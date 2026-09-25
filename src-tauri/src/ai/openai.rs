//! OpenAI-compatible Chat Completions adapter (OpenAI itself, and any
//! provider exposing the same wire format: Gemini's OpenAI endpoint,
//! OpenRouter, DeepSeek, Mistral, Ollama, LM Studio, ...).

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

use super::{extract_message, AiChatRequest, AiModel, SseOutcome, DEFAULT_MAX_TOKENS};

/// `POST {base}/chat/completions` body: the system prompt as its own
/// message, streaming on.
pub(crate) fn build_request_body(request: &AiChatRequest) -> Value {
    let mut messages = vec![json!({"role": "system", "content": request.system})];
    messages.extend(
        request
            .messages
            .iter()
            .map(|m| json!({"role": m.role, "content": m.content})),
    );
    json!({
        "model": request.model,
        "stream": true,
        "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "messages": messages,
    })
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

/// Parses `GET {base}/models` — `{"data":[{"id"},...]}` — sorted by id.
pub(crate) fn parse_models(body: &str) -> AppResult<Vec<AiModel>> {
    let parsed: ModelsResponse = serde_json::from_str(body)?;
    let mut models: Vec<AiModel> = parsed
        .data
        .into_iter()
        .map(|m| AiModel { id: m.id, name: None })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

/// Maps one SSE `data:` payload to a [`SseOutcome`]. There is no `event:`
/// line in this protocol — every frame is a plain `data: {...}` (or the
/// literal `data: [DONE]` that ends the stream). `finish_reason` typically
/// arrives on the last content chunk, before `[DONE]`.
pub(crate) fn handle_event(data: &str, stop_reason: &mut Option<String>) -> AppResult<Option<SseOutcome>> {
    if data.trim() == "[DONE]" {
        return Ok(Some(SseOutcome::Done));
    }

    let value: Value = serde_json::from_str(data)?;
    if value.get("error").is_some() {
        let message = extract_message(data).unwrap_or_else(|| "The AI request failed".to_string());
        return Err(AppError::Other(message));
    }

    let Some(choice) = value["choices"].get(0) else {
        return Ok(None);
    };
    if let Some(reason) = choice["finish_reason"].as_str() {
        *stop_reason = Some(reason.to_string());
    }
    match choice["delta"]["content"].as_str() {
        Some(text) if !text.is_empty() => Ok(Some(SseOutcome::Delta(text.to_string()))),
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
                provider_id: "openai".to_string(),
                protocol: AiProtocol::OpenAi,
                base_url: "https://api.openai.com/v1".to_string(),
                api_key: None,
            },
            model: "gpt-5".to_string(),
            system: "You are a SQL assistant.".to_string(),
            messages: vec![AiMessage {
                role: "user".to_string(),
                content: "fix this query".to_string(),
            }],
            max_tokens: None,
        }
    }

    #[test]
    fn build_request_body_puts_the_system_prompt_as_its_own_message() {
        let body = build_request_body(&request());
        assert_eq!(body["max_tokens"], DEFAULT_MAX_TOKENS);
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "You are a SQL assistant.");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "fix this query");
    }

    #[test]
    fn build_request_body_honors_an_explicit_max_tokens() {
        let mut request = request();
        request.max_tokens = Some(256);
        let body = build_request_body(&request);
        assert_eq!(body["max_tokens"], 256);
    }

    #[test]
    fn parse_models_sorts_by_id_with_no_display_name() {
        let body = r#"{"data":[{"id":"gpt-5"},{"id":"gpt-5-mini"}]}"#;
        let models = parse_models(body).unwrap();
        assert_eq!(models[0].id, "gpt-5");
        assert_eq!(models[0].name, None);
        assert_eq!(models[1].id, "gpt-5-mini");
    }

    #[test]
    fn handle_event_emits_a_delta_for_content() {
        let mut stop_reason = None;
        let outcome = handle_event(
            r#"{"choices":[{"delta":{"content":"SELECT"},"finish_reason":null}]}"#,
            &mut stop_reason,
        )
        .unwrap();
        assert_eq!(outcome, Some(SseOutcome::Delta("SELECT".to_string())));
        assert_eq!(stop_reason, None);
    }

    #[test]
    fn handle_event_ignores_a_null_or_missing_content_delta() {
        let mut stop_reason = None;
        assert_eq!(
            handle_event(r#"{"choices":[{"delta":{},"finish_reason":null}]}"#, &mut stop_reason).unwrap(),
            None
        );
        assert_eq!(
            handle_event(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#, &mut stop_reason).unwrap(),
            None
        );
    }

    #[test]
    fn handle_event_captures_the_finish_reason_without_emitting_done() {
        let mut stop_reason = None;
        let outcome = handle_event(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#, &mut stop_reason).unwrap();
        assert_eq!(outcome, None);
        assert_eq!(stop_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn handle_event_done_on_the_done_sentinel() {
        let mut stop_reason = None;
        assert_eq!(
            handle_event("[DONE]", &mut stop_reason).unwrap(),
            Some(SseOutcome::Done)
        );
        // Real streams send it with surrounding whitespace trimmed by the SSE parser already,
        // but tolerate stray whitespace here too.
        assert_eq!(
            handle_event(" [DONE] ", &mut stop_reason).unwrap(),
            Some(SseOutcome::Done)
        );
    }

    #[test]
    fn handle_event_maps_a_top_level_error_field_to_an_error() {
        let mut stop_reason = None;
        let err = handle_event(
            r#"{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}"#,
            &mut stop_reason,
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "Incorrect API key provided");
    }
}
