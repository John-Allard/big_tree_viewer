import { expect, test, type Page } from "@playwright/test";

// Mount the renderer directly so these optional props need no App plumbing.
const harness = `
<html><head><link rel="stylesheet" href="/src/styles.css"></head>
<body style="margin:0"><div id="root" style="width:1100px;height:760px"></div>
<script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const { default: React } = await import("/node_modules/.vite/deps/react.js");
const { default: ReactDOMClient } = await import("/node_modules/.vite/deps/react-dom_client.js");
const { default: TreeCanvas } = await import("/src/components/TreeCanvas.tsx");
const { cloneDefaultFigureStyles } = await import("/src/lib/figureStyles.ts");
const layout = {
  center: Float64Array.from([1.5, .5, 0, 1, 2.5, 2, 3]),
  min: Float64Array.from([0, 0, 0, 1, 2, 2, 3]),
  max: Float64Array.from([3, 1, 0, 1, 3, 2, 3]),
};
const tree = {
  root: 0, nodeCount: 7, leafCount: 4, maxDepth: 2, rootAge: 2,
  hasBranchLengths: true, isUltrametric: true, branchLengthMinPositive: 1,
  leafNodes: Int32Array.from([2, 3, 5, 6]),
  names: ["Root", "Left", "Original_A", "Original_B", "Right", "Original_C", "Original_D"],
  nodeIntervalLower: new Float64Array(7), nodeIntervalUpper: new Float64Array(7), nodeIntervalCount: 0,
  buffers: {
    parent: Int32Array.from([-1, 0, 1, 1, 0, 4, 4]),
    firstChild: Int32Array.from([1, 2, -1, -1, 5, -1, -1]),
    nextSibling: Int32Array.from([-1, 4, 3, -1, -1, 6, -1]),
    branchLength: Float64Array.from([0, 1, 1, 1, 1, 1, 1]),
    depth: Float64Array.from([0, 1, 2, 2, 1, 2, 2]),
    leafCount: Int32Array.from([4, 2, 1, 1, 2, 1, 1]),
  },
  layouts: { input: layout, asc: layout, desc: layout },
};
const root = ReactDOMClient.createRoot(document.getElementById("root"));
let props = {
  treeRef: { current: tree }, order: "input", viewMode: "rectangular", zoomAxisMode: "both",
  circularRotation: 0, radialAngularSpanDegrees: 360, radialCenterOpeningRatio: 0, spiralTurns: 2,
  showTimeStripes: false, timeStripeStyle: "bands", timeStripeLineWeight: 1,
  showScaleBars: false, timeAxisScale: "linear", timeAxisLogBase: 10, scaleTickInterval: null,
  showIntermediateScaleTicks: false, extendRectScaleToTick: false, showScaleZeroTick: true,
  showMyaTimeUnit: false, customTimeUnit: "", circularCenterScaleAngleDegrees: 0,
  useAutoCircularCenterScaleAngle: false, showCircularCenterRadialScaleBar: false,
  showTipLabels: true, alignTipLabels: false, showGenusLabels: false,
  taxonomyEnabled: false, taxonomyOverlayStyle: "ribbons", taxonomyBranchColoringEnabled: false,
  taxonomyColorJitter: 0, taxonomyColorPalette: "classic", taxonomyCustomPaletteColors: [],
  taxonomyColorRootRank: "auto", taxonomyColorJitterRank: "genus", taxonomyRankDisplayModes: {},
  useAutomaticTaxonomyRankVisibility: false, taxonomyRankVisibility: {}, taxonomyCollapseRank: null,
  taxonomyMapRef: { current: null }, taxonomyColorSourceMapRef: { current: null },
  phylopicEnabled: false, phylopicSilhouettes: [], phylopicPlacement: "after-label",
  phylopicSizeScale: 1, phylopicOffsetXPx: 0, phylopicOffsetYPx: 0,
  sharedSubtreeSourceTreeRef: { current: null }, sharedSubtreeSourceTaxonomyMapRef: { current: null },
  metadataBranchColors: null, metadataBranchColorVersion: "", metadataLabels: null, metadataLabelVersion: "",
  metadataMarkers: null, metadataMarkerVersion: "", metadataPies: null, metadataPieVersion: "",
  metadataPieSizePx: 16, metadataTipTableData: null, metadataTipTableMode: "table",
  metadataTipTableCellStyle: "square", metadataTipTablePalette: "blueOrange",
  metadataTipTableBarWidthPx: 40, metadataTipTableCellWidthPx: 20, metadataMarkerSizePx: 10,
  metadataLabelMaxCount: 20, metadataLabelMinSpacingPx: 15, metadataLabelOffsetXPx: 0, metadataLabelOffsetYPx: 0,
  showInternalNodeLabels: false, showBootstrapLabels: false, figureStyles: cloneDefaultFigureStyles(),
  branchThicknessScale: 1, showNodeHeightLabels: false, showNodeErrorBars: false,
  errorBarStyle: "rectangle", errorBarColor: "#777777", errorBarOpacity: .5,
  errorBarShowNodeDot: false, errorBarThicknessPx: 1, errorBarCapSizePx: 4,
  searchQuery: "", searchMatches: [], activeSearchNode: null, activeSearchGenusCenterNode: null,
  activeSearchTaxonomyNode: null, activeSearchTaxonomyKey: null, focusNodeRequest: 0, fitRequest: 0,
  exportSvgRequest: 0, exportSvgFilename: "tree.svg", exportPngRequest: 0, exportPngFilename: "tree.png",
  exportPngWidth: 1100, exportPngHeight: 760, automationExportRequest: null,
  sessionStateRequest: 0, sessionRestoreRequest: 0, sessionRestoreState: null, visualResetRequest: 0,
  onHoverChange: (hover) => { window.__displayHarness.hover = hover; },
  onSessionStateSnapshot: (state) => { window.__displayHarness.snapshot = state; },
  onAutomationExportComplete: (result) => { window.__displayHarness.exportResult = result; },
};
window.__displayHarness = {
  tree, props,
  update: (patch) => {
    props = { ...props, ...patch };
    window.__displayHarness.props = props;
    root.render(React.createElement(TreeCanvas, props));
  },
};
window.__displayHarness.update({});
</script></body></html>
`;

