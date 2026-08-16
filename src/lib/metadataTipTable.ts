import type { TreeModel } from "../types/tree";
import { METADATA_CONTINUOUS_PALETTES, type MetadataContinuousPalette } from "./metadataColors";

export type MetadataTipTableMode = "bars" | "heatmap" | "categorical";
export type MetadataTipTableCellStyle = "filled" | "circle" | "square" | "check" | "text";

export interface MetadataTipTableColumn {
  column: string;
  label: string;
}

export interface MetadataTipTableColumnData extends MetadataTipTableColumn {
  min: number | null;
  max: number | null;
  categoryColors: Record<string, string>;
}

export interface MetadataTipTableData {
  columns: MetadataTipTableColumnData[];
  valuesByNode: Array<string[] | null>;
  matchedTipCount: number;
}

const CATEGORY_COLORS = [
  "#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed", "#0891b2",
  "#be123c", "#4338ca", "#65a30d", "#c2410c", "#0f766e", "#b45309",
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
    && normalized !== "0"
    && normalized !== "false"
    && normalized !== "no"
    && normalized !== "off"
    && normalized !== "none"
    && normalized !== "na"
    && normalized !== "n/a";
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
  const columns = selectedColumns.map((selection) => ({
    ...selection,
    label: metadataTipTableDisplayLabel(selection.label || selection.column),
    min: null as number | null,
    max: null as number | null,
    categoryColors: {} as Record<string, string>,
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
  const categoryIndexes = columns.map(() => new Map<string, number>());
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const key = normalizeKey(rows[rowIndex][keyColumn] ?? "");
    const nodes = tipsByName.get(key);
    if (!nodes) {
      continue;
    }
    const values = columns.map((column, columnIndex) => {
      const value = (rows[rowIndex][column.column] ?? "").trim();
      const numeric = Number(value);
      if (value && Number.isFinite(numeric)) {
        column.min = column.min === null ? numeric : Math.min(column.min, numeric);
        column.max = column.max === null ? numeric : Math.max(column.max, numeric);
      }
      if (value && categoryIndexes[columnIndex].get(value) === undefined) {
        const categoryIndex = categoryIndexes[columnIndex].size;
        categoryIndexes[columnIndex].set(value, categoryIndex);
        column.categoryColors[value] = CATEGORY_COLORS[categoryIndex % CATEGORY_COLORS.length];
      }
      return value;
    });
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      valuesByNode[nodes[nodeIndex]] = values;
      matchedTips.add(nodes[nodeIndex]);
    }
  }
  return { columns, valuesByNode, matchedTipCount: matchedTips.size };
}
