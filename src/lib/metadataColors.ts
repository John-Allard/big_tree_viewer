import type { TreeModel } from "../types/tree";

export type MetadataColorMode = "categorical" | "continuous";
export type MetadataApplyScope = "branch" | "subtree";
export type MetadataContinuousPalette = "blueOrange" | "viridis" | "redBlue" | "tealRose";
export type MetadataContinuousTransform = "linear" | "sqrt" | "log";
export type MetadataMarkerShape = "circle" | "square" | "diamond" | "triangle";

export interface ParsedMetadataTable {
  columns: string[];
  rows: Array<Record<string, string>>;
  delimiter: "," | "\t" | ";";
  firstRowIsHeader: boolean;
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
  gradientCss: string;
  actualMin: number;
  actualMax: number;
  palette: MetadataContinuousPalette;
  transform: MetadataContinuousTransform;
}

export interface MetadataMarkerStyle {
  color: string;
  shape: MetadataMarkerShape;
  label: string;
}

export interface MetadataMarkerLegendItem {
  label: string;
  color: string;
  shape: MetadataMarkerShape;
  count: number;
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

export interface MetadataLabelOverlayResult {
  labels: Array<string | null>;
  hasAny: boolean;
  labeledNodeCount: number;
  matchedRowCount: number;
  unmappedRowCount: number;
  version: string;
}

export interface MetadataMarkerOverlayResult {
  markers: Array<MetadataMarkerStyle | null>;
  hasAny: boolean;
  matchedRowCount: number;
  markedNodeCount: number;
  unmappedRowCount: number;
  legend: MetadataMarkerLegendItem[];
  version: string;
}

export interface MetadataMarkerOverlayOptions {
  categoryStyleOverrides?: Record<string, Partial<Pick<MetadataMarkerStyle, "color" | "shape">>>;
}

export interface MetadataColorOverlayOptions {
  mode: MetadataColorMode;
  scope: MetadataApplyScope;
  reverseScale: boolean;
  continuousPalette: MetadataContinuousPalette;
  continuousTransform: MetadataContinuousTransform;
  continuousMin: number | null;
  continuousMax: number | null;
  categoricalColorOverrides?: Record<string, string>;
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

const MARKER_SHAPES: MetadataMarkerShape[] = ["circle", "square", "diamond", "triangle"];

export const METADATA_CONTINUOUS_PALETTES: Record<MetadataContinuousPalette, { label: string; stops: string[] }> = {
  blueOrange: {
    label: "Blue to orange",
    stops: ["#2563eb", "#d97706"],
  },
  viridis: {
    label: "Viridis",
    stops: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  },
  redBlue: {
    label: "Red to blue",
    stops: ["#b91c1c", "#f8fafc", "#1d4ed8"],
  },
  tealRose: {
    label: "Teal to rose",
    stops: ["#0f766e", "#f8fafc", "#e11d48"],
  },
};

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

function interpolatePalette(stops: string[], t: number): string {
  if (stops.length <= 1) {
    return stops[0] ?? "#2563eb";
  }
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const leftIndex = Math.floor(scaled);
  const rightIndex = Math.min(stops.length - 1, leftIndex + 1);
  const localT = scaled - leftIndex;
  return interpolateColor(stops[leftIndex], stops[rightIndex], localT);
}

function buildGradientCss(stops: string[]): string {
  if (stops.length <= 1) {
    return stops[0] ?? "#2563eb";
  }
  return `linear-gradient(90deg, ${stops.map((stop, index) => {
    const percent = stops.length === 1 ? 0 : (index / (stops.length - 1)) * 100;
    return `${stop} ${percent.toFixed(2)}%`;
  }).join(", ")})`;
}

function categoricalColor(index: number): string {
  if (index < CATEGORICAL_PALETTE.length) {
    return CATEGORICAL_PALETTE[index];
  }
  const hue = (index * 47) % 360;
  return `hsl(${hue} 72% 46%)`;
}

function categoricalMarkerShape(index: number): MetadataMarkerShape {
  return MARKER_SHAPES[index % MARKER_SHAPES.length];
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

function signedSqrt(value: number): number {
  return Math.sign(value) * Math.sqrt(Math.abs(value));
}

function signedLog1p(value: number): number {
  return Math.sign(value) * Math.log10(1 + Math.abs(value));
}

function transformContinuousValue(value: number, transform: MetadataContinuousTransform): number {
  if (transform === "sqrt") {
    return signedSqrt(value);
  }
  if (transform === "log") {
    return signedLog1p(value);
  }
  return value;
}

function normalizeContinuousBounds(min: number | null, max: number | null): { min: number | null; max: number | null } {
  if (min === null || max === null) {
    return { min, max };
  }
  return min <= max ? { min, max } : { min: max, max: min };
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

export function parseMetadataTable(text: string, firstRowIsHeader = true): ParsedMetadataTable {
  const delimiter = detectDelimiter(text);
  const rawRows = parseDelimitedRows(text, delimiter);
  if (rawRows.length < (firstRowIsHeader ? 2 : 1)) {
    throw new Error(firstRowIsHeader
      ? "Metadata file must contain a header row and at least one data row."
      : "Metadata file must contain at least one data row.");
  }
  const widestRowLength = rawRows.reduce((max, row) => Math.max(max, row.length), 0);
  const columns = firstRowIsHeader
    ? rawRows[0].map((value, index) => value.trim() || `column_${index + 1}`)
    : Array.from({ length: widestRowLength }, (_, index) => `column_${index + 1}`);
  const rows = (firstRowIsHeader ? rawRows.slice(1) : rawRows)
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
    firstRowIsHeader,
  };
}

export function metadataColumnLooksContinuous(rows: Array<Record<string, string>>, column: string): boolean {
  let numericCount = 0;
  let integerOnly = true;
  const uniqueValues = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const raw = rows[index][column] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      return false;
    }
    integerOnly = integerOnly && Number.isInteger(numeric);
    numericCount += 1;
    uniqueValues.add(trimmed);
  }
  const binaryLikeIntegerSet = Array.from(uniqueValues).every((value) => value === "-1" || value === "0" || value === "1");
  if (numericCount > 0 && integerOnly && (uniqueValues.size <= 2 || binaryLikeIntegerSet)) {
    return false;
  }
  return numericCount > 0;
}

export function buildMetadataColorOverlay(
  tree: TreeModel,
  rows: Array<Record<string, string>>,
  keyColumn: string,
  valueColumn: string,
  options: MetadataColorOverlayOptions,
): MetadataColorOverlayResult {
  const {
    mode,
    scope,
    reverseScale,
    continuousPalette,
    continuousTransform,
    continuousMin,
    continuousMax,
    categoricalColorOverrides = {},
  } = options;
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
      const color = categoryColors.get(value) ?? categoricalColorOverrides[value] ?? categoricalColor(categoryColors.size);
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
  let actualMin = Number.POSITIVE_INFINITY;
  let actualMax = Number.NEGATIVE_INFINITY;
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
    actualMin = Math.min(actualMin, value);
    actualMax = Math.max(actualMax, value);
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      matchedNodes.add(nodes[nodeIndex]);
    }
  }
  const paletteStops = [...METADATA_CONTINUOUS_PALETTES[continuousPalette].stops];
  if (reverseScale) {
    paletteStops.reverse();
  }
  const bounded = normalizeContinuousBounds(continuousMin, continuousMax);
  const legendMin = bounded.min ?? actualMin;
  const legendMax = bounded.max ?? actualMax;
  const transformedMin = transformContinuousValue(legendMin, continuousTransform);
  const transformedMax = transformContinuousValue(legendMax, continuousTransform);
  const span = Math.max(1e-9, transformedMax - transformedMin);
  for (let entryIndex = 0; entryIndex < numericEntries.length; entryIndex += 1) {
    const entry = numericEntries[entryIndex];
    const clampedValue = Math.max(legendMin, Math.min(legendMax, entry.value));
    const transformedValue = transformContinuousValue(clampedValue, continuousTransform);
    const t = legendMax > legendMin ? (transformedValue - transformedMin) / span : 0.5;
    const color = interpolatePalette(paletteStops, t);
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
        min: legendMin,
        max: legendMax,
        startColor: paletteStops[0],
        endColor: paletteStops[paletteStops.length - 1],
        gradientCss: buildGradientCss(paletteStops),
        actualMin,
        actualMax,
        palette: continuousPalette,
        transform: continuousTransform,
      }
      : null,
    version: `continuous:${keyColumn}:${valueColumn}:${scope}:${reverseScale ? "reverse" : "forward"}:${continuousPalette}:${continuousTransform}:${bounded.min ?? "auto"}:${bounded.max ?? "auto"}:${rows.length}:${actualMin}:${actualMax}`,
  };
}

