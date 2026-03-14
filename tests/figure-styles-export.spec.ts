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
  const bootstrapSection = page.locator(".label-style-toggle").filter({ hasText: "Bootstrap labels" });
  const nodeHeightSection = page.locator(".label-style-toggle").filter({ hasText: "Node height labels" });
  await expect(bootstrapSection).toBeVisible();
  await expect(bootstrapSection).not.toContainText("Hidden");
  await expect(nodeHeightSection).toContainText("Hidden");

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
