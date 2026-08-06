import { expect, test, type Page } from "@playwright/test";

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__
    && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded,
  ));
}

async function loadTreeFromPaste(page: Page, newick: string): Promise<void> {
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(newick);
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && !Boolean(state?.loading);
  });
}

async function centerFanTipAtDeepZoom(page: Page, targetLeafIndex: number): Promise<{
  node: number;
  sourcePixelsPerLeaf: number;
  sourceScale: number;
}> {
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("fan"));
  await page.waitForFunction(() => (
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === "fan"
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()?.kind === "circular"
  ));
  return page.evaluate(async (leafIndex) => {
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes ?? [];
    const canvasElement = document.querySelector("[data-testid=tree-canvas]");
    if (!canvas || !(canvasElement instanceof HTMLCanvasElement)) {
      throw new Error("Fan transition controls unavailable.");
    }
    canvas.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const node = leafNodes[leafIndex];
    const fitCamera = canvas.getCamera();
    const fitSegment = canvas.getBranchScreenSegmentForTest(node);
    if (!fitCamera || fitCamera.kind !== "circular" || !fitSegment) {
      throw new Error("Fan tip geometry unavailable.");
    }
    const sourceScale = Number(fitCamera.scale) * 8;
    const worldX = (fitSegment.x2 - Number(fitCamera.translateX)) / Number(fitCamera.scale);
    const worldY = (fitSegment.y2 - Number(fitCamera.translateY)) / Number(fitCamera.scale);
    const centerX = canvasElement.getBoundingClientRect().width * 0.5;
    const centerY = canvasElement.getBoundingClientRect().height * 0.5;
    canvas.setCircularCamera({
      scale: sourceScale,
      translateX: centerX - (worldX * sourceScale),
      translateY: centerY - (worldY * sourceScale),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const sourceRadius = Math.hypot(worldX, worldY);
    return {
      node,
      sourcePixelsPerLeaf: sourceRadius * sourceScale * (Math.PI / Math.max(1, leafNodes.length - 1)),
      sourceScale,
    };
  }, targetLeafIndex);
}

test("fan geometry fits an upper semicircle and supports precise rotation", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(
    page,
    "(((A_species:1,B_species:1):1,(C_species:1,D_species:1):1):1,((E_species:1,F_species:1):1,(G_species:1,H_species:1):1):1)Root;",
  );

  await page.getByRole("button", { name: "Fan", exact: true }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === "fan");
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const fitted = await page.evaluate(() => {
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const leafNode = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes?.[2] ?? -1;
    const camera = canvas?.getCamera();
    const labels = canvas?.getLabelHitboxes().filter((hitbox) => hitbox.labelKind === "tip") ?? [];
    const branch = leafNode >= 0 ? canvas?.getBranchScreenSegmentForTest(leafNode) : null;
    const hover = branch
      ? canvas?.probeHoverForTest((branch.x1 + branch.x2) * 0.5, (branch.y1 + branch.y2) * 0.5)
      : null;
    return {
      camera,
      leafNode,
      hoverNode: Number(hover?.node ?? -1),
      labelCount: labels.length,
      firstLabel: labels[0] ? { x: Number(labels[0].x), y: Number(labels[0].y) } : null,
      labelCentersY: labels.map((label) => Number(label.y) + (Number(label.height) * 0.5)),
      svg: canvas?.buildCurrentSvgForTest() ?? "",
    };
  });

  expect(fitted.camera?.kind).toBe("circular");
  expect(fitted.hoverNode).toBe(fitted.leafNode);
  expect(fitted.labelCount).toBe(8);
  const fanCenterY = Number((fitted.camera as { translateY?: number } | null)?.translateY);
  expect(Math.max(...fitted.labelCentersY)).toBeLessThanOrEqual(fanCenterY + 12);
  expect(fitted.svg).toContain("<path");
  expect(fitted.svg).toContain("A species");

  const rotationInput = page.getByRole("spinbutton", { name: "Rotation degrees" });
  await rotationInput.fill("12.34");
  await expect(rotationInput).toHaveValue("12.34");
  await page.waitForFunction(() => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    return camera?.kind === "circular" && Math.abs(camera.rotation - ((12.34 * Math.PI) / 180)) < 1e-6;
  });
  await page.waitForTimeout(180);
  const rotatedFirstLabel = await page.evaluate(() => {
    const label = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes()
      .find((hitbox) => hitbox.labelKind === "tip");
    return label ? { x: Number(label.x), y: Number(label.y) } : null;
  });
  expect(rotatedFirstLabel).not.toEqual(fitted.firstLabel);

  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(rotationInput).toHaveValue("0");
  await page.waitForFunction(() => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    return camera?.kind === "circular" && Math.abs(Number(camera.rotation)) < 1e-9;
  });
});

