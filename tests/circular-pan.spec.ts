import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => {
    return Boolean(
      window.__BIG_TREE_VIEWER_APP_TEST__
      && window.__BIG_TREE_VIEWER_CANVAS_TEST__
      && window.__BIG_TREE_VIEWER_RENDER_DEBUG__
      && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded
      && !window.__BIG_TREE_VIEWER_APP_TEST__.getState().loading,
    );
  });
  if (await page.getByRole("button", { name: "Export View" }).isDisabled()) {
    await page.getByRole("button", { name: "Load Example" }).click();
    await page.waitForFunction(() => {
      const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
      return Boolean(state?.treeLoaded && !state.loading && window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
    });
  }
}

async function loadTreeFile(page: Page, treePath: string): Promise<void> {
  await page.setInputFiles('input[type="file"]', treePath);
  await page.waitForFunction(() => {
    return Boolean(
      window.__BIG_TREE_VIEWER_APP_TEST__
      && window.__BIG_TREE_VIEWER_CANVAS_TEST__
      && window.__BIG_TREE_VIEWER_RENDER_DEBUG__
      && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded
      && !window.__BIG_TREE_VIEWER_APP_TEST__.getState().loading,
    );
  }, { timeout: 180000 });
}

async function loadPastedTree(page: Page, newick: string): Promise<void> {
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(newick);
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    return Boolean(
      window.__BIG_TREE_VIEWER_APP_TEST__
      && window.__BIG_TREE_VIEWER_CANVAS_TEST__
      && window.__BIG_TREE_VIEWER_RENDER_DEBUG__
      && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded
      && !window.__BIG_TREE_VIEWER_APP_TEST__.getState().loading,
    );
  });
}

async function readWorldPointAt(page: Page, x: number, y: number): Promise<{
  kind: "rect" | "circular";
  x: number;
  y: number;
  scale: number;
}> {
  return page.evaluate(({ localX, localY }) => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera) {
      throw new Error("Camera unavailable for keyboard zoom test.");
    }
    if (camera.kind === "rect") {
      return {
        kind: "rect" as const,
        x: (localX - Number(camera.translateX)) / Number(camera.scaleX),
        y: (localY - Number(camera.translateY)) / Number(camera.scaleY),
        scale: Number(camera.scaleX),
      };
    }
    const dx = (localX - Number(camera.translateX)) / Number(camera.scale);
    const dy = (localY - Number(camera.translateY)) / Number(camera.scale);
    return {
      kind: "circular" as const,
      x: (dx * Number(camera.rotationCos)) + (dy * Number(camera.rotationSin)),
      y: (-dx * Number(camera.rotationSin)) + (dy * Number(camera.rotationCos)),
      scale: Number(camera.scale),
    };
  }, { localX: x, localY: y });
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
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

test("circular zoom clamp stays bounded at extreme zoom", async ({ page }) => {
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

  expect(clamped.scale).toBeLessThanOrEqual(initialScale * 40);
  expect(Number.isFinite(clamped.visibleTipEstimate)).toBeTruthy();
  expect(clamped.visibleTipEstimate).toBeGreaterThanOrEqual(0);
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

test("circular fit switches to spiral fit without collapsing to the center", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("spiral");
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
  expect(Number(switchedCamera?.scale ?? 0)).toBeGreaterThan(0);
  expect(Math.abs(Number(switchedCamera?.scale ?? 0) - Number(fitCamera?.scale ?? 0))).toBeLessThanOrEqual(Number(fitCamera?.scale ?? 0) * 0.03);
  expect(Math.abs(Number(switchedCamera?.translateX ?? 0) - Number(fitCamera?.translateX ?? 0))).toBeLessThanOrEqual(6);
  expect(Math.abs(Number(switchedCamera?.translateY ?? 0) - Number(fitCamera?.translateY ?? 0))).toBeLessThanOrEqual(6);
});

test("a slightly panned spiral fit remains a fit view across geometry switches", async ({ page }) => {
  await waitForViewer(page);
  const results = await page.evaluate(async () => {
    const destinations = ["circular", "fan", "rectangular"] as const;
    const comparisons: Array<{
      mode: "circular" | "fan" | "rectangular";
      switched: Record<string, unknown>;
      fit: Record<string, unknown>;
    }> = [];
    for (const mode of destinations) {
      window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("spiral");
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const spiralFit = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
      if (!spiralFit || spiralFit.kind !== "circular") {
        throw new Error("Spiral fit camera unavailable for panned transition test.");
      }
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
        translateX: Number(spiralFit.translateX) + 18,
        translateY: Number(spiralFit.translateY) - 12,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode(mode);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const switched = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
      if (!switched) {
        throw new Error(`Switched ${mode} camera unavailable.`);
      }
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const fit = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
      if (!fit) {
        throw new Error(`Fit ${mode} camera unavailable.`);
      }
      comparisons.push({ mode, switched, fit });
    }
    return comparisons;
  });

  for (const result of results) {
    if (result.mode === "rectangular") {
      expect(result.switched.kind).toBe("rect");
      expect(result.fit.kind).toBe("rect");
      expect(Number(result.switched.scaleX)).toBeCloseTo(Number(result.fit.scaleX), 6);
      expect(Number(result.switched.scaleY)).toBeCloseTo(Number(result.fit.scaleY), 6);
      expect(Math.abs(Number(result.switched.translateX) - Number(result.fit.translateX))).toBeLessThanOrEqual(1);
      expect(Math.abs(Number(result.switched.translateY) - Number(result.fit.translateY))).toBeLessThanOrEqual(1);
      continue;
    }
    expect(result.switched.kind).toBe("circular");
    expect(result.fit.kind).toBe("circular");
    expect(Number(result.switched.scale)).toBeCloseTo(Number(result.fit.scale), 6);
    expect(Math.abs(Number(result.switched.translateX) - Number(result.fit.translateX))).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(result.switched.translateY) - Number(result.fit.translateY))).toBeLessThanOrEqual(1);
  }
});

