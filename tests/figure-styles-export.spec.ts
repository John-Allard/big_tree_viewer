import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__
    && window.__BIG_TREE_VIEWER_RENDER_DEBUG__
    && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded
    && !window.__BIG_TREE_VIEWER_APP_TEST__.getState().loading,
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

test("vector SVG export includes styled tip, internal, and bootstrap labels without raster embedding", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A_species:1,B_species:1)CladeOne:1,(C_species:1,D_species:1)92:1)Root;");

  const svg = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowInternalNodeLabels(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowBootstrapLabels(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("tip", "fontFamily", "arial");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("internalNode", "fontFamily", "georgia");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("bootstrap", "fontFamily", "courierNew");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("tip", "offsetPx", 12);
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? null;
  });

  expect(svg).toBeTruthy();
  expect(svg).toContain("<svg");
  expect(svg).not.toContain("<image");
  expect(svg).toContain("<line");
  expect(svg).toContain("<text");
  expect(svg).toContain("CladeOne");
  expect(svg).toContain(">92<");
  expect(svg).toContain("Arial");
  expect(svg).toContain("Georgia");
  expect(svg).toContain("Courier New");
});

test("tip labels can export with bold and italic styling", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A_species:1,B_species:1)CladeOne:1,(C_species:1,D_species:1)92:1)Root;");

  const svg = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("tip", "bold", true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("tip", "italic", true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? null;
  });

  expect(svg).toContain("font-style=\"italic\"");
  expect(svg).toContain("font-weight=\"700\"");
});

test("non-ultrametric tip labels can align at rectangular and circular tree edges", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "(Short_tip:0.4,Medium_tip:1.2,Mid_tip:1.8,Long_tip:2.1,Longest_tip:2.5)Root;");

  await page.getByRole("button", { name: "Visual Options" }).click();
  await page.getByRole("button", { name: "Tip labels settings" }).click();
  const alignControl = page.getByLabel("Align labels at tree edge");
  await expect(alignControl).toBeVisible();
  await expect(alignControl).not.toBeChecked();
  await alignControl.check();

  const aligned = await page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    if (!app || !canvas) {
      throw new Error("Aligned tip-label test controls unavailable.");
    }
    app.setShowGenusLabels(false);
    app.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const tipLabels = canvas.getLabelHitboxes()
      .filter((hitbox) => hitbox.labelKind === "tip")
      .map((hitbox) => ({
        text: String(hitbox.text),
        x: Number(hitbox.x),
      }));
    return {
      state: app.getState(),
      tipLabels,
      svg: canvas.buildCurrentSvgForTest(),
    };
  });

  expect(aligned.state.alignTipLabels).toBe(true);
  expect(aligned.tipLabels).toHaveLength(5);
  expect(new Set(aligned.tipLabels.map((label) => label.x.toFixed(3))).size).toBe(1);
  expect(aligned.svg).toContain("stroke-dasharray=\"1.5 3\"");

  const withTaxonomy = await page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes ?? [];
    if (!app || !canvas || leafNodes.length !== 5) {
      throw new Error("Taxonomy alignment test setup unavailable.");
    }
    app.setTaxonomyMapForTest({
      version: 1,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["class"],
      tipRanks: leafNodes.map((node) => ({
        node,
        ranks: { class: "TestClass" },
      })),
    });
    app.setTaxonomyRankVisibilityAutoForTest(false);
    app.setTaxonomyRankVisibilityForTest("class", true);
    app.setTaxonomyEnabled(true);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const tipLabels = canvas.getLabelHitboxes()
      .filter((hitbox) => hitbox.labelKind === "tip")
      .map((hitbox) => ({
        x: Number(hitbox.x),
        right: Number(hitbox.x) + Number(hitbox.width),
      }));
    const debug = canvas.getRenderDebug()?.rect as {
      taxonomyBandXs?: number[];
    } | undefined;
    return {
      tipLabels,
      firstRibbonX: Number(debug?.taxonomyBandXs?.[0] ?? Number.NaN),
    };
  });

  expect(new Set(withTaxonomy.tipLabels.map((label) => label.x.toFixed(3))).size).toBe(1);
  expect(withTaxonomy.firstRibbonX).toBeGreaterThan(
    Math.max(...withTaxonomy.tipLabels.map((label) => label.right)),
  );

  const alignedCircular = await page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    if (!app || !canvas) {
      throw new Error("Circular aligned-label test controls unavailable.");
    }
    app.setTaxonomyEnabled(false);
    app.setViewMode("circular");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const circularApp = window.__BIG_TREE_VIEWER_APP_TEST__;
    const circularCanvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    if (!circularApp || !circularCanvas) {
      throw new Error("Updated circular test controls unavailable.");
    }
    circularApp.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const svg = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest();
    if (!svg) {
      throw new Error("Circular aligned-label SVG unavailable.");
    }
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "circular") {
      throw new Error("Circular camera unavailable.");
    }
    const centerX = Number(camera.translateX);
    const centerY = Number(camera.translateY);
    const radii = (window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [])
      .filter((hitbox) => hitbox.labelKind === "tip")
      .map((hitbox) => Math.hypot(
        Number(hitbox.x) - centerX,
        Number(hitbox.y) - centerY,
      ));
    return { radii, svg };
  });

  await expect(alignControl).toBeEnabled();
  expect(alignedCircular.radii).toHaveLength(5);
  expect(Math.max(...alignedCircular.radii) - Math.min(...alignedCircular.radii)).toBeLessThan(0.5);
  expect(alignedCircular.svg).not.toContain("stroke-dasharray=\"1.5 3\"");

  const unalignedCircularRadii = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setAlignTipLabels(false);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "circular") {
      throw new Error("Circular camera unavailable after disabling alignment.");
    }
    const centerX = Number(camera.translateX);
    const centerY = Number(camera.translateY);
    return (window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [])
      .filter((hitbox) => hitbox.labelKind === "tip")
      .map((hitbox) => Math.hypot(
        Number(hitbox.x) - centerX,
        Number(hitbox.y) - centerY,
      ));
  });
  expect(Math.max(...unalignedCircularRadii) - Math.min(...unalignedCircularRadii)).toBeGreaterThan(20);
});

