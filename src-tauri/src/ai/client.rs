//! HTTP orchestration for the AI backend: builds the client, lists models,
//! and drives a streaming chat request through the SSE parser and the
//! matching protocol adapter. No wire format lives here — see [`super::anthropic`]
//! and [`super::openai`] for that.

use std::time::Duration;

use reqwest::{Client, StatusCode};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};

use super::sse::SseParser;
use super::{anthropic, openai, AiChatRequest, AiEndpoint, AiEvent, AiModel, AiProtocol};

/// Bounds a connection attempt to an unreachable host, mirroring the
/// ClickHouse HTTP transport's `CONNECT_TIMEOUT`.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Bounds how long the server may go silent mid-response; a running chat
/// otherwise streams for as long as the model keeps producing tokens.
const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// Total budget for a `GET /models` call (also used to "verify a key").
const LIST_MODELS_TIMEOUT: Duration = Duration::from_secs(30);

/// The message returned when a chat is cancelled mid-stream.
pub(crate) const CANCELLED: &str = "Cancelled";

fn build_client() -> AppResult<Client> {
    Ok(Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()?)
}

/// Joins a base URL and a path, tolerating a trailing slash on the base
/// (`endpoint.baseUrl` is user-editable, e.g. a local Ollama URL).
pub(crate) fn join_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

/// Turns a non-2xx response into an `AppError`, without ever including the
/// request (and therefore the API key, which only ever goes out in a header) in the message.
fn http_error(status: StatusCode, body: &str) -> AppError {
    let message = super::extract_message(body).unwrap_or_else(|| body.trim().chars().take(300).collect());
    let reason = status.canonical_reason().unwrap_or("");
    let hint = if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        " — check that the API key is valid"
    } else {
        ""
    };
    AppError::Other(format!("{} {reason}: {message}{hint}", status.as_u16()))
}

/// `GET {base}/v1/models` (Anthropic) or `GET {base}/models` (OpenAI-compatible).
pub(crate) async fn list_models(endpoint: &AiEndpoint, api_key: Option<&str>) -> AppResult<Vec<AiModel>> {
    let client = build_client()?;
    let request = match endpoint.protocol {
        AiProtocol::Anthropic => {
            let url = join_url(&endpoint.base_url, "/v1/models?limit=1000");
            let mut request = client.get(url).header("anthropic-version", anthropic::API_VERSION);
            if let Some(key) = api_key {
                request = request.header("x-api-key", key);
            }
            request
        }
        AiProtocol::OpenAi => {
            let url = join_url(&endpoint.base_url, "/models");
            let mut request = client.get(url);
            if let Some(key) = api_key {
                request = request.header("Authorization", format!("Bearer {key}"));
            }
            request
        }
    };

    let response = request.timeout(LIST_MODELS_TIMEOUT).send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(http_error(status, &body));
    }

    match endpoint.protocol {
        AiProtocol::Anthropic => anthropic::parse_models(&body),
        AiProtocol::OpenAi => openai::parse_models(&body),
    }
}

