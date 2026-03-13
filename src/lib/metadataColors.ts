import type { TreeModel } from "../types/tree";

export type MetadataColorMode = "categorical" | "continuous";
export type MetadataApplyScope = "branch" | "subtree";

export interface ParsedMetadataTable {
  columns: string[];
  rows: Array<Record<string, string>>;
  delimiter: "," | "\t" | ";";
}

export interface MetadataLegendCategoryItem {
  label: string;
  color: string;
  count: number;
}

export interface MetadataContinuousLegend {
  min: number;
  max: number;
  startColor: string;
  endColor: string;
}

export interface MetadataColorOverlayResult {
  colors: Array<string | null>;
  hasAny: boolean;
  matchedRowCount: number;
  matchedNodeCount: number;
  coloredNodeCount: number;
  unmappedRowCount: number;
  invalidValueRowCount: number;
  categoryLegend: MetadataLegendCategoryItem[];
  continuousLegend: MetadataContinuousLegend | null;
  version: string;
}

const CATEGORICAL_PALETTE = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#be123c",
  "#4338ca",
  "#65a30d",
  "#c2410c",
  "#0f766e",
  "#b45309",
];

function normalizeKey(value: string): string {
  return value.trim().replace(/^['"]+|['"]+$/g, "").replaceAll("_", " ").replace(/\s+/g, " ").toLowerCase();
}

function detectDelimiter(text: string): "," | "\t" | ";" {
  const sample = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const delimiters: Array<"," | "\t" | ";"> = [",", "\t", ";"];
  let best: "," | "\t" | ";" = ",";
  let bestCount = -1;
  for (let index = 0; index < delimiters.length; index += 1) {
    const delimiter = delimiters[index];
    let count = 0;
    let quote: "\"" | null = null;
    for (let charIndex = 0; charIndex < sample.length; charIndex += 1) {
      const character = sample[charIndex];
      if (character === "\"") {
        if (quote === "\"") {
          quote = null;
        } else if (quote === null) {
          quote = "\"";
        }
        continue;
      }
      if (quote === null && character === delimiter) {
        count += 1;
      }
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function parseDelimitedRows(text: string, delimiter: "," | "\t" | ";"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\"") {
      if (inQuotes && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && character === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (!inQuotes && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }
    cell += character;
  }
  row.push(cell);
  if (row.some((value) => value.trim().length > 0)) {
    rows.push(row);
  }
  return rows;
}

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const normalized = color.replace("#", "");
  const value = normalized.length === 3
    ? normalized.split("").map((part) => `${part}${part}`).join("")
    : normalized;
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

function interpolateColor(start: string, end: string, t: number): string {
  const startRgb = hexToRgb(start);
  const endRgb = hexToRgb(end);
  return rgbToHex(
    startRgb.r + ((endRgb.r - startRgb.r) * t),
    startRgb.g + ((endRgb.g - startRgb.g) * t),
    startRgb.b + ((endRgb.b - startRgb.b) * t),
  );
}

function categoricalColor(index: number): string {
  if (index < CATEGORICAL_PALETTE.length) {
    return CATEGORICAL_PALETTE[index];
  }
  const hue = (index * 47) % 360;
  return `hsl(${hue} 72% 46%)`;
}

function buildNodeLookup(tree: TreeModel): Map<string, number[]> {
  const byName = new Map<string, number[]>();
  for (let node = 0; node < tree.nodeCount; node += 1) {
    const raw = tree.names[node] ?? "";
    const normalized = normalizeKey(raw);
    if (!normalized) {
      continue;
    }
    const existing = byName.get(normalized) ?? [];
    existing.push(node);
    byName.set(normalized, existing);
  }
  return byName;
}

function applySubtreeColor(tree: TreeModel, colors: Array<string | null>, node: number, color: string): number {
  let colored = 0;
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "number") {
      continue;
    }
    if (colors[current] !== color) {
      colored += 1;
    }
    colors[current] = color;
    for (let child = tree.buffers.firstChild[current]; child >= 0; child = tree.buffers.nextSibling[child]) {
      stack.push(child);
    }
  }
  return colored;
}

export function parseMetadataTable(text: string): ParsedMetadataTable {
  const delimiter = detectDelimiter(text);
  const rawRows = parseDelimitedRows(text, delimiter);
  if (rawRows.length < 2) {
    throw new Error("Metadata file must contain a header row and at least one data row.");
  }
  const columns = rawRows[0].map((value, index) => value.trim() || `column_${index + 1}`);
  const rows = rawRows.slice(1)
    .filter((row) => row.some((value) => value.trim().length > 0))
    .map((row) => {
      const record: Record<string, string> = {};
      for (let index = 0; index < columns.length; index += 1) {
        record[columns[index]] = row[index]?.trim() ?? "";
      }
      return record;
    });
  if (rows.length === 0) {
    throw new Error("Metadata file does not contain any non-empty data rows.");
  }
  return {
    columns,
    rows,
    delimiter,
  };
}

export function metadataColumnLooksContinuous(rows: Array<Record<string, string>>, column: string): boolean {
  let numericCount = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index][column] ?? "";
    if (!raw.trim()) {
      continue;
    }
    if (!Number.isFinite(Number(raw))) {
      return false;
    }
    numericCount += 1;
  }
  return numericCount > 0;
}

export function buildMetadataColorOverlay(
  tree: TreeModel,
  rows: Array<Record<string, string>>,
  keyColumn: string,
  valueColumn: string,
  mode: MetadataColorMode,
  scope: MetadataApplyScope,
  reverseScale: boolean,
): MetadataColorOverlayResult {
  const colors = new Array<string | null>(tree.nodeCount).fill(null);
  const byName = buildNodeLookup(tree);
  const matchedNodes = new Set<number>();
  let matchedRowCount = 0;
  let coloredNodeCount = 0;
  let unmappedRowCount = 0;
  let invalidValueRowCount = 0;

  if (mode === "categorical") {
    const categoryColors = new Map<string, string>();
    const categoryCounts = new Map<string, number>();
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const key = normalizeKey(rows[rowIndex][keyColumn] ?? "");
      const value = (rows[rowIndex][valueColumn] ?? "").trim();
      if (!key || !value) {
        continue;
      }
      const nodes = byName.get(key);
      if (!nodes || nodes.length === 0) {
        unmappedRowCount += 1;
        continue;
      }
      matchedRowCount += 1;
      const color = categoryColors.get(value) ?? categoricalColor(categoryColors.size);
      categoryColors.set(value, color);
      categoryCounts.set(value, (categoryCounts.get(value) ?? 0) + nodes.length);
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        const node = nodes[nodeIndex];
        matchedNodes.add(node);
        if (scope === "subtree") {
          coloredNodeCount += applySubtreeColor(tree, colors, node, color);
        } else if (tree.buffers.parent[node] >= 0) {
          if (colors[node] !== color) {
            coloredNodeCount += 1;
          }
          colors[node] = color;
        }
      }
    }
    const categoryLegend = Array.from(categoryColors.entries()).map(([label, color]) => ({
      label,
      color,
      count: categoryCounts.get(label) ?? 0,
    }));
    return {
      colors,
      hasAny: colors.some((color) => color !== null),
      matchedRowCount,
      matchedNodeCount: matchedNodes.size,
      coloredNodeCount,
      unmappedRowCount,
      invalidValueRowCount,
      categoryLegend,
      continuousLegend: null,
      version: `categorical:${keyColumn}:${valueColumn}:${scope}:${rows.length}:${categoryLegend.map((item) => `${item.label}:${item.color}`).join("|")}`,
    };
  }

  const numericEntries: Array<{ nodes: number[]; value: number }> = [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const key = normalizeKey(rows[rowIndex][keyColumn] ?? "");
    const raw = (rows[rowIndex][valueColumn] ?? "").trim();
    if (!key || !raw) {
      continue;
    }
    const nodes = byName.get(key);
    if (!nodes || nodes.length === 0) {
      unmappedRowCount += 1;
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      invalidValueRowCount += 1;
      continue;
    }
    matchedRowCount += 1;
    numericEntries.push({ nodes, value });
    min = Math.min(min, value);
    max = Math.max(max, value);
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      matchedNodes.add(nodes[nodeIndex]);
    }
  }
  const startColor = reverseScale ? "#d97706" : "#2563eb";
  const endColor = reverseScale ? "#2563eb" : "#d97706";
  const span = Math.max(1e-9, max - min);
  for (let entryIndex = 0; entryIndex < numericEntries.length; entryIndex += 1) {
    const entry = numericEntries[entryIndex];
    const t = max > min ? (entry.value - min) / span : 0.5;
    const color = interpolateColor(startColor, endColor, t);
    for (let nodeIndex = 0; nodeIndex < entry.nodes.length; nodeIndex += 1) {
      const node = entry.nodes[nodeIndex];
      if (scope === "subtree") {
        coloredNodeCount += applySubtreeColor(tree, colors, node, color);
      } else if (tree.buffers.parent[node] >= 0) {
        if (colors[node] !== color) {
          coloredNodeCount += 1;
        }
        colors[node] = color;
      }
    }
  }
  return {
    colors,
    hasAny: colors.some((color) => color !== null),
    matchedRowCount,
    matchedNodeCount: matchedNodes.size,
    coloredNodeCount,
    unmappedRowCount,
    invalidValueRowCount,
    categoryLegend: [],
    continuousLegend: numericEntries.length > 0
      ? {
        min,
        max,
        startColor,
        endColor,
      }
      : null,
    version: `continuous:${keyColumn}:${valueColumn}:${scope}:${reverseScale ? "reverse" : "forward"}:${rows.length}:${min}:${max}`,
  };
}
