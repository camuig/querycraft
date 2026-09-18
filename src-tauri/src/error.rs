//! Unified application error. Tauri commands return `Result<T, AppError>`,
//! `AppError` is serialized as a string — that's what the frontend sees.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// An error reported by a database engine or its driver.
    #[error("{0}")]
    Database(String),

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
                AppError::Database(msg)
            }
            other => AppError::Database(other.to_string()),
        }
    }
}

impl From<tokio_postgres::Error> for AppError {
    fn from(err: tokio_postgres::Error) -> Self {
        match err.as_db_error() {
            Some(db) => {
                let mut msg = format!("[{}] {}", db.code().code(), db.message());
                if let Some(detail) = db.detail() {
                    msg = format!("{msg}\n{detail}");
                }
                if let Some(hint) = db.hint() {
                    msg = format!("{msg}\nHint: {hint}");
                }
                AppError::Database(msg)
            }
            // Connection-level failures ("error performing TLS handshake") only name the
            // cause in their source chain.
            None => AppError::Database(error_chain(&err)),
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::Database(err.to_string())
    }
}

impl From<redis::RedisError> for AppError {
    fn from(err: redis::RedisError) -> Self {
        AppError::Database(err.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        // reqwest includes the full URL (with query text) in its Display output, and the
        // top-level message alone ("error sending request") hides the cause (a rejected
        // certificate, a refused connection), so keep the URL out and the cause chain in.
        AppError::Database(error_chain(&err.without_url()))
    }
}

/// "outer: cause: root cause" — the messages of an error and all its sources.
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut msg = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !msg.contains(&text) {
            msg.push_str(": ");
            msg.push_str(&text);
        }
        source = cause.source();
    }
    msg
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

#[cfg(test)]
mod tests {
    use super::error_chain;

    #[derive(Debug)]
    struct Wrapped(std::io::Error);

    impl std::fmt::Display for Wrapped {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "request failed")
        }
    }

    impl std::error::Error for Wrapped {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }

    #[test]
    fn error_chain_appends_causes() {
        let err = Wrapped(std::io::Error::other("certificate verify failed"));
        assert_eq!(error_chain(&err), "request failed: certificate verify failed");
    }

    #[test]
    fn error_chain_without_source_is_the_message() {
        let err = std::io::Error::other("plain");
        assert_eq!(error_chain(&err), "plain");
    }
}
