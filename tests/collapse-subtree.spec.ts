import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TREE_PATH = path.join(TEST_DIR, "fixtures", "collapse-subtree-tree.nwk");

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function loadFixture(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__,
  ));
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded && !state.loading && state.treeSignature);
  });
  const tutorialClose = page.getByRole("button", { name: "Close tutorial prompt" });
  if (await tutorialClose.isVisible()) {
    await tutorialClose.click();
  }
  const previousSignature = await page.evaluate(() => (
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeSignature ?? null
  ));
  await page.setInputFiles('input[type="file"]', TREE_PATH);
  await page.waitForFunction((oldSignature) => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const names = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? [];
    return Boolean(
      state?.treeLoaded
      && !state.loading
      && state.treeSignature
      && state.treeSignature !== oldSignature
      && names.includes("A")
      && names.includes("P")
    );
  }, previousSignature);
}

async function configureTaxonomy(page: Page): Promise<{
  collapsedNode: number;
  movedAncestorNode: number;
  firstOutsideTip: number;
  secondOutsideTip: number;
}> {
  return page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    if (!app || !internal?.leafNodes || !internal.names || !internal.parent) {
      throw new Error("Tree test hooks unavailable.");
    }
    const nodeByName = new Map<string, number>();
    for (let index = 0; index < internal.names.length; index += 1) {
      nodeByName.set(internal.names[index], index);
    }
    const requiredNames = "ABCDEFGHIJKLMNOP".split("");
    const tips = requiredNames.map((name) => {
      const node = nodeByName.get(name);
      if (node === undefined) {
        throw new Error(`Missing fixture tip ${name}.`);
      }
      return node;
    });
    const ancestors = (node: number): Set<number> => {
      const result = new Set<number>();
      for (let current = node; current >= 0; current = internal.parent?.[current] ?? -1) {
        result.add(current);
      }
      return result;
    };
    const firstAncestors = ancestors(tips[0]);
    let collapsedNode = tips[3];
    while (!firstAncestors.has(collapsedNode)) {
      collapsedNode = internal.parent[collapsedNode];
    }
    const movedAncestorNode = internal.parent[collapsedNode];
    if (movedAncestorNode < 0 || internal.parent[movedAncestorNode] < 0) {
      throw new Error("Fixture collapse target lacks a movable ancestral stem.");
    }
    app.setTaxonomyMapForTest({
      version: 1,
      mappedCount: tips.length,
      totalTips: tips.length,
      activeRanks: ["family"],
      tipRanks: tips.map((node, index) => ({
        node,
        ranks: {
          family: index < 4
            ? "Alphaidae"
            : index < 8
              ? "Betaidae"
              : index < 12
                ? "Gammaidae"
                : "Deltaidae",
        },
        taxIds: {
          family: index < 4 ? 101 : index < 8 ? 202 : index < 12 ? 303 : 404,
        },
      })),
    });
    app.setTaxonomyRankVisibilityForTest("family", true);
    app.setViewMode("rectangular");
    app.setOrder("input");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return {
      collapsedNode,
      movedAncestorNode,
      firstOutsideTip: tips[4],
      secondOutsideTip: tips[5],
    };
  });
}

async function taxonomyLabelBox(page: Page, text: string): Promise<Record<string, unknown>> {
  return page.evaluate((label) => {
    const hitboxes = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [];
    const hitbox = hitboxes.find((candidate) => (
      candidate.labelKind === "taxonomy"
      && candidate.text === label
      && candidate.source !== "collapse"
    ));
    if (!hitbox) {
      throw new Error(`Taxonomy label hitbox unavailable for ${label}.`);
    }
    return hitbox;
  }, text);
}

