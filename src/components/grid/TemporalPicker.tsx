import type { FocusEvent, KeyboardEvent, MouseEvent, Ref, RefObject } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type CalendarDay,
  calendarDays,
  dateOf,
  nowText,
  parseTemporal,
  sameDate,
  shiftMonth,
  type TemporalKind,
  type TimeParts,
  weekdayLabels,
  withDate,
  withTime,
} from "../../lib/temporal";

interface TemporalPickerProps {
  ref: Ref<HTMLDivElement>;
  kind: TemporalKind;
  /** Current editor text; the picker reads the date/time from it and writes changes back. */
  text: string;
  /** The editing cell: the popup opens right below it (or above when there is no room). */
  anchorRef: RefObject<HTMLElement | null>;
  onChange: (text: string) => void;
  onCommit: (text: string) => void;
  onCancel: () => void;
  onBlur: (e: FocusEvent) => void;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MARGIN = 8;
const WEEK_START = localeWeekStart();

/** First day of the week for the system locale (0 = Sunday), Monday when unknown. */
function localeWeekStart(): number {
  try {
    type WeekInfo = { firstDay: number };
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => WeekInfo;
      weekInfo?: WeekInfo;
    };
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    if (info) return info.firstDay % 7;
  } catch {
    // Older WebViews: fall through to the ISO default.
  }
  return 1;
}

/** Calendar and time popup for a date/time cell editor (portal, positioned next to the cell). */
export function TemporalPicker({
  ref,
  kind,
  text,
  anchorRef,
  onChange,
  onCommit,
  onCancel,
  onBlur,
}: TemporalPickerProps) {
  const parsed = useMemo(() => parseTemporal(text), [text]);
  const selected = parsed?.date ?? null;
  const today = dateOf(new Date());
  const [view, setView] = useState(() => ({
    year: selected?.year ?? today.year,
    month: selected?.month ?? today.month,
  }));

  // Follow the typed date to its month.
  const selectedYear = selected?.year;
  const selectedMonth = selected?.month;
  useEffect(() => {
    if (selectedYear !== undefined && selectedMonth !== undefined) {
      setView({ year: selectedYear, month: selectedMonth });
    }
  }, [selectedYear, selectedMonth]);

  const popupRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const popup = popupRef.current?.getBoundingClientRect();
      if (!anchor || !popup) return;
      let top = anchor.bottom + 2;
      if (top + popup.height > window.innerHeight - MARGIN) {
        const above = anchor.top - popup.height - 2;
        top = above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - popup.height - MARGIN);
      }
      const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - popup.width - MARGIN));
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    // The cell's ref is attached after this (child) layout effect runs on mount, so place again
    // once it is available.
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef]);

  const setRefs = (el: HTMLDivElement | null) => {
    popupRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as RefObject<HTMLDivElement | null>).current = el;
  };

  const pickDay = (day: CalendarDay) => onChange(withDate(text, kind, day));
  const setTime = (time: TimeParts) => onChange(withTime(text, kind, time));
  const time = parsed?.time ?? { hour: 0, minute: 0, second: 0 };

  const handleMouseDown = (e: MouseEvent) => {
    // Keep the grid from taking focus and selecting cells; keep the caret in the text field
    // unless a time field is being clicked.
    e.stopPropagation();
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      onCommit(text);
    }
  };

  const shift = (delta: number) => setView((v) => shiftMonth(v.year, v.month, delta));

  return createPortal(
    <div
      ref={setRefs}
      className="temporal-picker"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {kind !== "time" && (
        <>
          <div className="tp-header">
            <button type="button" tabIndex={-1} title="Previous year" onClick={() => shift(-12)}>
              «
            </button>
            <button type="button" tabIndex={-1} title="Previous month" onClick={() => shift(-1)}>
              ‹
            </button>
            <span className="tp-title">
              {MONTHS[view.month - 1]} {view.year}
            </span>
            <button type="button" tabIndex={-1} title="Next month" onClick={() => shift(1)}>
              ›
            </button>
            <button type="button" tabIndex={-1} title="Next year" onClick={() => shift(12)}>
              »
            </button>
          </div>
          <div className="tp-grid">
            {weekdayLabels(WEEK_START).map((w) => (
              <span key={w} className="tp-weekday">
                {w}
              </span>
            ))}
            {calendarDays(view.year, view.month, WEEK_START).map((d) => {
              const cls = [
                "tp-day",
                d.inMonth ? "" : "tp-outside",
                sameDate(d, today) ? "tp-today" : "",
                sameDate(d, selected) ? "tp-selected" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={`${d.year}-${d.month}-${d.day}`}
                  type="button"
                  tabIndex={-1}
                  className={cls}
                  onClick={() => pickDay(d)}
                  onDoubleClick={() => onCommit(withDate(text, kind, d))}
                >
                  {d.day}
                </button>
              );
            })}
          </div>
        </>
      )}
      {kind !== "date" && (
        <div className="tp-time">
          <span className="muted">Time</span>
          <TimeField
            value={time.hour}
            max={23}
            label="Hours"
            onChange={(hour) => setTime({ ...time, hour })}
            onBlur={onBlur}
          />
          :
          <TimeField
            value={time.minute}
            max={59}
            label="Minutes"
            onChange={(minute) => setTime({ ...time, minute })}
            onBlur={onBlur}
          />
          :
          <TimeField
            value={time.second}
            max={59}
            label="Seconds"
            onChange={(second) => setTime({ ...time, second })}
            onBlur={onBlur}
          />
        </div>
      )}
      <div className="tp-footer">
        <button type="button" tabIndex={-1} onClick={() => onChange(nowText(kind))}>
          {kind === "date" ? "Today" : "Now"}
        </button>
        <span className="tp-hint muted">Enter to apply, Esc to cancel</span>
        <button type="button" tabIndex={-1} className="primary" onClick={() => onCommit(text)}>
          OK
        </button>
      </div>
    </div>,
    document.body,
  );
}

interface TimeFieldProps {
  value: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
  onBlur: (e: FocusEvent) => void;
}

/** A two-digit hour/minute/second field; ArrowUp/ArrowDown step the value with wrap-around. */
function TimeField({ value, max, label, onChange, onBlur }: TimeFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value).padStart(2, "0");

  return (
    <input
      className="tp-time-field"
      inputMode="numeric"
      aria-label={label}
      maxLength={2}
      value={shown}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        const raw = e.target.value.replace(/\D/g, "");
        setDraft(raw);
        const n = Number(raw);
        if (raw !== "" && n <= max) onChange(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          setDraft(null);
          onChange((value + (e.key === "ArrowUp" ? 1 : max)) % (max + 1));
        }
      }}
      onBlur={(e) => {
        setDraft(null);
        onBlur(e);
      }}
    />
  );
}
