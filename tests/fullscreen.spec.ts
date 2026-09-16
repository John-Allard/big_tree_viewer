import { expect, test } from "@playwright/test";

async function waitForViewer(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true);
}

test("fit view uses the uncovered viewport after the side panel becomes an overlay", async ({ page }) => {
  await waitForViewer(page);
  await page.locator('.viewer-corner-controls button[aria-label="Hide side panel"]').click();
  await page.locator('.viewer-corner-controls button[aria-label="Show side panel"]').click();
  await page.waitForFunction(() => Number(
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewerLeftOcclusionPx ?? 0,
  ) > 300);

  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const result = await page.evaluate(() => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const canvas = document.querySelector("canvas")?.getBoundingClientRect();
    const panel = document.querySelector(".control-panel-shell")?.getBoundingClientRect();
    return {
      camera,
      canvasLeft: canvas?.left ?? 0,
      panelRight: panel?.right ?? 0,
    };
  });
  expect(result.camera?.kind).toBe("rect");
  expect(result.canvasLeft + Number(result.camera?.translateX ?? 0)).toBeGreaterThanOrEqual(result.panelRight + 24);

  await page.locator('.viewer-corner-controls button[aria-label="Hide side panel"]').click();
  await page.waitForFunction(() => Number(
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewerLeftOcclusionPx ?? -1,
  ) === 0);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const hiddenCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
  expect(hiddenCamera?.kind).toBe("rect");
  expect(Number(hiddenCamera?.translateX ?? 0)).toBeCloseTo(32, 0);
});

test("full screen retains the side panel and exposes compact viewport controls", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/");

  const app = page.locator(".app-shell");
  const panel = page.locator(".control-panel");
  const viewer = page.locator(".viewer-panel");
  const fitButton = page.getByRole("button", { name: "Fit View" });
  const enterButton = page.getByRole("button", { name: "Enter full screen" });
  const hidePanelButton = page.getByRole("button", { name: "Hide side panel" });

  await expect(fitButton).toBeVisible();
  await expect(page.getByRole("button", { name: "Full Screen", exact: true })).toHaveCount(0);
  const fitBounds = await fitButton.boundingBox();
  const panelBounds = await panel.boundingBox();
  const viewerBounds = await viewer.boundingBox();
  const viewerControlsBounds = await page.locator(".viewer-corner-controls").boundingBox();
  expect(fitBounds).not.toBeNull();
  expect(panelBounds).not.toBeNull();
  expect(viewerBounds).not.toBeNull();
  expect(viewerControlsBounds).not.toBeNull();
  expect(fitBounds?.width ?? 0).toBeGreaterThan((panelBounds?.width ?? 0) * 0.75);
  expect(viewerControlsBounds?.x ?? 0).toBeGreaterThanOrEqual(viewerBounds?.x ?? 0);
  expect(viewerControlsBounds?.x ?? Number.POSITIVE_INFINITY).toBeLessThan((viewerBounds?.x ?? 0) + 50);
  expect(viewerControlsBounds?.x ?? 0).toBeGreaterThanOrEqual(panelBounds?.x ? panelBounds.x + panelBounds.width : 0);

  await enterButton.click();
  await expect(app).toHaveClass(/app-shell-fullscreen-fallback/);
  await expect(panel).toBeVisible();
  await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible();

  const viewerWithPanel = await viewer.boundingBox();
  await hidePanelButton.click();
  await expect(app).toHaveClass(/sidebar-hidden/);
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "Show side panel" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible();
  const viewerWithoutPanel = await viewer.boundingBox();
  expect(viewerWithPanel).not.toBeNull();
  expect(viewerWithoutPanel).not.toBeNull();
  expect(viewerWithoutPanel?.width ?? 0).toBeGreaterThan(viewerWithPanel?.width ?? 0);

  const cameraBeforeRestore = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
  await page.getByRole("button", { name: "Show side panel" }).click();
  await expect(panel).toBeVisible();
  const viewerWithOverlay = await viewer.boundingBox();
  const overlayPanelBounds = await panel.boundingBox();
  const overlayControlsBounds = await page.locator(".viewer-corner-controls").boundingBox();
  const cameraAfterRestore = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
  expect(viewerWithOverlay).toEqual(viewerWithoutPanel);
  expect(cameraAfterRestore).toEqual(cameraBeforeRestore);
  expect(overlayPanelBounds?.x ?? 0).toBeLessThan((viewerWithOverlay?.x ?? 0) + (viewerWithOverlay?.width ?? 0));
  expect(overlayControlsBounds?.x ?? 0).toBeGreaterThanOrEqual(
    (overlayPanelBounds?.x ?? 0) + (overlayPanelBounds?.width ?? 0),
  );
  await page.getByRole("button", { name: "Exit full screen" }).click();
  await expect(app).not.toHaveClass(/app-shell-fullscreen/);
  await expect(page.getByRole("button", { name: "Enter full screen" })).toBeVisible();
});
