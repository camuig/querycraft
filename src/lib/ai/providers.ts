// AI provider presets for the assistant's Settings section. Two wire protocols cover every
// provider: Anthropic's Messages API, and the OpenAI-compatible Chat Completions API that OpenAI,
// Gemini, OpenRouter, DeepSeek, Mistral, Ollama, LM Studio and any custom endpoint all speak.
// The backend only ever sees `{ providerId, protocol, baseUrl, apiKey? }` (see `AiEndpoint`);
// everything provider-specific (labels, key format, suggested models) lives here.

import type { AiEndpoint, AiModel, AiProtocol } from "../../api/types";

export interface AiProviderPreset {
  id: string;
  label: string;
  protocol: AiProtocol;
  baseUrl: string;
  /** Runs on the user's machine: no API key, base URL points at localhost. */
  local: boolean;
  keyRequired: boolean;
  /** Where to create/manage an API key for this provider. */
  keyUrl?: string;
  /** Known key prefixes, used to auto-detect the provider from a pasted key. */
  keyPrefixes?: string[];
  keyPlaceholder?: string;
  /** Model ids to prefer as the default pick when they appear in `aiListModels`. */
  suggestedModels: string[];
  /** One-line description shown next to the provider in Settings. */
  hint: string;
  /** Whether the user can edit the base URL (local runtimes and the custom preset). */
  baseUrlEditable: boolean;
}

export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    local: false,
    keyRequired: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPrefixes: ["sk-ant-"],
    keyPlaceholder: "sk-ant-...",
    suggestedModels: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    hint: "Claude models, direct from Anthropic.",
    baseUrlEditable: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    local: false,
    keyRequired: true,
    keyUrl: "https://platform.openai.com/api-keys",
    keyPrefixes: ["sk-proj-"],
    keyPlaceholder: "sk-proj-...",
    suggestedModels: [],
    hint: "GPT models, direct from OpenAI.",
    baseUrlEditable: false,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    local: false,
    keyRequired: true,
    keyUrl: "https://aistudio.google.com/apikey",
    keyPrefixes: ["AIza"],
    keyPlaceholder: "AIza...",
    suggestedModels: [],
    hint: "Gemini models, through Google's OpenAI-compatible endpoint.",
    baseUrlEditable: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    local: false,
    keyRequired: true,
    keyUrl: "https://openrouter.ai/keys",
    keyPrefixes: ["sk-or-"],
    keyPlaceholder: "sk-or-...",
    suggestedModels: [],
    hint: "One key, many models routed through OpenRouter.",
    baseUrlEditable: false,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    local: false,
    keyRequired: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    suggestedModels: ["deepseek-chat"],
    hint: "DeepSeek models, direct from DeepSeek.",
    baseUrlEditable: false,
  },
  {
    id: "mistral",
    label: "Mistral",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    local: false,
    keyRequired: true,
    keyUrl: "https://console.mistral.ai/api-keys",
    suggestedModels: [],
    hint: "Mistral models, direct from Mistral.",
    baseUrlEditable: false,
  },
  {
    id: "ollama",
    label: "Ollama",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    local: true,
    keyRequired: false,
    suggestedModels: [],
    hint: "Models running locally through Ollama. No API key needed.",
    baseUrlEditable: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    protocol: "openai",
    baseUrl: "http://localhost:1234/v1",
    local: true,
    keyRequired: false,
    suggestedModels: [],
    hint: "Models running locally through LM Studio. No API key needed.",
    baseUrlEditable: true,
  },
  {
    id: "custom",
    label: "OpenAI-compatible",
    protocol: "openai",
    baseUrl: "",
    local: false,
    keyRequired: false,
    suggestedModels: [],
    hint: "Any other OpenAI-compatible endpoint. Set its base URL below.",
    baseUrlEditable: true,
  },
];

export function providerById(id: string): AiProviderPreset | undefined {
  return AI_PROVIDERS.find((p) => p.id === id);
}

/**
 * Guesses the provider from a pasted API key by its prefix. When several providers' prefixes
 * match, the longest (most specific) one wins. A key that starts with a generic prefix shared by
 * several providers but matches none of them exactly (e.g. a bare "sk-") is ambiguous and returns
 * null rather than guessing wrong.
 */
export function detectProviderFromKey(key: string): AiProviderPreset | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  let best: { preset: AiProviderPreset; prefix: string } | null = null;
  for (const preset of AI_PROVIDERS) {
    for (const prefix of preset.keyPrefixes ?? []) {
      if (trimmed.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
        best = { preset, prefix };
      }
    }
  }
  return best?.preset ?? null;
}

/** Model families that are not chat/completion models and should not be offered as a chat model. */
const NON_CHAT_MODEL = /embedding|tts|whisper|transcribe|audio|realtime|image|dall-e|moderation|rerank/i;

export function isChatModel(id: string): boolean {
  return !NON_CHAT_MODEL.test(id);
}

/**
 * Picks the model a provider should default to once its model list has loaded: the first
 * suggested model that is actually available, otherwise the first chat model, otherwise null
 * (nothing usable — the list may be empty or embeddings/TTS-only).
 */
export function pickDefaultModel(preset: AiProviderPreset, models: AiModel[]): string | null {
  const available = new Set(models.map((m) => m.id));
  for (const suggested of preset.suggestedModels) {
    if (available.has(suggested)) return suggested;
  }
  return models.find((m) => isChatModel(m.id))?.id ?? null;
}

/**
 * Builds the endpoint sent to the backend. `baseUrlOverride` is the user's override from
 * `settingsStore` (for local runtimes and the custom preset); `apiKey` is only passed when
 * verifying a key that has not been saved yet — otherwise the backend loads the saved one.
 */
export function resolveEndpoint(preset: AiProviderPreset, baseUrlOverride?: string, apiKey?: string): AiEndpoint {
  const baseUrl = (baseUrlOverride?.trim() || preset.baseUrl).replace(/\/+$/, "");
  return {
    providerId: preset.id,
    protocol: preset.protocol,
    baseUrl,
    apiKey: apiKey?.trim() || null,
  };
}
