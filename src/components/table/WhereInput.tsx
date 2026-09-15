import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { NO_AUTOCORRECT } from "../../lib/inputProps";
import { applySuggestion, suggestWhere, type WhereSuggestion } from "../../lib/whereSuggest";

interface WhereInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter with no suggestion list open — apply the filter. */
  onApply: () => void;
  columns: readonly string[];
  placeholder?: string;
}

interface SuggestState {
  items: WhereSuggestion[];
  wordStart: number;
  wordEnd: number;
  active: number;
}

/** WHERE clause input with column name suggestions (no autocomplete: insertion only via Tab/Enter/click). */
export function WhereInput({ value, onChange, onApply, columns, placeholder }: WhereInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [suggest, setSuggest] = useState<SuggestState | null>(null);
  const pendingCaret = useRef<number | null>(null);

  // After insertion, place the caret at the end of the inserted word.
  useEffect(() => {
    if (pendingCaret.current === null) return;
    const el = inputRef.current;
    if (el) el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  const refresh = useCallback(
    (text: string, caret: number) => {
      const r = suggestWhere(text, caret, columns);
      setSuggest(r.items.length > 0 ? { items: r.items, wordStart: r.wordStart, wordEnd: r.wordEnd, active: 0 } : null);
    },
    [columns],
  );

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
    refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const accept = useCallback(
    (index: number) => {
      if (!suggest) return;
      const item = suggest.items[index];
      if (!item) return;
      const next = applySuggestion(value, suggest.wordStart, suggest.wordEnd, item.text);
      pendingCaret.current = next.caret;
      onChange(next.text);
      setSuggest(null);
    },
    [suggest, value, onChange],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggest) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggest({ ...suggest, active: (suggest.active + 1) % suggest.items.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggest({ ...suggest, active: (suggest.active - 1 + suggest.items.length) % suggest.items.length });
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        accept(suggest.active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggest(null);
        return;
      }
    }
    if (e.key === "Enter") {
      onApply();
    }
  };

  return (
    <div className="where-input-wrap">
      <input
        ref={inputRef}
        className="where-input"
        {...NO_AUTOCORRECT}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setSuggest(null)}
        placeholder={placeholder}
      />
      {suggest && (
        <ul className="where-suggest" role="listbox">
          {suggest.items.map((item, i) => (
            <li
              key={`${item.kind}:${item.text}`}
              role="option"
              aria-selected={i === suggest.active}
              className={`where-suggest-item ${item.kind} ${i === suggest.active ? "active" : ""}`}
              // mousedown, not click: otherwise blur closes the list before the click registers.
              onMouseDown={(e) => {
                e.preventDefault();
                accept(i);
              }}
              onMouseEnter={() => setSuggest((s) => (s ? { ...s, active: i } : s))}
            >
              <span className="where-suggest-text">{item.text}</span>
              <span className="where-suggest-kind">{item.kind === "column" ? "column" : "SQL"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
