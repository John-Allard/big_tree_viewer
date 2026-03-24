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
const ZOOM_FIRST_STEP_TOTAL_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_ZOOM_FIRST_STEP_TOTAL_MAX_MS", 40);
const ZOOM_FINAL_TOTAL_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_ZOOM_FINAL_TOTAL_MAX_MS", 50);
const ZOOM_STYLED_TOTAL_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_ZOOM_STYLED_TOTAL_MAX_MS", 60);
const ZOOM_FINAL_BRANCH_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_ZOOM_FINAL_BRANCH_MAX_MS", 2);
const ZOOM_FINAL_VISIBILITY_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_ZOOM_FINAL_VISIBILITY_MAX_MS", 2);
const PAN_DRAW_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_DRAW_P95_MAX_MS", 12);
const PAN_BRANCH_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_BRANCH_P95_MAX_MS", 2);
const PAN_TAXONOMY_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_TAXONOMY_P95_MAX_MS", 12);
const PAN_FRAME_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_FRAME_P95_MAX_MS", 35);
const PAN_BROAD_DRAW_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_BROAD_DRAW_P95_MAX_MS", 12);
const PAN_BROAD_TAXONOMY_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_BROAD_TAXONOMY_P95_MAX_MS", 12);
const PAN_BROAD_FRAME_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_BROAD_FRAME_P95_MAX_MS", 36);
const PAN_PARTIAL_DRAW_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_PARTIAL_DRAW_P95_MAX_MS", 24);
const PAN_PARTIAL_FRAME_P95_MAX_MS = envNumber("BIG_TREE_VIEWER_PERF_PAN_PARTIAL_FRAME_P95_MAX_MS", 45);

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

async function configureBroadSyntheticCircularPerfScene(page: Page): Promise<{ targetMidTheta: number; rootAge: number }> {
  const target = await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const state = app?.getState();
    const leafNodes = internal?.leafNodes ?? [];
    if (!app || !state || leafNodes.length === 0) {
      throw new Error("Broad synthetic taxonomy scene unavailable.");
    }
    const leafCount = leafNodes.length;
    const phylumCount = 5;
    const classesPerPhylum = 4;
    const ordersPerClass = 3;
    const familiesPerOrder = 2;
    const generaPerFamily = 2;
    const tipRanks = leafNodes.map((node, index) => {
      const phylumIndex = Math.min(phylumCount - 1, Math.floor((index / leafCount) * phylumCount));
      const withinPhylum = ((index / leafCount) * phylumCount) - phylumIndex;
      const classIndex = Math.min(classesPerPhylum - 1, Math.floor(withinPhylum * classesPerPhylum));
      const withinClass = (withinPhylum * classesPerPhylum) - classIndex;
      const orderIndex = Math.min(ordersPerClass - 1, Math.floor(withinClass * ordersPerClass));
      const withinOrder = (withinClass * ordersPerClass) - orderIndex;
      const familyIndex = Math.min(familiesPerOrder - 1, Math.floor(withinOrder * familiesPerOrder));
      const withinFamily = (withinOrder * familiesPerOrder) - familyIndex;
      const genusIndex = Math.min(generaPerFamily - 1, Math.floor(withinFamily * generaPerFamily));
      return {
        node,
        ranks: {
          genus: `Genus ${phylumIndex}-${classIndex}-${orderIndex}-${familyIndex}-${genusIndex}`,
          family: `Family ${phylumIndex}-${classIndex}-${orderIndex}-${familyIndex}`,
          order: `Order ${phylumIndex}-${classIndex}-${orderIndex}`,
          class: `Class ${phylumIndex}-${classIndex}`,
          phylum: `Phylum ${phylumIndex}`,
        },
      };
    });
    app.clearTaxonomy();
    app.setTaxonomyMapForTest({
      mappedCount: tipRanks.length,
      totalTips: tipRanks.length,
      activeRanks: ["genus", "family", "order", "class", "phylum"],
      tipRanks,
    });
    app.setShowGenusLabels(false);
    app.setViewMode("circular");

    const targetPhylum = 3;
    const targetClass = 1;
    const targetStartFraction = (targetPhylum / phylumCount) + (targetClass / (phylumCount * classesPerPhylum));
    const targetEndFraction = (targetPhylum / phylumCount) + ((targetClass + 1) / (phylumCount * classesPerPhylum));
    const targetStartIndex = Math.floor(targetStartFraction * leafCount);
    const targetEndIndex = Math.ceil(targetEndFraction * leafCount);
    const targetMidTheta = (((targetStartIndex + targetEndIndex) * 0.5) / leafCount) * Math.PI * 2;
    return {
      targetMidTheta,
      rootAge: Number(state.rootAge),
    };
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.viewMode === "circular"
      && Boolean(state?.taxonomyEnabled)
      && Number(state?.taxonomyMappedCount ?? 0) > 200000;
  });
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await waitForCircularTaxonomySnapshot(page);
  return target;
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
    visibleCircleFraction?: number;
    taxonomyArcDebug?: Array<{
      key?: string | null;
      innerRadiusPx?: number | null;
      outerRadiusPx?: number | null;
      startTheta?: number | null;
      endTheta?: number | null;
      screenSampleX?: number | null;
      screenSampleY?: number | null;
    }>;
    taxonomyPlacedLabels?: Array<{
      key?: string | null;
      rank?: string | null;
      fontSize?: number | null;
      x?: number | null;
      y?: number | null;
    }>;
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
        visibleCircleFraction: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular?.visibleCircleFraction,
        taxonomyArcDebug: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular?.taxonomyArcDebug,
        taxonomyPlacedLabels: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular?.taxonomyPlacedLabels,
      }
      : null,
  }));
}

