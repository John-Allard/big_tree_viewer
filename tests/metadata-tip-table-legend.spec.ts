import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync, strFromU8 } from "fflate";
import { buildMetadataTipTableLegend, normalizeMetadataLegendComponents } from "../src/lib/metadataLegend";
import { buildMetadataTipTableData, metadataTipTableContinuousColor, metadataTipTableCellAppearance, metadataTipTableColumnMode, METADATA_TIP_TABLE_CATEGORY_LIMIT } from "../src/lib/metadataTipTable";
import type { TreeModel } from "../src/types/tree";

const tree = { nodeCount: 3, names: ["Root", "A", "B"], leafNodes: Int32Array.from([1, 2]) } as TreeModel;
const data = buildMetadataTipTableData(tree, [
  { id: "A", score: "10", resistant: "0", date: "2023-01-01" },
  { id: "B", score: "90", resistant: "1", date: "2024-01-01" },
  { id: "unmatched", score: "999", resistant: "999", date: "2099" },
], "id", [{ column: "score", label: "Score" }, { column: "resistant", label: "Resistant" }, { column: "date", label: "Date", valueType: "date" }]);

test("heat-map legends use each matched column's range and exact cell palette", () => {
  for (const palette of ["viridis", "blueOrange", "redBlue", "tealRose"] as const) {
    const sections = buildMetadataTipTableLegend(data, "heatmap", palette, "filled");
    expect(sections.map(section => section.title)).toEqual(["Heat map: Score", "Tip table: Resistant", "Heat map: Date"]);
    expect(sections[0].continuous).toMatchObject({ min: 10, max: 90, transform: "linear" });
    expect(sections[1].continuous).toBeUndefined();
    expect(sections[1].entries).toEqual([{ label: "0 (no mark)", color: "#2563eb", glyph: "", noSwatch: true }, { label: "1", color: "#2563eb" }]);
    expect(sections[2].continuous?.valueType).toBe("date");
    const colors = sections[0].continuous!.colors;
    expect(colors[0]).toBe(metadataTipTableContinuousColor(10, 10, 90, palette));
    expect(colors.at(-1)).toBe(metadataTipTableContinuousColor(90, 10, 90, palette));
  }
});

test("constant columns use their cell midpoint color and empty columns have no key", () => {
  const constant = { ...data, columns: [{ ...data.columns[0], min: 5, max: 5 }, { ...data.columns[0], min: null, max: null }] };
  const sections = buildMetadataTipTableLegend(constant, "heatmap", "viridis", "filled");
  expect(sections).toHaveLength(1);
  expect(new Set(sections[0].continuous!.colors)).toEqual(new Set([metadataTipTableContinuousColor(5, 5, 5, "viridis")]));
  expect(buildMetadataTipTableLegend(null, "heatmap", "viridis", "filled")).toEqual([]);
});

test("categorical and bar legends follow the rendered encodings", () => {
  const sections = buildMetadataTipTableLegend(data, "categorical", "viridis", "circle");
  expect(sections[1].entries).toEqual([{ label: "0 (no mark)", color: "#2563eb", glyph: "", noSwatch: true }, { label: "1", color: "#2563eb", shape: "circle" }]);
  const checks = buildMetadataTipTableLegend(data, "categorical", "viridis", "check");
  expect(checks[1].entries.map(entry => entry.label)).toEqual(["0 (no mark)", "1"]);
  expect(checks[1].entries.map(entry => entry.glyph)).toEqual(["", "\u2713"]);
  expect(checks[1].entries.every(entry => entry.noSwatch)).toBe(true);
  expect(buildMetadataTipTableLegend(data, "categorical", "viridis", "text")[1].entries.every(entry => entry.noSwatch)).toBe(true);
  const bars = buildMetadataTipTableLegend(data, "bars", "viridis", "filled");
  expect(bars).toHaveLength(3);
  expect(bars[0].continuous).toMatchObject({ min: 0, max: 90 });
  expect(normalizeMetadataLegendComponents({ branchColors: false }).tipTables).toBe(true);
  expect(normalizeMetadataLegendComponents({ tipTables: false }).tipTables).toBe(false);
});

