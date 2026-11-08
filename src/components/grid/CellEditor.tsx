import type { CSSProperties, FocusEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CellValue, ColumnMeta } from "../../api/types";
import { NO_AUTOCORRECT } from "../../lib/inputProps";
import { temporalKind } from "../../lib/temporal";
import { TemporalPicker } from "./TemporalPicker";

export type EditAdvance = "down" | "right" | "left" | "none";

interface CellEditorProps {
  meta: ColumnMeta;
  initialValue: string;
  style: CSSProperties;
  onCommit: (value: CellValue, advance: EditAdvance) => void;
  onCancel: () => void;
}

/**
 * In-place cell editor: a text field (typing and pasting work as usual), plus a calendar popup
 * for date/time columns like in DataGrip. An empty date/time is saved as NULL.
 */
export function CellEditor({ meta, initialValue, style, onCommit, onCancel }: CellEditorProps) {
  const kind = temporalKind(meta.typeName);
  const [text, setText] = useState(initialValue);
  const textRef = useRef(text);
  textRef.current = text;
  const cellRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = useCallback(
    (advance: EditAdvance, override?: string) => {
      if (doneRef.current) return;
      doneRef.current = true;
      const raw = override ?? textRef.current;
      if (kind) {
        const trimmed = raw.trim();
        onCommit(trimmed === "" ? null : trimmed, advance);
      } else {
        onCommit(raw, advance);
      }
    },
    [kind, onCommit],
  );

  const cancel = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  }, [onCancel]);

  /** Commits when focus leaves both the text field and the popup (clicking elsewhere). */
  const handleBlur = useCallback(
    (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && (popupRef.current?.contains(next) || next === inputRef.current)) return;
      commit("none");
    },
    [commit],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit("down");
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Tab") {
      e.preventDefault();
      commit(e.shiftKey ? "left" : "right");
    }
  };

  return (
    <div ref={cellRef} className="grid-cell grid-cell-editing" style={style}>
      <input
        ref={inputRef}
        className="grid-cell-input"
        {...NO_AUTOCORRECT}
        value={text}
        placeholder={kind ? placeholderFor(kind) : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
      {kind && (
        <TemporalPicker
          ref={popupRef}
          kind={kind}
          text={text}
          anchorRef={cellRef}
          onChange={setText}
          onCommit={(value) => commit("none", value)}
          onCancel={cancel}
          onBlur={handleBlur}
        />
      )}
    </div>
  );
}

function placeholderFor(kind: NonNullable<ReturnType<typeof temporalKind>>): string {
  if (kind === "date") return "YYYY-MM-DD";
  if (kind === "time") return "HH:MM:SS";
  return "YYYY-MM-DD HH:MM:SS";
}