test("aligned tip-label control is disabled for ultrametric trees", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((Alpha_tip:1,Beta_tip:1):1,(Gamma_tip:1,Delta_tip:1):1)Root;");

  await page.getByRole("button", { name: "Visual Options" }).click();
  await page.getByRole("button", { name: "Tip labels settings" }).click();
  const control = page.getByLabel("Align labels at tree edge");
  await expect(control).toBeDisabled();
  const controlLabel = control.locator("xpath=..");
  await expect(controlLabel).toHaveClass(/label-style-disabled-control/);
  await expect(controlLabel).toHaveAttribute(
    "title",
    "Tip labels are already aligned because this tree is ultrametric.",
  );
});

test("label style popovers stay open while interacting with the tree and close on sidebar clicks", async ({ page }) => {
  await waitForViewer(page);

  await page.getByRole("button", { name: "Visual Options" }).click();
  await page.getByRole("button", { name: "Tip labels settings" }).click();
  await expect(page.getByRole("dialog", { name: "Tip labels settings" })).toBeVisible();

  await page.locator("[data-testid=tree-canvas]").click({ position: { x: 32, y: 32 } });
  await expect(page.getByRole("dialog", { name: "Tip labels settings" })).toBeVisible();

  await page.getByRole("heading", { name: "Big Tree Viewer" }).click();
  await expect(page.getByRole("dialog", { name: "Tip labels settings" })).toHaveCount(0);
});

test("time stripe settings live in a dedicated popover next to the toggle", async ({ page }) => {
  await waitForViewer(page);

  await page.getByRole("button", { name: "Visual Options" }).click();
  await page.getByRole("button", { name: "Time stripes settings" }).click();
  await expect(page.getByRole("dialog", { name: "Time stripes settings" })).toBeVisible();
  await expect(page.getByText("Stripe style")).toBeVisible();
});

test("download newick exports the active tree in the current tab", async ({ page }) => {
  await waitForViewer(page);
  const pastedNewick = "((A_species:1,B_species:1)CladeOne:1,(C_species:1,D_species:1)92:1)Root;";
  const exportedNewick = "((A_species:1,B_species:1)CladeOne:1,(C_species:1,D_species:1):1)Root;";
  await loadTreeFromPaste(page, pastedNewick);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Newick" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("pasted_tree.nwk");

  const path = await download.path();
  expect(path).toBeTruthy();
  const fileText = await readFile(path as string, "utf8");
  expect(fileText.trim()).toBe(exportedNewick);
});

test("point-anchored label styles support separate x and y offsets", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A_species:1,B_species:1)CladeOne:1,(C_species:1,D_species:1)92:1)Root;");

  const buildSvg = async () => page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowInternalNodeLabels(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowBootstrapLabels(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? null;
  });

  const extractTextPosition = (svg: string, text: string) => {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`<text x="([^"]+)" y="([^"]+)"[^>]*>${escaped}</text>`).exec(svg);
    if (!match) {
      throw new Error(`Unable to locate SVG text node for ${text}.`);
    }
    return {
      x: Number.parseFloat(match[1]),
      y: Number.parseFloat(match[2]),
    };
  };

  const baseSvg = await buildSvg();
  expect(baseSvg).toBeTruthy();
  const baseInternal = extractTextPosition(baseSvg ?? "", "CladeOne");
  const baseBootstrap = extractTextPosition(baseSvg ?? "", "92");

  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("internalNode", "offsetXPx", 18);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("internalNode", "offsetYPx", -10);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("bootstrap", "offsetXPx", -12);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("bootstrap", "offsetYPx", 14);
  });
  await page.waitForFunction(() => {
    const styles = window.__BIG_TREE_VIEWER_APP_TEST__?.getState().figureStyles;
    return styles?.internalNode.offsetXPx === 18
      && styles.internalNode.offsetYPx === -10
      && styles.bootstrap.offsetXPx === -12
      && styles.bootstrap.offsetYPx === 14;
  });
  const offsetSvg = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? null;
  });
  expect(offsetSvg).toBeTruthy();
  const offsetInternal = extractTextPosition(offsetSvg ?? "", "CladeOne");
  const offsetBootstrap = extractTextPosition(offsetSvg ?? "", "92");

  expect(offsetInternal.x - baseInternal.x).toBeCloseTo(18, 1);
  expect(offsetInternal.y - baseInternal.y).toBeCloseTo(-10, 1);
  expect(offsetBootstrap.x - baseBootstrap.x).toBeCloseTo(-12, 1);
  expect(offsetBootstrap.y - baseBootstrap.y).toBeCloseTo(14, 1);
});

