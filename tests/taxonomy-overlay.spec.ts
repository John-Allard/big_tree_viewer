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

  expect(firstDebug.taxonomyLabelKeys ?? []).toContainEqual(expect.stringContaining("class:ArcLabelTarget:"));

  await setScale(1.5);

  const secondDebug = await page.evaluate(() => window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.circular as {
    taxonomyLabelKeys?: string[];
  });

  expect(secondDebug.taxonomyLabelKeys ?? []).toContainEqual(expect.stringContaining("class:ArcLabelTarget:"));
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