test("collapse modes preserve ribbons or minimize to three tips with aligned hover geometry", async ({ page }) => {
  await loadFixture(page);
  const nodes = await configureTaxonomy(page);
  const originalRibbon = await taxonomyLabelBox(page, "Alphaidae");

  await page.evaluate((node) => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCollapsedNodeMode(node, "preserve-width");
  }, nodes.collapsedNode);
  await settleFrames(page);

  const preserved = await page.evaluate((node) => {
    const hitboxes = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [];
    const triangle = hitboxes
      .filter((candidate) => candidate.node === node && candidate.source === "collapse")
      .sort((left, right) => Number(right.width) - Number(left.width))[0];
    const ribbon = hitboxes.find((candidate) => (
      candidate.labelKind === "taxonomy"
      && candidate.text === "Alphaidae"
      && candidate.source !== "collapse"
    ));
    if (!triangle || !ribbon) {
      throw new Error("Preserved collapse geometry unavailable.");
    }
    return { triangle, ribbon };
  }, nodes.collapsedNode);

  expect(Number(preserved.ribbon.x)).toBeCloseTo(Number(originalRibbon.x), 3);
  expect(Number(preserved.ribbon.y)).toBeCloseTo(Number(originalRibbon.y), 3);
  expect(Number(preserved.ribbon.width)).toBeCloseTo(Number(originalRibbon.width), 3);
  const preservedApexProbe = await page.evaluate((triangle) => (
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.probeHoverForTest(
      Number(triangle.x) + 1,
      Number(triangle.y) + (Number(triangle.height) * 0.5),
    ) ?? null
  ), preserved.triangle);
  expect(preservedApexProbe).toMatchObject({
    kind: "taxonomy",
    name: "Alphaidae",
    taxonomyRank: "family",
    descendantTipCount: 4,
  });

  await page.evaluate((node) => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCollapsedNodeMode(node, "minimize");
  }, nodes.collapsedNode);
  await settleFrames(page);

  const minimized = await page.evaluate(({
    collapsedNode,
    movedAncestorNode,
    firstOutsideTip,
    secondOutsideTip,
  }) => {
    const canvasTest = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const hitboxes = canvasTest?.getLabelHitboxes() ?? [];
    const collapseHitboxes = hitboxes
      .filter((candidate) => candidate.node === collapsedNode && candidate.source === "collapse")
      .sort((left, right) => Number(right.width) - Number(left.width));
    const triangle = collapseHitboxes[0];
    const firstTipSegment = canvasTest?.getBranchScreenSegmentForTest(firstOutsideTip);
    const secondTipSegment = canvasTest?.getBranchScreenSegmentForTest(secondOutsideTip);
    const movedAncestorSegment = canvasTest?.getBranchScreenSegmentForTest(movedAncestorNode);
    if (!triangle || !firstTipSegment || !secondTipSegment || !movedAncestorSegment) {
      throw new Error("Minimized collapse geometry unavailable.");
    }
    const taxonomyLabel = collapseHitboxes.find((candidate) => candidate !== triangle);
    const triangleProbe = canvasTest?.probeHoverForTest(
      Number(triangle.x) + (Number(triangle.width) * 0.2),
      Number(triangle.y) + (Number(triangle.height) * 0.5),
    ) ?? null;
    const branchProbe = canvasTest?.probeHoverForTest(
      (movedAncestorSegment.x1 + movedAncestorSegment.x2) * 0.5,
      (movedAncestorSegment.y1 + movedAncestorSegment.y2) * 0.5,
    ) ?? null;
    return {
      triangle,
      taxonomyLabel,
      collapseHitboxCount: collapseHitboxes.length,
      outsideTipSpacing: Math.abs(firstTipSegment.y1 - secondTipSegment.y1),
      triangleProbe,
      branchProbe,
    };
  }, nodes);

  expect(Number(minimized.triangle.height)).toBeLessThan(Number(preserved.triangle.height) * 0.8);
  expect(Number(minimized.triangle.height) / minimized.outsideTipSpacing).toBeCloseTo(2, 1);
  expect(minimized.collapseHitboxCount).toBeGreaterThanOrEqual(2);
  expect(Number(minimized.taxonomyLabel?.x)).toBeGreaterThan(
    Number(minimized.triangle.x) + Number(minimized.triangle.width),
  );
  expect(minimized.triangleProbe).toMatchObject({
    kind: "taxonomy",
    name: "Alphaidae",
    taxonomyRank: "family",
    descendantTipCount: 4,
  });
  expect(minimized.branchProbe).toMatchObject({
    node: nodes.movedAncestorNode,
    targetKind: "stem",
  });

  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
  });
  await settleFrames(page);
  const circularBranchProbe = await page.evaluate((node) => {
    const canvasTest = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const segment = canvasTest?.getBranchScreenSegmentForTest(node);
    if (!segment) {
      throw new Error("Circular collapsed branch segment unavailable.");
    }
    return canvasTest?.probeHoverForTest(
      (segment.x1 + segment.x2) * 0.5,
      (segment.y1 + segment.y2) * 0.5,
    ) ?? null;
  }, nodes.movedAncestorNode);
  expect(circularBranchProbe).toMatchObject({
    node: nodes.movedAncestorNode,
    targetKind: "stem",
  });
});

