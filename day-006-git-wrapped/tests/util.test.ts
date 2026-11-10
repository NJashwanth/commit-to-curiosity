import { describe, expect, it } from "vitest";
import {
  dayNumber,
  escapeHtml,
  formatDate,
  formatDateTime,
  formatHour,
  formatNumber,
  isLeapYear,
  isoFromDayNumber,
  monthOf,
  percent,
  pluralize,
  weekdayOf,
} from "../src/util";

describe("date helpers", () => {
  it("converts between ISO dates and day numbers", () => {
    expect(dayNumber("1970-01-02")).toBe(1);
    expect(isoFromDayNumber(dayNumber("2026-03-04"))).toBe("2026-03-04");
  });

  it("counts consecutive days across month, year and leap boundaries", () => {
    expect(dayNumber("2026-01-01") - dayNumber("2025-12-31")).toBe(1);
    expect(dayNumber("2024-03-01") - dayNumber("2024-02-28")).toBe(2);
    expect(dayNumber("2025-03-01") - dayNumber("2025-02-28")).toBe(1);
  });

  it("finds weekday and month", () => {
    expect(weekdayOf("2026-11-10")).toBe(2); // Tuesday
    expect(weekdayOf("2026-11-08")).toBe(0); // Sunday
    expect(monthOf("2026-11-10")).toBe(10);
  });

  it("detects leap years", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
  });
});

describe("formatting", () => {
  it("formats numbers, hours, dates", () => {
    expect(formatNumber(12345)).toBe("12,345");
    expect(formatHour(0)).toBe("12 AM");
    expect(formatHour(12)).toBe("12 PM");
    expect(formatHour(21)).toBe("9 PM");
    expect(formatHour(5)).toBe("5 AM");
    expect(formatDate("2026-03-04")).toBe("March 4");
    expect(formatDateTime(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02 03:04 UTC");
  });

  it("computes percent and plurals safely", () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(1, 0)).toBe(0);
    expect(pluralize(1, "day")).toBe("day");
    expect(pluralize(2, "day")).toBe("days");
    expect(pluralize(2, "story", "stories")).toBe("stories");
  });
});

describe("escapeHtml", () => {
  it("escapes the five dangerous characters", () => {
    expect(escapeHtml(`<img src=x onerror="a&b">'`)).toBe(
      "&lt;img src=x onerror=&quot;a&amp;b&quot;&gt;&#39;",
    );
  });

  it("stringifies non-strings", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});
