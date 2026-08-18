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
  const comparisonStatisticRows = await panel.getByLabel("Comparison statistics").locator("dl > div").evaluateAll((rows) => (
    rows.map((row) => {
      const label = row.querySelector("dt")?.getBoundingClientRect();
      const value = row.querySelector("dd")?.getBoundingClientRect();
      return label && value ? {
        labelCenterY: label.top + (label.height / 2),
        valueCenterY: value.top + (value.height / 2),
        valueRight: value.right,
      } : null;
    })
  ));
  expect(comparisonStatisticRows).not.toContain(null);
  for (const row of comparisonStatisticRows) {
    expect(Math.abs(row!.labelCenterY - row!.valueCenterY)).toBeLessThan(1);
  }
  const valueRightEdges = comparisonStatisticRows.map((row) => row!.valueRight);
  expect(Math.max(...valueRightEdges) - Math.min(...valueRightEdges)).toBeLessThan(1);
  await expect(page.getByRole("button", { name: "Circular" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Fan" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Spiral" })).toBeDisabled();
  await page.waitForFunction(() => Number(
    window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().maximumDiscordance ?? 0,
  ) > 0);

  const hoverPoint = await page.evaluate(() => (
    window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().primaryBranchHoverPoint as { x: number; y: number } | undefined
  ));
  expect(hoverPoint).toBeTruthy();
  await comparisonCanvas.hover({ position: hoverPoint });
  const hoverTooltip = page.locator(".tree-comparison-shell .hover-tooltip");
  await expect(hoverTooltip).toBeVisible();
  await expect(hoverTooltip).toContainText("A");
  await expect(hoverTooltip).toContainText("Branch length");

  await page.getByRole("button", { name: "Zoom X" }).click();
  await comparisonCanvas.hover({ position: { x: 180, y: 240 } });
  await page.mouse.wheel(0, -500);
  await page.waitForFunction(() => {
    const camera = window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().camera as { zoom?: number; zoomX?: number } | undefined;
    return Number(camera?.zoomX ?? 0) > 1 && Number(camera?.zoom ?? 0) === 1;
  });
  const beforeHorizontalPan = await page.evaluate(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState());
  const canvasBox = await comparisonCanvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move((canvasBox?.x ?? 0) + 160, (canvasBox?.y ?? 0) + 240);
  await page.mouse.down();
  await page.mouse.move((canvasBox?.x ?? 0) + 300, (canvasBox?.y ?? 0) + 240, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction((startingPan) => Number(
    (window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().camera as { panX?: number } | undefined)?.panX ?? 0,
  ) > Number(startingPan), (beforeHorizontalPan?.camera as { panX?: number } | undefined)?.panX ?? 0);
  const afterHorizontalPan = await page.evaluate(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState());
  const primaryMovement = Number(afterHorizontalPan?.primaryTipX) - Number(beforeHorizontalPan?.primaryTipX);
  const comparisonMovement = Number(afterHorizontalPan?.comparisonTipX) - Number(beforeHorizontalPan?.comparisonTipX);
  const connectorMovement = Number(afterHorizontalPan?.connectorCenterX) - Number(beforeHorizontalPan?.connectorCenterX);
  expect(primaryMovement).toBeGreaterThan(100);
  expect(comparisonMovement).toBeCloseTo(primaryMovement, 5);
  expect(connectorMovement).toBeCloseTo(primaryMovement, 5);
  expect(
    Number(afterHorizontalPan?.comparisonTipX) - Number(afterHorizontalPan?.primaryTipX),
  ).toBeCloseTo(
    Number(beforeHorizontalPan?.comparisonTipX) - Number(beforeHorizontalPan?.primaryTipX),
    5,
  );
  await page.mouse.wheel(0, 700);
  await page.waitForFunction(() => {
    const camera = window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().camera as { panX?: number; zoomX?: number } | undefined;
    return Number(camera?.zoomX ?? 0) === 1 && Number(camera?.panX ?? Number.NaN) === 0;
  });
  const beforeFitScalePan = await page.evaluate(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState());
  await page.mouse.move((canvasBox?.x ?? 0) + 500, (canvasBox?.y ?? 0) + 240);
  await page.mouse.down();
  await page.mouse.move((canvasBox?.x ?? 0) + 360, (canvasBox?.y ?? 0) + 240, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => Number(
    (window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().camera as { panX?: number } | undefined)?.panX ?? 0,
  ) < -100);
  const afterFitScalePan = await page.evaluate(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState());
  const fitPrimaryMovement = Number(afterFitScalePan?.primaryTipX) - Number(beforeFitScalePan?.primaryTipX);
  const fitComparisonMovement = Number(afterFitScalePan?.comparisonTipX) - Number(beforeFitScalePan?.comparisonTipX);
  expect(fitPrimaryMovement).toBeLessThan(-100);
  expect(fitComparisonMovement).toBeCloseTo(fitPrimaryMovement, 5);
  await page.getByRole("button", { name: "Fit View" }).click();
  await page.waitForFunction(() => {
    const camera = window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().camera as { panX?: number; zoom?: number; zoomX?: number } | undefined;
    return Number(camera?.zoomX ?? 0) === 1
      && Number(camera?.zoom ?? 0) === 1
      && Number(camera?.panX ?? -1) === 0;
  });

  const defaultCenterWidth = Number((await page.evaluate(
    () => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().centerWidth,
  )) ?? 0);
  await expect(panel.getByLabel("Center zone width")).toHaveValue("0.5");
  await expect(panel.getByLabel("Center zone width")).toHaveAttribute("max", "1");
  await panel.getByLabel("Center zone width").fill("0.7");
  await panel.getByLabel("Connector sensitivity").fill("2");
  await page.waitForFunction(({ centerWidth, sensitivity }) => {
    const state = window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState();
    return Number(state?.centerWidth ?? 0) > centerWidth
      && Number(state?.connectorSensitivity ?? 0) === sensitivity;
  }, { centerWidth: defaultCenterWidth, sensitivity: 2 });

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

test("comparison file picker filters tree formats and loads an uncommon tree extension", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("((A:1,B:1):1,(C:1,D:1):1)Primary;");
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));

  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  const input = panel.locator('input[type="file"]');
  await expect(input).toHaveAttribute("accept", /\.mcc/);
  await input.setInputFiles({
    name: "comparison.mcc",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("((A:1,C:1):1,(B:1,D:1):1)Comparison;"),
  });

  await expect(page.getByLabel("Tree comparison view")).toBeVisible();
  await expect(panel).toContainText("comparison.mcc: 4 tips");
});

