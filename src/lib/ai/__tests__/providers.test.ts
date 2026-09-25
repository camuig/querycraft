import { describe, expect, it } from "vitest";
import type { AiModel } from "../../../api/types";
import {
  AI_PROVIDERS,
  detectProviderFromKey,
  isChatModel,
  pickDefaultModel,
  providerById,
  resolveEndpoint,
} from "../providers";

describe("AI_PROVIDERS", () => {
  it("lists every provider in the documented order", () => {
    expect(AI_PROVIDERS.map((p) => p.id)).toEqual([
      "anthropic",
      "openai",
      "gemini",
      "openrouter",
      "deepseek",
      "mistral",
      "ollama",
      "lmstudio",
      "custom",
    ]);
  });

  it("only suggests model ids for anthropic and deepseek", () => {
    for (const preset of AI_PROVIDERS) {
      if (preset.id === "anthropic" || preset.id === "deepseek") {
        expect(preset.suggestedModels.length).toBeGreaterThan(0);
      } else {
        expect(preset.suggestedModels).toEqual([]);
      }
    }
  });

  it("marks only the local runtimes and the custom preset as base-URL editable", () => {
    const editable = AI_PROVIDERS.filter((p) => p.baseUrlEditable).map((p) => p.id);
    expect(editable.sort()).toEqual(["custom", "lmstudio", "ollama"]);
  });

  it("requires a key for every hosted provider, not for local runtimes or the custom preset", () => {
    for (const preset of AI_PROVIDERS) {
      if (preset.local || preset.id === "custom") {
        expect(preset.keyRequired).toBe(false);
      } else {
        expect(preset.keyRequired).toBe(true);
      }
    }
  });
});

describe("providerById", () => {
  it("finds a known provider", () => {
    expect(providerById("openai")?.label).toBe("OpenAI");
  });

  it("returns undefined for an unknown id", () => {
    expect(providerById("not-a-provider")).toBeUndefined();
  });
});

describe("detectProviderFromKey", () => {
  it("detects a provider from its key prefix", () => {
    expect(detectProviderFromKey("sk-ant-abc123")?.id).toBe("anthropic");
    expect(detectProviderFromKey("sk-proj-abc123")?.id).toBe("openai");
    expect(detectProviderFromKey("AIzaSyAbc123")?.id).toBe("gemini");
    expect(detectProviderFromKey("sk-or-abc123")?.id).toBe("openrouter");
  });

  it("returns null for a bare generic prefix shared by several providers", () => {
    expect(detectProviderFromKey("sk-")).toBeNull();
    expect(detectProviderFromKey("sk-abcdef")).toBeNull();
  });

  it("returns null for an empty or unrecognized key", () => {
    expect(detectProviderFromKey("")).toBeNull();
    expect(detectProviderFromKey("   ")).toBeNull();
    expect(detectProviderFromKey("not-a-key")).toBeNull();
  });
});

describe("isChatModel", () => {
  it("accepts ordinary chat/completion model ids", () => {
    expect(isChatModel("claude-sonnet-5")).toBe(true);
    expect(isChatModel("gpt-4o")).toBe(true);
    expect(isChatModel("deepseek-chat")).toBe(true);
  });

  it("rejects embedding, audio and image model families", () => {
    expect(isChatModel("text-embedding-3-small")).toBe(false);
    expect(isChatModel("whisper-1")).toBe(false);
    expect(isChatModel("tts-1")).toBe(false);
    expect(isChatModel("gpt-4o-transcribe")).toBe(false);
    expect(isChatModel("gpt-4o-realtime-preview")).toBe(false);
    expect(isChatModel("dall-e-3")).toBe(false);
    expect(isChatModel("omni-moderation-latest")).toBe(false);
    expect(isChatModel("rerank-english-v3.0")).toBe(false);
  });
});

describe("pickDefaultModel", () => {
  const anthropic = providerById("anthropic");
  if (!anthropic) throw new Error("anthropic preset missing");

  it("prefers the first suggested model that is actually available", () => {
    const models: AiModel[] = [
      { id: "claude-haiku-4-5", name: null },
      { id: "claude-sonnet-5", name: null },
    ];
    // claude-opus-5 is suggested first but absent; claude-sonnet-5 is the next available one.
    expect(pickDefaultModel(anthropic, models)).toBe("claude-sonnet-5");
  });

  it("falls back to the first chat model when nothing suggested is available", () => {
    const models: AiModel[] = [
      { id: "text-embedding-3-small", name: null },
      { id: "gpt-4o", name: null },
    ];
    const openai = providerById("openai");
    if (!openai) throw new Error("openai preset missing");
    expect(pickDefaultModel(openai, models)).toBe("gpt-4o");
  });

  it("returns null when there is nothing usable", () => {
    expect(pickDefaultModel(anthropic, [])).toBeNull();
    expect(pickDefaultModel(anthropic, [{ id: "text-embedding-3-small", name: null }])).toBeNull();
  });
});

describe("resolveEndpoint", () => {
  const anthropic = providerById("anthropic");
  if (!anthropic) throw new Error("anthropic preset missing");

  it("uses the preset's base URL and a null apiKey by default", () => {
    expect(resolveEndpoint(anthropic)).toEqual({
      providerId: "anthropic",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: null,
    });
  });

  it("trims a trailing slash off an overridden base URL", () => {
    const ollama = providerById("ollama");
    if (!ollama) throw new Error("ollama preset missing");
    expect(resolveEndpoint(ollama, "http://localhost:11434/v1/").baseUrl).toBe("http://localhost:11434/v1");
  });

  it("trims the api key and treats a blank one as no key", () => {
    expect(resolveEndpoint(anthropic, undefined, "  sk-ant-abc  ").apiKey).toBe("sk-ant-abc");
    expect(resolveEndpoint(anthropic, undefined, "   ").apiKey).toBeNull();
  });
});
