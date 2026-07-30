import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TREE_PATH = path.join(TEST_DIR, "fixtures", "collapse-subtree-tree.nwk");

function balancedTreeNewick(tipCount: number): string {
  let nodes = Array.from({ length: tipCount }, (_, index) => `T${index}:1`);
  while (nodes.length > 1) {
    const parents: string[] = [];
    for (let index = 0; index < nodes.length; index += 2) {
      parents.push(`(${nodes[index]},${nodes[index + 1]}):1`);
    }
    nodes = parents;
  }
  return `${nodes[0].replace(/:1$/, "")};`;
}

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
    const mappedTips = tips.filter((_, index) => index !== 1);
    app.setTaxonomyMapForTest({
      version: 1,
      mappedCount: mappedTips.length,
      totalTips: tips.length,
      activeRanks: ["family"],
      tipRanks: mappedTips.map((node) => {
        const index = tips.indexOf(node);
        return {
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
        };
      }),
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
      preservedRibbonStillVisible: hitboxes.some((candidate) => (
        candidate.labelKind === "taxonomy"
        && candidate.text === "Alphaidae"
        && candidate.source !== "collapse"
      )),
      outsideTipSpacing: Math.abs(firstTipSegment.y1 - secondTipSegment.y1),
      triangleProbe,
      branchProbe,
    };
  }, nodes);

  expect(Number(minimized.triangle.height)).toBeLessThan(Number(preserved.triangle.height) * 0.8);
  expect(Number(minimized.triangle.height) / minimized.outsideTipSpacing).toBeCloseTo(2, 1);
  expect(minimized.collapseHitboxCount).toBeGreaterThanOrEqual(2);
  expect(minimized.preservedRibbonStillVisible).toBeFalsy();
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
  const minimizedTrianglePoint = await page.evaluate((triangle) => {
    const canvas = document.querySelector("[data-testid=tree-canvas]");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Tree canvas unavailable.");
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + Number(triangle.x) + (Number(triangle.width) * 0.2),
      y: rect.top + Number(triangle.y) + (Number(triangle.height) * 0.5),
    };
  }, minimized.triangle);
  await page.mouse.move(minimizedTrianglePoint.x, minimizedTrianglePoint.y);
  await expect(page.locator(".hover-tooltip")).toContainText("Alphaidae");
  await expect(page.locator(".hover-tooltip")).toContainText("Rank: family");
  const hoverOverlayPixelCount = await page.evaluate(() => {
    const overlay = document.querySelector(".tree-canvas-overlay");
    if (!(overlay instanceof HTMLCanvasElement)) {
      return 0;
    }
    const context = overlay.getContext("2d");
    if (!context) {
      return 0;
    }
    const pixels = context.getImageData(0, 0, overlay.width, overlay.height).data;
    let count = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) {
        count += 1;
      }
    }
    return count;
  });
  expect(hoverOverlayPixelCount).toBeGreaterThan(10);

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
  const minimizedTrianglePoint = await page.evaluate((node) => {
    const canvas = document.querySelector("[data-testid=tree-canvas]");
    const hitboxes = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [];
    const triangle = hitboxes
      .filter((candidate) => candidate.node === node && candidate.source === "collapse")
      .sort((left, right) => Number(right.width) - Number(left.width))[0];
    if (!(canvas instanceof HTMLCanvasElement) || !triangle) {
      throw new Error("Minimized taxonomy triangle context-menu target unavailable.");
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + Number(triangle.x) + (Number(triangle.width) * 0.2),
      y: rect.top + Number(triangle.y) + (Number(triangle.height) * 0.5),
    };
  }, nodes.collapsedNode);
  await page.mouse.click(minimizedTrianglePoint.x, minimizedTrianglePoint.y, { button: "right" });
  await expect(page.getByRole("button", { name: "Expand Group" })).toBeVisible();
});

