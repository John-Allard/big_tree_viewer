import { parseMetadataDate } from "./metadataDates";
import type { TreeModel } from "../types/tree";
import type { FigureStyleSettings } from "./figureStyles";

export function calendarStylesForSubtree(styles: FigureStyleSettings, rootDepthOffset: number): FigureStyleSettings {
  return styles.scale.calendarAxis && Number.isFinite(styles.scale.calendarRootYear)
    ? { ...styles, scale: { ...styles.scale, calendarRootYear: styles.scale.calendarRootYear! + rootDepthOffset } }
    : styles;
}

function yearStart(year: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, 0, 1);
  return date.getTime();
}

export function decimalCalendarYear(milliseconds: number): number {
  const year = new Date(milliseconds).getUTCFullYear();
  return year + (milliseconds - yearStart(year)) / (yearStart(year + 1) - yearStart(year));
}

export function formatCalendarYear(year: number): string {
  if (!Number.isFinite(year) || year < 0 || year >= 10000) return "";
  if (Math.abs(year - Math.round(year)) < 1e-7) return String(Math.round(year));
  const whole = Math.floor(year);
  const date = new Date(yearStart(whole) + (year - whole) * (yearStart(whole + 1) - yearStart(whole)));
  return date.toISOString().slice(0, 10);
}

/** Anchor only an already time-scaled tree; this does not fit a molecular clock. */
export function inferCalendarRootYear(tree: TreeModel | null, values: Array<string | null>): {
  rootYear: number | null; matchedTips: number; message: string;
} {
  if (!tree) return { rootYear: null, matchedTips: 0, message: "Load a dated tree and sampling-date metadata." };
  let lower = -Infinity, upper = Infinity, matchedTips = 0;
  const roundingAllowance = 1 / 365.25;
  for (const node of tree.leafNodes) {
    const raw = values[node]?.trim() ?? "";
    const start = parseMetadataDate(raw);
    if (start === null) continue;
    const end = new Date(start);
    if (raw.length === 4) end.setUTCFullYear(end.getUTCFullYear() + 1);
    else if (raw.length === 7) end.setUTCMonth(end.getUTCMonth() + 1);
    else end.setUTCDate(end.getUTCDate() + 1);
    const depth = tree.buffers.depth[node] - tree.buffers.depth[tree.root];
    lower = Math.max(lower, decimalCalendarYear(start) - depth - roundingAllowance);
    upper = Math.min(upper, decimalCalendarYear(end.getTime()) - depth + roundingAllowance);
    matchedTips += 1;
  }
  if (matchedTips < 2) return { rootYear: null, matchedTips, message: "At least two matched sampling dates are needed to estimate a root year." };
  if (upper < lower) return { rootYear: null, matchedTips, message: "Sampling dates do not agree with branch lengths in years. Keep a branch-length axis or load a dated tree." };
  if (upper - lower > 7 / 365.25) return { rootYear: null, matchedTips, message: "Sampling dates are too imprecise to anchor the calendar axis; enter the known root year instead." };
  const rootYear = (lower + upper) / 2;
  if (rootYear < 0 || rootYear >= 10000) return { rootYear: null, matchedTips, message: "The estimated root year is outside the supported calendar." };
  return { rootYear, matchedTips, message: `${matchedTips.toLocaleString()} sampling dates agree with branch lengths in years.` };
}

/** Place ticks on calendar boundaries rather than arbitrary offsets from the root. */
export function calendarBoundaries(
  rootYear: number, extent: number, levels: Array<{ step: number; alpha: number }>, reverse = false,
): Array<{ value: number; alpha: number }> {
  if (!Number.isFinite(rootYear) || !Number.isFinite(extent) || extent <= 0) return [];
  const result = new Map<string, { value: number; alpha: number }>();
  for (const level of levels) {
    if (!Number.isFinite(level.step) || !(level.step > 0) || extent / level.step > 20000 || level.alpha <= 0) continue;
    const first = Math.ceil((rootYear - 1e-9) / level.step);
    const last = Math.floor((rootYear + extent + 1e-9) / level.step);
    for (let index = first; index <= last; index += 1) {
      const depth = index * level.step - rootYear;
      if (depth < -1e-8 || depth > extent + 1e-8) continue;
      const value = reverse ? extent - depth : depth;
      const key = value.toPrecision(12);
      if (!result.has(key) || result.get(key)!.alpha < level.alpha) result.set(key, { value, alpha: level.alpha });
    }
  }
  return [...result.values()].sort((a, b) => a.value - b.value);
}

/** Include partial edge bands, using the same absolute-year grid as calendar ticks. */
export function calendarBands(rootYear: number, extent: number, step: number): Array<{
  startDepth: number; endDepth: number; calendarIndex: number;
}> {
  if (!Number.isFinite(rootYear) || !Number.isFinite(extent) || !Number.isFinite(step)
    || extent <= 0 || step <= 0 || extent / step > 20000) return [];
  const edges = [0, ...calendarBoundaries(rootYear, extent, [{ step, alpha: 1 }])
    .map(tick => tick.value).filter(depth => depth > 1e-8 && depth < extent - 1e-8), extent];
  return edges.slice(0, -1).map((startDepth, index) => ({
    startDepth,
    endDepth: edges[index + 1],
    calendarIndex: Math.floor((rootYear + (startDepth + edges[index + 1]) / 2) / step),
  }));
}
