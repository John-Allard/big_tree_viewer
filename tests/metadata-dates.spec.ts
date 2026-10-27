import { expect, test } from "@playwright/test";
import {
  buildMetadataColorOverlay, metadataColumnLooksContinuous, metadataColumnLooksDate,
  METADATA_CONTINUOUS_PALETTES, type MetadataColorOverlayOptions,
  type MetadataContinuousPalette,
} from "../src/lib/metadataColors";
import { formatMetadataDate, parseMetadataDate } from "../src/lib/metadataDates";
import { layoutMetadataLegend, type MetadataLegendSection } from "../src/lib/metadataLegend";
import {
  buildMetadataTipTableData, metadataTipTableContinuousColor, metadataTipTableNumericValue,
} from "../src/lib/metadataTipTable";
import type { TreeModel } from "../src/types/tree";

const day = 86_400_000;
const layout = { center: new Float64Array(6), min: new Float64Array(6), max: new Float64Array(6) };
const tree: TreeModel = {
  root: 0, nodeCount: 6, leafCount: 4, maxDepth: 2, rootAge: 2,
  hasBranchLengths: true, isUltrametric: false, branchLengthMinPositive: 1,
  names: ["Root", "Clade", "A_one", "B", "C", "D"], leafNodes: Int32Array.from([2, 3, 4, 5]),
  nodeIntervalLower: new Float64Array(6), nodeIntervalUpper: new Float64Array(6), nodeIntervalCount: 0,
  buffers: {
    parent: Int32Array.from([-1, 0, 1, 1, 0, 0]),
    firstChild: Int32Array.from([1, 2, -1, -1, -1, -1]),
    nextSibling: Int32Array.from([-1, 4, 3, -1, 5, -1]),
    branchLength: Float64Array.from([0, 1, 1, 1, 1, 1]),
    depth: Float64Array.from([0, 1, 2, 2, 1, 1]),
    leafCount: Int32Array.from([4, 2, 1, 1, 1, 1]),
  },
  layouts: { input: layout, asc: layout, desc: layout },
};
const options: MetadataColorOverlayOptions = {
  mode: "date", scope: "branch", reverseScale: false, continuousPalette: "blueOrange",
  continuousTransform: "linear", continuousMin: null, continuousMax: null,
};
const rows = [
  { name: " A one ", value: "2024" },
  { name: "B", value: "2024-02" },
  { name: "C", value: "2024-03-01" },
];
const overlay = (data = rows, overrides: Partial<MetadataColorOverlayOptions> = {}) =>
  buildMetadataColorOverlay(tree, data, "name", "value", { ...options, ...overrides });

test("strict ISO dates default missing fields and preserve early years in UTC", () => {
  expect(parseMetadataDate("1970")).toBe(0);
  expect(parseMetadataDate("1970-02")).toBe(31 * day);
  expect(parseMetadataDate(" 1970-01-02 ")).toBe(day);
  expect(parseMetadataDate("1969-12-31")).toBe(-day);
  for (const value of ["0000-02-29", "0001-01-01", "0099-12-31", "1900-03-01", "2000-02-29", "2024-02-29", "9999-12-31"]) {
    expect(formatMetadataDate(parseMetadataDate(value)!)).toBe(value);
  }
  expect(parseMetadataDate("2024-03-01")! - parseMetadataDate("2024-02-28")!).toBe(2 * day);
});

test("strict ISO dates reject rollover, ambiguous formats, timestamps and trailing text", () => {
  for (const value of [
    "", " ", "01/02/2024", "2024/02/01", "02-01-2024", "Feb 1 2024", "2024-2", "2024-02-1",
    "24", "+2024", "-2024", "10000", "2024.5", "2024-00", "2024-13", "2024-01-00",
    "2024-01-32", "2024-04-31", "2023-02-29", "1900-02-29", "2100-02-29", "2024-02-30",
    "2024-01-01T00:00:00Z", "2024-01-01Z", "2024-01-01 extra", "Infinity", "NaN",
  ]) expect(parseMetadataDate(value), value).toBeNull();
  for (const value of [NaN, Infinity, -Infinity, 1e20]) expect(formatMetadataDate(value)).toBe("");
});

test("explicit date inference rejects mixed columns without changing numeric inference", () => {
  expect(metadataColumnLooksDate([...rows, { name: "D", value: "" }], "value")).toBe(true);
  expect(metadataColumnLooksDate([{ value: "2024" }], "value")).toBe(true);
  expect(metadataColumnLooksDate([...rows, { name: "D", value: "2024-02-30" }], "value")).toBe(false);
  expect(metadataColumnLooksDate([{ value: "" }, {}], "value")).toBe(false);
  expect(metadataColumnLooksContinuous(rows, "value")).toBe(false);
  expect(metadataColumnLooksContinuous(["1", "2", "3"].map((value) => ({ value })), "value")).toBe(true);
  expect(metadataColumnLooksContinuous(["0", "1"].map((value) => ({ value })), "value")).toBe(false);
});

