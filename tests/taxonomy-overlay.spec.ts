import { expect, test, type Page } from "@playwright/test";

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => {
    return Boolean(
      window.__BIG_TREE_VIEWER_APP_TEST__
      && window.__BIG_TREE_VIEWER_CANVAS_TEST__
      && window.__BIG_TREE_VIEWER_RENDER_DEBUG__
      && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded,
    );
  });
}

async function enableMockTaxonomy(page: Page): Promise<void> {
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMockTaxonomy();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount ?? 0) > 0;
  });
}

test("rectangular taxonomy columns render when taxonomy is enabled", async ({ page }) => {
  await waitForViewer(page);
  await enableMockTaxonomy(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const rectDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
    taxonomyVisibleRanks?: string[];
    genusBandX?: number | null;
    tipSideX?: number;
  });

  expect((rectDebug.taxonomyVisibleRanks ?? []).length).toBeGreaterThan(0);
  expect(Number(rectDebug.genusBandX ?? 0)).toBeGreaterThan(Number(rectDebug.tipSideX ?? 0) + 10);
});

test("rectangular fit-view taxonomy keeps cached colored connectors visible", async ({ page }) => {
  await waitForViewer(page);
  await enableMockTaxonomy(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const rectDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
    branchRenderMode?: string;
    taxonomyVisibleRanks?: string[];
    taxonomyConnectorSegmentCount?: number;
  });

  expect(rectDebug.branchRenderMode).toBe("taxonomy-cached-paths");
  expect((rectDebug.taxonomyVisibleRanks ?? []).length).toBeGreaterThanOrEqual(1);
  expect((rectDebug.taxonomyVisibleRanks ?? []).length).toBeLessThanOrEqual(2);
  expect(Number(rectDebug.taxonomyConnectorSegmentCount ?? 0)).toBeGreaterThan(0);
});

test("real mapped rectangular fit-view starts with class and order taxonomy visible", async ({ page }) => {
  test.setTimeout(60000);
  await waitForViewer(page);
  await page.evaluate(async () => {
    await window.__BIG_TREE_VIEWER_APP_TEST__?.runRealTaxonomyMappingForTest();
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount ?? 0) > 0;
  });
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const rectDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
    branchRenderMode?: string;
    taxonomyVisibleRanks?: string[];
  });

  expect(rectDebug.branchRenderMode).toBe("taxonomy-cached-paths");
  expect(rectDebug.taxonomyVisibleRanks ?? []).toContain("class");
  expect(rectDebug.taxonomyVisibleRanks ?? []).toContain("order");
});

test("real mapped rectangular max zoom-out keeps coarse taxonomy overlays and colored branches", async ({ page }) => {
  test.setTimeout(60000);
  await waitForViewer(page);
  await page.evaluate(async () => {
    await window.__BIG_TREE_VIEWER_APP_TEST__?.runRealTaxonomyMappingForTest();
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount ?? 0) > 0;
  });
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "rect") {
      throw new Error("Rectangular camera unavailable.");
    }
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setRectCamera({
      scaleY: Number(camera.scaleY) * 0.55,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const rectState = await page.evaluate(() => ({
    debug: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
      branchRenderMode?: string;
      taxonomyVisibleRanks?: string[];
    } | undefined,
    branchColors: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors() ?? [],
  }));

  const coloredBranchCount = rectState.branchColors.filter((color: string) => color !== "#0f172a").length;
  expect(rectState.debug?.branchRenderMode).toBe("taxonomy-cached-paths");
  expect(rectState.debug?.taxonomyVisibleRanks ?? []).toContain("class");
  expect(coloredBranchCount).toBeGreaterThan(0);
});