test("large minimized clades retain a viewport sliver until three-tip spacing is larger", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__,
  ));
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(balancedTreeNewick(4096));
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => (
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded
    && !window.__BIG_TREE_VIEWER_APP_TEST__?.getState().loading
    && (window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? []).includes("T4095")
  ));

  const fitResult = await page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const canvasTest = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const canvas = document.querySelector("[data-testid=tree-canvas]");
    if (!app || !canvasTest || !internal?.leafNodes || !internal.parent || !internal.firstChild || !internal.nextSibling || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Large collapse test hooks unavailable.");
    }
    const leafSet = new Set(internal.leafNodes);
    const descendantCounts = new Array<number>(internal.parent.length).fill(0);
    for (let node = internal.parent.length - 1; node >= 0; node -= 1) {
      let count = leafSet.has(node) ? 1 : 0;
      for (let child = internal.firstChild[node]; child >= 0; child = internal.nextSibling[child]) {
        count += descendantCounts[child];
      }
      descendantCounts[node] = count;
    }
    const targetNode = descendantCounts.findIndex((count, node) => (
      count >= 1024
      && count <= 2048
      && internal.parent![node] >= 0
      && internal.firstChild![node] >= 0
    ));
    if (targetNode < 0) {
      throw new Error("Large collapse target unavailable.");
    }
    app.setViewMode("rectangular");
    app.setOrder("input");
    canvasTest.fitView();
    canvasTest.setCollapsedNodeMode(targetNode, "minimize");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const triangle = (canvasTest.getLabelHitboxes() ?? [])
      .filter((candidate) => candidate.node === targetNode && candidate.source === "collapse")
      .sort((left, right) => Number(right.width) - Number(left.width))[0];
    const camera = canvasTest.getCamera();
    if (!triangle || !camera || camera.kind !== "rect") {
      throw new Error("Large minimized triangle unavailable.");
    }
    const leafIndexMap = canvasTest.getLeafIndexMap();
    if (!leafIndexMap) {
      throw new Error("Large collapse leaf order unavailable.");
    }
    const descendantLeaves = internal.leafNodes.filter((leaf) => {
      for (let current = leaf; current >= 0; current = internal.parent![current]) {
        if (current === targetNode) {
          return true;
        }
      }
      return false;
    });
    const descendantIndices = descendantLeaves.map((leaf) => leafIndexMap[leaf]).sort((left, right) => left - right);
    const outsideLeaf = internal.leafNodes
      .filter((leaf) => !descendantLeaves.includes(leaf))
      .sort((left, right) => (
        Math.min(
          Math.abs(leafIndexMap[left] - descendantIndices[0]),
          Math.abs(leafIndexMap[left] - descendantIndices[descendantIndices.length - 1]),
        )
        - Math.min(
          Math.abs(leafIndexMap[right] - descendantIndices[0]),
          Math.abs(leafIndexMap[right] - descendantIndices[descendantIndices.length - 1]),
        )
      ))[0];
    const outsideSegment = canvasTest.getBranchScreenSegmentForTest(outsideLeaf);
    if (!outsideSegment) {
      throw new Error("Nearest outside branch unavailable.");
    }
    const distanceFromTriangle = outsideSegment.y1 < Number(triangle.y)
      ? Number(triangle.y) - outsideSegment.y1
      : outsideSegment.y1 - (Number(triangle.y) + Number(triangle.height));
    return {
      targetNode,
      height: Number(triangle.height),
      viewportHeight: canvas.getBoundingClientRect().height,
      scaleY: Number(camera.scaleY),
      distanceFromTriangle,
      outsideLeaf,
      centerWorldY: (
        Number(triangle.y) + (Number(triangle.height) * 0.5) - Number(camera.translateY)
      ) / Number(camera.scaleY),
    };
  });

  expect(fitResult.height).toBeGreaterThanOrEqual(fitResult.viewportHeight * 0.0095);
  expect(fitResult.distanceFromTriangle).toBeGreaterThanOrEqual(0);

  const wheelSamples: Array<{ centerY: number; height: number; distanceFromTriangle: number }> = [];
  await page.evaluate(({ targetNode, outsideLeaf }) => {
    const canvasTest = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    if (!canvasTest?.startCollapsedTriangleDrawCapture) {
      throw new Error("Collapsed triangle draw capture unavailable.");
    }
    canvasTest.startCollapsedTriangleDrawCapture(targetNode, outsideLeaf);
  }, fitResult);
  for (let step = 0; step < 6; step += 1) {
    const point = await page.evaluate(({ targetNode }) => {
      const canvas = document.querySelector("[data-testid=tree-canvas]");
      const triangle = (window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [])
        .filter((candidate) => candidate.node === targetNode && candidate.source === "collapse")
        .sort((left, right) => Number(right.width) - Number(left.width))[0];
      if (!(canvas instanceof HTMLCanvasElement) || !triangle) {
        throw new Error("Wheel zoom triangle unavailable.");
      }
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + Number(triangle.x) + (Number(triangle.width) * 0.35),
        y: rect.top + Number(triangle.y) + (Number(triangle.height) * 0.5),
      };
    }, fitResult);
    await page.evaluate(({ x, y }) => {
      const shell = document.querySelector(".tree-canvas-shell");
      if (!(shell instanceof HTMLElement)) {
        throw new Error("Tree canvas shell unavailable.");
      }
      shell.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        deltaY: -100,
      }));
    }, point);
    await settleFrames(page);
    wheelSamples.push(await page.evaluate(({ targetNode, outsideLeaf }) => {
      const canvasTest = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
      const triangle = (canvasTest?.getLabelHitboxes() ?? [])
        .filter((candidate) => candidate.node === targetNode && candidate.source === "collapse")
        .sort((left, right) => Number(right.width) - Number(left.width))[0];
      const outsideSegment = canvasTest?.getBranchScreenSegmentForTest(outsideLeaf);
      if (!triangle || !outsideSegment) {
        throw new Error("Wheel zoom neighbor geometry unavailable.");
      }
      const top = Number(triangle.y);
      const height = Number(triangle.height);
      return {
        centerY: top + (height * 0.5),
        height,
        distanceFromTriangle: outsideSegment.y1 < top
          ? top - outsideSegment.y1
          : outsideSegment.y1 - (top + height),
      };
    }, fitResult));
  }
  const wheelCenters = wheelSamples.map((sample) => sample.centerY);
  expect(Math.max(...wheelCenters) - Math.min(...wheelCenters)).toBeLessThan(1);
  for (let index = 0; index < wheelSamples.length; index += 1) {
    expect(wheelSamples[index].height).toBeCloseTo(fitResult.height, 0);
    expect(wheelSamples[index].distanceFromTriangle).toBeGreaterThanOrEqual(0);
    if (index > 0) {
      expect(wheelSamples[index].distanceFromTriangle)
        .toBeGreaterThanOrEqual(wheelSamples[index - 1].distanceFromTriangle - 0.1);
    }
  }
  const transientWheelSamples = await page.evaluate(() => (
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.stopCollapsedTriangleDrawCapture() ?? []
  ));
  const wheelScaleY = await page.evaluate(() => Number(
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()?.scaleY ?? 0,
  ));
  expect(wheelScaleY).toBeGreaterThan(fitResult.scaleY);
  expect(transientWheelSamples.length).toBeGreaterThanOrEqual(6);
  const transientHeights = transientWheelSamples.map((sample) => sample.height);
  expect(Math.max(...transientHeights) - Math.min(...transientHeights)).toBeLessThan(1);
  const transientCenters = transientWheelSamples.map((sample) => sample.centerY);
  expect(Math.max(...transientCenters) - Math.min(...transientCenters)).toBeLessThan(1);
  const transientNeighborDistances = transientWheelSamples
    .filter((sample) => sample.neighborY !== null)
    .map((sample) => Math.abs(Number(sample.neighborY) - sample.centerY));
  for (let index = 1; index < transientNeighborDistances.length; index += 1) {
    expect(transientNeighborDistances[index])
      .toBeGreaterThanOrEqual(transientNeighborDistances[index - 1] - 0.1);
  }

  const zoomedResult = await page.evaluate(async ({ targetNode, centerWorldY, outsideLeaf }) => {
    const canvasTest = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const canvas = document.querySelector("[data-testid=tree-canvas]");
    if (!canvasTest || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Large zoom test hooks unavailable.");
    }
    const viewportHeight = canvas.getBoundingClientRect().height;
    const scaleY = 8;
    canvasTest.setRectCamera({
      scaleY,
      translateY: (viewportHeight * 0.5) - (centerWorldY * scaleY),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const triangle = (canvasTest.getLabelHitboxes() ?? [])
      .filter((candidate) => candidate.node === targetNode && candidate.source === "collapse")
      .sort((left, right) => Number(right.width) - Number(left.width))[0];
    if (!triangle) {
      throw new Error("Zoomed minimized triangle unavailable.");
    }
    const outsideSegment = canvasTest.getBranchScreenSegmentForTest(outsideLeaf);
    if (!outsideSegment) {
      throw new Error("Zoomed outside branch unavailable.");
    }
    const distanceFromTriangle = outsideSegment.y1 < Number(triangle.y)
      ? Number(triangle.y) - outsideSegment.y1
      : outsideSegment.y1 - (Number(triangle.y) + Number(triangle.height));
    return {
      height: Number(triangle.height),
      distanceFromTriangle,
    };
  }, fitResult);
  expect(zoomedResult.height).toBeGreaterThan(fitResult.height * 1.5);
  expect(zoomedResult.distanceFromTriangle).toBeGreaterThanOrEqual(0);
});

