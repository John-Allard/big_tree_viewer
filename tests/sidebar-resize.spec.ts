import { expect, test } from "@playwright/test";

test("radial canvas cannot stretch its previous frame between layout and redraw", async ({ page }) => {
  await page.goto(`/?btv_newick=${encodeURIComponent("((A:1,B:1):1,(C:1,D:1):1)Root;")}&btv_view=circular`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()?.kind === "circular");
  await page.waitForTimeout(150);
  const result = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=tree-canvas]")!;
    const overlay = document.querySelector<HTMLCanvasElement>(".tree-canvas-overlay")!;
    const shell = document.querySelector<HTMLElement>(".tree-canvas-shell")!;
    const before = canvas.getBoundingClientRect();
    // Layout changes immediately; ResizeObserver cannot redraw until this task ends.
    shell.style.width = `${before.width + 80}px`;
    shell.style.height = `${before.height + 120}px`;
    const pendingCanvas = canvas.getBoundingClientRect();
    const pendingOverlay = overlay.getBoundingClientRect();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const after = canvas.getBoundingClientRect();
    return {
      before: { width: before.width, height: before.height },
      pending: { width: pendingCanvas.width, height: pendingCanvas.height },
      pendingOverlay: { width: pendingOverlay.width, height: pendingOverlay.height },
      after: { width: after.width, height: after.height },
    };
  });
  expect(result.pending).toEqual(result.before);
  expect(result.pendingOverlay).toEqual(result.before);
  expect(result.after.width).toBe(result.before.width + 80);
  expect(result.after.height).toBe(result.before.height + 120);
});

for (const native of [false, true]) {
  test(`radial fullscreen redraws retain proportional camera coverage (${native ? "native" : "fallback"})`, async ({ page }, testInfo) => {
    if (!native) await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: undefined });
    });
    await page.goto(`/?btv_newick=${encodeURIComponent("((A:1,B:1):1,(C:1,D:1):1)Root;")}&btv_view=circular`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()?.kind === "circular");
    await page.waitForTimeout(150);
    for (const name of ["Enter full screen", "Exit full screen"]) {
      const frames = await page.evaluate(async (buttonName) => {
        const sample = () => {
          const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=tree-canvas]")!;
          const bounds = canvas.getBoundingClientRect();
          const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera()!;
          const inset = window.__BIG_TREE_VIEWER_APP_TEST__!.getState().viewerLeftOcclusionPx;
          const width = Math.floor(bounds.width);
          const height = Math.floor(bounds.height);
          return {
            width, height, backingWidth: canvas.width,
            coverage: Number("scale" in camera ? camera.scale : 0) / Math.min(width - inset, height),
            centerX: camera.translateX, centerY: camera.translateY,
          };
        };
        const samples = [sample()];
        document.querySelector<HTMLButtonElement>(`button[aria-label="${buttonName}"]`)!.click();
        for (let i = 0; i < 16; i += 1) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          samples.push(sample());
        }
        return samples;
      }, name);
      await testInfo.attach(`${name}-frames`, { body: JSON.stringify(frames, null, 2), contentType: "application/json" });
      for (const frame of frames) {
        expect(frame.coverage).toBeCloseTo(frames[0].coverage, 8);
        expect(frame.backingWidth).toBe(Math.floor(frame.width * await page.evaluate(() => devicePixelRatio)));
      }
    }
  });
}

test("first panel close after reload does not stretch a stale canvas frame", async ({ page }) => {
  const newick = "((A:1,B:1):1,(C:1,D:1):1)Root;";
  await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=rectangular`);
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()));
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()));
  await page.waitForTimeout(150);
  const frames = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=tree-canvas]")!;
    const samples: Array<{ actual: number; expected: number; rootX: number }> = [];
    document.querySelector<HTMLButtonElement>('button[aria-label="Hide side panel"]')!.click();
    for (let i = 0; i < 8; i += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      // ResizeObserver runs after animation callbacks, before paint.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const bounds = canvas.getBoundingClientRect();
      const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera()!;
      samples.push({ actual: canvas.width, expected: Math.floor(bounds.width * devicePixelRatio),
        rootX: bounds.left + Number(camera.translateX) });
    }
    return samples;
  });
  for (const frame of frames) expect(frame.actual).toBe(frame.expected);
  expect(Math.max(...frames.map(f => f.rootX)) - Math.min(...frames.map(f => f.rootX))).toBeLessThan(1);
});

test("restored overlay panel is opaque and does not blur moving tree content", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Hide side panel", exact: true }).click();
  await page.getByRole("button", { name: "Show side panel", exact: true }).click();
  const style = await page.locator(".control-panel").evaluate(panel => {
    const computed = getComputedStyle(panel);
    return { background: computed.backgroundColor, blur: computed.backdropFilter };
  });
  expect(style.background).toBe("rgb(255, 255, 255)");
  expect(style.blur).toBe("none");
});

test("50k example follows drag input with the restored overlay panel open", async ({ page }, testInfo) => {
  await page.goto("/?btv_view=circular");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()?.kind === "circular",
  ));
  await page.getByRole("button", { name: "Hide side panel", exact: true }).click();
  await page.getByRole("button", { name: "Show side panel", exact: true }).click();
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera()!);
  const bounds = (await page.getByTestId("tree-canvas").boundingBox())!;
  const startX = bounds.x + bounds.width * 0.65;
  const startY = bounds.y + bounds.height * 0.5;
  await page.mouse.move(startX, startY);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.startPanBenchmark("overlay-panel-drag"));
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    await page.mouse.move(startX + i * 8, startY + i * 2);
    await page.waitForTimeout(20);
    const camera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera()!);
    expect(Number(camera.translateX) - Number(before.translateX)).toBeCloseTo(i * 8, 5);
    expect(Number(camera.translateY) - Number(before.translateY)).toBeCloseTo(i * 2, 5);
  }
  await page.mouse.up();
  await page.waitForTimeout(50);
  const timing = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.stopPanBenchmark());
  await testInfo.attach("overlay-pan-timing", { body: JSON.stringify(timing, null, 2), contentType: "application/json" });
});