test("fan deep zoom keeps the same tip centered when switching to rectangular", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(
    page,
    "(((A_species:1,B_species:1):1,(C_species:1,D_species:1):1):1,((E_species:1,F_species:1):1,(G_species:1,H_species:1):1):1)Root;",
  );
  const source = await centerFanTipAtDeepZoom(page, 3);

  await page.getByRole("button", { name: "Rectangular", exact: true }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === "rectangular");
  const result = await page.evaluate(async (node) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const canvasElement = document.querySelector("[data-testid=tree-canvas]");
    const camera = canvas?.getCamera();
    const segment = canvas?.getBranchScreenSegmentForTest(node);
    const label = canvas?.getLabelHitboxes().find((hitbox) => hitbox.labelKind === "tip" && Number(hitbox.node) === node);
    if (!camera || camera.kind !== "rect" || !segment || !(canvasElement instanceof HTMLCanvasElement)) {
      throw new Error("Rectangular transition result unavailable.");
    }
    const rect = canvasElement.getBoundingClientRect();
    return {
      scaleY: Number(camera.scaleY),
      tipX: segment.x2,
      tipY: segment.y2,
      centerX: rect.width * 0.5,
      centerY: rect.height * 0.5,
      labelVisible: Boolean(label),
    };
  }, source.node);

  expect(result.labelVisible).toBe(true);
  expect(Math.abs(result.tipY - result.centerY)).toBeLessThanOrEqual(28);
  expect(Math.abs(result.tipX - result.centerX)).toBeLessThanOrEqual(80);
  expect(result.scaleY / source.sourcePixelsPerLeaf).toBeGreaterThan(0.8);
  expect(result.scaleY / source.sourcePixelsPerLeaf).toBeLessThan(1.2);
});

test("fan deep zoom keeps the same tip and spacing when switching to circular", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(
    page,
    "(((A_species:1,B_species:1):1,(C_species:1,D_species:1):1):1,((E_species:1,F_species:1):1,(G_species:1,H_species:1):1):1)Root;",
  );
  const source = await centerFanTipAtDeepZoom(page, 3);

  await page.getByRole("button", { name: "Circular", exact: true }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === "circular");
  const result = await page.evaluate(async (node) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const canvasElement = document.querySelector("[data-testid=tree-canvas]");
    const camera = canvas?.getCamera();
    const segment = canvas?.getBranchScreenSegmentForTest(node);
    const leafCount = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes?.length ?? 1;
    const label = canvas?.getLabelHitboxes().find((hitbox) => hitbox.labelKind === "tip" && Number(hitbox.node) === node);
    if (!camera || camera.kind !== "circular" || !segment || !(canvasElement instanceof HTMLCanvasElement)) {
      throw new Error("Circular transition result unavailable.");
    }
    const rect = canvasElement.getBoundingClientRect();
    const worldX = (segment.x2 - Number(camera.translateX)) / Number(camera.scale);
    const worldY = (segment.y2 - Number(camera.translateY)) / Number(camera.scale);
    return {
      scale: Number(camera.scale),
      pixelsPerLeaf: Math.hypot(worldX, worldY) * Number(camera.scale) * ((Math.PI * 2) / Math.max(1, leafCount)),
      tipX: segment.x2,
      tipY: segment.y2,
      centerX: rect.width * 0.5,
      centerY: rect.height * 0.5,
      labelVisible: Boolean(label),
    };
  }, source.node);

  expect(result.labelVisible).toBe(true);
  expect(Math.hypot(result.tipX - result.centerX, result.tipY - result.centerY)).toBeLessThanOrEqual(32);
  expect(result.pixelsPerLeaf / source.sourcePixelsPerLeaf).toBeGreaterThan(0.8);
  expect(result.pixelsPerLeaf / source.sourcePixelsPerLeaf).toBeLessThan(1.2);
  expect(result.scale / source.sourceScale).toBeGreaterThan(0.35);
});