test("rectangular taxonomy bands use outer-weighted widths and in-band vertical labels", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    if (!leafNodes || leafNodes.length < 80) {
      throw new Error("Leaf nodes unavailable for rectangular taxonomy label test.");
    }
    const tipRanks = leafNodes.map((node, index) => ({
      node,
      ranks: {
        phylum: index < 40 ? "Chordata" : "Arthropoda",
        class: index < 20 ? "Mammalia" : index < 40 ? "Aves" : index < 60 ? "Insecta" : "Arachnida",
      },
    }));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 3,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["class", "phylum"],
      tipRanks,
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("input");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount ?? 0) > 0;
  });
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "rect") {
      throw new Error("Rectangular camera unavailable.");
    }
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setRectCamera({
      scaleY: Math.max(Number(camera.scaleY) * 14, 12),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.waitForFunction(() => {
    const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
      taxonomyVisibleRanks?: string[];
      taxonomyPlacedLabelCount?: number;
    } | undefined;
    return Array.isArray(debug?.taxonomyVisibleRanks)
      && debug.taxonomyVisibleRanks.includes("class")
      && debug.taxonomyVisibleRanks.includes("phylum")
      && Number(debug.taxonomyPlacedLabelCount ?? 0) > 0;
  });

  const rectDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
    taxonomyVisibleRanks?: string[];
    taxonomyBandWidthsPx?: number[];
    taxonomyPlacedLabelCount?: number;
    taxonomyPlacedLabels?: Array<{ rotation?: number; text?: string }>;
  });

  expect(rectDebug.taxonomyVisibleRanks ?? []).toEqual(expect.arrayContaining(["class", "phylum"]));
  expect((rectDebug.taxonomyBandWidthsPx ?? []).length).toBeGreaterThanOrEqual(2);
  expect(Number(rectDebug.taxonomyBandWidthsPx?.[1] ?? 0)).toBeGreaterThan(Number(rectDebug.taxonomyBandWidthsPx?.[0] ?? 0));
  expect(Number(rectDebug.taxonomyPlacedLabelCount ?? 0)).toBeGreaterThan(0);
  for (const label of rectDebug.taxonomyPlacedLabels ?? []) {
    expect(Math.abs(Math.abs(Number(label.rotation ?? 0)) - (Math.PI * 0.5))).toBeLessThan(0.001);
  }
});

test("rectangular bottom-most taxonomy bands stop at the last tip center", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    if (!leafNodes || leafNodes.length < 80) {
      throw new Error("Leaf nodes unavailable for rectangular bottom-band test.");
    }
    const tipRanks = leafNodes.map((node, index) => ({
      node,
      ranks: {
        class: index >= 40 ? "Aves" : "Mammalia",
        order: index >= 60 ? "Passeriformes" : index >= 40 ? "Falconiformes" : "Primates",
      },
    }));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 4,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["order", "class"],
      tipRanks,
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("input");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount ?? 0) > 0;
  });
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "rect") {
      throw new Error("Rectangular camera unavailable.");
    }
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setRectCamera({
      scaleY: Math.max(Number(camera.scaleY) * 10, 8),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const rectDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
    taxonomyVisibleRanks?: string[];
    leafEdgeCenters?: { topY?: number; bottomY?: number } | null;
    taxonomyRenderedBlocks?: Array<{ rank: string; label: string; topY: number; bottomY: number }>;
  });

  expect(rectDebug.taxonomyVisibleRanks ?? []).toEqual(expect.arrayContaining(["class", "order"]));
  const bottomLeafY = Number(rectDebug.leafEdgeCenters?.bottomY ?? Number.NaN);
  const avesBottom = Math.max(...(rectDebug.taxonomyRenderedBlocks ?? [])
    .filter((block) => block.rank === "class" && block.label === "Aves")
    .map((block) => block.bottomY));
  const passeriformesBottom = Math.max(...(rectDebug.taxonomyRenderedBlocks ?? [])
    .filter((block) => block.rank === "order" && block.label === "Passeriformes")
    .map((block) => block.bottomY));

  expect(avesBottom).toBeGreaterThan(bottomLeafY - 1);
  expect(avesBottom).toBeLessThanOrEqual(bottomLeafY + 0.5);
  expect(passeriformesBottom).toBeGreaterThan(bottomLeafY - 1);
  expect(passeriformesBottom).toBeLessThanOrEqual(bottomLeafY + 0.5);
});

test("rectangular full-height taxonomy bands keep labels centered in the viewport", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    if (!leafNodes || leafNodes.length < 40) {
      throw new Error("Leaf nodes unavailable for rectangular centered-label test.");
    }
    const blockStart = Math.max(1, Math.floor(leafNodes.length * 0.18));
    const tipRanks = leafNodes.map((node, index) => ({
      node,
      ranks: {
        class: index >= blockStart ? "Aves" : "Mammalia",
      },
    }));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 5,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["class"],
      tipRanks,
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("input");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount ?? 0) > 0;
  });
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    const leafIndexMap = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLeafIndexMap();
    const canvas = document.querySelector("canvas");
    if (!camera || camera.kind !== "rect" || !leafNodes || !leafIndexMap || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Rectangular centered-label setup unavailable.");
    }
    const blockStart = Math.max(1, Math.floor(leafNodes.length * 0.18));
    const blockSpan = leafNodes.length - blockStart;
    const targetLeaf = leafNodes[Math.min(leafNodes.length - 1, blockStart + Math.floor(blockSpan * 0.78))];
    const targetY = Number(leafIndexMap[targetLeaf]);
    const scaleY = Math.max(canvas.height / Math.max(8, Math.floor(blockSpan * 0.28)), Number(camera.scaleY) * 5);
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setRectCamera({
      scaleY,
      translateY: (canvas.height * 0.5) - (targetY * scaleY),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const rectState = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    return {
      debug: window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
        taxonomyPlacedLabels?: Array<{ text: string; y: number }>;
      },
      canvasCenterY: canvas instanceof HTMLCanvasElement ? canvas.getBoundingClientRect().height * 0.5 : null,
    };
  });

  const avesLabel = (rectState.debug.taxonomyPlacedLabels ?? []).find((label) => label.text === "Aves");
  const viewportCenterY = Number(rectState.canvasCenterY ?? 0);
  expect(avesLabel).toBeTruthy();
  expect(Math.abs(Number(avesLabel?.y ?? 0) - viewportCenterY)).toBeLessThanOrEqual(3);
});