test("mixed columns infer numbers, binary states, categories, ISO dates and calendar years", () => {
  const rows = [
    { id: "A", score: "2000", year: "2022", when: "2022-03-01", resistant: "yes", country: "France", missing: "NA" },
    { id: "B", score: "2100", year: "2024", when: "2024-06", resistant: "no", country: "Canada", missing: "" },
    { id: "not-in-tree", score: "text", year: "garbage", when: "invalid", resistant: "perhaps", country: "USA", missing: "5" },
  ];
  const mixed = buildMetadataTipTableData(tree, rows, "id", ["score", "year", "when", "resistant", "country", "missing"].map(column => ({ column, label: column })));
  expect(mixed.columns.map(column => column.kind)).toEqual(["number", "date", "date", "binary", "categorical", "categorical"]);
  expect(mixed.columns.map(column => metadataTipTableColumnMode(column, "bars"))).toEqual(["bars", "bars", "bars", "categorical", "categorical", "categorical"]);
  expect(mixed.columns.map(column => metadataTipTableColumnMode(column, "heatmap"))).toEqual(["heatmap", "heatmap", "heatmap", "categorical", "categorical", "categorical"]);
  expect(mixed.valuesByNode[1]?.at(-1)).toBe("");
  expect(metadataTipTableCellAppearance(mixed.columns[3], "no", "filled").empty).toBe(true);
  expect(metadataTipTableCellAppearance(mixed.columns[3], "no", "check-cross")).toMatchObject({ empty: false, style: "text", text: "\u00d7" });
  expect(metadataTipTableCellAppearance(mixed.columns[4], "France", "check-cross")).toMatchObject({ empty: false, style: "filled" });
  const forced = buildMetadataTipTableData(tree, rows, "id", [{ column: "year", label: "Year", valueType: "number" }]);
  expect(forced.columns[0].kind).toBe("number");
  const letters = buildMetadataTipTableData(tree, [{ id: "A", site: "T", detected: "Y" }, { id: "B", site: "F", detected: "N" }], "id", [{ column: "site" }, { column: "detected" }]);
  expect(letters.columns.map(column => column.kind)).toEqual(["text", "binary"]);
});

test("large category sets have bounded keys and one shared Other color", () => {
  const names = Array.from({ length: 5000 }, (_, index) => `T${index}`);
  const manyTips = { nodeCount: names.length, names, leafNodes: Int32Array.from(names, (_, index) => index) } as TreeModel;
  const many = buildMetadataTipTableData(manyTips, names.map(id => ({ id, category: `state-${id}` })), "id", [{ column: "category", label: "Category" }]);
  const column = many.columns[0];
  expect(Object.keys(column.categoryColors)).toHaveLength(METADATA_TIP_TABLE_CATEGORY_LIMIT);
  expect(column.hasOtherCategories).toBe(true);
  const legend = buildMetadataTipTableLegend(many, "heatmap", "viridis", "filled")[0];
  expect(legend.entries).toHaveLength(METADATA_TIP_TABLE_CATEGORY_LIMIT + 1);
  expect(legend.entries.at(-1)?.label).toBe("Other");
  expect(metadataTipTableCellAppearance(column, "state-T4999", "filled").color).toBe(legend.entries.at(-1)?.color);
  expect(many.valuesByNode[4999]).toEqual(["state-T4999"]);
});

