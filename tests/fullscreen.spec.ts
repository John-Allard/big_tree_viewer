import { expect, test } from "@playwright/test";

async function waitForViewer(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true);
}

for (const view of ["rectangular", "circular", "spiral"] as const) {
  test(`full screen preserves proportional coverage and focus in ${view} view`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: undefined });
    });
    const newick = "(((A_a:1,B_b:1):1,(C_c:1,D_d:1):1):1,((E_e:1,F_f:1):1,(G_g:1,H_h:1):1):1)Root;";
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=${view}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.waitForTimeout(150);
    await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView());
    const snapshot = () => page.evaluate(() => {
      const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera()!;
      const bounds = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect();
      const inset = window.__BIG_TREE_VIEWER_APP_TEST__!.getState().viewerLeftOcclusionPx;
      const canvasWidth = Math.floor(bounds.width);
      const height = Math.floor(bounds.height);
      const width = canvasWidth - inset;
      const scaleX = camera.kind === "rect" ? camera.scaleX : camera.scale;
      const scaleY = camera.kind === "rect" ? camera.scaleY : camera.scale;
      return {
        x: ((canvasWidth + inset) * 0.5 - camera.translateX) / scaleX,
        y: (height * 0.5 - camera.translateY) / scaleY,
        coverageX: scaleX / (camera.kind === "rect" ? width : Math.min(width, height)),
        coverageY: scaleY / (camera.kind === "rect" ? height : Math.min(width, height)),
      };
    });
    for (const zoomed of [false, true]) {
      if (zoomed) {
        const bounds = (await page.getByTestId("tree-canvas").boundingBox())!;
        await page.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.4);
        await page.mouse.wheel(0, -400);
        await page.waitForTimeout(250);
      }
      const before = await snapshot();
      for (const name of ["Enter full screen", "Exit full screen"]) {
        await page.getByRole("button", { name, exact: true }).click();
        await page.waitForTimeout(150);
        const after = await snapshot();
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
        expect(after.coverageX).toBeCloseTo(before.coverageX, 8);
        expect(after.coverageY).toBeCloseTo(before.coverageY, 8);
      }
    }
  });

  test(`side panel toggles keep the focused world point centered in ${view} view`, async ({ page }) => {
    const newick = "(((A_a:1,B_b:1):1,(C_c:1,D_d:1):1):1,((E_e:1,F_f:1):1,(G_g:1,H_h:1):1):1)Root;";
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=${view}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    const settle = () => page.waitForTimeout(250);
    await settle();
    await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView());
    const focus = () => page.evaluate(() => {
      const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera()!;
      const bounds = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect();
      const inset = window.__BIG_TREE_VIEWER_APP_TEST__!.getState().viewerLeftOcclusionPx;
      const centerX = (bounds.width + inset) * 0.5;
      const scaleX = camera.kind === "rect" ? camera.scaleX : camera.scale;
      const scaleY = camera.kind === "rect" ? camera.scaleY : camera.scale;
      return {
        x: (centerX - camera.translateX) / scaleX,
        y: (bounds.height * 0.5 - camera.translateY) / scaleY,
        scaleX, scaleY,
      };
    });
    for (const zoomed of [false, true]) {
      if (zoomed) {
        const bounds = await page.locator("[data-testid=tree-canvas]").boundingBox();
        await page.mouse.move(bounds!.x + bounds!.width * 0.7, bounds!.y + bounds!.height * 0.4);
        await page.mouse.wheel(0, -400);
        await settle();
      }
      const before = await focus();
      for (let cycle = 0; cycle < 2; cycle += 1) {
        for (const name of ["Hide side panel", "Show side panel"]) {
          await page.getByRole("button", { name, exact: true }).click();
          await settle();
          const after = await focus();
          expect(after.scaleX).toBeCloseTo(before.scaleX, 8);
          expect(after.scaleY).toBeCloseTo(before.scaleY, 8);
          expect(after.x).toBeCloseTo(before.x, 6);
          expect(after.y).toBeCloseTo(before.y, 6);
        }
      }
    }
  });
}

