//! Storage for connection configurations: `connections.json` in the app's config directory
//! plus passwords in the system keyring (service "QueryCraft", key — connection id).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use keyring::Entry;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const KEYRING_SERVICE: &str = "QueryCraft";
const CONNECTIONS_FILE: &str = "connections.json";

/// What's actually stored on disk — without the password and without the computed `hasPassword`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredConnection {
    id: String,
    name: String,
    host: String,
    port: u16,
    user: String,
    #[serde(default)]
    database: Option<String>,
    #[serde(default)]
    ssl: bool,
    /// Verify the server certificate when SSL is on. Missing in configs written
    /// before this field existed; defaults to the secure choice.
    #[serde(default = "default_true")]
    ssl_verify: bool,
    #[serde(default)]
    color: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Public connection configuration (contract with the frontend).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    pub ssl: bool,
    pub ssl_verify: bool,
    pub color: Option<String>,
    pub has_password: bool,
}

/// What the frontend sends when saving/testing a connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub save_password: bool,
    pub database: Option<String>,
    pub ssl: bool,
    #[serde(default = "default_true")]
    pub ssl_verify: bool,
    pub color: Option<String>,
}

pub struct ConnectionStore {
    file_path: PathBuf,
    connections: Mutex<Vec<StoredConnection>>,
    /// Passwords entered in this session but not saved to the keyring
    /// (savePassword = false). Lets connect/test use them
    /// until the app is closed.
    session_passwords: Mutex<HashMap<String, String>>,
}

impl ConnectionStore {
    /// Loads the list of connections from `<app_config_dir>/connections.json`,
    /// creating the directory/file if needed.
    pub fn load(app: &tauri::AppHandle) -> AppResult<Self> {
        use tauri::Manager;

        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|e| AppError::Other(format!("Failed to determine the config directory: {e}")))?;
        fs::create_dir_all(&config_dir)?;
        let file_path = config_dir.join(CONNECTIONS_FILE);

