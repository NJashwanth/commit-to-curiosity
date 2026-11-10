export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

const MS_PER_DAY = 86_400_000;

/** Whole days since 1970-01-01 for a YYYY-MM-DD string. Calendar math, no time zones involved. */
export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

export function isoFromDayNumber(n: number): string {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(iso: string): number {
  return new Date(dayNumber(iso) * MS_PER_DAY).getUTCDay();
}

/** 0-based month index from YYYY-MM-DD. */
export function monthOf(iso: string): number {
  return Number(iso.slice(5, 7)) - 1;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** 0 -> "12 AM", 13 -> "1 PM". */
export function formatHour(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? "AM" : "PM"}`;
}

/** "2026-03-04" -> "March 4". */
export function formatDate(iso: string): string {
  return `${MONTH_NAMES[monthOf(iso)]} ${Number(iso.slice(8, 10))}`;
}

export function formatDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : (part / whole) * 100;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for safe use in HTML bodies and quoted attributes. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