test("terminal polytomy and collapsed triangle strokes stop at the present-day boundary", async ({ page }) => {
  await loadFixture(page);
  const previousSignature = await page.evaluate(() => (
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeSignature ?? null
  ));
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("((A:0,B:0,C:0):1,D:1.001)Root;");
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction((oldSignature) => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.treeLoaded
      && !state.loading
      && state.treeSignature !== oldSignature
      && (window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes ?? []).length === 4;
  }, previousSignature);

  const alignment = await page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    let canvasTest = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    if (!app || !canvasTest || !internal?.names || !internal.parent) {
      throw new Error("Terminal alignment test hooks unavailable.");
    }
    app.setViewMode("rectangular");
    app.setOrder("input");
    app.setShowTipLabels(false);
    app.setShowTimeStripes(false);
    app.setTaxonomyMapForTest({
      version: 1,
      mappedCount: 4,
      totalTips: 4,
      activeRanks: ["class"],
      tipRanks: internal.names.flatMap((name, node) => (
        ["A", "B", "C", "D"].includes(name)
          ? [{
              node,
              ranks: { class: name === "D" ? "Outgroupia" : "Polytomia" },
              taxIds: { class: name === "D" ? 902 : 901 },
            }]
          : []
      )),
    });
    app.setTaxonomyRankDisplayModeForTest("class", "label-only");
    for (let frame = 0; frame < 10; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount === 4) {
        break;
      }
    }
    canvasTest = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    if (!canvasTest) {
      throw new Error("Updated canvas test hooks unavailable.");
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const mode = (
        window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.rect as { branchRenderMode?: string } | undefined
      )?.branchRenderMode;
      if (mode?.startsWith("taxonomy-cached-")) {
        break;
      }
    }
    const fittedCamera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (fittedCamera?.kind === "rect") {
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setRectCamera({
        scaleY: 40,
        translateY: 300,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }
    canvasTest = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    if (!canvasTest) {
      throw new Error("Rendered canvas test hooks unavailable.");
    }
    const camera = canvasTest.getCamera();
    if (!camera || camera.kind !== "rect") {
      throw new Error("Rectangular camera unavailable.");
    }
    const nodeByName = new Map(internal.names.map((name, node) => [name, node]));
    const tipA = nodeByName.get("A");
    const tipC = nodeByName.get("C");
    if (tipA === undefined || tipC === undefined) {
      throw new Error("Terminal polytomy tips unavailable.");
    }
    const tipASegment = canvasTest.getBranchScreenSegmentForTest(tipA);
    const tipCSegment = canvasTest.getBranchScreenSegmentForTest(tipC);
    const canvas = document.querySelector("[data-testid=tree-canvas]");
    if (!tipASegment || !tipCSegment || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Terminal polytomy raster geometry unavailable.");
    }
    const polytomyNode = internal.parent[tipA];
    const locallyDetectedTerminalPolytomy = canvasTest.isTerminalRectConnectorForTest(polytomyNode);
    const presentBoundaryX = Math.max(tipASegment.x1, tipASegment.x2);
    const branchRenderMode = (
      canvasTest.getRenderDebug()?.rect as { branchRenderMode?: string } | undefined
    )?.branchRenderMode;
    const svg = canvasTest.buildCurrentSvgForTest();
    if (!svg) {
      throw new Error("SVG scene unavailable.");
    }
    const documentNode = new DOMParser().parseFromString(svg, "image/svg+xml");
    const terminalLines = Array.from(documentNode.querySelectorAll("line"))
      .map((line) => ({
        x1: Number(line.getAttribute("x1")),
        x2: Number(line.getAttribute("x2")),
        y1: Number(line.getAttribute("y1")),
        y2: Number(line.getAttribute("y2")),
        width: Number(line.getAttribute("stroke-width")),
      }))
      .filter((line) => (
        Math.abs(line.x1 - line.x2) < 1e-6
        && Math.abs(line.y1 - line.y2) > 1
        && line.x1 <= presentBoundaryX + 1
      ));
    const terminalConnector = terminalLines.reduce((rightmost, line) => (
      line.x1 > rightmost.x1 ? line : rightmost
    ));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Tree canvas context unavailable.");
    }
    const cssRect = canvas.getBoundingClientRect();
    const dpr = canvas.width / cssRect.width;
    const firstProhibitedDeviceX = Math.ceil(presentBoundaryX * dpr);
    const minDeviceY = Math.max(0, Math.floor(Math.min(tipASegment.y1, tipCSegment.y1) * dpr));
    const maxDeviceY = Math.min(canvas.height - 1, Math.ceil(Math.max(tipASegment.y1, tipCSegment.y1) * dpr));
    const rasterProbe = context.getImageData(
      firstProhibitedDeviceX,
      minDeviceY,
      Math.min(3, canvas.width - firstProhibitedDeviceX),
      Math.max(1, maxDeviceY - minDeviceY + 1),
    ).data;
    let paintedPixelsBeyondPresent = 0;
    for (let index = 0; index < rasterProbe.length; index += 4) {
      const red = rasterProbe[index];
      const green = rasterProbe[index + 1];
      const blue = rasterProbe[index + 2];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      if (
        rasterProbe[index + 3] > 0
        && (maximum - minimum > 10 || maximum < 180)
      ) {
        paintedPixelsBeyondPresent += 1;
      }
    }
    canvasTest.setCollapsedNodeMode(polytomyNode, "minimize");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const triangle = canvasTest.getCollapsedTriangleHitboxes()
      .find((candidate) => candidate.node === polytomyNode);
    if (!triangle) {
      throw new Error("Collapsed terminal triangle unavailable.");
    }
    const triangleMaxX = Math.max(...triangle.points.map((point) => point.x));
    return {
      presentBoundaryX,
      locallyDetectedTerminalPolytomy,
      paintedPixelsBeyondPresent,
      branchRenderMode,
      terminalConnectorOuterX: terminalConnector.x1 + (terminalConnector.width * 0.5),
      triangleOuterX: triangleMaxX + 0.55,
    };
  });

  expect(alignment.terminalConnectorOuterX).toBeCloseTo(alignment.presentBoundaryX, 2);
  expect(alignment.locallyDetectedTerminalPolytomy).toBe(true);
  expect(alignment.triangleOuterX).toBeLessThanOrEqual(alignment.presentBoundaryX + 0.02);
  expect(alignment.branchRenderMode).toMatch(/^taxonomy-cached-/);
  expect(alignment.paintedPixelsBeyondPresent).toBe(0);
});