test("node and taxonomy context menus expose preserve-width and minimize actions", async ({ page }) => {
  await loadFixture(page);
  const nodes = await configureTaxonomy(page);

  const branchPoint = await page.evaluate((node) => {
    const canvas = document.querySelector("[data-testid=tree-canvas]");
    const canvasTest = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const segment = canvasTest?.getBranchScreenSegmentForTest(node);
    if (!(canvas instanceof HTMLCanvasElement) || !canvasTest || !segment) {
      throw new Error("Node context-menu target unavailable.");
    }
    const rect = canvas.getBoundingClientRect();
    for (const fraction of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const localX = segment.x1 + ((segment.x2 - segment.x1) * fraction);
      const localY = segment.y1 + ((segment.y2 - segment.y1) * fraction);
      const hover = canvasTest.probeHoverForTest(localX, localY);
      if (hover?.node === node && hover.targetKind === "stem") {
        return {
          x: rect.left + localX,
          y: rect.top + localY,
        };
      }
    }
    throw new Error("No unambiguous node stem context-menu target found.");
  }, nodes.collapsedNode);
  await page.mouse.click(branchPoint.x, branchPoint.y, { button: "right" });
  await page.getByRole("button", { name: "Collapse Subtree" }).click();
  await expect(page.getByRole("button", { name: "Preserve Width" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Minimize" })).toBeVisible();
  await page.getByRole("button", { name: "Preserve Width" }).click();
  await expect.poll(async () => page.evaluate(() => (
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCollapsedNodeModes() ?? []
  ))).toContainEqual([nodes.collapsedNode, "preserve-width"]);

  const collapsedTrianglePoint = await page.evaluate((node) => {
    const canvas = document.querySelector("[data-testid=tree-canvas]");
    const hitboxes = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [];
    const triangle = hitboxes
      .filter((candidate) => candidate.node === node && candidate.source === "collapse")
      .sort((left, right) => Number(right.width) - Number(left.width))[0];
    if (!(canvas instanceof HTMLCanvasElement) || !triangle) {
      throw new Error("Collapsed taxonomy triangle context-menu target unavailable.");
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + Number(triangle.x) + 1,
      y: rect.top + Number(triangle.y) + (Number(triangle.height) * 0.5),
    };
  }, nodes.collapsedNode);
  await page.mouse.click(collapsedTrianglePoint.x, collapsedTrianglePoint.y, { button: "right" });
  await expect(page.getByRole("button", { name: "Expand Group" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom To Group MRCA" })).toBeVisible();
  await page.getByRole("button", { name: "Expand Group" }).click();
  await expect.poll(async () => page.evaluate(() => (
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCollapsedNodeModes() ?? []
  ))).not.toContainEqual([nodes.collapsedNode, "preserve-width"]);
  await settleFrames(page);
  const taxonomyPoint = await page.evaluate(() => {
    const canvas = document.querySelector("[data-testid=tree-canvas]");
    const hitboxes = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [];
    const hitbox = hitboxes.find((candidate) => (
      candidate.labelKind === "taxonomy"
      && candidate.text === "Alphaidae"
      && candidate.source !== "collapse"
    ));
    if (!(canvas instanceof HTMLCanvasElement) || !hitbox) {
      throw new Error("Taxonomy context-menu target unavailable.");
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + Number(hitbox.x) + (Number(hitbox.width) * 0.5),
      y: rect.top + Number(hitbox.y) + (Number(hitbox.height) * 0.5),
    };
  });
  await page.mouse.click(taxonomyPoint.x, taxonomyPoint.y, { button: "right" });
  await page.getByRole("button", { name: "Collapse Group" }).click();
  await expect(page.getByRole("button", { name: "Preserve Width" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Minimize" })).toBeVisible();
  await page.getByRole("button", { name: "Minimize" }).click();
  await expect.poll(async () => page.evaluate(() => (
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCollapsedNodeModes() ?? []
  ))).toContainEqual([nodes.collapsedNode, "minimize"]);
});
