import { expect, test } from "@playwright/test";
import { buildCircularScaleBar, choosePartialRadialScale } from "../src/components/treeCanvasUtils";
import { parseSharedSubtreeStoragePayload } from "../src/lib/sharedSubtreePayload";

test("partial radial scale preference survives shared subtree settings", () => {
  for (const enabled of [true, false]) {
    const parsed = parseSharedSubtreeStoragePayload(JSON.stringify({
      version: 2, newick: "(A:1,B:1);", visual: {
        viewMode: "circular", radialAngularSpanDegrees: 180,
        figureStyles: { scale: { showPartialRadialScaleBar: enabled } },
      },
    }));
    expect(parsed.visual?.figureStyles.scale.showPartialRadialScaleBar).toBe(enabled);
  }
});

test("edge scales exclude intersections in a fan's missing half", () => {
  const boundaries = [{ value: 1, alpha: 1 }, { value: 2, alpha: 1 }];
  const radius = (boundary: { value: number }) => boundary.value * 100;
  expect(buildCircularScaleBar(300, 200, 600, 400, boundaries, radius)).not.toBeNull();
  expect(buildCircularScaleBar(300, 200, 600, 400, boundaries, radius,
    { start: Math.PI, span: Math.PI })).toBeNull();
  const sliced = buildCircularScaleBar(300, 420, 600, 400, boundaries, radius,
    { start: Math.PI, span: Math.PI });
  expect(sliced?.kind).toBe("bottom");
  for (const tick of sliced!.ticks) {
    expect(Math.hypot(tick.position - 300, sliced!.axisPosition - 420)).toBeCloseTo(radius(tick.boundary));
  }
});

test("zero ticks do not select an edge axis and opening scales choose a visible side", () => {
  expect(buildCircularScaleBar(580, 200, 600, 400,
    [{ value: 1, alpha: 1 }, { value: 2, alpha: 1 }], (boundary) => boundary.value * 60)).toBeNull();
  expect(buildCircularScaleBar(100, 100, 600, 400, [{ value: 0, alpha: 1 }], () => 180)).toBeNull();
  const radii = [60, 120, 180, 240];
  const right = choosePartialRadialScale(300, 200, 600, 600, 0, 0, 300, Math.PI, 0, radii);
  expect(right.theta).toBe(0);
  const left = choosePartialRadialScale(470, 200, 600, 600, 0, 0, 300, Math.PI, 0, radii);
  expect(left.theta).toBe(Math.PI);
  expect(left.visibleFraction).toBe(1);
  expect(left.offsetPx).toBe(-14);
  // The preferred side is still over half visible, but the other side is complete.
  const mostlyRight = choosePartialRadialScale(400, 200, 600, 600, 0, 0, 300, Math.PI, 0, radii);
  expect(mostlyRight.theta).toBe(Math.PI);
  const bothVisible = choosePartialRadialScale(300, 200, 600, 600, 0, 0, 200, Math.PI, 0, radii);
  expect(bothVisible.theta).toBe(0);
  const rotated = choosePartialRadialScale(300, 300, 600, 600, 0, 0, 200, Math.PI, Math.PI, radii);
  expect(rotated.theta).toBe(Math.PI);
  const pacman = choosePartialRadialScale(520, 200, 600, 600, 0, 0, 300, Math.PI / 3, 0, radii);
  expect(pacman.theta).toBeCloseTo(Math.PI / 3);
  expect(pacman.visibleFraction).toBeGreaterThan(0);
});