async function mountCanvas(page: Page): Promise<void> {
  page.on("pageerror", (error) => { throw error; });
  await page.addInitScript(() => {
    (window as any).__drawnTexts = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      (window as any).__drawnTexts.push(String(text));
      return fillText.call(this, text, ...args);
    };
  });
  await page.route("**/__canvas-display-harness", (route) => route.fulfill({ contentType: "text/html", body: harness }));
  await page.goto("/__canvas-display-harness");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()));
}

async function update(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (next) => {
    (window as any).__displayHarness.update(next);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, patch);
}

async function svgTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const svg = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest();
    return Array.from(new DOMParser().parseFromString(svg!, "image/svg+xml").querySelectorAll("text"), (node) => node.textContent ?? "");
  });
}

async function drawnTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__drawnTexts);
}

for (const viewMode of ["rectangular", "circular", "fan", "spiral"]) {
  test(`display labels and metadata groups render and export in ${viewMode}`, async ({ page }) => {
    await mountCanvas(page);
    await update(page, { viewMode, tipDisplayLabels: [null, "Ignore internal", "Alternate A", null, null, "Alternate C"] });
    await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView());
    if (viewMode === "spiral") await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      api.setCircularCamera({ scale: 600 });
      const first = (api.getRenderDebug() as any).spiral.firstTipWorld;
      api.setCircularCamera({ translateX: 550 - first.x * 600, translateY: 380 - first.y * 600 });
    });
    const texts = await svgTexts(page);
    expect(texts).toContain("Alternate A");
    expect(texts).toContain("Original B");
    if (viewMode !== "spiral") {
      expect(texts).toContain("Alternate C");
      expect(texts).toContain("Original D");
    }
    expect(texts).not.toContain("Original A");
    expect(texts).not.toContain("Ignore internal");
    expect(await drawnTexts(page)).toContain("Alternate A");
    expect(await page.evaluate(() => (window as any).__displayHarness.tree.names[2])).toBe("Original_A");

    await update(page, { metadataCollapsedNodes: [{ node: 1, label: "Group Alpha", tipCount: 2 }] });
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCollapsedNodeModes())).toEqual([[1, "minimize"]]);
    const collapsedTexts = await svgTexts(page);
    expect(collapsedTexts).toContain("Group Alpha (2 tips)");
    expect(await drawnTexts(page)).toContain("Group Alpha (2 tips)");
    expect(collapsedTexts).not.toContain("Alternate A");
    expect(collapsedTexts).not.toContain("Original B");
    await update(page, { metadataCollapsedNodes: [], tipDisplayLabels: undefined });
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCollapsedNodeModes())).toEqual([]);
    expect(await svgTexts(page)).toContain("Original A");
  });
}

