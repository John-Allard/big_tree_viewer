import { expect, test, type Page } from "@playwright/test";

type ViewMode = "rectangular" | "circular" | "spiral";

interface ThicknessSample {
  spacing: number;
  multiplier: number;
  renderedScale: number;
  sliderScale: number;
}

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__
    && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded,
  ));
}

async function configureMode(page: Page, mode: ViewMode): Promise<void> {
  await page.evaluate((nextMode) => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode(nextMode);
  }, mode);
  await page.waitForFunction((nextMode) => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const expectedCameraKind = nextMode === "rectangular" ? "rect" : "circular";
    return state?.viewMode === nextMode && camera?.kind === expectedCameraKind;
  }, mode);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function sampleAtSpacing(page: Page, targetSpacing: number): Promise<ThicknessSample> {
  return page.evaluate(async (spacing) => {
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const camera = canvas?.getCamera();
    const before = canvas?.getRenderDebug() as { tipSpacingPx?: number } | null | undefined;
    if (!canvas || !app || !camera || !(Number(before?.tipSpacingPx) > 0)) {
      throw new Error("Branch-thickness zoom test controls unavailable.");
    }
    const scaleRatio = spacing / Number(before?.tipSpacingPx);
    if (camera.kind === "rect") {
      canvas.setRectCamera({ scaleY: Number(camera.scaleY) * scaleRatio });
    } else {
      canvas.setCircularCamera({ scale: Number(camera.scale) * scaleRatio });
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const debug = canvas.getRenderDebug() as {
      tipSpacingPx?: number;
      branchStrokeAutoMultiplier?: number;
      renderedBranchStrokeScale?: number;
    } | null | undefined;
    return {
      spacing: Number(debug?.tipSpacingPx),
      multiplier: Number(debug?.branchStrokeAutoMultiplier),
      renderedScale: Number(debug?.renderedBranchStrokeScale),
      sliderScale: Number(app.getState().branchThicknessScale),
    };
  }, targetSpacing);
}

test("branch strokes thicken gradually after full tip labels appear", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await waitForViewer(page);
  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setBranchThicknessScaleForTest(1.6);
  });

  const configurations: Array<{ mode: ViewMode; threshold: number }> = [
    { mode: "rectangular", threshold: 4.2 },
    { mode: "circular", threshold: 4.5 },
    { mode: "spiral", threshold: 2.9 },
  ];
  for (const { mode, threshold } of configurations) {
    await configureMode(page, mode);
    const samples: ThicknessSample[] = [];
    for (const spacing of [threshold, threshold + 0.1, 12, 24]) {
      samples.push(await sampleAtSpacing(page, spacing));
    }

    expect(samples[0].multiplier).toBeCloseTo(1, 6);
    expect(samples[1].multiplier).toBeGreaterThanOrEqual(1);
    expect(samples[1].multiplier).toBeLessThan(1.001);
    expect(samples[2].multiplier).toBeGreaterThan(1.1);
    expect(samples[2].multiplier).toBeLessThan(1.25);
    expect(samples[3].multiplier).toBeCloseTo(1.45, 6);
    expect(samples.map((sample) => sample.multiplier)).toEqual(
      [...samples].map((sample) => sample.multiplier).sort((left, right) => left - right),
    );
    for (const sample of samples) {
      expect(sample.sliderScale).toBeCloseTo(1.6, 6);
      expect(sample.renderedScale).toBeCloseTo(1.6 * sample.multiplier, 6);
    }
  }
});