test("a fully visible spiral above the near-fit threshold switches to radial fit", async ({ page }) => {
  await waitForViewer(page);
  const result = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("spiral");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const spiralFit = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!spiralFit || spiralFit.kind !== "circular") {
      throw new Error("Spiral fit camera unavailable for visible-tree transition test.");
    }
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      scale: Number(spiralFit.scale) * 1.04,
      translateX: Number(spiralFit.translateX) + 4,
      translateY: Number(spiralFit.translateY) - 3,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const switched = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const fit = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    return { switched, fit };
  });

  expect(result.switched?.kind).toBe("circular");
  expect(result.fit?.kind).toBe("circular");
  expect(Number(result.switched?.scale)).toBeCloseTo(Number(result.fit?.scale), 6);
  expect(Math.abs(Number(result.switched?.translateX) - Number(result.fit?.translateX))).toBeLessThanOrEqual(1);
  expect(Math.abs(Number(result.switched?.translateY) - Number(result.fit?.translateY))).toBeLessThanOrEqual(1);
});

test("an ambiguous partially zoomed spiral switches other geometries to fit view", async ({ page }) => {
  await waitForViewer(page);
  const results = await page.evaluate(async () => {
    const destinations = ["circular", "rectangular"] as const;
    const comparisons: Array<{
      mode: "circular" | "rectangular";
      switched: Record<string, unknown>;
      fit: Record<string, unknown>;
    }> = [];
    for (const mode of destinations) {
      window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("spiral");
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const spiralFit = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
      if (!spiralFit || spiralFit.kind !== "circular") {
        throw new Error("Spiral fit camera unavailable for ambiguous transition test.");
      }
      const canvas = document.querySelector("canvas");
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("Canvas unavailable for ambiguous transition test.");
      }
      const rect = canvas.getBoundingClientRect();
      const sourceFocusX = rect.width * 0.72;
      const sourceFocusY = rect.height * 0.28;
      const zoomedScale = Number(spiralFit.scale) * 2.2;
      const focusWorldX = (sourceFocusX - Number(spiralFit.translateX)) / Number(spiralFit.scale);
      const focusWorldY = (sourceFocusY - Number(spiralFit.translateY)) / Number(spiralFit.scale);
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
        scale: zoomedScale,
        translateX: (rect.width * 0.5) - (focusWorldX * zoomedScale),
        translateY: (rect.height * 0.5) - (focusWorldY * zoomedScale),
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode(mode);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const switched = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const fit = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
      if (!switched || !fit) {
        throw new Error(`Camera unavailable for ambiguous ${mode} transition test.`);
      }
      comparisons.push({ mode, switched, fit });
    }
    return comparisons;
  });

  for (const result of results) {
    expect(result.switched.kind).toBe(result.fit.kind);
    if (result.mode === "rectangular") {
      expect(Number(result.switched.scaleX)).toBeCloseTo(Number(result.fit.scaleX), 6);
      expect(Number(result.switched.scaleY)).toBeCloseTo(Number(result.fit.scaleY), 6);
    } else {
      expect(Number(result.switched.scale)).toBeCloseTo(Number(result.fit.scale), 6);
    }
    expect(Number(result.switched.translateX)).toBeCloseTo(Number(result.fit.translateX), 6);
    expect(Number(result.switched.translateY)).toBeCloseTo(Number(result.fit.translateY), 6);
  }
});

