//! Storage for connection configurations: `connections.json` in the app's config directory
//! plus secrets in the [`SecretStore`] (the database password is stored under the connection
//! id, the SSH password or key passphrase under `<id>/ssh`).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::DbKind;
use crate::error::{AppError, AppResult};
use crate::secrets::SecretStore;

const CONNECTIONS_FILE: &str = "connections.json";

/// Which secret of a connection is meant: the keyring account name is derived from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Secret {
    /// The database password (keyring account = connection id, as in earlier versions).
    Password,
    /// The SSH password or private-key passphrase (keyring account = `<id>/ssh`).
    Ssh,
}

impl Secret {
    fn account(self, id: &str) -> String {
        match self {
            Secret::Password => id.to_string(),
            Secret::Ssh => format!("{id}/ssh"),
        }
    }
}

/// How the SSH tunnel authenticates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    #[default]
    Password,
    Key,
    Agent,
}

/// SSH tunnel settings: the database is reached through a port forwarded over this host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    /// Private key file for `SshAuth::Key`.
    #[serde(default)]
    pub key_path: Option<String>,
}

/// Everything a driver needs besides the configuration: the database password
/// and the SSH password / passphrase, each `None` when unknown.
#[derive(Debug, Clone, Default)]
pub struct Credentials {
    pub password: Option<String>,
    pub ssh_secret: Option<String>,
}

impl Credentials {
    pub fn password(password: Option<String>) -> Self {
        Self {
            password,
            ssh_secret: None,
        }
    }
}

/// What's actually stored on disk — without the password and without the computed `hasPassword`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredConnection {
    id: String,
    name: String,
    /// Missing in configs written before multi-engine support: those are MySQL.
    #[serde(default)]
    kind: DbKind,
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
    /// PEM file with the CA certificate(s) that sign the server certificate.
    #[serde(default)]
    ssl_ca_path: Option<String>,
    #[serde(default)]
    color: Option<String>,
    /// Database file for file-based engines (SQLite); `host`/`port`/`user` are unused then.
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    ssh: Option<SshConfig>,
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
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    pub ssl: bool,
    pub ssl_verify: bool,
    pub ssl_ca_path: Option<String>,
    pub color: Option<String>,
    pub path: Option<String>,
    pub ssh: Option<SshConfig>,
    pub has_password: bool,
    /// Whether the SSH password / passphrase is saved in the keyring.
    pub has_ssh_secret: bool,
}

/// What the frontend sends when saving/testing a connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub save_password: bool,
    pub database: Option<String>,
    pub ssl: bool,
    #[serde(default = "default_true")]
    pub ssl_verify: bool,
    #[serde(default)]
    pub ssl_ca_path: Option<String>,
    pub color: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// SSH password or key passphrase; follows the `save_password` policy like the database password.
    #[serde(default)]
    pub ssh_secret: Option<String>,
}

impl ConnectionInput {
    /// The part of the input the drivers need (everything except the name, color and password policy).
    pub fn to_view(&self) -> StoredConnectionView {
        StoredConnectionView {
            kind: self.kind,
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            database: self.database.clone(),
            ssl: self.ssl,
            ssl_verify: self.ssl_verify,
            ssl_ca_path: self.ssl_ca_path.clone(),
            path: self.path.clone(),
            ssh: self.ssh.clone(),
        }
    }

    /// The secrets typed into the dialog.
    pub fn credentials(&self) -> Credentials {
        Credentials {
            password: self.password.clone(),
            ssh_secret: self.ssh_secret.clone(),
        }
    }
}

pub struct ConnectionStore {
    file_path: PathBuf,
    connections: Mutex<Vec<StoredConnection>>,
    secrets: SecretStore,
    /// Secrets entered in this session but not saved to the secret store
    /// (savePassword = false), keyed by account. Lets connect/test use them
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

