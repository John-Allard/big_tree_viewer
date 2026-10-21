import { expect, test } from "@playwright/test";

for (const mode of ["rectangular", "circular", "fan", "spiral"]) {
  test(`${mode} label threshold changes visibility without changing framing`, async ({ page }, testInfo) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width: 1000, height: 640 });
    const tipCount = mode === "spiral" ? 1000 : mode === "rectangular" ? 160 : mode === "fan" ? 300 : 600;
    const newick = `(${Array.from({ length: tipCount }, (_, i) => `Species_${i}:1`).join(",")})Root;`;
    await page.route("**/threshold-tree.nwk", route => route.fulfill({ body: newick }));
    await page.goto(`/?btv_newick_url=/threshold-tree.nwk&btv_view=${mode}`);
    await page.waitForFunction(count => {
      const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
      return state?.treeLoaded && !state.loading
        && window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes.length === count
        && Boolean(window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
    }, tipCount);
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
    await page.getByRole("button", { name: "Visual Options" }).click();
    await page.getByRole("button", { name: "Taxonomy overlays settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Taxonomy overlays settings" });
    const threshold = settings.getByLabel("Label visibility threshold", { exact: true });
    await expect(threshold).toHaveValue("1");
    const setThreshold = async (value: number) => {
      if (!await threshold.isVisible()) {
        await page.getByRole("button", { name: "Taxonomy overlays settings", exact: true }).click();
      }
      await threshold.evaluate((input, next) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(next));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
      await page.waitForFunction(next => (window.__BIG_TREE_VIEWER_APP_TEST__!.getState().figureStyles as { taxonomy: { labelVisibilityThreshold: number } }).taxonomy.labelVisibilityThreshold === next, value);
    };
    const snapshot = async () => page.evaluate(() => {
      const svg = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()!;
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      return {
        labels: [...doc.querySelectorAll("text")].map(node => node.textContent ?? "").filter(text => /^F\d+$/.test(text)),
        camera: window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera(),
        frame: doc.documentElement.getAttribute("viewBox"),
        ranks: window.__BIG_TREE_VIEWER_APP_TEST__!.getState().taxonomyRankVisibility,
      };
    });
    const normal = await snapshot();
    await setThreshold(0.1);
    const dense = await snapshot();
    expect(dense.labels.length).toBeGreaterThan(normal.labels.length);
    expect(dense.camera).toEqual(normal.camera);
    expect(dense.frame).toEqual(normal.frame);
    expect(dense.ranks).toEqual(normal.ranks);
    await page.screenshot({ path: testInfo.outputPath("lower-threshold.png") });

    await page.getByRole("button", { name: "Export View", exact: true }).click();
    const exportDialog = page.getByRole("dialog", { name: "Export view settings" });
    const width = await page.getByTestId("tree-canvas").evaluate(canvas => canvas.clientWidth);
    await exportDialog.getByLabel("Width px").fill(String(width * 4));
    await expect(exportDialog.getByLabel("Height px", { exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      const labels: string[] = [];
      (window as typeof window & { __thresholdExportLabels: string[] }).__thresholdExportLabels = labels;
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
        if (!this.canvas.isConnected && /^F\d+$/.test(text)) labels.push(text);
        if (maxWidth === undefined) original.call(this, text, x, y);
        else original.call(this, text, x, y, maxWidth);
      };
    });
    const downloadPromise = page.waitForEvent("download");
    await exportDialog.getByRole("button", { name: "Export", exact: true }).click();
    await (await downloadPromise).saveAs(testInfo.outputPath("lower-threshold-4x.png"));
    const exportedLabels = await page.evaluate(() => [...new Set((window as typeof window & { __thresholdExportLabels: string[] }).__thresholdExportLabels)]);
    expect(exportedLabels.length).toBeGreaterThan(normal.labels.length);
    expect((await snapshot()).camera).toEqual(normal.camera);
    await exportDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await setThreshold(2);
    expect((await snapshot()).labels.length).toBeLessThanOrEqual(normal.labels.length);
    await setThreshold(1);
    expect((await snapshot()).labels).toEqual(normal.labels);
    await testInfo.attach("label-counts", { body: JSON.stringify({ normal: normal.labels.length, dense: dense.labels.length }), contentType: "application/json" });
  });
}
