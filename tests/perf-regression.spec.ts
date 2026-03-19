import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const DEFAULT_PERF_TREE_PATH = "/home/john/Repos/TimeTree_CSTA/results/full_v9_tipdepth1_reconcile_rootcap4300_safehomonyms_withtt5/131567_cellular_organisms_reconcile_rootcap4300.nwk";
const PERF_TREE_PATH = process.env.BIG_TREE_VIEWER_PERF_TREE ?? DEFAULT_PERF_TREE_PATH;
const PERF_TREE_AVAILABLE = fs.existsSync(PERF_TREE_PATH);

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const ZOOM_STEPS = Math.max(1, Math.floor(envNumber("BIG_TREE_VIEWER_PERF_ZOOM_STEPS", 3)));
const ZOOM_CACHE_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_ZOOM_CACHE_MAX_MS", 35);
const ZOOM_FINAL_TOTAL_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_ZOOM_FINAL_TOTAL_MAX_MS", 50);
const ZOOM_FINAL_BRANCH_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_ZOOM_FINAL_BRANCH_MAX_MS", 2);
const ZOOM_FINAL_VISIBILITY_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_ZOOM_FINAL_VISIBILITY_MAX_MS", 2);
const PAN_DRAW_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_DRAW_P95_MAX_MS", 12);
const PAN_BRANCH_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_BRANCH_P95_MAX_MS", 2);
const PAN_TAXONOMY_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_TAXONOMY_P95_MAX_MS", 12);
const PAN_FRAME_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_FRAME_P95_MAX_MS", 35);
const PAN_BROAD_DRAW_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_BROAD_DRAW_P95_MAX_MS", 12);
const PAN_BROAD_TAXONOMY_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_BROAD_TAXONOMY_P95_MAX_MS", 12);
const PAN_BROAD_FRAME_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_BROAD_FRAME_P95_MAX_MS", 36);

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__
    && window.__BIG_TREE_VIEWER_RENDER_DEBUG__,
  ));
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded)
      && !Boolean(state?.loading)
      && typeof state?.treeSignature === "string"
      && state.treeSignature.length > 0;
  }, undefined, { timeout: 180000 });
}

async function loadTreeFile(page: Page, treePath: string): Promise<void> {
  const previousSignature = await page.evaluate(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return typeof state?.treeSignature === "string" ? state.treeSignature : null;
  });
  await page.setInputFiles('input[type="file"]', treePath);
  await page.waitForFunction((expectedPreviousSignature) => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const state = app?.getState();
    return Boolean(
      app
      && state?.treeLoaded
      && !state?.loading
      && typeof state?.treeSignature === "string"
      && state.treeSignature.length > 0
      && state.treeSignature !== expectedPreviousSignature
      && window.__BIG_TREE_VIEWER_CANVAS_TEST__
      && window.__BIG_TREE_VIEWER_RENDER_DEBUG__,
    );
  }, previousSignature, { timeout: 300000 });
  const loadedSignature = await page.evaluate(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return typeof state?.treeSignature === "string" ? state.treeSignature : null;
  });
  await page.waitForTimeout(150);
  await page.waitForFunction((expectedSignature) => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return typeof state?.treeSignature === "string" && state.treeSignature === expectedSignature;
  }, loadedSignature, { timeout: 30_000 });
}

async function configureCircularPerfScene(page: Page): Promise<void> {
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.clearTaxonomy();
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMockTaxonomy();
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowGenusLabels(false);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.viewMode === "circular"
      && Boolean(state?.taxonomyEnabled)
      && Number(state?.taxonomyMappedCount ?? 0) > 0;
  });
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await waitForCircularTaxonomySnapshot(page);
}

async function movePointerToCircularCenter(page: Page): Promise<void> {
  const center = await page.evaluate(() => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "circular") {
      throw new Error("Circular camera unavailable.");
    }
    return { x: Number(camera.translateX), y: Number(camera.translateY) };
  });
  await page.mouse.move(center.x, center.y);
}

async function runCircularPanBenchmark(
  page: Page,
  label: string,
  dragDx: number,
  dragDy: number,
  steps: number,
): Promise<{
  branchRenderModes?: string[];
  drawTotalMsP95?: number;
  branchBaseMsP95?: number;
  taxonomyOverlayMsP95?: number;
  frameDeltaMsP95?: number;
} | null> {
  await page.evaluate((benchmarkLabel) => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.startPanBenchmark(benchmarkLabel);
  }, label);

  await movePointerToCircularCenter(page);
  const center = await page.evaluate(() => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "circular") {
      throw new Error("Circular camera unavailable.");
    }
    return { x: Number(camera.translateX), y: Number(camera.translateY) };
  });
  await page.mouse.down();
  await page.mouse.move(center.x + dragDx, center.y + dragDy, { steps });
  await page.mouse.up();
  await page.waitForTimeout(150);

  return page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.stopPanBenchmark?.() as {
    branchRenderModes?: string[];
    drawTotalMsP95?: number;
    branchBaseMsP95?: number;
    taxonomyOverlayMsP95?: number;
    frameDeltaMsP95?: number;
  } | null);
}