test("tip context menu exposes copy tip name action", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!camera || camera.kind !== "rect") {
      throw new Error("Rectangular camera unavailable.");
    }
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setRectCamera({
      scaleY: Math.max(Number(camera.scaleY) * 14, 10),
    });
    Object.defineProperty(window.navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          (window as typeof window & { __copiedText?: string }).__copiedText = text;
        },
      },
      configurable: true,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const tipPoint = await page.evaluate(() => {
    const hitboxes = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes?.() ?? [];
    const canvas = document.querySelector("canvas");
    const tipHit = hitboxes.find((hitbox) => hitbox.labelKind === "tip");
    if (!(canvas instanceof HTMLCanvasElement) || !tipHit) {
      throw new Error("Tip label hitbox unavailable.");
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + Number(tipHit.x) + (Number(tipHit.width) * 0.5),
      y: rect.top + Number(tipHit.y) + (Number(tipHit.height) * 0.5),
    };
  });

  await page.mouse.click(tipPoint.x, tipPoint.y, { button: "right" });
  await expect(page.getByRole("button", { name: "Copy Tip Name" })).toBeVisible();
  const menuTitle = await page.locator(".tree-context-menu-title").textContent();
  await page.getByRole("button", { name: "Copy Tip Name" }).click();

  const copiedText = await page.evaluate(() => (window as typeof window & { __copiedText?: string }).__copiedText ?? null);
  expect(copiedText).toBe(menuTitle);
});

test("taxonomy label context menu exposes MRCA zoom, copy name, and NCBI open", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    if (!leafNodes || leafNodes.length < 60) {
      throw new Error("Leaf nodes unavailable for taxonomy context-menu test.");
    }
    const split = Math.max(8, Math.floor(leafNodes.length * 0.2));
    const tipRanks = leafNodes.map((node, index) => ({
      node,
      ranks: {
        class: index < split ? "Mammalia" : "Aves",
      },
      taxIds: {
        class: index < split ? 40674 : 8782,
      },
    }));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 6,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["class"],
      tipRanks,
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("input");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    Object.defineProperty(window, "open", {
      value: (url: string) => {
        (window as typeof window & { __openedUrl?: string }).__openedUrl = url;
        return null;
      },
      configurable: true,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const taxonomyPoint = await page.evaluate(() => {
    const hitboxes = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes?.() ?? [];
    const canvas = document.querySelector("canvas");
    const taxonomyHit = hitboxes.find((hitbox) => hitbox.labelKind === "taxonomy" && hitbox.text === "Aves");
    if (!(canvas instanceof HTMLCanvasElement) || !taxonomyHit) {
      throw new Error("Taxonomy label hitbox unavailable.");
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + Number(taxonomyHit.x) + (Number(taxonomyHit.width) * 0.5),
      y: rect.top + Number(taxonomyHit.y) + (Number(taxonomyHit.height) * 0.5),
    };
  });

  await page.mouse.click(taxonomyPoint.x, taxonomyPoint.y, { button: "right" });
  await expect(page.getByRole("button", { name: "Zoom To Group MRCA" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy Name" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open In NCBI Taxonomy" })).toBeVisible();
  await page.getByRole("button", { name: "Open In NCBI Taxonomy" }).click();

  const openedUrl = await page.evaluate(() => (window as typeof window & { __openedUrl?: string }).__openedUrl ?? null);
  expect(openedUrl).toContain("id=8782");
});

test("taxonomy search ranks exact matches before higher-rank substring matches", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    if (!leafNodes || leafNodes.length < 80) {
      throw new Error("Leaf nodes unavailable for taxonomy search ranking test.");
    }
    const split = Math.floor(leafNodes.length * 0.5);
    const tipRanks = leafNodes.map((node, index) => ({
      node,
      ranks: index < split
        ? {
          class: "Aves",
          order: "Avesiformes",
          family: "Avesidae",
          genus: "Avesella",
        }
        : {
          class: "Mammalia",
          order: "Primates",
          family: "Hominidae",
          genus: "Homo",
        },
    }));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 7,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["genus", "family", "order", "class"],
      tipRanks,
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setSearchQuery("aves");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState() as {
      searchResults?: Array<unknown>;
    } | undefined;
    return Array.isArray(state?.searchResults) && state.searchResults.length >= 4;
  });

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState()) as {
    searchResults?: Array<{ kind?: string; displayName?: string; rank?: string | null }>;
    activeSearchResult?: { kind?: string; displayName?: string; rank?: string | null } | null;
  };

  expect(state.activeSearchResult?.kind).toBe("taxonomy");
  expect(state.activeSearchResult?.displayName).toBe("Aves");
  expect(state.searchResults?.slice(0, 4)).toEqual([
    expect.objectContaining({ kind: "taxonomy", rank: "class", displayName: "Aves" }),
    expect.objectContaining({ kind: "taxonomy", rank: "order", displayName: "Avesiformes" }),
    expect.objectContaining({ kind: "taxonomy", rank: "family", displayName: "Avesidae" }),
    expect.objectContaining({ kind: "taxonomy", rank: "genus", displayName: "Avesella" }),
  ]);
});