test("circular vector SVG export preserves taxonomy and metadata annotations", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((Alpha_one:1,Alpha_two:1)CladeOne:1,(Beta_one:1,Beta_two:1)CladeTwo:1)Root;");

  const svg = await page.evaluate(async () => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const leafNodes = internal?.leafNodes ?? [];
    const names = internal?.names ?? [];
    if (leafNodes.length < 4) {
      throw new Error("Expected four leaves for circular export test.");
    }
    const tipRanks = leafNodes.map((node, index) => ({
      node,
      ranks: {
        phylum: index < 2 ? "Chordata" : "Arthropoda",
        class: index < 2 ? "Mammalia" : "Insecta",
        genus: index < 2 ? "Alpha" : "Beta",
      },
    }));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 1,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["class", "phylum", "genus"],
      tipRanks,
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.importMetadataTextForTest(`name,group\n${names[leafNodes[0]]},Hot\n`, "small.csv");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise<void>((resolve) => {
      const check = () => {
        const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as { kind?: string } | null;
        if (camera?.kind === "circular") {
          resolve();
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? null;
  });

  expect(svg).toBeTruthy();
  expect(svg).toContain("<svg");
  expect(svg).not.toContain("<image");
  expect(svg).toMatch(/<(path|line)/);
  expect(svg).toMatch(/>(Chordata|Arthropoda|Mammalia|Insecta|Alpha|Beta)</);
  expect(svg).toMatch(/>(Alpha one|Alpha two|Beta one|Beta two)</);
  expect(svg).toContain("stroke=\"#2563eb\"");
});

test("spiral SVG export includes vector tree content instead of a blank scene", async ({ page }) => {
  await waitForViewer(page);
  const tips = Array.from({ length: 1000 }, (_, index) => `Tip_${index}:1`);
  await loadTreeFromPaste(page, `(${tips.join(",")})Root;`);

  const svg = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("spiral");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowGenusLabels(false);
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await new Promise<void>((resolve) => {
      const check = () => {
        const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
        const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as { kind?: string } | null;
        if (state?.viewMode === "spiral" && camera?.kind === "circular") {
          resolve();
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "";
  });

  expect(svg).toContain("<svg");
  expect(svg).not.toContain("<image");
  expect(svg).toContain("<path");
  expect(svg).toContain("<line");
});

test("spiral mode is disabled for trees with fewer than 1000 tips", async ({ page }) => {
  await waitForViewer(page);
  const tipNames = Array.from({ length: 32 }, (_, index) => (
    `${String.fromCharCode(65 + Math.floor(index / 2))}_${index % 2 === 0 ? "one" : "two"}:1`
  ));
  await loadTreeFromPaste(page, `(${tipNames.join(",")})Root;`);

  const spiralButton = page.getByRole("button", { name: "Spiral" });
  await expect(spiralButton).toBeDisabled();
  await expect(spiralButton).toHaveAttribute(
    "title",
    "Spiral mode requires at least 1,000 tips.",
  );

  const viewMode = await page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    if (!app) {
      throw new Error("Spiral minimum-size test controls unavailable.");
    }
    app.setViewMode("spiral");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode;
  });
  expect(viewMode).not.toBe("spiral");
});

test("zoomed spiral labels remain radial and wait for inter-turn clearance", async ({ page }) => {
  await waitForViewer(page);
  const tips = Array.from({ length: 1000 }, (_, index) => `Tip_${String(index).padStart(4, "0")}:1`);
  await loadTreeFromPaste(page, `(${tips.join(",")})Root;`);

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    if (!app) {
      throw new Error("Zoomed spiral label test controls unavailable.");
    }
    app.setViewMode("spiral");
    app.setShowTipLabels(true);
    app.setShowGenusLabels(false);
    app.requestFit();
  });
  await page.waitForFunction(() => (
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === "spiral"
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()?.kind === "circular"
  ));

  const result = await page.evaluate(async () => {
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    if (!canvas) {
      throw new Error("Zoomed spiral canvas test controls unavailable.");
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const fitDebug = canvas.getRenderDebug()?.spiral as {
      tipLabelsVisible?: boolean;
    } | undefined;
    const fitCamera = canvas.getCamera();
    if (!fitCamera || fitCamera.kind !== "circular") {
      throw new Error("Spiral fit camera unavailable.");
    }
    canvas.setCircularCamera({
      scale: Number(fitCamera.scale) * 20,
      translateX: Number(fitCamera.translateX),
      translateY: Number(fitCamera.translateY),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const zoomedCamera = canvas.getCamera();
    const zoomedDebug = canvas.getRenderDebug()?.spiral as {
      firstTipWorld?: { x?: number; y?: number };
    } | undefined;
    const treeCanvas = document.querySelector("[data-testid=tree-canvas]");
    if (
      !zoomedCamera
      || zoomedCamera.kind !== "circular"
      || !zoomedDebug?.firstTipWorld
      || !(treeCanvas instanceof HTMLCanvasElement)
    ) {
      throw new Error("Zoomed spiral target state unavailable.");
    }
    const rect = treeCanvas.getBoundingClientRect();
    canvas.setCircularCamera({
      translateX: (rect.width * 0.5) - (Number(zoomedDebug.firstTipWorld.x) * Number(zoomedCamera.scale)),
      translateY: (rect.height * 0.5) - (Number(zoomedDebug.firstTipWorld.y) * Number(zoomedCamera.scale)),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const camera = canvas.getCamera();
    const debug = canvas.getRenderDebug()?.spiral as {
      interTurnGapPx?: number;
      tipLabelRequiredClearancePx?: number;
      tipLabelsVisible?: boolean;
      placedTipLabelCount?: number;
    } | undefined;
    if (!camera || camera.kind !== "circular" || !debug) {
      throw new Error("Zoomed spiral render state unavailable.");
    }
    const centerX = Number(camera.translateX);
    const centerY = Number(camera.translateY);
    const radialAlignment = canvas.getLabelHitboxes()
      .filter((hitbox) => hitbox.labelKind === "tip")
      .map((hitbox) => {
        const dx = Number(hitbox.x) - centerX;
        const dy = Number(hitbox.y) - centerY;
        const radius = Math.hypot(dx, dy);
        const rotation = Number(hitbox.rotation);
        return Math.abs(
          ((dx / radius) * Math.cos(rotation))
          + ((dy / radius) * Math.sin(rotation)),
        );
      });
    return { fitLabelsVisible: fitDebug?.tipLabelsVisible, debug, radialAlignment };
  });

  expect(result.fitLabelsVisible).toBe(false);
  expect(result.debug.tipLabelsVisible).toBe(true);
  expect(result.debug.placedTipLabelCount).toBeGreaterThan(2);
  expect(result.debug.tipLabelRequiredClearancePx).toBeLessThanOrEqual(
    Number(result.debug.interTurnGapPx) + 0.01,
  );
  expect(result.radialAlignment.length).toBe(result.debug.placedTipLabelCount);
  expect(Math.min(...result.radialAlignment)).toBeGreaterThan(0.85);
});

test("spiral genus guides converge to stable screen spacing and thickness at deep zoom", async ({ page }) => {
  await waitForViewer(page);
  const tips = Array.from({ length: 1200 }, (_, index) => (
    `Genus${String(Math.floor(index / 20)).padStart(3, "0")}_species${String(index).padStart(4, "0")}:1`
  ));
  await loadTreeFromPaste(page, `(${tips.join(",")})Root;`);

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setTaxonomyEnabled(false);
    app?.setShowTipLabels(true);
    app?.setShowGenusLabels(true);
    app?.setViewMode("spiral");
    app?.requestFit();
  });
  await page.waitForFunction(() => (
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === "spiral"
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()?.kind === "circular"
  ));

  const styles = await page.evaluate(async () => {
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const treeCanvas = document.querySelector("[data-testid=tree-canvas]");
    const fitCamera = canvas?.getCamera();
    if (!canvas || !fitCamera || fitCamera.kind !== "circular" || !(treeCanvas instanceof HTMLCanvasElement)) {
      throw new Error("Spiral genus compression controls unavailable.");
    }
    const rect = treeCanvas.getBoundingClientRect();
    const readAtScale = async (scale: number) => {
      canvas.setCircularCamera({ scale });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const debugBeforeCenter = canvas.getRenderDebug()?.spiral as {
        firstGenusWorld?: { x?: number; y?: number } | null;
      } | undefined;
      if (!debugBeforeCenter?.firstGenusWorld) {
        throw new Error("Spiral genus compression target unavailable.");
      }
      canvas.setCircularCamera({
        translateX: (rect.width * 0.5) - (Number(debugBeforeCenter.firstGenusWorld.x) * scale),
        translateY: (rect.height * 0.5) - (Number(debugBeforeCenter.firstGenusWorld.y) * scale),
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const debug = canvas.getRenderDebug()?.spiral as {
        tipLabelsVisible?: boolean;
        genusOffsetFromTipsPx?: number | null;
        genusLineWidthPx?: number | null;
        genusMaxFontSizePx?: number | null;
        placedGenusLabelCount?: number;
      } | undefined;
      return {
        tipLabelsVisible: Boolean(debug?.tipLabelsVisible),
        offset: Number(debug?.genusOffsetFromTipsPx),
        lineWidth: Number(debug?.genusLineWidthPx),
        maxFontSize: Number(debug?.genusMaxFontSizePx),
        labelCount: Number(debug?.placedGenusLabelCount),
      };
    };
    return {
      deep: await readAtScale(Number(fitCamera.scale) * 80),
      deeper: await readAtScale(Number(fitCamera.scale) * 160),
    };
  });

  expect(styles.deep.tipLabelsVisible).toBe(true);
  expect(styles.deeper.tipLabelsVisible).toBe(true);
  expect(styles.deep.labelCount).toBeGreaterThan(0);
  expect(styles.deeper.labelCount).toBeGreaterThan(0);
  expect(styles.deep.offset).toBeGreaterThan(20);
  expect(styles.deeper.offset).toBeCloseTo(styles.deep.offset, 3);
  expect(styles.deep.lineWidth).toBeCloseTo(1.2, 3);
  expect(styles.deeper.lineWidth).toBeCloseTo(1.2, 3);
  expect(styles.deep.maxFontSize).toBeLessThanOrEqual(18.01);
  expect(styles.deeper.maxFontSize).toBeCloseTo(styles.deep.maxFontSize, 3);
});

test("spiral branches strengthen as dense overplotting resolves during zoom", async ({ page }) => {
  await waitForViewer(page);
  const tips = Array.from({ length: 5000 }, (_, index) => `Tip_${index}:1`);
  await loadTreeFromPaste(page, `(${tips.join(",")})Root;`);

  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("spiral");
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
  });
  await page.waitForFunction(() => (
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().viewMode === "spiral"
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()?.kind === "circular"
  ));

  const styles = await page.evaluate(async () => {
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    if (!canvas) {
      throw new Error("Spiral branch-style test controls unavailable.");
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const readStyle = () => {
      const renderDebug = canvas.getRenderDebug() as {
        branchStrokeAutoMultiplier?: number;
        spiral?: {
          branchLineWidthPx?: number;
          baseBranchOpacity?: number;
          branchDetailProgress?: number;
        };
      } | null | undefined;
      const debug = renderDebug?.spiral as {
        branchLineWidthPx?: number;
        baseBranchOpacity?: number;
        branchDetailProgress?: number;
      } | undefined;
      return {
        width: Number(debug?.branchLineWidthPx),
        opacity: Number(debug?.baseBranchOpacity),
        progress: Number(debug?.branchDetailProgress),
        autoMultiplier: Number(renderDebug?.branchStrokeAutoMultiplier),
      };
    };
    const fit = readStyle();
    const camera = canvas.getCamera();
    if (!camera || camera.kind !== "circular") {
      throw new Error("Spiral branch-style camera unavailable.");
    }
    canvas.setCircularCamera({ scale: Number(camera.scale) * 5 });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return { fit, zoomed: readStyle() };
  });

  expect(styles.zoomed.progress).toBeGreaterThan(styles.fit.progress);
  expect(styles.zoomed.width).toBeGreaterThan(styles.fit.width);
  expect(styles.zoomed.opacity).toBeGreaterThan(styles.fit.opacity);
  expect(styles.zoomed.width).toBeCloseTo(1.05 * styles.zoomed.autoMultiplier, 6);
  expect(styles.zoomed.opacity).toBeCloseTo(0.96, 2);
});

test("taxonomy label size and band thickness controls are independent", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((Alpha_one:1,Alpha_two:1)CladeOne:1,(Beta_one:1,Beta_two:1)CladeTwo:1)Root;");

  await page.evaluate(async () => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const leafNodes = internal?.leafNodes ?? [];
    if (leafNodes.length < 4) {
      throw new Error("Expected four leaves for taxonomy style test.");
    }
    const tipRanks = leafNodes.map((node, index) => ({
      node,
      ranks: {
        phylum: index < 2 ? "Chordata" : "Arthropoda",
        class: index < 2 ? "Mammalia" : "Insecta",
        genus: index < 2 ? "Alpha" : "Beta",
      },
    }));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 1,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["class", "phylum", "genus"],
      tipRanks,
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "sizeScale", 1);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "bandThicknessScale", 1);
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const readRect = async () => page.evaluate(() => {
    const rect = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
      taxonomyBandWidthsPx?: number[];
      taxonomyPlacedLabels?: Array<{ text?: string; fontSize?: number }>;
    } | undefined;
    const label = (rect?.taxonomyPlacedLabels ?? []).find((entry) => (
      entry.text === "Chordata"
      || entry.text === "Arthropoda"
      || entry.text === "Mammalia"
      || entry.text === "Insecta"
      || entry.text === "Alpha"
      || entry.text === "Beta"
    ));
    return {
      bandWidth: Number(rect?.taxonomyBandWidthsPx?.[0] ?? 0),
      fontSize: Number(label?.fontSize ?? 0),
    };
  });

  const base = await readRect();
  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "sizeScale", 0.8);
  });
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const smallerLabels = await readRect();

  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "bandThicknessScale", 1.4);
  });
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const thickerBands = await readRect();

  expect(base.fontSize).toBeGreaterThan(0);
  expect(base.bandWidth).toBeGreaterThan(0);
  expect(smallerLabels.fontSize).toBeLessThan(base.fontSize);
  expect(smallerLabels.bandWidth).toBeCloseTo(base.bandWidth, 5);
  expect(thickerBands.bandWidth).toBeGreaterThan(smallerLabels.bandWidth);
  expect(thickerBands.fontSize).toBeCloseTo(smallerLabels.fontSize, 5);
});