async function readCircularPerfSnapshot(page: Page): Promise<{
  state: {
    viewMode?: string;
    taxonomyEnabled?: boolean;
    taxonomyMappedCount?: number;
  } | null;
  timing: {
    totalMs?: number;
    branchBaseMs?: number;
    taxonomyOverlayMs?: number;
    circularTaxonomyCacheMs?: number;
    circularVisibilityPrepMs?: number;
  } | null;
  circular: {
    branchRenderMode?: string;
    taxonomyVisibleRanks?: string[];
    taxonomyArcCount?: number;
    taxonomyPlacedLabelCount?: number;
  } | null;
}> {
  return page.evaluate(() => ({
    state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState
      ? {
        viewMode: String(window.__BIG_TREE_VIEWER_APP_TEST__.getState().viewMode ?? ""),
        taxonomyEnabled: Boolean(window.__BIG_TREE_VIEWER_APP_TEST__.getState().taxonomyEnabled),
        taxonomyMappedCount: Number(window.__BIG_TREE_VIEWER_APP_TEST__.getState().taxonomyMappedCount ?? 0),
      }
      : null,
    timing: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.timing ?? null,
    circular: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular
      ? {
        branchRenderMode: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular?.branchRenderMode,
        taxonomyVisibleRanks: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular?.taxonomyVisibleRanks,
        taxonomyArcCount: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular?.taxonomyArcCount,
        taxonomyPlacedLabelCount: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular?.taxonomyPlacedLabelCount,
      }
      : null,
  }));
}

