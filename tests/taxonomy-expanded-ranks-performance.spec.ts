import { expect, test } from "@playwright/test";
import { gzipSync, strToU8 } from "fflate";
import { buildTaxonomyBlocksForOrderedLeaves } from "../src/lib/taxonomyBlocks";
import {
  addTaxonomyIndexEntry,
  enrichTaxonomyMapRanks,
  mapTipsWithContext,
  type ParsedTaxonomyForMapping,
  type TaxonomyNodeInfo,
} from "../src/lib/taxonomyNameResolver";
import {
  DEFAULT_TAXONOMY_RANKS,
  TAXONOMY_RANKS,
  type TaxonomyMapPayload,
  type TaxonomyRank,
  type TaxonomyTipRanks,
} from "../src/types/taxonomy";

const BENCHMARK_TIP_COUNT = Math.max(
  10_000,
  Number.parseInt(process.env.BTV_TAXONOMY_BENCH_TIPS ?? "100000", 10) || 100_000,
);

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function timed<T>(operation: () => T): { elapsedMs: number; value: T } {
  const startedAt = performance.now();
  const value = operation();
  return { elapsedMs: performance.now() - startedAt, value };
}

function syntheticTipRanks(tipCount: number, includeOptionalRanks: boolean): TaxonomyTipRanks[] {
  return Array.from({ length: tipCount }, (_, node) => {
    const broadGroup = node < tipCount / 2 ? "A" : "B";
    const fineGroup = Math.floor(node / Math.max(2, Math.ceil(tipCount / 40)));
    const ranks: Partial<Record<TaxonomyRank, string>> = {
      superkingdom: "Eukaryota",
      kingdom: `Kingdom ${broadGroup}`,
      phylum: `Phylum ${Math.floor(fineGroup / 8)}`,
      class: `Class ${Math.floor(fineGroup / 4)}`,
      order: `Order ${Math.floor(fineGroup / 2)}`,
      family: `Family ${fineGroup}`,
      genus: `Genus ${Math.floor(node / Math.max(2, Math.ceil(tipCount / 200)))}`,
    };
    if (includeOptionalRanks) {
      ranks.superfamily = `Superfamily ${Math.floor(fineGroup / 2)}`;
      ranks.subfamily = `Subfamily ${fineGroup}`;
      ranks.tribe = `Tribe ${fineGroup}`;
      ranks.subgenus = `Subgenus ${Math.floor(node / Math.max(2, Math.ceil(tipCount / 400)))}`;
    }
    return { node, ranks };
  });
}

function benchmarkBlocks(
  taxonomyMap: TaxonomyMapPayload,
  orderedLeaves: number[],
  ranks: readonly TaxonomyRank[],
): number {
  return median(Array.from({ length: 3 }, () => timed(() => (
    buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, taxonomyMap, null, undefined, ranks)
  )).elapsedMs));
}

function buildDeepTaxonomy(): { taxonomy: ParsedTaxonomyForMapping; speciesTaxIds: [number, number] } {
  const nodes = new Map<number, TaxonomyNodeInfo>();
  const rankNames = new Map<number, string>();
  const speciesIndex = new Map<string, number[]>();
  const genusIndex = new Map<string, number[]>();
  const namedTaxonIndex = new Map<string, number[]>();
  nodes.set(1, { parentId: 1, rank: "no rank" });

  const speciesTaxIds: number[] = [];
  for (let lineage = 0; lineage < 2; lineage += 1) {
    let parentId = 1;
    for (let rankIndex = 0; rankIndex < TAXONOMY_RANKS.length; rankIndex += 1) {
      const taxId = 10_000 + (lineage * 1_000) + rankIndex;
      const rank = TAXONOMY_RANKS[rankIndex];
      nodes.set(taxId, { parentId, rank });
      rankNames.set(taxId, `${rank} ${lineage + 1}`);
      parentId = taxId;
    }
    const speciesTaxId = 10_000 + (lineage * 1_000) + TAXONOMY_RANKS.length;
    nodes.set(speciesTaxId, { parentId, rank: "species" });
    rankNames.set(speciesTaxId, `Species ${lineage + 1}`);
    addTaxonomyIndexEntry(speciesIndex, `species ${lineage + 1}`, speciesTaxId);
    speciesTaxIds.push(speciesTaxId);
  }

  return {
    taxonomy: { nodes, rankNames, speciesIndex, genusIndex, namedTaxonIndex },
    speciesTaxIds: speciesTaxIds as [number, number],
  };
}

