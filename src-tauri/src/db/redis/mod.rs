//! Redis / Valkey backend on the `redis` crate: a shared admin connection for
//! server info, `SCAN`-based key listing and `CLIENT KILL`, and a dedicated
//! `MultiplexedConnection` per session (Redis connections carry `SELECT`
//! state, so sessions cannot share one). The console speaks redis-cli syntax
//! (see `command.rs`), not SQL; replies are shaped into a grid by `convert.rs`.

pub(crate) mod command;
mod convert;
mod schema;

use std::net::SocketAddr;

use async_trait::async_trait;
use redis::aio::MultiplexedConnection;
use redis::{
    AsyncConnectionConfig, Client, ConnectionAddr, IntoConnectionInfo, RedisConnectionInfo, Value as RedisValue,
};
use tokio::sync::Mutex as AsyncMutex;

use crate::connections::StoredConnectionView;
use crate::error::{AppError, AppResult};

use super::schema::{ColumnInfo, ForeignKeyInfo, IndexInfo, KeyListing, TableInfo};
use super::{
    read_ca_certificate, CancelHandle, DbKind, Driver, Endpoint, ParamStatement, ServerInfo, Session, StatementResult,
};

/// Commands that would break the request/response protocol on a shared
/// console connection (they switch it into a push/replication stream or tear
/// it down) — refused with a clear error instead of hanging the session.
const REFUSED_COMMANDS: &[&str] = &[
    "SUBSCRIBE",
    "PSUBSCRIBE",
    "SSUBSCRIBE",
    "UNSUBSCRIBE",
    "PUNSUBSCRIBE",
    "SUNSUBSCRIBE",
    "MONITOR",
    "SYNC",
    "PSYNC",
    "QUIT",
    "RESET",
];

/// Parses a database selector into its numeric index: empty/absent means the
/// default database (`0`); anything else must be an unsigned integer.
fn parse_db_index(database: Option<&str>) -> AppResult<u32> {
    match database.map(str::trim) {
        None | Some("") => Ok(0),
        Some(s) => s
            .parse::<u32>()
            .map_err(|_| AppError::Other(format!("Database must be a numeric index, got {s:?}"))),
    }
}

/// Resolves every DNS lookup on the connection to a fixed address — the
/// local end of an SSH tunnel — instead of asking the system resolver.
/// `ConnectionAddr` still carries the *configured* host name (see
/// `open_connection`), so TLS verification (certificate name, SNI) keeps
/// checking it against the real server name even though the socket is
/// actually dialed to the tunnel.
struct FixedResolver(SocketAddr);

