import { expect, test } from "@playwright/test";
import {
  addTaxonomyIndexEntry,
  mapTipsWithContext,
  type ParsedTaxonomyForMapping,
  type TaxonomyNodeInfo,
} from "../src/lib/taxonomyNameResolver";
import type { TaxonomyRank } from "../src/types/taxonomy";

const TARGET_RANKS: TaxonomyRank[] = ["genus", "family", "order", "class", "phylum", "superkingdom"];

function buildParsedTaxonomy(): ParsedTaxonomyForMapping {
  const nodes = new Map<number, TaxonomyNodeInfo>();
  const rankNames = new Map<number, string>();
  const speciesIndex = new Map<string, number[]>();
  const genusIndex = new Map<string, number[]>();

  const addNode = (taxId: number, parentId: number, rank: string, name?: string): void => {
    nodes.set(taxId, { parentId, rank });
    if (name) {
      rankNames.set(taxId, name);
    }
  };

  addNode(1, 1, "no rank");
  addNode(2, 1, "superkingdom", "Eukaryota");

  addNode(10, 2, "phylum", "Chordata");
  addNode(11, 10, "class", "Mammalia");
  addNode(12, 11, "order", "Carnivora");
  addNode(13, 12, "family", "Felidae");
  addNode(14, 13, "genus", "Felis");
  addNode(15, 14, "species");
  addNode(16, 13, "genus", "Panthera");
  addNode(17, 16, "species");

  addNode(20, 2, "phylum", "Tracheophyta");
  addNode(21, 20, "class", "Magnoliopsida");
  addNode(22, 21, "order", "Rosales");
  addNode(23, 22, "family", "Rosaceae");
  addNode(24, 23, "genus", "Rosa");
  addNode(25, 24, "species");
  addNode(26, 23, "genus", "Malus");
  addNode(27, 26, "species");

  addTaxonomyIndexEntry(speciesIndex, "duplicata communis", 15);
  addTaxonomyIndexEntry(speciesIndex, "duplicata_communis", 15);
  addTaxonomyIndexEntry(speciesIndex, "duplicata communis", 25);
  addTaxonomyIndexEntry(speciesIndex, "duplicata_communis", 25);
  addTaxonomyIndexEntry(speciesIndex, "panthera leo", 17);
  addTaxonomyIndexEntry(speciesIndex, "panthera_leo", 17);
  addTaxonomyIndexEntry(speciesIndex, "malus domestica", 27);
  addTaxonomyIndexEntry(speciesIndex, "malus_domestica", 27);
  addTaxonomyIndexEntry(genusIndex, "felis", 14);
  addTaxonomyIndexEntry(genusIndex, "panthera", 16);
  addTaxonomyIndexEntry(genusIndex, "rosa", 24);
  addTaxonomyIndexEntry(genusIndex, "malus", 26);

  return { nodes, rankNames, speciesIndex, genusIndex };
}

test("context-aware taxonomy resolver disambiguates reused species names by nearby mapped clades", async () => {
  const taxonomy = buildParsedTaxonomy();
  const payload = mapTipsWithContext([
    { node: 100, name: "Malus domestica" },
    { node: 101, name: "Duplicata communis" },
    { node: 102, name: "Rosa canina" },
    { node: 103, name: "Panthera leo" },
    { node: 104, name: "Duplicata communis" },
    { node: 105, name: "Felis catus" },
  ], taxonomy, TARGET_RANKS, 99);

  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));
  expect(byNode.get(101)?.ranks.family).toBe("Rosaceae");
  expect(byNode.get(101)?.ranks.genus).toBe("Rosa");
  expect(byNode.get(104)?.ranks.family).toBe("Felidae");
  expect(byNode.get(104)?.ranks.genus).toBe("Felis");
});

test("context-aware taxonomy resolver leaves cross-domain name collisions unmapped without context", async () => {
  const taxonomy = buildParsedTaxonomy();
  const payload = mapTipsWithContext([
    { node: 200, name: "Duplicata communis" },
  ], taxonomy, TARGET_RANKS, 99);

  expect(payload.mappedCount).toBe(0);
  expect(payload.tipRanks).toHaveLength(0);
});
