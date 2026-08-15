import { expect, test } from "@playwright/test";

test("metadata guide presents the workflow with responsive images", async ({ page }) => {
  await page.goto("/#metadata");

  await expect(page.getByRole("heading", { name: "Using metadata" })).toBeVisible();
  await expect(page.getByText(/must match a tree label exactly/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose an overlay" })).toBeVisible();
  await expect(page.getByText("Matched branches", { exact: true })).toBeVisible();
  await expect(page.getByText("Matched subtrees", { exact: true })).toBeVisible();

  const images = page.locator(".metadata-guide-page img");
  await expect(images).toHaveCount(7);
  for (let index = 0; index < await images.count(); index += 1) {
    const image = images.nth(index);
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  const imageState = await images.evaluateAll((elements) => elements.map((image) => ({
    complete: (image as HTMLImageElement).complete,
    width: (image as HTMLImageElement).naturalWidth,
    height: (image as HTMLImageElement).naturalHeight,
  })));
  expect(imageState.every((image) => image.complete && image.width > 0 && image.height > 0)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("API documentation page is linked and documents launch parameters", async ({ page }) => {
  await page.goto("/#about");
  await expect(page.getByRole("link", { name: "API" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Share sessions" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Start tutorial" })).toBeVisible();
  await page.getByRole("link", { name: "API" }).click();

  await expect(page.getByRole("heading", { name: "Launch API" })).toBeVisible();
  await expect(page.getByText("btv_newick").first()).toBeVisible();
  await expect(page.getByText(/rectangular.*circular.*fan.*spiral/).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Large trees with postMessage" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Compact taxonomy handoff" })).toBeVisible();
  await expect(page.getByText("big-tree-viewer-compact-taxonomy").first()).toBeVisible();
  await expect(page.getByText("Metadata-driven branch colors")).toBeVisible();
});

test("share sessions page generates a launch link and QR code", async ({ page }) => {
  await page.goto("/#share");

  await expect(page.getByRole("heading", { name: "How to share your tree session" })).toBeVisible();
  await expect(page.getByAltText("Big Tree Viewer interface with the Save Session button highlighted in the Data panel.")).toBeVisible();
  await expect(page.getByText("Dropbox", { exact: true })).toBeVisible();
  await expect(page.getByText("OSF", { exact: true })).toBeVisible();
  await expect(page.getByText("Google Drive", { exact: true })).toBeVisible();
  await expect(page.getByText("Not suitable for direct BTV session links")).toBeVisible();

  await page.getByLabel("Static session file URL").fill("https://example.org/tree.btvsession");
  const expected = "http://127.0.0.1:4173/?btv_session_url=https%3A%2F%2Fexample.org%2Ftree.btvsession";
  await expect(page.getByLabel("Share link")).toHaveValue(expected);
  await expect(page.getByLabel("QR code for the Big Tree Viewer session link")).toBeVisible();

  await page.getByLabel("Static session file URL").fill("https://www.dropbox.com/scl/fi/token/tree.btvsession?rlkey=abc&dl=0");
  await expect(page.getByLabel("Share link")).toHaveValue(
    "http://127.0.0.1:4173/?btv_session_url=https%3A%2F%2Fdl.dropboxusercontent.com%2Fscl%2Ffi%2Ftoken%2Ftree.btvsession%3Frlkey%3Dabc%26dl%3D1",
  );
});

test("about page start tutorial link opens the guided tutorial in the viewer", async ({ page }) => {
  await page.goto("/#about");
  await page.getByRole("link", { name: "Start tutorial" }).click();

  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial step" })).toContainText("Load a tree");
  await expect(page.locator('[data-tour="data"]')).toHaveClass(/tour-highlight/);
  await expect(page).not.toHaveURL(/#tutorial$/);
});

test("tutorial prompt and tour are suppressed on mobile-sized viewports", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.removeItem("big-tree-viewer-tutorial-completed");
    window.localStorage.removeItem("big-tree-viewer-tutorial-dismissed");
  });
  await page.reload();

  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial" })).toHaveCount(0);
  const mobilePanelLayout = await page.evaluate(() => {
    const panel = document.querySelector(".control-panel")?.getBoundingClientRect();
    const title = document.querySelector(".panel-title-block h1")?.getBoundingClientRect();
    const button = document.querySelector(".mobile-sidebar-toggle-inline")?.getBoundingClientRect();
    return panel && title && button
      ? {
        titleTopOffset: title.top - panel.top,
        buttonTopOffset: button.top - panel.top,
      }
      : null;
  });
  expect(mobilePanelLayout).not.toBeNull();
  expect(mobilePanelLayout?.titleTopOffset ?? Number.POSITIVE_INFINITY).toBeLessThan(28);
  expect(mobilePanelLayout?.buttonTopOffset ?? Number.POSITIVE_INFINITY).toBeLessThan(28);
  await page.goto("/#tutorial");
  await expect(page.getByRole("dialog", { name: "Big Tree Viewer tutorial step" })).toHaveCount(0);
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