test("taxonomy search highlights the active taxonomy label and focuses its subtree", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    const parent = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.parent;
    const firstChild = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.firstChild;
    const nextSibling = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.nextSibling;
    if (!leafNodes || leafNodes.length < 80) {
      throw new Error("Leaf nodes unavailable for taxonomy search focus test.");
    }
    if (!parent || !firstChild || !nextSibling) {
      throw new Error("Tree topology unavailable for taxonomy search focus test.");
    }
    const root = parent.findIndex((value) => value < 0);
    if (root < 0) {
      throw new Error("Root node unavailable for taxonomy search focus test.");
    }
    const postorder: number[] = [];
    const stack: Array<{ node: number; expanded: boolean }> = [{ node: root, expanded: false }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      if (current.expanded) {
        postorder.push(current.node);
        continue;
      }
      stack.push({ node: current.node, expanded: true });
      for (let child = firstChild[current.node]; child >= 0; child = nextSibling[child]) {
        stack.push({ node: child, expanded: false });
      }
    }
    const leafCountByNode = new Array(parent.length).fill(0);
    for (const node of postorder) {
      if (firstChild[node] < 0) {
        leafCountByNode[node] = 1;
        continue;
      }
      let total = 0;
      for (let child = firstChild[node]; child >= 0; child = nextSibling[child]) {
        total += leafCountByNode[child];
      }
      leafCountByNode[node] = total;
    }
    const minLeafCount = Math.max(8, Math.floor(leafNodes.length * 0.06));
    const maxLeafCount = Math.max(minLeafCount + 1, Math.floor(leafNodes.length * 0.22));
    const targetNode = postorder.find((node) => (
      firstChild[node] >= 0
      && leafCountByNode[node] >= minLeafCount
      && leafCountByNode[node] <= maxLeafCount
    ));
    if (targetNode === undefined) {
      throw new Error("No suitable subtree found for taxonomy search focus test.");
    }
    const targetLeaves = new Set<number>();
    const subtreeStack = [targetNode];
    while (subtreeStack.length > 0) {
      const node = subtreeStack.pop();
      if (node === undefined) {
        continue;
      }
      if (firstChild[node] < 0) {
        targetLeaves.add(node);
        continue;
      }
      for (let child = firstChild[node]; child >= 0; child = nextSibling[child]) {
        subtreeStack.push(child);
      }
    }
    const tipRanks = leafNodes.map((node) => ({
      node,
      ranks: {
        class: targetLeaves.has(node) ? "Aves" : "Mammalia",
      },
    }));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 8,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["class"],
      tipRanks,
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    window.__BIG_TREE_VIEWER_APP_TEST__?.setSearchQuery("Aves");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.waitForFunction(() => {
    const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
      taxonomyPlacedLabels?: Array<{ text?: string; searchHighlightColor?: string | null }>;
    } | undefined;
    return Boolean(
      debug?.taxonomyPlacedLabels?.some((label) => label.text === "Aves" && label.searchHighlightColor === "#c2410c"),
    );
  });

  const beforeCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()) as {
    kind?: string;
    scaleY?: number;
  } | null;
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.requestSearchFocus();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const afterCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera()) as {
    kind?: string;
    scaleY?: number;
  } | null;

  expect(beforeCamera?.kind).toBe("rect");
  expect(afterCamera?.kind).toBe("rect");
  expect(Number(afterCamera?.scaleY ?? 0)).toBeGreaterThan(Number(beforeCamera?.scaleY ?? 0) * 1.4);
});

