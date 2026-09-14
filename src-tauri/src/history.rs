//! История выполненных запросов: `history.json` в каталоге данных приложения,
//! не более `MAX_ENTRIES` записей (старые обрезаются).

use std::fs;
use std::path::PathBuf;

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppResult;

const HISTORY_FILE: &str = "history.json";
const MAX_ENTRIES: usize = 1000;
/// Ограничение длины сохранённого SQL-текста в истории.
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
    /// Загружает историю из `<app_data_dir>/history.json`, создавая каталог при необходимости.
    pub fn load(app: &tauri::AppHandle) -> AppResult<Self> {
        use tauri::Manager;

        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| crate::error::AppError::Other(format!("Не удалось определить каталог данных: {e}")))?;
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

        Ok(Self { file_path, entries: Mutex::new(entries) })
    }

    /// История в произвольном файле (для тестов и отладки).
    pub fn at_path(file_path: PathBuf) -> Self {
        Self { file_path, entries: Mutex::new(Vec::new()) }
    }

    fn persist(&self, entries: &[QueryHistoryEntry]) -> AppResult<()> {
        let json = serde_json::to_vec_pretty(entries)?;
        fs::write(&self.file_path, json)?;
        Ok(())
    }

    /// Добавляет запись в начало истории (новые — первыми), обрезая SQL и
    /// список до лимитов, и сразу сохраняет на диск.
    pub fn record(&self, connection_id: &str, database: Option<&str>, sql: &str, duration_ms: u64, success: bool) -> AppResult<()> {
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

    /// Последние `limit` записей, самые новые — первыми.
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
