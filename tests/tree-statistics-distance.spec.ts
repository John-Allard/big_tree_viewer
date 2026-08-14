import { expect, test, type Page } from "@playwright/test";

const TEST_TREE = "((A:1,B:1)AB:1,(C:1,D:1)CD:1)Root;";

function balancedTreeNewick(tipCount: number): string {
  const build = (start: number, end: number): string => {
    if (end - start === 1) {
      return `T${start}:1`;
    }
    const middle = start + Math.floor((end - start) / 2);
    return `(${build(start, middle)},${build(middle, end)}):1`;
  };
  const middle = Math.floor(tipCount / 2);
  return `(${build(0, middle)},${build(middle, tipCount)})Root;`;
}

async function loadTree(page: Page, newick = TEST_TREE): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__,
  ));
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(newick);
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && !Boolean(state?.loading);
  });
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("input");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function nodeIndex(page: Page, name: string): Promise<number> {
  return page.evaluate((targetName) => {
    const names = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names;
    const node = names?.indexOf(targetName) ?? -1;
    if (node < 0) {
      throw new Error(`Node ${targetName} was not found.`);
    }
    return node;
  }, name);
}

async function branchPoint(page: Page, node: number): Promise<{ x: number; y: number }> {
  const local = await page.evaluate((targetNode) => {
    const segment = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getBranchScreenSegmentForTest(targetNode);
    if (!segment) {
      throw new Error(`No visible branch segment for node ${targetNode}.`);
    }
    return {
      x: (segment.x1 + segment.x2) / 2,
      y: (segment.y1 + segment.y2) / 2,
    };
  }, node);
  const box = await page.getByTestId("tree-canvas").boundingBox();
  if (!box) {
    throw new Error("Tree canvas has no bounding box.");
  }
  return { x: box.x + local.x, y: box.y + local.y };
}

async function statisticValue(scope: ReturnType<Page["locator"]>, label: string) {
  return scope.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
}

test("whole-tree and subtree statistics use the same definitions", async ({ page }) => {
  await loadTree(page);

  await page.getByRole("button", { name: "Stats" }).click();
  const sidePanel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Stats" }) });
  await expect(await statisticValue(sidePanel, "Tips")).toHaveText("4");
  await expect(await statisticValue(sidePanel, "Nodes")).toHaveText("7");
  await expect(await statisticValue(sidePanel, "Branches")).toHaveText("6");
  await expect(await statisticValue(sidePanel, "Cherries")).toHaveText("2");
  await expect(await statisticValue(sidePanel, "Total branch length")).toHaveText("6");
  await expect(await statisticValue(sidePanel, "Mean pairwise tip distance")).toHaveText("3.333333");
  await expect(await statisticValue(sidePanel, "Sackin index")).toHaveText("8");
  await expect(await statisticValue(sidePanel, "Normalized Sackin")).toHaveText("0");
  await expect(await statisticValue(sidePanel, "Colless index")).toHaveText("0");
  await expect(await statisticValue(sidePanel, "Ultrametric")).toHaveText("Yes");
  await page.getByRole("button", { name: "Stats" }).click();
  await expect(page.getByRole("button", { name: "Stats" })).toHaveAttribute("aria-expanded", "false");

  const abNode = await nodeIndex(page, "AB");
  const abPoint = await branchPoint(page, abNode);
  await page.mouse.click(abPoint.x, abPoint.y, { button: "right" });
  await page.getByRole("button", { name: "View Subtree Statistics" }).click();

  const subtreePanel = page.locator(".subtree-statistics-panel");
  await expect(page.getByRole("button", { name: "Stats" })).toHaveAttribute("aria-expanded", "true");
  await expect(subtreePanel).toBeVisible();
  await expect.poll(async () => {
    const box = await subtreePanel.boundingBox();
    return box ? box.y : Number.POSITIVE_INFINITY;
  }).toBeLessThan(700);
  await expect(subtreePanel).toContainText("Subtree Statistics");
  await expect(subtreePanel).toContainText("AB");
  await expect(await statisticValue(subtreePanel, "Tips")).toHaveText("2");
  await expect(await statisticValue(subtreePanel, "Nodes")).toHaveText("3");
  await expect(await statisticValue(subtreePanel, "Total branch length")).toHaveText("2");
  await expect(await statisticValue(subtreePanel, "Mean pairwise tip distance")).toHaveText("2");
  await page.getByRole("button", { name: "Close subtree statistics" }).click();
  await expect(subtreePanel).toBeHidden();
  await expect(await statisticValue(sidePanel, "Tips")).toHaveText("4");
});

