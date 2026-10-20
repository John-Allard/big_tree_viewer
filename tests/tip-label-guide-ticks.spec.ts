import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { parseSharedSubtreeStoragePayload } from "../src/lib/sharedSubtreePayload";

const newick = `(${Array.from({ length: 256 }, (_, index) => `Species_${index}:1`).join(",")})Root;`;

for (const view of ["circular", "fan"] as const) {
  test(`${view} guide ticks can be hidden on canvas and SVG without hiding tip names`, async ({ page }) => {
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=${view}&btv_genus_labels=false&btv_scale_bars=false`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: /Visual Options/ }).click();
    await page.evaluate(view => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const count = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.leafNodes.length;
      api.setCircularCamera({ scale: 2 * (view === "fan" ? count - 1 : count) / (view === "fan" ? Math.PI : 2 * Math.PI) });
    }, view);
    const read = () => page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const doc = new DOMParser().parseFromString(api.buildCurrentSvgForTest()!, "image/svg+xml");
      const cues = [...doc.querySelectorAll('line[stroke="rgba(15,23,42,0.42)"]')];
      const point = cues[0];
      const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=tree-canvas]")!;
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const x = point ? (Number(point.getAttribute("x1")) + Number(point.getAttribute("x2"))) / 2 : 0;
      const y = point ? (Number(point.getAttribute("y1")) + Number(point.getAttribute("y2"))) / 2 : 0;
      return { count: cues.length, point: { x, y, dpr }, labels: [...doc.querySelectorAll("text")].filter(text => text.textContent?.startsWith("Species")).length };
    });
    await expect.poll(async () => (await read()).count).toBeGreaterThan(100);
    const before = await read();
    const sample = () => page.evaluate(({ x, y, dpr }) => {
      const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=tree-canvas]")!;
      return [...canvas.getContext("2d")!.getImageData(Math.round(x * dpr) - 2, Math.round(y * dpr) - 2, 5, 5).data];
    }, before.point);
    const beforePixels = await sample();
    await page.getByRole("button", { name: "Tip labels settings", exact: true }).click();
    const toggle = page.getByLabel("Disable tip label tick marks", { exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect.poll(async () => (await read()).count).toBe(0);
    expect(await sample()).not.toEqual(beforePixels);
    const shared = await page.evaluate(() => {
      const root = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.parent!.findIndex(parent => parent < 0);
      return window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildSharedSubtreePayloadForTest(root);
    });
    expect(shared?.visual?.figureStyles.tip.showGuideTicks).toBe(false);
    await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const camera = api.getCamera()!;
      if (camera.kind === "circular") api.setCircularCamera({ scale: camera.scale * 3 });
    });
    await expect.poll(async () => (await read()).labels).toBeGreaterThan(0);
    expect((await read()).count).toBe(0);
  });
}

test("guide-tick preference survives session loading and resets to on", async ({ page }) => {
  await page.goto(`/?btv_newick=${encodeURIComponent(newick)}`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
  await page.getByRole("button", { name: /Visual Options/ }).click();
  await page.getByRole("button", { name: "Tip labels settings", exact: true }).click();
  await page.getByLabel("Disable tip label tick marks", { exact: true }).check();
  await page.getByRole("button", { name: "Close Tip labels settings", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  const file = (await (await download).path())!;
  const bytes = await readFile(file);
  const session = JSON.parse((bytes[0] === 0x1f ? gunzipSync(bytes) : bytes).toString("utf8"));
  expect(session.settings.figureStyles.tip.showGuideTicks).toBe(false);
  await page.getByRole("button", { name: "Reset Defaults", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load Session", exact: true }).click();
  await (await chooser).setFiles(file);
  await page.getByRole("button", { name: "Tip labels settings", exact: true }).click();
  await expect(page.getByLabel("Disable tip label tick marks", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Close Tip labels settings", exact: true }).click();
  await page.getByRole("button", { name: "Reset Defaults", exact: true }).click();
  await page.getByRole("button", { name: "Tip labels settings", exact: true }).click();
  await expect(page.getByLabel("Disable tip label tick marks", { exact: true })).not.toBeChecked();
});

test("older shared views default guide ticks to on and explicit false is retained", () => {
  const parse = (tip: object) => parseSharedSubtreeStoragePayload(JSON.stringify({ newick, visual: { figureStyles: { tip } } })).visual!.figureStyles.tip;
  expect(parse({}).showGuideTicks).toBe(true);
  expect(parse({ showGuideTicks: false }).showGuideTicks).toBe(false);
});
