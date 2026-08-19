import { expect, test } from "@playwright/test";

test("radial geometry supports custom spans and center openings", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__,
  ));
  const tutorialClose = page.getByRole("button", { name: "Close tutorial prompt" });
  if (await tutorialClose.count()) {
    await tutorialClose.click();
  }

  await page.getByRole("button", { name: "Radial", exact: true }).click();
  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setRadialAngularSpanDegreesForTest(210);
    app?.setRadialCenterOpeningRatioForTest(0.55);
    app?.requestFit();
  });
  await page.waitForFunction(() => {
    const radial = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.radial as Record<string, unknown> | undefined;
    return Number(radial?.angularSpanDegrees) === 210
      && Math.abs(Number(radial?.centerOpeningRatio) - 0.55) < 1e-6;
  });

  const result = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const camera = canvas?.getCamera();
    const radial = canvas?.getRenderDebug()?.radial as Record<string, unknown> | undefined;
    const canvasElement = document.querySelector("[data-testid=tree-canvas]");
    const root = internal?.parent?.findIndex((parent) => parent < 0) ?? -1;
    const rootChild = root >= 0 ? Number(internal?.firstChild?.[root] ?? -1) : -1;
    const rootChildSegment = rootChild >= 0 ? canvas?.getBranchScreenSegmentForTest(rootChild) : null;
    if (!camera || camera.kind !== "circular" || !radial || !rootChildSegment || !(canvasElement instanceof HTMLCanvasElement)) {
      throw new Error("Radial geometry test state unavailable.");
    }
    const scale = Number(camera.scale);
    const rotation = Number(camera.rotation);
    const dx = (rootChildSegment.x1 - Number(camera.translateX)) / scale;
    const dy = (rootChildSegment.y1 - Number(camera.translateY)) / scale;
    const unrotatedX = (dx * Math.cos(rotation)) + (dy * Math.sin(rotation));
    const unrotatedY = (-dx * Math.sin(rotation)) + (dy * Math.cos(rotation));
    return {
      angularSpanDegrees: Number(radial.angularSpanDegrees),
      centerOpeningRatio: Number(radial.centerOpeningRatio),
      innerRadiusWorld: Number(radial.innerRadiusWorld),
      outerRadiusWorld: Number(radial.outerRadiusWorld),
      rootRadiusWorld: Math.hypot(unrotatedX, unrotatedY),
      viewport: {
        width: canvasElement.getBoundingClientRect().width,
        height: canvasElement.getBoundingClientRect().height,
      },
      taxonomyBounds: canvas.getTaxonomyArcHitboxes()
        .map((hitbox) => hitbox.screenPolygonBounds as { left: number; right: number; top: number; bottom: number } | undefined)
        .filter((bounds): bounds is { left: number; right: number; top: number; bottom: number } => Boolean(bounds)),
    };
  });

  expect(result.angularSpanDegrees).toBe(210);
  expect(result.centerOpeningRatio).toBeCloseTo(0.55, 6);
  expect(result.innerRadiusWorld).toBeGreaterThan(0);
  expect(result.innerRadiusWorld / result.outerRadiusWorld).toBeCloseTo(0.55, 6);
  expect(result.rootRadiusWorld).toBeCloseTo(result.innerRadiusWorld, 5);
  for (const bounds of result.taxonomyBounds) {
    expect(bounds.left).toBeGreaterThanOrEqual(-2);
    expect(bounds.right).toBeLessThanOrEqual(result.viewport.width + 2);
    expect(bounds.top).toBeGreaterThanOrEqual(-2);
    expect(bounds.bottom).toBeLessThanOrEqual(result.viewport.height + 2);
  }
  await expect(page.getByRole("button", { name: "Circular" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fan", exact: true })).toHaveCount(0);
});

test("legacy fan mode remains an upper semicircle compatibility preset", async ({ page }) => {
  await page.goto("/?btv_newick=((A:1,B:1):1,(C:1,D:1):1)Root;&btv_view=fan");
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true);
  const radial = await page.evaluate(() => (
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.radial as Record<string, unknown> | undefined
  ));
  expect(Number(radial?.angularSpanDegrees)).toBe(180);
  expect(Number(radial?.centerOpeningRatio)).toBe(0);
  await expect(page.getByRole("button", { name: "Radial", exact: true })).toHaveClass(/active/);
});

test("URL API accepts radial geometry settings", async ({ page }) => {
  await page.goto("/?btv_newick=((A:1,B:1):1,(C:1,D:1):1)Root;&btv_view=radial&btv_radial_span=240&btv_radial_opening=0.4");
  await page.waitForFunction(() => {
    const radial = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.radial as Record<string, unknown> | undefined;
    return window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true
      && Number(radial?.angularSpanDegrees) === 240;
  });
  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState());
  const radial = await page.evaluate(() => (
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.radial as Record<string, unknown> | undefined
  ));
  expect(state?.viewMode).toBe("circular");
  expect(Number(radial?.centerOpeningRatio)).toBeCloseTo(0.4, 6);
});

test("custom radial arcs remain visible on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto("/?btv_view=radial&btv_radial_span=180&btv_radial_opening=0.5");
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit());
  await page.waitForTimeout(200);
  const pixels = await page.locator("[data-testid=tree-canvas]").evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) {
      return { width: 0, height: 0, nonBackgroundSamples: 0 };
    }
    const context = element.getContext("2d");
    if (!context) {
      return { width: element.width, height: element.height, nonBackgroundSamples: 0 };
    }
    const data = context.getImageData(0, 0, element.width, element.height).data;
    let nonBackgroundSamples = 0;
    for (let index = 0; index < data.length; index += 64) {
      if (data[index] < 245 || data[index + 1] < 245 || data[index + 2] < 245) {
        nonBackgroundSamples += 1;
      }
    }
    return { width: element.width, height: element.height, nonBackgroundSamples };
  });
  expect(pixels.width).toBeGreaterThan(300);
  expect(pixels.height).toBeGreaterThan(300);
  expect(pixels.nonBackgroundSamples).toBeGreaterThan(100);
  await expect(page.getByRole("button", { name: "Radial", exact: true })).toHaveClass(/active/);
});
