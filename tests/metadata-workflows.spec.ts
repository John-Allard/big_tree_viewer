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
  await load(page, { enabled: true, valueColumn: "date", colorMode: "date" }, {
    metadataLegendEnabled: true, metadataTipTableEnabled: true, metadataTipTableMode: "heatmap",
    metadataTipTableColumns: [{ column: "date", label: "Collection date", valueType: "date" }],
  });
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataTipTableColumns))
    .toEqual([{ column: "date", label: "Collection date", valueType: "date" }]);
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

test("web API imports a custom taxonomy file and generates styled subtree ribbons", async ({ page }) => {
  await page.route("https://example.test/custom.csv", route => route.fulfill({ contentType: "text/csv", body: csv }));
  await load(page, { text: undefined, url: "https://example.test/custom.csv", autoRankColumns: true,
    cladeRibbons: { labelColumn: "country", mode: "tips", widthPx: 40, labelSizePx: 18 } });
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount)).toBe(4);
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().customCladeRibbons)).toMatchObject([
    { label: "France", widthPx: 40, labelSizePx: 18 }, { label: "Canada", widthPx: 40, labelSizePx: 18 },
  ]);
  const map = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest());
  expect(map?.mappingOrigin).toBe("metadata-ranks");
  expect(map?.activeRanks).toEqual(expect.arrayContaining(["family", "genus"]));
});

for (const mode of ["api", "ui"] as const) test(`NCBI maps metadata TaxIDs instead of arbitrary sequence labels (${mode})`, async ({ page }) => {
  const nodes = ["1\t|\t1\t|\tno rank\t|", "2\t|\t1\t|\tsuperkingdom\t|", "6\t|\t2\t|\tfamily\t|", "7\t|\t6\t|\tgenus\t|", "8\t|\t7\t|\tspecies\t|", "9\t|\t6\t|\tgenus\t|", "10\t|\t9\t|\tspecies\t|"].join("\n");
  const names = [[1, "root"], [2, "Bacteria"], [6, "Testaceae"], [7, "Alpha"], [8, "Alpha one"], [9, "Beta"], [10, "Beta two"]].map(([id, name]) => `${id}\t|\t${name}\t|\t\t|\tscientific name\t|`).join("\n");
  const archive = Buffer.from(zipSync({ "nodes.dmp": strToU8(nodes), "names.dmp": strToU8(names) }));
  await page.route("https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdmp.zip", route => route.fulfill({ status: 200, contentType: "application/zip", body: archive }));
  await load(page, mode === "api" ? { taxIdColumn: "taxid" } : {}, {}, mode === "api" ? { runMapping: true, allowDownload: true } : undefined);
  if (mode === "ui") {
    await openPanel(page, "Taxonomy");
    const source = page.getByRole("combobox", { name: "Taxonomy source", exact: true });
    await source.selectOption("catalogue-of-life");
    await source.selectOption("custom");
    await page.getByText("Metadata TaxID mapping", { exact: true }).click();
    await page.getByRole("combobox", { name: "NCBI TaxID column", exact: true }).selectOption("taxid");
    await page.getByRole("button", { name: "Map NCBI TaxIDs", exact: true }).click();
  }
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount)).toBe(4);
  const result = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest());
  expect(result).toMatchObject({ mappingOrigin: "metadata-taxids", identifierMode: "ncbi-taxid" });
  expect(result?.tipRanks.map(tip => tip.sourceTaxId)).toEqual([8, 8, 10, 10]);
});

