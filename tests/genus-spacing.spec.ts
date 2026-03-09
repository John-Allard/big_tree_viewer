import { expect, test, type Page } from "@playwright/test";

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => {
    return Boolean(
      window.__BIG_TREE_VIEWER_APP_TEST__
      && window.__BIG_TREE_VIEWER_CANVAS_TEST__
      && window.__BIG_TREE_VIEWER_RENDER_DEBUG__
      && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded,
    );
  });
}

async function configureRectangularView(page: Page): Promise<void> {
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowGenusLabels(true);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function readRectDebug(page: Page): Promise<{
  cueVisible: boolean;
  microVisible: boolean;
  tipVisible: boolean;
  tipBandFontSize: number;
  tipBandWidthPx: number;
  tipSideX: number;
  genusGapPx: number | null;
  genusBandX: number | null;
  genusBandOffsetPx: number | null;
  connectorXs: number[];
}> {
  return page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
    cueVisible: boolean;
    microVisible: boolean;
    tipVisible: boolean;
    tipBandFontSize: number;
    tipBandWidthPx: number;
    tipSideX: number;
    genusGapPx: number | null;
    genusBandX: number | null;
    genusBandOffsetPx: number | null;
    connectorXs: number[];
  });
}

async function setRectScaleY(page: Page, scaleY: number): Promise<void> {
  await page.evaluate(async (nextScaleY) => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "rect") {
      throw new Error("Rectangular camera unavailable.");
    }
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setRectCamera({
      scaleX: camera.scaleX,
      scaleY: nextScaleY,
      translateX: camera.translateX,
      translateY: camera.translateY,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, scaleY);
}

test("rectangular genus band remains smooth and monotonic", async ({ page }) => {
  await waitForViewer(page);
  await configureRectangularView(page);

  const earlyScales = [1.7, 1.8, 1.9];
  const earlyOffsets: number[] = [];
  for (const scaleY of earlyScales) {
    await setRectScaleY(page, scaleY);
    const debug = await readRectDebug(page);
    expect(debug.connectorXs.length).toBeGreaterThan(0);
    earlyOffsets.push(debug.genusBandOffsetPx ?? -1);
  }
  expect(earlyOffsets[0]).toBeLessThan(14);
  expect(earlyOffsets[2]).toBeLessThan(20);

  const zoomScales = Array.from({ length: 28 }, (_, index) => Number((2.1 + (index * 0.1)).toFixed(1)));
  const zoomOffsets: number[] = [];
  for (const scaleY of zoomScales) {
    await setRectScaleY(page, scaleY);
    const debug = await readRectDebug(page);
    zoomOffsets.push(debug.genusBandOffsetPx ?? -1);
    for (const connectorX of debug.connectorXs) {
      expect(Math.abs(connectorX - (debug.genusBandX ?? connectorX))).toBeLessThan(0.01);
    }
  }

  for (let index = 1; index < zoomOffsets.length; index += 1) {
    expect(zoomOffsets[index]).toBeGreaterThanOrEqual(zoomOffsets[index - 1] - 0.2);
    expect(zoomOffsets[index] - zoomOffsets[index - 1]).toBeLessThan(13);
  }
});
