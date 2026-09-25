//! Anthropic Messages API adapter: the request body, the models-list
//! response, and the mapping from a Server-Sent Event to a [`SseOutcome`].
//!
//! Reference: <https://docs.anthropic.com/en/api/messages-streaming>.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

use super::{extract_message, AiChatRequest, AiModel, SseOutcome, DEFAULT_MAX_TOKENS};

pub(crate) const API_VERSION: &str = "2023-06-01";

/// `POST {base}/v1/messages` body: streaming on, the system prompt as a
/// cacheable content block, and the conversation as-is.
pub(crate) fn build_request_body(request: &AiChatRequest) -> Value {
    json!({
        "model": request.model,
        "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "stream": true,
        "system": [
            {
                "type": "text",
                "text": request.system,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        "messages": request.messages.iter().map(|m| json!({
            "role": m.role,
            "content": m.content,
        })).collect::<Vec<_>>(),
    })
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
    display_name: Option<String>,
}

/// Parses `GET {base}/v1/models` — `{"data":[{"id","display_name"},...]}` — sorted by id.
pub(crate) fn parse_models(body: &str) -> AppResult<Vec<AiModel>> {
    let parsed: ModelsResponse = serde_json::from_str(body)?;
    let mut models: Vec<AiModel> = parsed
        .data
        .into_iter()
        .map(|m| AiModel {
            id: m.id,
            name: m.display_name,
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

/// Maps one SSE `(event, data)` pair to a [`SseOutcome`], threading the
/// `stop_reason` seen in `message_delta` through to the `message_stop` that
/// ends the stream. A `stop_reason` of `"refusal"` fails the whole request,
/// and an `event: error` frame does too — both carry the same
/// `{"error": {"message": ...}}` shape.
pub(crate) fn handle_event(
    event: Option<&str>,
    data: &str,
    stop_reason: &mut Option<String>,
) -> AppResult<Option<SseOutcome>> {
    match event.unwrap_or_default() {
        "content_block_delta" => {
            let value: Value = serde_json::from_str(data)?;
            if value["delta"]["type"] == "text_delta" {
                if let Some(text) = value["delta"]["text"].as_str() {
                    return Ok(Some(SseOutcome::Delta(text.to_string())));
                }
            }
            // thinking_delta, signature_delta, input_json_delta, ...: ignored.
            Ok(None)
        }
        "message_delta" => {
            let value: Value = serde_json::from_str(data)?;
            if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                *stop_reason = Some(reason.to_string());
            }
            Ok(None)
        }
        "message_stop" => {
            if stop_reason.as_deref() == Some("refusal") {
                return Err(AppError::Other("The model declined this request".to_string()));
            }
            Ok(Some(SseOutcome::Done))
        }
        "error" => {
            let message = extract_message(data).unwrap_or_else(|| "The AI request failed".to_string());
            Err(AppError::Other(message))
        }
        // "ping", "message_start", "content_block_start", "content_block_stop", ...
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiEndpoint, AiMessage, AiProtocol};

    fn request() -> AiChatRequest {
        AiChatRequest {
            request_id: "r1".to_string(),
            endpoint: AiEndpoint {
                provider_id: "anthropic".to_string(),
                protocol: AiProtocol::Anthropic,
                base_url: "https://api.anthropic.com".to_string(),
                api_key: None,
            },
            model: "claude-sonnet".to_string(),
            system: "You are a SQL assistant.".to_string(),
            messages: vec![AiMessage {
                role: "user".to_string(),
                content: "fix this query".to_string(),
            }],
            max_tokens: None,
        }
    }

    #[test]
    fn build_request_body_applies_the_default_max_tokens() {
        let body = build_request_body(&request());
        assert_eq!(body["max_tokens"], DEFAULT_MAX_TOKENS);
        assert_eq!(body["stream"], true);
        assert_eq!(body["model"], "claude-sonnet");
        assert_eq!(body["system"][0]["text"], "You are a SQL assistant.");
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "fix this query");
    }

    #[test]
    fn build_request_body_honors_an_explicit_max_tokens() {
        let mut request = request();
        request.max_tokens = Some(512);
        let body = build_request_body(&request);
        assert_eq!(body["max_tokens"], 512);
    }

    #[test]
    fn parse_models_sorts_by_id_and_keeps_the_display_name() {
        let body =
            r#"{"data":[{"id":"claude-opus","display_name":"Opus"},{"id":"claude-haiku","display_name":"Haiku"}]}"#;
        let models = parse_models(body).unwrap();
        assert_eq!(models[0].id, "claude-haiku");
        assert_eq!(models[0].name.as_deref(), Some("Haiku"));
        assert_eq!(models[1].id, "claude-opus");
    }

    #[test]
    fn parse_models_tolerates_a_missing_display_name() {
        let body = r#"{"data":[{"id":"claude-opus"}]}"#;
        let models = parse_models(body).unwrap();
        assert_eq!(models[0].name, None);
    }

    #[test]
    fn handle_event_emits_a_delta_for_text_delta() {
        let mut stop_reason = None;
        let outcome = handle_event(
            Some("content_block_delta"),
            r#"{"delta":{"type":"text_delta","text":"SELECT"}}"#,
            &mut stop_reason,
        )
        .unwrap();
        assert_eq!(outcome, Some(SseOutcome::Delta("SELECT".to_string())));
    }

    #[test]
    fn handle_event_ignores_non_text_delta_types() {
        let mut stop_reason = None;
        let outcome = handle_event(
            Some("content_block_delta"),
            r#"{"delta":{"type":"thinking_delta","thinking":"..."}}"#,
            &mut stop_reason,
        )
        .unwrap();
        assert_eq!(outcome, None);
    }

    #[test]
    fn handle_event_remembers_the_stop_reason_and_signals_done_on_message_stop() {
        let mut stop_reason = None;
        assert_eq!(
            handle_event(
                Some("message_delta"),
                r#"{"delta":{"stop_reason":"end_turn"}}"#,
                &mut stop_reason
            )
            .unwrap(),
            None
        );
        assert_eq!(stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(
            handle_event(Some("message_stop"), "{}", &mut stop_reason).unwrap(),
            Some(SseOutcome::Done)
        );
    }

    #[test]
    fn handle_event_fails_the_request_on_a_refusal_stop_reason() {
        let mut stop_reason = Some("refusal".to_string());
        let err = handle_event(Some("message_stop"), "{}", &mut stop_reason).unwrap_err();
        assert_eq!(err.to_string(), "The model declined this request");
    }

    #[test]
    fn handle_event_maps_an_error_event_to_an_error() {
        let mut stop_reason = None;
        let err = handle_event(
            Some("error"),
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
            &mut stop_reason,
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "invalid x-api-key");
    }

    #[test]
    fn handle_event_ignores_ping_and_unknown_events() {
        let mut stop_reason = None;
        assert_eq!(handle_event(Some("ping"), "{}", &mut stop_reason).unwrap(), None);
        assert_eq!(
            handle_event(Some("content_block_start"), "{}", &mut stop_reason).unwrap(),
            None
        );
        assert_eq!(handle_event(None, "{}", &mut stop_reason).unwrap(), None);
    }
}
