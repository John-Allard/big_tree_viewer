import { expect, test } from "@playwright/test";

test("API documentation page is linked and documents launch parameters", async ({ page }) => {
  await page.goto("/#about");
  await expect(page.getByRole("link", { name: "API" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start tutorial" })).toBeVisible();
  await page.getByRole("link", { name: "API" }).click();

  await expect(page.getByRole("heading", { name: "Launch API" })).toBeVisible();
  await expect(page.getByText("btv_newick").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Large trees with postMessage" })).toBeVisible();
  await expect(page.getByText("Metadata-driven branch colors")).toBeVisible();
});

test("about page start tutorial link opens the guided tutorial in the viewer", async ({ page }) => {
  await page.goto("/#about");
  await page.getByRole("link", { name: "Start tutorial" }).click();

  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial step" })).toContainText("Load a tree");
  await expect(page.locator('[data-tour="data"]')).toHaveClass(/tour-highlight/);
  await expect(page).not.toHaveURL(/#tutorial$/);
});

test("new-user tutorial prompt can start, advance, and persist dismissal", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.removeItem("big-tree-viewer-tutorial-completed");
    window.localStorage.removeItem("big-tree-viewer-tutorial-dismissed");
  });
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial" })).toBeVisible();
  await page.getByRole("button", { name: "Start tutorial" }).first().click();

  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial step" })).toContainText("Load a tree");
  await expect(page.locator('[data-tour="data"]')).toHaveClass(/tour-highlight/);
  const dataTarget = await page.locator('[data-tour="data"]').boundingBox();
  const firstCard = await page.getByRole("dialog", { name: "Big Tree Viewer tutorial step" }).boundingBox();
  expect(dataTarget).toBeTruthy();
  expect(firstCard).toBeTruthy();
  expect(firstCard?.x ?? 0).toBeGreaterThan((dataTarget?.x ?? 0) + (dataTarget?.width ?? 0));

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial step" })).toContainText("Navigate the tree");
  await expect(page.locator('[data-tour="view"]')).toHaveClass(/tour-highlight/);

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial step" })).toContainText("Style the figure");
  await expect(page.locator('[data-tour="visual"]')).toHaveClass(/tour-highlight/);

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial step" })).toContainText("Map taxonomy");
  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial step" })).toContainText("automatically map binomial species tip names");
  await expect(page.locator('[data-tour="taxonomy"]')).toHaveClass(/tour-highlight/);

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial step" })).toContainText("Use the branch menu");
  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial step" })).toContainText("Right-click or control-click");
  await expect(page.locator('[data-tour="branch-menu-demo"]')).toHaveClass(/tour-highlight/);
  await expect(page.locator('[data-tour="branch-menu-demo"]')).toContainText("Right click to open this menu");
  await expect(page.locator('[data-tour="branch-menu-demo"]')).toContainText("Color Subtree");

  await page.getByRole("button", { name: "Stop" }).click();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial" })).toHaveCount(0);
});