export function buildMetadataLabelOverlay(
  tree: TreeModel,
  rows: Array<Record<string, string>>,
  keyColumn: string,
  labelColumn: string,
  scope: MetadataApplyScope,
): MetadataLabelOverlayResult {
  const labels = new Array<string | null>(tree.nodeCount).fill(null);
  const byName = buildNodeLookup(tree);
  let labeledNodeCount = 0;
  let matchedRowCount = 0;
  let unmappedRowCount = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const key = normalizeKey(rows[rowIndex][keyColumn] ?? "");
    const label = (rows[rowIndex][labelColumn] ?? "").trim();
    if (!key || !label) {
      continue;
    }
    const nodes = byName.get(key);
    if (!nodes || nodes.length === 0) {
      unmappedRowCount += 1;
      continue;
    }
    matchedRowCount += 1;
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const node = nodes[nodeIndex];
      const targetNode = scope === "subtree" ? node : node;
      if (labels[targetNode] === null) {
        labeledNodeCount += 1;
      }
      labels[targetNode] = label;
    }
  }

  return {
    labels,
    hasAny: labeledNodeCount > 0,
    labeledNodeCount,
    matchedRowCount,
    unmappedRowCount,
    version: `labels:${keyColumn}:${labelColumn}:${scope}:${rows.length}:${labeledNodeCount}`,
  };
}

