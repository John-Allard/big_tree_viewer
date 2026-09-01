import { expect, test } from "@playwright/test";

test("tree viewport fullscreen uses a tucked expandable toolbar", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/");

  const enterButton = page.getByRole("button", { name: "Full Screen" });
  const fitBounds = await page.getByRole("button", { name: "Fit View" }).boundingBox();
  const enterBounds = await enterButton.boundingBox();
  expect(fitBounds).not.toBeNull();
  expect(enterBounds).not.toBeNull();
  expect(enterBounds?.x ?? 0).toBeLessThan(fitBounds?.x ?? 0);
  expect((fitBounds?.width ?? 0) / (enterBounds?.width ?? 1)).toBeCloseTo(3, 1);
  await enterButton.click();

  const viewer = page.locator(".viewer-panel");
  await expect(viewer).toHaveClass(/viewer-panel-fullscreen-fallback/);
  const toolbar = page.getByRole("toolbar", { name: "Full-screen tree controls" });
  const openToolbar = page.getByRole("button", { name: "Open full-screen toolbar" });
  await expect(toolbar).toBeVisible();
  await expect(openToolbar).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Exit Full Screen" })).toBeVisible();
  const bounds = await viewer.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds?.x).toBeCloseTo(0, 0);
  expect(bounds?.y).toBeCloseTo(0, 0);
  expect(bounds?.width).toBeCloseTo(viewport?.width ?? 0, 0);
  expect(bounds?.height).toBeCloseTo(viewport?.height ?? 0, 0);

  await expect(toolbar.getByRole("button", { name: "Fit View" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Zoom Both" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Zoom X" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Zoom Y" })).toBeVisible();
  const zoomLabelsFit = await toolbar.locator(".viewer-fullscreen-zoom-controls button").evaluateAll((buttons) => (
    buttons.every((button) => button.scrollWidth <= button.clientWidth)
  ));
  expect(zoomLabelsFit).toBe(true);
  await toolbar.getByRole("button", { name: "Hide full-screen toolbar" }).click();
  await expect(toolbar).toHaveCount(0);
  await expect(openToolbar).toBeVisible();

  await openToolbar.click();
  await page.getByRole("button", { name: "Exit Full Screen" }).click();
  await expect(viewer).not.toHaveClass(/viewer-panel-fullscreen/);
  await expect(page.getByRole("button", { name: "Full Screen" })).toBeVisible();
});
