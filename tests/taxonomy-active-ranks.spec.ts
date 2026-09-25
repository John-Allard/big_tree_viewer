import { expect, test } from "@playwright/test";
import { filterTaxonomyMapToRanks } from "../src/lib/taxonomyActiveRanks";
import { DEFAULT_TAXONOMY_RANKS, type TaxonomyMapPayload } from "../src/types/taxonomy";

const enrichedMap: TaxonomyMapPayload = {
  version: 14,
  source: "ncbi",
  mappedCount: 2,
  totalTips: 2,
  resolvedRanks: [...DEFAULT_TAXONOMY_RANKS, "superfamily", "subgenus"],
  activeRanks: ["family", "genus", "subgenus"],
  tipRanks: [
    {
      node: 1,
      sourceTaxId: 101,
      ranks: { family: "A", genus: "A1", subgenus: "A1a", superfamily: "S" },
      taxIds: { family: 10, genus: 11, subgenus: 12, superfamily: 9 },
    },
    {
      node: 2,
      sourceTaxId: 102,
      ranks: { family: "A", genus: "A2", subgenus: "A2a", superfamily: "S" },
      taxIds: { family: 10, genus: 21, subgenus: 22, superfamily: 9 },
    },
  ],
};

test("serialized taxonomy maps retain only defaults and selected optional ranks", () => {
  const defaultsOnly = filterTaxonomyMapToRanks(enrichedMap, DEFAULT_TAXONOMY_RANKS);
  expect(defaultsOnly?.resolvedRanks).toEqual(DEFAULT_TAXONOMY_RANKS);
  expect(defaultsOnly?.tipRanks.every((tip) => tip.ranks.subgenus === undefined && tip.ranks.superfamily === undefined)).toBe(true);
  expect(defaultsOnly?.tipRanks.map((tip) => tip.sourceTaxId)).toEqual([101, 102]);

  const withSubgenus = filterTaxonomyMapToRanks(enrichedMap, [...DEFAULT_TAXONOMY_RANKS, "subgenus"]);
  expect(withSubgenus?.resolvedRanks).toEqual([...DEFAULT_TAXONOMY_RANKS, "subgenus"]);
  expect(withSubgenus?.tipRanks.map((tip) => tip.ranks.subgenus)).toEqual(["A1a", "A2a"]);
  expect(withSubgenus?.tipRanks.every((tip) => tip.ranks.superfamily === undefined)).toBe(true);
});