test("search still returns genus matches first without a taxonomy mapping", async ({ page }) => {
  await waitForViewer(page);
  const query = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.clearTaxonomy();
    window.__BIG_TREE_VIEWER_APP_TEST__?.setShowGenusLabels(false);
    const names = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names;
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    if (!names || !leafNodes) {
      throw new Error("Example tree names unavailable for genus fallback search test.");
    }
    const counts = new Map<string, number>();
    for (const node of leafNodes) {
      const genus = String(names[node] ?? "").trim().split(/[_ ]+/).filter(Boolean)[0] ?? "";
      if (genus.length <= 4) {
        continue;
      }
      counts.set(genus, (counts.get(genus) ?? 0) + 1);
    }
    const candidate = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
    if (!candidate) {
      throw new Error("No suitable genus candidate found in example tree.");
    }
    const partialQuery = candidate.slice(0, Math.max(3, Math.min(5, candidate.length - 1)));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setSearchQuery(partialQuery);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return partialQuery;
  });
  await page.waitForFunction((expectedQuery) => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState() as {
      searchQuery?: string;
      searchResults?: Array<{ kind?: string }>;
    } | undefined;
    return state?.searchQuery === expectedQuery
      && Array.isArray(state.searchResults)
      && state.searchResults.length > 0;
  }, query);

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState()) as {
    searchResults?: Array<{ kind?: string; displayName?: string }>;
  };

  expect(state.searchResults?.[0]?.kind).toBe("genus");
});

test("circular taxonomy rings stay outside the tip-label band", async ({ page }) => {
  await waitForViewer(page);
  await enableMockTaxonomy(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.evaluate(async () => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const canvas = document.querySelector("canvas");
    if (!state || !camera || camera.kind !== "circular" || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Circular taxonomy test setup unavailable.");
    }
    const radiusWorld = Number(state.isUltrametric ? state.rootAge : state.maxDepth);
    const rect = canvas.getBoundingClientRect();
    const scale = Math.max(Number(camera.scale) * 55, 42);
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      scale,
      translateX: (rect.width * 0.34) - (radiusWorld * scale),
      translateY: rect.height * 0.54,
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const circularDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    tipVisible: boolean;
    microVisible: boolean;
    taxonomyVisibleRanks?: string[];
    taxonomyTipBandOuterRadiusPx?: number | null;
    taxonomyFirstRingInnerRadiusPx?: number | null;
  });

  expect(circularDebug.tipVisible || circularDebug.microVisible).toBeTruthy();
  expect((circularDebug.taxonomyVisibleRanks ?? []).length).toBeGreaterThan(0);
  expect(Number(circularDebug.taxonomyFirstRingInnerRadiusPx ?? 0)).toBeGreaterThan(
    Number(circularDebug.taxonomyTipBandOuterRadiusPx ?? 0) + 6,
  );
});

test("circular taxonomy overlay uses full-strength taxon colors", async ({ page }) => {
  await waitForViewer(page);
  await enableMockTaxonomy(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const circularDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    taxonomyOverlayAlpha?: number;
  });

  expect(Number(circularDebug.taxonomyOverlayAlpha ?? 0)).toBe(1);
});

test("circular full-view taxonomy keeps only coarse ranks visible", async ({ page }) => {
  await waitForViewer(page);
  await enableMockTaxonomy(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const circularDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    taxonomyVisibleRanks?: string[];
  });

  expect((circularDebug.taxonomyVisibleRanks ?? []).length).toBeGreaterThanOrEqual(1);
  expect((circularDebug.taxonomyVisibleRanks ?? []).length).toBeLessThanOrEqual(2);
});

test("cached taxonomy mapping restores across reload for the same tree", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    await window.__BIG_TREE_VIEWER_APP_TEST__?.cacheMockTaxonomy();
  });

  await page.reload();
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount ?? 0) > 0;
  });
});