test("a close view of one spiral turn stays local when switching to rectangular", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("spiral"));
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === "spiral");
  const result = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const spiralFit = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const canvas = document.querySelector("canvas");
    if (!spiralFit || spiralFit.kind !== "circular" || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Spiral camera unavailable for local-turn transition test.");
    }
    const rect = canvas.getBoundingClientRect();
    const sourceFocusX = rect.width * 0.78;
    const sourceFocusY = rect.height * 0.5;
    const zoomedScale = Number(spiralFit.scale) * 6;
    const focusWorldX = (sourceFocusX - Number(spiralFit.translateX)) / Number(spiralFit.scale);
    const focusWorldY = (sourceFocusY - Number(spiralFit.translateY)) / Number(spiralFit.scale);
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      scale: zoomedScale,
      translateX: (rect.width * 0.5) - (focusWorldX * zoomedScale),
      translateY: (rect.height * 0.5) - (focusWorldY * zoomedScale),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const switched = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const fit = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    return { switched, fit };
  });

  expect(result.switched?.kind).toBe("rect");
  expect(result.fit?.kind).toBe("rect");
  expect(Number(result.switched?.scaleY ?? 0)).toBeGreaterThan(Number(result.fit?.scaleY ?? 0) * 2);
  expect(Math.abs(Number(result.switched?.translateY ?? 0) - Number(result.fit?.translateY ?? 0))).toBeGreaterThan(20);
});

test("the 50k example refreshes a sharp circular bitmap as it zooms", async ({ page }) => {
  await waitForViewer(page);
  await page.getByRole("button", { name: "Load Example" }).click();
  await page.waitForFunction(() => (
    Number(window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes.length ?? 0) > 40_000
    && Number(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount ?? 0) > 40_000
    && !Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().loading)
  ));
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const canvas = page.getByTestId("tree-canvas");
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error("Canvas unavailable for moderate-tree bitmap refresh test.");
  }
  await page.mouse.move(bounds.x + (bounds.width * 0.5), bounds.y + (bounds.height * 0.5));
  for (let index = 0; index < 5; index += 1) {
    await page.mouse.wheel(0, -100);
    await settleFrames(page);
  }
  const renderMode = await page.evaluate(() => (
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.circular as Record<string, unknown> | undefined
  )?.branchRenderMode);

  expect(renderMode).toBe("taxonomy-cached-bitmap");
});

test("a fitted circular taxonomy bitmap covers every legal pan position", async ({ page }) => {
  await waitForViewer(page);
  await page.getByRole("button", { name: "Load Example" }).click();
  await page.waitForFunction(() => (
    Number(window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes.length ?? 0) > 40_000
    && Number(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount ?? 0) > 40_000
    && !Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().loading)
  ));
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      translateX: Number.POSITIVE_INFINITY,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const renderMode = await page.evaluate(() => (
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.circular as Record<string, unknown> | undefined
  )?.branchRenderMode);

  expect(renderMode).toBe("taxonomy-cached-bitmap");
});

test("rectangular vertical wheel input zooms instead of scrolling or panning", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const before = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as {
    kind: "rect";
    scaleX: number;
    scaleY: number;
    translateX: number;
    translateY: number;
  } | null);

  await page.evaluate(async () => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Canvas unavailable for wheel pan test.");
    }
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent("wheel", {
      deltaX: 0,
      deltaY: 36,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: rect.left + (rect.width * 0.5),
      clientY: rect.top + (rect.height * 0.5),
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const after = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as {
    kind: "rect";
    scaleX: number;
    scaleY: number;
    translateX: number;
    translateY: number;
  } | null);

  expect(before?.kind).toBe("rect");
  expect(after?.kind).toBe("rect");
  expect(Number(after?.scaleX ?? 0)).toBeLessThan(Number(before?.scaleX ?? 0));
  expect(Number(after?.scaleY ?? 0)).toBeLessThan(Number(before?.scaleY ?? 0));
});