test("fifty site columns use automatic text display and a compact bulk chooser", async ({ page }) => {
  const columns = Array.from({ length: 50 }, (_, index) => `site_${index + 1}`);
  const text = ["id," + columns.join(","), ...["A", "B", "C", "D"].map((id, row) =>
    id + "," + columns.map((_, col) => ["A", "N", "Y", "T"][(row + col) % 4]).join(","))].join("\n");
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(text => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick: "((A:1,B:1):1,(C:1,D:1):1)Root;", metadata: { text, keyColumn: "id" },
    visual: { viewMode: "rectangular", showTipLabels: true, metadataLegendEnabled: true, metadataTipTableEnabled: true },
  } }, "*"), text);
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataTipTableColumns?.length)).toBe(50);
  await expect.poll(() => page.evaluate(() => (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { columns?: Array<{ kind: string }> })?.columns?.every(item => item.kind === "text"))).toBe(true);
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest())).not.toContain("Tip table: site");
  const metadata = page.locator(".panel-section .section-toggle").filter({ hasText: "Metadata" }).first();
  if (await metadata.getAttribute("aria-expanded") !== "true") await metadata.click();
  await page.getByRole("button", { name: "Tip data table settings", exact: true }).click();
  const chooser = page.getByTestId("metadata-tip-table-columns");
  await expect(chooser).not.toHaveAttribute("open", "");
  await expect(chooser.locator("summary")).toHaveText("Columns (50 selected)");
  await expect(page.getByRole("textbox", { name: /Display label for/ })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Binary display", exact: true }).selectOption("check-cross");
  await page.getByRole("combobox", { name: "Categorical display", exact: true }).selectOption("circle");
  await expect(page.getByRole("combobox", { name: "Short-text display", exact: true })).toHaveValue("text");
  await chooser.locator("summary").click();
  await chooser.getByRole("searchbox", { name: "Find table columns" }).fill("site_49");
  await expect(chooser.getByRole("checkbox")).toHaveCount(1);
  await chooser.getByRole("checkbox").uncheck();
  await expect(chooser.locator("summary")).toHaveText("Columns (49 selected)");
  await chooser.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(chooser.locator("summary")).toHaveText("Columns (50 selected)");
});

