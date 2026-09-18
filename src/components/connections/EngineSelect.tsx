import { useCallback, useEffect, useRef, useState } from "react";
import type { DbKind } from "../../api/types";
import { DB_KINDS, dialectFor } from "../../lib/dialect";
import { DbIcon } from "../common/DbIcon";

interface EngineSelectProps {
  value: DbKind;
  onChange: (kind: DbKind) => void;
}

/**
 * Dropdown for the connection dialog's "Type" field: a listbox popover showing every engine's
 * icon + label, replacing a native <select> (which cannot render the icon) and the old
 * `.segmented` row of buttons (which no longer fits with 8+ engines).
 */
export function EngineSelect({ value, onChange }: EngineSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<DbKind>(value);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openList = useCallback(() => {
    setHighlighted(value);
    setOpen(true);
  }, [value]);

  // Clicking outside the trigger/popover closes it.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Move keyboard focus into the popover so Arrow/Enter/Escape work right away.
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  function select(kind: DbKind) {
    onChange(kind);
    close();
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openList();
    }
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    const idx = DB_KINDS.indexOf(highlighted);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlighted(DB_KINDS[Math.min(idx + 1, DB_KINDS.length - 1)]);
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlighted(DB_KINDS[Math.max(idx - 1, 0)]);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        select(highlighted);
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        // Let focus move on as usual (like a native <select>); just close the popover.
        setOpen(false);
        break;
      default:
        break;
    }
  }

  const dialect = dialectFor(value);

  return (
    <div className="engine-select" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="engine-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onTriggerKeyDown}
      >
        <DbIcon kind={value} size={14} />
        <span className="engine-select-label">{dialect.label}</span>
        <span className="engine-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="engine-select-popover"
          role="listbox"
          aria-label="Database engine"
          aria-activedescendant={`engine-option-${highlighted}`}
          ref={listRef}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
        >
          {DB_KINDS.map((k) => (
            <div
              key={k}
              id={`engine-option-${k}`}
              role="option"
              aria-selected={k === value}
              className={`engine-select-option${k === highlighted ? " highlighted" : ""}${k === value ? " active" : ""}`}
              onMouseEnter={() => setHighlighted(k)}
              onClick={() => select(k)}
            >
              <DbIcon kind={k} size={14} />
              <span>{dialectFor(k).label}</span>
              {k === value && (
                <span className="engine-select-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
