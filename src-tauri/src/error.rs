//! Unified application error. Tauri commands return `Result<T, AppError>`,
//! `AppError` is serialized as a string — that's what the frontend sees.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Mysql(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON format error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Password storage error: {0}")]
    Keyring(String),

    #[error("Connection not found: {0}")]
    ConnectionNotFound(String),

    #[error("{0}")]
    Other(String),
}

impl From<mysql_async::Error> for AppError {
    fn from(err: mysql_async::Error) -> Self {
        match err {
            mysql_async::Error::Server(server_error) => {
                let mut msg = format!("[{}] {}", server_error.code, server_error.message);
                if !server_error.state.is_empty() {
                    msg = format!(
                        "[{}, {}] {}",
                        server_error.code, server_error.state, server_error.message
                    );
                }
                AppError::Mysql(msg)
            }
            other => AppError::Mysql(other.to_string()),
        }
    }
}

impl From<keyring::Error> for AppError {
    fn from(err: keyring::Error) -> Self {
        AppError::Keyring(err.to_string())
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Other(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Other(s.to_string())
    }
}

// Tauri commands want Result<T, E: Serialize>; the error is passed to the frontend
// as a plain string (see src/api/commands.ts — it catches a String there).
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
