import type { TreeModel } from "../types/tree";
import { METADATA_CONTINUOUS_PALETTES, type MetadataContinuousPalette } from "./metadataColors";
import { parseMetadataDate } from "./metadataDates";

export type MetadataTipTableMode = "bars" | "heatmap" | "categorical";
export type MetadataTipTableCellStyle = "filled" | "circle" | "square" | "check" | "check-cross" | "text";
export type MetadataTipTableValueType = "number" | "date";

export interface MetadataTipTableColumn {
  column: string;
  label?: string;
  valueType?: MetadataTipTableValueType;
}

export interface MetadataTipTableColumnData extends MetadataTipTableColumn {
  label: string;
  kind: "number" | "date" | "binary" | "categorical" | "text";
  hasOtherCategories: boolean;
  min: number | null;
  max: number | null;
  categoryColors: Record<string, string>;
}

export const METADATA_TIP_TABLE_CATEGORY_LIMIT = 20;
export const METADATA_TIP_TABLE_OTHER_COLOR = "#94a3b8";

export function metadataTipTableColumnMode(column: MetadataTipTableColumnData, mode: MetadataTipTableMode): MetadataTipTableMode {
  return column.kind === "binary" || column.kind === "categorical" || column.kind === "text" ? "categorical" : mode === "bars" ? "bars" : "heatmap";
}

export function normalizeMetadataTipTableCellStyle(value: unknown, fallback: MetadataTipTableCellStyle): MetadataTipTableCellStyle {
  return ["filled", "circle", "square", "check", "check-cross", "text"].includes(value as string) ? value as MetadataTipTableCellStyle : fallback;
}

export function metadataTipTableStyleForColumn(column: MetadataTipTableColumnData, categorical: MetadataTipTableCellStyle,
  binary: MetadataTipTableCellStyle = categorical, text: MetadataTipTableCellStyle = "text"): MetadataTipTableCellStyle {
  return column.kind === "binary" ? binary : column.kind === "text" ? text : categorical;
}

export function metadataTipTableCellAppearance(column: MetadataTipTableColumnData, value: string, style: MetadataTipTableCellStyle): {
  color: string; style: "filled" | "circle" | "square" | "text"; text: string; empty: boolean;
} {
  const binary = column.kind === "binary";
  const on = metadataTipTableValueIsOn(value);
  const color = binary ? "#2563eb" : column.categoryColors[value] ?? METADATA_TIP_TABLE_OTHER_COLOR;
  if (binary && (style === "check" || style === "check-cross")) {
    return { color: on ? "#16a34a" : "#64748b", style: "text", text: on ? "\u2713" : "\u00d7", empty: !on && style === "check" };
  }
  return { color: style === "text" ? "#0f172a" : color,
    style: style === "check" || style === "check-cross" ? "filled" : style,
    text: value, empty: binary && !on && style !== "text" };
}

export interface MetadataTipTableData {
  columns: MetadataTipTableColumnData[];
  valuesByNode: Array<string[] | null>;
  matchedTipCount: number;
}

const CATEGORY_COLORS = [
  "#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed", "#0891b2",
  "#be123c", "#4338ca", "#65a30d", "#c2410c", "#0f766e", "#b45309",
  "#db2777", "#0369a1", "#15803d", "#a16207", "#9333ea", "#b91c1c", "#4d7c0f", "#57534e",
];

