import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__
    && window.__BIG_TREE_VIEWER_RENDER_DEBUG__
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

  const offsetSvg = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("internalNode", "offsetXPx", 18);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("internalNode", "offsetYPx", -10);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("bootstrap", "offsetXPx", -12);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("bootstrap", "offsetYPx", 14);
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
    window.__BIG_TREE_VIEWER_APP_TEST__?.setCircularCenterScaleTickIntervalInput("200");
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
