import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

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

async function routeTinyTaxdump(page: Page): Promise<void> {
  const nodes = [
    "1\t|\t1\t|\tno rank\t|",
    "2\t|\t1\t|\tsuperkingdom\t|",
    "3\t|\t2\t|\tphylum\t|",
    "4\t|\t3\t|\tclass\t|",
    "5\t|\t4\t|\torder\t|",
    "6\t|\t5\t|\tfamily\t|",
    "7\t|\t6\t|\tgenus\t|",
    "8\t|\t7\t|\tspecies\t|",
    "9\t|\t6\t|\tgenus\t|",
    "10\t|\t9\t|\tspecies\t|",
  ].join("\n");
  const names = [
    "1\t|\troot\t|\t\t|\tscientific name\t|",
    "2\t|\tTestkingdom\t|\t\t|\tscientific name\t|",
    "3\t|\tTestphylum\t|\t\t|\tscientific name\t|",
    "4\t|\tTestclass\t|\t\t|\tscientific name\t|",
    "5\t|\tTestorder\t|\t\t|\tscientific name\t|",
    "6\t|\tTestaceae\t|\t\t|\tscientific name\t|",
    "7\t|\tA\t|\t\t|\tscientific name\t|",
    "8\t|\tA species\t|\t\t|\tscientific name\t|",
    "9\t|\tB\t|\t\t|\tscientific name\t|",
    "10\t|\tB species\t|\t\t|\tscientific name\t|",
  ].join("\n");
  const archive = Buffer.from(zipSync({
    "nodes.dmp": strToU8(`${nodes}\n`),
    "names.dmp": strToU8(`${names}\n`),
  }));
  await page.route("https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdmp.zip", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/zip",
      body: archive,
    });
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