function summarizeRingBounds(
  arcs: Array<{ key?: string | null; innerRadiusPx?: number | null; outerRadiusPx?: number | null }>,
): Array<{ rank: string; minInner: number; maxOuter: number }> {
  const bounds = new Map<string, { minInner: number; maxOuter: number }>();
  for (const arc of arcs) {
    const rank = String(arc.key ?? "").split(":")[0] ?? "";
    const innerRadiusPx = Number(arc.innerRadiusPx ?? Number.NaN);
    const outerRadiusPx = Number(arc.outerRadiusPx ?? Number.NaN);
    if (!rank || !Number.isFinite(innerRadiusPx) || !Number.isFinite(outerRadiusPx)) {
      continue;
    }
    const existing = bounds.get(rank);
    if (existing) {
      existing.minInner = Math.min(existing.minInner, innerRadiusPx);
      existing.maxOuter = Math.max(existing.maxOuter, outerRadiusPx);
    } else {
      bounds.set(rank, { minInner: innerRadiusPx, maxOuter: outerRadiusPx });
    }
  }
  return ["genus", "family", "order", "class", "phylum", "superkingdom"]
    .filter((rank) => bounds.has(rank))
    .map((rank) => ({ rank, minInner: bounds.get(rank)!.minInner, maxOuter: bounds.get(rank)!.maxOuter }));
}

function summarizeArcCountsByRank(
  arcs: Array<{ key?: string | null }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const arc of arcs) {
    const rank = String(arc.key ?? "").split(":")[0] ?? "";
    if (!rank) {
      continue;
    }
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  return counts;
}

