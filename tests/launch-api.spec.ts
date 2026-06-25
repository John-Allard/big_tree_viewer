import { expect, test, type Page } from "@playwright/test";

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function waitForLoadedTree(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && !Boolean(state?.loading);
  });
}

function sessionSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const labelStyle = {
    fontFamily: "arial",
    sizeScale: 1,
    offsetPx: 0,
    offsetXPx: 0,
    offsetYPx: 0,
    bold: false,
    italic: false,
    bandThicknessScale: 1,
    taxonomyGapPx: 0,
  };
  return {
    viewMode: "rectangular",
    showSpiralViewOption: false,
    order: "asc",
    zoomAxisMode: "both",
    circularRotationDegrees: 0,
    spiralTurns: 5.5,
    showTimeStripes: true,
    timeStripeStyle: "bands",
    timeStripeLineWeight: 1.1,
    timeAxisScale: "linear",
    timeAxisLogBase: 3,
    showScaleBars: true,
    showIntermediateScaleTicks: true,
    extendRectScaleToTick: false,
    showScaleZeroTick: false,
    scaleTickIntervalInput: "",
    useAutoCircularCenterScaleAngle: true,
    circularCenterScaleAngleDegrees: 5,
    showCircularCenterRadialScaleBar: false,
    showTipLabels: true,
    showGenusLabels: true,
    showInternalNodeLabels: false,
    showBootstrapLabels: false,
    showNodeHeightLabels: false,
    showNodeErrorBars: false,
    errorBarThicknessPx: 1.2,
    errorBarCapSizePx: 7,
    figureStyles: {
      tip: labelStyle,
      genus: labelStyle,
      taxonomy: labelStyle,
      internalNode: { ...labelStyle, fontFamily: "georgia", sizeScale: 0.95 },
      bootstrap: { ...labelStyle, fontFamily: "courierNew", sizeScale: 0.9 },
      nodeHeight: { ...labelStyle, fontFamily: "courierNew" },
      scale: labelStyle,
    },
    taxonomyEnabled: false,
    taxonomyRankVisibility: {},
    taxonomyCollapseRank: "species",
    useAutomaticTaxonomyRankVisibility: true,
    taxonomyBranchColoringEnabled: true,
    taxonomyColorJitter: 1,
    taxonomyColorPalette: "classic",
    taxonomyCustomPaletteInput: "",
    taxonomyColorRootRank: "auto",
    taxonomyColorJitterRank: "genus",
    branchThicknessScale: 1,
    metadataEnabled: false,
    metadataFirstRowIsHeader: true,
    metadataKeyColumn: "",
    metadataValueColumn: "",
    metadataColorMode: "categorical",
    metadataApplyScope: "branch",
    metadataReverseScale: false,
    metadataContinuousPalette: "blueOrange",
    metadataContinuousTransform: "linear",
    metadataContinuousMinInput: "",
    metadataContinuousMaxInput: "",
    metadataLabelsEnabled: false,
    metadataLabelColumn: "",
    metadataMarkersEnabled: false,
    metadataMarkerColumn: "",
    metadataCategoryColorOverrides: {},
    metadataMarkerStyleOverrides: {},
    metadataMarkerSizePx: 9,
    metadataLabelMaxCount: 240,
    metadataLabelMinSpacingPx: 10,
    metadataLabelOffsetXPx: 0,
    metadataLabelOffsetYPx: 0,
    ...overrides,
  };
}

test("spiral view option stays hidden on ordinary page load until the shortcut is pressed", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await expect(page.getByRole("button", { name: "Spiral" })).toHaveCount(0);

  await page.keyboard.down("Shift");
  await page.keyboard.down("S");
  await page.keyboard.down("P");
  await page.keyboard.up("P");
  await page.keyboard.up("S");
  await page.keyboard.up("Shift");

  await expect(page.getByRole("button", { name: "Spiral" })).toBeVisible();
});

test("remote Newick URL launch fetches a public tree and applies URL settings", async ({ page }) => {
  await page.route("**/remote-tree.nwk", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "((Remote_alpha:1,Remote_beta:1)RemoteClade:1,Remote_gamma:2)Root;",
    });
  });
  const params = new URLSearchParams({
    btv_newick_url: "/remote-tree.nwk",
    btv_view: "circular",
    btv_tip_labels: "false",
    btv_branch_thickness: "1.6",
  });

  await page.goto(`/?${params.toString()}`);
  await waitForLoadedTree(page);

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null);
  expect(state?.viewMode).toBe("circular");
  expect(state?.showTipLabels).toBe(false);
  expect(state?.branchThicknessScale).toBeCloseTo(1.6);
  expect(state?.loadError).toBeNull();
});