test("circular taxonomy labels persist once a visible arc can fit them", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    if (!leafNodes || leafNodes.length < 80) {
      throw new Error("Leaf nodes unavailable for taxonomy label test.");
    }
    const tipRanks = leafNodes.map((node, index) => ({
      node,
      ranks: {
        class: index < 40 ? "ArcLabelTarget" : "OtherClass",
      },
    }));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 3,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["class"],
      tipRanks,
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("input");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const setScale = async (factor: number): Promise<void> => {
    await page.evaluate(async (factorValue) => {
      const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
      if (!leafNodes || leafNodes.length < 80) {
        throw new Error("Leaf nodes unavailable for taxonomy label test.");
      }
      const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
      const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
      const canvas = document.querySelector("canvas");
      if (!camera || camera.kind !== "circular" || !state || !(canvas instanceof HTMLCanvasElement)) {
        throw new Error("Circular camera unavailable.");
      }
      const radiusWorld = Number(state.isUltrametric ? state.rootAge : state.maxDepth);
      const rect = canvas.getBoundingClientRect();
      const theta = ((20 / leafNodes.length) * Math.PI * 2);
      const scale = Math.max(Number(camera.scale) * factorValue, 18);
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
        scale,
        translateX: (rect.width * 0.45) - (Math.cos(theta) * radiusWorld * scale),
        translateY: rect.height * 0.58,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, factor);
  };

  await setScale(80);

  const firstDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    taxonomyLabelKeys?: string[];
  });

  expect(firstDebug.taxonomyLabelKeys ?? []).toContain("class:ArcLabelTarget");

  await setScale(1.5);

  const secondDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    taxonomyLabelKeys?: string[];
  });

  expect(secondDebug.taxonomyLabelKeys ?? []).toContain("class:ArcLabelTarget");
});

test("single unmapped interlopers do not split taxonomy continuity", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    if (!leafNodes || leafNodes.length < 30) {
      throw new Error("Leaf nodes unavailable for taxonomy continuity test.");
    }
    const tipRanks = leafNodes.map((node, index) => {
      if (index === 10) {
        return { node, ranks: {} };
      }
      return {
        node,
        ranks: {
          class: index < 20 ? "Amphibia" : "Mammalia",
        },
      };
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 3,
      mappedCount: leafNodes.length - 1,
      totalTips: leafNodes.length,
      activeRanks: ["class"],
      tipRanks,
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("input");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const circularDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    taxonomyBlockCounts?: Record<string, number>;
  });

  expect(Number(circularDebug.taxonomyBlockCounts?.class ?? 0)).toBe(2);
});

test("circular taxonomy labels move with their clades when the fit view is rotated", async ({ page }) => {
  await waitForViewer(page);
  await enableMockTaxonomy(page);
  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const initial = await page.evaluate(() => {
    const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
      taxonomyPlacedLabels?: Array<{ key?: string | null; text: string; x: number; y: number }>;
    } | undefined;
    return debug?.taxonomyPlacedLabels ?? [];
  });

  expect(initial.length).toBeGreaterThan(0);

  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setCircularRotationDegreesForTest(90);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const rotated = await page.evaluate(() => {
    const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
      taxonomyPlacedLabels?: Array<{ key?: string | null; text: string; x: number; y: number }>;
    } | undefined;
    return debug?.taxonomyPlacedLabels ?? [];
  });

  expect(rotated.length).toBeGreaterThan(0);
  const rotatedByKey = new Map(rotated.map((label) => [label.key ?? label.text, label]));
  const maxDistance = initial.reduce((best, label) => {
    const match = rotatedByKey.get(label.key ?? label.text);
    if (!match) {
      return best;
    }
    return Math.max(best, Math.hypot(match.x - label.x, match.y - label.y));
  }, 0);
  expect(maxDistance).toBeGreaterThan(60);
});