test("small pixel wheel deltas from trackpads zoom with usable sensitivity", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const before = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as {
    kind: "rect";
    scaleX: number;
    scaleY: number;
  } | null);

  await page.evaluate(async () => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Canvas unavailable for trackpad wheel test.");
    }
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent("wheel", {
      deltaX: 0,
      deltaY: -4,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: rect.left + (rect.width * 0.5),
      clientY: rect.top + (rect.height * 0.5),
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const after = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as {
    kind: "rect";
    scaleX: number;
    scaleY: number;
  } | null);

  expect(before?.kind).toBe("rect");
  expect(after?.kind).toBe("rect");
  expect(Number(after?.scaleX ?? 0) / Number(before?.scaleX ?? 1)).toBeGreaterThan(1.025);
  expect(Number(after?.scaleY ?? 0) / Number(before?.scaleY ?? 1)).toBeGreaterThan(1.025);
});

test("Mac pinch wheel input lifts tiny deltas without making larger deltas jump", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const zoomRatioForDelta = async (deltaY: number): Promise<number> => page.evaluate(async (delta) => {
    const canvasApi = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const canvas = document.querySelector("canvas");
    if (!canvasApi || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Canvas unavailable for Mac pinch wheel test.");
    }
    canvasApi.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const before = canvasApi.getCamera();
    if (!before || before.kind !== "rect") {
      throw new Error("Rectangular camera unavailable for Mac pinch wheel test.");
    }
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent("wheel", {
      deltaX: 0,
      deltaY: delta,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ctrlKey: true,
      clientX: rect.left + (rect.width * 0.5),
      clientY: rect.top + (rect.height * 0.5),
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const after = canvasApi.getCamera();
    if (!after || after.kind !== "rect") {
      throw new Error("Updated rectangular camera unavailable for Mac pinch wheel test.");
    }
    return Number(after.scaleX) / Number(before.scaleX);
  }, deltaY);

  const tinyPinchRatio = await zoomRatioForDelta(-1);
  const largerPinchRatio = await zoomRatioForDelta(-20);
  expect(tinyPinchRatio).toBeGreaterThan(1.009);
  expect(tinyPinchRatio).toBeLessThan(1.03);
  expect(largerPinchRatio).toBeGreaterThan(1.12);
  expect(largerPinchRatio).toBeLessThan(1.2);
});

test("native Mac gesture pinch has a responsive but bounded scale", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const ratio = await page.evaluate(async () => {
    const canvasApi = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const canvas = document.querySelector("canvas");
    const before = canvasApi?.getCamera();
    if (!canvasApi || !(canvas instanceof HTMLCanvasElement) || !before || before.kind !== "rect") {
      throw new Error("Canvas unavailable for native Mac gesture test.");
    }
    const rect = canvas.getBoundingClientRect();
    const gestureEvent = (type: string, scale: number): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
        scale?: number;
        clientX?: number;
        clientY?: number;
      };
      Object.defineProperties(event, {
        scale: { value: scale },
        clientX: { value: rect.left + (rect.width * 0.5) },
        clientY: { value: rect.top + (rect.height * 0.5) },
      });
      return event;
    };
    canvas.dispatchEvent(gestureEvent("gesturestart", 1));
    canvas.dispatchEvent(gestureEvent("gesturechange", 1.01));
    canvas.dispatchEvent(gestureEvent("gestureend", 1.01));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const after = canvasApi.getCamera();
    if (!after || after.kind !== "rect") {
      throw new Error("Updated camera unavailable for native Mac gesture test.");
    }
    return Number(after.scaleX) / Number(before.scaleX);
  });

  expect(ratio).toBeGreaterThan(1.018);
  expect(ratio).toBeLessThan(1.03);
});

