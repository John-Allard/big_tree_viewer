import { expect, test } from "@playwright/test";
import { clampCircularCamera } from "../src/components/treeCanvasCamera";
import type { CircularCamera } from "../src/components/treeCanvasTypes";
import type { TreeModel } from "../src/types/tree";

const TEST_TREE = {
  maxDepth: 100,
  branchLengthMinPositive: 1,
} as TreeModel;

function circularCamera(translateX: number, translateY: number): CircularCamera {
  return {
    kind: "circular",
    scale: 10,
    translateX,
    translateY,
    rotation: 0,
    rotationCos: 1,
    rotationSin: 0,
  };
}

test("circular camera retains the visible tree margin when panned past a corner", () => {
  const camera = circularCamera(-100_000, -100_000);

  clampCircularCamera(camera, TEST_TREE, 800, 600);

  const treeRadiusPx = TEST_TREE.maxDepth * camera.scale;
  const distanceFromViewport = Math.hypot(camera.translateX, camera.translateY);
  expect(treeRadiusPx - distanceFromViewport).toBeCloseTo(56, 6);
});

test("circular camera keeps the existing edge limit away from corners", () => {
  const camera = circularCamera(-100_000, 300);

  clampCircularCamera(camera, TEST_TREE, 800, 600);

  expect(camera.translateX).toBe(-944);
  expect(camera.translateY).toBe(300);
});

test("circular camera padding cannot move the actual tree entirely offscreen", () => {
  const camera = circularCamera(-100_000, 300);

  clampCircularCamera(camera, TEST_TREE, 800, 600, 240);

  const treeRadiusPx = TEST_TREE.maxDepth * camera.scale;
  expect(treeRadiusPx + camera.translateX).toBeCloseTo(8, 6);
  expect(camera.translateY).toBe(300);
});

test("circular corner pan leaves rendered tree content in every viewport corner", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__,
  ));

  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowTipLabels(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowGenusLabels(true);
  });
  await page.waitForFunction(() => (
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === "circular"
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()?.kind === "circular"
  ));

  const cornerPixelCounts = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const canvas = document.querySelector("canvas");
    const fitCamera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!(canvas instanceof HTMLCanvasElement) || !fitCamera || fitCamera.kind !== "circular") {
      throw new Error("Circular viewer unavailable.");
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Canvas context unavailable.");
    }

    const corners = [
      { x: -1_000_000, y: -1_000_000, left: true, top: true },
      { x: 1_000_000, y: -1_000_000, left: false, top: true },
      { x: -1_000_000, y: 1_000_000, left: true, top: false },
      { x: 1_000_000, y: 1_000_000, left: false, top: false },
    ];
    const sampleSizeCssPx = 120;
    const counts: number[] = [];
    for (const corner of corners) {
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
        scale: fitCamera.scale * 10,
        translateX: corner.x,
        translateY: corner.y,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const sampleWidth = Math.round(sampleSizeCssPx * scaleX);
      const sampleHeight = Math.round(sampleSizeCssPx * scaleY);
      const startX = corner.left ? 0 : canvas.width - sampleWidth;
      const startY = corner.top ? 0 : canvas.height - sampleHeight;
      const pixels = ctx.getImageData(startX, startY, sampleWidth, sampleHeight).data;
      let darkPixels = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 180 && pixels[index + 1] < 180 && pixels[index + 2] < 180) {
          darkPixels += 1;
        }
      }
      counts.push(darkPixels);
    }
    return counts;
  });

  for (const darkPixelCount of cornerPixelCounts) {
    expect(darkPixelCount).toBeGreaterThan(10);
  }
});