impl redis::io::AsyncDNSResolver for FixedResolver {
    fn resolve<'a, 'b: 'a>(
        &'a self,
        _host: &'b str,
        _port: u16,
    ) -> redis::RedisFuture<'a, Box<dyn Iterator<Item = SocketAddr> + Send + 'a>> {
        let addr = self.0;
        Box::pin(async move { Ok(Box::new(std::iter::once(addr)) as Box<dyn Iterator<Item = SocketAddr> + Send + 'a>) })
    }
}

struct ConnectParams<'a> {
    host: &'a str,
    port: u16,
    ssl: bool,
    ssl_verify: bool,
    user: &'a str,
    password: Option<&'a str>,
    db: u32,
    /// The SSH tunnel's local address, when the connection is tunneled.
    tunnel_addr: Option<SocketAddr>,
}

/// Opens one connection with the given database selected. `RedisConnectionInfo::set_db`
/// makes the crate send `SELECT` as part of its own connection handshake, so
/// callers never have to issue it themselves.
async fn open_connection(params: ConnectParams<'_>) -> AppResult<MultiplexedConnection> {
    let addr = if params.ssl {
        ConnectionAddr::TcpTls {
            host: params.host.to_string(),
            port: params.port,
            insecure: !params.ssl_verify,
            // The native-TLS backend has no public API for a custom root certificate
            // (see `RedisDriver::connect`); a verified connection uses the system trust store.
            tls_params: None,
        }
    } else {
        ConnectionAddr::Tcp(params.host.to_string(), params.port)
    };

    let mut redis_info = RedisConnectionInfo::default().set_db(params.db as i64);
    if !params.user.is_empty() {
        // An empty user means "the default user" — Redis 6+ ACLs treat that
        // differently from `AUTH default ...`, so it's simplest to omit it.
        redis_info = redis_info.set_username(params.user);
    }
    if let Some(password) = params.password {
        redis_info = redis_info.set_password(password);
    }

    let info = addr.into_connection_info()?.set_redis_settings(redis_info);
    let client = Client::open(info)?;

    let mut config = AsyncConnectionConfig::new();
    if let Some(tunnel_addr) = params.tunnel_addr {
        config = config.set_dns_resolver(FixedResolver(tunnel_addr));
    }
    Ok(client.get_multiplexed_async_connection_with_config(&config).await?)
}

pub struct RedisDriver {
    kind: DbKind,
    host: String,
    port: u16,
    ssl: bool,
    ssl_verify: bool,
    user: String,
    password: Option<String>,
    default_db: u32,
    tunnel_addr: Option<SocketAddr>,
    /// Shared connection for driver-level work (server info, key listing,
    /// `CLIENT KILL`); guarded so `SELECT` (in `list_keys`) never interleaves
    /// with another caller's use of the same connection.
    admin: AsyncMutex<MultiplexedConnection>,
}

impl RedisDriver {
    pub async fn connect(
        config: &StoredConnectionView,
        endpoint: &Endpoint,
        password: Option<String>,
    ) -> AppResult<Self> {
        if config.ssl && read_ca_certificate(config)?.is_some() {
            return Err(AppError::Other(
                "Redis and Valkey connections do not support a custom CA certificate file here: \
                 the redis crate's native-TLS backend only verifies against the system trust store, \
                 or skips verification entirely when certificate verification is turned off."
                    .into(),
            ));
        }

        let default_db = parse_db_index(config.database.as_deref())?;
        let tunnel_addr = if endpoint.tunneled {
            Some(
                format!("{}:{}", endpoint.host, endpoint.port)
                    .parse::<SocketAddr>()
                    .map_err(|e| AppError::Other(format!("invalid tunnel address {}: {e}", endpoint.host)))?,
            )
        } else {
            None
        };

        let admin = open_connection(ConnectParams {
            host: &config.host,
            port: config.port,
            ssl: config.ssl,
            ssl_verify: config.ssl_verify,
            user: &config.user,
            password: password.as_deref(),
            db: default_db,
            tunnel_addr,
        })
        .await?;

        Ok(Self {
            kind: config.kind,
            host: config.host.clone(),
            port: config.port,
            ssl: config.ssl,
            ssl_verify: config.ssl_verify,
            user: config.user.clone(),
            password,
            default_db,
            tunnel_addr,
            admin: AsyncMutex::new(admin),
        })
    }

    fn connect_params<'a>(&'a self, db: u32) -> ConnectParams<'a> {
        ConnectParams {
            host: &self.host,
            port: self.port,
            ssl: self.ssl,
            ssl_verify: self.ssl_verify,
            user: &self.user,
            password: self.password.as_deref(),
            db,
            tunnel_addr: self.tunnel_addr,
        }
    }
}

#[async_trait]
impl Driver for RedisDriver {
    fn kind(&self) -> DbKind {
        self.kind
    }

    async fn server_info(&self) -> AppResult<ServerInfo> {
        let mut conn = self.admin.lock().await;
        let info: String = redis::cmd("INFO").arg("server").query_async(&mut *conn).await?;
        let server_version = schema::info_field(&info, "valkey_version")
            .or_else(|| schema::info_field(&info, "redis_version"))
            .unwrap_or("unknown")
            .to_string();
        let client_id: i64 = redis::cmd("CLIENT").arg("ID").query_async(&mut *conn).await?;
        Ok(ServerInfo {
            server_version,
            connection_id: Some(client_id as u64),
        })
    }

    async fn open_session(&self, database: Option<&str>) -> AppResult<Box<dyn Session>> {
        let db = match database.map(str::trim) {
            Some(d) if !d.is_empty() => parse_db_index(Some(d))?,
            _ => self.default_db,
        };
        let mut conn = open_connection(self.connect_params(db)).await?;
        let client_id: i64 = redis::cmd("CLIENT").arg("ID").query_async(&mut conn).await?;
        Ok(Box::new(RedisSession { conn, client_id }))
    }