for (const mode of ["launch", "manual"] as const) test(`NCBI maps microbial display names, preserves ribbons, and restores its metadata-specific cache (${mode})`, async ({ page }) => {
  const ribbons = [
    { id: "metadata-ribbon:tips:1", node: 1, label: "France", color: "#2b8cbe", placement: "outside", enabled: true },
    { id: "metadata-ribbon:tips:4", node: 4, label: "Canada", color: "#d95f0e", placement: "outside", enabled: true },
    { id: "manual-root", node: 0, label: "Study group", color: "#965ac7", placement: "outside", enabled: true },
  ];
  const nodes = ["1\t|\t1\t|\tno rank\t|", "2\t|\t1\t|\tsuperkingdom\t|", "6\t|\t2\t|\tfamily\t|", "7\t|\t6\t|\tgenus\t|", "8\t|\t7\t|\tspecies\t|", "9\t|\t6\t|\tgenus\t|", "10\t|\t9\t|\tspecies\t|"].join("\n");
  const names = [[1, "root"], [2, "Bacteria"], [6, "Enterobacteriaceae"], [7, "Escherichia"], [8, "Escherichia coli"], [9, "Salmonella"], [10, "Salmonella enterica"]].map(([id, name]) => `${id}\t|\t${name}\t|\t\t|\tscientific name\t|`).join("\n");
  const archive = Buffer.from(zipSync({ "nodes.dmp": strToU8(nodes), "names.dmp": strToU8(names) }));
  await page.route("https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdmp.zip", route => route.fulfill({ status: 200, contentType: "application/zip", body: archive }));
  await load(page, { text: "sequence_id,display_name\nsample1,Escherichia coli A\nsample2,Escherichia_coli_B\nsample3,Salmonella enterica C\nsample4,Salmonella_enterica_D\n", tipLabelColumn: mode === "launch" ? "display_name" : "" }, { customCladeRibbons: ribbons }, { runMapping: true, allowDownload: true });
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().customCladeRibbons)).toEqual(ribbons);
  if (mode === "manual") {
    await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getTaxonomyMapForTest()?.mappedCount)).toBe(0);
    await openPanel(page, "Visual Options");
    await page.getByRole("button", { name: "Tip labels settings", exact: true }).click();
    await page.getByRole("combobox", { name: "Tip label source", exact: true }).selectOption("display_name");
    await page.getByRole("button", { name: "Close Tip labels settings", exact: true }).click();
    await openPanel(page, "Taxonomy");
    const run = page.getByRole("button", { name: "Run Taxonomy Mapping", exact: true });
    await expect(run).toBeEnabled();
    await run.click();
  }
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount)).toBe(4);
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().customCladeRibbons)).toEqual(ribbons);
  for (const view of ["rectangular", "circular"] as const) {
    await page.evaluate(view => window.__BIG_TREE_VIEWER_APP_TEST__!.setViewMode(view), view);
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getSubtreeRibbonHitboxes().length)).toBe(3);
    const svg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()!);
    for (const ribbon of ribbons) expect(svg).toContain(ribbon.color);
  }
  const map = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getTaxonomyMapForTest());
  expect(map?.mappingOrigin).toBe("metadata-display-names");
  expect(map?.tipRanks.map(tip => tip.sourceTaxId)).toEqual([8, 8, 10, 10]);
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.names)).toContain("sample1");
  const cached = await page.evaluate(async () => {
    const modulePath = "/src/lib/taxonomyCache.ts";
    const cache = await import(modulePath);
    return cache.getCachedTaxonomyMapping(window.__BIG_TREE_VIEWER_APP_TEST__!.getState().treeSignature);
  });
  if (mode === "launch") expect(cached).toBeNull();
  else expect(cached?.mappedCount).toBe(0);
  const displayCache = await page.evaluate(async () => {
    const cacheModule = "/src/lib/taxonomyCache.ts";
    const metadataModule = "/src/lib/metadataMapping.ts";
    const cache = await import(cacheModule), metadata = await import(metadataModule);
    const values: Record<string, string> = { sample1: "Escherichia coli A", sample2: "Escherichia_coli_B", sample3: "Salmonella enterica C", sample4: "Salmonella_enterica_D" };
    const labels = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.names!.map(name => values[name] ?? null);
    const key = await metadata.metadataDisplayNameCacheKey(window.__BIG_TREE_VIEWER_APP_TEST__!.getState().treeSignature, labels);
    return cache.getCachedTaxonomyMapping(key);
  });
  expect(displayCache?.mappedCount).toBe(4);
  const payload = { newick, metadata: { text: "sequence_id,display_name\nsample1,Escherichia coli A\nsample2,Escherichia_coli_B\nsample3,Salmonella enterica C\nsample4,Salmonella_enterica_D\n", keyColumn: "sequence_id", tipLabelColumn: "display_name" }, visual: { viewMode: "rectangular", customCladeRibbons: ribbons } };
  await page.goto(`/?btv_payload=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`);
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount)).toBe(4);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().taxonomyMappedCount)).toBe(4);
  await expect(page.getByText(/0 mapped tips|4 of 4 tips.*not mapped/)).toHaveCount(0);
  await openPanel(page, "Taxonomy");
  await expect(page.getByRole("button", { name: "NCBI Taxonomy Loaded", exact: true })).toBeDisabled();
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
  await page.getByRole("combobox", { name: "Taxonomy source", exact: true }).selectOption("custom");
  await page.getByRole("button", { name: "Apply custom taxonomy ribbons", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount)).toBe(4);
});
