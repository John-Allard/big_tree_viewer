import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, strFromU8 } from "fflate";

test("loads, displays, and disables a comparison tree", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("((A:1,B:1):1,(C:1,D:1):1)Primary;");
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));
  await page.evaluate(() => {
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const camera = canvas?.getCamera();
    if (!canvas || camera?.kind !== "rect") {
      throw new Error("Rectangular camera unavailable.");
    }
    canvas.setRectCamera({
      scaleX: Number(camera.scaleX) * 1.25,
      scaleY: Number(camera.scaleY) * 2,
      translateX: Number(camera.translateX) - 18,
      translateY: Number(camera.translateY) + 27,
    });
  });
  const originalCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());

  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.getByRole("button", { name: "Paste Newick" }).click();
  await panel.getByPlaceholder("Paste the comparison tree in Newick or NEXUS format").fill("((A:1,C:1):1,(B:1,D:1):1)Comparison;");
  await panel.getByRole("button", { name: "Load Comparison" }).click();

  const comparisonCanvas = page.getByLabel("Tree comparison view");
  await expect(comparisonCanvas).toBeVisible();
  await expect(page.locator(".tree-comparison-summary")).toContainText("4 shared tips");
  await expect(panel).toContainText("pasted comparison tree: 4 tips");
  await expect(panel.getByLabel("Comparison statistics")).toContainText("Normalized RF");
  await expect(panel.getByLabel("Comparison statistics").locator("dd").filter({ hasText: "1.0000" })).toHaveCount(1);
  await expect(panel.getByLabel("Comparison statistics")).not.toContainText("Matching-cluster");
  await expect(page.getByRole("button", { name: "Circular" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Fan" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Spiral" })).toBeDisabled();
  await page.waitForFunction(() => Number(
    window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().maximumDiscordance ?? 0,
  ) > 0);

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
  const restoredCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
  expect(restoredCamera).toEqual(originalCamera);
});

test("comparison tree and linked camera survive a session round trip", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("((A:1,B:1):1,(C:1,D:1):1)Primary;");
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));
  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.getByRole("button", { name: "Paste Newick" }).click();
  await panel.getByPlaceholder("Paste the comparison tree in Newick or NEXUS format").fill("((A:1,C:1):1,(B:1,D:1):1)Comparison;");
  await panel.getByRole("button", { name: "Load Comparison" }).click();
  await panel.getByRole("checkbox", { name: /Show red X marks/ }).check();
  const canvas = page.getByLabel("Tree comparison view");
  await canvas.hover({ position: { x: 500, y: 300 } });
  await page.mouse.wheel(0, -600);
  await page.waitForFunction(() => Number(
    (window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().camera as { zoom?: number } | undefined)?.zoom ?? 0,
  ) > 1.5);
  const savedCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().camera);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session" }).click();
  const download = await downloadPromise;
  const savedPath = await download.path();
  expect(savedPath).toBeTruthy();
  const session = JSON.parse(strFromU8(gunzipSync(await readFile(savedPath as string))));
  expect(session.comparison?.enabled).toBe(true);
  expect(session.comparison?.newick).toContain("Comparison");
  expect(session.comparison?.camera?.zoom).toBeGreaterThan(1.5);
  expect(session.comparison?.showIncompatibleSplits).toBe(true);

  const savedBytes = [...await readFile(savedPath as string)];
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));
  await page.evaluate((bytes) => {
    Object.defineProperty(window, "showOpenFilePicker", {
      value: async () => [{
        getFile: async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 25));
          return new File([new Uint8Array(bytes)], "comparison-session.btvsession");
        },
      }],
      configurable: true,
    });
  }, savedBytes);
  await page.getByRole("button", { name: "Load Session" }).click();
  await page.waitForFunction(
    () => Boolean(window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState()),
    undefined,
    { timeout: 15_000 },
  );
  await expect(page.getByLabel("Tree comparison view")).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: /Show red X marks/ })).toBeChecked();
  await page.waitForFunction(() => Number(
    (window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().camera as { zoom?: number } | undefined)?.zoom ?? 0,
  ) > 1.5);
  const restoredCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().camera);
  expect(restoredCamera).toEqual(savedCamera);
});

