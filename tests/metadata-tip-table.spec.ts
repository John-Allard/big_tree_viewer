import { expect, test, type Page } from "@playwright/test";

async function loadSmallTree(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__ && window.__BIG_TREE_VIEWER_CANVAS_TEST__));
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(
    "(((A:1,B:1):1,(C:1,D:1):1):1,((E:1,F:1):1,(G:1,H:1):1):1)Root;",
  );
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true);
}

async function loadMetadataTable(page: Page): Promise<void> {
  await page.evaluate(() => {
    const csv = [
      "name,numeric_a,numeric_b,present,state_code",
      "A,1,8,yes,AA",
      "B,2,7,no,AB",
      "C,3,6,yes,BB",
      "D,4,5,no,BA",
      "E,5,4,yes,AA",
      "F,6,3,no,AB",
      "G,7,2,yes,BB",
      "H,8,1,no,BA",
    ].join("\n");
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.importMetadataTextForTest(csv, "tip-table.csv");
    app?.setViewMode("rectangular");
    app?.setShowTipLabels(true);
    app?.setMetadataTipTableEnabled(true);
    app?.setMetadataTipTableColumns([
      { column: "numeric_a", label: "Trait one" },
      { column: "numeric_b", label: "Trait two" },
    ]);
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const table = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { columnCount?: number } | undefined;
    return state?.metadataTipTableMatchedTipCount === 8 && table?.columnCount === 2;
  });
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView());
  await page.waitForTimeout(100);
}

test("tip metadata heat maps render beside labels and remain vector in SVG", async ({ page }) => {
  await loadSmallTree(page);
  await loadMetadataTable(page);
  await page.evaluate(() => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMetadataTipTableMode("heatmap");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMockTaxonomy();
  });
  await page.waitForFunction(() => (
    (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { mode?: string } | undefined)?.mode === "heatmap"
    && (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.taxonomyBandXs as number[] | undefined)?.length
  ));
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView());
  await page.waitForTimeout(100);

  const result = await page.evaluate(() => ({
    debug: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable,
    taxonomyBandXs: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.taxonomyBandXs,
    taxonomyBandWidthsPx: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.taxonomyBandWidthsPx,
    canvasWidth: document.querySelector<HTMLCanvasElement>(".tree-canvas")?.clientWidth ?? 0,
    svg: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "",
  }));
  expect(result.debug).toMatchObject({ mode: "heatmap", columnCount: 2, visibleMatchedTipCount: 8 });
  const rightmostRibbon = Math.max(...result.taxonomyBandXs.map((x: number, index: number) => x + result.taxonomyBandWidthsPx[index]));
  expect(result.debug.tableStartX).toBeGreaterThan(rightmostRibbon);
  expect(result.debug.tableStartX + 48).toBeLessThanOrEqual(result.canvasWidth);
  expect(result.svg).toContain("Trait one");
  expect(result.svg).toContain("Trait two");
  expect(result.svg).toContain("rotate(-45.000");
  expect(result.svg).not.toContain("<image");
});

test("tip metadata supports quantitative bars and categorical checks or text", async ({ page }) => {
  await loadSmallTree(page);
  await loadMetadataTable(page);

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setMetadataTipTableMode("bars");
    app?.setMetadataTipTableColumns([{ column: "numeric_a", label: "Abundance" }]);
  });
  await page.waitForFunction(() => (
    (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { mode?: string } | undefined)?.mode === "bars"
    && window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataTipTableColumns?.[0]?.label === "Abundance"
  ));
  const renderedBarsSvg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "");
  expect(renderedBarsSvg).toContain("Abundance");
  expect(renderedBarsSvg).toContain('fill="#2563eb" opacity="0.78"');

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setMetadataTipTableMode("categorical");
    app?.setMetadataTipTableCellStyle("check");
    app?.setMetadataTipTableColumns([{ column: "present", label: "Detected" }]);
  });
  await page.waitForFunction(() => (
    (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { mode?: string } | undefined)?.mode === "categorical"
    && window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataTipTableCellStyle === "check"
  ));
  const checkSvg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "");
  expect(checkSvg).toContain("Detected");
  expect(checkSvg).toContain("✓");

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setMetadataTipTableCellStyle("text");
    app?.setMetadataTipTableColumns([{ column: "state_code", label: "Site 42" }]);
  });
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataTipTableCellStyle === "text");
  const textSvg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "");
  expect(textSvg).toContain("Site 42");
  expect(textSvg).toContain(">AA</text>");
});

test("tip metadata table is suppressed outside rectangular geometry", async ({ page }) => {
  await loadSmallTree(page);
  await loadMetadataTable(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const svg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "");
  expect(svg).not.toContain("Trait one");
  expect(svg).not.toContain("Trait two");
});

test("tip metadata table starts after the rendered long-label section", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__ && window.__BIG_TREE_VIEWER_CANVAS_TEST__));
  const longLabel = "Species_with_a_very_long_voucher_collection_and_accession_identifier";
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(
    `(${longLabel}:1,Short_species:1,Other_species:1)Root;`,
  );
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true);
  await page.evaluate((label) => {
    const csv = `name,value\n${label},1\nShort_species,2\nOther_species,3`;
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.importMetadataTextForTest(csv, "long-label-table.csv");
    app?.setViewMode("rectangular");
    app?.setShowTipLabels(true);
    app?.setShowGenusLabels(false);
    app?.setFigureStyleForTest("tip", "limitWidth", false);
    app?.setMetadataTipTableEnabled(true);
    app?.setMetadataTipTableMode("bars");
    app?.setMetadataTipTableColumns([{ column: "value", label: "Value" }]);
    app?.requestFit();
  }, longLabel);
  await page.waitForFunction(() => (
    (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { visibleMatchedTipCount?: number } | undefined)
      ?.visibleMatchedTipCount === 3
  ));

  const result = await page.evaluate(() => {
    const labels = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes()
      .filter((hitbox) => hitbox.labelKind === "tip") ?? [];
    return {
      tableStartX: Number((window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { tableStartX?: number }).tableStartX),
      labelRightX: Math.max(...labels.map((label) => Number(label.x) + Number(label.width))),
    };
  });
  expect(result.tableStartX).toBeGreaterThan(result.labelRightX);
});
