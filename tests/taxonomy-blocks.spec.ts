import { expect, test } from "@playwright/test";
import { buildTaxonomyColorMap } from "../src/components/TreeCanvas";
import { buildTaxonomyBlocksForOrderedLeaves } from "../src/lib/taxonomyBlocks";
import type { TaxonomyMapPayload } from "../src/types/taxonomy";

function coveredIndices(startIndex: number, endIndex: number, leafCount: number): number[] {
  const end = endIndex >= startIndex ? endIndex : endIndex + leafCount;
  return Array.from({ length: end - startIndex }, (_, offset) => (startIndex + offset) % leafCount);
}

test("polyphyletic taxa produce exact non-overlapping blocks for every contiguous chunk", () => {
  const orderedLeaves = Array.from({ length: 12 }, (_, index) => index);
  const familyByIndex = [
    "FamilyA", "FamilyA",
    "FamilyB", "FamilyB",
    "FamilyA", "FamilyA",
    "FamilyC", "FamilyC", "FamilyC", "FamilyC",
    "FamilyA", "FamilyA",
  ];
  const taxonomyMap: TaxonomyMapPayload = {
    mappedCount: orderedLeaves.length,
    totalTips: orderedLeaves.length,
    activeRanks: ["family"],
    tipRanks: orderedLeaves.map((node) => ({
      node,
      ranks: { family: familyByIndex[node] },
    })),
  };

  const blocks = buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, taxonomyMap, null).family;
  const familyABlocks = blocks.filter((block) => block.label === "FamilyA");
  expect(familyABlocks).toHaveLength(2);
  expect(familyABlocks.map((block) => [block.startIndex, block.endIndex])).toEqual([
    [4, 6],
    [10, 2],
  ]);
  expect(familyABlocks.every((block) => block.segments?.length === 1)).toBe(true);

  const owners = Array.from({ length: orderedLeaves.length }, () => [] as string[]);
  for (const block of blocks) {
    for (const index of coveredIndices(block.startIndex ?? 0, block.endIndex ?? 0, orderedLeaves.length)) {
      owners[index].push(block.label);
    }
  }
  expect(owners).toEqual(familyByIndex.map((family) => [family]));
});

test("short unmapped runs inherit a taxonomy ribbon from matching neighbors", () => {
  const orderedLeaves = [0, 1, 2, 3, 4];
  const taxonomyMap: TaxonomyMapPayload = {
    mappedCount: 4,
    totalTips: 5,
    activeRanks: ["family"],
    tipRanks: orderedLeaves
      .filter((node) => node !== 2)
      .map((node) => ({ node, ranks: { family: "FamilyA" }, taxIds: { family: 101 } })),
  };

  const blocks = buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, taxonomyMap, null).family;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ label: "FamilyA", startIndex: 0, endIndex: 5 });
});

test("long interior unmapped runs inherit from matching taxonomy anchors", () => {
  const orderedLeaves = Array.from({ length: 100 }, (_, node) => node);
  const taxonomyMap: TaxonomyMapPayload = {
    mappedCount: 2,
    totalTips: orderedLeaves.length,
    activeRanks: ["class"],
    tipRanks: [
      { node: 0, ranks: { class: "Insecta" }, taxIds: { class: 50557 } },
      { node: 99, ranks: { class: "Insecta" }, taxIds: { class: 50557 } },
    ],
  };

  const blocks = buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, taxonomyMap, null).class;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ label: "Insecta", startIndex: 0, endIndex: 100 });
});

test("large unmapped runs across the circular seam remain uninferred", () => {
  const orderedLeaves = Array.from({ length: 10 }, (_, node) => node);
  const taxonomyMap: TaxonomyMapPayload = {
    mappedCount: 2,
    totalTips: orderedLeaves.length,
    activeRanks: ["class"],
    tipRanks: [
      { node: 2, ranks: { class: "Insecta" }, taxIds: { class: 50557 } },
      { node: 7, ranks: { class: "Insecta" }, taxIds: { class: 50557 } },
    ],
  };

  const blocks = buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, taxonomyMap, null).class;
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ label: "Insecta", startIndex: 2, endIndex: 8 });
});

test("mapped taxonomic interlopers remain separate contiguous ribbon chunks", () => {
  const orderedLeaves = [0, 1, 2, 3, 4];
  const taxonomyMap: TaxonomyMapPayload = {
    mappedCount: 5,
    totalTips: 5,
    activeRanks: ["family"],
    tipRanks: orderedLeaves.map((node) => ({
      node,
      ranks: { family: node === 2 ? "FamilyB" : "FamilyA" },
    })),
  };

  const blocks = buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, taxonomyMap, null).family;
  expect(blocks.filter((block) => block.label === "FamilyA")).toHaveLength(1);
  expect(blocks.filter((block) => block.label === "FamilyB")).toHaveLength(1);
  const familyB = blocks.find((block) => block.label === "FamilyB");
  expect(familyB).toMatchObject({ startIndex: 2, endIndex: 3 });
});

test("unmapped runs between different taxa remain unpainted", () => {
  const orderedLeaves = [0, 1, 2, 3, 4];
  const taxonomyMap: TaxonomyMapPayload = {
    mappedCount: 4,
    totalTips: 5,
    activeRanks: ["family"],
    tipRanks: [
      { node: 0, ranks: { family: "FamilyA" } },
      { node: 1, ranks: { family: "FamilyA" } },
      { node: 3, ranks: { family: "FamilyB" } },
      { node: 4, ranks: { family: "FamilyB" } },
    ],
  };

  const blocks = buildTaxonomyBlocksForOrderedLeaves(orderedLeaves, taxonomyMap, null).family;
  expect(blocks).toHaveLength(2);
  expect(blocks.map((block) => [block.label, block.startIndex, block.endIndex])).toEqual([
    ["FamilyA", 0, 2],
    ["FamilyB", 3, 5],
  ]);
});

test("adjacent child taxa receive separated colors inherited from one parent", () => {
  const families = ["FamilyA", "FamilyA", "FamilyB", "FamilyB", "FamilyA", "FamilyA", "FamilyC", "FamilyC", "FamilyD", "FamilyD", "FamilyE", "FamilyE"];
  const taxonomyMap: TaxonomyMapPayload = {
    mappedCount: families.length,
    totalTips: families.length,
    activeRanks: ["family", "order"],
    tipRanks: families.map((family, node) => ({
      node,
      ranks: { order: "Perciformes", family },
    })),
  };
  const colors = buildTaxonomyColorMap(taxonomyMap, new Map(), 1, "classic", [], "order", "family");
  const familyColors = ["FamilyA", "FamilyB", "FamilyC", "FamilyD", "FamilyE"].map((family) => colors.family?.[family] ?? "");

  expect(new Set(familyColors).size).toBe(familyColors.length);
  const hues = familyColors.map((color) => {
    const match = /^hsl\(([-\d.]+)deg/.exec(color);
    return match ? Number(match[1]) : Number.NaN;
  });
  expect(hues.every(Number.isFinite)).toBe(true);
  for (let index = 1; index < hues.length; index += 1) {
    const difference = Math.abs(hues[index] - hues[index - 1]);
    expect(Math.min(difference, 360 - difference)).toBeGreaterThan(8);
  }
});