test("comparison stats switch trees and search zoom highlights matching tips in both", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("((A:1,B:1):1,(C:1,D:1):1)Primary;");
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));

  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const comparisonPanel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await comparisonPanel.getByRole("button", { name: "Paste Newick" }).click();
  await comparisonPanel.getByPlaceholder("Paste the comparison tree in Newick or NEXUS format").fill("(((A:1,C:1):1,(B:1,D:1):1):1,E:3)Comparison;");
  await comparisonPanel.getByRole("button", { name: "Load Comparison" }).click();
  await expect(page.getByLabel("Tree comparison view")).toBeVisible();

  await page.getByRole("button", { name: "Stats" }).click();
  const statsPanel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Stats" }) });
  await expect(statsPanel.locator(".comparison-stats-label")).toHaveText("pasted tree");
  await expect(statsPanel.locator(".stats-list").first().locator("dd").first()).toHaveText("4");
  await statsPanel.getByRole("button", { name: "Right Tree" }).click();
  await expect(statsPanel.locator(".comparison-stats-label")).toHaveText("pasted comparison tree");
  await expect(statsPanel.locator(".stats-list").first().locator("dd").first()).toHaveText("5");

  await page.getByRole("button", { name: "Search" }).click();
  const searchPanel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Search" }) });
  await searchPanel.getByPlaceholder("Search tip, node, genus, or taxonomy names").fill("A");
  const zoomButton = searchPanel.getByRole("button", { name: "Zoom In" });
  await zoomButton.click();
  await expect(zoomButton).toHaveAttribute("aria-pressed", "true");
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState();
    return state?.highlightedPrimaryTips === 1
      && state?.highlightedComparisonTips === 1
      && Number((state.camera as { zoom?: number } | undefined)?.zoom ?? 0) > 1;
  });
  const layout = await page.evaluate(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState());
  expect(Number(layout?.primaryLabelEndX)).toBeLessThan(Number(layout?.connectorStartX));
  expect(Number(layout?.connectorEndX)).toBeLessThan(Number(layout?.comparisonLabelStartX));

  await zoomButton.click();
  await expect(zoomButton).toHaveAttribute("aria-pressed", "false");
});

test("unmatched tips do not create false connector discordance", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("((A:1,X:1,B:1):1,(C:1,Y:1,D:1):1)Primary;");
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));

  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.getByRole("button", { name: "Paste Newick" }).click();
  await panel.getByPlaceholder("Paste the comparison tree in Newick or NEXUS format").fill("((Z:1,A:1,B:1):1,(W:1,C:1,D:1,Q:1):1)Comparison;");
  await panel.getByRole("button", { name: "Load Comparison" }).click();

  await expect(page.getByLabel("Tree comparison view")).toBeVisible();
  await expect(page.locator(".tree-comparison-summary")).toHaveText(
    "4 shared tips · 2 only in left tree · 3 only in right tree",
  );
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().sharedTipCount === 4);
  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState());
  expect(Number(state?.maximumDiscordance)).toBe(0);
});

test("bundled example comparison fixture matches every example-tree tip", async ({ page }) => {
  execFileSync(process.execPath, ["scripts/make-example-comparison-tree.mjs"], {
    cwd: path.resolve("."),
    stdio: "ignore",
  });
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.getByRole("button", { name: "Load Example" }).click();
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && !Boolean(state?.loading);
  });

  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.locator('input[type="file"]').setInputFiles(path.resolve("tmp/example_comparison_tree.nwk"));

  await expect(page.getByLabel("Tree comparison view")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".tree-comparison-summary")).toHaveText("50,033 shared tips", { timeout: 30_000 });
  await expect(panel).toContainText("example_comparison_tree.nwk: 50,033 tips");
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().activeRankCount === 2);
  const initialRibbonState = await page.evaluate(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState());
  expect(Number(initialRibbonState?.maximumTaxonomyLabelOverflow)).toBeLessThanOrEqual(0);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "bandThicknessScale", 2));
  await page.waitForFunction((initialWidth) => Number(
    window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().ribbonsWidth ?? 0,
  ) > Number(initialWidth), initialRibbonState?.ribbonsWidth);
});

test("warns about a different root and reroots the comparison tree on an exact matching edge", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(
    "(A:1,((B:1,C:1):1,(D:1,E:1):1):1)Primary;",
  );
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));

  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.getByRole("button", { name: "Paste Newick" }).click();
  await panel.getByPlaceholder("Paste the comparison tree in Newick or NEXUS format").fill(
    "((B:1,C:1):1,(A:1,(D:1,E:1):1):1)Comparison;",
  );
  await panel.getByRole("button", { name: "Load Comparison" }).click();

  const warning = panel.getByRole("alert");
  await expect(warning).toContainText("do not appear to have the same root");
  await expect(warning).toContainText("exactly matches");
  await warning.getByRole("button", { name: "Re-root to Match Original" }).click();
  await expect(warning).toBeHidden();
  await expect(panel).toContainText("(rerooted to match)");
  await expect(panel.getByLabel("Comparison statistics").locator("dd").filter({ hasText: "0.0000" })).toHaveCount(1);
});

test("marks left-tree branches whose unrooted splits are absent from the comparison tree", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(
    "((A:1,B:1):1,(C:1,(D:1,E:1):1):1)Primary;",
  );
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));

  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.getByRole("button", { name: "Paste Newick" }).click();
  await panel.getByPlaceholder("Paste the comparison tree in Newick or NEXUS format").fill(
    "((A:1,C:1):1,(B:1,(D:1,E:1):1):1)Comparison;",
  );
  await panel.getByRole("button", { name: "Load Comparison" }).click();

  const toggle = panel.getByRole("checkbox", { name: /Show red X marks/ });
  await expect(toggle).toBeVisible();
  await expect(panel).toContainText("Show red X marks on incompatible left-tree splits (1)");
  await toggle.check();
  await page.waitForFunction(() => Number(
    window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().incompatibleSplitMarkerCount ?? 0,
  ) > 0);
});