for (const mode of ["rectangular", "circular"] as const) {
  test(`${mode} keyboard zoom keeps the world point under the mouse fixed`, async ({ page }) => {
    await waitForViewer(page);
    await page.evaluate(async (nextMode) => {
      window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode(nextMode);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, mode);

    const canvas = page.getByTestId("tree-canvas");
    const bounds = await canvas.boundingBox();
    if (!bounds) {
      throw new Error("Canvas bounds unavailable for keyboard zoom test.");
    }
    const localX = bounds.width * 0.64;
    const localY = bounds.height * 0.41;
    await page.mouse.move(bounds.x + localX, bounds.y + localY);

    const before = await readWorldPointAt(page, localX, localY);
    await page.keyboard.press("Shift+Equal");
    await settleFrames(page);
    const afterZoomIn = await readWorldPointAt(page, localX, localY);
    expect(afterZoomIn.kind).toBe(before.kind);
    expect(afterZoomIn.scale).toBeGreaterThan(before.scale);
    expect(Math.abs(afterZoomIn.x - before.x)).toBeLessThan(0.001);
    expect(Math.abs(afterZoomIn.y - before.y)).toBeLessThan(0.001);

    await page.keyboard.press("-");
    await settleFrames(page);
    const afterZoomOut = await readWorldPointAt(page, localX, localY);
    expect(Math.abs(afterZoomOut.x - before.x)).toBeLessThan(0.001);
    expect(Math.abs(afterZoomOut.y - before.y)).toBeLessThan(0.001);
  });
}

test("rectangular gesturechange input zooms the camera", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const before = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as {
    kind: "rect";
    scaleX: number;
    scaleY: number;
  } | null);

  await page.evaluate(async () => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Canvas unavailable for gesture zoom test.");
    }
    const rect = canvas.getBoundingClientRect();
    const defineGestureProps = (event: Event, scale: number): void => {
      Object.defineProperty(event, "scale", { value: scale });
      Object.defineProperty(event, "clientX", { value: rect.left + (rect.width * 0.5) });
      Object.defineProperty(event, "clientY", { value: rect.top + (rect.height * 0.5) });
    };
    const start = new Event("gesturestart", { bubbles: true, cancelable: true });
    defineGestureProps(start, 1);
    canvas.dispatchEvent(start);
    const change = new Event("gesturechange", { bubbles: true, cancelable: true });
    defineGestureProps(change, 1.2);
    canvas.dispatchEvent(change);
    const end = new Event("gestureend", { bubbles: true, cancelable: true });
    defineGestureProps(end, 1.2);
    canvas.dispatchEvent(end);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const after = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as {
    kind: "rect";
    scaleX: number;
    scaleY: number;
  } | null);

  expect(before?.kind).toBe("rect");
  expect(after?.kind).toBe("rect");
  expect(Number(after?.scaleX ?? 0)).toBeGreaterThan(Number(before?.scaleX ?? 0));
  expect(Number(after?.scaleY ?? 0)).toBeGreaterThan(Number(before?.scaleY ?? 0));
});

test("circular subtree zoom switches to rectangular subtree framing", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  await page.evaluate(async () => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    if (!internal?.leafNodes || !internal.parent || !internal.firstChild || !internal.nextSibling) {
      throw new Error("Internal tree data unavailable.");
    }
    const leafSet = new Set<number>(internal.leafNodes);
    const descendantLeafCounts = new Array<number>(internal.parent.length).fill(0);
    for (let node = internal.parent.length - 1; node >= 0; node -= 1) {
      let count = leafSet.has(node) ? 1 : 0;
      for (let child = internal.firstChild[node]; child >= 0; child = internal.nextSibling[child]) {
        count += descendantLeafCounts[child];
      }
      descendantLeafCounts[node] = count;
    }
    const targetNode = descendantLeafCounts.findIndex((count, node) => internal.parent![node] >= 0 && internal.firstChild![node] >= 0 && count >= 6);
    if (targetNode < 0) {
      throw new Error("No internal subtree target available.");
    }
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.zoomToSubtreeTarget?.(targetNode);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    return state?.viewMode === "rectangular" && camera?.kind === "rect";
  });

  const result = await page.evaluate(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as {
      kind: "rect";
      scaleY: number;
      scaleX: number;
    } | null;
    return {
      viewMode: state?.viewMode,
      cameraKind: camera?.kind,
      scaleY: Number(camera?.scaleY ?? 0),
      scaleX: Number(camera?.scaleX ?? 0),
    };
  });

  expect(result.viewMode).toBe("rectangular");
  expect(result.cameraKind).toBe("rect");
  expect(result.scaleY).toBeGreaterThan(0);
  expect(result.scaleX).toBeGreaterThan(0);
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