test("scale settings support explicit tick interval and disabling fading subdivision ticks", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A:500,B:500):500,(C:500,D:500):500)Root;");

  const svg = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowIntermediateScaleTicks(false);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setScaleTickIntervalInput("200");
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "";
  });

  expect(svg).toContain(">200 mya<");
  expect(svg).toContain(">400 mya<");
  expect(svg).not.toContain(">100 mya<");
  expect(svg).not.toContain(">300 mya<");
});

test("solid subdivision ticks remain when fading ticks are hidden", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A:300,B:300):300,(C:300,D:300):300)Root;");

  const svg = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowIntermediateScaleTicks(false);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setScaleTickIntervalInput("400");
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "";
  });

  expect(svg).toContain(">200 mya<");
  expect(svg).toContain(">400 mya<");
  expect(svg).not.toContain(">100 mya<");
  expect(svg).not.toContain(">300 mya<");
});

test("dashed stripe mode exports dashed guide lines", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A:300,B:300):300,(C:300,D:300):300)Root;");

  const svg = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTimeStripeStyle("dashed");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTimeStripeLineWeight(1.6);
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "";
  });

  expect(svg).toContain('stroke-dasharray="6 6"');
});

test("circular center scale supports manual angle and radial bar controls", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A:500,B:500):500,(C:500,D:500):500)Root;");

  const debug = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setCircularCenterScaleAngleDegrees(90);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowCircularCenterRadialScaleBar(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular ?? null;
  }) as {
    centerScaleAngleDegrees?: number;
    showCentralScaleLabels?: boolean;
    centerScaleTickCount?: number;
    showCenterRadialScaleBar?: boolean;
  } | null;

  expect(debug?.showCentralScaleLabels).toBe(true);
  expect(debug?.centerScaleAngleDegrees).toBe(90);
  expect(debug?.centerScaleTickCount).toBeGreaterThanOrEqual(4);
  expect(debug?.showCenterRadialScaleBar).toBe(true);
});