test("export dialog defaults to browser-scale PNG dimensions", async ({ page }) => {
  const newick = "((Alpha:1,Beta:1)CladeOne:1,Gamma:2)Root;";
  const params = new URLSearchParams({
    btv_newick_b64: toBase64Url(newick),
    btv_view: "rectangular",
  });
  await page.goto(`/?${params.toString()}`);
  await waitForLoadedTree(page);
  const tutorialClose = page.getByRole("button", { name: "Close tutorial prompt" });
  if (await tutorialClose.count()) {
    await tutorialClose.click();
  }

  await page.getByRole("button", { name: "Export View" }).click();
  let dialog = page.getByRole("dialog", { name: "Export view settings" });
  await expect(dialog.getByLabel("Width px")).toHaveValue("1600");
  await expect(dialog.getByLabel("Height px")).toHaveValue("1000");
  await expect(dialog.getByLabel("Print width (in)")).toHaveValue("8");
  await expect(dialog.getByLabel("Print height (in)")).toHaveValue("5");
  await expect(dialog.getByLabel("DPI")).toHaveValue("200");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Circular" }).click();
  await page.getByRole("button", { name: "Export View" }).click();
  dialog = page.getByRole("dialog", { name: "Export view settings" });
  await expect(dialog.getByLabel("Width px")).toHaveValue("1200");
  await expect(dialog.getByLabel("Height px")).toHaveValue("1200");
  await expect(dialog.getByLabel("Print width (in)")).toHaveValue("6");
  await expect(dialog.getByLabel("Print height (in)")).toHaveValue("6");
  await expect(dialog.getByLabel("DPI")).toHaveValue("200");
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

test("remote session URL launch can run standard taxonomy mapping", async ({ page }) => {
  await routeTinyTaxdump(page);
  const session = {
    format: "big-tree-viewer-session",
    version: 1,
    savedAt: "2026-06-25T00:00:00.000Z",
    settings: sessionSettings({
      viewMode: "circular",
      taxonomyEnabled: true,
    }),
    tree: {
      label: "remote-session-taxonomy-tree",
      newick: "(A_species:1,B_species:1)Root;",
      signature: null,
    },
    taxonomy: null,
    canvas: null,
  };
  await page.route("**/remote-taxonomy-session.btvsession", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });

  const params = new URLSearchParams({
    btv_session_url: "/remote-taxonomy-session.btvsession",
    btv_map_taxonomy: "true",
    btv_taxonomy_allow_download: "true",
  });
  await page.goto(`/?${params.toString()}`);
  await waitForLoadedTree(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount === 2);

  const result = await page.evaluate(() => ({
    state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null,
    taxonomy: window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest?.() ?? null,
  }));
  expect(result.state?.taxonomyEnabled).toBe(true);
  expect(result.state?.taxonomyMappedCount).toBe(2);
  expect(result.taxonomy?.tipRanks[0]?.ranks.family).toBe("Testaceae");
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
  const metadata = "name,group,label,marker,c3,c4\nAlpha_one,A,Alpha label,circle,0.8,0.2\nBeta_two,B,Beta label,square,0.1,0.9\n";
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
    btv_metadata_pies: "true",
    btv_metadata_pie_start: "c3",
    btv_metadata_pie_end: "c4",
    btv_metadata_pie_palette: "warm",
    btv_metadata_pie_size: "17",
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
  expect(state?.metadataPiesEnabled).toBe(true);
  expect(state?.metadataPieStartColumn).toBe("c3");
  expect(state?.metadataPieEndColumn).toBe("c4");
  expect(state?.metadataPiePalette).toBe("warm");
  expect(state?.metadataPieSizePx).toBe(17);
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

test("postMessage launch API accepts a taxonomy map payload", async ({ page }) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.evaluate(() => {
    window.postMessage({
      type: "big-tree-viewer:load",
      payload: {
        newick: "(A_species:1,B_species:1)Root;",
        label: "taxonomy-launch-tree",
        taxonomy: {
          map: {
            version: 1,
            mappedCount: 2,
            totalTips: 2,
            activeRanks: ["genus", "family"],
            tipRanks: [
              { node: 1, ranks: { genus: "A", family: "Alphaaceae" } },
              { node: 2, ranks: { genus: "B", family: "Betaaceae" } },
            ],
          },
        },
        visual: {
          viewMode: "circular",
          taxonomyEnabled: true,
          taxonomyRankVisibility: { family: true, genus: true },
        },
      },
    }, "*");
  });

  await waitForLoadedTree(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount === 2);

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null);
  expect(state?.viewMode).toBe("circular");
  expect(state?.taxonomyEnabled).toBe(true);
  expect(state?.taxonomyMappedCount).toBe(2);
});

test("postMessage launch API can run the standard taxonomy mapper", async ({ page }) => {
  await routeTinyTaxdump(page);
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.evaluate(() => {
    window.postMessage({
      type: "big-tree-viewer:load",
      payload: {
        newick: "(A_species:1,B_species:1)Root;",
        label: "standard-taxonomy-launch-tree",
        taxonomy: {
          runMapping: true,
          allowDownload: true,
        },
        visual: {
          viewMode: "circular",
          taxonomyEnabled: true,
        },
      },
    }, "*");
  });

  await waitForLoadedTree(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount === 2);

  const result = await page.evaluate(() => ({
    state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null,
    taxonomy: window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest?.() ?? null,
  }));
  expect(result.state?.taxonomyEnabled).toBe(true);
  expect(result.state?.taxonomyMappedCount).toBe(2);
  expect(result.taxonomy?.tipRanks[0]?.ranks.family).toBe("Testaceae");
});

test("postMessage API can map taxonomy for the current loaded tree", async ({ page }) => {
  await routeTinyTaxdump(page);
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __btvTaxonomyMessages?: Array<Record<string, unknown>>;
    };
    testWindow.__btvTaxonomyMessages = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type === "big-tree-viewer:taxonomy-mapped" || event.data?.type === "big-tree-viewer:taxonomy-error") {
        testWindow.__btvTaxonomyMessages?.push(event.data);
      }
    });
    window.postMessage({
      type: "big-tree-viewer:load",
      payload: {
        newick: "(A_species:1,B_species:1)Root;",
        label: "standard-taxonomy-message-tree",
      },
    }, "*");
  });
  await waitForLoadedTree(page);

  await page.evaluate(() => {
    window.postMessage({ type: "big-tree-viewer:map-taxonomy", payload: { allowDownload: true } }, "*");
  });

  await page.waitForFunction(() => (
    ((window as typeof window & {
      __btvTaxonomyMessages?: Array<Record<string, unknown>>;
    }).__btvTaxonomyMessages ?? []).length > 0
  ));
  const [message] = await page.evaluate(() => (
    (window as typeof window & {
      __btvTaxonomyMessages?: Array<Record<string, unknown>>;
    }).__btvTaxonomyMessages ?? []
  ));

  expect(message.type).toBe("big-tree-viewer:taxonomy-mapped");
  expect((message.taxonomy as { map?: { mappedCount?: number } })?.map?.mappedCount).toBe(2);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount === 2);
});

