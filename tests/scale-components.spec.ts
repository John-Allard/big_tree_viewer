import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const newick = "((A_a:500,B_b:500):500,(C_c:500,D_d:500):500)Root;";
const spiralNewick = `(${Array.from({ length: 1000 }, (_, index) => `T${index}:1000`).join(",")})Root;`;

test("scale settings only show controls for the selected geometry and axis", async ({ page }, testInfo) => {
  await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=rectangular`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: /Visual Options/ }).click();
  await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
  const autoAngle = page.getByLabel("Auto angle from tip ordering", { exact: true });
  const angle = page.getByLabel("Circular center scale angle", { exact: true });
  const logBase = page.getByLabel("Log time scale base", { exact: true });
  await expect(autoAngle).toHaveCount(0);
  await expect(angle).toHaveCount(0);
  await expect(logBase).toHaveCount(0);
  await page.getByLabel("Use log time axis", { exact: true }).check();
  await expect(logBase).toBeVisible();
  await page.getByLabel("Use log time axis", { exact: true }).uncheck();
  await expect(logBase).toHaveCount(0);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setViewMode("circular"));
  await expect(autoAngle).toBeChecked();
  await expect(angle).toHaveCount(0);
  await autoAngle.uncheck();
  await expect(angle).toBeVisible();
  await autoAngle.check();
  await expect(angle).toHaveCount(0);
  const stripeLabels = page.getByLabel("Show Time Stripe Labels", { exact: true });
  await expect(stripeLabels).toHaveCount(0);
  await page.getByLabel("Show scale bar labels", { exact: true }).uncheck();
  await expect(stripeLabels).toBeVisible();
  await stripeLabels.check();
  await page.screenshot({ path: testInfo.outputPath("conditional-scale-controls.png") });
});

async function readDecorations(page: Page) {
  return page.evaluate(() => {
    const svg = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()!;
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    return {
      axes: doc.querySelectorAll('line[stroke="#6b7280"], line[stroke="#64748b"]').length,
      labels: doc.querySelectorAll('text[fill="#6b7280"], text[fill="#475569"]').length,
      guides: doc.querySelectorAll('[stroke-dasharray="6 6"]').length,
      svg,
    };
  });
}

for (const view of ["rectangular", "circular", "fan", "spiral"] as const) {
  test(`${view} scale components are independent and respect the master switch`, async ({ page }) => {
    await page.goto(`/?btv_newick=${encodeURIComponent(view === "spiral" ? spiralNewick : newick)}&btv_view=${view}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: /Visual Options/ }).click();
    await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
    await page.getByRole("combobox", { name: "Stripe style", exact: true }).selectOption("dashed");
    if (view === "circular" || view === "fan") {
      await page.getByLabel("Show internal circular radial scale bar", { exact: true }).check();
    }
    await expect.poll(async () => (await readDecorations(page)).axes).toBeGreaterThan(0);
    await expect.poll(async () => (await readDecorations(page)).labels).toBeGreaterThan(0);
    await page.getByLabel("Show scale bar and ticks", { exact: true }).uncheck();
    await page.getByLabel("Show scale bar labels", { exact: true }).uncheck();
    let decorations = await readDecorations(page);
    expect(decorations.axes).toBe(0);
    expect(decorations.labels).toBe(0);
    expect(decorations.guides).toBeGreaterThan(0);

    await page.getByLabel("Show Time Stripe Labels", { exact: true }).check();
    decorations = await readDecorations(page);
    expect(decorations.axes).toBe(0);
    expect(decorations.labels).toBeGreaterThan(0);
    expect(decorations.guides).toBeGreaterThan(0);

    await page.getByLabel("Show time stripes", { exact: true }).uncheck();
    await expect(page.getByLabel("Show Time Stripe Labels", { exact: true })).toBeDisabled();
    decorations = await readDecorations(page);
    expect(decorations.axes).toBe(0);
    expect(decorations.labels).toBe(0);
    expect(decorations.guides).toBe(0);

    await page.getByLabel("Show scale bar and ticks", { exact: true }).check();
    decorations = await readDecorations(page);
    expect(decorations.axes).toBeGreaterThan(0);
    expect(decorations.labels).toBe(0);
    await page.getByLabel("Show scale bar and ticks", { exact: true }).uncheck();
    await page.getByLabel("Show scale bar labels", { exact: true }).check();
    decorations = await readDecorations(page);
    expect(decorations.axes).toBe(0);
    expect(decorations.labels).toBeGreaterThan(0);

    await page.getByLabel("Show time stripes", { exact: true }).check();
    await page.getByRole("heading", { name: "Big Tree Viewer", exact: true }).click();
    await page.getByLabel("Show scale bars", { exact: true }).uncheck();
    decorations = await readDecorations(page);
    expect(decorations.axes).toBe(0);
    expect(decorations.labels).toBe(0);
    expect(decorations.guides).toBe(0);
    await page.getByLabel("Show scale bars", { exact: true }).check();
    await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
    await expect(page.getByLabel("Show scale bar and ticks", { exact: true })).not.toBeChecked();
    await expect(page.getByLabel("Show scale bar labels", { exact: true })).toBeChecked();
    await expect(page.getByLabel("Show time stripes", { exact: true })).toBeChecked();
    if (view === "rectangular") {
      await expect(page.getByLabel("Show Time Stripe Labels", { exact: true })).toBeChecked();
    } else {
      await expect(page.getByLabel("Show Time Stripe Labels", { exact: true })).toHaveCount(0);
    }
  });
}