for (const view of ["rectangular", "circular"] as const) {
  test(`panel visibility and resizing preserve colors and collapsed clades in ${view} view`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: undefined });
    });
    const newick = "(((A_a:1,B_b:1):1,(C_c:1,D_d:1):1):1,((E_e:1,F_f:1):1,(G_g:1,H_h:1):1):1)Root;";
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=${view}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.evaluate(async () => {
      const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
      const leaves = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.leafNodes;
      app.setOrder("input");
      app.setShowGenusLabels(false);
      app.setShowTipLabels(false);
      app.setShowBootstrapLabels(true);
      app.setBranchThicknessScaleForTest(1.4);
      app.setFigureStyleForTest("taxonomy", "bandThicknessScale", 0.75);
      app.setTaxonomyColorRootRankForTest("phylum");
      app.setTaxonomyColorJitterForTest(0);
      app.setTaxonomyMapForTest({
        version: 10, mappedCount: leaves.length, totalTips: leaves.length,
        activeRanks: ["phylum"],
        tipRanks: leaves.map((node, index) => ({ node, ranks: { phylum: index < 4 ? "Chordata" : "Arthropoda" } })),
      });
      app.setTaxonomyRankDisplayModeForTest("phylum", "ribbon");
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView();
    });
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes().some(
      (hit) => hit.labelKind === "taxonomy" && hit.text === "Chordata",
    ));
    const point = await page.evaluate(() => {
      const hit = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getLabelHitboxes().find(
        (candidate) => candidate.labelKind === "taxonomy" && candidate.text === "Chordata",
      )!;
      const bounds = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect();
      return { x: bounds.left + hit.x + hit.width / 2, y: bounds.top + hit.y + hit.height / 2 };
    });
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page.getByRole("button", { name: "Color Top-Level Group", exact: true }).click();
    await page.getByRole("button", { name: "Set taxonomy-root color Red" }).click();
    await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getTaxonomyRootColors()))
      .toEqual([["Chordata", "#dc2626"]]);
    await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!;
      api.setManualBranchColor(internal.leafNodes[4], "#00aa44");
      api.setManualSubtreeColor(internal.parent![internal.leafNodes[6]], "#8844cc");
      api.setCollapsedNodeMode(internal.parent![internal.leafNodes[0]], "minimize");
    });
    await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCollapsedNodeModes().length)).toBe(1);
    const snapshot = () => page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const app = window.__BIG_TREE_VIEWER_APP_TEST__!.getState();
      return {
        rootColors: api.getTaxonomyRootColors(),
        branchColors: api.getCurrentBranchColors(),
        collapsedModes: api.getCollapsedNodeModes(),
        figureStyles: app.figureStyles,
        viewMode: app.viewMode,
        order: app.order,
        taxonomyEnabled: app.taxonomyEnabled,
        showTipLabels: app.showTipLabels,
        showBootstrapLabels: app.showBootstrapLabels,
        branchThicknessScale: app.branchThicknessScale,
      };
    });
    const before = await snapshot();
    expect(before.branchColors).toContain("#dc2626");
    expect(before.branchColors).toContain("#00aa44");
    expect(before.branchColors).toContain("#8844cc");
    const settle = () => page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }));
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await page.getByRole("button", { name: "Hide side panel", exact: true }).click();
      await settle();
      expect(await snapshot()).toEqual(before);
      await page.getByRole("button", { name: "Show side panel", exact: true }).click();
      await settle();
      expect(await snapshot()).toEqual(before);
    }
    for (const viewport of [{ width: 1500, height: 950 }, { width: 1100, height: 700 }]) {
      await page.setViewportSize(viewport);
      await settle();
      expect(await snapshot()).toEqual(before);
    }
    await page.getByRole("button", { name: "Enter full screen", exact: true }).click();
    await settle();
    expect(await snapshot()).toEqual(before);
    await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
    await settle();
    expect(await snapshot()).toEqual(before);

    // A replacement tree must still discard edits belonging to the old topology.
    await page.getByRole("button", { name: "Paste Newick", exact: true }).click();
    await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("(New_a:2,New_b:2)NewRoot;");
    await page.getByRole("button", { name: "Load Pasted Tree", exact: true }).click();
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes.length === 2);
    await settle();
    const replaced = await snapshot();
    expect(replaced.rootColors).toEqual([]);
    expect(replaced.collapsedModes).toEqual([]);
    for (const color of ["#dc2626", "#00aa44", "#8844cc"]) expect(replaced.branchColors).not.toContain(color);
  });
}