test("external collapse preserves overlapping and nested manual state, and snapshots exclude it", async ({ page }) => {
  await mountCanvas(page);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setCollapsedNodeMode(1, "preserve-width"));
  await update(page, {
    metadataCollapsedNodes: [
      { node: 0, label: "All groups", tipCount: 4 },
      { node: 1, label: "Group Alpha", tipCount: 2 },
      { node: 4, label: "Group Beta", tipCount: 2 },
      { node: 2, label: "Not a clade", tipCount: 1 },
      { node: -1, label: "Invalid", tipCount: 1 },
      { node: 99, label: "Invalid", tipCount: 1 },
    ],
    sessionStateRequest: 1,
  });
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCollapsedNodeModes())).toEqual([
    [1, "minimize"], [0, "minimize"], [4, "minimize"],
  ]);
  expect(await page.evaluate(() => (window as any).__displayHarness.snapshot.collapsedNodeModes)).toEqual([[1, "preserve-width"]]);
  expect(await page.evaluate(() => (window as any).__displayHarness.snapshot.collapsedNodes)).toEqual([1]);
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCollapsedTriangleHitboxes().map((hit) => hit.node))).toEqual([0]);
  expect(await svgTexts(page)).toContain("All groups (4 tips)");
  const triangle = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCollapsedTriangleHitboxes()[0]);
  const center = triangle.points.reduce((sum, point) => ({ x: sum.x + point.x / 3, y: sum.y + point.y / 3 }), { x: 0, y: 0 });
  await page.mouse.click(center.x, center.y);
  await update(page, { sessionStateRequest: 2 });
  expect(await page.evaluate(() => (window as any).__displayHarness.snapshot.collapsedNodeModes)).toEqual([[1, "preserve-width"]]);
  await update(page, {
    sessionRestoreRequest: 1,
    sessionRestoreState: await page.evaluate(() => (window as any).__displayHarness.snapshot),
  });
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCollapsedNodeModes())).toEqual([
    [1, "minimize"], [0, "minimize"], [4, "minimize"],
  ]);
  await update(page, { metadataCollapsedNodes: undefined });
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCollapsedNodeModes())).toEqual([[1, "preserve-width"]]);
  await update(page, { sessionStateRequest: 3 });
  expect(await page.evaluate(() => (window as any).__displayHarness.snapshot.collapsedNodeModes)).toEqual([[1, "preserve-width"]]);
});

test("subtree taxonomy retains metadata provenance", async ({ page }) => {
  await mountCanvas(page);
  await update(page, {
    taxonomyEnabled: true,
    taxonomyMapRef: { current: {
      mappingOrigin: "metadata-ranks",
      metadataRankColumns: { kingdom: "realm", genus: "cluster" },
      mappedCount: 2, totalTips: 4, activeRanks: ["kingdom", "genus"],
      tipRanks: [
        { node: 2, ranks: { kingdom: "Realm", genus: "Alpha" } },
        { node: 3, ranks: { kingdom: "Realm", genus: "Alpha" } },
      ],
    } },
  });
  const taxonomy = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildSharedSubtreePayloadForTest(1)?.taxonomy);
  expect(taxonomy).toMatchObject({
    mappingOrigin: "metadata-ranks",
    metadataRankColumns: { kingdom: "realm", genus: "cluster" },
    mappedCount: 2,
  });
});

test("tooltips keep original identity and add alternate names or metadata groups", async ({ page }) => {
  await mountCanvas(page);
  await update(page, { tipDisplayLabels: [null, null, "Alternate A"] });
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView());
  const tip = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getLabelHitboxes().find((hit) => hit.node === 2 && hit.labelKind === "tip"));
  expect(tip).toBeTruthy();
  await page.mouse.move(tip!.x + tip!.width / 2, tip!.y + tip!.height / 2);
  await expect(page.locator(".hover-tooltip")).toContainText("Original name: Original_A");
  await expect(page.locator(".hover-tooltip")).toContainText("Display name: Alternate A");
  expect(await page.evaluate(() => (window as any).__displayHarness.hover.name)).toBe("Original A");

  await update(page, { metadataCollapsedNodes: [{ node: 1, label: "Group Alpha", tipCount: 2 }] });
  const triangle = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCollapsedTriangleHitboxes()[0]);
  const center = triangle.points.reduce((sum, point) => ({ x: sum.x + point.x / 3, y: sum.y + point.y / 3 }), { x: 0, y: 0 });
  await page.mouse.move(center.x, center.y);
  await expect(page.locator(".hover-tooltip")).toContainText("Metadata group: Group Alpha");
  await expect(page.locator(".hover-tooltip")).toContainText("Descendant tips: 2");
});