test("Y-only zoom preserves connector width while tip labels displace both trees", async ({ page }) => {
  const labels = Array.from({ length: 128 }, (_, index) => `Species_${index.toString().padStart(3, "0")}_long_name`);
  const primaryNewick = `(${labels.map((label) => `${label}:1`).join(",")})Primary;`;
  const comparisonNewick = `(${[...labels].reverse().map((label) => `${label}:1`).join(",")})Comparison;`;

  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(primaryNewick);
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));
  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.getByRole("button", { name: "Paste Newick" }).click();
  await panel.getByPlaceholder("Paste the comparison tree in Newick or NEXUS format").fill(comparisonNewick);
  await panel.getByRole("button", { name: "Load Comparison" }).click();

  const canvas = page.getByLabel("Tree comparison view");
  await expect(canvas).toBeVisible();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().labelsVisible === false);
  const before = await page.evaluate(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState());
  await page.getByRole("button", { name: "Zoom Y" }).click();
  await canvas.hover({ position: { x: 500, y: 300 } });
  await page.mouse.wheel(0, -900);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState().labelsVisible === true);
  const after = await page.evaluate(() => window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState());

  expect(Number((after?.camera as { zoomX?: number } | undefined)?.zoomX)).toBe(1);
  expect(Number(after?.connectorStartX)).toBeCloseTo(Number(before?.connectorStartX), 5);
  expect(Number(after?.connectorEndX)).toBeCloseTo(Number(before?.connectorEndX), 5);
  expect(Number(after?.primaryTipX)).toBeLessThan(Number(before?.primaryTipX) - 50);
  expect(Number(after?.comparisonTipX)).toBeGreaterThan(Number(before?.comparisonTipX) + 50);
});