test("fit view uses the uncovered viewport after the side panel becomes an overlay", async ({ page }) => {
  await waitForViewer(page);
  await page.locator('.viewer-corner-controls button[aria-label="Hide side panel"]').click();
  await page.locator('.viewer-corner-controls button[aria-label="Show side panel"]').click();
  await page.waitForFunction(() => Number(
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewerLeftOcclusionPx ?? 0,
  ) > 300);

  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const result = await page.evaluate(() => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const canvas = document.querySelector("canvas")?.getBoundingClientRect();
    const panel = document.querySelector(".control-panel-shell")?.getBoundingClientRect();
    return {
      camera,
      canvasLeft: canvas?.left ?? 0,
      panelRight: panel?.right ?? 0,
    };
  });
  expect(result.camera?.kind).toBe("rect");
  expect(result.canvasLeft + Number(result.camera?.translateX ?? 0)).toBeGreaterThanOrEqual(result.panelRight + 24);

  await page.locator('.viewer-corner-controls button[aria-label="Hide side panel"]').click();
  await page.waitForFunction(() => Number(
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewerLeftOcclusionPx ?? -1,
  ) === 0);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const hiddenCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
  expect(hiddenCamera?.kind).toBe("rect");
  expect(Number(hiddenCamera?.translateX ?? 0)).toBeCloseTo(32, 0);
});

test("full screen retains the side panel and exposes compact viewport controls", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/");

  const app = page.locator(".app-shell");
  const panel = page.locator(".control-panel");
  const viewer = page.locator(".viewer-panel");
  const fitButton = page.getByRole("button", { name: "Fit View" });
  const enterButton = page.getByRole("button", { name: "Enter full screen" });
  const hidePanelButton = page.getByRole("button", { name: "Hide side panel" });

  await expect(fitButton).toBeVisible();
  await expect(page.getByRole("button", { name: "Full Screen", exact: true })).toHaveCount(0);
  const fitBounds = await fitButton.boundingBox();
  const panelBounds = await panel.boundingBox();
  const viewerBounds = await viewer.boundingBox();
  const viewerControlsBounds = await page.locator(".viewer-corner-controls").boundingBox();
  expect(fitBounds).not.toBeNull();
  expect(panelBounds).not.toBeNull();
  expect(viewerBounds).not.toBeNull();
  expect(viewerControlsBounds).not.toBeNull();
  expect(fitBounds?.width ?? 0).toBeGreaterThan((panelBounds?.width ?? 0) * 0.75);
  expect(viewerControlsBounds?.x ?? 0).toBeGreaterThanOrEqual(viewerBounds?.x ?? 0);
  expect(viewerControlsBounds?.x ?? Number.POSITIVE_INFINITY).toBeLessThan((viewerBounds?.x ?? 0) + 50);
  expect(viewerControlsBounds?.x ?? 0).toBeGreaterThanOrEqual(panelBounds?.x ? panelBounds.x + panelBounds.width : 0);

  await enterButton.click();
  await expect(app).toHaveClass(/app-shell-fullscreen-fallback/);
  await expect(panel).toBeVisible();
  await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible();

  const viewerWithPanel = await viewer.boundingBox();
  await hidePanelButton.click();
  await expect(app).toHaveClass(/sidebar-hidden/);
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "Show side panel" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible();
  const viewerWithoutPanel = await viewer.boundingBox();
  expect(viewerWithPanel).not.toBeNull();
  expect(viewerWithoutPanel).not.toBeNull();
  expect(viewerWithoutPanel?.width ?? 0).toBeGreaterThan(viewerWithPanel?.width ?? 0);

  const cameraBeforeRestore = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
  await page.getByRole("button", { name: "Show side panel" }).click();
  await expect(panel).toBeVisible();
  const viewerWithOverlay = await viewer.boundingBox();
  const overlayPanelBounds = await panel.boundingBox();
  const overlayControlsBounds = await page.locator(".viewer-corner-controls").boundingBox();
  const cameraAfterRestore = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera());
  expect(viewerWithOverlay).toEqual(viewerWithoutPanel);
  expect(cameraAfterRestore?.kind).toBe(cameraBeforeRestore?.kind);
  expect(Number(cameraAfterRestore?.translateX) - Number(cameraBeforeRestore?.translateX))
    .toBeCloseTo(Number(overlayPanelBounds?.width) * 0.5, 0);
  expect(cameraAfterRestore?.translateY).toEqual(cameraBeforeRestore?.translateY);
  expect(overlayPanelBounds?.x ?? 0).toBeLessThan((viewerWithOverlay?.x ?? 0) + (viewerWithOverlay?.width ?? 0));
  expect(overlayControlsBounds?.x ?? 0).toBeGreaterThanOrEqual(
    (overlayPanelBounds?.x ?? 0) + (overlayPanelBounds?.width ?? 0),
  );
  await page.getByRole("button", { name: "Exit full screen" }).click();
  await expect(app).not.toHaveClass(/app-shell-fullscreen/);
  await expect(page.getByRole("button", { name: "Enter full screen" })).toBeVisible();
});
