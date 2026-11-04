import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync, strFromU8 } from "fflate";

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
      "name,numeric_a,numeric_b,present,state_code,family,genus",
      "A,1,8,yes,AA,Family One,Genus One",
      "B,2,7,no,AB,Family One,Genus One",
      "C,3,6,yes,BB,Family One,Genus Two",
      "D,4,5,no,BA,Family One,Genus Two",
      "E,5,4,yes,AA,Family Two,Genus Three",
      "F,6,3,no,AB,Family Two,Genus Three",
      "G,7,2,yes,BB,Family Two,Genus Four",
      "H,8,1,no,BA,Family Two,Genus Four",
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
    app?.setMetadataTipTableBinaryStyle("check");
    app?.setMetadataTipTableColumns([{ column: "present", label: "Detected" }]);
  });
  await page.waitForFunction(() => (
    (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { mode?: string } | undefined)?.mode === "categorical"
    && window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataTipTableBinaryStyle === "check"
  ));
  const checkSvg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "");
  expect(checkSvg).toContain("Detected");
  expect(checkSvg).toContain("✓");
  const checkSizes = await page.evaluate(svg => [...new DOMParser().parseFromString(svg, "image/svg+xml").querySelectorAll("text")]
    .filter(text => text.textContent === "✓").map(text => Number(text.getAttribute("font-size"))), checkSvg);
  expect(Math.max(...checkSizes)).toBeGreaterThanOrEqual(20);

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setMetadataTipTableTextStyle("text");
    app?.setMetadataTipTableColumns([{ column: "state_code", label: "Site 42" }]);
  });
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataTipTableTextStyle === "text");
  const textSvg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "");
  expect(textSvg).toContain("Site 42");
  expect(textSvg).toContain(">AA</text>");
});

test("table placement reserves space inside taxonomy and survives session reload", async ({ page }, testInfo) => {
  await loadSmallTree(page);
  await loadMetadataTable(page);
  const taxonomySection = page.locator(".panel-section .section-toggle").filter({ hasText: "Taxonomy" }).first();
  if (await taxonomySection.getAttribute("aria-expanded") !== "true") await taxonomySection.click();
  await page.getByRole("combobox", { name: "Taxonomy source", exact: true }).selectOption("custom");
  await page.getByRole("button", { name: "Apply custom taxonomy ribbons", exact: true }).click();
  await page.waitForFunction(() => Boolean((window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.taxonomyBandXs as number[])?.length));
  const section = page.locator(".panel-section .section-toggle").filter({ hasText: "Metadata" }).first();
  if (await section.getAttribute("aria-expanded") !== "true") await section.click();
  await page.getByRole("button", { name: "Tip data table settings", exact: true }).click();
  const placement = page.getByRole("combobox", { name: "Table placement", exact: true });
  await expect(placement).toHaveValue("outside");
  const bounds = () => page.evaluate(() => {
    const rect = window.__BIG_TREE_VIEWER_RENDER_DEBUG__!.rect!;
    const table = rect.metadataTipTable as { tableStartX: number; placement: string; columns: Array<{ width: number }> };
    const xs = rect.taxonomyBandXs as number[];
    const widths = rect.taxonomyBandWidthsPx as number[];
    const labels = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getLabelHitboxes().filter(hit => hit.labelKind === "tip");
    return { placement: table.placement, start: table.tableStartX, end: table.tableStartX + table.columns.reduce((sum, column) => sum + column.width, 0),
      taxonomyStart: Math.min(...xs), taxonomyEnd: Math.max(...xs.map((x, i) => x + widths[i])),
      labelsEnd: Math.max(...labels.map(hit => Number(hit.x) + Number(hit.width))) };
  });
  expect((await bounds()).start).toBeGreaterThan((await bounds()).taxonomyEnd);
  await placement.selectOption("inside");
  await expect.poll(async () => (await bounds()).placement).toBe("inside");
  let inside = await bounds();
  expect(inside.start).toBeGreaterThan(inside.labelsEnd);
  expect(inside.end).toBeLessThan(inside.taxonomyStart);
  await page.getByRole("button", { name: "Close Tip data table settings", exact: true }).click();
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView());
  await page.screenshot({ path: testInfo.outputPath("table-inside-taxonomy.png") });
  const svg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest());
  expect(svg).toContain("Trait one");
  expect(svg).toContain("Trait two");
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  const file = (await (await download).path())!;
  const session = JSON.parse(strFromU8(gunzipSync(await readFile(file))));
  expect(session.settings.metadataTipTablePlacement).toBe("inside");
  await page.getByRole("button", { name: "Tip data table settings", exact: true }).click();
  await placement.selectOption("outside");
  await expect.poll(async () => (await bounds()).placement).toBe("outside");
  expect((await bounds()).start).toBeGreaterThan((await bounds()).taxonomyEnd);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load Session", exact: true }).click();
  await (await chooser).setFiles(file);
  await page.waitForFunction(() => Boolean((window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.taxonomyBandXs as number[])?.length)
    && !window.__BIG_TREE_VIEWER_APP_TEST__?.getState().loading);
  await expect.poll(async () => (await bounds()).placement).toBe("inside");
  inside = await bounds();
  expect(inside.start).toBeGreaterThan(inside.labelsEnd);
  expect(inside.end).toBeLessThan(inside.taxonomyStart);
});