        let secrets = SecretStore::for_build(&config_dir);
        if secrets.is_file() {
            log::info!("development build: connection secrets are kept in a plain file, not the keyring");
        }

        Ok(Self {
            file_path,
            connections: Mutex::new(connections),
            secrets,
            session_passwords: Mutex::new(HashMap::new()),
        })
    }

    fn persist(&self, connections: &[StoredConnection]) -> AppResult<()> {
        let json = serde_json::to_vec_pretty(connections)?;
        fs::write(&self.file_path, json)?;
        Ok(())
    }

    /// Applies the password policy to one secret: save it to the secret store, drop it
    /// from the store, or keep it for this session only.
    fn store_secret(&self, account: &str, secret: Option<String>, save: bool) -> AppResult<()> {
        if save {
            if let Some(secret) = secret {
                self.secrets.set(account, &secret)?;
                self.session_passwords.lock().remove(account);
            }
        } else {
            self.secrets.delete(account)?;
            if let Some(secret) = secret {
                self.session_passwords.lock().insert(account.to_string(), secret);
            }
        }
        Ok(())
    }

    fn to_config(&self, stored: &StoredConnection) -> ConnectionConfig {
        ConnectionConfig {
            id: stored.id.clone(),
            name: stored.name.clone(),
            kind: stored.kind,
            host: stored.host.clone(),
            port: stored.port,
            user: stored.user.clone(),
            database: stored.database.clone(),
            ssl: stored.ssl,
            ssl_verify: stored.ssl_verify,
            ssl_ca_path: stored.ssl_ca_path.clone(),
            color: stored.color.clone(),
            path: stored.path.clone(),
            ssh: stored.ssh.clone(),
            has_password: self.secrets.get(&Secret::Password.account(&stored.id)).is_some(),
            has_ssh_secret: stored.ssh.is_some() && self.secrets.get(&Secret::Ssh.account(&stored.id)).is_some(),
        }
    }

    pub fn list(&self) -> AppResult<Vec<ConnectionConfig>> {
        let connections = self.connections.lock();
        Ok(connections.iter().map(|c| self.to_config(c)).collect())
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionConfig> {
        let connections = self.connections.lock();
        connections
            .iter()
            .find(|c| c.id == id)
            .map(|c| self.to_config(c))
            .ok_or_else(|| AppError::ConnectionNotFound(id.to_string()))
    }

    /// Internal config (without serializing `hasPassword`) — needed by the connection code.
    pub(crate) fn get_stored(&self, id: &str) -> AppResult<StoredConnectionView> {
        let connections = self.connections.lock();
        connections
            .iter()
            .find(|c| c.id == id)
            .map(|c| StoredConnectionView {
                kind: c.kind,
                host: c.host.clone(),
                port: c.port,
                user: c.user.clone(),
                database: c.database.clone(),
                ssl: c.ssl,
                ssl_verify: c.ssl_verify,
                ssl_ca_path: c.ssl_ca_path.clone(),
                path: c.path.clone(),
                ssh: c.ssh.clone(),
            })
            .ok_or_else(|| AppError::ConnectionNotFound(id.to_string()))
    }

    pub fn save(&self, input: ConnectionInput) -> AppResult<ConnectionConfig> {
        let id = input.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());

        let stored = StoredConnection {
            id: id.clone(),
            name: input.name,
            kind: input.kind,
            host: input.host,
            port: input.port,
            user: input.user,
            database: input.database,
            ssl: input.ssl,
            ssl_verify: input.ssl_verify,
            ssl_ca_path: input.ssl_ca_path,
            color: input.color,
            path: input.path,
            ssh: input.ssh,
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

        self.store_secret(&Secret::Password.account(&id), input.password, input.save_password)?;
        let ssh_account = Secret::Ssh.account(&id);
        if stored.ssh.is_some() {
            self.store_secret(&ssh_account, input.ssh_secret, input.save_password)?;
        } else {
            // The tunnel was switched off: its secret is no longer needed anywhere.
            self.secrets.delete(&ssh_account)?;
            self.session_passwords.lock().remove(&ssh_account);
        }

        self.get(&id)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        {
            let mut connections = self.connections.lock();
            connections.retain(|c| c.id != id);
            self.persist(&connections)?;
        }
        for secret in [Secret::Password, Secret::Ssh] {
            let account = secret.account(id);
            self.session_passwords.lock().remove(&account);
            self.secrets.delete(&account)?;
        }
        Ok(())
    }

    /// A secret of the connection: the secret store first, then the session cache.
    pub fn get_secret(&self, id: &str, secret: Secret) -> Option<String> {
        let account = secret.account(id);
        self.secrets
            .get(&account)
            .or_else(|| self.session_passwords.lock().get(&account).cloned())
    }

    /// Both secrets of the connection, for opening it.
    pub fn get_credentials(&self, id: &str) -> Credentials {
        Credentials {
            password: self.get_secret(id, Secret::Password),
            ssh_secret: self.get_secret(id, Secret::Ssh),
        }
    }
}

