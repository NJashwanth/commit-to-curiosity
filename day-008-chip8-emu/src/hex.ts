/** Format a number as upper-case hex, zero padded to `width` digits. */
export function hex(value: number, width = 2): string {
  return value.toString(16).toUpperCase().padStart(width, "0");
}
