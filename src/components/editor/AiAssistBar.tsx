import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useRef } from "react";
import { extractSql, isDestructiveSql } from "../../lib/ai/prompts";
import { NO_AUTOCORRECT } from "../../lib/inputProps";
import { detectPlatform, formatShortcut } from "../../lib/keymap";
import { useSettingsStore } from "../../store/settingsStore";
import { toast } from "../../store/toastStore";
import type { AiAssistApi } from "./useAiAssist";
import "../../styles/ai.css";

/** "Accept (⌘⏎)" / "Accept (Ctrl+Enter)" — Accept has no keymap entry (it only applies while the bar
 * has focus), so its shortcut label is built directly rather than through `actionTitle`. */
function acceptTitle(): string {
  const platform = detectPlatform();
  return `Accept (${formatShortcut({ code: "Enter", meta: platform === "mac", ctrl: platform !== "mac" }, platform)})`;
}

/** First line of an error message, trimmed for the "Fixing: ..." header. */
function firstLine(text: string, max = 80): string {
  const line = text.split("\n")[0] ?? text;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function headerLabel(api: AiAssistApi): string {
  const mode = api.state.mode;
  if (!mode) return "";
  if (mode.kind === "fix") return `Fixing: ${firstLine(mode.error)}`;
  if (mode.kind === "selection") {
    const lines = mode.text.split("\n").length;
    return `Edit selection (${lines} line${lines === 1 ? "" : "s"})`;
  }
  return "Generate SQL";
}

async function copyText(text: string) {
  try {
    await writeText(text);
  } catch {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
  }
  toast.success("Copied to clipboard");
}

/**
 * Console AI bar: sits between the toolbar and the editor/results split. Purely a view over
 * `useAiAssist`'s state machine — all IPC and prompt building happens in the hook.
 */
export function AiAssistBar({ api }: { api: AiAssistApi }) {
  const { state } = api;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const openSettings = useSettingsStore((s) => s.openDialog);

  const showInput = state.status === "prompting" || state.status === "result";

  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus whenever the bar (re)opens or returns to an editable draft
  useEffect(() => {
    if (showInput) inputRef.current?.focus();
  }, [state.status, state.mode]);

  if (state.status === "closed") return null;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      api.close();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && state.status === "result") {
      e.preventDefault();
      api.accept();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && showInput) {
      e.preventDefault();
      api.submit();
    }
  }

  const sql = state.status === "streaming" || state.status === "result" ? extractSql(state.text) : "";
  const destructive = state.status === "result" && isDestructiveSql(sql);

  return (
    <div className="ai-assist-bar" onKeyDown={handleKeyDown}>
      <div className="ai-assist-header">
        <span className="ai-assist-title">✦ {headerLabel(api)}</span>
        <button type="button" className="icon ai-assist-close" title="Close (Esc)" onClick={api.close}>
          ✕
        </button>
      </div>

      {showInput && (
        <div className="ai-assist-input-row">
          <input
            ref={inputRef}
            {...NO_AUTOCORRECT}
            placeholder={
              state.status === "result"
                ? "Refine: e.g. add a date filter"
                : state.mode?.kind === "selection"
                  ? "How should the selected SQL change?"
                  : "Describe the query you need…"
            }
            value={state.draft}
            onChange={(e) => api.setDraft(e.target.value)}
          />
          <button type="button" className="primary" onClick={api.submit} disabled={!state.draft.trim()}>
            {state.status === "result" ? "Refine" : "Generate"}
          </button>
        </div>
      )}

      {(state.status === "streaming" || state.status === "result") && (
        <pre className="ai-assist-preview mono text-select">{sql || " "}</pre>
      )}

      {state.status === "streaming" && (
        <div className="ai-assist-actions">
          <span className="spinner" />
          <span className="muted">Generating…</span>
          <div className="spacer" />
          <button type="button" onClick={api.stop}>
            ■ Stop
          </button>
        </div>
      )}

      {state.status === "result" && (
        <div className="ai-assist-actions">
          {destructive && (
            <span className="danger ai-assist-warning">Destructive statement — review it before running.</span>
          )}
          <div className="spacer" />
          <button type="button" onClick={() => void copyText(sql)}>
            Copy
          </button>
          <button type="button" onClick={api.regenerate}>
            Regenerate
          </button>
          <button type="button" className="outline" onClick={api.discard}>
            Discard
          </button>
          <button type="button" className="primary" onClick={api.accept} title={acceptTitle()}>
            Accept
          </button>
        </div>
      )}

      {state.status === "error" && (
        <div className="ai-assist-actions">
          <span className="danger ai-assist-error-text">
            {state.error === "Choose an AI provider in Settings" ||
            state.error?.startsWith("Add an API key") ||
            state.error === "Choose a model in Settings" ? (
              <>
                {state.error}.{" "}
                <button type="button" className="link" onClick={() => openSettings("ai")}>
                  Open settings
                </button>
              </>
            ) : (
              state.error
            )}
          </span>
          <div className="spacer" />
          <button type="button" onClick={api.retry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