test("circular taxonomy labels on the same ring do not overlap after zooming into a dense sector", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(async () => {
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    if (!leafNodes || leafNodes.length < 200) {
      throw new Error("Leaf nodes unavailable for overlap test.");
    }
    const tipRanks = leafNodes.map((node, index) => {
      const inSector = index < 400;
      const familyIndex = inSector ? Math.floor(index / 40) : 100 + Math.floor((index - 400) / 50);
      const genusIndex = inSector ? Math.floor(index / 8) : 200 + Math.floor((index - 400) / 10);
      return {
        node,
        ranks: {
          class: "Mammalia",
          order: inSector ? "Primates" : "Rodentia",
          family: `Family${familyIndex}`,
          genus: `Genus${genusIndex}`,
        },
      };
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 3,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["class", "order", "family", "genus"],
      tipRanks,
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("input");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  await page.evaluate(async () => {
    const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
      taxonomyPlacedLabels?: Array<{ text: string; x: number; y: number; rank?: string | null }>;
    } | undefined;
    const anchor = (debug?.taxonomyPlacedLabels ?? []).find((label) => label.rank === "order")
      ?? (debug?.taxonomyPlacedLabels ?? []).find((label) => label.rank === "family")
      ?? (debug?.taxonomyPlacedLabels ?? []).find((label) => label.rank === "class")
      ?? null;
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    if (!anchor || !camera || camera.kind !== "circular") {
      throw new Error("Taxonomy zoom target unavailable.");
    }
    const dx = (anchor.x - camera.translateX) / camera.scale;
    const dy = (anchor.y - camera.translateY) / camera.scale;
    const worldX = (dx * camera.rotationCos) + (dy * camera.rotationSin);
    const worldY = (-dx * camera.rotationSin) + (dy * camera.rotationCos);
    const scale = camera.scale * 20;
    const rotatedX = (worldX * camera.rotationCos) - (worldY * camera.rotationSin);
    const rotatedY = (worldX * camera.rotationSin) + (worldY * camera.rotationCos);
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      scale,
      translateX: anchor.x - (rotatedX * scale),
      translateY: anchor.y - (rotatedY * scale),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const overlapResult = await page.evaluate(() => {
    const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
      taxonomyPlacedLabels?: Array<{
        rank?: string | null;
        text: string;
        fontSize: number;
        theta?: number | null;
        clipArc?: { innerRadiusPx: number; outerRadiusPx: number } | null;
      }>;
    } | undefined;
    const labels = (debug?.taxonomyPlacedLabels ?? []).filter((label) => label.rank && label.theta !== null && label.clipArc);
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Canvas unavailable for overlap measurement.");
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D context unavailable.");
    }
    const splitWrapped = (start: number, end: number) => {
      const tau = Math.PI * 2;
      const wrap = (value: number) => ((value % tau) + tau) % tau;
      const a = wrap(start);
      const b = wrap(end);
      if (b >= a) {
        return [{ start: a, end: b }];
      }
      return [{ start: a, end: tau }, { start: 0, end: b }];
    };
    const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
    let count = 0;
    for (let index = 0; index < labels.length; index += 1) {
      const left = labels[index];
      ctx.font = `${left.fontSize}px "IBM Plex Sans", "Segoe UI", sans-serif`;
      const leftWidth = ctx.measureText(left.text).width;
      const leftRadius = ((left.clipArc?.innerRadiusPx ?? 0) + (left.clipArc?.outerRadiusPx ?? 0)) * 0.5;
      const leftIntervals = splitWrapped((left.theta ?? 0) - ((leftWidth / Math.max(leftRadius, 1e-6)) * 0.5), (left.theta ?? 0) + ((leftWidth / Math.max(leftRadius, 1e-6)) * 0.5));
      for (let otherIndex = index + 1; otherIndex < labels.length; otherIndex += 1) {
        const right = labels[otherIndex];
        if (left.rank !== right.rank) {
          continue;
        }
        ctx.font = `${right.fontSize}px "IBM Plex Sans", "Segoe UI", sans-serif`;
        const rightWidth = ctx.measureText(right.text).width;
        const rightRadius = ((right.clipArc?.innerRadiusPx ?? 0) + (right.clipArc?.outerRadiusPx ?? 0)) * 0.5;
        const rightIntervals = splitWrapped((right.theta ?? 0) - ((rightWidth / Math.max(rightRadius, 1e-6)) * 0.5), (right.theta ?? 0) + ((rightWidth / Math.max(rightRadius, 1e-6)) * 0.5));
        if (leftIntervals.some((leftInterval) => rightIntervals.some((rightInterval) => overlaps(leftInterval, rightInterval)))) {
          count += 1;
        }
      }
    }
    const denseRankCounts = labels.reduce<Record<string, number>>((accumulator, label) => {
      const rank = label.rank ?? "unknown";
      accumulator[rank] = (accumulator[rank] ?? 0) + 1;
      return accumulator;
    }, {});
    return { overlapCount: count, denseRankCounts };
  });

  expect(Math.max(0, ...Object.values(overlapResult.denseRankCounts))).toBeGreaterThanOrEqual(8);
  expect(overlapResult.overlapCount).toBe(0);
});

test("real mapped Pongo appears as an in-arc circular taxonomy label at deep ape zoom", async ({ page }) => {
  test.setTimeout(60000);
  await waitForViewer(page);
  await page.evaluate(async () => {
    await window.__BIG_TREE_VIEWER_APP_TEST__?.runRealTaxonomyMappingForTest();
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.viewMode === "circular" && Boolean(state?.taxonomyEnabled);
  });

  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  await page.evaluate(async () => {
    const names = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? [];
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes ?? [];
    const leafIndexMap = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLeafIndexMap() ?? {};
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    if (!camera || camera.kind !== "circular" || !state) {
      throw new Error("Circular camera unavailable for Pongo test.");
    }
    const pongoIndices = leafNodes
      .filter((node) => {
        const name = String(names[node] ?? "");
        return name.startsWith("Pongo_") || name.startsWith("Pongo ");
      })
      .map((node) => Number(leafIndexMap[node]))
      .sort((left, right) => left - right);
    if (pongoIndices.length === 0) {
      throw new Error("Pongo tips unavailable for real taxonomy test.");
    }
    const leafCount = leafNodes.length;
    const startIndex = pongoIndices[0];
    const endIndex = pongoIndices[pongoIndices.length - 1] + 1;
    const turns = Math.PI * 2;
    const startTheta = ((startIndex - 0.5) / leafCount) * turns;
    const endTheta = ((endIndex - 0.5) / leafCount) * turns;
    const midTheta = (startTheta + endTheta) * 0.5;
    const radiusWorld = Number(state.rootAge);
    const scale = Number(camera.scale) * 384;
    const rotatedX = ((Math.cos(midTheta) * radiusWorld) * camera.rotationCos) - ((Math.sin(midTheta) * radiusWorld) * camera.rotationSin);
    const rotatedY = ((Math.cos(midTheta) * radiusWorld) * camera.rotationSin) + ((Math.sin(midTheta) * radiusWorld) * camera.rotationCos);
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setCircularCamera({
      scale,
      translateX: (1400 * 0.56) - (rotatedX * scale),
      translateY: (900 * 0.50) - (rotatedY * scale),
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const circularDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    taxonomyArcDebug?: Array<{ key?: string | null; mode?: string | null; lineWidthPx?: number | null }>;
    taxonomyPlacedLabels?: Array<{ text: string; key?: string | null; clipArc?: { skipClip?: boolean | null } | null }>;
  });

  const apeLabels = (circularDebug.taxonomyPlacedLabels ?? []).filter((label) => ["Pongo", "Gorilla", "Homo", "Pan"].includes(label.text));
  expect(apeLabels.map((label) => label.text).sort()).toEqual(["Gorilla", "Homo", "Pan", "Pongo"]);
  expect(apeLabels.every((label) => Boolean(label.clipArc))).toBeTruthy();
  expect(apeLabels.every((label) => label.clipArc?.skipClip === true)).toBeTruthy();

  const apeArcDebug = (circularDebug.taxonomyArcDebug ?? []).filter((arc) => /:(Pongo|Gorilla|Homo|Pan):/.test(String(arc.key ?? "")));
  expect(apeArcDebug).toHaveLength(4);
  expect(apeArcDebug.every((arc) => arc.mode === "ribbon")).toBeTruthy();
  expect(apeArcDebug.every((arc) => Number(arc.lineWidthPx ?? 0) > 0)).toBeTruthy();

  const apeArcPixels = await page.evaluate(() => {
    const debug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
      taxonomyArcDebug?: Array<{ key?: string | null; startTheta?: number | null; endTheta?: number | null; lineRadiusPx?: number | null }>;
    } | undefined;
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    const canvas = document.querySelector("canvas");
    if (!debug || !camera || camera.kind !== "circular" || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Circular arc pixel probe unavailable.");
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("2D context unavailable.");
    }
    const background = [251, 252, 254, 255];
    const distance = (rgba: number[]) => Math.hypot(
      rgba[0] - background[0],
      rgba[1] - background[1],
      rgba[2] - background[2],
      rgba[3] - background[3],
    );
    return (debug.taxonomyArcDebug ?? [])
      .filter((arc) => /:(Pongo|Gorilla|Homo|Pan):/.test(String(arc.key ?? "")))
      .map((arc) => {
        const midTheta = ((Number(arc.startTheta ?? 0) + Number(arc.endTheta ?? 0)) * 0.5) + camera.rotation;
        const radiusPx = Number(arc.lineRadiusPx ?? 0);
        const distances = [-10, -5, 0, 5, 10].map((radialOffset) => {
          const x = Math.round(camera.translateX + (Math.cos(midTheta) * (radiusPx + radialOffset)));
          const y = Math.round(camera.translateY + (Math.sin(midTheta) * (radiusPx + radialOffset)));
          return distance(Array.from(ctx.getImageData(x, y, 1, 1).data));
        });
        return {
          key: arc.key ?? null,
          maxDistance: Math.max(...distances),
        };
      });
  });

  expect(apeArcPixels.every((arc) => arc.maxDistance > 20)).toBeTruthy();
});