test("postMessage taxonomy mapping does not download taxdump without explicit permission", async ({ page }) => {
  let taxdumpRequested = false;
  await page.route("https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdmp.zip", async (route) => {
    taxdumpRequested = true;
    await route.abort();
  });
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __btvTaxonomyMessages?: Array<Record<string, unknown>>;
    };
    testWindow.__btvTaxonomyMessages = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type === "big-tree-viewer:taxonomy-mapped" || event.data?.type === "big-tree-viewer:taxonomy-error") {
        testWindow.__btvTaxonomyMessages?.push(event.data);
      }
    });
    window.postMessage({
      type: "big-tree-viewer:load",
      payload: {
        newick: "(A_species:1,B_species:1)Root;",
        label: "standard-taxonomy-cache-only-tree",
      },
    }, "*");
  });
  await waitForLoadedTree(page);

  await page.evaluate(() => {
    window.postMessage({ type: "big-tree-viewer:map-taxonomy", payload: {} }, "*");
  });

  await page.waitForFunction(() => (
    ((window as typeof window & {
      __btvTaxonomyMessages?: Array<Record<string, unknown>>;
    }).__btvTaxonomyMessages ?? []).length > 0
  ));
  const [message] = await page.evaluate(() => (
    (window as typeof window & {
      __btvTaxonomyMessages?: Array<Record<string, unknown>>;
    }).__btvTaxonomyMessages ?? []
  ));

  expect(message.type).toBe("big-tree-viewer:taxonomy-error");
  expect(String(message.message)).toContain("No cached NCBI taxonomy archive");
  expect(taxdumpRequested).toBe(false);
});

test("postMessage API can export the current view after load", async ({ page }) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __btvExportMessages?: Array<Record<string, unknown>>;
    };
    testWindow.__btvExportMessages = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type === "big-tree-viewer:exported" || event.data?.type === "big-tree-viewer:export-error") {
        testWindow.__btvExportMessages?.push(event.data);
      }
    });
    window.postMessage({
      type: "big-tree-viewer:load",
      payload: {
        newick: "(A_species:1,B_species:1)Root;",
        label: "export-current-view-tree",
        visual: {
          viewMode: "rectangular",
          showTipLabels: false,
        },
      },
    }, "*");
  });
  await waitForLoadedTree(page);

  await page.evaluate(() => {
    window.postMessage({
      type: "big-tree-viewer:export",
      payload: {
        format: "svg",
        delivery: "postMessage",
        filename: "current-view.svg",
      },
    }, "*");
  });

  await page.waitForFunction(() => (
    ((window as typeof window & {
      __btvExportMessages?: Array<Record<string, unknown>>;
    }).__btvExportMessages ?? []).length > 0
  ));
  const [message] = await page.evaluate(() => (
    (window as typeof window & {
      __btvExportMessages?: Array<Record<string, unknown>>;
    }).__btvExportMessages ?? []
  ));

  expect(message.type).toBe("big-tree-viewer:exported");
  expect(message.ok).toBe(true);
  expect(message.format).toBe("svg");
  expect(String(message.text)).toContain("<svg");
});

test("postMessage PNG export can preserve viewport styling at higher pixel density", async ({ page }) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __btvExportMessages?: Array<Record<string, unknown>>;
    };
    testWindow.__btvExportMessages = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type === "big-tree-viewer:exported" || event.data?.type === "big-tree-viewer:export-error") {
        testWindow.__btvExportMessages?.push(event.data);
      }
    });
    window.postMessage({
      type: "big-tree-viewer:load",
      payload: {
        newick: "(A_species:1,B_species:1)Root;",
        label: "export-viewport-density-tree",
        visual: {
          viewMode: "circular",
          showTipLabels: false,
        },
      },
    }, "*");
  });
  await waitForLoadedTree(page);

  await page.evaluate(() => {
    window.postMessage({
      type: "big-tree-viewer:export",
      payload: {
        format: "png",
        delivery: "postMessage",
        filename: "current-view.png",
        width: 640,
        height: 640,
        viewportWidth: 320,
        viewportHeight: 320,
      },
    }, "*");
  });

  await page.waitForFunction(() => (
    ((window as typeof window & {
      __btvExportMessages?: Array<Record<string, unknown>>;
    }).__btvExportMessages ?? []).length > 0
  ));
  const [message] = await page.evaluate(() => (
    (window as typeof window & {
      __btvExportMessages?: Array<Record<string, unknown>>;
    }).__btvExportMessages ?? []
  ));

  expect(message.type).toBe("big-tree-viewer:exported");
  expect(message.ok).toBe(true);
  expect(message.format).toBe("png");
  expect(message.width).toBe(640);
  expect(message.height).toBe(640);
  expect(String(message.dataUrl)).toMatch(/^data:image\/png;base64,/);
});