test("unlabeled subtree statistics identify the selection as an internal node", async ({ page }) => {
  await loadTree(page, "((A:1,B:1)AB:1,(C:1,D:1):1)Root;");
  const unlabeledNode = await page.evaluate(() => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const cNode = internal?.names?.indexOf("C") ?? -1;
    const parent = cNode >= 0 ? internal?.parent?.[cNode] ?? -1 : -1;
    if (parent < 0) {
      throw new Error("Unlabeled internal node unavailable.");
    }
    return parent;
  });
  const point = await branchPoint(page, unlabeledNode);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.getByRole("button", { name: "View Subtree Statistics" }).click();
  const panel = page.locator(".subtree-statistics-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".subtree-statistics-panel-header p")).toHaveText("Internal node");
});

test("distance measurement follows the hovered node path and survives wheel zoom", async ({ page }) => {
  await loadTree(page);
  const startNode = await nodeIndex(page, "A");
  const targetNode = await nodeIndex(page, "C");
  const startPoint = await branchPoint(page, startNode);
  const targetPoint = await branchPoint(page, targetNode);

  await page.mouse.click(startPoint.x, startPoint.y, { button: "right" });
  await page.getByRole("button", { name: "Measure Distance" }).click();
  await page.mouse.move(targetPoint.x, targetPoint.y);

  const tooltip = page.locator(".distance-measurement-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("A to C");
  await expect(tooltip).toContainText("Distance: 4");
  await expect(tooltip).toContainText("MRCA: Root");

  const highlightedPixels = await page.locator(".tree-canvas-overlay").evaluate((canvas) => {
    const context = (canvas as HTMLCanvasElement).getContext("2d");
    if (!context) {
      return 0;
    }
    const pixels = context.getImageData(0, 0, (canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 170 && pixels[index + 1] < 90 && pixels[index + 2] < 90 && pixels[index + 3] > 80) {
        count += 1;
      }
    }
    return count;
  });
  expect(highlightedPixels).toBeGreaterThan(20);

  await page.mouse.wheel(0, -120);
  await expect(tooltip).toBeVisible();

  for (const mode of ["circular", "fan"] as const) {
    await page.evaluate(async (nextMode) => {
      window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode(nextMode);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, mode);
    const nextTargetPoint = await branchPoint(page, targetNode);
    await page.mouse.move(nextTargetPoint.x, nextTargetPoint.y);
    await expect(tooltip).toContainText("Distance: 4");
    await expect(tooltip).toContainText("MRCA: Root");
  }

  const canvasBox = await page.getByTestId("tree-canvas").boundingBox();
  if (!canvasBox) {
    throw new Error("Tree canvas has no bounding box.");
  }
  await page.mouse.click(canvasBox.x + 20, canvasBox.y + 20);
  await expect(tooltip).toBeHidden();
});

test("distance path renders in spiral geometry", async ({ page }) => {
  await loadTree(page, balancedTreeNewick(1024));
  const startNode = await nodeIndex(page, "T0");
  const targetNode = await nodeIndex(page, "T1023");
  const measurement = await page.evaluate(async ({ start, target }) => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    if (!app || !canvas) {
      throw new Error("Distance test controls unavailable.");
    }
    app.setViewMode("spiral");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    canvas.fitView();
    canvas.startDistanceMeasurementForTest(start, 100, 100);
    canvas.updateDistanceMeasurementForTest(target, 120, 120);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return canvas.getDistanceMeasurementForTest();
  }, { start: startNode, target: targetNode });

  expect(measurement).toMatchObject({
    startNode,
    targetNode,
    distance: 20,
  });
  await expect(page.locator(".distance-measurement-tooltip")).toContainText("Distance: 20");
  const highlightedPixels = await page.locator(".tree-canvas-overlay").evaluate((canvas) => {
    const context = (canvas as HTMLCanvasElement).getContext("2d");
    if (!context) {
      return 0;
    }
    const pixels = context.getImageData(0, 0, (canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 170 && pixels[index + 1] < 90 && pixels[index + 2] < 90 && pixels[index + 3] > 80) {
        count += 1;
      }
    }
    return count;
  });
  expect(highlightedPixels).toBeGreaterThan(20);
});
