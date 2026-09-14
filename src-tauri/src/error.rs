//! Единая ошибка приложения. Команды Tauri возвращают `Result<T, AppError>`,
//! `AppError` сериализуется как строка — именно её видит фронтенд.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Mysql(String),

    #[error("Ошибка ввода/вывода: {0}")]
    Io(#[from] std::io::Error),

    #[error("Ошибка формата JSON: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Ошибка хранилища паролей: {0}")]
    Keyring(String),

    #[error("Подключение не найдено: {0}")]
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
                    msg = format!("[{}, {}] {}", server_error.code, server_error.state, server_error.message);
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

// Команды Tauri хотят Result<T, E: Serialize>, ошибка передаётся во фронтенд
// в виде обычной строки (см. src/api/commands.ts — там ловится String).
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
