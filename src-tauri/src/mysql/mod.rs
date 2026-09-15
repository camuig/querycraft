//! Менеджер MySQL-соединений: пул метаданных на подключение + выделенные
//! соединения (`Conn`) на сессию (консоль/вкладка данных) + реестр активных
//! запросов для отмены через `KILL QUERY`.

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
    /// CONNECTION_ID() сессии (для отладки).
    pub connection_id: u32,
}

/// Экранирует идентификатор (имя БД/таблицы) для подстановки в DDL-запрос
/// обратными кавычками, удваивая уже имеющиеся backtick-и.
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
    /// query_id -> (connection_id, mysql thread id) — для cancel_query.
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

    /// Проверка подключения без сохранения состояния: открывает временное
    /// соединение, делает тестовый запрос и сразу закрывает его.
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
        Ok(ServerInfo { server_version, connection_id })
    }

    /// Открывает пул метаданных для подключения (идемпотентно — повторный
    /// вызов пересоздаёт пул с актуальным паролем).
    pub async fn connect(&self, id: &str, config: &StoredConnectionView, password: Option<String>) -> AppResult<ServerInfo> {
        let opts = Self::build_opts(config, password);

        let pool_opts = PoolOpts::default().with_constraints(
            PoolConstraints::new(1, 4).expect("1 <= 4 and 4 > 0 — valid pool constraints"),
        );
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

        // Если подключение уже было открыто — закрываем старый пул/сессии.
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

    /// Закрывает пул и все сессии подключения.
    pub async fn disconnect(&self, connection_id: &str) -> AppResult<()> {
        let entry = self.connections.lock().remove(connection_id);
        if let Some(entry) = entry {
            entry.sessions.lock().await.clear();
            entry.pool.clone().disconnect().await?;
        }
        self.running_queries.lock().retain(|_, (cid, _)| cid != connection_id);
        Ok(())
    }

    /// Соединение из пула метаданных (для запросов к information_schema и т.п.).
    pub async fn metadata_conn(&self, connection_id: &str) -> AppResult<Conn> {
        let entry = self.entry(connection_id)?;
        Ok(entry.pool.get_conn().await?)
    }

    /// Выделенное соединение сессии (консоль/вкладка данных). Создаётся лениво
    /// и никогда не возвращается в пул. Если существующее соединение мертво
    /// (например, его убили через KILL), пересоздаёт его.
    pub async fn get_session(
        &self,
        connection_id: &str,
        session_id: &str,
        database: Option<&str>,
    ) -> AppResult<Arc<AsyncMutex<Conn>>> {
        let entry = self.entry(connection_id)?;
        let mut sessions = entry.sessions.lock().await;

        if let Some(session) = sessions.get(session_id) {
            // Если соединение сейчас занято запросом (мьютекс захвачен), считаем его
            // живым: ждать здесь нельзя — мы держим замок на всей таблице сессий.
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

    /// Закрывает выделенное соединение сессии (при закрытии вкладки).
    pub async fn close_session(&self, connection_id: &str, session_id: &str) -> AppResult<()> {
        let entry = self.connections.lock().get(connection_id).cloned();
        if let Some(entry) = entry {
            entry.sessions.lock().await.remove(session_id);
        }
        Ok(())
    }

    /// Запоминает mysql-thread-id запроса, чтобы его можно было отменить.
    pub fn register_query(&self, query_id: &str, connection_id: &str, thread_id: u32) {
        self.running_queries
            .lock()
            .insert(query_id.to_string(), (connection_id.to_string(), thread_id));
    }

    pub fn unregister_query(&self, query_id: &str) {
        self.running_queries.lock().remove(query_id);
    }

    /// `KILL QUERY <thread_id>` через служебное соединение из пула.
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
