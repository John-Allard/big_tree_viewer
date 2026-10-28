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
  expect(buildCircularScaleBar(100, 100, 600, 400, [{ value: 0, alpha: 1 }], () => 180)).toBeNull();
  const radii = [60, 120, 180, 240];
  const right = choosePartialRadialScale(300, 200, 600, 600, 0, 0, 300, Math.PI, 0, radii);
  expect(right.theta).toBe(0);
  const left = choosePartialRadialScale(470, 200, 600, 600, 0, 0, 300, Math.PI, 0, radii);
  expect(left.theta).toBe(Math.PI);
  expect(left.visibleFraction).toBe(1);
  expect(left.offsetPx).toBe(-14);
  const pacman = choosePartialRadialScale(520, 200, 600, 600, 0, 0, 300, Math.PI / 3, 0, radii);
  expect(pacman.theta).toBeCloseTo(Math.PI / 3 * 0.9);
  expect(pacman.visibleFraction).toBeGreaterThan(0);
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
  await page.evaluate(() => {
    const canvas = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect();
    window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setCircularCamera({ scale: 0.5, translateX: canvas.width - 100, translateY: 500 });
  });
  await expect.poll(async () => Number((await debug()).radialScaleTheta)).toBeCloseTo(Math.PI);
  await expect.poll(async () => (await debug()).scaleBarPlacement).toBe("radial");
  await page.screenshot({ path: testInfo.outputPath("fan-left-scale.png") });
});

for (const span of [180, 300]) {
  test(`${span}-degree radial scale stays in the gap, rotates, and can be disabled`, async ({ page }, testInfo) => {
    await page.goto(`/?btv_api=1&btv_newick=${encodeURIComponent("((A:500,B:500):500,(C:500,D:500):500)Root;")}&btv_view=circular&btv_radial_span=${span}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    const debug = () => page.evaluate(() => {
      window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest();
      return window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as Record<string, unknown>;
    });
    await expect.poll(async () => (await debug()).showCenterRadialScaleBar).toBe(true);
    expect((await debug()).scaleBarPlacement).toBe("radial");
    const angle = span === 180 ? 0 : Math.PI / 6;
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
    if (span === 300) {
      await page.evaluate(() => {
        const width = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect().width;
        window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setCircularCamera({ scale: 0.3, translateX: width - 64, translateY: 200 });
      });
      await expect.poll(async () => Number((await debug()).radialScaleTheta)).toBeCloseTo(Math.PI / 3 * 0.9);
      await expect.poll(async () => (await debug()).scaleBarPlacement).toBe("right");
      await page.screenshot({ path: testInfo.outputPath("pacman-relocated-scale.png") });
    }
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const canvas = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect();
      const camera = api.getCamera()!;
      if (camera.kind === "circular") api.setCircularCamera({ scale: camera.scale * 3, translateY: canvas.height + 100 });
    });
    await expect.poll(async () => (await debug()).scaleBarPlacement).toMatch(/^(bottom|left|right)$/);
    await page.screenshot({ path: testInfo.outputPath(`radial-${span}-edge.png`) });
  });
}