test("deep labeled views preserve the focal tip and taxonomy group across every geometry", async ({ page }) => {
  test.setTimeout(60_000);
  await waitForViewer(page);
  const tipCount = 1200;
  const newick = `(${Array.from({ length: tipCount }, (_, index) => `Tip_${String(index).padStart(4, "0")}:1`).join(",")})Root;`;
  await loadTreeFromPaste(page, newick);

  const targetNode = await page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes ?? [];
    const canvasElement = document.querySelector("[data-testid=tree-canvas]");
    if (!app || !canvas || !(canvasElement instanceof HTMLCanvasElement) || leafNodes.length !== 1200) {
      throw new Error("Geometry continuity controls unavailable.");
    }
    app.setTaxonomyMapForTest({
      version: 1,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["phylum", "class", "order", "family", "genus"],
      tipRanks: leafNodes.map((node, index) => ({
        node,
        ranks: {
          phylum: `Phylum${Math.floor(index / 600)}`,
          class: `Class${Math.floor(index / 100)}`,
          order: `Order${Math.floor(index / 20)}`,
          family: `Family${Math.floor(index / 5)}`,
          genus: `Genus${index}`,
        },
      })),
    });
    app.setTaxonomyEnabled(true);
    app.setViewMode("rectangular");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const currentCanvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    currentCanvas?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const node = leafNodes[649];
    const camera = currentCanvas?.getCamera();
    const segment = currentCanvas?.getBranchScreenSegmentForTest(node);
    if (!camera || camera.kind !== "rect" || !segment) {
      throw new Error("Rectangular focal tip unavailable.");
    }
    const worldX = (segment.x2 - Number(camera.translateX)) / Number(camera.scaleX);
    const worldY = (segment.y2 - Number(camera.translateY)) / Number(camera.scaleY);
    const rect = canvasElement.getBoundingClientRect();
    const scaleX = Math.max(Number(camera.scaleX), rect.width * 0.5);
    const scaleY = 12;
    currentCanvas?.setRectCamera({
      scaleX,
      scaleY,
      translateX: (rect.width * 0.5) - (worldX * scaleX),
      translateY: (rect.height * 0.5) - (worldY * scaleY),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return node;
  });

  const transitions = [
    "fan",
    "spiral",
    "circular",
    "fan",
    "circular",
    "rectangular",
    "spiral",
    "fan",
    "rectangular",
    "circular",
    "spiral",
    "rectangular",
  ] as const;
  const targetTaxonomyRibbons = ["Phylum1", "Class6", "Order32", "Family129", "Genus649"];
  let previousMode: "rectangular" | "fan" | "circular" | "spiral" = "rectangular";
  for (let transitionIndex = 0; transitionIndex < transitions.length; transitionIndex += 1) {
    const mode = transitions[transitionIndex];
    const transitionLabel = `${previousMode}->${mode}`;
    await page.evaluate((nextMode) => window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode(nextMode), mode);
    await page.waitForFunction((nextMode) => (
      window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === nextMode
    ), mode);
    await expect.poll(async () => page.evaluate(({ node, expectedTaxonomyRibbons }) => {
      const hitboxes = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [];
      const ribbons = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getTaxonomyArcHitboxes() ?? [];
      return {
        tip: hitboxes.some((hitbox) => hitbox.labelKind === "tip" && Number(hitbox.node) === node),
        classLabel: hitboxes.some((hitbox) => hitbox.labelKind === "taxonomy" && hitbox.text === "Class6"),
        missingTaxonomy: expectedTaxonomyRibbons.filter((label) => (
          !ribbons.some((ribbon) => ribbon.label === label)
        )),
        camera: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() ?? null,
        visibleTipNodes: hitboxes.filter((hitbox) => hitbox.labelKind === "tip").slice(0, 8).map((hitbox) => Number(hitbox.node)),
        visibleTaxonomy: hitboxes.filter((hitbox) => hitbox.labelKind === "taxonomy").slice(0, 8).map((hitbox) => String(hitbox.text)),
      };
    }, { node: targetNode, expectedTaxonomyRibbons: targetTaxonomyRibbons }), {
      message: `${transitionLabel} should retain the focal tip and taxonomy label`,
      timeout: 10_000,
    }).toMatchObject({ tip: true, classLabel: true, missingTaxonomy: [] });
    const position = await page.evaluate(({ node, expectedTaxonomyRibbons }) => {
      const hitboxes = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [];
      const ribbons = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getTaxonomyArcHitboxes() ?? [];
      const canvasElement = document.querySelector("[data-testid=tree-canvas]");
      const tip = hitboxes.find((hitbox) => hitbox.labelKind === "tip" && Number(hitbox.node) === node);
      const taxonomy = hitboxes.find((hitbox) => hitbox.labelKind === "taxonomy" && hitbox.text === "Class6");
      const taxonomyRibbons = expectedTaxonomyRibbons.map((label) => (
        ribbons.find((ribbon) => ribbon.label === label)
      ));
      if (!tip || !taxonomy || taxonomyRibbons.some((ribbon) => !ribbon) || !(canvasElement instanceof HTMLCanvasElement)) {
        throw new Error("Focal labels unavailable after geometry transition.");
      }
      const boundsFor = (hitbox: (typeof hitboxes)[number]) => {
        if (hitbox.kind === "rect") {
          return {
            left: Number(hitbox.x),
            right: Number(hitbox.x) + Number(hitbox.width),
            top: Number(hitbox.y),
            bottom: Number(hitbox.y) + Number(hitbox.height),
          };
        }
        const width = Number(hitbox.width);
        const height = Number(hitbox.height);
        const minX = hitbox.align === "right" ? -width : hitbox.align === "center" ? -width * 0.5 : 0;
        const maxX = hitbox.align === "right" ? 0 : hitbox.align === "center" ? width * 0.5 : width;
        const minY = -height * 0.5;
        const maxY = height * 0.5;
        const rotation = Number(hitbox.rotation ?? 0);
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        const corners = [
          [minX, minY],
          [maxX, minY],
          [maxX, maxY],
          [minX, maxY],
        ].map(([x, y]) => ({
          x: Number(hitbox.x) + (x * cos) - (y * sin),
          y: Number(hitbox.y) + (x * sin) + (y * cos),
        }));
        return {
          left: Math.min(...corners.map((corner) => corner.x)),
          right: Math.max(...corners.map((corner) => corner.x)),
          top: Math.min(...corners.map((corner) => corner.y)),
          bottom: Math.max(...corners.map((corner) => corner.y)),
        };
      };
      const rect = canvasElement.getBoundingClientRect();
      const tipBounds = boundsFor(tip);
      const taxonomyBounds = boundsFor(taxonomy);
      const ribbonBounds = taxonomyRibbons.map((ribbon) => ribbon!.screenPolygonBounds as {
        left: number;
        right: number;
        top: number;
        bottom: number;
      });
      return {
        tipBounds,
        taxonomyBounds,
        ribbonBounds,
        taxonomyX: (taxonomyBounds.left + taxonomyBounds.right) * 0.5,
        taxonomyY: (taxonomyBounds.top + taxonomyBounds.bottom) * 0.5,
        centerX: rect.width * 0.5,
        centerY: rect.height * 0.5,
        width: rect.width,
        height: rect.height,
      };
    }, { node: targetNode, expectedTaxonomyRibbons: targetTaxonomyRibbons });
    expect(position.tipBounds.right, `${transitionLabel} focal tip right edge`).toBeGreaterThan(0);
    expect(position.tipBounds.left, `${transitionLabel} focal tip left edge`).toBeLessThan(position.width);
    expect(position.tipBounds.bottom, `${transitionLabel} focal tip bottom edge`).toBeGreaterThan(0);
    expect(position.tipBounds.top, `${transitionLabel} focal tip top edge`).toBeLessThan(position.height);
    expect(position.taxonomyBounds.left, `${transitionLabel} Class6 left edge`).toBeGreaterThanOrEqual(-2);
    expect(position.taxonomyBounds.right, `${transitionLabel} Class6 right edge`).toBeLessThanOrEqual(position.width + 2);
    expect(position.taxonomyBounds.top, `${transitionLabel} Class6 top edge`).toBeGreaterThanOrEqual(-2);
    expect(position.taxonomyBounds.bottom, `${transitionLabel} Class6 bottom edge`).toBeLessThanOrEqual(position.height + 2);
    for (const [ribbonIndex, bounds] of position.ribbonBounds.entries()) {
      expect(bounds.right, `${transitionLabel} ${targetTaxonomyRibbons[ribbonIndex]} ribbon right edge`).toBeGreaterThan(0);
      expect(bounds.left, `${transitionLabel} ${targetTaxonomyRibbons[ribbonIndex]} ribbon left edge`).toBeLessThan(position.width);
      expect(bounds.bottom, `${transitionLabel} ${targetTaxonomyRibbons[ribbonIndex]} ribbon bottom edge`).toBeGreaterThan(0);
      expect(bounds.top, `${transitionLabel} ${targetTaxonomyRibbons[ribbonIndex]} ribbon top edge`).toBeLessThan(position.height);
    }
    expect(
      Math.hypot(position.taxonomyX - position.centerX, position.taxonomyY - position.centerY),
      `${transitionLabel} focal taxonomy label`,
    ).toBeLessThanOrEqual(220);
    previousMode = mode;
  }
});