test("postMessage circular PNG export coerces non-square dimensions to square", async ({ page }) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __btvExportMessages?: Array<Record<string, unknown>>;
    };
    testWindow.__btvExportMessages = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type === "big-tree-viewer:exported" || event.data?.type === "big-tree-viewer:export-error") {
        testWindow.__btvExportMessages?.push(event.data);
      }
    });
    window.postMessage({
      type: "big-tree-viewer:load",
      payload: {
        newick: "(A_species:1,B_species:1)Root;",
        label: "export-square-circular-tree",
        taxonomy: {
          map: {
            version: 1,
            mappedCount: 2,
            totalTips: 2,
            activeRanks: ["genus", "family"],
            tipRanks: [
              { node: 1, ranks: { genus: "A", family: "Alphaaceae" } },
              { node: 2, ranks: { genus: "B", family: "Betaaceae" } },
            ],
          },
        },
        visual: {
          viewMode: "circular",
          showTipLabels: false,
          taxonomyEnabled: true,
          taxonomyRankVisibility: { family: true, genus: true },
          taxonomyRankDisplayModes: { family: "label-only", genus: "label-only" },
        },
      },
    }, "*");
  });
  await waitForLoadedTree(page);

  await page.evaluate(() => {
    window.postMessage({
      type: "big-tree-viewer:export",
      payload: {
        format: "png",
        delivery: "postMessage",
        filename: "current-view.png",
        width: 900,
        height: 500,
        viewportWidth: 450,
        viewportHeight: 250,
      },
    }, "*");
  });

  await page.waitForFunction(() => (
    ((window as typeof window & {
      __btvExportMessages?: Array<Record<string, unknown>>;
    }).__btvExportMessages ?? []).length > 0
  ));
  const [message] = await page.evaluate(() => (
    (window as typeof window & {
      __btvExportMessages?: Array<Record<string, unknown>>;
    }).__btvExportMessages ?? []
  ));

  expect(message.type).toBe("big-tree-viewer:exported");
  expect(message.ok).toBe(true);
  expect(message.format).toBe("png");
  expect(message.width).toBe(900);
  expect(message.height).toBe(900);
  expect(String(message.dataUrl)).toMatch(/^data:image\/png;base64,/);
});

test("family label-only circular fit reserves the two-rank taxonomy envelope", async ({ page }) => {
  const tipCount = 96;
  const newick = `(${Array.from({ length: tipCount }, (_, index) => `Tip_${index}:1`).join(",")})Root;`;
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.evaluate((treeText) => {
    window.postMessage({
      type: "big-tree-viewer:load",
      payload: {
        newick: treeText,
        label: "family-label-only-fit-tree",
        visual: {
          viewMode: "circular",
          showTipLabels: false,
          showGenusLabels: false,
        },
      },
    }, "*");
  }, newick);
  await waitForLoadedTree(page);

  const scales = await page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes ?? [];
    if (!app || !canvas || leafNodes.length < 2) {
      throw new Error("Circular taxonomy fit test setup unavailable.");
    }

    app.setTaxonomyMapForTest({
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["genus", "family"],
      tipRanks: leafNodes.map((node, index) => ({
        node,
        ranks: {
          genus: `Genus${index}`,
          family: `Family${Math.floor(index / 8)}`,
        },
      })),
    });
    app.setTaxonomyEnabled(true);
    app.setTaxonomyBranchColoringEnabled(false);
    app.setViewMode("circular");
    app.setShowTipLabels(false);
    app.setShowGenusLabels(false);

    const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const fitWithModes = async (familyMode: "label-only" | "ribbon", genusMode: "hidden" | "ribbon"): Promise<number> => {
      app.setTaxonomyRankDisplayModeForTest("family", familyMode);
      app.setTaxonomyRankDisplayModeForTest("genus", genusMode);
      await nextFrame();
      await nextFrame();
      canvas.fitView();
      await nextFrame();
      await nextFrame();
      const camera = canvas.getCamera();
      if (!camera || camera.kind !== "circular" || typeof camera.scale !== "number") {
        throw new Error("Circular camera unavailable after fit.");
      }
      return camera.scale;
    };

    return {
      labelOnly: await fitWithModes("label-only", "hidden"),
      twoRibbon: await fitWithModes("ribbon", "ribbon"),
    };
  });

  expect(scales.labelOnly).toBeLessThanOrEqual(scales.twoRibbon * 1.02);
});