test("circular center scale auto angle tracks ordering until manually overridden", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A:500,B:500):500,(C:500,D:500):500)Root;");

  const autoDesc = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setUseAutoCircularCenterScaleAngle(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("desc");
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return {
      state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null,
      debug: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular ?? null,
    };
  }) as {
    state?: { circularCenterScaleAngleDegrees?: number; circularCenterScaleAngleAuto?: boolean };
    debug?: { centerScaleAngleDegrees?: number };
  };

  expect(autoDesc.state?.circularCenterScaleAngleAuto).toBe(true);
  expect(autoDesc.state?.circularCenterScaleAngleDegrees).toBe(-5);
  expect(autoDesc.debug?.centerScaleAngleDegrees).toBe(-5);

  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("asc");
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState() as { circularCenterScaleAngleDegrees?: number; circularCenterScaleAngleAuto?: boolean } | undefined;
    const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as { centerScaleAngleDegrees?: number } | undefined;
    return state?.circularCenterScaleAngleAuto === true
      && state?.circularCenterScaleAngleDegrees === 5
      && debug?.centerScaleAngleDegrees === 5;
  });
  const autoAsc = await page.evaluate(() => {
    return {
      state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null,
      debug: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular ?? null,
    };
  }) as {
    state?: { circularCenterScaleAngleDegrees?: number; circularCenterScaleAngleAuto?: boolean };
    debug?: { centerScaleAngleDegrees?: number };
  };

  expect(autoAsc.state?.circularCenterScaleAngleAuto).toBe(true);
  expect(autoAsc.state?.circularCenterScaleAngleDegrees).toBe(5);
  expect(autoAsc.debug?.centerScaleAngleDegrees).toBe(5);

  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setCircularCenterScaleAngleDegrees(30);
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState() as { circularCenterScaleAngleDegrees?: number; circularCenterScaleAngleAuto?: boolean } | undefined;
    const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as { centerScaleAngleDegrees?: number } | undefined;
    return state?.circularCenterScaleAngleAuto === false
      && state?.circularCenterScaleAngleDegrees === 30
      && debug?.centerScaleAngleDegrees === 30;
  });
  const manual = await page.evaluate(() => {
    return {
      state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null,
      debug: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular ?? null,
    };
  }) as {
    state?: { circularCenterScaleAngleDegrees?: number; circularCenterScaleAngleAuto?: boolean };
    debug?: { centerScaleAngleDegrees?: number };
  };

  expect(manual.state?.circularCenterScaleAngleAuto).toBe(false);
  expect(manual.state?.circularCenterScaleAngleDegrees).toBe(30);
  expect(manual.debug?.centerScaleAngleDegrees).toBe(30);

  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("desc");
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState() as { circularCenterScaleAngleDegrees?: number; circularCenterScaleAngleAuto?: boolean } | undefined;
    const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as { centerScaleAngleDegrees?: number } | undefined;
    return state?.circularCenterScaleAngleAuto === false
      && state?.circularCenterScaleAngleDegrees === 30
      && debug?.centerScaleAngleDegrees === 30;
  });
  const manualAfterOrderChange = await page.evaluate(() => {
    return {
      state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null,
      debug: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular ?? null,
    };
  }) as {
    state?: { circularCenterScaleAngleDegrees?: number; circularCenterScaleAngleAuto?: boolean };
    debug?: { centerScaleAngleDegrees?: number };
  };

  expect(manualAfterOrderChange.state?.circularCenterScaleAngleAuto).toBe(false);
  expect(manualAfterOrderChange.state?.circularCenterScaleAngleDegrees).toBe(30);
  expect(manualAfterOrderChange.debug?.centerScaleAngleDegrees).toBe(30);
});