test("rectangular canvas removes the axis pixels but retains guide labels", async ({ page }) => {
  await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=rectangular`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: /Visual Options/ }).click();
  await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
  const axisPixels = () => page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=tree-canvas]")!;
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const pixels = canvas.getContext("2d")!.getImageData(0, Math.round((canvas.height / dpr - 29) * dpr), canvas.width, Math.ceil(3 * dpr)).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const red = pixels[i];
      const green = pixels[i + 1];
      const blue = pixels[i + 2];
      // A one-pixel stroke can straddle raster rows and blend with the background.
      if (red >= 100 && red <= 220 && green - red >= 3 && green - red <= 9 && blue - green >= 5 && blue - green <= 16) count++;
    }
    return count;
  });
  await expect.poll(axisPixels).toBeGreaterThan(30);
  await page.getByLabel("Show scale bar and ticks", { exact: true }).uncheck();
  await page.getByLabel("Show scale bar labels", { exact: true }).uncheck();
  await page.getByLabel("Show Time Stripe Labels", { exact: true }).check();
  await expect.poll(axisPixels).toBe(0);
  expect((await readDecorations(page)).labels).toBeGreaterThan(0);
});

test("zoomed radial edge scales also honor independent component controls", async ({ page }) => {
  await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=circular`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: /Visual Options/ }).click();
  await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
  await page.evaluate(() => {
    const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
    const camera = api.getCamera()!;
    if (camera.kind === "circular") api.setCircularCamera({ scale: camera.scale * 4 });
  });
  await expect.poll(async () => (await readDecorations(page)).axes).toBeGreaterThan(0);
  await page.getByLabel("Show scale bar and ticks", { exact: true }).uncheck();
  await page.getByLabel("Show scale bar labels", { exact: true }).uncheck();
  await page.getByLabel("Show Time Stripe Labels", { exact: true }).check();
  const decorations = await readDecorations(page);
  expect(decorations.axes).toBe(0);
  expect(decorations.labels).toBeGreaterThan(0);
  expect(decorations.svg).not.toContain('fill="rgba(251,252,254,0.97)"');
});

test("scale component settings survive a session round trip", async ({ page }) => {
  await page.goto(`/?btv_newick=${encodeURIComponent(newick)}`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
  await page.getByRole("button", { name: /Visual Options/ }).click();
  await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
  await page.getByLabel("Show scale bar and ticks", { exact: true }).uncheck();
  await page.getByLabel("Show scale bar labels", { exact: true }).uncheck();
  await page.getByLabel("Show Time Stripe Labels", { exact: true }).check();
  await page.getByRole("heading", { name: "Big Tree Viewer", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  const file = (await (await downloadPromise).path())!;
  const bytes = await readFile(file);
  const session = JSON.parse((bytes[0] === 0x1f ? gunzipSync(bytes) : bytes).toString("utf8"));
  expect(session.settings.figureStyles.scale).toMatchObject({ showScaleBar: false, showScaleBarLabels: false, showTimeGuideLabels: true });
  await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
  await page.getByLabel("Show scale bar and ticks", { exact: true }).check();
  await page.getByLabel("Show Time Stripe Labels", { exact: true }).uncheck();
  await page.getByRole("heading", { name: "Big Tree Viewer", exact: true }).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load Session", exact: true }).click();
  await (await chooserPromise).setFiles(file);
  await expect.poll(async () => (await readDecorations(page)).axes).toBe(0);
  await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
  await expect(page.getByLabel("Show scale bar and ticks", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Show scale bar labels", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Show Time Stripe Labels", { exact: true })).toBeChecked();
});

for (const width of [1100, 390]) {
  test(`scale component controls can be reached with sidebar scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: /Visual Options/ }).click();
    await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Scale labels settings", exact: true });
    await page.getByLabel("Show Time Stripe Labels", { exact: true }).scrollIntoViewIfNeeded();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await expect(page.getByLabel("Show Time Stripe Labels", { exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "Close Scale labels settings", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Close Scale labels settings", exact: true })).toBeInViewport();
    await page.screenshot({ path: `test-results/scale-components-${width}.png` });
  });
}