test("remote session URL launch fetches and restores a saved session", async ({ page }) => {
  const session = {
    format: "big-tree-viewer-session",
    version: 1,
    savedAt: "2026-05-27T00:00:00.000Z",
    settings: sessionSettings({
      viewMode: "circular",
      showTipLabels: false,
      showGenusLabels: false,
      branchThicknessScale: 2.1,
      taxonomyEnabled: true,
    }),
    tree: {
      label: "remote-session-tree",
      newick: "((Session_alpha:1,Session_beta:1)SessionClade:1,Session_gamma:2)Root;",
      signature: null,
    },
    taxonomy: {
      map: {
        version: 3,
        mappedCount: 3,
        totalTips: 3,
        activeRanks: ["genus", "family", "order"],
        tipRanks: [
          {
            node: 2,
            ranks: { genus: "Session", family: "Sessionidae", order: "Sessionales" },
          },
          {
            node: 3,
            ranks: { genus: "Session", family: "Sessionidae", order: "Sessionales" },
          },
          {
            node: 4,
            ranks: { genus: "Remote", family: "Remotidae", order: "Remotales" },
          },
        ],
      },
    },
    canvas: null,
  };
  await page.route("**/scl/fi/token/remote-session.btvsession?rlkey=abc&dl=1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });

  const dropboxShareUrl = "https://www.dropbox.com/scl/fi/token/remote-session.btvsession?rlkey=abc&raw=1";
  await page.goto(`/?btv_session_url=${encodeURIComponent(dropboxShareUrl)}`);
  await waitForLoadedTree(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount === 3);

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null);
  expect(state?.viewMode).toBe("circular");
  expect(state?.showTipLabels).toBe(false);
  expect(state?.showGenusLabels).toBe(false);
  expect(state?.branchThicknessScale).toBeCloseTo(2.1);
  expect(state?.taxonomyEnabled).toBe(true);
  expect(state?.taxonomyMappedCount).toBe(3);
  expect(state?.loadError).toBeNull();
});

test("desktop-saved remote session viewport is reframed on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const session = {
    format: "big-tree-viewer-session",
    version: 1,
    savedAt: "2026-05-27T00:00:00.000Z",
    settings: sessionSettings({
      viewMode: "circular",
      showTipLabels: false,
      showGenusLabels: false,
    }),
    tree: {
      label: "desktop-session-tree",
      newick: "((Desktop_alpha:1,Desktop_beta:1)DesktopClade:1,Desktop_gamma:2)Root;",
      signature: null,
    },
    taxonomy: null,
    canvas: {
      viewportWidth: 1200,
      viewportHeight: 800,
      camera: {
        kind: "circular",
        scale: 176,
        translateX: 600,
        translateY: 400,
        rotation: 0,
        rotationCos: 1,
        rotationSin: 0,
      },
      collapsedNodes: [],
      manualBranchColors: [],
      manualSubtreeColors: [],
    },
  };
  await page.route("**/mobile-session.btvsession", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });

  await page.goto(`/?btv_session_url=${encodeURIComponent("/mobile-session.btvsession")}`);
  await waitForLoadedTree(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()?.kind === "circular");

  const result = await page.evaluate(() => {
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() as {
      kind?: string;
      scale?: number;
      translateX?: number;
      translateY?: number;
    } | null;
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState() as {
      maxDepth?: number | null;
      viewMode?: string;
    } | null;
    const radiusPx = Number(state?.maxDepth ?? 0) * Number(camera?.scale ?? 0);
    return {
      viewMode: state?.viewMode,
      kind: camera?.kind,
      translateX: Number(camera?.translateX ?? Number.NaN),
      translateY: Number(camera?.translateY ?? Number.NaN),
      radiusPx,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });

  expect(result.viewMode).toBe("circular");
  expect(result.kind).toBe("circular");
  expect(result.translateX).toBeGreaterThan(0);
  expect(result.translateX).toBeLessThan(result.width);
  expect(result.translateY).toBeGreaterThan(0);
  expect(result.translateY).toBeLessThan(result.height);
  expect(result.translateX - result.radiusPx).toBeGreaterThanOrEqual(-2);
  expect(result.translateX + result.radiusPx).toBeLessThanOrEqual(result.width + 2);
});