test("tip-table scales appear in the canvas and export, follow palette edits, and can be hidden", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(() => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick: "((A:1,B:1):1,(C:1,D:1):1)Root;",
    metadata: { text: "id,country,score,resistant,collection_year\nA,France,10,0,2020\nB,France,30,1,2021\nC,Canada,60,0,2022\nD,Canada,90,1,2024", keyColumn: "id", enabled: true, valueColumn: "country" },
    visual: { viewMode: "rectangular", showTipLabels: true, metadataLegendEnabled: true,
      metadataTipTableEnabled: true, metadataTipTableMode: "heatmap", metadataTipTablePalette: "viridis",
      metadataTipTableCellWidthPx: 80,
      metadataTipTableColumns: [{ column: "score", label: "Score" }, { column: "resistant", label: "Resistant" }, { column: "country", label: "Country" }, { column: "collection_year", label: "Year" }] },
  } }, "*"));
  const svg = () => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "");
  await expect.poll(svg).toContain("Heat map: Score");
  expect(await svg()).toContain("10 to 90");
  expect(await svg()).toContain("Tip table: Resistant");
  expect(await svg()).not.toContain("0 to 1");
  expect(await svg()).toContain("Heat map: Year");
  expect(await svg()).toContain("2020-01-01 to 2024-01-01");
  const metadata = page.locator(".panel-section .section-toggle").filter({ hasText: "Metadata" }).first();
  if (await metadata.getAttribute("aria-expanded") !== "true") await metadata.click();
  await page.getByRole("button", { name: "Metadata legend settings", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Metadata legend settings" });
  await expect(details.getByLabel("Tip tables", { exact: true })).toBeChecked();
  await expect(details.getByRole("combobox")).toHaveCount(1);
  await expect(details.getByRole("combobox", { name: "Legend position", exact: true })).toBeVisible();
  await details.getByLabel("Tip tables", { exact: true }).uncheck();
  await expect.poll(svg).not.toContain("Heat map: Score");
  expect(await svg()).toContain("Branch colors: country");
  await details.getByLabel("Tip tables", { exact: true }).check();
  await page.getByRole("button", { name: "Close Metadata legend settings", exact: true }).click();
  await page.getByRole("button", { name: "Tip data table settings", exact: true }).click();
  const tableSettings = page.getByRole("dialog", { name: "Tip data table settings" });
  await tableSettings.getByRole("slider", { name: "Column name size" }).fill("18");
  await expect.poll(() => page.evaluate(() => (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { headerFontSize: number })?.headerFontSize)).toBe(18);
  await tableSettings.getByRole("combobox", { name: "Palette", exact: true }).selectOption("redBlue");
  await expect.poll(svg).toContain(metadataTipTableContinuousColor(10, 10, 90, "redBlue"));
  await tableSettings.getByRole("combobox", { name: "Binary display", exact: true }).selectOption("check");
  await expect.poll(svg).toContain("0 (no mark)");
  await expect.poll(svg).toContain(">\u2713</text>");
  await tableSettings.getByRole("combobox", { name: "Binary display", exact: true }).selectOption("text");
  await expect.poll(svg).not.toContain(">\u2713</text>");
  await tableSettings.getByRole("combobox", { name: "Numeric display", exact: true }).selectOption("bars");
  await tableSettings.getByRole("combobox", { name: "Binary display", exact: true }).selectOption("check-cross");
  await expect.poll(svg).toContain("Tip bars: Score");
  expect(await svg()).toContain("Tip table: Country");
  expect(await svg()).toContain("Tip bars: Year");
  expect(await svg()).toContain(">\u00d7</text>");
  const columnModes = () => page.evaluate(() => (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { columns?: Array<{ mode: string; width: number }> })?.columns);
  await expect.poll(columnModes).toEqual([
    { column: "score", kind: "number", mode: "bars", width: 80 },
    { column: "resistant", kind: "binary", mode: "categorical", width: 80 },
    { column: "country", kind: "categorical", mode: "categorical", width: 80 },
    { column: "collection_year", kind: "date", mode: "bars", width: 80 },
  ]);
  await expect(tableSettings.getByRole("combobox", { name: /data type/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close Tip data table settings", exact: true }).click();
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView());
  const header = await page.evaluate(() => (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { headers: Array<{ column: string; x: number; y: number }> }).headers.find(item => item.column === "score")!);
  const canvas = (await page.getByTestId("tree-canvas").boundingBox())!;
  await page.mouse.click(canvas.x + header.x, canvas.y + header.y, { button: "right" });
  await expect(page.getByRole("textbox", { name: "Column display name", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Rename Column", exact: true }).click();
  await page.getByRole("textbox", { name: "Column display name", exact: true }).fill("Fitness score");
  await page.getByRole("button", { name: "Apply column name", exact: true }).click();
  await expect.poll(svg).toContain("Tip bars: Fitness score");
  await page.screenshot({ path: testInfo.outputPath("tip-table-legend.png") });
  await page.evaluate(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  const session = JSON.parse(strFromU8(gunzipSync(await readFile((await (await download).path())!))));
  expect(session.settings).toMatchObject({ metadataTipTableMode: "bars", metadataTipTableBinaryStyle: "check-cross", metadataTipTableCellWidthPx: 80, metadataTipTableHeaderFontSizePx: 18 });
  expect(session.settings.metadataTipTableColumns[0]).toEqual({ column: "score", label: "Fitness score" });
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.setMetadataTipTableMode("heatmap"));
  await expect.poll(columnModes).toEqual(expect.arrayContaining([{ column: "collection_year", kind: "date", mode: "heatmap", width: 80 }]));
  await page.evaluate(session => window.postMessage({ type: "big-tree-viewer:load", payload: { session } }, "*"), session);
  await expect.poll(columnModes).toEqual(expect.arrayContaining([{ column: "collection_year", kind: "date", mode: "bars", width: 80 }]));
});
