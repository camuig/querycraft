//! AI assistant backend: a BYOK (bring your own key) chat client over two wire
//! protocols — the Anthropic Messages API and OpenAI-compatible Chat
//! Completions (used by OpenAI itself, and by Gemini, OpenRouter, DeepSeek,
//! Mistral, Ollama, LM Studio, ... through their OpenAI-compatible endpoints).
//!
//! Provider presets (base URLs, model pickers) live in the frontend; this
//! module only knows the wire protocol and the endpoint it is given. API keys
//! are stored in the app's [`crate::secrets::SecretStore`] under the account
//! `ai/<providerId>` and never travel back to the frontend.
//!
//! Module layout: [`sse`] is a pure Server-Sent-Events parser, [`anthropic`]
//! and [`openai`] are the per-protocol request builders and event mappers,
//! [`client`] drives the actual HTTP request/stream, and [`commands`] exposes
//! the Tauri command surface.

mod anthropic;
mod client;
pub mod commands;
mod openai;
mod sse;

use std::collections::HashMap;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// A default `max_tokens` when the caller does not specify one.
const DEFAULT_MAX_TOKENS: u32 = 16_000;

/// Wire protocol spoken by a provider's endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProtocol {
    Anthropic,
    #[serde(rename = "openai")]
    OpenAi,
}

/// Where and how to reach a provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEndpoint {
    pub provider_id: String,
    pub protocol: AiProtocol,
    /// Anthropic: `"https://api.anthropic.com"`. OpenAI-compatible: includes
    /// the API version segment, e.g. `"https://api.openai.com/v1"`.
    pub base_url: String,
    /// `Some` verifies this (unsaved) key instead of the one in the secret
    /// store; `None` loads `ai/<providerId>` from there (which may itself be
    /// absent — a local Ollama server needs no key).
    #[serde(default)]
    pub api_key: Option<String>,
}

/// One turn of the conversation sent to the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    /// `"user"` or `"assistant"`.
    pub role: String,
    pub content: String,
}

/// A chat-completion request, streamed back through an [`AiEvent`] channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    /// Correlates a running request with an [`commands::ai_cancel`] call.
    pub request_id: String,
    pub endpoint: AiEndpoint,
    pub model: String,
    pub system: String,
    pub messages: Vec<AiMessage>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

/// A model a provider offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    pub id: String,
    /// The display name, when the provider gives one.
    pub name: Option<String>,
}

/// Streamed over the `on_event` channel of [`commands::ai_chat`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    Delta {
        text: String,
    },
    Done {
        #[serde(rename = "stopReason")]
        stop_reason: Option<String>,
    },
}

/// What a protocol adapter extracted from one SSE event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SseOutcome {
    Delta(String),
    Done,
}

/// Best-effort extraction of an error message from a JSON response body, in
/// either `{"error": {"message": ...}}` (OpenAI, Anthropic's HTTP errors) or
/// `{"error": "..."}` (some Ollama/LM Studio responses) shape, falling back
/// to a top-level `message` field.
pub(crate) fn extract_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    if let Some(error) = value.get("error") {
        if let Some(message) = error.as_str() {
            return Some(message.to_string());
        }
        if let Some(message) = error.get("message").and_then(serde_json::Value::as_str) {
            return Some(message.to_string());
        }
    }
    value
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

/// Cancellation tokens for `ai_chat` calls in flight, keyed by `requestId`.
#[derive(Default)]
pub struct AiState {
    running: Mutex<HashMap<String, CancellationToken>>,
}

impl AiState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a new request, replacing any stale token left under the same id.
    pub(crate) fn register(&self, request_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.running.lock().insert(request_id.to_string(), token.clone());
        token
    }

    /// Drops the bookkeeping for a finished request (cancelled or not).
    pub(crate) fn unregister(&self, request_id: &str) {
        self.running.lock().remove(request_id);
    }

    /// Cancels a running request; an unknown id is not an error.
    pub(crate) fn cancel(&self, request_id: &str) {
        if let Some(token) = self.running.lock().get(request_id) {
            token.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_protocol_serializes_to_the_wire_names() {
        assert_eq!(serde_json::to_string(&AiProtocol::Anthropic).unwrap(), "\"anthropic\"");
        assert_eq!(serde_json::to_string(&AiProtocol::OpenAi).unwrap(), "\"openai\"");
    }

    #[test]
    fn ai_protocol_deserializes_from_the_wire_names() {
        assert_eq!(
            serde_json::from_str::<AiProtocol>("\"anthropic\"").unwrap(),
            AiProtocol::Anthropic
        );
        assert_eq!(
            serde_json::from_str::<AiProtocol>("\"openai\"").unwrap(),
            AiProtocol::OpenAi
        );
    }

    #[test]
    fn ai_event_delta_serializes_as_camel_case() {
        let event = AiEvent::Delta {
            text: "SELECT 1".to_string(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json, serde_json::json!({"kind": "delta", "text": "SELECT 1"}));
    }

    #[test]
    fn ai_event_done_serializes_stop_reason_as_camel_case() {
        let event = AiEvent::Done {
            stop_reason: Some("end_turn".to_string()),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json, serde_json::json!({"kind": "done", "stopReason": "end_turn"}));
    }

    #[test]
    fn ai_endpoint_defaults_api_key_to_none_when_absent() {
        let json = r#"{"providerId":"anthropic","protocol":"anthropic","baseUrl":"https://api.anthropic.com"}"#;
        let endpoint: AiEndpoint = serde_json::from_str(json).unwrap();
        assert_eq!(endpoint.api_key, None);
    }

    #[test]
    fn extract_message_reads_the_nested_error_object_shape() {
        let body = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        assert_eq!(extract_message(body).as_deref(), Some("invalid x-api-key"));
    }

    #[test]
    fn extract_message_reads_the_flat_error_object_shape() {
        let body = r#"{"error":{"message":"insufficient_quota","type":"insufficient_quota"}}"#;
        assert_eq!(extract_message(body).as_deref(), Some("insufficient_quota"));
    }

    #[test]
    fn extract_message_reads_a_plain_string_error() {
        let body = r#"{"error":"model not found"}"#;
        assert_eq!(extract_message(body).as_deref(), Some("model not found"));
    }

    #[test]
    fn extract_message_falls_back_to_a_top_level_message_field() {
        let body = r#"{"message":"bad request"}"#;
        assert_eq!(extract_message(body).as_deref(), Some("bad request"));
    }

    #[test]
    fn extract_message_is_none_for_unstructured_or_invalid_bodies() {
        assert_eq!(extract_message("not json"), None);
        assert_eq!(extract_message(r#"{"unrelated":true}"#), None);
    }

    #[test]
    fn ai_state_cancel_of_an_unknown_request_id_does_nothing() {
        let state = AiState::new();
        state.cancel("missing");
    }

    #[test]
    fn ai_state_register_then_cancel_cancels_the_token() {
        let state = AiState::new();
        let token = state.register("r1");
        assert!(!token.is_cancelled());
        state.cancel("r1");
        assert!(token.is_cancelled());
    }

    #[test]
    fn ai_state_unregister_drops_the_token() {
        let state = AiState::new();
        let token = state.register("r1");
        state.unregister("r1");
        state.cancel("r1"); // no-op, but must not panic
        assert!(!token.is_cancelled());
    }
}
