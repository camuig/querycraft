import { useEffect, useRef, useState } from "react";
import { PopupMenu } from "../common/PopupMenu";

export interface AiMenuButtonProps {
  disabled: boolean;
  /** Tooltip shown on the main button when disabled (e.g. why AI is unavailable for this connection). */
  disabledReason?: string;
  mainButtonTitle: string;
  onGenerate: () => void;
  onExplain: () => void;
  onOptimize: () => void;
  onOpenChat: () => void;
  optimizing: boolean;
}

/**
 * Console toolbar "✦ AI" split button: the main part keeps the old one-click "Generate SQL" behavior,
 * the caret opens a menu with the rest of the AI actions (Explain, Optimize, Open AI chat).
 */
export function AiMenuButton({
  disabled,
  disabledReason,
  mainButtonTitle,
  onGenerate,
  onExplain,
  onOptimize,
  onOpenChat,
  optimizing,
}: AiMenuButtonProps) {
  const [pos, setPos] = useState<{ x: number; y: number; anchorHeight: number } | null>(null);
  const caretRef = useRef<HTMLButtonElement | null>(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  function pick(action: () => void) {
    setPos(null);
    action();
  }

  return (
    <div className="ai-menu-button">
      <button
        type="button"
        className="ai-toolbar-button"
        onClick={onGenerate}
        disabled={disabled}
        title={disabled ? disabledReason : mainButtonTitle}
      >
        ✦ AI
      </button>
      <button
        type="button"
        className="icon ai-menu-caret"
        ref={caretRef}
        disabled={disabled}
        title="More AI actions"
        onClick={() => {
          const rect = caretRef.current?.getBoundingClientRect();
          setPos(
            rect
              ? { x: rect.left, y: rect.bottom + 4, anchorHeight: rect.height + 8 }
              : { x: 0, y: 0, anchorHeight: 0 },
          );
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      {open && pos && (
        <PopupMenu x={pos.x} y={pos.y} anchorHeight={pos.anchorHeight}>
          <div className="item" onClick={() => pick(onGenerate)}>
            Generate SQL…
          </div>
          <div className="item" onClick={() => pick(onExplain)}>
            Explain query
          </div>
          <div className={`item${optimizing ? " disabled" : ""}`} onClick={() => !optimizing && pick(onOptimize)}>
            {optimizing ? "Optimizing…" : "Optimize query"}
          </div>
          <div className="divider" />
          <div className="item" onClick={() => pick(onOpenChat)}>
            Open AI chat
          </div>
        </PopupMenu>
      )}
    </div>
  );
}
