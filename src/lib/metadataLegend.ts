import type { MetadataMarkerShape } from "./metadataColors";
import { formatMetadataDate } from "./metadataDates";

export type MetadataLegendPosition = "top-right" | "bottom-right" | "bottom-left" | "top-left";
export interface MetadataLegendPlacement { x: number; y: number }
export interface MetadataLegendComponents { branchColors: boolean; markers: boolean; pies: boolean }
export function normalizeMetadataLegendComponents(value?: Partial<MetadataLegendComponents>): MetadataLegendComponents {
  return { branchColors: value?.branchColors !== false, markers: value?.markers !== false, pies: value?.pies !== false };
}
export function normalizeMetadataLegendPlacement(value: unknown): MetadataLegendPlacement | null {
  const point = value as Partial<MetadataLegendPlacement> | null;
  return point && typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y)
    ? { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) } : null;
}
export interface MetadataLegendSection {
  title: string;
  kind?: "branchColors" | "markers" | "pies";
  entries: Array<{ label: string; color: string; shape?: MetadataMarkerShape }>;
  continuous?: {
    colors: string[]; min: number; max: number; transform: string;
    valueType?: "number" | "date";
    minLabel?: string; maxLabel?: string;
  };
}
type LegendPrimitive =
  | { kind: "line"; x: number; y: number; width: number; color: string }
  | { kind: "rect"; x: number; y: number; width: number; height: number; color: string }
  | { kind: "text"; x: number; y: number; text: string; bold: boolean }
  | { kind: "marker"; x: number; y: number; shape: MetadataMarkerShape; color: string };

export function metadataLegendPosition(value: unknown): MetadataLegendPosition {
  return value === "bottom-right" || value === "bottom-left" || value === "top-left" ? value : "top-right";
}

export function layoutMetadataLegend(
  context: CanvasRenderingContext2D,
  sections: MetadataLegendSection[],
  viewport: { left: number; width: number; height: number },
  position: MetadataLegendPosition,
  placement?: MetadataLegendPlacement | null,
): { x: number; y: number; width: number; height: number; primitives: LegendPrimitive[] } | null {
  if (!sections.length || viewport.width < 100 || viewport.height < 100) return null;
  const width = Math.min(260, viewport.width - 24);
  const maximumHeight = Math.max(60, viewport.height - 100);
  const primitives: LegendPrimitive[] = [];
  let cursorY = 12;
  let remaining = sections.reduce((count, section) => count + section.entries.length + (section.continuous ? 1 : 0), 0);
  const wrapped = (text: string, available: number, bold: boolean): string[] => {
    context.font = `${bold ? "700 " : ""}12px Arial`;
    const lines: string[] = [];
    let line = "";
    for (const character of text.replace(/_/g, " ")) {
      if (line && context.measureText(line + character).width > available) {
        lines.push(line.trimEnd());
        line = "";
      }
      line += character;
    }
    lines.push(line.trimEnd());
    return lines;
  };
  const textLines = (lines: string[], x: number, bold: boolean): void => {
    for (const text of lines) {
      primitives.push({ kind: "text", x, y: cursorY + 8, text, bold });
      cursorY += 16;
    }
  };
  outer: for (const section of sections) {
    const heading = wrapped(section.title, width - 24, true);
    if (cursorY + heading.length * 16 + 42 > maximumHeight) break;
    textLines(heading, 12, true);
    cursorY += 4;
    if (section.continuous) {
      const { colors, min, max, transform, valueType, minLabel, maxLabel } = section.continuous;
      const barWidth = width - 24;
      for (let index = 0; index < colors.length; index += 1) {
        primitives.push({ kind: "rect", x: 12 + index * barWidth / colors.length, y: cursorY,
          width: Math.min(barWidth - index * barWidth / colors.length, barWidth / colors.length + 1), height: 12, color: colors[index] });
      }
      cursorY += 16;
      const format = valueType === "date" ? formatMetadataDate : (value: number) => Number(value.toPrecision(5)).toString();
      textLines(wrapped(`${minLabel ?? format(min)} to ${maxLabel ?? format(max)}${transform === "linear" ? "" : ` (${transform})`}`, width - 24, false), 12, false);
      remaining -= 1;
    }
    for (const entry of section.entries) {
      const lines = wrapped(entry.label, width - 48, false);
      if (cursorY + lines.length * 16 + 28 > maximumHeight) break outer;
      if (entry.shape) primitives.push({ kind: "marker", x: 18, y: cursorY + 8, color: entry.color, shape: entry.shape });
      else if (section.kind === "branchColors") primitives.push({ kind: "line", x: 12, y: cursorY + 8, width: 14, color: entry.color });
      else primitives.push({ kind: "rect", x: 12, y: cursorY + 2, width: 12, height: 12, color: entry.color });
      textLines(lines, 32, false);
      remaining -= 1;
    }
    cursorY += 8;
  }
  if (remaining) textLines([`+${remaining.toLocaleString()} more entries`], 12, false);
  const height = cursorY + 8;
  const x = placement ? viewport.left + 12 + placement.x * Math.max(0, viewport.width - width - 24)
    : position.endsWith("right") ? viewport.left + viewport.width - width - 12 : viewport.left + 12;
  const y = placement ? 12 + placement.y * Math.max(0, viewport.height - height - 24)
    : position.startsWith("bottom") ? viewport.height - height - 12 : position === "top-left" ? 72 : 12;
  return { x, y, width, height, primitives };
}