test("fan taxonomy ribbons and labels use the semicircular geometry", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "(((A:1,B:1):1,(C:1,D:1):1):1,((E:1,F:1):1,(G:1,H:1):1):1)Root;");
  await page.getByRole("button", { name: "Fan", exact: true }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === "fan");

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes ?? [];
    if (!app || leafNodes.length !== 8) {
      throw new Error("Fan taxonomy test controls unavailable.");
    }
    app.setTaxonomyMapForTest({
      version: 1,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["class"],
      tipRanks: leafNodes.map((node, index) => ({
        node,
        ranks: { class: index < 4 ? "Alpha" : "Beta" },
      })),
    });
    app.setTaxonomyRankVisibilityAutoForTest(false);
    app.setTaxonomyRankVisibilityForTest("class", true);
    app.setTaxonomyEnabled(true);
    app.requestFit();
  });
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyEnabled));
  const result = await page.evaluate(async () => {
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    if (!canvas) {
      throw new Error("Fan taxonomy canvas controls unavailable.");
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return {
      arcs: canvas.getTaxonomyArcHitboxes(),
      labels: canvas.getLabelHitboxes()
        .filter((hitbox) => hitbox.labelKind === "taxonomy")
        .map((hitbox) => String(hitbox.text)),
      svg: canvas.buildCurrentSvgForTest(),
    };
  });

  expect(result.arcs.length).toBeGreaterThanOrEqual(2);
  expect(result.labels).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
  expect(result.svg).toContain("Alpha");
  expect(result.svg).toContain("Beta");
});