test("tip metadata tables render as radial rings and retain their header settings shortcut", async ({ page }, testInfo) => {
  await loadSmallTree(page);
  await loadMetadataTable(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const svg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "");
  expect(svg).toContain("Trait one");
  expect(svg).toContain("Trait two");
  expect(svg).not.toContain("<image");
  const table = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular?.metadataTipTable as {
    columnCount: number; visibleMatchedTipCount: number; headers: Array<{ x: number; y: number }>; tableEndRadius: number;
  });
  expect(table.columnCount).toBe(2);
  expect(table.visibleMatchedTipCount).toBe(8);
  const canvas = (await page.getByTestId("tree-canvas").boundingBox())!;
  await page.mouse.click(canvas.x + table.headers[0].x, canvas.y + table.headers[0].y, { button: "right" });
  await expect(page.locator(".tree-context-menu").getByRole("button", { name: "Rename Column", exact: true })).toBeVisible();
  await page.locator(".tree-context-menu").getByRole("button", { name: "Tip data table settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Tip data table settings" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Show tip data table", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Close Tip data table settings", exact: true }).click();
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("radial-table.png") });
  await page.getByRole("spinbutton", { name: "Radial angular span degrees" }).fill("180");
  await page.getByRole("spinbutton", { name: "Radial angular span degrees" }).press("Enter");
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular?.metadataTipTable as { visibleMatchedTipCount: number })?.visibleMatchedTipCount)).toBe(8);
  await page.screenshot({ path: testInfo.outputPath("fan-table.png") });
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

test("radial table placement stays clear of taxonomy in either order", async ({ page }) => {
  await loadSmallTree(page);
  await loadMetadataTable(page);
  const taxonomySection = page.locator(".panel-section .section-toggle").filter({ hasText: "Taxonomy" }).first();
  if (await taxonomySection.getAttribute("aria-expanded") !== "true") await taxonomySection.click();
  await page.getByRole("combobox", { name: "Taxonomy source", exact: true }).selectOption("custom");
  await page.getByRole("button", { name: "Apply custom taxonomy ribbons", exact: true }).click();
  await page.getByRole("button", { name: "Radial", exact: true }).click();
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  const bounds = () => page.evaluate(() => {
    const radial = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular;
    const table = radial?.metadataTipTable as { placement: string; tableStartRadius: number; tableEndRadius: number };
    return { ...table, taxonomyStart: Number(radial?.taxonomyFirstRingInnerRadiusPx) };
  });
  await expect.poll(async () => (await bounds()).placement).toBe("outside");
  expect((await bounds()).tableStartRadius).toBeGreaterThan((await bounds()).taxonomyStart);
  const metadataSection = page.locator(".panel-section .section-toggle").filter({ hasText: "Metadata" }).first();
  if (await metadataSection.getAttribute("aria-expanded") !== "true") await metadataSection.click();
  await page.getByRole("button", { name: "Tip data table settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Table placement", exact: true }).selectOption("inside");
  await expect.poll(async () => (await bounds()).placement).toBe("inside");
  expect((await bounds()).tableEndRadius).toBeLessThan((await bounds()).taxonomyStart);
});

test("column headers pan off-screen with the table instead of sticking over visible rows", async ({ page }) => {
  await loadSmallTree(page);
  await loadMetadataTable(page);
  const state = () => page.evaluate(() => ({
    camera: window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera() as { translateY: number },
    headerY: (window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect?.metadataTipTable as { headerY: number }).headerY,
  }));
  const before = await state();
  await page.evaluate(y => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setRectCamera({ translateY: y - 250 }), before.camera.translateY);
  await expect.poll(async () => (await state()).headerY).toBeLessThan(0);
  const after = await state();
  expect(after.headerY - before.headerY).toBeCloseTo(after.camera.translateY - before.camera.translateY, 3);
});
