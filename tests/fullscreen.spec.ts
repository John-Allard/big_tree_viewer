import { expect, test } from "@playwright/test";

test("full screen retains the side panel and exposes compact edge controls", async ({ page }) => {
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
  const panelControlsBounds = await page.locator(".panel-edge-controls").boundingBox();
  expect(fitBounds).not.toBeNull();
  expect(panelBounds).not.toBeNull();
  expect(panelControlsBounds).not.toBeNull();
  expect(fitBounds?.width ?? 0).toBeGreaterThan((panelBounds?.width ?? 0) * 0.75);
  expect(panelControlsBounds?.x ?? 0).toBeGreaterThan(panelBounds?.x ?? 0);
  expect((panelControlsBounds?.x ?? 0) + (panelControlsBounds?.width ?? 0))
    .toBeLessThan((panelBounds?.x ?? 0) + (panelBounds?.width ?? 0) - 8);

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
  const cameraAfterRestore = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
  expect(viewerWithOverlay).toEqual(viewerWithoutPanel);
  expect(cameraAfterRestore).toEqual(cameraBeforeRestore);
  expect(overlayPanelBounds?.x ?? 0).toBeLessThan((viewerWithOverlay?.x ?? 0) + (viewerWithOverlay?.width ?? 0));
  await page.getByRole("button", { name: "Exit full screen" }).click();
  await expect(app).not.toHaveClass(/app-shell-fullscreen/);
  await expect(page.getByRole("button", { name: "Enter full screen" })).toBeVisible();
});
