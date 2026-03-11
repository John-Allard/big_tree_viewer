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

async function configureCircularDeepZoom(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowGenusLabels(false);
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    return state?.viewMode === "circular" && camera?.kind === "circular";
  });
  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
  });
  await page.waitForFunction(() => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    return camera?.kind === "circular";
  });
  await page.evaluate(async () => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const canvas = document.querySelector("canvas");
    if (!state || !camera || camera.kind !== "circular" || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Circular test setup unavailable.");
    }
    const radiusWorld = Number(state.isUltrametric ? state.rootAge : state.maxDepth);
    if (!(radiusWorld > 0)) {
      throw new Error("Invalid circular tree radius.");
    }
    const rect = canvas.getBoundingClientRect();
    const deepScale = Math.max(Number(camera.scale) * 220, 120);
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      scale: deepScale,
      translateX: 132 - (radiusWorld * deepScale),
      translateY: rect.height * 0.55,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function readCircularDebug(page: Page): Promise<{
  visibleLeafRanges: Array<[number, number]>;
  visibleTipLabelCount: number;
  tipVisible: boolean;
  microVisible: boolean;
}> {
  return page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    visibleLeafRanges: Array<[number, number]>;
    visibleTipLabelCount: number;
    tipVisible: boolean;
    microVisible: boolean;
  });
}

async function panCircularBy(page: Page, deltaY: number): Promise<void> {
  await page.evaluate(async (stepY) => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "circular") {
      throw new Error("Circular camera unavailable.");
    }
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      translateX: camera.translateX,
      translateY: Number(camera.translateY) + stepY,
      scale: camera.scale,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, deltaY);
}

function rangeLength(ranges: Array<[number, number]>): number {
  return ranges.reduce((total, [start, end]) => total + Math.max(0, end - start), 0);
}

function rangeOverlap(left: Array<[number, number]>, right: Array<[number, number]>): number {
  let overlap = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const [leftStart, leftEnd] = left[leftIndex];
    const [rightStart, rightEnd] = right[rightIndex];
    const start = Math.max(leftStart, rightStart);
    const end = Math.min(leftEnd, rightEnd);
    if (end > start) {
      overlap += end - start;
    }
    if (leftEnd < rightEnd) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return overlap;
}

test("circular deep-zoom pan keeps visible tip coverage continuous", async ({ page }) => {
  await waitForViewer(page);
  await configureCircularDeepZoom(page);

  let previousDebug = await readCircularDebug(page);
  expect(previousDebug.microVisible || previousDebug.tipVisible).toBeTruthy();
  expect(previousDebug.visibleLeafRanges.length).toBeGreaterThan(0);
  expect(previousDebug.visibleTipLabelCount).toBeGreaterThan(0);

  for (let step = 0; step < 12; step += 1) {
    await panCircularBy(page, 8);
    const currentDebug = await readCircularDebug(page);
    expect(currentDebug.visibleLeafRanges.length).toBeGreaterThan(0);
    expect(currentDebug.visibleTipLabelCount).toBeGreaterThan(0);

    const previousLength = rangeLength(previousDebug.visibleLeafRanges);
    const currentLength = rangeLength(currentDebug.visibleLeafRanges);
    const overlap = rangeOverlap(previousDebug.visibleLeafRanges, currentDebug.visibleLeafRanges);
    const minLength = Math.max(1, Math.min(previousLength, currentLength));
    expect(overlap / minLength).toBeGreaterThan(0.65);

    previousDebug = currentDebug;
  }
});

test("circular zoom clamps before the visible window drops below two tips", async ({ page }) => {
  await waitForViewer(page);
  await configureCircularDeepZoom(page);

  const initialScale = await page.evaluate(() => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "circular") {
      throw new Error("Circular camera unavailable.");
    }
    return Number(camera.scale);
  });

  await page.evaluate(async () => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "circular") {
      throw new Error("Circular camera unavailable.");
    }
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      scale: camera.scale * 40,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const clamped = await page.evaluate(() => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
      visibleLeafRanges: Array<[number, number]>;
    } | undefined;
    if (!camera || camera.kind !== "circular" || !debug) {
      throw new Error("Circular render debug unavailable.");
    }
    const visibleTipEstimate = (debug.visibleLeafRanges ?? []).reduce(
      (total, [start, end]) => total + Math.max(0, end - start),
      0,
    );
    return {
      scale: Number(camera.scale),
      visibleTipEstimate,
    };
  });

  expect(clamped.scale).toBeLessThan(initialScale * 40);
  expect(clamped.visibleTipEstimate).toBeGreaterThanOrEqual(2);
});

test("rectangular fit switches to circular fit without partial zoom", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const switchedCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as {
    kind: "circular";
    scale: number;
    translateX: number;
    translateY: number;
  } | null);

  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const fitCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as {
    kind: "circular";
    scale: number;
    translateX: number;
    translateY: number;
  } | null);

  expect(switchedCamera?.kind).toBe("circular");
  expect(fitCamera?.kind).toBe("circular");
  expect(Math.abs(Number(switchedCamera?.scale ?? 0) - Number(fitCamera?.scale ?? 0))).toBeLessThanOrEqual(Number(fitCamera?.scale ?? 0) * 0.03);
  expect(Math.abs(Number(switchedCamera?.translateX ?? 0) - Number(fitCamera?.translateX ?? 0))).toBeLessThanOrEqual(6);
  expect(Math.abs(Number(switchedCamera?.translateY ?? 0) - Number(fitCamera?.translateY ?? 0))).toBeLessThanOrEqual(6);
});

test("circular taxonomy fit-view branch render stays cached-fast", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMockTaxonomy();
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const timing = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.timing as {
    branchBaseMs?: number;
    totalMs?: number;
  } | null);

  expect(Number(timing?.branchBaseMs ?? 999)).toBeLessThan(8);
  expect(Number(timing?.totalMs ?? 999)).toBeLessThan(24);
});