test("URL launch parameters load a tree, metadata, and selected visual options", async ({ page }) => {
  const newick = "((Alpha_one:1,Beta_two:1)CladeOne:1,Gamma_three:2)Root;";
  const metadata = "name,group,label,marker\nAlpha_one,A,Alpha label,circle\nBeta_two,B,Beta label,square\n";
  const params = new URLSearchParams({
    btv_newick_b64: toBase64Url(newick),
    btv_label: "url-launch-tree",
    btv_metadata_b64: toBase64Url(metadata),
    btv_metadata_key: "name",
    btv_metadata_value: "group",
    btv_metadata_color_mode: "categorical",
    btv_metadata_enabled: "true",
    btv_metadata_labels: "true",
    btv_metadata_label_column: "label",
    btv_metadata_markers: "true",
    btv_metadata_marker_column: "marker",
    btv_view: "circular",
    btv_tip_labels: "false",
    btv_genus_labels: "true",
    btv_taxonomy: "false",
    btv_branch_thickness: "1.75",
  });

  await page.goto(`/?${params.toString()}`);
  await waitForLoadedTree(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataMatchedRowCount === 2);

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null);
  expect(state?.viewMode).toBe("circular");
  expect(state?.showTipLabels).toBe(false);
  expect(state?.showGenusLabels).toBe(true);
  expect(state?.branchThicknessScale).toBeCloseTo(1.75);
  expect(state?.taxonomyEnabled).toBe(false);
  expect(state?.metadataRowCount).toBe(2);
  expect(state?.metadataKeyColumn).toBe("name");
  expect(state?.metadataValueColumn).toBe("group");
  expect(state?.metadataColorMode).toBe("categorical");
  expect(state?.metadataLabelsEnabled).toBe(true);
  expect(state?.metadataLabelColumn).toBe("label");
  expect(state?.metadataMarkersEnabled).toBe(true);
  expect(state?.metadataMarkerColumn).toBe("marker");
  expect(state?.metadataMatchedRowCount).toBe(2);
});

test("URL launch parameters can fetch metadata from a URL", async ({ page }) => {
  const newick = "((Alpha_one:1,Beta_two:1)CladeOne:1,Gamma_three:2)Root;";
  const metadata = "name,score\nAlpha_one,10.5\nBeta_two,20.75\n";
  await page.route("**/metadata.tsv", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/tab-separated-values",
      body: metadata,
    });
  });
  const params = new URLSearchParams({
    btv_newick_b64: toBase64Url(newick),
    btv_metadata_url: "/metadata.tsv",
    btv_metadata_key: "name",
    btv_metadata_value: "score",
    btv_metadata_color_mode: "continuous",
    btv_metadata_enabled: "true",
    btv_view: "circular",
  });

  await page.goto(`/?${params.toString()}`);
  await waitForLoadedTree(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataMatchedRowCount === 2);

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null);
  expect(state?.metadataFileName).toBe("metadata.tsv");
  expect(state?.metadataColorMode).toBe("continuous");
  expect(state?.metadataEnabled).toBe(true);
  expect(state?.metadataMatchedRowCount).toBe(2);
});

test("postMessage launch API can load a payload after opening an empty viewer", async ({ page }) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.evaluate(() => {
    window.postMessage({
      type: "big-tree-viewer:load",
      payload: {
        newick: "(A_species:1,B_species:1)Root;",
        label: "message-launch-tree",
        visual: {
          viewMode: "rectangular",
          showTipLabels: true,
          showGenusLabels: false,
          timeAxisScale: "log",
          timeAxisLogBase: 4,
        },
        metadata: {
          text: "name,score\nA_species,10.5\nB_species,20.75\n",
          keyColumn: "name",
          valueColumn: "score",
          colorMode: "continuous",
          enabled: true,
        },
      },
    }, "*");
  });

  await waitForLoadedTree(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataMatchedRowCount === 2);

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null);
  expect(state?.viewMode).toBe("rectangular");
  expect(state?.showTipLabels).toBe(true);
  expect(state?.showGenusLabels).toBe(false);
  expect(state?.timeAxisScale).toBe("log");
  expect(state?.metadataColorMode).toBe("continuous");
  expect(state?.metadataMatchedRowCount).toBe(2);
});
