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

async function enableMockTaxonomy(page: Page): Promise<void> {
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMockTaxonomy();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount ?? 0) > 0;
  });
}

test("rectangular taxonomy columns render when taxonomy is enabled", async ({ page }) => {
  await waitForViewer(page);
  await enableMockTaxonomy(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const rectDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
    taxonomyVisibleRanks?: string[];
    genusBandX?: number | null;
    tipSideX?: number;
  });

  expect((rectDebug.taxonomyVisibleRanks ?? []).length).toBeGreaterThan(0);
  expect(Number(rectDebug.genusBandX ?? 0)).toBeGreaterThan(Number(rectDebug.tipSideX ?? 0) + 10);
});

test("circular taxonomy rings stay outside the tip-label band", async ({ page }) => {
  await waitForViewer(page);
  await enableMockTaxonomy(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.evaluate(async () => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const canvas = document.querySelector("canvas");
    if (!state || !camera || camera.kind !== "circular" || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Circular taxonomy test setup unavailable.");
    }
    const radiusWorld = Number(state.isUltrametric ? state.rootAge : state.maxDepth);
    const rect = canvas.getBoundingClientRect();
    const scale = Math.max(Number(camera.scale) * 55, 42);
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      scale,
      translateX: (rect.width * 0.34) - (radiusWorld * scale),
      translateY: rect.height * 0.54,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const circularDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    tipVisible: boolean;
    microVisible: boolean;
    taxonomyVisibleRanks?: string[];
    taxonomyTipBandOuterRadiusPx?: number | null;
    taxonomyFirstRingInnerRadiusPx?: number | null;
  });

  expect(circularDebug.tipVisible || circularDebug.microVisible).toBeTruthy();
  expect((circularDebug.taxonomyVisibleRanks ?? []).length).toBeGreaterThan(0);
  expect(Number(circularDebug.taxonomyFirstRingInnerRadiusPx ?? 0)).toBeGreaterThan(
    Number(circularDebug.taxonomyTipBandOuterRadiusPx ?? 0) + 6,
  );
});