test("switching to circular view and fitting in the same turn produces a real fit view", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMockTaxonomy();
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const result = await page.evaluate(() => ({
    state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null,
    camera: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera?.() ?? null,
    debug: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular ?? null,
  })) as {
    state?: { viewMode?: string; taxonomyEnabled?: boolean };
    camera?: { kind?: string; scale?: number } | null;
    debug?: { visibleCircleFraction?: number | null; branchRenderMode?: string | null } | null;
  };

  expect(result.state?.viewMode).toBe("circular");
  expect(result.state?.taxonomyEnabled).toBe(true);
  expect(result.camera?.kind).toBe("circular");
  expect(Number(result.debug?.visibleCircleFraction ?? 0)).toBeGreaterThan(0.9);
  expect(result.debug?.branchRenderMode).toBeTruthy();
});

test("circular fit keeps genus labels inside the viewport without taxonomy ribbons", async ({ page }) => {
  await waitForViewer(page);

  for (const rotation of [0, 90]) {
    const bounds = await page.evaluate(async (degrees) => {
      const app = window.__BIG_TREE_VIEWER_APP_TEST__;
      app?.setTaxonomyEnabled(false);
      app?.setShowGenusLabels(true);
      app?.setViewMode("circular");
      app?.setCircularRotationDegreesForTest(degrees);
      app?.requestFit();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

      const svgMarkup = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "";
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:0;top:0;z-index:-1";
      host.innerHTML = svgMarkup;
      document.body.append(host);
      const svg = host.querySelector("svg");
      if (!(svg instanceof SVGSVGElement)) {
        host.remove();
        throw new Error("Circular SVG export was unavailable.");
      }
      const svgBounds = svg.getBoundingClientRect();
      const labelBounds = Array.from(svg.querySelectorAll("text"))
        .filter((label) => !label.textContent?.includes("mya"))
        .map((label) => label.getBoundingClientRect());
      const result = {
        width: svgBounds.width,
        height: svgBounds.height,
        labelCount: labelBounds.length,
        minLeft: Math.min(...labelBounds.map((label) => label.left - svgBounds.left)),
        maxRight: Math.max(...labelBounds.map((label) => label.right - svgBounds.left)),
        minTop: Math.min(...labelBounds.map((label) => label.top - svgBounds.top)),
        maxBottom: Math.max(...labelBounds.map((label) => label.bottom - svgBounds.top)),
      };
      host.remove();
      return result;
    }, rotation);

    expect(bounds.labelCount).toBeGreaterThan(10);
    expect(bounds.minLeft).toBeGreaterThanOrEqual(8);
    expect(bounds.maxRight).toBeLessThanOrEqual(bounds.width - 8);
    expect(bounds.minTop).toBeGreaterThanOrEqual(8);
    expect(bounds.maxBottom).toBeLessThanOrEqual(bounds.height - 8);
  }
});

