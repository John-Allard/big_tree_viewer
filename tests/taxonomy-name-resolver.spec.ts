import { expect, test } from "@playwright/test";
import {
  addTaxonomyIndexEntry,
  mapTipsWithContext,
  normalizeTaxonomyName,
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

test("species synonym matches win before a conflicting genus fallback", async () => {
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

  addNode(10, 2, "phylum", "Ascomycota");
  addNode(11, 10, "class", "Leotiomycetes");
  addNode(12, 11, "order", "Helotiales");
  addNode(13, 12, "family", "Sclerotiniaceae");
  addNode(14, 13, "species");

  addNode(20, 2, "phylum", "Basidiomycota");
  addNode(21, 20, "class", "Agaricomycetes");
  addNode(22, 21, "order", "Agaricales");
  addNode(23, 22, "family", "Typhulaceae");
  addNode(24, 23, "genus", "Sclerotium");

  addTaxonomyIndexEntry(speciesIndex, normalizeTaxonomyName("[Sclerotium] perniciosum"), 14);
  addTaxonomyIndexEntry(speciesIndex, normalizeTaxonomyName("Sclerotium perniciosum"), 14);
  addTaxonomyIndexEntry(genusIndex, "sclerotium", 24);

  const payload = mapTipsWithContext([
    { node: 300, name: "Sclerotium perniciosum" },
  ], { nodes, rankNames, speciesIndex, genusIndex }, TARGET_RANKS, 99);

  expect(payload.mappedCount).toBe(1);
  expect(payload.tipRanks).toHaveLength(1);
  expect(payload.tipRanks[0]?.ranks.phylum).toBe("Ascomycota");
  expect(payload.tipRanks[0]?.ranks.class).toBe("Leotiomycetes");
  expect(payload.tipRanks[0]?.ranks.order).toBe("Helotiales");
  expect(payload.tipRanks[0]?.ranks.family).toBe("Sclerotiniaceae");
  expect(payload.tipRanks[0]?.ranks.genus).toBeUndefined();
});

test("resolver records best lower-rank fallbacks for missing collapse ranks", async () => {
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
  addNode(11, 10, "order", "Testudines");
  addNode(12, 11, "family", "Testudinidae");
  addNode(13, 12, "genus", "Testudo");
  addNode(14, 13, "species");

  addNode(20, 2, "phylum", "Chordata");
  addNode(21, 20, "superfamily", "Chelonoidea");
  addNode(22, 21, "genus", "Mysteria");
  addNode(23, 22, "species");

  addTaxonomyIndexEntry(speciesIndex, "testudo graeca", 14);
  addTaxonomyIndexEntry(speciesIndex, "testudo_graeca", 14);
  addTaxonomyIndexEntry(speciesIndex, "mysteria obscura", 23);
  addTaxonomyIndexEntry(speciesIndex, "mysteria_obscura", 23);
  addTaxonomyIndexEntry(genusIndex, "testudo", 13);
  addTaxonomyIndexEntry(genusIndex, "mysteria", 22);

  const payload = mapTipsWithContext([
    { node: 400, name: "Testudo graeca" },
    { node: 401, name: "Mysteria obscura" },
  ], { nodes, rankNames, speciesIndex, genusIndex }, TARGET_RANKS, 99);

  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));
  expect(byNode.get(400)?.ranks.class).toBeUndefined();
  expect(byNode.get(400)?.collapseFallbacks?.class?.label).toBe("Testudines");
  expect(byNode.get(400)?.collapseFallbacks?.class?.rank).toBe("order");
  expect(byNode.get(401)?.ranks.class).toBeUndefined();
  expect(byNode.get(401)?.collapseFallbacks?.class?.label).toBe("Chelonoidea");
  expect(byNode.get(401)?.collapseFallbacks?.class?.rank).toBe("superfamily");
});
