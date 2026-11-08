// Date/time helpers for the grid's temporal cell editor: column kind detection, parsing and
// formatting of the engine's text representation, and the calendar month layout.

export type TemporalKind = "date" | "datetime" | "time";

export interface DateParts {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
}

export interface TimeParts {
  hour: number;
  minute: number;
  second: number;
}

/**
 * A parsed temporal value. Parts the editor does not touch (fractional seconds, a time zone
 * offset or any other trailing text) are kept verbatim so that picking a day does not lose them.
 */
export interface TemporalValue {
  date: DateParts | null;
  time: TimeParts | null;
  /** Fractional seconds including the dot (".123"), or "". */
  fraction: string;
  /** Text after the time/date, e.g. "+03:00", " UTC", "Z", or "". */
  suffix: string;
}

const DATE_RE = /^(\d{4,})-(\d{1,2})-(\d{1,2})/;
/** ClickHouse type wrappers that do not change how the value is edited. */
const WRAPPER_RE = /^(?:NULLABLE|LOWCARDINALITY)\((.*)\)$/;
const TIME_RE = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(\.\d+)?/;

/**
 * Editor kind for an engine type name, or null when the column is not a calendar date/time.
 * Covers MySQL/MariaDB, PostgreSQL, SQL Server, SQLite declared types and ClickHouse
 * (`Nullable(DateTime64(3, 'UTC'))`). YEAR and INTERVAL are deliberately excluded.
 */
export function temporalKind(typeName: string | null | undefined): TemporalKind | null {
  if (!typeName) return null;
  let t = typeName.trim().toUpperCase();
  for (let m = WRAPPER_RE.exec(t); m; m = WRAPPER_RE.exec(t)) t = m[1].trim();
  const base = t.replace(/\(.*\)$/, "").trim();
  if (base === "DATE" || base === "DATE32") return "date";
  if (
    /^(DATETIME(2|64|OFFSET)?|SMALLDATETIME|TIMESTAMPTZ|TIMESTAMP)$/.test(base) ||
    /^TIMESTAMP(\(\d+\))? WITH(OUT)? TIME ZONE$/.test(t)
  ) {
    return "datetime";
  }
  if (base === "TIME" || base === "TIMETZ" || /^TIME(\(\d+\))? WITH(OUT)? TIME ZONE$/.test(t)) return "time";
  return null;
}

function inRange(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

function validDate(d: DateParts): boolean {
  return inRange(d.month, 1, 12) && inRange(d.day, 1, daysInMonth(d.year, d.month));
}

function validTime(t: TimeParts): boolean {
  return inRange(t.hour, 0, 23) && inRange(t.minute, 0, 59) && inRange(t.second, 0, 59);
}

/** Parses "YYYY-MM-DD", "YYYY-MM-DD HH:MM[:SS[.fff]][suffix]" (also with "T") or "HH:MM[:SS[.fff]][suffix]". */
export function parseTemporal(text: string): TemporalValue | null {
  let rest = text.trim();
  let date: DateParts | null = null;
  let time: TimeParts | null = null;
  let fraction = "";

  const dm = DATE_RE.exec(rest);
  if (dm) {
    date = { year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]) };
    if (!validDate(date)) return null;
    rest = rest.slice(dm[0].length);
    const sep = /^[ T]/.exec(rest);
    if (sep && TIME_RE.test(rest.slice(1))) rest = rest.slice(1);
    else return { date, time: null, fraction: "", suffix: rest };
  }

  const tm = TIME_RE.exec(rest);
  if (!tm) return date ? { date, time, fraction, suffix: rest } : null;
  time = { hour: Number(tm[1]), minute: Number(tm[2]), second: Number(tm[3] ?? 0) };
  if (!validTime(time)) return null;
  fraction = tm[4] ?? "";
  return { date, time, fraction, suffix: rest.slice(tm[0].length) };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function formatDate(d: DateParts): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

export function formatTime(t: TimeParts): string {
  return `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
}

/** Formats a value for the given kind, keeping its fraction and suffix; missing parts come from `fallback`. */
export function formatTemporal(value: TemporalValue, kind: TemporalKind, fallback: Date = new Date()): string {
  const date = value.date ?? dateOf(fallback);
  const time = value.time ?? { hour: 0, minute: 0, second: 0 };
  const tail = `${value.fraction}${value.suffix}`;
  if (kind === "date") return `${formatDate(date)}${value.suffix}`;
  if (kind === "time") return `${formatTime(time)}${tail}`;
  return `${formatDate(date)} ${formatTime(time)}${tail}`;
}

/** Replaces the date of `text` (or starts a new value) keeping its time, fraction and suffix. */
export function withDate(text: string, kind: TemporalKind, date: DateParts): string {
  const v = parseTemporal(text) ?? { date: null, time: null, fraction: "", suffix: "" };
  return formatTemporal({ ...v, date }, kind);
}

/** Replaces the time of `text` (or starts a new value with today's date) keeping fraction and suffix. */
export function withTime(text: string, kind: TemporalKind, time: TimeParts, today: Date = new Date()): string {
  const v = parseTemporal(text) ?? { date: null, time: null, fraction: "", suffix: "" };
  return formatTemporal({ ...v, time }, kind, today);
}

export function dateOf(d: Date): DateParts {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

export function timeOf(d: Date): TimeParts {
  return { hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
}

/** The local current date/time formatted for the kind ("Today" for dates, "Now" otherwise). */
export function nowText(kind: TemporalKind, now: Date = new Date()): string {
  return formatTemporal({ date: dateOf(now), time: timeOf(now), fraction: "", suffix: "" }, kind, now);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Adds `delta` months to (year, month), returning the normalized pair. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export interface CalendarDay extends DateParts {
  inMonth: boolean;
}

/**
 * Six weeks of days covering the month, starting on `weekStart` (0 = Sunday, 1 = Monday, ...),
 * padded with the trailing days of the previous month and the leading days of the next one.
 */
export function calendarDays(year: number, month: number, weekStart = 1): CalendarDay[] {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const lead = (firstWeekday - weekStart + 7) % 7;
  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(year, month - 1, 1 - lead + i));
    days.push({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() + 1 === month,
    });
  }
  return days;
}

/** Short weekday names starting on `weekStart`. */
export function weekdayLabels(weekStart = 1): string[] {
  const names = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  return names.map((_, i) => names[(weekStart + i) % 7]);
}

export function sameDate(a: DateParts | null, b: DateParts | null): boolean {
  return !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day;
}