test("circular radial scale bar offsets below and rotates center labels", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A:500,B:500):500,(C:500,D:500):500)Root;");

  const svg = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowCircularCenterRadialScaleBar(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "";
  });

  expect(svg).toContain(">200 mya<");
  expect(svg).toContain('text-anchor="middle"');
  expect(svg).toContain('transform="rotate(');
});

test("rectangular scale can extend to the next tick and include zero", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A:275,B:275):275,(C:275,D:275):275)Root;");

  const svg = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowIntermediateScaleTicks(false);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setScaleTickIntervalInput("200");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setExtendRectScaleToTick(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowScaleZeroTick(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "";
  });

  expect(svg).toContain(">0 mya<");
  expect(svg).toContain(">200 mya<");
  expect(svg).toContain(">400 mya<");
  expect(svg).toContain(">600 mya<");
});

test("BEAST or MrBayes-style interval annotations render node error bars", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A:1,B:1)[&height_95%_HPD={0.6,0.8}]:1,(C:1,D:1)[&length_95%_HPD={0.2,0.4}]:1)Root;");

  const result = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowNodeErrorBars(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return {
      state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null,
      debug: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect ?? null,
    };
  }) as {
    state?: { nodeIntervalCount?: number };
    debug?: { errorBarCount?: number };
  };

  expect(result.state?.nodeIntervalCount).toBeGreaterThanOrEqual(2);
  expect(result.debug?.errorBarCount).toBeGreaterThanOrEqual(2);
});