test("comparison tree can be dropped without opening the native file picker", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("((A:1,B:1):1,(C:1,D:1):1)Primary;");
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));

  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const dropZone = page.getByLabel("Drop comparison tree");
  await dropZone.evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(
      ["((A:1,C:1):1,(B:1,D:1):1)DroppedComparison;"],
      "dropped-comparison.nwk",
      { type: "text/plain" },
    ));
    element.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }));
  });

  await expect(page.getByLabel("Tree comparison view")).toBeVisible();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await expect(panel).toContainText("dropped-comparison.nwk: 4 tips");
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
  await panel.getByLabel("Connector sensitivity").fill("2.5");
  await panel.getByLabel("Center zone width").fill("0.75");
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
  expect(session.comparison?.connectorSensitivity).toBe(2.5);
  expect(session.comparison?.centerWidthScale).toBe(0.75);

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
  await expect(panel.getByLabel("Connector sensitivity")).toHaveValue("2.5");
  await expect(panel.getByLabel("Center zone width")).toHaveValue("0.75");
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
  const taxonomyHoverPoint = initialRibbonState?.taxonomyHoverPoint as { x: number; y: number } | undefined;
  expect(taxonomyHoverPoint).toBeTruthy();
  await page.getByLabel("Tree comparison view").hover({ position: taxonomyHoverPoint });
  const taxonomyTooltip = page.locator(".tree-comparison-shell .hover-tooltip");
  await expect(taxonomyTooltip).toBeVisible();
  await expect(taxonomyTooltip).toContainText("Rank:");
  await expect(taxonomyTooltip).toContainText("Descendant tips:");
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "bandThicknessScale", 2));
  await page.waitForFunction(({ initialFontSize, initialWidth }) => {
    const state = window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState();
    return Number(state?.ribbonsWidth ?? 0) > Number(initialWidth)
      && Number(state?.maximumTaxonomyLabelFontSize ?? 0) > Number(initialFontSize);
  }, {
    initialFontSize: initialRibbonState?.maximumTaxonomyLabelFontSize,
    initialWidth: initialRibbonState?.ribbonsWidth,
  });
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

test("matches and reroots a trifurcating original root at a comparison-tree node", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("((A:1,B:1):1,(C:1,D:1):1,(E:1,F:1):1)Primary;");
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));
  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.getByRole("button", { name: "Paste Newick" }).click();
  await panel.getByPlaceholder("Paste the comparison tree in Newick or NEXUS format").fill("(A:1,(B:1,((C:1,D:1):1,(E:1,F:1):1):1):1)Comparison;");
  await panel.getByRole("button", { name: "Load Comparison" }).click();

  const warning = panel.locator(".comparison-root-warning");
  await expect(warning).toContainText("reference tree appears to be unrooted or has a root-level polytomy");
  await expect(warning).toContainText("contains a node that exactly matches");
  await warning.getByRole("button", { name: "Re-root to Match Original" }).click();
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("may not be biologically meaningful");
  await expect(warning.getByRole("button", { name: "Re-root to Match Original" })).toBeHidden();
  await expect(page.getByLabel("Tree comparison view")).toBeVisible();
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

test("renders every incompatible-split marker, including dense conflicts", async ({ page }) => {
  const labels = Array.from({ length: 256 }, (_, index) => `T${index.toString().padStart(3, "0")}`);
  const buildBalanced = (names: string[]): string => {
    if (names.length === 1) return `${names[0]}:1`;
    const midpoint = Math.floor(names.length / 2);
    return `(${buildBalanced(names.slice(0, midpoint))},${buildBalanced(names.slice(midpoint))}):1`;
  };
  const reverseBits = (value: number): number => {
    let result = 0;
    for (let bit = 0; bit < 8; bit += 1) result = (result << 1) | ((value >> bit) & 1);
    return result;
  };
  const comparisonLabels = labels.map((_, index) => labels[reverseBits(index)]);
  const primaryNewick = `${buildBalanced(labels).slice(0, -2)}Primary;`;
  const comparisonNewick = `${buildBalanced(comparisonLabels).slice(0, -2)}Comparison;`;

  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.getByRole("button", { name: "Paste Newick" }).first().click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(primaryNewick);
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded));
  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.getByRole("button", { name: "Paste Newick" }).click();
  await panel.getByPlaceholder("Paste the comparison tree in Newick or NEXUS format").fill(comparisonNewick);
  await panel.getByRole("button", { name: "Load Comparison" }).click();
  await panel.getByRole("checkbox", { name: /Show red X marks/ }).check();

  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_COMPARISON_TEST__?.getState();
    return Number(state?.incompatibleSplitCandidateCount ?? 0) > 0
      && Number(state?.incompatibleSplitCandidateCount ?? 0) === Number(state?.incompatibleSplitMarkerCount ?? -1);
  });
});