        let connections: Vec<StoredConnection> = if file_path.exists() {
            let raw = fs::read_to_string(&file_path)?;
            if raw.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str(&raw)?
            }
        } else {
            Vec::new()
        };

        Ok(Self {
            file_path,
            connections: Mutex::new(connections),
            session_passwords: Mutex::new(HashMap::new()),
        })
    }

    fn persist(&self, connections: &[StoredConnection]) -> AppResult<()> {
        let json = serde_json::to_vec_pretty(connections)?;
        fs::write(&self.file_path, json)?;
        Ok(())
    }

    fn keyring_entry(id: &str) -> AppResult<Entry> {
        Ok(Entry::new(KEYRING_SERVICE, id)?)
    }

    /// Whether a password is saved in the keyring. Read errors (keyring unavailable
    /// in CI/headless environments) are treated as "no password" with a warning logged.
    fn has_saved_password(id: &str) -> bool {
        match Self::keyring_entry(id) {
            Ok(entry) => match entry.get_password() {
                Ok(_) => true,
                Err(keyring::Error::NoEntry) => false,
                Err(e) => {
                    log::warn!("Failed to read the password from the keyring for {id}: {e}");
                    false
                }
            },
            Err(e) => {
                log::warn!("Failed to open the keyring for {id}: {e}");
                false
            }
        }
    }

    fn to_config(stored: &StoredConnection) -> ConnectionConfig {
        ConnectionConfig {
            id: stored.id.clone(),
            name: stored.name.clone(),
            host: stored.host.clone(),
            port: stored.port,
            user: stored.user.clone(),
            database: stored.database.clone(),
            ssl: stored.ssl,
            ssl_verify: stored.ssl_verify,
            color: stored.color.clone(),
            has_password: Self::has_saved_password(&stored.id),
        }
    }

    pub fn list(&self) -> AppResult<Vec<ConnectionConfig>> {
        let connections = self.connections.lock();
        Ok(connections.iter().map(Self::to_config).collect())
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionConfig> {
        let connections = self.connections.lock();
        connections
            .iter()
            .find(|c| c.id == id)
            .map(Self::to_config)
            .ok_or_else(|| AppError::ConnectionNotFound(id.to_string()))
    }

    /// Internal config (without serializing `hasPassword`) — needed by the connection code.
    pub(crate) fn get_stored(&self, id: &str) -> AppResult<StoredConnectionView> {
        let connections = self.connections.lock();
        connections
            .iter()
            .find(|c| c.id == id)
            .map(|c| StoredConnectionView {
                host: c.host.clone(),
                port: c.port,
                user: c.user.clone(),
                database: c.database.clone(),
                ssl: c.ssl,
                ssl_verify: c.ssl_verify,
            })
            .ok_or_else(|| AppError::ConnectionNotFound(id.to_string()))
    }

    pub fn save(&self, input: ConnectionInput) -> AppResult<ConnectionConfig> {
        let id = input.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());

        let stored = StoredConnection {
            id: id.clone(),
            name: input.name,
            host: input.host,
            port: input.port,
            user: input.user,
            database: input.database,
            ssl: input.ssl,
            ssl_verify: input.ssl_verify,
            color: input.color,
        };

        {
            let mut connections = self.connections.lock();
            if let Some(existing) = connections.iter_mut().find(|c| c.id == id) {
                *existing = stored.clone();
            } else {
                connections.push(stored.clone());
            }
            self.persist(&connections)?;
        }

        // Password: save to the keyring, remove from the keyring, or cache for the session.
        if input.save_password {
            if let Some(password) = &input.password {
                let entry = Self::keyring_entry(&id)?;
                entry.set_password(password)?;
                self.session_passwords.lock().remove(&id);
            }
        } else {
            let entry = Self::keyring_entry(&id)?;
            match entry.delete_credential() {
                Ok(()) => {}
                Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(e.into()),
            }
            if let Some(password) = input.password {
                self.session_passwords.lock().insert(id.clone(), password);
            }
        }

        self.get(&id)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        {
            let mut connections = self.connections.lock();
            connections.retain(|c| c.id != id);
            self.persist(&connections)?;
        }
        self.session_passwords.lock().remove(id);

        let entry = Self::keyring_entry(id)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Password for the connection: keyring first, then the session cache.
    /// Keyring read errors are not fatal — it just means no password is saved.
    pub fn get_password(&self, id: &str) -> AppResult<Option<String>> {
        let from_keyring = match Self::keyring_entry(id) {
            Ok(entry) => match entry.get_password() {
                Ok(password) => Some(password),
                Err(keyring::Error::NoEntry) => None,
                Err(e) => {
                    log::warn!("Failed to read the password from the keyring for {id}: {e}");
                    None
                }
            },
            Err(e) => {
                log::warn!("Failed to open the keyring for {id}: {e}");
                None
            }
        };

        if from_keyring.is_some() {
            return Ok(from_keyring);
        }

        Ok(self.session_passwords.lock().get(id).cloned())
    }
}

/// Internal representation of a connection without the serializable `hasPassword` —
/// used when building `OptsBuilder`.
#[derive(Debug, Clone)]
pub struct StoredConnectionView {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    pub ssl: bool,
    /// Verify the server certificate and host name (only matters when `ssl` is on).
    pub ssl_verify: bool,
}

#[cfg(test)]
mod tests {
    use super::StoredConnection;

    #[test]
    fn stored_connection_without_ssl_verify_defaults_to_verifying() {
        let json = r#"{"id":"a","name":"n","host":"h","port":3306,"user":"u","ssl":true}"#;
        let stored: StoredConnection = serde_json::from_str(json).unwrap();
        assert!(stored.ssl);
        assert!(stored.ssl_verify);
    }

    #[test]
    fn stored_connection_keeps_explicit_ssl_verify() {
        let json = r#"{"id":"a","name":"n","host":"h","port":3306,"user":"u","ssl":true,"ssl_verify":false}"#;
        let stored: StoredConnection = serde_json::from_str(json).unwrap();
        assert!(!stored.ssl_verify);
    }
}
