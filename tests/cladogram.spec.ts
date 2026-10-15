import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const newick = "(((A_a:2,B_b:3)88[&height_95%_HPD={8,10}]:4,C_c:6)99:5,D_d:20)Root;";
const spiralNewick = `(${Array.from({ length: 1000 }, (_, index) => `Tip_${index}:1`).join(",")})Root;`;

for (const view of ["rectangular", "circular"] as const) {
  test(`${view} cladograms use unit internal edges and optional aligned tips without editing the tree`, async ({ page }) => {
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=${view}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: "Visual Options", exact: false }).click();
    await expect(page.getByLabel("Show cladogram", { exact: true })).not.toBeChecked();
    await page.getByLabel("Show node height labels", { exact: true }).check();
    await page.getByLabel("Show node error bars", { exact: true }).check();
    await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!;
      api.setManualBranchColor(internal.leafNodes[0], "#00aa44");
    });
    await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCurrentBranchColors())).toContain("#00aa44");
    const original = await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      return { maxDepth: window.__BIG_TREE_VIEWER_APP_TEST__!.getState().maxDepth, colors: api.getCurrentBranchColors() };
    });
    await page.getByLabel("Show cladogram", { exact: true }).check();
    await expect(page.getByLabel("Show scale bars", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Show scale bars", { exact: true })).not.toBeChecked();
    await expect(page.getByLabel("Show node error bars", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Show node error bars", { exact: true })).not.toBeChecked();
    await expect(page.getByLabel("Show node height labels", { exact: true })).toBeChecked();
    const readEdges = () => page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!;
      const camera = api.getCamera()!;
      const scale = camera.kind === "rect" ? camera.scaleX : camera.scale;
      return internal.parent!.map((parent, node) => {
        const segment = api.getBranchScreenSegmentForTest(node);
        return {
          node, parent, terminal: internal.firstChild![node] < 0,
          length: segment ? Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1) / scale : 0,
          tipRadius: segment && camera.kind === "circular"
            ? Math.hypot(segment.x2 - camera.translateX, segment.y2 - camera.translateY) / scale
            : segment && camera.kind === "rect" ? (segment.x2 - camera.translateX) / scale : 0,
        };
      }).filter(edge => edge.parent >= 0);
    });
    await expect.poll(async () => (await readEdges()).filter(edge => !edge.terminal).map(edge => Number(edge.length.toFixed(6))))
      .toEqual([1, 1]);
    for (const edge of (await readEdges()).filter(edge => edge.terminal)) expect(edge.tipRadius).toBeCloseTo(3, 8);
    await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
    await expect(page.getByLabel("Show as ultrametric cladogram", { exact: true })).toBeChecked();
    await page.getByLabel("Show as ultrametric cladogram", { exact: true }).uncheck();
    await expect.poll(async () => (await readEdges()).map(edge => Number(edge.length.toFixed(6))))
      .toEqual([1, 1, 1, 1, 1, 1]);
    const svg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest());
    expect(svg).toMatch(/>5<\/text>/);
    expect(svg).toMatch(/>9<\/text>/);
    expect(svg).not.toContain("mya");
    await page.getByRole("heading", { name: "Big Tree Viewer", exact: true }).click();
    await page.getByLabel("Show cladogram", { exact: true }).uncheck();
    await expect(page.getByLabel("Show scale bars", { exact: true })).toBeEnabled();
    await expect(page.getByLabel("Show node error bars", { exact: true })).toBeChecked();
    await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCurrentBranchColors())).toEqual(original.colors);
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().maxDepth)).toBe(original.maxDepth);
  });
}

test("cladogram settings round-trip while the session retains input branch lengths", async ({ page }) => {
  await page.goto(`/?btv_newick=${encodeURIComponent(newick)}`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: "Visual Options", exact: false }).click();
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
  await page.getByLabel("Show cladogram", { exact: true }).check();
  await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
  await page.getByLabel("Show as ultrametric cladogram", { exact: true }).uncheck();
  await page.getByRole("heading", { name: "Big Tree Viewer", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  const file = await (await downloadPromise).path();
  const bytes = await readFile(file!);
  const session = JSON.parse((bytes[0] === 0x1f ? gunzipSync(bytes) : bytes).toString("utf8"));
  expect(session.settings.showCladogram).toBe(true);
  expect(session.settings.ultrametricCladogram).toBe(false);
  await page.getByLabel("Show cladogram", { exact: true }).uncheck();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load Session", exact: true }).click();
  await (await chooserPromise).setFiles(file!);
  await expect(page.getByLabel("Show cladogram", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
  await expect(page.getByLabel("Show as ultrametric cladogram", { exact: true })).not.toBeChecked();
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().maxDepth)).toBe(20);
});

test("spiral disables cladogram display and uses original lengths", async ({ page }) => {
  await page.goto(`/?btv_newick=${encodeURIComponent(spiralNewick)}`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: "Visual Options", exact: false }).click();
  await page.getByLabel("Show cladogram", { exact: true }).check();
  await page.getByRole("button", { name: "Spiral", exact: true }).click();
  await expect(page.getByLabel("Show cladogram", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Show cladogram", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Show scale bars", { exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Radial", exact: true }).click();
  await expect(page.getByLabel("Show cladogram", { exact: true })).toBeChecked();
});

for (const view of ["rectangular", "circular", "spiral"] as const) {
  test(`scale master switch removes stripes, ticks and labels in ${view}`, async ({ page }) => {
    await page.goto(`/?btv_newick=${encodeURIComponent(view === "spiral" ? spiralNewick : newick)}&btv_view=${view}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: "Visual Options", exact: false }).click();
    await page.getByLabel("Show scale bars", { exact: true }).uncheck();
    const decorations = await page.evaluate(() => {
      const svg = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()!;
      const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=tree-canvas]")!;
      const ctx = canvas.getContext("2d")!;
      const row = ctx.getImageData(0, canvas.height - 28, canvas.width, 1).data;
      let axisPixels = 0;
      for (let i = 0; i < row.length; i += 4) if (row[i] === 107 && row[i + 1] === 114 && row[i + 2] === 128) axisPixels++;
      return { svg, axisPixels };
    });
    expect(decorations.svg).not.toContain("mya");
    expect(decorations.svg).not.toContain("#6b7280");
    expect(decorations.axisPixels).toBe(0);
    await page.getByLabel("Show scale bars", { exact: true }).check();
    await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
    await expect(page.getByLabel("Show time stripes", { exact: true })).toBeVisible();
    await page.getByLabel("Show time stripes", { exact: true }).uncheck();
    await expect(page.getByLabel("Show scale bars", { exact: true })).toBeChecked();
  });
}

for (const width of [1100, 390]) {
  test(`cladogram settings fit a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=circular`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: "Visual Options", exact: false }).click();
    await page.getByLabel("Show cladogram", { exact: true }).check();
    await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cladogram settings", exact: true });
    await expect(dialog).toBeVisible();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/cladogram-${width}.png` });
  });
}
