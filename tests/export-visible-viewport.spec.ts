import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";

const newick = "((Homo_sapiens:1,Homo_neanderthalensis:1):1,(Mus_musculus:1,Mus_spretus:1):1)Root;";

async function loadTree(page: Page, mode: string): Promise<void> {
  const input = mode === "spiral"
    ? `(${Array.from({ length: 1000 }, (_, i) => `Species_${i}:1`).join(",")})Root;`
    : newick;
  await page.route("**/export-tree.nwk", route => route.fulfill({ body: input, contentType: "text/plain" }));
  await page.goto(`/?btv_newick_url=/export-tree.nwk&btv_view=${mode}`);
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()));
}

for (const width of [1280, 390]) {
  test(`physical export width and DPI survive exports, closing, and geometry changes (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await loadTree(page, "rectangular");
    await page.getByRole("button", { name: "Export View", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export view settings" });
    await dialog.getByLabel("File name").fill("my-figure.png");
    await expect(dialog.getByLabel("Width (inches)")).toHaveValue("8");
    await expect(dialog.getByLabel("DPI", { exact: true })).toHaveValue("200");
    await dialog.getByLabel("Width (inches)").fill("3.5");
    await dialog.getByLabel("DPI", { exact: true }).fill("240");
    await expect(dialog.getByLabel("Width px")).toHaveValue("840");
    await dialog.getByLabel("Width px").fill("960");
    await expect(dialog.getByLabel("Width (inches)")).toHaveValue("4");
    await dialog.getByLabel("Width (inches)").fill("3.5");
    await expect(dialog.getByLabel("Height px", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Height: automatic", { exact: true })).toHaveCount(0);
    for (let i = 0; i < 2; i += 1) {
      const download = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Export", exact: true }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe("my-figure.png");
      const bytes = await readFile((await file.path())!);
      expect(bytes.readUInt32BE(16)).toBe(840);
      let resolutionCount = 0;
      for (let offset = 8; offset + 12 <= bytes.length; offset += bytes.readUInt32BE(offset) + 12) {
        const length = bytes.readUInt32BE(offset);
        if (bytes.toString("ascii", offset + 4, offset + 8) !== "pHYs") continue;
        resolutionCount += 1;
        expect(bytes.readUInt32BE(offset + 8) * 0.0254).toBeCloseTo(240, 1);
        expect(bytes.readUInt32BE(offset + 12)).toBe(bytes.readUInt32BE(offset + 8));
        expect(bytes[offset + 16]).toBe(1);
        expect(bytes.readUInt32BE(offset + length + 8)).toBe(crc32(bytes.subarray(offset + 4, offset + length + 8)));
      }
      expect(resolutionCount).toBe(1);
      await expect(dialog).toBeVisible();
    }
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Radial", exact: true }).click();
    await page.getByRole("button", { name: "Export View", exact: true }).click();
    await expect(dialog.getByLabel("File name")).toHaveValue("my-figure.png");
    await expect(dialog.getByLabel("Width px")).toHaveValue("840");
    await expect(dialog.getByLabel("Width (inches)")).toHaveValue("3.5");
    await expect(dialog.getByLabel("DPI", { exact: true })).toHaveValue("240");
    await dialog.getByRole("combobox", { name: "Format", exact: true }).selectOption("svg");
    await expect(dialog.getByLabel("Width px")).toHaveValue("840");
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const svgFile = await download;
    expect(svgFile.suggestedFilename()).toBe("my-figure.svg");
    expect(await readFile((await svgFile.path())!, "utf8")).toContain('width="3.5in"');
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Restore Defaults" }).click();
    await expect(dialog.getByRole("combobox", { name: "Format", exact: true })).toHaveValue("png");
    await expect(dialog.getByLabel("Width px")).toHaveValue("1600");
    await expect(dialog.getByLabel("Width (inches)")).toHaveValue("8");
    await expect(dialog.getByLabel("DPI", { exact: true })).toHaveValue("200");
    const overflows = await dialog.evaluate(element => [...element.querySelectorAll("input, button, select")].some(control => {
      const bounds = control.getBoundingClientRect();
      return bounds.left < 0 || bounds.right > innerWidth;
    }));
    expect(overflows).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("export-settings.png") });
  });
}

test("export size fields can be cleared, typed into, and committed without forced zeros", async ({ page }) => {
  await loadTree(page, "rectangular");
  await page.getByRole("button", { name: "Export View", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export view settings" });
  const inches = dialog.getByLabel("Width (inches)");
  const dpi = dialog.getByLabel("DPI", { exact: true });
  const pixels = dialog.getByLabel("Width px");
  await inches.fill("");
  await expect(inches).toHaveValue("");
  await inches.pressSequentially("10");
  await inches.press("Enter");
  await expect(inches).toHaveValue("10");
  await expect(pixels).toHaveValue("2000");
  await inches.fill("010");
  await inches.press("Enter");
  await expect(inches).toHaveValue("10");
  await inches.fill("");
  await inches.pressSequentially("6.5");
  await inches.press("Tab");
  await expect(inches).toHaveValue("6.5");
  await dpi.fill("");
  await expect(dpi).toHaveValue("");
  await dpi.pressSequentially("300");
  await dpi.press("Enter");
  await expect(pixels).toHaveValue("1950");
  await pixels.fill("");
  await expect(pixels).toHaveValue("");
  await pixels.pressSequentially("1800");
  await pixels.press("Enter");
  await expect(pixels).toHaveValue("1800");
  await expect(inches).toHaveValue("6");
  await expect(dialog.getByText("Height: automatic", { exact: true })).toHaveCount(0);
});

// The automation API retains explicit, current-view framing rather than the UI's whole-tree crop.
for (const mode of ["rectangular", "circular", "fan", "spiral", "short-window"]) {
  test(`${mode} current-view SVG crops the covered sidebar without changing the camera`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: mode === "short-window" ? 280 : 800 });
    await loadTree(page, mode === "short-window" ? "circular" : mode);
    for (const panel of ["normal", "overlay", "hidden"]) {
      if (panel === "overlay") {
        await page.getByRole("button", { name: "Hide side panel", exact: true }).click();
        await page.getByRole("button", { name: "Show side panel", exact: true }).click();
        await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().viewerLeftOcclusionPx > 0);
      } else if (panel === "hidden") {
        await page.getByRole("button", { name: "Hide side panel", exact: true }).click();
        await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().viewerLeftOcclusionPx === 0);
      }
      const source = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=tree-canvas]")!;
        const shell = document.querySelector<HTMLElement>(".tree-canvas-shell")!;
        return { width: Math.min(canvas.clientWidth, shell.clientWidth), height: Math.min(canvas.clientHeight, shell.clientHeight),
          inset: window.__BIG_TREE_VIEWER_APP_TEST__!.getState().viewerLeftOcclusionPx,
          camera: window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera() };
      });
      const svg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()!);
      expect(svg).toContain(`viewBox="${source.inset} 0 ${source.width - source.inset} ${source.height}"`);
      expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera())).toEqual(source.camera);
    }
  });
}
