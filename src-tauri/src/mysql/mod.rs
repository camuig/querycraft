//! MySQL connection manager: a metadata pool per connection + dedicated
//! connections (`Conn`) per session (console/data tab) + a registry of active
//! queries for cancellation via `KILL QUERY`.

pub mod convert;
pub mod execute;
pub mod schema;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, SslOpts};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::connections::StoredConnectionView;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub server_version: String,
    /// The session's CONNECTION_ID() (for debugging).
    pub connection_id: u32,
}

/// Escapes an identifier (DB/table name) for use in a DDL query
/// with backticks, doubling any backticks already present.
pub(crate) fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

struct Session {
    conn: Arc<AsyncMutex<Conn>>,
}

struct ConnectionEntry {
    pool: Pool,
    opts: Opts,
    sessions: AsyncMutex<HashMap<String, Session>>,
}

pub struct ConnectionManager {
    connections: parking_lot::Mutex<HashMap<String, Arc<ConnectionEntry>>>,
    /// query_id -> (connection_id, mysql thread id) — for cancel_query.
    running_queries: parking_lot::Mutex<HashMap<String, (String, u32)>>,
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: parking_lot::Mutex::new(HashMap::new()),
            running_queries: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    fn build_opts(config: &StoredConnectionView, password: Option<String>) -> Opts {
        let mut builder = OptsBuilder::default()
            .ip_or_hostname(config.host.clone())
            .tcp_port(config.port)
            .user(Some(config.user.clone()))
            .pass(password)
            .db_name(config.database.clone())
            .tcp_keepalive(Some(Duration::from_millis(30_000)));

        if config.ssl {
            let ssl_opts = SslOpts::default()
                .with_danger_accept_invalid_certs(true)
                .with_danger_skip_domain_validation(true);
            builder = builder.ssl_opts(Some(ssl_opts));
        }

        builder.into()
    }

    /// Tests a connection without keeping any state: opens a temporary
    /// connection, runs a test query, and closes it right away.
    pub async fn test_connection(config: &StoredConnectionView, password: Option<String>) -> AppResult<ServerInfo> {
        let opts = Self::build_opts(config, password);
        let mut conn = Conn::new(opts).await?;
        let info = Self::fetch_server_info(&mut conn).await?;
        conn.disconnect().await?;
        Ok(info)
    }

    async fn fetch_server_info(conn: &mut Conn) -> AppResult<ServerInfo> {
        let row: Option<(String, u32)> = conn.query_first("SELECT VERSION(), CONNECTION_ID()").await?;
        let (server_version, connection_id) =
            row.ok_or_else(|| AppError::Mysql("Empty response from the server on connect".into()))?;
        Ok(ServerInfo {
            server_version,
            connection_id,
        })
    }

    /// Opens the metadata pool for a connection (idempotent — a repeated
    /// call recreates the pool with the current password).
    pub async fn connect(
        &self,
        id: &str,
        config: &StoredConnectionView,
        password: Option<String>,
    ) -> AppResult<ServerInfo> {
        let opts = Self::build_opts(config, password);

        let pool_opts = PoolOpts::default()
            .with_constraints(PoolConstraints::new(1, 4).expect("1 <= 4 and 4 > 0 — valid pool constraints"));
        let pool = Pool::new(OptsBuilder::from_opts(opts.clone()).pool_opts(pool_opts));

        let mut conn = pool.get_conn().await?;
        let info = Self::fetch_server_info(&mut conn).await;
        drop(conn);
        let info = info?;

        let entry = Arc::new(ConnectionEntry {
            pool,
            opts,
            sessions: AsyncMutex::new(HashMap::new()),
        });

        // If the connection was already open, close the old pool/sessions.
        let previous = self.connections.lock().insert(id.to_string(), entry);
        if let Some(previous) = previous {
            let _ = previous.pool.clone().disconnect().await;
        }

        Ok(info)
    }

    fn entry(&self, connection_id: &str) -> AppResult<Arc<ConnectionEntry>> {
        self.connections
            .lock()
            .get(connection_id)
            .cloned()
            .ok_or_else(|| AppError::ConnectionNotFound(connection_id.to_string()))
    }

    /// Closes the pool and all sessions for a connection.
    pub async fn disconnect(&self, connection_id: &str) -> AppResult<()> {
        let entry = self.connections.lock().remove(connection_id);
        if let Some(entry) = entry {
            entry.sessions.lock().await.clear();
            entry.pool.clone().disconnect().await?;
        }
        self.running_queries.lock().retain(|_, (cid, _)| cid != connection_id);
        Ok(())
    }

    /// A connection from the metadata pool (for queries to information_schema, etc.).
    pub async fn metadata_conn(&self, connection_id: &str) -> AppResult<Conn> {
        let entry = self.entry(connection_id)?;
        Ok(entry.pool.get_conn().await?)
    }

    /// The session's dedicated connection (console/data tab). Created lazily
    /// and never returned to the pool. If the existing connection is dead
    /// (e.g. it was killed via KILL), it's recreated.
    pub async fn get_session(
        &self,
        connection_id: &str,
        session_id: &str,
        database: Option<&str>,
    ) -> AppResult<Arc<AsyncMutex<Conn>>> {
        let entry = self.entry(connection_id)?;
        let mut sessions = entry.sessions.lock().await;

        if let Some(session) = sessions.get(session_id) {
            // If the connection is currently busy with a query (mutex held), treat it
            // as alive: we can't wait here since we hold the lock on the whole session table.
            let alive = match session.conn.try_lock() {
                Ok(mut conn) => conn.ping().await.is_ok(),
                Err(_) => true,
            };
            if alive {
                return Ok(session.conn.clone());
            }
            sessions.remove(session_id);
        }

        let mut conn = Conn::new(entry.opts.clone()).await?;
        if let Some(db) = database {
            conn.query_drop(format!("USE {}", quote_ident(db))).await?;
        }
        let conn = Arc::new(AsyncMutex::new(conn));
        sessions.insert(session_id.to_string(), Session { conn: conn.clone() });
        Ok(conn)
    }

    /// Closes the session's dedicated connection (when a tab is closed).
    pub async fn close_session(&self, connection_id: &str, session_id: &str) -> AppResult<()> {
        let entry = self.connections.lock().get(connection_id).cloned();
        if let Some(entry) = entry {
            entry.sessions.lock().await.remove(session_id);
        }
        Ok(())
    }

    /// Remembers the query's mysql thread id so it can be cancelled.
    pub fn register_query(&self, query_id: &str, connection_id: &str, thread_id: u32) {
        self.running_queries
            .lock()
            .insert(query_id.to_string(), (connection_id.to_string(), thread_id));
    }

    pub fn unregister_query(&self, query_id: &str) {
        self.running_queries.lock().remove(query_id);
    }

    /// `KILL QUERY <thread_id>` via a utility connection from the pool.
    pub async fn cancel_query(&self, connection_id: &str, query_id: &str) -> AppResult<()> {
        let thread_id = self.running_queries.lock().get(query_id).map(|(_, tid)| *tid);
        let Some(thread_id) = thread_id else {
            return Ok(());
        };
        let mut conn = self.metadata_conn(connection_id).await?;
        conn.query_drop(format!("KILL QUERY {thread_id}")).await?;
        Ok(())
    }
}