test("all available geometry buttons fit their segmented control", async ({ page }) => {
  await waitForViewer(page);
  await page.keyboard.down("Shift");
  await page.keyboard.down("S");
  await page.keyboard.down("P");
  await page.keyboard.up("P");
  await page.keyboard.up("S");
  await page.keyboard.up("Shift");
  await expect(page.getByRole("button", { name: "Spiral", exact: true })).toBeVisible();

  const geometryButtons = page.getByRole("button", {
    name: /^(Rectangular|Circular|Fan|Spiral)$/,
  });
  await expect(geometryButtons).toHaveCount(4);
  const fit = await geometryButtons.evaluateAll((buttons) => buttons.map((button) => ({
    text: button.textContent?.trim() ?? "",
    clientWidth: (button as HTMLElement).clientWidth,
    scrollWidth: (button as HTMLElement).scrollWidth,
    top: (button as HTMLElement).getBoundingClientRect().top,
  })));
  expect(new Set(fit.map((button) => Math.round(button.top))).size).toBe(1);
  for (const button of fit) {
    expect(button.scrollWidth, button.text).toBeLessThanOrEqual(button.clientWidth);
  }

  await page.setViewportSize({ width: 430, height: 900 });
  await geometryButtons.first().scrollIntoViewIfNeeded();
  const mobileFit = await geometryButtons.evaluateAll((buttons) => buttons.map((button) => ({
    text: button.textContent?.trim() ?? "",
    clientWidth: (button as HTMLElement).clientWidth,
    scrollWidth: (button as HTMLElement).scrollWidth,
    top: (button as HTMLElement).getBoundingClientRect().top,
  })));
  expect(new Set(mobileFit.map((button) => Math.round(button.top))).size).toBe(1);
  for (const button of mobileFit) {
    expect(button.scrollWidth, `mobile ${button.text}`).toBeLessThanOrEqual(button.clientWidth);
  }
});