/// Internal representation of a connection without the serializable `hasPassword` —
/// what the drivers get to open a connection.
#[derive(Debug, Clone)]
pub struct StoredConnectionView {
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    pub ssl: bool,
    /// Verify the server certificate and host name (only matters when `ssl` is on).
    pub ssl_verify: bool,
    /// PEM file with the CA certificate(s) that sign the server certificate.
    pub ssl_ca_path: Option<String>,
    /// Database file for file-based engines (SQLite).
    pub path: Option<String>,
    /// Reach the database through an SSH tunnel.
    pub ssh: Option<SshConfig>,
}

#[cfg(test)]
mod tests {
    use super::{Secret, SshAuth, StoredConnection};
    use crate::db::DbKind;

    #[test]
    fn stored_connection_without_kind_is_mysql() {
        let json = r#"{"id":"a","name":"n","host":"h","port":3306,"user":"u"}"#;
        let stored: StoredConnection = serde_json::from_str(json).unwrap();
        assert_eq!(stored.kind, DbKind::Mysql);
        assert!(stored.path.is_none());
    }

    #[test]
    fn stored_connection_without_ssh_or_ca_has_none() {
        let json = r#"{"id":"a","name":"n","host":"h","port":3306,"user":"u"}"#;
        let stored: StoredConnection = serde_json::from_str(json).unwrap();
        assert!(stored.ssh.is_none());
        assert!(stored.ssl_ca_path.is_none());
    }

    #[test]
    fn stored_connection_keeps_ssh_settings() {
        let json = r#"{"id":"a","name":"n","host":"h","port":5432,"user":"u","ssl_ca_path":"/ca.pem",
            "ssh":{"host":"bastion","port":22,"user":"deploy","auth":"key","keyPath":"/k"}}"#;
        let stored: StoredConnection = serde_json::from_str(json).unwrap();
        let ssh = stored.ssh.unwrap();
        assert_eq!(ssh.auth, SshAuth::Key);
        assert_eq!(ssh.key_path.as_deref(), Some("/k"));
        assert_eq!(stored.ssl_ca_path.as_deref(), Some("/ca.pem"));
    }

    #[test]
    fn secret_accounts_keep_the_password_account_unchanged() {
        assert_eq!(Secret::Password.account("abc"), "abc");
        assert_eq!(Secret::Ssh.account("abc"), "abc/ssh");
    }

    #[test]
    fn stored_connection_keeps_kind_and_path() {
        let json = r#"{"id":"a","name":"n","kind":"sqlite","host":"","port":0,"user":"","path":"/tmp/x.db"}"#;
        let stored: StoredConnection = serde_json::from_str(json).unwrap();
        assert_eq!(stored.kind, DbKind::Sqlite);
        assert_eq!(stored.path.as_deref(), Some("/tmp/x.db"));
    }

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
