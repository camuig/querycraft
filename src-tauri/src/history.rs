//! History of executed queries: `history.json` in the app's data directory,
//! at most `MAX_ENTRIES` entries (older ones are trimmed).

use std::fs;
use std::path::PathBuf;

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppResult;

const HISTORY_FILE: &str = "history.json";
const MAX_ENTRIES: usize = 1000;
/// Limit on the length of saved SQL text in history.
const MAX_SQL_LEN: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryHistoryEntry {
    pub id: String,
    pub connection_id: String,
    pub database: Option<String>,
    pub sql: String,
    /// ISO 8601
    pub executed_at: String,
    pub duration_ms: u64,
    pub success: bool,
}

pub struct History {
    file_path: PathBuf,
    entries: Mutex<Vec<QueryHistoryEntry>>,
}

impl History {
    /// Loads history from `<app_data_dir>/history.json`, creating the directory if needed.
    pub fn load(app: &tauri::AppHandle) -> AppResult<Self> {
        use tauri::Manager;

        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| crate::error::AppError::Other(format!("Failed to determine the data directory: {e}")))?;
        fs::create_dir_all(&data_dir)?;
        let file_path = data_dir.join(HISTORY_FILE);

        let entries: Vec<QueryHistoryEntry> = if file_path.exists() {
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
            entries: Mutex::new(entries),
        })
    }

    /// History stored in an arbitrary file (for tests and debugging).
    pub fn at_path(file_path: PathBuf) -> Self {
        Self {
            file_path,
            entries: Mutex::new(Vec::new()),
        }
    }

    fn persist(&self, entries: &[QueryHistoryEntry]) -> AppResult<()> {
        let json = serde_json::to_vec_pretty(entries)?;
        fs::write(&self.file_path, json)?;
        Ok(())
    }

    /// Adds an entry to the front of history (newest first), trimming the SQL
    /// and the list to their limits, and saves to disk immediately.
    pub fn record(
        &self,
        connection_id: &str,
        database: Option<&str>,
        sql: &str,
        duration_ms: u64,
        success: bool,
    ) -> AppResult<()> {
        let truncated_sql: String = sql.chars().take(MAX_SQL_LEN).collect();
        let entry = QueryHistoryEntry {
            id: Uuid::new_v4().to_string(),
            connection_id: connection_id.to_string(),
            database: database.map(|s| s.to_string()),
            sql: truncated_sql,
            executed_at: Utc::now().to_rfc3339(),
            duration_ms,
            success,
        };

        let mut entries = self.entries.lock();
        entries.insert(0, entry);
        entries.truncate(MAX_ENTRIES);
        self.persist(&entries)
    }

    /// The last `limit` entries, newest first.
    pub fn list(&self, limit: usize) -> Vec<QueryHistoryEntry> {
        let entries = self.entries.lock();
        entries.iter().take(limit).cloned().collect()
    }

    pub fn clear(&self) -> AppResult<()> {
        let mut entries = self.entries.lock();
        entries.clear();
        self.persist(&entries)
    }
}
