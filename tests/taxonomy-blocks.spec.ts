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
