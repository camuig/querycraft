//! Connection manager: one opened `Driver` per saved connection, dedicated
//! `Session`s per console / data tab, and a registry of running statements
//! for cancellation. Knows nothing about a particular engine.

use std::collections::HashMap;
use std::ops::Deref;
use std::sync::Arc;

use tokio::sync::Mutex as AsyncMutex;

use crate::connections::StoredConnectionView;
use crate::error::{AppError, AppResult};

use super::{open_driver, CancelHandle, Driver, ServerInfo, Session};

pub type SharedSession = Arc<AsyncMutex<Box<dyn Session>>>;

struct ConnectionEntry {
    driver: Box<dyn Driver>,
    sessions: AsyncMutex<HashMap<String, SharedSession>>,
}

/// Borrow of an opened driver that keeps the connection entry alive.
pub struct DriverRef(Arc<ConnectionEntry>);

impl Deref for DriverRef {
    type Target = dyn Driver;

    fn deref(&self) -> &Self::Target {
        self.0.driver.as_ref()
    }
}

pub struct ConnectionManager {
    connections: parking_lot::Mutex<HashMap<String, Arc<ConnectionEntry>>>,
    /// query_id -> (connection_id, cancel handle) — for `cancel_query`.
    running_queries: parking_lot::Mutex<HashMap<String, (String, CancelHandle)>>,
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

    /// Tests a connection without keeping any state.
    pub async fn test_connection(config: &StoredConnectionView, password: Option<String>) -> AppResult<ServerInfo> {
        super::test_connection(config, password).await
    }

    /// Opens the driver for a connection (idempotent — a repeated call
    /// replaces the driver, closing the previous one and its sessions).
    pub async fn connect(
        &self,
        id: &str,
        config: &StoredConnectionView,
        password: Option<String>,
    ) -> AppResult<ServerInfo> {
        let driver = open_driver(config, password).await?;
        let info = match driver.server_info().await {
            Ok(info) => info,
            Err(e) => {
                driver.close().await;
                return Err(e);
            }
        };

        let entry = Arc::new(ConnectionEntry {
            driver,
            sessions: AsyncMutex::new(HashMap::new()),
        });

        let previous = self.connections.lock().insert(id.to_string(), entry);
        if let Some(previous) = previous {
            previous.sessions.lock().await.clear();
            previous.driver.close().await;
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

    /// The opened driver of a connection (schema queries go through it).
    pub fn driver(&self, connection_id: &str) -> AppResult<DriverRef> {
        self.entry(connection_id).map(DriverRef)
    }

    /// Closes the driver and all sessions of a connection.
    pub async fn disconnect(&self, connection_id: &str) -> AppResult<()> {
        let entry = self.connections.lock().remove(connection_id);
        if let Some(entry) = entry {
            entry.sessions.lock().await.clear();
            entry.driver.close().await;
        }
        self.running_queries.lock().retain(|_, (cid, _)| cid != connection_id);
        Ok(())
    }

    /// The session's dedicated connection (console/data tab). Created lazily
    /// and never shared between tabs. If the existing session is dead (e.g.
    /// it was killed server-side), it is recreated.
    pub async fn get_session(
        &self,
        connection_id: &str,
        session_id: &str,
        database: Option<&str>,
    ) -> AppResult<SharedSession> {
        let entry = self.entry(connection_id)?;
        let mut sessions = entry.sessions.lock().await;

        if let Some(session) = sessions.get(session_id) {
            // If the session is currently busy with a statement (mutex held), treat it
            // as alive: we can't wait here since we hold the lock on the whole session table.
            let alive = match session.try_lock() {
                Ok(mut s) => s.is_alive().await,
                Err(_) => true,
            };
            if alive {
                return Ok(session.clone());
            }
            sessions.remove(session_id);
        }

        let session = entry.driver.open_session(database).await?;
        let session = Arc::new(AsyncMutex::new(session));
        sessions.insert(session_id.to_string(), session.clone());
        Ok(session)
    }

    /// Closes the session's dedicated connection (when a tab is closed).
    pub async fn close_session(&self, connection_id: &str, session_id: &str) -> AppResult<()> {
        let entry = self.connections.lock().get(connection_id).cloned();
        if let Some(entry) = entry {
            entry.sessions.lock().await.remove(session_id);
        }
        Ok(())
    }

    /// Remembers how to cancel the statement that is about to run.
    pub fn register_query(&self, query_id: &str, connection_id: &str, handle: CancelHandle) {
        self.running_queries
            .lock()
            .insert(query_id.to_string(), (connection_id.to_string(), handle));
    }

    pub fn unregister_query(&self, query_id: &str) {
        self.running_queries.lock().remove(query_id);
    }

    /// Cancels the statement started with `query_id`; a no-op when it already finished.
    pub async fn cancel_query(&self, connection_id: &str, query_id: &str) -> AppResult<()> {
        let handle = self.running_queries.lock().get(query_id).map(|(_, h)| h.clone());
        let Some(handle) = handle else {
            return Ok(());
        };
        self.driver(connection_id)?.cancel(&handle).await
    }
}