test("mobile circular fit leaves room for taxonomy overlays", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForViewer(page);

  const snapshot = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowTipLabels(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMockTaxonomy();
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const debug = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.circular as {
      taxonomyArcDebug?: Array<{ outerRadiusPx?: number | null }>;
      taxonomyVisibleRanks?: string[];
    } | undefined;
    if (!camera || camera.kind !== "circular" || !debug) {
      throw new Error("Mobile circular fit debug unavailable.");
    }
    const outerRadiusPx = Math.max(
      0,
      ...(debug.taxonomyArcDebug ?? []).map((arc) => Number(arc.outerRadiusPx ?? 0)),
    );
    return {
      camera,
      outerRadiusPx,
      visibleRanks: debug.taxonomyVisibleRanks ?? [],
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });

  expect(snapshot.visibleRanks.length).toBeGreaterThan(0);
  expect(snapshot.outerRadiusPx).toBeGreaterThan(0);
  expect(snapshot.camera.translateX - snapshot.outerRadiusPx).toBeGreaterThanOrEqual(-2);
  expect(snapshot.camera.translateX + snapshot.outerRadiusPx).toBeLessThanOrEqual(snapshot.width + 2);
  expect(snapshot.camera.translateY - snapshot.outerRadiusPx).toBeGreaterThanOrEqual(-2);
  expect(snapshot.camera.translateY + snapshot.outerRadiusPx).toBeLessThanOrEqual(snapshot.height + 2);
});

test("mobile circular taxonomy panning does not clamp branch bitmap apart from ribbons", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForViewer(page);

  const modes = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMockTaxonomy();
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const initialDebug = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.circular as {
      branchRenderMode?: string;
    } | undefined;
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "circular") {
      throw new Error("Circular camera unavailable.");
    }
    let pannedDebug: { branchRenderMode?: string } | undefined = initialDebug;
    for (const delta of [900, 1800, 3200, -900, -1800, -3200]) {
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
        translateX: camera.translateX + delta,
        translateY: camera.translateY,
        scale: camera.scale,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const candidateDebug = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.circular as {
        branchRenderMode?: string;
      } | undefined;
      if (candidateDebug?.branchRenderMode) {
        pannedDebug = candidateDebug;
      }
      if (pannedDebug?.branchRenderMode !== "taxonomy-cached-bitmap") {
        break;
      }
    }
    return {
      initial: initialDebug?.branchRenderMode ?? null,
      panned: pannedDebug?.branchRenderMode ?? null,
    };
  });

  expect(["taxonomy-cached-bitmap", "taxonomy-cached-paths"]).toContain(modes.initial);
  expect(["taxonomy-cached-bitmap", "taxonomy-cached-paths"]).toContain(modes.panned);
});

test("large circular fit-view falls back to the cached base path", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFile(page, path.resolve(TEST_DIR, "..", "backbone_hang_supertree.nwk"));
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyEnabled(false);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const debug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    branchRenderMode?: string;
  } | null);

  expect(debug?.branchRenderMode).toBe("cached-path");
});

test("circular log-scale live branch arcs use transformed radii", async ({ page }) => {
  await waitForViewer(page);
  await loadPastedTree(page, "((A:90,B:90)X:10,C:100)Root;");

  const result = await page.evaluate(async () => {
    const logBase = 4.2;
    const extent = 100;
    const rawInternalDepth = 10;
    const logUnit = extent / logBase;
    const denominator = Math.log1p(extent / logUnit);
    const age = extent - rawInternalDepth;
    const axisDepth = extent * (1 - (Math.log1p(age / logUnit) / denominator));
    const scale = 8;

    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTimeAxisScale("log");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      scale,
      translateX: 500,
      translateY: 400,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const svg = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "";
    const branchArcRadii: number[] = [];
    const pathPattern = /<path d="([^"]*?A ([0-9.]+) ([0-9.]+)[^"]*?)" stroke="#0f172a"/g;
    let match: RegExpExecArray | null;
    while ((match = pathPattern.exec(svg)) !== null) {
      const radiusX = Number(match[2]);
      const radiusY = Number(match[3]);
      if (Number.isFinite(radiusX) && Math.abs(radiusX - radiusY) < 0.001) {
        branchArcRadii.push(radiusX);
      }
    }

    return {
      branchArcRadii,
      expectedRadius: axisDepth * scale,
      rawRadius: rawInternalDepth * scale,
    };
  });

  expect(result.branchArcRadii.some((radius) => Math.abs(radius - result.expectedRadius) < 0.75)).toBeTruthy();
  expect(result.branchArcRadii.some((radius) => Math.abs(radius - result.rawRadius) < 0.75)).toBeFalsy();
});