test("a densely ticked visible fan base wins even when most of its full length is off-screen", async ({ page }, testInfo) => {
  await page.goto(`/?btv_newick=${encodeURIComponent("((A:500,B:500):500,(C:500,D:500):500)Root;")}&btv_view=fan`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: /Visual Options/ }).click();
  await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
  await page.getByLabel("Tick interval", { exact: true }).fill("10");
  for (const scale of [2, 2.5, 3]) {
    await page.evaluate((scale) => {
      const width = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect().width;
      window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setCircularCamera({ scale, translateX: width + 28, translateY: 300 });
    }, scale);
    const debug = () => page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as Record<string, unknown>);
    await expect.poll(async () => (await debug()).scaleBarPlacement).toBe("radial");
    expect(Number((await debug()).radialScaleVisibleFraction)).toBeLessThan(0.5);
    expect(Number((await debug()).radialScaleTheta)).toBeCloseTo(Math.PI);
    expect(Number((await debug()).viewportScaleIntersections)).toBeGreaterThan(0);
    expect(Number((await debug()).openingScaleIntersections)).toBeGreaterThan(Number((await debug()).viewportScaleIntersections));
    await page.getByLabel("Show zero tick", { exact: true }).check();
    await expect.poll(async () => (await debug()).scaleBarPlacement).toBe("radial");
  }
  await page.screenshot({ path: testInfo.outputPath("visible-fan-base-dominates.png") });
});

test("opening scales remain parallel to an actual edge as angular span increases", () => {
  for (const span of [180, 181, 200, 240, 269]) {
    const gap = (360 - span) * Math.PI / 180;
    const placement = choosePartialRadialScale(300, 300, 600, 600, 0, 0, 200, gap, 0, [50, 100, 150]);
    expect(placement.theta).toBe(0);
    expect(placement.offsetPx).toBe(14);
    const cropped = choosePartialRadialScale(520, 300, 600, 600, 0, 0, 200, gap, 0, [50, 100, 150]);
    expect([0, gap]).toContain(cropped.theta);
  }
});

test("a cropped fan keeps its opening scale with zero enabled and moves it left when needed", async ({ page }, testInfo) => {
  await page.goto(`/?btv_newick=${encodeURIComponent("((A:500,B:500):500,(C:500,D:500):500)Root;")}&btv_view=fan`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: /Visual Options/ }).click();
  await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
  const debug = () => page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as Record<string, unknown>);
  await page.evaluate(() => {
    const inset = window.__BIG_TREE_VIEWER_APP_TEST__!.getState().viewerLeftOcclusionPx ?? 0;
    window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setCircularCamera({ scale: 0.2, translateX: inset + 150, translateY: 400 });
  });
  await expect.poll(async () => (await debug()).scaleBarPlacement).toBe("radial");
  await page.getByLabel("Show zero tick", { exact: true }).check();
  await expect.poll(async () => (await debug()).scaleBarPlacement).toBe("radial");
  await page.screenshot({ path: testInfo.outputPath("fan-cropped-zero.png") });
  for (const rightSpace of [300, 100]) {
    await page.evaluate((rightSpace) => {
      const canvas = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect();
      window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setCircularCamera({ scale: 0.5, translateX: canvas.width - rightSpace, translateY: 500 });
    }, rightSpace);
    await expect.poll(async () => Number((await debug()).radialScaleTheta)).toBeCloseTo(Math.PI);
    await expect.poll(async () => (await debug()).scaleBarPlacement).toBe("radial");
  }
  await page.screenshot({ path: testInfo.outputPath("fan-left-scale.png") });
});