async function hasPaintedOuterTaxonomyArcSample(
  page: Page,
  arcs: Array<{
    key?: string | null;
    innerRadiusPx?: number | null;
    outerRadiusPx?: number | null;
    startTheta?: number | null;
    endTheta?: number | null;
    screenSampleX?: number | null;
    screenSampleY?: number | null;
  }>,
): Promise<boolean> {
  return page.evaluate((rawArcs) => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "circular") {
      return false;
    }
    const canvas = document.querySelector('[data-testid="tree-canvas"]') as HTMLCanvasElement | null;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !ctx) {
      return false;
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(rect.width, 1);
    const scaleY = canvas.height / Math.max(rect.height, 1);
    const sampleFractions = [0.18, 0.35, 0.5, 0.65, 0.82];
    const candidateArcs = rawArcs
      .filter((arc) => {
        const rank = String(arc.key ?? "").split(":")[0] ?? "";
        return ["family", "order", "class", "phylum"].includes(rank);
      })
      .sort((left, right) => Number(right.outerRadiusPx ?? 0) - Number(left.outerRadiusPx ?? 0));
    for (const arc of candidateArcs) {
      const startTheta = Number(arc.startTheta ?? Number.NaN);
      const endTheta = Number(arc.endTheta ?? Number.NaN);
      const innerRadiusPx = Number(arc.innerRadiusPx ?? Number.NaN);
      const outerRadiusPx = Number(arc.outerRadiusPx ?? Number.NaN);
      const screenSampleX = Number(arc.screenSampleX ?? Number.NaN);
      const screenSampleY = Number(arc.screenSampleY ?? Number.NaN);
      if (
        Number.isFinite(screenSampleX)
        && Number.isFinite(screenSampleY)
        && screenSampleX >= 16
        && screenSampleX <= rect.width - 16
        && screenSampleY >= 16
        && screenSampleY <= rect.height - 16
      ) {
        const pixelX = Math.round(screenSampleX * scaleX);
        const pixelY = Math.round(screenSampleY * scaleY);
        const sample = ctx.getImageData(
          Math.max(0, pixelX - 1),
          Math.max(0, pixelY - 1),
          Math.min(3, Math.max(1, canvas.width - Math.max(0, pixelX - 1))),
          Math.min(3, Math.max(1, canvas.height - Math.max(0, pixelY - 1))),
        ).data;
        let totalR = 0;
        let totalG = 0;
        let totalB = 0;
        let totalA = 0;
        const pixelCount = Math.max(1, sample.length / 4);
        for (let index = 0; index < sample.length; index += 4) {
          totalR += sample[index];
          totalG += sample[index + 1];
          totalB += sample[index + 2];
          totalA += sample[index + 3];
        }
        const avgR = totalR / pixelCount;
        const avgG = totalG / pixelCount;
        const avgB = totalB / pixelCount;
        const avgA = totalA / pixelCount;
        const whiteDistance = Math.sqrt(
          ((255 - avgR) * (255 - avgR))
          + ((255 - avgG) * (255 - avgG))
          + ((255 - avgB) * (255 - avgB)),
        );
        if (avgA > 0 && whiteDistance > 18) {
          return true;
        }
      }
      if (
        !Number.isFinite(startTheta)
        || !Number.isFinite(endTheta)
        || !Number.isFinite(innerRadiusPx)
        || !Number.isFinite(outerRadiusPx)
        || endTheta <= startTheta
      ) {
        continue;
      }
      const radiusPx = (innerRadiusPx + outerRadiusPx) * 0.5;
      for (const fraction of sampleFractions) {
        const theta = startTheta + ((endTheta - startTheta) * fraction) + Number(camera.rotation);
        const x = Number(camera.translateX) + (Math.cos(theta) * radiusPx);
        const y = Number(camera.translateY) + (Math.sin(theta) * radiusPx);
        if (x < 16 || x > rect.width - 16 || y < 16 || y > rect.height - 16) {
          continue;
        }
        const pixelX = Math.round(x * scaleX);
        const pixelY = Math.round(y * scaleY);
        const sampleSize = 3;
        const sample = ctx.getImageData(
          Math.max(0, pixelX - 1),
          Math.max(0, pixelY - 1),
          Math.min(sampleSize, Math.max(1, canvas.width - Math.max(0, pixelX - 1))),
          Math.min(sampleSize, Math.max(1, canvas.height - Math.max(0, pixelY - 1))),
        ).data;
        let totalR = 0;
        let totalG = 0;
        let totalB = 0;
        let totalA = 0;
        const pixelCount = Math.max(1, sample.length / 4);
        for (let index = 0; index < sample.length; index += 4) {
          totalR += sample[index];
          totalG += sample[index + 1];
          totalB += sample[index + 2];
          totalA += sample[index + 3];
        }
        const avgR = totalR / pixelCount;
        const avgG = totalG / pixelCount;
        const avgB = totalB / pixelCount;
        const avgA = totalA / pixelCount;
        const whiteDistance = Math.sqrt(
          ((255 - avgR) * (255 - avgR))
          + ((255 - avgG) * (255 - avgG))
          + ((255 - avgB) * (255 - avgB)),
        );
        if (avgA > 0 && whiteDistance > 18) {
          return true;
        }
      }
    }
    return false;
  }, arcs);
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
    const firstZoomFrame = zoomFrames[0];
    expect(firstZoomFrame.circular?.branchRenderMode ?? "").toBe("taxonomy-cached-bitmap");
    expect(Number(firstZoomFrame.timing?.totalMs ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(
      ZOOM_FIRST_STEP_TOTAL_MAX_MS,
    );
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

  test("deep 210k circular zoom keeps five taxonomy rings radially ordered", async ({ page }) => {
    test.slow();
    test.setTimeout(6 * 60 * 1000);

    await page.setViewportSize({ width: 1440, height: 960 });
    await waitForViewer(page);
    await loadTreeFile(page, PERF_TREE_PATH);
    await configureCircularPerfScene(page);

    const fitCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
    expect(fitCamera?.kind).toBe("circular");
    const fiveRingSnapshots: Array<Array<{ rank: string; minInner: number; maxOuter: number }>> = [];
    for (const scale of [6, 12, 20]) {
      await page.evaluate(({ fitCamera, scale }) => {
        if (!fitCamera || fitCamera.kind !== "circular") {
          throw new Error("Circular fit camera unavailable.");
        }
        window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
          scale,
          translateX: Number(fitCamera.translateX),
          translateY: Number(fitCamera.translateY),
        });
      }, { fitCamera, scale });
      await settleFrames(page);
      const snapshot = await readCircularPerfSnapshot(page);
      const bounds = summarizeRingBounds(snapshot.circular?.taxonomyArcDebug ?? []);
      if ((snapshot.circular?.taxonomyVisibleRanks ?? []).length >= 5 && bounds.length >= 5) {
        fiveRingSnapshots.push(bounds);
      }
    }

    expect(fiveRingSnapshots.length).toBeGreaterThan(0);
    for (const bounds of fiveRingSnapshots) {
      expect(bounds.slice(0, 5).map((entry) => entry.rank)).toEqual(["genus", "family", "order", "class", "phylum"]);
      for (let index = 1; index < 5; index += 1) {
        expect(bounds[index].minInner).toBeGreaterThan(bounds[index - 1].maxOuter + 2);
      }
    }
  });

  test("deep partial-view circular zoom keeps outer taxonomy arcs visible", async ({ page }) => {
    test.slow();
    test.setTimeout(6 * 60 * 1000);

    await page.setViewportSize({ width: 1440, height: 960 });
    await waitForViewer(page);
    await loadTreeFile(page, PERF_TREE_PATH);
    const target = await configureBroadSyntheticCircularPerfScene(page);

    const fitCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
    expect(fitCamera?.kind).toBe("circular");

    const qualifyingSamples: Array<{
      multiplier: number;
      visibleCircleFraction: number;
      visibleRanks: string[];
      taxonomyArcCount: number;
      screenSpaceArcCount: number;
      paintedOuterArc: boolean;
    }> = [];

    for (const multiplier of [4, 6, 8, 10, 12, 16]) {
      await page.evaluate(({ fitCamera, target, multiplier }) => {
        if (!fitCamera || fitCamera.kind !== "circular") {
          throw new Error("Circular fit camera unavailable.");
        }
        const scale = Number(fitCamera.scale) * multiplier;
        const worldX = Math.cos(target.targetMidTheta) * target.rootAge;
        const worldY = Math.sin(target.targetMidTheta) * target.rootAge;
        window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
          scale,
          translateX: (1440 * 0.45) - (worldX * scale),
          translateY: (960 * 0.52) - (worldY * scale),
        });
      }, { fitCamera, target, multiplier });
      await settleFrames(page);

      const snapshot = await readCircularPerfSnapshot(page);
      const visibleRanks = snapshot.circular?.taxonomyVisibleRanks ?? [];
      if (!visibleRanks.includes("class") || !visibleRanks.includes("phylum")) {
        continue;
      }
      qualifyingSamples.push({
        multiplier,
        visibleCircleFraction: Number(snapshot.circular?.visibleCircleFraction ?? 0),
        visibleRanks,
        taxonomyArcCount: Number(snapshot.circular?.taxonomyArcCount ?? 0),
        screenSpaceArcCount: (snapshot.circular?.taxonomyArcDebug ?? [])
          .filter((arc) => String(arc.key ?? "").includes(":screen-"))
          .length,
        paintedOuterArc: await hasPaintedOuterTaxonomyArcSample(page, snapshot.circular?.taxonomyArcDebug ?? []),
      });
    }

    expect(qualifyingSamples.length).toBeGreaterThan(0);
    expect(qualifyingSamples.some((sample) => sample.multiplier >= 8)).toBeTruthy();
    for (const sample of qualifyingSamples) {
      expect(sample.taxonomyArcCount).toBeGreaterThan(0);
      expect(sample.screenSpaceArcCount).toBeGreaterThan(0);
      expect(
        sample.paintedOuterArc,
        `Expected a painted outer-rank taxonomy arc on the canvas at multiplier=${sample.multiplier}, visibleCircleFraction=${sample.visibleCircleFraction.toFixed(3)}`,
      ).toBeTruthy();
    }
  });

  test("quarter-view circular pan stays on cached bitmap branches", async ({ page }) => {
    test.slow();
    test.setTimeout(6 * 60 * 1000);

    await page.setViewportSize({ width: 1440, height: 960 });
    await waitForViewer(page);
    await loadTreeFile(page, PERF_TREE_PATH);
    await configureCircularPerfScene(page);

    const fitCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
    expect(fitCamera?.kind).toBe("circular");
    await page.evaluate((fitCamera) => {
      if (!fitCamera || fitCamera.kind !== "circular") {
        throw new Error("Circular fit camera unavailable.");
      }
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
        scale: Number(fitCamera.scale) * 5,
        translateX: Number(fitCamera.translateX),
        translateY: Number(fitCamera.translateY),
      });
    }, fitCamera);
    await settleFrames(page);

    const snapshot = await readCircularPerfSnapshot(page);
    const benchmark = await runCircularPanBenchmark(page, "local-perf-pan-quarter", 180, 48, 18);

    expect(Number(snapshot.circular?.visibleCircleFraction ?? 0)).toBeLessThanOrEqual(0.3);
    expect(benchmark).not.toBeNull();
    expect(benchmark?.branchRenderModes ?? []).toContain("taxonomy-cached-bitmap");
    expect((benchmark?.branchRenderModes ?? []).every((mode) => ["taxonomy-cached-bitmap", "taxonomy-cached-paths"].includes(mode))).toBeTruthy();
    expect(Number(benchmark?.drawTotalMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_PARTIAL_DRAW_P95_MAX_MS);
    expect(Number(benchmark?.frameDeltaMsP95 ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(PAN_PARTIAL_FRAME_P95_MAX_MS);
  });

  test("outer circular taxonomy labels keep a stable size near the viewport edge", async ({ page }) => {
    test.slow();
    test.setTimeout(6 * 60 * 1000);

    await page.setViewportSize({ width: 1440, height: 960 });
    await waitForViewer(page);
    await loadTreeFile(page, PERF_TREE_PATH);
    await configureCircularPerfScene(page);

    const fitCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
    expect(fitCamera?.kind).toBe("circular");
    const before = await readCircularPerfSnapshot(page);
    const labelCandidates = before.circular?.taxonomyPlacedLabels ?? [];
    const candidate = labelCandidates
      .filter((label) => (
        (label.rank === "phylum" || label.rank === "class" || label.rank === "order")
        && typeof label.key === "string"
        && Number(label.x ?? 0) > 520
        && Number(label.x ?? 0) < 1180
        && Number(label.fontSize ?? 0) > 0
      ))
      .sort((left, right) => Number(right.x ?? 0) - Number(left.x ?? 0))[0]
      ?? labelCandidates
        .filter((label) => typeof label.key === "string" && Number(label.fontSize ?? 0) > 0)
        .sort((left, right) => Number(right.x ?? 0) - Number(left.x ?? 0))[0]
        ?? null;

    expect(candidate?.key ?? null).not.toBeNull();

    for (const deltaX of [80, 120, 160]) {
      await page.evaluate(({ baseCamera, translateDeltaX }) => {
        if (!baseCamera || baseCamera.kind !== "circular") {
          throw new Error("Circular camera unavailable.");
        }
        window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
          scale: Number(baseCamera.scale),
          translateX: Number(baseCamera.translateX) + Number(translateDeltaX),
          translateY: Number(baseCamera.translateY),
        });
      }, {
        baseCamera: fitCamera,
        translateDeltaX: deltaX,
      });
      await settleFrames(page);

      const after = await readCircularPerfSnapshot(page);
      const moved = (after.circular?.taxonomyPlacedLabels ?? []).find((label) => label.key === candidate?.key);
      expect(moved?.key ?? null).toBe(candidate?.key ?? null);
      expect(Math.abs(Number(moved.fontSize ?? 0) - Number(candidate?.fontSize ?? 0))).toBeLessThanOrEqual(0.35);
    }
  });

  test("slightly zoomed circular outer taxonomy rings stay filled on the vertical midline", async ({ page }) => {
    test.slow();
    test.setTimeout(6 * 60 * 1000);

    await page.setViewportSize({ width: 1440, height: 960 });
    await waitForViewer(page);
    await loadTreeFile(page, PERF_TREE_PATH);
    await page.evaluate(async () => {
      const app = window.__BIG_TREE_VIEWER_APP_TEST__;
      const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
      const leafNodes = internal?.leafNodes ?? [];
      if (!app || leafNodes.length < 1000) {
        throw new Error("Broad circular taxonomy seam scene unavailable.");
      }
      const tipRanks = leafNodes.map((node, index) => {
        const fraction = index / leafNodes.length;
        const phylum = fraction < 0.5 ? "Phylum A" : "Phylum B";
        const classRank = fraction < 0.25
          ? "Class A"
          : fraction < 0.5
            ? "Class B"
            : fraction < 0.75
              ? "Class C"
              : "Class D";
        return {
          node,
          ranks: {
            class: classRank,
            phylum,
          },
        };
      });
      app.setTaxonomyMapForTest({
        version: 3,
        mappedCount: tipRanks.length,
        totalTips: tipRanks.length,
        activeRanks: ["class", "phylum"],
        tipRanks,
      });
      app.setTaxonomyRankVisibilityAutoForTest(false);
      app.setTaxonomyRankVisibilityForTest("class", true);
      app.setTaxonomyRankVisibilityForTest("phylum", true);
      app.setShowGenusLabels(false);
      app.setViewMode("circular");
      app.setCircularRotationDegreesForTest(30);
      app.requestFit();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await settleFrames(page);

    const fitCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
    expect(fitCamera?.kind).toBe("circular");
    await page.evaluate((camera) => {
      if (!camera || camera.kind !== "circular") {
        throw new Error("Circular camera unavailable.");
      }
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
        scale: Number(camera.scale) * 1.08,
        translateX: Number(camera.translateX),
        translateY: Number(camera.translateY),
      });
    }, fitCamera);
    await settleFrames(page);

    const seamSamples = await page.evaluate(() => {
      const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
        taxonomyArcDebug?: Array<{
          key?: string | null;
          startTheta?: number | null;
          endTheta?: number | null;
          innerRadiusPx?: number | null;
          outerRadiusPx?: number | null;
        }>;
      } | undefined;
      const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
      const canvas = document.querySelector("canvas");
      if (!debug || !camera || camera.kind !== "circular" || !(canvas instanceof HTMLCanvasElement)) {
        throw new Error("Circular seam probe unavailable.");
      }
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        throw new Error("2D context unavailable.");
      }
      const wrapPositive = (angle: number): number => {
        const fullTurn = Math.PI * 2;
        let normalized = angle % fullTurn;
        if (normalized < 0) {
          normalized += fullTurn;
        }
        return normalized;
      };
      const renderedSpanContains = (
        startTheta: number,
        endTheta: number,
        targetTheta: number,
      ): boolean => {
        let start = wrapPositive(startTheta + Number(camera.rotation));
        let end = wrapPositive(endTheta + Number(camera.rotation));
        let target = wrapPositive(targetTheta);
        if (end < start) {
          end += Math.PI * 2;
        }
        if (target < start) {
          target += Math.PI * 2;
        }
        return target >= start && target <= end;
      };
      const background = [251, 252, 254, 255];
      const colorDistance = (rgba: Uint8ClampedArray): number => Math.hypot(
        rgba[0] - background[0],
        rgba[1] - background[1],
        rgba[2] - background[2],
        rgba[3] - background[3],
      );
      const probes = [
        { name: "phylum-top", rank: "phylum", theta: -Math.PI / 2 },
        { name: "phylum-bottom", rank: "phylum", theta: Math.PI / 2 },
        { name: "phylum-right", rank: "phylum", theta: 0 },
        { name: "phylum-left", rank: "phylum", theta: Math.PI },
        { name: "class-top", rank: "class", theta: -Math.PI / 2 },
        { name: "class-bottom", rank: "class", theta: Math.PI / 2 },
        { name: "class-right", rank: "class", theta: 0 },
        { name: "class-left", rank: "class", theta: Math.PI },
      ];
      return probes.map((probe) => {
        const arc = (debug.taxonomyArcDebug ?? [])
          .filter((entry) => (
            String(entry.key ?? "").startsWith(`${probe.rank}:`)
            && Number.isFinite(Number(entry.innerRadiusPx ?? Number.NaN))
            && Number.isFinite(Number(entry.outerRadiusPx ?? Number.NaN))
            && Number.isFinite(Number(entry.startTheta ?? Number.NaN))
            && Number.isFinite(Number(entry.endTheta ?? Number.NaN))
            && renderedSpanContains(Number(entry.startTheta ?? 0), Number(entry.endTheta ?? 0), probe.theta)
          ))
          .sort((left, right) => Number(right.outerRadiusPx ?? 0) - Number(left.outerRadiusPx ?? 0))[0];
        if (!arc) {
          throw new Error(`No ${probe.rank} arc crosses ${probe.name}.`);
        }
        const radiusPx = (Number(arc.innerRadiusPx ?? 0) + Number(arc.outerRadiusPx ?? 0)) * 0.5;
        const sampleX = Math.round(Number(camera.translateX) + (Math.cos(probe.theta) * radiusPx));
        const sampleY = Math.round(Number(camera.translateY) + (Math.sin(probe.theta) * radiusPx));
        let maxDistance = 0;
        for (const dx of [-1, 0, 1]) {
          for (const dy of [-1, 0, 1]) {
            const x = Math.max(0, Math.min(canvas.width - 1, sampleX + dx));
            const y = Math.max(0, Math.min(canvas.height - 1, sampleY + dy));
            const pixel = ctx.getImageData(x, y, 1, 1).data;
            maxDistance = Math.max(maxDistance, colorDistance(pixel));
          }
        }
        return {
          name: probe.name,
          maxDistance,
        };
      });
    });

    expect(seamSamples.every((sample) => Number(sample.maxDistance ?? 0) > 18)).toBeTruthy();
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

    const zoomFrames = snapshots.slice(1);
    expect(zoomFrames[0]?.circular?.branchRenderMode ?? "").toBe("taxonomy-cached-bitmap");
    for (const snapshot of zoomFrames) {
      expect(["taxonomy-cached-bitmap", "taxonomy-cached-paths"]).toContain(snapshot.circular?.branchRenderMode ?? "");
    }
    expect(Number(zoomFrames[zoomFrames.length - 1]?.timing?.totalMs ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(
      ZOOM_STYLED_TOTAL_MAX_MS,
    );
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