test("branch hover clears when the pointer leaves or the view is panned", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, `(Eschrichtius_robustus:0.0255005437,((((Balaenoptera_physalus:0.01418474,Balaenoptera_omurai:0.0159458974):0.0125670305,((((Balaenoptera_edeni:0.0043849524,Balaenoptera_ricei:0.0058099046):0.0030451356,Balaenoptera_brydei:0.0042225818):0.0024446814,Balaenoptera_borealis:0.0060860444):0.0123042734,Balaenoptera_musculus:0.0240853564):0.0012022186):0.0095518165,Megaptera_novaeangliae:0.0228219859):0.0020243086,(Balaenoptera_acutorostrata:0.0118619984,Balaenoptera_bonaerensis:0.0117498968):0.0128744291):0.0007187714);`);

  const canvas = page.getByTestId("tree-canvas");
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  const tipHitbox = await page.evaluate(() => {
    const hitboxes = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes() ?? [];
    const tip = hitboxes.find((hitbox) => hitbox.labelKind === "tip");
    if (!tip) {
      return null;
    }
    return {
      x: Number(tip.x),
      y: Number(tip.y),
      height: Number(tip.height ?? 0),
    };
  });
  expect(tipHitbox).toBeTruthy();
  const hoverX = (box?.x ?? 0) + (tipHitbox?.x ?? 0) - 14;
  const hoverY = (box?.y ?? 0) + (tipHitbox?.y ?? 0) + ((tipHitbox?.height ?? 0) * 0.5);

  await page.mouse.move(hoverX, hoverY);
  await expect(page.locator(".hover-tooltip")).toBeVisible();

  await page.mouse.move((box?.x ?? 0) + 12, (box?.y ?? 0) + 12);
  await expect(page.locator(".hover-tooltip")).toBeHidden();

  await page.mouse.move(hoverX, hoverY);
  await expect(page.locator(".hover-tooltip")).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(hoverX + 80, hoverY + 30, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".hover-tooltip")).toBeHidden();
});

test("non-ultrametric scale bars use root-to-tip branch-length units with useful precision", async ({ page }) => {
  await waitForViewer(page);
  await loadTreeFromPaste(page, "((A:0.005,B:0.01):0.002,(C:0.012,D:0.018):0.003)Root;");

  const svg = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowIntermediateScaleTicks(false);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setScaleTickIntervalInput("0.005");
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "";
  });

  expect(svg).toContain(">0.005<");
  expect(svg).toContain(">0.01<");
  expect(svg).toContain(">0.015<");
  expect(svg).not.toContain("mya");
  expect(svg).not.toContain(">0.0<");
});

test("visual options only mark hidden label sections when they are actually disabled and can reset style defaults", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowBootstrapLabels(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("tip", "offsetPx", 12);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("internalNode", "offsetXPx", 9);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("internalNode", "offsetYPx", -7);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "bandThicknessScale", 1.4);
  });

  await page.getByRole("button", { name: "Visual Options" }).click();
  const bootstrapRow = page.locator(".visual-option-row").filter({ hasText: "Show bootstrap labels" });
  const nodeHeightRow = page.locator(".visual-option-row").filter({ hasText: "Show node height labels" });
  await expect(bootstrapRow).toBeVisible();
  await expect(bootstrapRow).not.toContainText("Hidden");
  await expect(nodeHeightRow).not.toContainText("Hidden");

  await page.getByRole("button", { name: "Reset Defaults" }).click();

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null) as {
    figureStyles?: {
      tip?: { offsetPx?: number };
      internalNode?: { offsetXPx?: number; offsetYPx?: number };
      taxonomy?: { sizeScale?: number; bandThicknessScale?: number };
    };
  } | null;

  expect(state?.figureStyles?.tip?.offsetPx).toBe(0);
  expect(state?.figureStyles?.internalNode?.offsetXPx).toBe(0);
  expect(state?.figureStyles?.internalNode?.offsetYPx).toBe(0);
  expect(state?.figureStyles?.taxonomy?.sizeScale).toBe(1);
  expect(state?.figureStyles?.taxonomy?.bandThicknessScale).toBe(1);
});