for (const span of [180, 240]) {
  test(`${span}-degree radial scale stays in the gap, rotates, and can be disabled`, async ({ page }, testInfo) => {
    await page.goto(`/?btv_api=1&btv_newick=${encodeURIComponent("((A:500,B:500):500,(C:500,D:500):500)Root;")}&btv_view=circular&btv_radial_span=${span}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    const debug = () => page.evaluate(() => {
      window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest();
      return window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as Record<string, unknown>;
    });
    await expect.poll(async () => (await debug()).showCenterRadialScaleBar).toBe(true);
    expect((await debug()).scaleBarPlacement).toBe("radial");
    const angle = 0;
    expect((await debug()).radialScaleTheta).toBeCloseTo(angle);
    await page.getByRole("button", { name: /Visual Options/ }).click();
    await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
    await expect(page.getByLabel("Extend rectangular scale to next tick", { exact: true })).toHaveCount(0);
    const toggle = page.getByLabel("Show circular radial scale bar", { exact: true });
    await expect(toggle).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath(`radial-${span}.png`) });
    await toggle.uncheck();
    await expect.poll(async () => (await debug()).showCenterRadialScaleBar).toBe(false);
    const hiddenSvg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()!);
    expect(hiddenSvg).not.toContain('stroke="#6b7280"');
    expect(hiddenSvg).not.toContain('fill="#6b7280"');
    await toggle.check();
    await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setCircularRotationDegreesForTest(90));
    await page.waitForFunction(() => {
      const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera();
      return camera?.kind === "circular" && Math.abs(camera.rotation - Math.PI / 2) < 1e-6;
    });
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    await expect.poll(async () => (await debug()).scaleBarPlacement).toBe("radial");
    await expect.poll(async () => Number((await debug()).radialScaleTheta)).toBeCloseTo(angle + Math.PI / 2);
    await page.screenshot({ path: testInfo.outputPath(`radial-${span}-rotated.png`) });
    // Pan the center below the viewport so the actual upper arc cuts its bottom edge.
    await page.evaluate(() => {
      window.__BIG_TREE_VIEWER_APP_TEST__!.setCircularRotationDegreesForTest(0);
    });
    await page.waitForFunction(() => {
      const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera();
      return camera?.kind === "circular" && Math.abs(camera.rotation) < 1e-6;
    });
    if (span === 240) {
      await page.evaluate(() => {
        const width = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect().width;
        window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setCircularCamera({ scale: 0.3, translateX: width - 64, translateY: 200 });
      });
      await expect.poll(async () => Number((await debug()).radialScaleTheta)).toBeCloseTo(Math.PI * 2 / 3);
      await expect.poll(async () => (await debug()).scaleBarPlacement).toBe("radial");
      await page.screenshot({ path: testInfo.outputPath("pacman-relocated-scale.png") });
    }
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const canvas = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect();
      const camera = api.getCamera()!;
      if (camera.kind === "circular") api.setCircularCamera({ scale: camera.scale * 3, translateY: canvas.height + 100 });
    });
    await expect.poll(async () => (await debug()).scaleBarPlacement).toMatch(/^(bottom|left)$/);
    await page.screenshot({ path: testInfo.outputPath(`radial-${span}-edge.png`) });
  });
}

test("270 degrees and larger partial circles use central labels without an edge bar", async ({ page }, testInfo) => {
  await page.goto(`/?btv_newick=${encodeURIComponent("((A:500,B:500):500,(C:500,D:500):500)Root;")}&btv_view=circular&btv_radial_span=269`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  for (const span of [269, 270, 300, 359, 269]) {
    await page.evaluate((span) => window.__BIG_TREE_VIEWER_APP_TEST__!.setRadialAngularSpanDegreesForTest(span), span);
    const debug = () => page.evaluate(() => {
      const svg = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()!;
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      return { ...(window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as Record<string, unknown>),
        axes: doc.querySelectorAll('line[stroke="#6b7280"]').length,
        labels: doc.querySelectorAll('text[fill="#6b7280"]').length };
    });
    await expect.poll(async () => (await debug()).showCenterRadialScaleBar).toBe(span < 270);
    await expect.poll(async () => (await debug()).showCentralScaleLabels).toBe(true);
    expect((await debug()).labels).toBeGreaterThan(0);
    if (span >= 270) {
      expect((await debug()).axes).toBe(0);
      expect((await debug()).centerScaleLabelRotationRadians).toBe(0);
      expect(Number((await debug()).radialScaleTheta)).toBeCloseTo(-Number((await debug()).centerScaleAngleDegrees) * Math.PI / 180);
      await page.screenshot({ path: testInfo.outputPath(`labels-only-${span}.png`) });
    }
  }
});