for (const palette of Object.keys(METADATA_CONTINUOUS_PALETTES) as MetadataContinuousPalette[]) {
  test(`date overlay uses ${palette} with elapsed-time spacing and reversal`, () => {
    const result = overlay(rows, { continuousPalette: palette });
    const numeric = overlay(rows.map((row) => ({ ...row, value: String(parseMetadataDate(row.value)) })), {
      mode: "continuous", continuousPalette: palette,
    });
    expect(result.colors).toEqual(numeric.colors);
    expect(result.values.slice(2, 5)).toEqual(["2024", "2024-02", "2024-03-01"]);
    expect(result).toMatchObject({ matchedRowCount: 3, matchedNodeCount: 3, coloredNodeCount: 3, invalidValueRowCount: 0 });
    const stops = METADATA_CONTINUOUS_PALETTES[palette].stops;
    expect(result.colors[2]).toBe(stops[0]);
    expect(result.colors[4]).toBe(stops.at(-1));
    const reversed = overlay(rows, { continuousPalette: palette, reverseScale: true });
    expect(reversed.colors[2]).toBe(stops.at(-1));
    expect(reversed.colors[4]).toBe(stops[0]);
    expect(reversed.continuousLegend?.colors).toEqual([...result.continuousLegend!.colors].reverse());
    expect(result.continuousLegend).toMatchObject({
      valueType: "date", palette, transform: "linear",
      min: parseMetadataDate("2024"), max: parseMetadataDate("2024-03-01"),
      minLabel: "2024-01-01", maxLabel: "2024-03-01",
      actualMinLabel: "2024-01-01", actualMaxLabel: "2024-03-01",
    });
    expect(result.version).toMatch(/^date:/);
    expect(result.version).not.toBe(numeric.version);
  });
}

