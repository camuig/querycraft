// Runtime AI assistant state: which providers have a saved key, and their loaded model lists.
// Not persisted — `settingsStore` holds the user's actual choices (provider, model, base URL);
// this store is just what the backend/SecretStore currently reports plus a session-local cache.

import { create } from "zustand";
import * as api from "../api/commands";
import type { AiEndpoint, AiModel } from "../api/types";
import { AI_PROVIDERS, type AiProviderPreset, providerById, resolveEndpoint } from "../lib/ai/providers";
import { useSettingsStore } from "./settingsStore";

interface AiState {
  /** Which provider ids have a saved API key in the backend's SecretStore. */
  keyStatus: Record<string, boolean>;
  /** Last model list loaded per provider id. */
  models: Record<string, AiModel[]>;

  refreshKeyStatus: () => Promise<void>;
  saveKey: (providerId: string, key: string) => Promise<void>;
  deleteKey: (providerId: string) => Promise<void>;
  /** Loads (and caches) a provider's model list; `apiKeyOverride` verifies a key before it is saved. */
  loadModels: (providerId: string, apiKeyOverride?: string) => Promise<AiModel[]>;
}

export const useAiStore = create<AiState>()((set) => ({
  keyStatus: {},
  models: {},

  refreshKeyStatus: async () => {
    const keyStatus = await api.aiKeyStatus(AI_PROVIDERS.map((p) => p.id));
    set({ keyStatus });
  },

  saveKey: async (providerId, key) => {
    await api.aiSetKey(providerId, key);
    set((s) => ({ keyStatus: { ...s.keyStatus, [providerId]: key.trim().length > 0 } }));
  },

  deleteKey: async (providerId) => {
    await api.aiDeleteKey(providerId);
    set((s) => ({ keyStatus: { ...s.keyStatus, [providerId]: false } }));
  },

  loadModels: async (providerId, apiKeyOverride) => {
    const preset = providerById(providerId);
    if (!preset) throw new Error(`Unknown AI provider: ${providerId}`);
    const baseUrlOverride = useSettingsStore.getState().aiBaseUrls[providerId];
    const endpoint = resolveEndpoint(preset, baseUrlOverride, apiKeyOverride);
    const models = await api.aiListModels(endpoint);
    set((s) => ({ models: { ...s.models, [providerId]: models } }));
    return models;
  },
}));

export type ActiveAiConfig = { endpoint: AiEndpoint; model: string; preset: AiProviderPreset };

/**
 * Resolves the provider/model/endpoint the console should use right now, or the reason it can't:
 * no provider chosen yet, a required key missing, or no model chosen yet. UI actions (Generate SQL,
 * Fix with AI) call this first and show the `error` instead of attempting a request.
 */
export function getActiveAiConfig(): ActiveAiConfig | { error: string } {
  const settings = useSettingsStore.getState();
  const providerId = settings.aiProviderId;
  const preset = providerId ? providerById(providerId) : undefined;
  if (!providerId || !preset) {
    return { error: "Choose an AI provider in Settings" };
  }

  if (preset.keyRequired && !useAiStore.getState().keyStatus[providerId]) {
    return { error: `Add an API key for ${preset.label} in Settings` };
  }

  const model = settings.aiModels[providerId];
  if (!model) {
    return { error: "Choose a model in Settings" };
  }

  return { endpoint: resolveEndpoint(preset, settings.aiBaseUrls[providerId]), model, preset };
}
