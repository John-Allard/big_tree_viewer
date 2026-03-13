import { expect, test, type Page } from "@playwright/test";

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
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("tip", "fontFamily", "nunito");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("internalNode", "fontFamily", "sourceSerif");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("bootstrap", "fontFamily", "jetbrainsMono");
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
  expect(svg).toContain("Nunito Sans");
  expect(svg).toContain("Source Serif 4");
  expect(svg).toContain("JetBrains Mono");
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
    window.__BIG_TREE_VIEWER_APP_TEST__?.setFigureStyleForTest("taxonomy", "sizeScale", 1.2);
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? null;
  });

  expect(svg).toBeTruthy();
  expect(svg).toContain("<svg");
  expect(svg).not.toContain("<image");
  expect(svg).toContain("<path");
  expect(svg).toMatch(/>(Chordata|Arthropoda|Mammalia|Insecta|Alpha|Beta)</);
  expect(svg).toMatch(/>(Alpha one|Alpha two|Beta one|Beta two)</);
  expect(svg).toContain("stroke=\"#2563eb\"");
});