    async fn cancel(&self, handle: &CancelHandle) -> AppResult<()> {
        let CancelHandle::RedisClient(client_id) = handle else {
            return Ok(());
        };
        let mut conn = self.admin.lock().await;
        let result = redis::cmd("CLIENT")
            .arg("KILL")
            .arg("ID")
            .arg(*client_id)
            .query_async::<i64>(&mut *conn)
            .await;
        match result {
            Ok(_) => Ok(()),
            // The session's connection is already gone (finished before the
            // cancel arrived, or was already killed) — nothing left to do.
            Err(e) if e.to_string().contains("No such client") => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        let mut conn = self.admin.lock().await;
        schema::list_databases(&mut conn).await
    }

    async fn list_tables(&self, _database: &str) -> AppResult<Vec<TableInfo>> {
        Ok(Vec::new())
    }

    async fn list_columns(&self, _database: &str, _table: &str) -> AppResult<Vec<ColumnInfo>> {
        Ok(Vec::new())
    }

    async fn list_indexes(&self, _database: &str, _table: &str) -> AppResult<Vec<IndexInfo>> {
        Ok(Vec::new())
    }

    async fn list_foreign_keys(&self, _database: &str, _table: &str) -> AppResult<Vec<ForeignKeyInfo>> {
        Ok(Vec::new())
    }

    async fn table_ddl(&self, _database: &str, _table: &str) -> AppResult<String> {
        Err(AppError::Other("Redis has no DDL".into()))
    }

    async fn list_keys(&self, database: &str, pattern: &str, limit: usize) -> AppResult<KeyListing> {
        let db = parse_db_index(Some(database))?;
        let mut conn = self.admin.lock().await;
        schema::list_keys(&mut conn, db as i64, pattern, limit).await
    }

    async fn close(&self) {
        // Nothing to release explicitly: dropping the connections closes their sockets.
    }
}

struct RedisSession {
    conn: MultiplexedConnection,
    /// This session's `CLIENT ID` on the server, captured right after
    /// connecting — the target of `CLIENT KILL ID` for cancellation.
    client_id: i64,
}

#[async_trait]
impl Session for RedisSession {
    fn cancel_handle(&self) -> CancelHandle {
        CancelHandle::RedisClient(self.client_id)
    }

    async fn run(&mut self, sql: &str, max_rows: usize) -> AppResult<Vec<StatementResult>> {
        let parts = command::parse_line(sql)?;
        let Some(first) = parts.first() else {
            return Ok(Vec::new());
        };
        let command_word = String::from_utf8_lossy(first).to_ascii_uppercase();
        if REFUSED_COMMANDS.contains(&command_word.as_str()) {
            return Err(AppError::Other(format!(
                "{command_word} is not supported in the console"
            )));
        }

        let mut cmd = redis::cmd(&command_word);
        for arg in &parts[1..] {
            cmd.arg(arg.as_slice());
        }
        let value: RedisValue = cmd.query_async(&mut self.conn).await?;
        Ok(convert::to_results(sql, &parts, value, max_rows))
    }

    async fn apply(&mut self, statements: &[ParamStatement]) -> AppResult<u64> {
        if statements.is_empty() {
            return Ok(0);
        }

        let mut pipe = redis::pipe();
        pipe.atomic();
        for stmt in statements {
            let command_word = command::validate_command_word(&stmt.sql)?;
            if REFUSED_COMMANDS.contains(&command_word.as_str()) {
                return Err(AppError::Other(format!(
                    "{command_word} is not supported in the console"
                )));
            }
            pipe.cmd(&command_word);
            for param in &stmt.params {
                pipe.arg(convert::cell_to_redis_arg(param)?);
            }
        }

        // `pipe.atomic()` wraps the batch in MULTI/EXEC: a queue-time error
        // (wrong arity, unknown command) aborts before EXEC and nothing runs,
        // but Redis does not roll back a runtime error raised by one of the
        // queued commands once EXEC starts — the commands before it have
        // already taken effect. Either kind of failure surfaces here as one error.
        pipe.query_async::<()>(&mut self.conn).await?;
        Ok(statements.len() as u64)
    }

    async fn is_alive(&mut self) -> bool {
        redis::cmd("PING").query_async::<String>(&mut self.conn).await.is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::parse_db_index;

    #[test]
    fn parse_db_index_defaults_to_zero() {
        assert_eq!(parse_db_index(None).unwrap(), 0);
        assert_eq!(parse_db_index(Some("")).unwrap(), 0);
        assert_eq!(parse_db_index(Some("  ")).unwrap(), 0);
    }

    #[test]
    fn parse_db_index_parses_a_number() {
        assert_eq!(parse_db_index(Some("3")).unwrap(), 3);
    }

    #[test]
    fn parse_db_index_rejects_non_numeric() {
        assert!(parse_db_index(Some("shop")).is_err());
    }
}