async function waitForCircularTaxonomySnapshot(page: Page, timeoutMs = 30_000): Promise<Awaited<ReturnType<typeof readCircularPerfSnapshot>>> {
  const deadline = Date.now() + timeoutMs;
  let latestSnapshot = await readCircularPerfSnapshot(page);
  while (Date.now() < deadline) {
    const ranks = latestSnapshot.circular?.taxonomyVisibleRanks ?? [];
    const renderMode = latestSnapshot.circular?.branchRenderMode ?? null;
    if (ranks.length > 0 && renderMode !== null && renderMode.startsWith("taxonomy-")) {
      return latestSnapshot;
    }
    await page.evaluate(async () => {
      window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
      window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await page.waitForTimeout(200);
    latestSnapshot = await readCircularPerfSnapshot(page);
  }
  throw new Error(`Timed out waiting for circular taxonomy render snapshot: ${JSON.stringify(latestSnapshot)}`);
}

test.describe("local circular perf regression", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!PERF_TREE_AVAILABLE, `Missing local perf tree: ${PERF_TREE_PATH}`);

  test("fit-view wheel zoom stays on cached taxonomy paths before class appears", async ({ page }) => {
    test.slow();
    test.setTimeout(6 * 60 * 1000);

    await waitForViewer(page);
    await loadTreeFile(page, PERF_TREE_PATH);
    await configureCircularPerfScene(page);

    const snapshots: Array<Awaited<ReturnType<typeof readCircularPerfSnapshot>>> = [];
    for (let step = 0; step <= ZOOM_STEPS; step += 1) {
      if (step > 0) {
        await movePointerToCircularCenter(page);
        await page.mouse.wheel(0, -100);
        await settleFrames(page);
      }
      snapshots.push(await readCircularPerfSnapshot(page));
    }

    const zoomFrames = snapshots.slice(1);
    expect(zoomFrames.length).toBe(ZOOM_STEPS);
    for (const snapshot of zoomFrames) {
      expect((snapshot.circular?.taxonomyVisibleRanks ?? []).length).toBeGreaterThan(0);
      expect(snapshot.circular?.taxonomyVisibleRanks ?? []).not.toContain("class");
      expect(["taxonomy-cached-bitmap", "taxonomy-cached-paths"]).toContain(snapshot.circular?.branchRenderMode ?? "");
      expect(Number(snapshot.timing?.circularTaxonomyCacheMs ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(ZOOM_CACHE_MAX_MS);
    }

    const finalSnapshot = zoomFrames[zoomFrames.length - 1];
    expect(Number(finalSnapshot.timing?.totalMs ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(ZOOM_FINAL_TOTAL_MAX_MS);
    expect(Number(finalSnapshot.timing?.branchBaseMs ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(ZOOM_FINAL_BRANCH_MAX_MS);
    expect(Number(finalSnapshot.timing?.circularVisibilityPrepMs ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(
      ZOOM_FINAL_VISIBILITY_MAX_MS,
    );
  });

  test("fit-view pan stays on the cached taxonomy bitmap path", async ({ page }) => {
    test.slow();
    test.setTimeout(6 * 60 * 1000);

    await waitForViewer(page);
    await loadTreeFile(page, PERF_TREE_PATH);
    await configureCircularPerfScene(page);
    await settleFrames(page);

    const benchmark = await runCircularPanBenchmark(page, "local-perf-pan", 160, 40, 24);

    expect(benchmark).not.toBeNull();
    expect(benchmark?.branchRenderModes ?? []).toEqual(["taxonomy-cached-bitmap"]);
    expect(Number(benchmark?.drawTotalMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_DRAW_P95_MAX_MS);
    expect(Number(benchmark?.branchBaseMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_BRANCH_P95_MAX_MS);
    expect(Number(benchmark?.taxonomyOverlayMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_TAXONOMY_P95_MAX_MS);
    expect(Number(benchmark?.frameDeltaMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_FRAME_P95_MAX_MS);
  });

  test("broader circular pan with taxonomy labels stays interactive on cached branches", async ({ page }) => {
    test.slow();
    test.setTimeout(6 * 60 * 1000);

    await page.setViewportSize({ width: 1440, height: 960 });
    await waitForViewer(page);
    await loadTreeFile(page, PERF_TREE_PATH);
    await configureCircularPerfScene(page);
    await settleFrames(page);

    const benchmark = await runCircularPanBenchmark(page, "local-perf-pan-broad", 480, 120, 24);
    const snapshot = await readCircularPerfSnapshot(page);

    expect(benchmark).not.toBeNull();
    expect(benchmark?.branchRenderModes ?? []).toEqual(["taxonomy-cached-bitmap"]);
    expect((snapshot.circular?.taxonomyVisibleRanks ?? []).length).toBeGreaterThan(0);
    expect(Number(snapshot.circular?.taxonomyArcCount ?? 0)).toBeGreaterThan(100);
    expect(Number(snapshot.circular?.taxonomyPlacedLabelCount ?? 0)).toBeGreaterThan(0);
    expect(Number(benchmark?.drawTotalMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_BROAD_DRAW_P95_MAX_MS);
    expect(Number(benchmark?.branchBaseMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_BRANCH_P95_MAX_MS);
    expect(Number(benchmark?.taxonomyOverlayMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_BROAD_TAXONOMY_P95_MAX_MS);
    expect(Number(benchmark?.frameDeltaMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_BROAD_FRAME_P95_MAX_MS);
  });

  test("figure style changes do not break cached circular taxonomy fit-view zoom", async ({ page }) => {
    test.slow();
    test.setTimeout(6 * 60 * 1000);

    await waitForViewer(page);
    await loadTreeFile(page, PERF_TREE_PATH);
    await configureCircularPerfScene(page);
    await page.evaluate(() => {
      window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("tip", "sizeScale", 1.6);
      window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "sizeScale", 1.5);
      window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "bandThicknessScale", 1.35);
      window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    });
    await settleFrames(page);

    const snapshots: Array<Awaited<ReturnType<typeof readCircularPerfSnapshot>>> = [];
    for (let step = 0; step <= ZOOM_STEPS; step += 1) {
      if (step > 0) {
        await movePointerToCircularCenter(page);
        await page.mouse.wheel(0, -100);
        await settleFrames(page);
      }
      snapshots.push(await readCircularPerfSnapshot(page));
    }

    for (const snapshot of snapshots.slice(1)) {
      expect(["taxonomy-cached-bitmap", "taxonomy-cached-paths"]).toContain(snapshot.circular?.branchRenderMode ?? "");
      expect(Number(snapshot.timing?.branchBaseMs ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(ZOOM_FINAL_BRANCH_MAX_MS);
    }
  });

  test("figure style changes do not break cached circular taxonomy fit-view pan", async ({ page }) => {
    test.slow();
    test.setTimeout(6 * 60 * 1000);

    await waitForViewer(page);
    await loadTreeFile(page, PERF_TREE_PATH);
    await configureCircularPerfScene(page);
    await page.evaluate(() => {
      window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("tip", "sizeScale", 1.6);
      window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "sizeScale", 1.5);
      window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "bandThicknessScale", 1.35);
      window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    });
    await settleFrames(page);

    const benchmark = await runCircularPanBenchmark(page, "local-perf-pan-styled", 160, 40, 24);

    expect(benchmark).not.toBeNull();
    expect(benchmark?.branchRenderModes ?? []).toEqual(["taxonomy-cached-bitmap"]);
    expect(Number(benchmark?.drawTotalMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_DRAW_P95_MAX_MS);
    expect(Number(benchmark?.branchBaseMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_BRANCH_P95_MAX_MS);
    expect(Number(benchmark?.taxonomyOverlayMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_TAXONOMY_P95_MAX_MS);
    expect(Number(benchmark?.frameDeltaMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_FRAME_P95_MAX_MS);
  });
});
