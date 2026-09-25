//! Thin `#[tauri::command]` wrappers for the AI assistant — mirrors the style
//! of `crate::commands`. `state.connections.secrets()` is reused rather than
//! opening a second [`crate::secrets::SecretStore`], so key storage and
//! connection-secret storage never race over the same file.

use std::collections::HashMap;

use tauri::State;

use crate::commands::AppState;
use crate::error::AppResult;

use super::client;
use super::{AiChatRequest, AiEndpoint, AiEvent, AiModel, AiState};

/// The `SecretStore` account a provider's key is saved under.
fn key_account(provider_id: &str) -> String {
    format!("ai/{provider_id}")
}

/// `endpoint.apiKey` (an unsaved key being verified) wins over the saved key;
/// a provider with neither (e.g. a local Ollama server) resolves to `None`.
fn resolve_key(state: &AppState, endpoint: &AiEndpoint) -> Option<String> {
    endpoint
        .api_key
        .clone()
        .or_else(|| state.connections.secrets().get(&key_account(&endpoint.provider_id)))
}

/// Which of `provider_ids` currently have a saved key.
#[tauri::command]
pub async fn ai_key_status(state: State<'_, AppState>, provider_ids: Vec<String>) -> AppResult<HashMap<String, bool>> {
    let secrets = state.connections.secrets();
    Ok(provider_ids
        .into_iter()
        .map(|id| {
            let has_key = secrets.get(&key_account(&id)).is_some();
            (id, has_key)
        })
        .collect())
}

/// Saves the key for `provider_id`. `api_key` is trimmed first; an empty
/// result deletes the saved key instead.
#[tauri::command]
pub async fn ai_set_key(state: State<'_, AppState>, provider_id: String, api_key: String) -> AppResult<()> {
    let trimmed = api_key.trim();
    let account = key_account(&provider_id);
    if trimmed.is_empty() {
        state.connections.secrets().delete(&account)
    } else {
        state.connections.secrets().set(&account, trimmed)
    }
}

#[tauri::command]
pub async fn ai_delete_key(state: State<'_, AppState>, provider_id: String) -> AppResult<()> {
    state.connections.secrets().delete(&key_account(&provider_id))
}

/// Lists the models `endpoint` offers; also doubles as "verify this key" from Settings.
#[tauri::command]
pub async fn ai_list_models(state: State<'_, AppState>, endpoint: AiEndpoint) -> AppResult<Vec<AiModel>> {
    let api_key = resolve_key(&state, &endpoint);
    client::list_models(&endpoint, api_key.as_deref()).await
}

/// Streams a chat completion through `on_event`, resolving to the full
/// response text once the stream ends.
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    ai: State<'_, AiState>,
    request: AiChatRequest,
    on_event: tauri::ipc::Channel<AiEvent>,
) -> AppResult<String> {
    let api_key = resolve_key(&state, &request.endpoint);
    let request_id = request.request_id.clone();
    let cancel = ai.register(&request_id);
    let result = client::chat(request, api_key.as_deref(), &on_event, cancel).await;
    ai.unregister(&request_id);
    result
}

/// Cancels a running `ai_chat`; an unknown or already-finished `request_id` is not an error.
#[tauri::command]
pub async fn ai_cancel(ai: State<'_, AiState>, request_id: String) -> AppResult<()> {
    ai.cancel(&request_id);
    Ok(())
}