function normalizeKey(value: string): string {
  return value.trim().replace(/^['"]+|['"]+$/g, "").replaceAll("_", " ").replace(/\s+/g, " ").toLowerCase();
}

export function metadataTipTableDisplayLabel(value: string): string {
  return value.trim().replaceAll("_", " ").replace(/\s+/g, " ");
}

export function metadataTipTableValueIsOn(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized !== ""
    && Number(normalized) !== 0
    && normalized !== "0"
    && normalized !== "false"
    && normalized !== "no"
    && normalized !== "n"
    && normalized !== "f"
    && normalized !== "off"
    && normalized !== "absent"
    && normalized !== "none"
    && normalized !== "na"
    && normalized !== "n/a";
}

/** Shared by bounds calculation and renderers; raw cell text remains unchanged. */
export function metadataTipTableNumericValue(value: string, valueType: MetadataTipTableValueType = "number"): number | null {
  if (valueType === "date") return parseMetadataDate(value);
  const numeric = Number(value);
  return value.trim() && Number.isFinite(numeric) ? numeric : null;
}

export function metadataTipTableContinuousColor(
  value: number,
  min: number,
  max: number,
  palette: MetadataContinuousPalette,
): string {
  const stops = METADATA_CONTINUOUS_PALETTES[palette].stops;
  const t = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0.5;
  const scaled = t * Math.max(0, stops.length - 1);
  const leftIndex = Math.floor(scaled);
  const rightIndex = Math.min(stops.length - 1, leftIndex + 1);
  const localT = scaled - leftIndex;
  const parse = (color: string): [number, number, number] => [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
  const left = parse(stops[leftIndex]);
  const right = parse(stops[rightIndex]);
  const channel = (index: number): string => Math.round(left[index] + ((right[index] - left[index]) * localT))
    .toString(16)
    .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

export function buildMetadataTipTableData(
  tree: TreeModel,
  rows: Array<Record<string, string>>,
  keyColumn: string,
  selectedColumns: MetadataTipTableColumn[],
): MetadataTipTableData {
  const columns: MetadataTipTableColumnData[] = selectedColumns.map((selection) => ({
    ...selection,
    label: metadataTipTableDisplayLabel(selection.label || selection.column),
    min: null as number | null,
    max: null as number | null,
    categoryColors: Object.create(null) as Record<string, string>,
    kind: "categorical",
    hasOtherCategories: false,
  }));
  const valuesByNode = new Array<string[] | null>(tree.nodeCount).fill(null);
  if (!keyColumn || columns.length === 0) {
    return { columns, valuesByNode, matchedTipCount: 0 };
  }

  const tipsByName = new Map<string, number[]>();
  for (let index = 0; index < tree.leafNodes.length; index += 1) {
    const node = tree.leafNodes[index];
    const key = normalizeKey(tree.names[node] ?? "");
    if (!key) {
      continue;
    }
    const nodes = tipsByName.get(key) ?? [];
    nodes.push(node);
    tipsByName.set(key, nodes);
  }

  const matchedTips = new Set<number>();
  const stats = columns.map(() => ({ count: 0, categoryCount: 0, numeric: true, date: true, binary: true, text: true, isoDate: false,
    years: true, dateMin: Infinity, dateMax: -Infinity }));
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const key = normalizeKey(rows[rowIndex][keyColumn] ?? "");
    const nodes = tipsByName.get(key);
    if (!nodes) {
      continue;
    }
    const values = columns.map((column, columnIndex) => {
      const value = (rows[rowIndex][column.column] ?? "").trim();
      if (!value || /^(?:na|n\/a|null|nan|unknown)$/i.test(value)) return "";
      const stat = stats[columnIndex];
      stat.count++;
      const numeric = metadataTipTableNumericValue(value, "number");
      const date = parseMetadataDate(value);
      stat.numeric &&= numeric !== null;
      stat.date &&= date !== null;
      stat.binary &&= numeric === 0 || numeric === 1 || /^(?:true|false|yes|no|on|off|present|absent|none)$/i.test(value)
        || (/resistan|present|flag|binary|enabled|positive|detected/i.test(column.column) && /^[yntf]$/i.test(value));
      stat.text &&= /^[A-Za-z*?.-]{1,3}$/.test(value);
      stat.isoDate ||= /^\d{4}-\d{2}(?:-\d{2})?$/.test(value);
      stat.years &&= /^\d{4}$/.test(value) && Number(value) >= 1600 && Number(value) <= 2200;
      if (date !== null) { stat.dateMin = Math.min(stat.dateMin, date); stat.dateMax = Math.max(stat.dateMax, date); }
      if (numeric !== null) {
        column.min = column.min === null ? numeric : Math.min(column.min, numeric);
        column.max = column.max === null ? numeric : Math.max(column.max, numeric);
      }
      if (!Object.hasOwn(column.categoryColors, value)) {
        const categoryIndex = stat.categoryCount;
        if (categoryIndex < METADATA_TIP_TABLE_CATEGORY_LIMIT) { column.categoryColors[value] = CATEGORY_COLORS[categoryIndex % CATEGORY_COLORS.length]; stat.categoryCount++; }
        else column.hasOtherCategories = true;
      }
      return value;
    });
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      valuesByNode[nodes[nodeIndex]] = values;
      matchedTips.add(nodes[nodeIndex]);
    }
  }
  columns.forEach((column, index) => {
    const stat = stats[index];
    const dateHeader = /(?:^|[\s_-])(?:date|year|collectiondate|collectionyear|samplingdate|samplingyear)(?:$|[\s_-])/i.test(column.column);
    const inferredDate = stat.count > 0 && stat.date && (stat.isoDate || dateHeader
      || (stat.years && !/(?:id|score|count|size|code)/i.test(column.column)));
    column.kind = column.valueType === "date" ? "date" : column.valueType === "number" ? "number"
      : inferredDate ? "date" : stat.count > 0 && stat.binary ? "binary"
        : stat.count > 0 && stat.numeric ? "number" : stat.count > 0 && stat.text ? "text" : "categorical";
    column.valueType = column.kind === "date" ? "date" : column.kind === "number" ? "number" : undefined;
    if (column.kind !== "categorical" && column.kind !== "text") column.hasOtherCategories = false;
    if (column.kind === "date") {
      column.min = stat.dateMin === Infinity ? null : stat.dateMin;
      column.max = stat.dateMax === -Infinity ? null : stat.dateMax;
    }
  });
  return { columns, valuesByNode, matchedTipCount: matchedTips.size };
}
