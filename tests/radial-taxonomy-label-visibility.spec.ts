import { expect, test } from "@playwright/test";

test("thin uniform radial ribbons retain labels that have enough arc length", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__,
  ));
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount ?? 0) > 0;
  });

  const result = await page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setViewMode("radial");
    app?.setRadialAngularSpanDegreesForTest(360);
    app?.setRadialCenterOpeningRatioForTest(0.85);
    app?.setFigureStyleForTest("taxonomy", "bandThicknessScale", 0.5);
    app?.setFigureStyleForTest("taxonomy", "thickenOutermostRibbon", false);
    app?.setTaxonomyRankVisibilityAutoForTest(false);
    app?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    type Candidate = {
      rank?: string;
      label?: string;
      accepted?: boolean;
      reason?: string;
      arcLengthPx?: number;
      fitFontSize?: number;
    };
    type CircularDebug = {
      taxonomyBandWidthsPx?: number[];
      taxonomyCandidateDebug?: Candidate[];
      taxonomyPlacedLabels?: Array<{ rank?: string; text?: string; fontSize?: number }>;
    };
    const circular = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.circular as CircularDebug | undefined;
    return {
      widths: circular?.taxonomyBandWidthsPx ?? [],
      targetCandidate: circular?.taxonomyCandidateDebug?.find((candidate) => (
        candidate.rank === "class" && candidate.label === "Chondrichthyes"
      )) ?? null,
      targetLabel: circular?.taxonomyPlacedLabels?.find((label) => (
        label.rank === "class" && label.text === "Chondrichthyes"
      )) ?? null,
    };
  });

  expect(result.widths.length).toBeGreaterThan(0);
  for (const width of result.widths) {
    expect(width).toBeCloseTo(result.widths[0], 5);
  }
  expect(result.targetCandidate?.accepted).toBe(true);
  expect(result.targetLabel?.fontSize).toBeGreaterThanOrEqual(3.5);
});
