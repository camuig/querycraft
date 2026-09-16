//! Where connection secrets (database passwords, SSH passwords and passphrases) live.
//!
//! Release builds use the system keyring. Development builds (`tauri dev`) keep them in a
//! plain JSON file next to `connections.json` instead: the keyring grants access per code
//! signature, and every rebuild produces a new binary, so macOS would ask for the keychain
//! password on every start. Set `QUERYCRAFT_KEYRING=1` to use the keyring in a dev build.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use keyring::Entry;
use parking_lot::Mutex;

use crate::error::AppResult;

const KEYRING_SERVICE: &str = "QueryCraft";
const DEV_SECRETS_FILE: &str = "secrets.dev.json";

pub enum SecretStore {
    Keyring,
    File {
        path: PathBuf,
        entries: Mutex<BTreeMap<String, String>>,
    },
}

impl SecretStore {
    /// The store for this build: the keyring, or the file in `config_dir` for debug builds.
    pub fn for_build(config_dir: &Path) -> Self {
        let force_keyring = std::env::var_os("QUERYCRAFT_KEYRING").is_some_and(|v| v == "1");
        if cfg!(debug_assertions) && !force_keyring {
            Self::file(config_dir.join(DEV_SECRETS_FILE))
        } else {
            Self::Keyring
        }
    }

    /// A plain-text JSON store at `path` (created on the first write).
    pub fn file(path: PathBuf) -> Self {
        let entries = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self::File {
            path,
            entries: Mutex::new(entries),
        }
    }

    pub fn is_file(&self) -> bool {
        matches!(self, Self::File { .. })
    }

    /// The saved secret, if any. Read errors (keyring unavailable in CI or headless
    /// environments) count as "nothing saved" and are only logged.
    pub fn get(&self, account: &str) -> Option<String> {
        match self {
            Self::Keyring => match Entry::new(KEYRING_SERVICE, account).and_then(|e| e.get_password()) {
                Ok(secret) => Some(secret),
                Err(keyring::Error::NoEntry) => None,
                Err(e) => {
                    log::warn!("Failed to read the secret from the keyring for {account}: {e}");
                    None
                }
            },
            Self::File { entries, .. } => entries.lock().get(account).cloned(),
        }
    }

    pub fn set(&self, account: &str, secret: &str) -> AppResult<()> {
        match self {
            Self::Keyring => Ok(Entry::new(KEYRING_SERVICE, account)?.set_password(secret)?),
            Self::File { path, entries } => {
                let mut entries = entries.lock();
                entries.insert(account.to_string(), secret.to_string());
                Self::persist(path, &entries)
            }
        }
    }

    /// Removes the secret; a missing entry is not an error.
    pub fn delete(&self, account: &str) -> AppResult<()> {
        match self {
            Self::Keyring => match Entry::new(KEYRING_SERVICE, account)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e.into()),
            },
            Self::File { path, entries } => {
                let mut entries = entries.lock();
                if entries.remove(account).is_some() {
                    Self::persist(path, &entries)?;
                }
                Ok(())
            }
        }
    }

    fn persist(path: &Path, entries: &BTreeMap<String, String>) -> AppResult<()> {
        fs::write(path, serde_json::to_vec_pretty(entries)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path() -> PathBuf {
        std::env::temp_dir().join(format!("querycraft-secrets-{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn file_store_round_trips_and_survives_a_reload() {
        let path = temp_path();
        let store = SecretStore::file(path.clone());
        assert!(store.is_file());
        assert_eq!(store.get("c1"), None);
        store.set("c1", "pw").unwrap();
        store.set("c1/ssh", "phrase").unwrap();
        assert_eq!(store.get("c1").as_deref(), Some("pw"));

        let reloaded = SecretStore::file(path.clone());
        assert_eq!(reloaded.get("c1/ssh").as_deref(), Some("phrase"));

        reloaded.delete("c1").unwrap();
        reloaded.delete("missing").unwrap();
        assert_eq!(reloaded.get("c1"), None);
        assert_eq!(SecretStore::file(path.clone()).get("c1/ssh").as_deref(), Some("phrase"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn file_store_tolerates_a_missing_or_broken_file() {
        let path = temp_path();
        assert_eq!(SecretStore::file(path.clone()).get("x"), None);
        fs::write(&path, "not json").unwrap();
        let store = SecretStore::file(path.clone());
        assert_eq!(store.get("x"), None);
        store.set("x", "1").unwrap();
        assert_eq!(SecretStore::file(path.clone()).get("x").as_deref(), Some("1"));
        let _ = fs::remove_file(path);
    }
}