test.describe("expanded taxonomy rank performance", () => {
  test.setTimeout(120_000);

  test("hidden optional ranks preserve core ribbon preprocessing performance", () => {
    const orderedLeaves = Array.from({ length: BENCHMARK_TIP_COUNT }, (_, index) => index);
    const expandedMap: TaxonomyMapPayload = {
      version: 13,
      mappedCount: BENCHMARK_TIP_COUNT,
      totalTips: BENCHMARK_TIP_COUNT,
      activeRanks: [...DEFAULT_TAXONOMY_RANKS, "superfamily", "subfamily", "tribe", "subgenus"],
      tipRanks: syntheticTipRanks(BENCHMARK_TIP_COUNT, true),
    };
    const coreMap: TaxonomyMapPayload = {
      ...expandedMap,
      activeRanks: [...DEFAULT_TAXONOMY_RANKS],
      tipRanks: syntheticTipRanks(BENCHMARK_TIP_COUNT, false),
    };

    buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, coreMap, null, undefined, DEFAULT_TAXONOMY_RANKS);
    buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, expandedMap, null, undefined, DEFAULT_TAXONOMY_RANKS);
    buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, expandedMap, null, undefined, [...DEFAULT_TAXONOMY_RANKS, "subgenus"]);
    buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, expandedMap, null, undefined, [...DEFAULT_TAXONOMY_RANKS, "superfamily", "subgenus"]);
    const coreMs = benchmarkBlocks(coreMap, orderedLeaves, DEFAULT_TAXONOMY_RANKS);
    const retainedHiddenMs = benchmarkBlocks(expandedMap, orderedLeaves, DEFAULT_TAXONOMY_RANKS);
    const oneAddedMs = benchmarkBlocks(expandedMap, orderedLeaves, [...DEFAULT_TAXONOMY_RANKS, "subgenus"]);
    const twoAddedMs = benchmarkBlocks(expandedMap, orderedLeaves, [...DEFAULT_TAXONOMY_RANKS, "superfamily", "subgenus"]);

    console.info("taxonomy-ribbon-benchmark", {
      tips: BENCHMARK_TIP_COUNT,
      coreMs: Math.round(coreMs),
      retainedHiddenMs: Math.round(retainedHiddenMs),
      oneAddedMs: Math.round(oneAddedMs),
      twoAddedMs: Math.round(twoAddedMs),
    });
    expect(retainedHiddenMs).toBeLessThan(coreMs * 1.5 + 100);
    expect(oneAddedMs).toBeLessThan(retainedHiddenMs * 1.5 + 100);
    expect(twoAddedMs).toBeLessThan(retainedHiddenMs * 1.75 + 125);
    expect(retainedHiddenMs).toBeLessThan(5_000);
  });

  test("on-demand enrichment of one or two ranks remains bounded", () => {
    const mappingTipCount = BENCHMARK_TIP_COUNT;
    const { taxonomy, speciesTaxIds } = buildDeepTaxonomy();
    const tips = Array.from({ length: mappingTipCount }, (_, node) => ({
      node,
      name: `sequence_${node}_taxid_${speciesTaxIds[node % speciesTaxIds.length]}`,
    }));
    const coreMap = mapTipsWithContext(
      tips,
      taxonomy,
      [...DEFAULT_TAXONOMY_RANKS],
      13,
      { identifierMode: "ncbi-taxid", enableCollapseFallbacks: true },
    );
    const run = (ranks: TaxonomyRank[]): number => timed(() => enrichTaxonomyMapRanks(
      coreMap,
      taxonomy,
      ranks,
      14,
      true,
    )).elapsedMs;

    run(["subgenus"]);
    run(["superfamily", "subgenus"]);
    const oneRankMs = median([run(["subgenus"]), run(["subgenus"])]);
    const twoRankMs = median([run(["superfamily", "subgenus"]), run(["superfamily", "subgenus"])]);

    console.info("taxonomy-enrichment-benchmark", {
      tips: mappingTipCount,
      oneRankMs: Math.round(oneRankMs),
      twoRankMs: Math.round(twoRankMs),
    });
    expect(twoRankMs).toBeLessThan(oneRankMs * 2 + 250);
    expect(twoRankMs).toBeLessThan(5_000);
  });

  test("one or two optional ranks have bounded compressed storage overhead", () => {
    const storageTipCount = 10_000;
    const { taxonomy, speciesTaxIds } = buildDeepTaxonomy();
    const tips = Array.from({ length: storageTipCount }, (_, node) => ({
      node,
      name: `sequence_${node}_taxid_${speciesTaxIds[node % speciesTaxIds.length]}`,
    }));
    const map = (ranks: TaxonomyRank[]) => mapTipsWithContext(
      tips,
      taxonomy,
      ranks,
      13,
      { identifierMode: "ncbi-taxid", enableCollapseFallbacks: true },
    );
    const coreJson = JSON.stringify(map([...DEFAULT_TAXONOMY_RANKS]));
    const oneRankJson = JSON.stringify(map([...DEFAULT_TAXONOMY_RANKS, "subgenus"]));
    const twoRankJson = JSON.stringify(map([...DEFAULT_TAXONOMY_RANKS, "superfamily", "subgenus"]));
    const coreCompressedBytes = gzipSync(strToU8(coreJson), { level: 6 }).byteLength;
    const oneRankCompressedBytes = gzipSync(strToU8(oneRankJson), { level: 6 }).byteLength;
    const twoRankCompressedBytes = gzipSync(strToU8(twoRankJson), { level: 6 }).byteLength;

    console.info("taxonomy-storage-benchmark", {
      tips: storageTipCount,
      coreBytes: coreJson.length,
      oneRankBytes: oneRankJson.length,
      twoRankBytes: twoRankJson.length,
      coreCompressedBytes,
      oneRankCompressedBytes,
      twoRankCompressedBytes,
    });
    expect(oneRankCompressedBytes).toBeLessThan(coreCompressedBytes * 1.75);
    expect(twoRankCompressedBytes).toBeLessThan(coreCompressedBytes * 2.25);
  });

  test("retained hidden ranks do not degrade interactive panning", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => {
      const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
      return Boolean(
        state?.treeLoaded
        && !state?.loading
        && window.__BIG_TREE_VIEWER_CANVAS_TEST__
        && window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes?.length,
      );
    }, undefined, { timeout: 180_000 });

    const configureMap = async (includeOptionalRanks: boolean): Promise<void> => {
      await page.evaluate(async (withOptionalRanks) => {
        const app = window.__BIG_TREE_VIEWER_APP_TEST__;
        const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes ?? [];
        if (!app || leafNodes.length === 0) {
          throw new Error("Tree test controls are unavailable.");
        }
        const groupSize = Math.max(2, Math.ceil(leafNodes.length / 100));
        app.setTaxonomyMapForTest({
          version: 13,
          mappedCount: leafNodes.length,
          totalTips: leafNodes.length,
          activeRanks: withOptionalRanks
            ? ["subgenus", "tribe", "superfamily", "genus", "family", "order", "class", "phylum"]
            : ["genus", "family", "order", "class", "phylum"],
          tipRanks: leafNodes.map((node, index) => ({
            node,
            ranks: {
              phylum: `Phylum ${Math.floor(index / (groupSize * 20))}`,
              class: `Class ${Math.floor(index / (groupSize * 10))}`,
              order: `Order ${Math.floor(index / (groupSize * 5))}`,
              family: `Family ${Math.floor(index / (groupSize * 2))}`,
              genus: `Genus ${Math.floor(index / groupSize)}`,
              ...(withOptionalRanks ? {
                superfamily: `Superfamily ${Math.floor(index / (groupSize * 3))}`,
                tribe: `Tribe ${Math.floor(index / groupSize)}`,
                subgenus: `Subgenus ${Math.floor(index / Math.max(2, Math.ceil(groupSize / 2)))}`,
              } : {}),
            },
          })),
        });
        app.setShowGenusLabels(false);
        app.setViewMode("circular");
        window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }, includeOptionalRanks);
    };

    const pan = async (label: string): Promise<{ drawTotalMsP95: number; frameDeltaMsP95: number }> => {
      await page.evaluate((benchmarkLabel) => {
        window.__BIG_TREE_VIEWER_CANVAS_TEST__?.startPanBenchmark(benchmarkLabel);
      }, label);
      const center = await page.evaluate(() => {
        const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
        if (!camera || camera.kind !== "circular") {
          throw new Error("Circular camera unavailable.");
        }
        return { x: Number(camera.translateX), y: Number(camera.translateY) };
      });
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      await page.mouse.move(center.x + 180, center.y + 90, { steps: 24 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      const result = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.stopPanBenchmark?.());
      return {
        drawTotalMsP95: Number(result?.drawTotalMsP95 ?? Number.POSITIVE_INFINITY),
        frameDeltaMsP95: Number(result?.frameDeltaMsP95 ?? Number.POSITIVE_INFINITY),
      };
    };

    await configureMap(false);
    await pan("core-warmup");
    const core = await pan("core-ranks");
    await configureMap(true);
    await pan("retained-warmup");
    const retained = await pan("retained-hidden-ranks");

    console.info("taxonomy-pan-benchmark", {
      tips: await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes?.length ?? 0),
      core,
      retained,
    });
    expect(retained.drawTotalMsP95).toBeLessThan(core.drawTotalMsP95 * 2 + 8);
    expect(retained.frameDeltaMsP95).toBeLessThan(core.frameDeltaMsP95 * 2 + 12);
  });
});