test("date bounds normalize, clip and retain actual dates; epoch transforms stay linear", () => {
  const bounds = { continuousMin: parseMetadataDate("2024-02-15"), continuousMax: parseMetadataDate("2024-01-15") };
  const result = overlay(rows, bounds);
  expect(result.continuousLegend).toMatchObject({
    minLabel: "2024-01-15", maxLabel: "2024-02-15", actualMinLabel: "2024-01-01", actualMaxLabel: "2024-03-01",
  });
  expect(result.colors[2]).toBe("#2563eb");
  expect(result.colors[4]).toBe("#d97706");
  for (const continuousTransform of ["sqrt", "log"] as const) {
    const transformed = overlay(rows, { ...bounds, continuousTransform });
    expect(transformed.colors).toEqual(result.colors);
    expect(transformed.continuousLegend?.transform).toBe("linear");
  }
  expect(overlay(rows, { continuousMin: parseMetadataDate("2023") }).continuousLegend?.minLabel).toBe("2023-01-01");
  const single = overlay([{ name: "B", value: "1970" }]);
  expect(single.continuousLegend).toMatchObject({ min: 0, max: 0 });
  expect(single.colors[3]).toMatch(/^#[0-9a-f]{6}$/);
});

test("invalid dates and unmatched keys have separate counts and empty data has no legend", () => {
  const result = overlay([
    ...rows, { name: "D", value: "2023-02-29" }, { name: "missing", value: "2024-01-01" },
    { name: "B", value: "" }, { name: "", value: "2024" },
  ]);
  expect(result).toMatchObject({ matchedRowCount: 3, unmappedRowCount: 1, invalidValueRowCount: 1 });
  expect(result.colors[5]).toBeNull();
  expect(overlay([{ name: "B", value: "02/01/2024" }])).toMatchObject({
    hasAny: false, continuousLegend: null, invalidValueRowCount: 1,
  });
  expect(overlay([])).toMatchObject({ hasAny: false, continuousLegend: null });
});

test("date subtree coloring preserves ISO text for descendants and root branches stay uncolored", () => {
  const result = overlay([{ name: "clade", value: "2024-02" }], { scope: "subtree" });
  expect(result.values).toEqual([null, "2024-02", "2024-02", "2024-02", null, null]);
  expect(result.coloredNodeCount).toBe(3);
  expect(overlay([{ name: "Root", value: "2024" }]).colors[0]).toBeNull();
});

test("numeric overlays retain signed transforms, normalized values, bounds and categorical behavior", () => {
  const numericRows = ["-9", "0", "9e0"].map((value, index) => ({ name: rows[index].name, value }));
  for (const continuousTransform of ["linear", "sqrt", "log"] as const) {
    const result = overlay(numericRows, { mode: "continuous", continuousTransform });
    expect(result.values.slice(2, 5)).toEqual(["-9", "0", "9"]);
    expect(result.colors[2]).toBe("#2563eb");
    expect(result.colors[4]).toBe("#d97706");
    expect(result.continuousLegend).toMatchObject({
      valueType: "number", min: -9, max: 9, actualMin: -9, actualMax: 9, transform: continuousTransform,
    });
    expect(result.version).toMatch(/^continuous:/);
  }
  const categorical = overlay(rows, { mode: "categorical", categoricalColorOverrides: { "2024": "#123456" } });
  expect(categorical.colors[2]).toBe("#123456");
  expect(categorical.continuousLegend).toBeNull();
  expect(categorical.categoryLegend).toHaveLength(3);
});

test("tip date columns compute UTC bounds, preserve raw text and use every existing palette", () => {
  const data = buildMetadataTipTableData(tree, [
    ...rows.map((row, index) => ({ ...row, score: String(index - 1) })),
    { name: "D", value: "2024-02-30", score: "0x10" },
    { name: "Root", value: "1900", score: "-100" },
    { name: "missing", value: "9999", score: "9999" },
  ], "name", [{ column: "value", label: "Collection_date", valueType: "date" }, { column: "score", label: "" }]);
  expect(data.matchedTipCount).toBe(4);
  expect(data.columns[0]).toMatchObject({ label: "Collection date", valueType: "date", min: parseMetadataDate("2024"), max: parseMetadataDate("2024-03-01") });
  expect(data.columns[1]).toMatchObject({ label: "score", min: -1, max: 16 });
  expect(data.valuesByNode[2]).toEqual(["2024", "-1"]);
  expect(data.valuesByNode[5]).toEqual(["2024-02-30", "0x10"]);
  expect(data.valuesByNode[0]).toBeNull();
  const column = data.columns[0];
  const min = metadataTipTableNumericValue(data.valuesByNode[2]![0], column.valueType)!;
  const max = metadataTipTableNumericValue(data.valuesByNode[4]![0], column.valueType)!;
  for (const palette of Object.keys(METADATA_CONTINUOUS_PALETTES) as MetadataContinuousPalette[]) {
    const stops = METADATA_CONTINUOUS_PALETTES[palette].stops;
    expect(metadataTipTableContinuousColor(min, column.min!, column.max!, palette)).toBe(stops[0]);
    expect(metadataTipTableContinuousColor(max, column.min!, column.max!, palette)).toBe(stops.at(-1));
  }
  expect(metadataTipTableNumericValue("2024-02-30", "date")).toBeNull();
  expect(metadataTipTableNumericValue("0", "number")).toBe(0);
  expect(metadataTipTableNumericValue(" 1e2 ")).toBe(100);
  expect(metadataTipTableNumericValue(" ")).toBeNull();
  expect(metadataTipTableNumericValue("Infinity")).toBeNull();
  expect(metadataTipTableNumericValue("1970", "date")).toBe(0);
});

test("tip date columns with no valid dates keep null bounds; numeric columns do not infer dates", () => {
  const data = buildMetadataTipTableData(tree, [{ name: "B", value: "01/02/2024" }], "name", [
    { column: "value", label: "Date", valueType: "date" },
  ]);
  expect(data.columns[0]).toMatchObject({ min: null, max: null });
  const numeric = buildMetadataTipTableData(tree, rows, "name", [{ column: "value", label: "Numeric" }]);
  expect(numeric.columns[0]).toMatchObject({ min: 2024, max: 2024 });
  expect(buildMetadataTipTableData(tree, rows, "", []).matchedTipCount).toBe(0);
});

test("legend renders date bounds and optional labels while preserving numeric formatting", () => {
  const context = { font: "", measureText: (text: string) => ({ width: text.length * 6 }) } as CanvasRenderingContext2D;
  const text = (continuous: MetadataLegendSection["continuous"]) => layoutMetadataLegend(context,
    [{ title: "Collection date", entries: [], continuous }], { left: 0, width: 800, height: 600 }, "top-right")!
    .primitives.filter((primitive) => primitive.kind === "text").map((primitive) => primitive.text).join(" ");
  expect(text(overlay().continuousLegend!)).toContain("2024-01-01 to 2024-03-01");
  expect(text({ colors: ["#000000"], min: 0, max: day, transform: "linear", valueType: "date" })).toContain("1970-01-01 to 1970-01-02");
  expect(text({ colors: [], min: 0, max: 123456, transform: "log" })).toContain("0 to 123460 (log)");
  expect(text({ colors: [], min: 0, max: day, transform: "linear", minLabel: "Earlier", maxLabel: "Later" })).toContain("Earlier to Later");
});

test("browser date parsing and formatting are identical across local timezones", async ({ browser }) => {
  for (const timezoneId of ["America/Los_Angeles", "Pacific/Auckland"]) {
    const context = await browser.newContext({ timezoneId });
    try {
      const page = await context.newPage();
      await page.goto("/");
      const result = await page.evaluate(async () => {
        const moduleUrl = "/src/lib/metadataDates.ts";
        const { parseMetadataDate, formatMetadataDate } = await import(moduleUrl);
        return ["1970", "2024-03-10", "2024-11-03", "0099-01-01"].map((raw) => {
          const value = parseMetadataDate(raw);
          return { value, label: formatMetadataDate(value) };
        });
      });
      expect(result).toEqual(["1970", "2024-03-10", "2024-11-03", "0099-01-01"].map((raw) => ({
        value: parseMetadataDate(raw), label: formatMetadataDate(parseMetadataDate(raw)!),
      })));
    } finally {
      await context.close();
    }
  }
});
