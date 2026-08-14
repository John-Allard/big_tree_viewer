import { expect, test } from "@playwright/test";
import path from "node:path";

test("loads, displays, and disables a comparison tree", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("((A:1,B:1):1,(C:1,D:1):1)Primary;");
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));

  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.getByRole("button", { name: "Paste Newick" }).click();
  await panel.getByPlaceholder("Paste the comparison tree in Newick or NEXUS format").fill("((A:1,C:1):1,(B:1,D:1):1)Comparison;");
  await panel.getByRole("button", { name: "Load Comparison" }).click();

  const comparisonCanvas = page.getByLabel("Tree comparison view");
  await expect(comparisonCanvas).toBeVisible();
  await expect(page.locator(".tree-comparison-summary")).toContainText("4 shared tips");
  await expect(panel).toContainText("pasted comparison tree: 4 tips");

  const nonWhitePixels = await comparisonCanvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) {
      return 0;
    }
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] < 240 || data[index + 1] < 240 || data[index + 2] < 240) {
        count += 1;
      }
    }
    return count;
  });
  expect(nonWhitePixels).toBeGreaterThan(100);

  await panel.getByRole("button", { name: "Turn Off Comparison" }).click();
  await expect(comparisonCanvas).toBeHidden();
  await expect(page.getByTestId("tree-canvas")).toBeVisible();
});

test("bundled example comparison fixture matches every example-tree tip", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.getByRole("button", { name: "Load Example" }).click();
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && !Boolean(state?.loading);
  });

  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.locator('input[type="file"]').setInputFiles(path.resolve("public/example_comparison_tree.nwk"));

  await expect(page.getByLabel("Tree comparison view")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".tree-comparison-summary")).toHaveText("50,033 shared tips", { timeout: 30_000 });
  await expect(panel).toContainText("example_comparison_tree.nwk: 50,033 tips");
});
