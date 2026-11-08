import { describe, expect, it } from "vitest";
import {
  calendarDays,
  daysInMonth,
  nowText,
  parseTemporal,
  shiftMonth,
  temporalKind,
  weekdayLabels,
  withDate,
  withTime,
} from "../temporal";

describe("temporalKind", () => {
  it.each([
    ["DATE", "date"],
    ["Date32", "date"],
    ["Nullable(Date)", "date"],
    ["DATETIME", "datetime"],
    ["DATETIME2", "datetime"],
    ["SMALLDATETIME", "datetime"],
    ["DATETIMEOFFSET", "datetime"],
    ["TIMESTAMP", "datetime"],
    ["TIMESTAMPTZ", "datetime"],
    ["timestamp(3) with time zone", "datetime"],
    ["DateTime64(3, 'UTC')", "datetime"],
    ["LowCardinality(Nullable(DateTime))", "datetime"],
    ["TIME", "time"],
    ["TIMETZ", "time"],
    ["time without time zone", "time"],
  ])("%s -> %s", (type, kind) => {
    expect(temporalKind(type)).toBe(kind);
  });

  it.each(["YEAR", "INTERVAL", "VARCHAR", "INT", "", null, undefined])("%s is not temporal", (type) => {
    expect(temporalKind(type)).toBeNull();
  });
});

describe("parseTemporal", () => {
  it("parses a date", () => {
    expect(parseTemporal("2024-02-29")).toEqual({
      date: { year: 2024, month: 2, day: 29 },
      time: null,
      fraction: "",
      suffix: "",
    });
  });

  it("parses a datetime with fraction and offset", () => {
    expect(parseTemporal("2024-01-02 03:04:05.123+03:00")).toEqual({
      date: { year: 2024, month: 1, day: 2 },
      time: { hour: 3, minute: 4, second: 5 },
      fraction: ".123",
      suffix: "+03:00",
    });
  });

  it("accepts the ISO T separator and missing seconds", () => {
    expect(parseTemporal("2024-01-02T03:04")?.time).toEqual({ hour: 3, minute: 4, second: 0 });
  });

  it("parses a time", () => {
    expect(parseTemporal(" 23:59:58 ")).toEqual({
      date: null,
      time: { hour: 23, minute: 59, second: 58 },
      fraction: "",
      suffix: "",
    });
  });

  it.each(["", "abc", "2023-02-29", "2024-13-01", "25:00:00", "12:60"])("rejects %j", (text) => {
    expect(parseTemporal(text)).toBeNull();
  });
});

describe("withDate / withTime", () => {
  it("replaces the date and keeps the time, fraction and suffix", () => {
    expect(withDate("2024-01-02 03:04:05.5 UTC", "datetime", { year: 2025, month: 12, day: 31 })).toBe(
      "2025-12-31 03:04:05.5 UTC",
    );
  });

  it("starts a datetime at midnight when the text is empty", () => {
    expect(withDate("", "datetime", { year: 2025, month: 3, day: 7 })).toBe("2025-03-07 00:00:00");
  });

  it("formats a date-only column without time", () => {
    expect(withDate("2024-01-02", "date", { year: 2024, month: 1, day: 9 })).toBe("2024-01-09");
  });

  it("replaces the time and keeps the date", () => {
    expect(withTime("2024-01-02 03:04:05", "datetime", { hour: 13, minute: 0, second: 9 })).toBe("2024-01-02 13:00:09");
  });

  it("uses today's date when setting a time on an empty datetime", () => {
    const today = new Date(2026, 10, 8, 12, 0, 0);
    expect(withTime("", "datetime", { hour: 1, minute: 2, second: 3 }, today)).toBe("2026-11-08 01:02:03");
  });

  it("formats a time-only column", () => {
    expect(withTime("10:00:00.25", "time", { hour: 9, minute: 30, second: 0 })).toBe("09:30:00.25");
  });
});

describe("nowText", () => {
  const now = new Date(2026, 0, 5, 7, 8, 9);
  it.each([
    ["date", "2026-01-05"],
    ["datetime", "2026-01-05 07:08:09"],
    ["time", "07:08:09"],
  ] as const)("%s", (kind, expected) => {
    expect(nowText(kind, now)).toBe(expected);
  });
});

describe("calendar", () => {
  it("knows month lengths", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(2024, 12)).toBe(31);
  });

  it("shifts months across years", () => {
    expect(shiftMonth(2024, 12, 1)).toEqual({ year: 2025, month: 1 });
    expect(shiftMonth(2024, 1, -1)).toEqual({ year: 2023, month: 12 });
    expect(shiftMonth(2024, 5, -17)).toEqual({ year: 2022, month: 12 });
  });

  it("lays out six weeks starting on Monday", () => {
    // November 2026 starts on a Sunday.
    const days = calendarDays(2026, 11, 1);
    expect(days).toHaveLength(42);
    expect(days[0]).toEqual({ year: 2026, month: 10, day: 26, inMonth: false });
    expect(days[6]).toEqual({ year: 2026, month: 11, day: 1, inMonth: true });
    expect(days.filter((d) => d.inMonth)).toHaveLength(30);
  });

  it("lays out weeks starting on Sunday", () => {
    expect(calendarDays(2026, 11, 0)[0]).toEqual({ year: 2026, month: 11, day: 1, inMonth: true });
    expect(weekdayLabels(0)[0]).toBe("Su");
    expect(weekdayLabels(1)).toEqual(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
  });
});
