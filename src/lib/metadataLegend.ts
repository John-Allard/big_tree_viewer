import type { MetadataMarkerShape, MetadataContinuousPalette } from "./metadataColors";
import { formatMetadataDate } from "./metadataDates";
import { metadataTipTableContinuousColor, metadataTipTableColumnMode, metadataTipTableCellAppearance, metadataTipTableStyleForColumn, METADATA_TIP_TABLE_OTHER_COLOR, type MetadataTipTableData, type MetadataTipTableMode, type MetadataTipTableCellStyle } from "./metadataTipTable";

export type MetadataLegendPosition = "top-right" | "bottom-right" | "bottom-left" | "top-left";
export interface MetadataLegendPlacement { x: number; y: number }
export interface MetadataLegendComponents { branchColors: boolean; markers: boolean; pies: boolean; tipTables: boolean }
export function normalizeMetadataLegendComponents(value?: Partial<MetadataLegendComponents>): MetadataLegendComponents {
  return { branchColors: value?.branchColors !== false, markers: value?.markers !== false, pies: value?.pies !== false, tipTables: value?.tipTables !== false };
}
export function normalizeMetadataLegendPlacement(value: unknown): MetadataLegendPlacement | null {
  const point = value as Partial<MetadataLegendPlacement> | null;
  return point && typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y)
    ? { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) } : null;
}
export interface MetadataLegendSection {
  title: string;
  kind?: "branchColors" | "markers" | "pies" | "tipTables";
  entries: Array<{ label: string; color: string; shape?: MetadataMarkerShape; glyph?: string; noSwatch?: boolean }>;
  continuous?: {
    colors: string[]; min: number; max: number; transform: string;
    valueType?: "number" | "date";
    minLabel?: string; maxLabel?: string;
  };
}

/** Use the table's matched-tip ranges and color function, not branch-color settings. */
export function buildMetadataTipTableLegend(data: MetadataTipTableData | null, mode: MetadataTipTableMode,
  palette: MetadataContinuousPalette, cellStyle: MetadataTipTableCellStyle,
  binaryStyle: MetadataTipTableCellStyle = cellStyle, textStyle: MetadataTipTableCellStyle = "text"): MetadataLegendSection[] {
  if (!data?.matchedTipCount) return [];
  return data.columns.flatMap((column): MetadataLegendSection[] => {
    const columnMode = metadataTipTableColumnMode(column, mode);
    const style = metadataTipTableStyleForColumn(column, cellStyle, binaryStyle, textStyle);
    if (column.kind === "text" && style === "text") return [];
    if (columnMode === "categorical") {
      const entries: MetadataLegendSection["entries"] = Object.keys(column.categoryColors).map(label => {
        const cell = metadataTipTableCellAppearance(column, label, style);
        return { label: cell.empty ? `${label} (no mark)` : label, color: cell.color,
          ...(cell.style === "text" || cell.empty ? { glyph: cell.empty || style === "text" ? "" : cell.text, noSwatch: true } : {}),
          ...(!cell.empty && (cell.style === "circle" || cell.style === "square") ? { shape: cell.style } : {}) };
      });
      if (column.hasOtherCategories) entries.push({ label: "Other", color: METADATA_TIP_TABLE_OTHER_COLOR });
      return entries.length ? [{ kind: "tipTables", title: `Tip table: ${column.label}`, entries }] : [];
    }
    if (column.min === null || column.max === null) return [];
    const min = columnMode === "bars" && column.valueType !== "date" ? Math.min(0, column.min) : column.min;
    const max = columnMode === "bars" && column.valueType !== "date" ? Math.max(0, column.max) : column.max;
    const colors = columnMode === "bars" ? ["rgba(37,99,235,0.78)"] : Array.from({ length: 64 }, (_, index) =>
      metadataTipTableContinuousColor(min + (max - min) * index / 63, min, max, palette));
    return [{ kind: "tipTables", title: `${columnMode === "heatmap" ? "Heat map" : "Tip bars"}: ${column.label}`,
      entries: [], continuous: { colors, min, max, transform: "linear", valueType: column.valueType } }];
  });
}
type LegendPrimitive =
  | { kind: "line"; x: number; y: number; width: number; color: string }
  | { kind: "rect"; x: number; y: number; width: number; height: number; color: string }
  | { kind: "text"; x: number; y: number; text: string; bold: boolean; color?: string }
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
      const label = entry.glyph ? entry.label.replace(/^\u2713\s+/, "") : entry.label;
      const lines = wrapped(label, width - 48, false);
      if (cursorY + lines.length * 16 + 28 > maximumHeight) break outer;
      if (entry.glyph) primitives.push({ kind: "text", x: 12, y: cursorY + 8, text: entry.glyph, bold: false, color: entry.color });
      else if (entry.noSwatch) { /* Text-only and absent checks have no colored swatch. */ }
      else if (entry.shape) primitives.push({ kind: "marker", x: 18, y: cursorY + 8, color: entry.color, shape: entry.shape });
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