/// Streams a chat completion, sending every text delta and the final `Done`
/// through `on_event`, and returning the accumulated text. Cancelling `cancel`
/// aborts the request (whether still connecting or mid-stream) with
/// [`CANCELLED`].
pub(crate) async fn chat(
    request: AiChatRequest,
    api_key: Option<&str>,
    on_event: &tauri::ipc::Channel<AiEvent>,
    cancel: CancellationToken,
) -> AppResult<String> {
    let client = build_client()?;
    let protocol = request.endpoint.protocol;
    let body = match protocol {
        AiProtocol::Anthropic => anthropic::build_request_body(&request),
        AiProtocol::OpenAi => openai::build_request_body(&request),
    };
    let url = match protocol {
        AiProtocol::Anthropic => join_url(&request.endpoint.base_url, "/v1/messages"),
        AiProtocol::OpenAi => join_url(&request.endpoint.base_url, "/chat/completions"),
    };

    let mut builder = client.post(url).header("content-type", "application/json");
    builder = match protocol {
        AiProtocol::Anthropic => {
            builder = builder.header("anthropic-version", anthropic::API_VERSION);
            match api_key {
                Some(key) => builder.header("x-api-key", key),
                None => builder,
            }
        }
        AiProtocol::OpenAi => match api_key {
            Some(key) => builder.header("Authorization", format!("Bearer {key}")),
            None => builder,
        },
    };

    let mut response = tokio::select! {
        result = builder.body(serde_json::to_vec(&body)?).send() => result?,
        () = cancel.cancelled() => return Err(AppError::Other(CANCELLED.to_string())),
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await?;
        return Err(http_error(status, &body));
    }

    let mut parser = SseParser::new();
    let mut stop_reason: Option<String> = None;
    let mut full_text = String::new();

    loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk?,
            () = cancel.cancelled() => return Err(AppError::Other(CANCELLED.to_string())),
        };
        let Some(chunk) = chunk else {
            break;
        };

        for (event, data) in parser.feed(&chunk) {
            let outcome = match protocol {
                AiProtocol::Anthropic => anthropic::handle_event(event.as_deref(), &data, &mut stop_reason)?,
                AiProtocol::OpenAi => openai::handle_event(&data, &mut stop_reason)?,
            };
            match outcome {
                Some(super::SseOutcome::Delta(text)) => {
                    full_text.push_str(&text);
                    let _ = on_event.send(AiEvent::Delta { text });
                }
                Some(super::SseOutcome::Done) => {
                    let _ = on_event.send(AiEvent::Done {
                        stop_reason: stop_reason.clone(),
                    });
                    return Ok(full_text);
                }
                None => {}
            }
        }
    }

    // The connection closed without an explicit "done" event (e.g. the server
    // dropped the stream early): report what was received so far as finished.
    let _ = on_event.send(AiEvent::Done {
        stop_reason: stop_reason.clone(),
    });
    Ok(full_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_url_trims_a_trailing_slash_on_the_base() {
        assert_eq!(
            join_url("http://localhost:11434/", "/models"),
            "http://localhost:11434/models"
        );
    }

    #[test]
    fn join_url_keeps_a_base_without_a_trailing_slash() {
        assert_eq!(
            join_url("https://api.openai.com/v1", "/models"),
            "https://api.openai.com/v1/models"
        );
    }

    #[test]
    fn join_url_collapses_only_the_boundary_not_internal_slashes() {
        assert_eq!(
            join_url("https://api.anthropic.com//", "/v1/models"),
            "https://api.anthropic.com/v1/models"
        );
    }

    #[test]
    fn http_error_formats_status_and_extracted_message() {
        let err = http_error(
            StatusCode::UNAUTHORIZED,
            r#"{"type":"error","error":{"message":"invalid x-api-key"}}"#,
        );
        assert_eq!(
            err.to_string(),
            "401 Unauthorized: invalid x-api-key — check that the API key is valid"
        );
    }

    #[test]
    fn http_error_without_a_401_or_403_status_has_no_key_hint() {
        let err = http_error(StatusCode::TOO_MANY_REQUESTS, r#"{"error":{"message":"rate limited"}}"#);
        assert_eq!(err.to_string(), "429 Too Many Requests: rate limited");
    }

    #[test]
    fn http_error_falls_back_to_a_truncated_body_when_unstructured() {
        let err = http_error(StatusCode::BAD_GATEWAY, "  <html>not json</html>  ");
        assert_eq!(err.to_string(), "502 Bad Gateway: <html>not json</html>");
    }

    #[test]
    fn http_error_never_echoes_back_a_provided_api_key() {
        // The api key never appears in a response body in the first place — this just
        // documents that http_error only ever looks at (status, body), never a key.
        let err = http_error(StatusCode::FORBIDDEN, r#"{"error":{"message":"forbidden"}}"#);
        assert!(!err.to_string().contains("sk-"));
    }
}
