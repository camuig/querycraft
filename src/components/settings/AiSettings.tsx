import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
import {
  AI_PROVIDERS,
  type AiProviderPreset,
  detectProviderFromKey,
  isChatModel,
  pickDefaultModel,
} from "../../lib/ai/providers";
import { useAiStore } from "../../store/aiStore";
import { useSettingsStore } from "../../store/settingsStore";

/** `readText` needs the real Tauri clipboard plugin; the browser dev server falls back to the Clipboard API. */
async function readClipboardText(): Promise<string> {
  try {
    return await readText();
  } catch {
    return navigator.clipboard.readText();
  }
}

type StatusMessage = { kind: "success" | "error"; text: string } | null;

/** Settings dialog "AI" page: provider, API key, model and base URL for the BYOK assistant. */
export function AiSettings() {
  const providerId = useSettingsStore((s) => s.aiProviderId);
  const setAiProvider = useSettingsStore((s) => s.setAiProvider);
  const aiModels = useSettingsStore((s) => s.aiModels);
  const setAiModel = useSettingsStore((s) => s.setAiModel);
  const aiBaseUrls = useSettingsStore((s) => s.aiBaseUrls);
  const setAiBaseUrl = useSettingsStore((s) => s.setAiBaseUrl);

  const keyStatus = useAiStore((s) => s.keyStatus);
  const modelsByProvider = useAiStore((s) => s.models);
  const refreshKeyStatus = useAiStore((s) => s.refreshKeyStatus);
  const saveKey = useAiStore((s) => s.saveKey);
  const deleteKey = useAiStore((s) => s.deleteKey);
  const loadModels = useAiStore((s) => s.loadModels);

  const preset = useMemo(() => AI_PROVIDERS.find((p) => p.id === providerId), [providerId]);
  const models = providerId ? (modelsByProvider[providerId] ?? []) : [];
  const chatModels = models.filter((m) => isChatModel(m.id));

  const [keyInput, setKeyInput] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [detectedHint, setDetectedHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [modelInput, setModelInput] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: load the saved-key status once, on mount
  useEffect(() => {
    refreshKeyStatus().catch(() => undefined);
  }, []);

  // Once the key status is known, load the current provider's models if it's usable, so the Model
  // select is not empty when the AI tab is reopened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the key-status flag, not the whole map
  useEffect(() => {
    if (!providerId || !preset) return;
    if (modelsByProvider[providerId]) return;
    if (!preset.keyRequired || keyStatus[providerId]) {
      loadModels(providerId).catch(() => undefined);
    }
  }, [providerId, keyStatus[providerId ?? ""]]);

  // Reset the per-provider draft state whenever the selected provider changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-runs only on a provider switch
  useEffect(() => {
    setKeyInput("");
    setReplacing(false);
    setDetectedHint(null);
    setStatus(null);
    setModelInput("");
  }, [providerId]);

  const hasKey = providerId ? !!keyStatus[providerId] : false;
  const showKeySection = !!preset && (preset.keyRequired || preset.id === "custom" || !preset.local);
  const showKeyInput = !hasKey || replacing;

  function selectProvider(id: string) {
    setAiProvider(id);
    const next = AI_PROVIDERS.find((p) => p.id === id);
    if (next && (!next.keyRequired || keyStatus[id])) {
      loadModels(id).catch(() => undefined);
    }
  }

  async function verifyAndPickModel(target: AiProviderPreset) {
    setBusy(true);
    setStatus(null);
    try {
      const loaded = await loadModels(target.id);
      if (!aiModels[target.id]) {
        const def = pickDefaultModel(target, loaded);
        if (def) setAiModel(target.id, def);
      }
      setStatus({ kind: "success", text: `✓ Key verified · ${loaded.length} models` });
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  /** Detects the provider from a pasted/typed key and switches to it when it differs. */
  function applyPastedKey(key: string) {
    const detected = detectProviderFromKey(key);
    if (detected && detected.id !== providerId) {
      setAiProvider(detected.id);
      setDetectedHint(`Detected a ${detected.label} key`);
      return detected;
    }
    return preset;
  }

  async function saveAndVerify(key: string, target: AiProviderPreset) {
    setBusy(true);
    try {
      await saveKey(target.id, key);
    } finally {
      setBusy(false);
    }
    setKeyInput("");
    setReplacing(false);
    if (key) await verifyAndPickModel(target);
    else setStatus(null);
  }

  async function handleSave() {
    if (!preset) return;
    const key = keyInput.trim();
    const target = applyPastedKey(key) ?? preset;
    await saveAndVerify(key, target);
  }

  async function handlePaste() {
    if (!preset) return;
    let text: string;
    try {
      text = (await readClipboardText()).trim();
    } catch {
      return;
    }
    if (!text) return;
    const target = applyPastedKey(text) ?? preset;
    setKeyInput(text);
    await saveAndVerify(text, target);
  }

  function handleKeyInputPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (text) applyPastedKey(text);
  }

  async function handleDeleteKey() {
    if (!preset) return;
    setBusy(true);
    try {
      await deleteKey(preset.id);
    } finally {
      setBusy(false);
    }
    setStatus(null);
    setReplacing(false);
  }

  async function handleRefreshModels() {
    if (!preset) return;
    setBusy(true);
    setStatus(null);
    try {
      const loaded = await loadModels(preset.id);
      setStatus({ kind: "success", text: `${loaded.length} models` });
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ai-settings">
      <div className="ai-provider-grid" role="radiogroup" aria-label="AI provider">
        {AI_PROVIDERS.map((p) => (
          <ProviderTile
            key={p.id}
            preset={p}
            selected={p.id === providerId}
            hasKey={!!keyStatus[p.id]}
            onSelect={selectProvider}
          />
        ))}
      </div>

      {!preset && (
        <p className="form-hint" style={{ gridColumn: "unset", marginTop: 12 }}>
          Choose a provider above to configure it.
        </p>
      )}

      {preset && (
        <>
          {showKeySection && (
            <div className="form-grid" style={{ marginTop: 16 }}>
              <span className="form-label">API key</span>
              {showKeyInput ? (
                <div className="form-row">
                  <input
                    type="password"
                    placeholder={preset.keyPlaceholder ?? "Paste your API key"}
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    onPaste={handleKeyInputPaste}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSave();
                    }}
                    style={{ flex: 1 }}
                    disabled={busy}
                  />
                  <button type="button" onClick={() => void handlePaste()} disabled={busy}>
                    Paste
                  </button>
                  <button type="button" className="primary" onClick={() => void handleSave()} disabled={busy}>
                    Save
                  </button>
                </div>
              ) : (
                <div className="form-row">
                  <input readOnly value="•••••••• saved in the system keychain" style={{ flex: 1 }} />
                  <button type="button" onClick={() => setReplacing(true)} disabled={busy}>
                    Replace
                  </button>
                  <button type="button" onClick={() => void handleDeleteKey()} disabled={busy}>
                    Remove
                  </button>
                </div>
              )}

              {preset.keyUrl && (
                <>
                  <span className="form-label" />
                  <div className="form-row">
                    <button
                      type="button"
                      className="link"
                      style={{ marginLeft: "auto" }}
                      onClick={() => void openUrl(preset.keyUrl as string)}
                    >
                      Get a key ↗
                    </button>
                  </div>
                </>
              )}

              {detectedHint && (
                <>
                  <span className="form-label" />
                  <span className="form-hint" style={{ marginTop: 0 }}>
                    {detectedHint}
                  </span>
                </>
              )}

              {status && (
                <>
                  <span className="form-label" />
                  <span className={status.kind === "success" ? "success" : "danger"} style={{ gridColumn: 2 }}>
                    {status.text}
                  </span>
                </>
              )}
            </div>
          )}

          <div className="form-grid" style={{ marginTop: 12 }}>
            <label htmlFor="ai-model">Model</label>
            <div className="form-row">
              {chatModels.length > 0 ? (
                <select
                  id="ai-model"
                  style={{ flex: 1 }}
                  value={aiModels[preset.id] ?? ""}
                  onChange={(e) => setAiModel(preset.id, e.target.value)}
                >
                  <option value="" disabled>
                    Choose a model…
                  </option>
                  {chatModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name ?? m.id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="ai-model"
                  placeholder="Model id"
                  style={{ flex: 1 }}
                  value={modelInput || (aiModels[preset.id] ?? "")}
                  onChange={(e) => {
                    setModelInput(e.target.value);
                    setAiModel(preset.id, e.target.value);
                  }}
                />
              )}
              <button
                type="button"
                className="icon"
                title="Reload models"
                onClick={() => void handleRefreshModels()}
                disabled={busy}
              >
                ↻
              </button>
            </div>
          </div>

          {preset.baseUrlEditable ? (
            <div className="form-grid" style={{ marginTop: 12 }}>
              <label htmlFor="ai-base-url">Base URL</label>
              <input
                id="ai-base-url"
                placeholder={preset.baseUrl}
                value={aiBaseUrls[preset.id] ?? ""}
                onChange={(e) => setAiBaseUrl(preset.id, e.target.value)}
              />
            </div>
          ) : (
            <div className="form-grid" style={{ marginTop: 12 }}>
              <span className="form-label" />
              <button type="button" className="link" onClick={() => setAdvancedOpen((v) => !v)}>
                {advancedOpen ? "▾ Advanced" : "▸ Advanced"}
              </button>
              {advancedOpen && (
                <>
                  <label htmlFor="ai-base-url-adv">Base URL</label>
                  <input
                    id="ai-base-url-adv"
                    placeholder={preset.baseUrl}
                    value={aiBaseUrls[preset.id] ?? ""}
                    onChange={(e) => setAiBaseUrl(preset.id, e.target.value)}
                  />
                </>
              )}
            </div>
          )}
        </>
      )}

      <p className="form-hint ai-privacy-note">
        The assistant sends your prompt, the query and the structure of the current database's tables (names, columns,
        types, keys, comments) to the selected provider. Row data is never sent. You can limit or disable this per
        connection in the connection settings.
      </p>
    </div>
  );
}

function ProviderTile({
  preset,
  selected,
  hasKey,
  onSelect,
}: {
  preset: AiProviderPreset;
  selected: boolean;
  hasKey: boolean;
  onSelect: (id: string) => void;
}) {
  const usable = hasKey || !preset.keyRequired;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`ai-provider-tile ${selected ? "selected" : ""}`}
      onClick={() => onSelect(preset.id)}
    >
      <div className="ai-provider-tile-header">
        <span className="ai-provider-tile-label">{preset.label}</span>
        <span className={`ai-provider-tile-dot ${usable ? "on" : ""}`} title={usable ? "Key saved" : "No key saved"} />
      </div>
      <span className="ai-provider-tile-hint muted">
        {preset.local ? "Local" : "Cloud"} · {preset.hint}
      </span>
    </button>
  );
}
