import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

for (const mode of ["circular", "fan", "spiral"]) {
  test(`${mode} exports taxonomy ribbon labels curved without changing the view`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    const newick = `(${Array.from({ length: 1000 }, (_, i) => `Tip_${i}:100`).join(",")})Root;`;
    await page.route("**/curved-tree.nwk", route => route.fulfill({ body: newick }));
    await page.goto(`/?btv_newick_url=/curved-tree.nwk&btv_view=${mode}`);
    await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()));
    await page.evaluate(mode => {
      const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
      const leaves = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.leafNodes;
      app.setTaxonomyMapForTest({ version: 1, mappedCount: leaves.length, totalTips: leaves.length, activeRanks: ["family"],
        tipRanks: leaves.map((node, i) => ({ node, ranks: { family: `Q${String.fromCharCode(97 + Math.floor(i / 200))}` } })) });
      app.setTaxonomyEnabled(true);
      app.setTaxonomyRankVisibilityAutoForTest(false);
      app.setTaxonomyRankDisplayModeForTest("family", "ribbon");
      if (mode === "spiral") app.setSpiralTurnsForTest(3);
      app.requestFit();
    }, mode);
    await page.getByRole("button", { name: "Export View", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export view settings" });
    const toggle = dialog.getByLabel("Curve all taxonomy ribbon labels", { exact: true });
    await expect(toggle).toHaveCount(0);
    await dialog.getByLabel("Width px").fill("1000");
    const screen = await page.getByTestId("tree-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
    const camera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera());
    const exportSvg = async () => {
      await dialog.getByRole("combobox", { name: "Format", exact: true }).selectOption("svg");
      const download = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Export", exact: true }).click();
      const file = await download;
      await file.saveAs(testInfo.outputPath("curved-labels.svg"));
      return readFile((await file.path())!, "utf8");
    };
    const curved = await exportSvg();
    const textRuns = async (svg: string) => page.evaluate(markup => [...new DOMParser().parseFromString(markup, "image/svg+xml").querySelectorAll("text")]
      .map(text => text.textContent ?? ""), svg);
    const curvedRuns = await textRuns(curved);
    expect(curvedRuns.some(text => /^Q[a-e]$/.test(text))).toBe(false);
    for (const label of ["Qa", "Qb", "Qc", "Qd", "Qe"]) {
      expect(curvedRuns.join("")).toContain(label);
    }
    expect(curvedRuns).toContain("Q");
    await dialog.getByRole("combobox", { name: "Format", exact: true }).selectOption("png");
    await expect(toggle).toHaveCount(0);
    await page.evaluate(() => {
      const original = CanvasRenderingContext2D.prototype.fillText;
      const runs: string[] = [];
      (window as typeof window & { __curvedExportRuns: string[] }).__curvedExportRuns = runs;
      CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
        if (!this.canvas.isConnected && /^Q[a-e]?$/.test(text)) runs.push(text);
        if (maxWidth === undefined) original.call(this, text, x, y);
        else original.call(this, text, x, y, maxWidth);
      };
    });
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const png = await download;
    await png.saveAs(testInfo.outputPath("curved-labels.png"));
    expect((await readFile((await png.path())!)).readUInt32BE(16)).toBe(1000);
    const pngRuns = await page.evaluate(() => (window as typeof window & { __curvedExportRuns: string[] }).__curvedExportRuns);
    expect(pngRuns).toContain("Q");
    expect(pngRuns.some(text => /^Q[a-e]$/.test(text))).toBe(false);
    expect(await page.getByTestId("tree-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(screen);
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera())).toEqual(camera);
    await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setViewMode("rectangular"));
    await expect(toggle).toHaveCount(0);
    await dialog.getByRole("button", { name: "Restore Defaults" }).click();
    await page.evaluate(mode => window.__BIG_TREE_VIEWER_APP_TEST__!.setViewMode(mode as "circular" | "fan" | "spiral"), mode);
    await expect(toggle).toHaveCount(0);
  });
}

for (const mode of ["rectangular", "circular", "fan", "spiral"]) {
  test(`${mode} can add readable ribbon labels only to high-resolution PNGs`, async ({ page }, testInfo) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width: 1000, height: 640 });
    const tipCount = mode === "spiral" ? 1000 : mode === "rectangular" ? 160 : mode === "fan" ? 300 : 600;
    const newick = `(${Array.from({ length: tipCount }, (_, i) => `Species_${i}:1`).join(",")})Root;`;
    await page.route("**/label-tree.nwk", route => route.fulfill({ body: newick }));
    await page.goto(`/?btv_newick_url=/label-tree.nwk&btv_view=${mode}`);
    await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()));
    await page.getByRole("button", { name: "Export View", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export view settings" });
    const checkbox = dialog.getByLabel("Show additional taxonomy labels at export resolution");
    await expect(checkbox).toHaveCount(0);
    await page.evaluate(() => {
      const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
      const leaves = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.leafNodes;
      app.setTaxonomyMapForTest({
        version: 1, mappedCount: leaves.length, totalTips: leaves.length, activeRanks: ["family"],
        tipRanks: leaves.map((node, i) => ({ node, ranks: { family: `F${Math.floor(i / 2)}` } })),
      });
      app.setTaxonomyRankVisibilityForTest("family", true);
      app.requestFit();
    });
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await page.evaluate(() => {
      const original = CanvasRenderingContext2D.prototype.fillText;
      const recording: string[] = [];
      (window as typeof window & { __exportLabels: string[] }).__exportLabels = recording;
      CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
        // Curved labels draw glyphs individually; each F still starts one label.
        if (!this.canvas.isConnected && /^F\d*$/.test(text)) recording.push(text);
        if (maxWidth === undefined) original.call(this, text, x, y);
        else original.call(this, text, x, y, maxWidth);
      };
    });
    const counts: number[] = [];
    for (const [resolution, enabled] of [[1, false], [1, true], [4, false], [4, true], [4, false]] as const) {
      await dialog.getByLabel("Width px").fill(String(resolution === 1 ? 200 : 2800));
      await checkbox.setChecked(enabled);
      const before = await page.getByTestId("tree-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
      await page.evaluate(() => { (window as typeof window & { __exportLabels: string[] }).__exportLabels.length = 0; });
      const download = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Export", exact: true }).click();
      const file = await download;
      if (resolution > 1 && enabled) await file.saveAs(testInfo.outputPath("additional-labels.png"));
      counts.push(await page.evaluate(() => (window as typeof window & { __exportLabels: string[] }).__exportLabels.length));
      expect(await page.getByTestId("tree-canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(before);
    }
    await testInfo.attach("exported-label-counts", { body: JSON.stringify(counts), contentType: "application/json" });
    expect(counts[1]).toBe(counts[0]);
    expect(counts[2]).toBe(counts[0]);
    expect(counts[3]).toBeGreaterThan(counts[2]);
    expect(counts[4]).toBe(counts[2]);
    await checkbox.check();
    await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setTaxonomyEnabled(false));
    await expect(checkbox).toHaveCount(0);
    await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setTaxonomyEnabled(true));
    await expect(checkbox).toBeChecked();
    await dialog.getByRole("combobox", { name: "Format", exact: true }).selectOption("svg");
    await expect(checkbox).toHaveCount(0);
    await dialog.getByRole("button", { name: "Restore Defaults" }).click();
    await expect(checkbox).not.toBeChecked();
  });
}
