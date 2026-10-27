import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync, strFromU8, strToU8, zipSync } from "fflate";

const newick = "((sample1:1,sample2:1)GroupA:1,(sample3:1,sample4:1)GroupB:1)Root;";
const csv = "sequence_id,display_name,country,date,taxid,family,genus\nsample1,Sample One,France,2024-01-01,8,Family A,Genus A\nsample2,Sample Two,France,2024-04-01,8,Family A,Genus A\nsample3,Sample Three,Canada,2024-07-01,10,Family B,Genus B\nsample4,Sample Four,Canada,2025-01-01,10,Family B,Genus B\n";

async function load(page: Page, metadata: Record<string, unknown> = {}, visual: Record<string, unknown> = {}, taxonomy?: Record<string, unknown>) {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(payload => window.postMessage({ type: "big-tree-viewer:load", payload }, "*"), {
    newick, label: "Pathogen example", metadata: { text: csv, keyColumn: "sequence_id", ...metadata },
    visual: { viewMode: "rectangular", showGenusLabels: false, ...visual }, taxonomy,
  });
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));
}

async function openPanel(page: Page, name: string) {
  const toggle = page.locator(".panel-section .section-toggle").filter({ hasText: name }).first();
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

test("date color scales and legend settings remain synchronized", async ({ page }, testInfo) => {
  await load(page, { enabled: true, valueColumn: "date", colorMode: "date" }, { metadataLegendEnabled: true });
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataColoredNodeCount === 4);
  await openPanel(page, "Metadata");
  await page.getByRole("button", { name: "Metadata legend settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Color scale palette", exact: true }).selectOption("viridis");
  await page.getByLabel("Reverse color scale", { exact: true }).check();
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataContinuousLegend)).toMatchObject({
    valueType: "date", minLabel: "2024-01-01", maxLabel: "2025-01-01", palette: "viridis", startColor: "#fde725",
  });
  await page.screenshot({ path: testInfo.outputPath("date-metadata-legend.png") });
  await page.getByRole("button", { name: "Close Metadata legend settings", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("date-metadata-mobile.png") });
});

test("custom taxonomy, alternate tip names and metadata collapse survive a session round trip", async ({ page }, testInfo) => {
  await load(page, { tipLabelColumn: "display_name", rankColumns: { family: "family", genus: "genus" } });
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest()?.mappingOrigin === "metadata-ranks");
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().tipLabelMetadataColumn)).toBe("display_name");
  const before = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names);
  expect(before).toContain("sample1");
  expect(before).not.toContain("Sample One");
  await page.screenshot({ path: testInfo.outputPath("custom-metadata-ribbons.png") });
  await openPanel(page, "Metadata");
  await page.getByRole("combobox", { name: "Collapse by metadata", exact: true }).selectOption("country");
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCollapsedNodeModes().length)).toBe(2);
  await page.evaluate(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  const download = await downloadEvent;
  const session = JSON.parse(strFromU8(gunzipSync(await readFile((await download.path())!))));
  expect(session.settings).toMatchObject({ tipLabelMetadataColumn: "display_name", metadataCollapseColumn: "country" });
  expect(session.taxonomy.map.mappingOrigin).toBe("metadata-ranks");
  expect(session.canvas.collapsedNodeModes).toEqual([]);
  await page.evaluate(payload => window.postMessage({ type: "big-tree-viewer:load", payload: { session: payload } }, "*"), session);
  await page.waitForFunction(() => !window.__BIG_TREE_VIEWER_APP_TEST__?.getState().loading);
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest()?.mappingOrigin)).toBe("metadata-ranks");
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataCollapseColumn)).toBe("country");
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCollapsedNodeModes().length)).toBe(2);
  await page.screenshot({ path: testInfo.outputPath("custom-metadata-collapsed.png") });
  await page.getByRole("combobox", { name: "Collapse by metadata", exact: true }).selectOption("");
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCollapsedNodeModes().length)).toBe(0);
});

test("NCBI maps metadata TaxIDs instead of arbitrary sequence labels", async ({ page }) => {
  const nodes = ["1\t|\t1\t|\tno rank\t|", "2\t|\t1\t|\tsuperkingdom\t|", "6\t|\t2\t|\tfamily\t|", "7\t|\t6\t|\tgenus\t|", "8\t|\t7\t|\tspecies\t|", "9\t|\t6\t|\tgenus\t|", "10\t|\t9\t|\tspecies\t|"].join("\n");
  const names = [[1, "root"], [2, "Bacteria"], [6, "Testaceae"], [7, "Alpha"], [8, "Alpha one"], [9, "Beta"], [10, "Beta two"]].map(([id, name]) => `${id}\t|\t${name}\t|\t\t|\tscientific name\t|`).join("\n");
  const archive = Buffer.from(zipSync({ "nodes.dmp": strToU8(nodes), "names.dmp": strToU8(names) }));
  await page.route("https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdmp.zip", route => route.fulfill({ status: 200, contentType: "application/zip", body: archive }));
  await load(page, { taxIdColumn: "taxid" }, {}, { runMapping: true, allowDownload: true });
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount)).toBe(4);
  const result = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest());
  expect(result).toMatchObject({ mappingOrigin: "metadata-taxids", identifierMode: "ncbi-taxid" });
  expect(result?.tipRanks.map(tip => tip.sourceTaxId)).toEqual([8, 8, 10, 10]);
});

test("mapping buttons load a shared table and label source lives in tip settings", async ({ page }) => {
  await load(page);
  await openPanel(page, "Visual Options");
  await page.getByRole("button", { name: "Tip labels settings", exact: true }).click();
  const chooserEvent = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open label mapping file", exact: true }).click();
  await (await chooserEvent).setFiles({ name: "mapping.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataFileName)).toBe("mapping.csv");
  await page.getByRole("combobox", { name: "Tip label source", exact: true }).selectOption("display_name");
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().tipLabelMetadataColumn)).toBe("display_name");
  await page.getByRole("button", { name: "Close Tip labels settings", exact: true }).click();
  await openPanel(page, "Taxonomy");
  await page.locator("summary").filter({ hasText: "Custom taxonomy from metadata" }).click();
  await page.getByRole("combobox", { name: "Family column", exact: true }).selectOption("family");
  await page.getByRole("combobox", { name: "Genus column", exact: true }).selectOption("genus");
  await page.getByRole("button", { name: "Apply custom taxonomy ribbons", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount)).toBe(4);
});