test("URL launch accepts fan geometry", async ({ page }) => {
  const params = new URLSearchParams({
    btv_newick: "((A:1,B:1):1,(C:1,D:1):1)Root;",
    btv_view: "fan",
    btv_rotation: "4.25",
  });
  await page.goto(`/?${params.toString()}`);
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    return state?.treeLoaded && state.viewMode === "fan" && camera?.kind === "circular";
  });
  const result = await page.evaluate(() => ({
    state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState(),
    camera: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera(),
  }));
  expect(result.state?.viewMode).toBe("fan");
  expect(Number(result.camera?.rotation)).toBeCloseTo((4.25 * Math.PI) / 180, 6);
});

test("fan mode minimizes clades with a usable triangle hit target", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "(((A:1,B:1):1,(C:1,D:1):1):1,((E:1,F:1):1,(G:1,H:1):1):1)Root;");
  await page.getByRole("button", { name: "Fan", exact: true }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === "fan");

  const result = await page.evaluate(async () => {
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const firstLeaf = internal?.leafNodes?.[0] ?? -1;
    const targetNode = firstLeaf >= 0 ? Number(internal?.parent?.[firstLeaf] ?? -1) : -1;
    if (!canvas || targetNode < 0) {
      throw new Error("Fan collapse test controls unavailable.");
    }
    canvas.setCollapsedNodeMode(targetNode, "minimize");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const triangle = canvas.getCollapsedTriangleHitboxes().find((candidate) => candidate.node === targetNode) ?? null;
    const center = triangle
      ? {
          x: triangle.points.reduce((total, point) => total + point.x, 0) / triangle.points.length,
          y: triangle.points.reduce((total, point) => total + point.y, 0) / triangle.points.length,
        }
      : null;
    return {
      targetNode,
      triangle,
      hover: center ? canvas.probeHoverForTest(center.x, center.y) : null,
    };
  });

  expect(result.triangle?.points).toHaveLength(3);
  expect(Number(result.hover?.node)).toBe(result.targetNode);
});
