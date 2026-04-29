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
      && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded,
    );
  });
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

test("zoomed spiral switches back to circular fit without keeping the spiral zoom", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("spiral");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "circular") {
      throw new Error("Spiral camera unavailable.");
    }
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      scale: camera.scale * 4,
      translateX: camera.translateX - 120,
      translateY: camera.translateY + 90,
    });
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

test("large circular fit-view falls back to the cached base path", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFile(page, path.resolve(TEST_DIR, "..", "backbone_hang_supertree.nwk"));
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const debug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    branchRenderMode?: string;
  } | null);

  expect(debug?.branchRenderMode).toBe("cached-path");
});