export function buildMetadataMarkerOverlay(
  tree: TreeModel,
  rows: Array<Record<string, string>>,
  keyColumn: string,
  markerColumn: string,
  options: MetadataMarkerOverlayOptions = {},
): MetadataMarkerOverlayResult {
  const { categoryStyleOverrides = {} } = options;
  const markers = new Array<MetadataMarkerStyle | null>(tree.nodeCount).fill(null);
  const byName = buildNodeLookup(tree);
  const categoryStyles = new Map<string, MetadataMarkerStyle>();
  const categoryCounts = new Map<string, number>();
  const markedNodes = new Set<number>();
  let matchedRowCount = 0;
  let unmappedRowCount = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const key = normalizeKey(rows[rowIndex][keyColumn] ?? "");
    const value = (rows[rowIndex][markerColumn] ?? "").trim();
    if (!key || !value) {
      continue;
    }
    const nodes = byName.get(key);
    if (!nodes || nodes.length === 0) {
      unmappedRowCount += 1;
      continue;
    }
    matchedRowCount += 1;
    let style = categoryStyles.get(value);
    if (!style) {
      const categoryIndex = categoryStyles.size;
      const override = categoryStyleOverrides[value] ?? {};
      style = {
        color: override.color ?? categoricalColor(categoryIndex),
        shape: override.shape ?? categoricalMarkerShape(categoryIndex),
        label: value,
      };
      categoryStyles.set(value, style);
    }
    categoryCounts.set(value, (categoryCounts.get(value) ?? 0) + nodes.length);
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const node = nodes[nodeIndex];
      markers[node] = style;
      markedNodes.add(node);
    }
  }

  const legend = Array.from(categoryStyles.values()).map((style) => ({
    label: style.label,
    color: style.color,
    shape: style.shape,
    count: categoryCounts.get(style.label) ?? 0,
  }));

  return {
    markers,
    hasAny: markedNodes.size > 0,
    matchedRowCount,
    markedNodeCount: markedNodes.size,
    unmappedRowCount,
    legend,
    version: `markers:${keyColumn}:${markerColumn}:${rows.length}:${legend.map((item) => `${item.label}:${item.color}:${item.shape}`).join("|")}`,
  };
}
