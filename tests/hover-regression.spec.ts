import { expect, test, type Page } from "@playwright/test";

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__
    && window.__BIG_TREE_VIEWER_RENDER_DEBUG__,
  ));
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function configureDenseRectFitView(page: Page): Promise<{
  sampleX: number;
  viewportX: number;
  viewportTopY: number;
  viewportBottomY: number;
  hoverViewportY: number;
  results: Array<Record<string, unknown> | null>;
}> {
  return page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const canvasTest = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const canvas = document.querySelector("[data-testid=tree-canvas]") as HTMLCanvasElement | null;
    if (!app || !canvasTest || !canvas) {
      throw new Error("Viewer test hooks unavailable.");
    }

    app.setViewMode("rectangular");
    app.clearTaxonomy();
    app.setShowGenusLabels(false);
    app.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const state = app.getState() as {
      isUltrametric?: boolean;
      rootAge?: number | null;
      maxDepth?: number | null;
    };
    const camera = canvasTest.getCamera() as {
      kind?: string;
      scaleX?: number;
      translateX?: number;
    } | null;
    if (!camera || camera.kind !== "rectangular" && camera.kind !== "rect") {
      throw new Error("Rectangular camera unavailable.");
    }
    const tipDepth = state.isUltrametric ? Number(state.rootAge ?? 0) : Number(state.maxDepth ?? 0);
    const tipScreenX = Number(camera.translateX ?? 0) + (tipDepth * Number(camera.scaleX ?? 0));
    const rect = canvas.getBoundingClientRect();
    const sampleX = Math.min(rect.width - 6, Math.max(6, tipScreenX - 6));
    const step = Math.max(6, Math.floor((rect.height - 24) / 48));
    const results: Array<Record<string, unknown> | null> = [];
    let hoverViewportY: number | null = null;
    for (let y = 12; y <= rect.height - 12; y += step) {
      const hit = canvasTest.probeHoverForTest(sampleX, y);
      if (hoverViewportY === null && hit && hit.targetKind !== "label") {
        hoverViewportY = rect.top + y;
      }
      results.push(hit);
    }
    return {
      sampleX,
      viewportX: rect.left + sampleX,
      viewportTopY: rect.top + 12,
      viewportBottomY: rect.top + rect.height - 12,
      hoverViewportY: hoverViewportY ?? (rect.top + 12),
      results,
    };
  });
}

test("dense rectangular fit-view keeps fast tip hover near the tip wall", async ({ page }) => {
  await waitForViewer(page);

  const samples = await configureDenseRectFitView(page);

  const branchHits = samples.results.filter((hit) => hit && hit.targetKind !== "label");
  expect(branchHits.length).toBeGreaterThan(8);
  expect(branchHits.every((hit) => hit?.targetKind === "stem")).toBeTruthy();
});

test("dense rectangular fit-view hover does not redraw the whole scene", async ({ page }) => {
  await waitForViewer(page);
  const target = await configureDenseRectFitView(page);
  await settleFrames(page);

  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.startPanBenchmark("hover-fit-view");
  });
  await page.mouse.move(target.viewportX, target.viewportTopY);
  await page.mouse.move(target.viewportX, target.viewportBottomY, { steps: 120 });
  await page.waitForTimeout(80);

  const summary = await page.evaluate(() => ({
    benchmark: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.stopPanBenchmark?.() as {
      scheduledFrameCount?: number;
      frameCount?: number;
    } | null,
  }));

  await page.mouse.move(target.viewportX, target.hoverViewportY);
  await page.waitForTimeout(40);
  const tooltip = await page.evaluate(() => ({
    tooltipHidden: (document.querySelector(".hover-tooltip") as HTMLDivElement | null)?.hidden ?? true,
    tooltipLabel: document.querySelector(".hover-tooltip-label")?.textContent ?? "",
  }));

  expect(summary.benchmark).not.toBeNull();
  expect(Number(summary.benchmark?.scheduledFrameCount ?? Number.POSITIVE_INFINITY)).toBe(0);
  expect(Number(summary.benchmark?.frameCount ?? Number.POSITIVE_INFINITY)).toBe(0);
  expect(tooltip.tooltipHidden).toBeFalsy();
  expect(tooltip.tooltipLabel.length).toBeGreaterThan(0);
});
