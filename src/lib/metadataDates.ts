/** ISO calendar dates in UTC milliseconds. Partial dates use the first day/month. */
export function parseMetadataDate(value: string): number | null {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2] ?? 1);
  const day = Number(match[3] ?? 1);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // setUTCFullYear avoids Date.UTC's special treatment of years 00 through 99.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.getTime()
    : null;
}

/** Locale-independent ISO day label; empty for invalid or non-four-digit years. */
export function formatMetadataDate(value: number): string {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(value) || !Number.isFinite(year) || year < 0 || year > 9999) return "";
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
