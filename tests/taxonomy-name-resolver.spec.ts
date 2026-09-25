import { expect, test } from "@playwright/test";
import {
  addTaxonomyIndexEntry,
  candidateSpeciesNames,
  enrichTaxonomyMapRanks,
  extractNcbiTaxId,
  extractNcbiTaxIdSuffix,
  mapTipsWithContext,
  normalizeTaxonomyName,
  type ParsedTaxonomyForMapping,
  type TaxonomyNodeInfo,
} from "../src/lib/taxonomyNameResolver";
import { filterTaxonomyMapToRanks } from "../src/lib/taxonomyActiveRanks";
import { DEFAULT_TAXONOMY_RANKS, type TaxonomyRank } from "../src/types/taxonomy";

const TARGET_RANKS: TaxonomyRank[] = ["genus", "family", "order", "class", "phylum", "superkingdom"];

function buildParsedTaxonomy(): ParsedTaxonomyForMapping {
  const nodes = new Map<number, TaxonomyNodeInfo>();
  const rankNames = new Map<number, string>();
  const speciesIndex = new Map<string, number[]>();
  const genusIndex = new Map<string, number[]>();
  const namedTaxonIndex = new Map<string, number[]>();

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
  addNode(140, 14, "subgenus", "Felis (Felis)");
  addNode(15, 140, "species");
  addNode(16, 13, "genus", "Panthera");
  addNode(160, 16, "subgenus", "Panthera (Panthera)");
  addNode(17, 160, "species");

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
  addTaxonomyIndexEntry(namedTaxonIndex, "felis", 14);
  addTaxonomyIndexEntry(namedTaxonIndex, "panthera", 16);
  addTaxonomyIndexEntry(namedTaxonIndex, "rosaceae", 23);
  addTaxonomyIndexEntry(namedTaxonIndex, "rosa", 24);
  addTaxonomyIndexEntry(namedTaxonIndex, "malus", 26);

  return { nodes, rankNames, speciesIndex, genusIndex, namedTaxonIndex };
}

test("species-name candidates support leading binomials with trailing identifiers", async () => {
  expect(candidateSpeciesNames("Homo_sapiens_HBB_isoform_2")).toEqual([
    "homo sapiens hbb isoform 2",
    "homo sapiens",
  ]);
  expect(candidateSpeciesNames("'Homo sapiens voucher 17'")).toEqual([
    "homo sapiens voucher 17",
    "homo sapiens",
  ]);
  expect(candidateSpeciesNames('"Homo_sapiens_sample-A"')).toEqual([
    "homo sapiens sample-a",
    "homo sapiens",
  ]);
});

test("NCBI TaxIDs support explicit suffixes and complete TaxID labels", async () => {
  expect(extractNcbiTaxIdSuffix("sequence_1_taxid_9606")).toBe(9606);
  expect(extractNcbiTaxIdSuffix("sequence_1_tx9606")).toBe(9606);
  expect(extractNcbiTaxIdSuffix("sequence_1_tx_9606")).toBe(9606);
  expect(extractNcbiTaxIdSuffix("sequence_1|taxid=9606")).toBe(9606);
  expect(extractNcbiTaxIdSuffix("sequence_taxid_9606_extra")).toBeNull();
  expect(extractNcbiTaxIdSuffix("sequence_9606")).toBeNull();
  expect(extractNcbiTaxIdSuffix("sequence_taxid_0")).toBeNull();
  expect(extractNcbiTaxId("taxid=9606")).toBe(9606);
  expect(extractNcbiTaxId("tax_id:9606")).toBe(9606);
  expect(extractNcbiTaxId("tx9606")).toBe(9606);
  expect(extractNcbiTaxId("9606")).toBe(9606);
  expect(extractNcbiTaxId("'Tax ID 9606'")).toBe(9606);
});

test("resolver maps direct NCBI TaxIDs without falling back to tip names", async () => {
  const taxonomy = buildParsedTaxonomy();
  const payload = mapTipsWithContext([
    { node: 610, name: "unrelated_gene_identifier_taxid_17" },
    { node: 611, name: "Malus_domestica_without_a_taxid" },
    { node: 612, name: "another_identifier|taxid=27" },
    { node: 613, name: "unknown_taxid_999999" },
    { node: 614, name: "taxid=15" },
    { node: 615, name: "27" },
  ], taxonomy, TARGET_RANKS, 99, { identifierMode: "ncbi-taxid" });

  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));
  expect(payload.identifierMode).toBe("ncbi-taxid");
  expect(payload.mappedCount).toBe(4);
  expect(byNode.get(610)?.ranks.genus).toBe("Panthera");
  expect(byNode.get(612)?.ranks.genus).toBe("Malus");
  expect(byNode.has(611)).toBe(false);
  expect(byNode.has(613)).toBe(false);
  expect(byNode.get(614)?.ranks.genus).toBe("Felis");
  expect(byNode.get(615)?.ranks.genus).toBe("Malus");
});

test("optional ranks are added on demand without remapping existing tips", async () => {
  const taxonomy = buildParsedTaxonomy();
  const payload = mapTipsWithContext([
    { node: 620, name: "first_taxid_15" },
    { node: 621, name: "second_taxid_15" },
    { node: 622, name: "third_taxid_17" },
    { node: 623, name: "fourth_taxid_17" },
  ], taxonomy, [...DEFAULT_TAXONOMY_RANKS], 100, { identifierMode: "ncbi-taxid" });

  const originalTips = structuredClone(payload.tipRanks);
  expect(payload.resolvedRanks).toEqual(DEFAULT_TAXONOMY_RANKS);
  expect(payload.tipRanks.every((tip) => tip.ranks.subgenus === undefined)).toBe(true);
  expect(payload.tipRanks.map((tip) => tip.sourceTaxId)).toEqual([15, 15, 17, 17]);

  const enriched = enrichTaxonomyMapRanks(payload, taxonomy, ["subgenus"], 101);

  expect(enriched.activeRanks).toContain("subgenus");
  expect(enriched.resolvedRanks).toEqual([...DEFAULT_TAXONOMY_RANKS, "subgenus"]);
  expect(enriched.tipRanks.map((tip) => tip.ranks.subgenus)).toEqual([
    "Felis (Felis)",
    "Felis (Felis)",
    "Panthera (Panthera)",
    "Panthera (Panthera)",
  ]);
  expect(filterTaxonomyMapToRanks(enriched, DEFAULT_TAXONOMY_RANKS)?.tipRanks).toEqual(originalTips);
});

test("resolver maps leading species names before gene or specimen identifiers", async () => {
  const taxonomy = buildParsedTaxonomy();
  const payload = mapTipsWithContext([
    { node: 600, name: "Panthera_leo_HBB_isoform_2" },
    { node: 601, name: "'Malus domestica voucher 17'" },
    { node: 602, name: '"Panthera_leo_sample-A"' },
  ], taxonomy, TARGET_RANKS, 99);

  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));
  expect(payload.mappedCount).toBe(3);
  expect(byNode.get(600)?.ranks.genus).toBe("Panthera");
  expect(byNode.get(601)?.ranks.genus).toBe("Malus");
  expect(byNode.get(602)?.ranks.family).toBe("Felidae");
});

test("an exact full species label takes precedence over its leading binomial fallback", async () => {
  const taxonomy = buildParsedTaxonomy();
  addTaxonomyIndexEntry(taxonomy.speciesIndex, "panthera leo persica", 27);

  const payload = mapTipsWithContext([
    { node: 700, name: "Panthera leo persica" },
  ], taxonomy, TARGET_RANKS, 99);

  expect(payload.mappedCount).toBe(1);
  expect(payload.tipRanks[0]?.ranks.genus).toBe("Malus");
  expect(payload.tipRanks[0]?.ranks.family).toBe("Rosaceae");
});

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

test("optional broad-rank guard rejects a small phylum run embedded in another phylum", async () => {
  const taxonomy = buildParsedTaxonomy();
  addTaxonomyIndexEntry(taxonomy.speciesIndex, "felis catus", 15);
  addTaxonomyIndexEntry(taxonomy.speciesIndex, "rosa canina", 25);

  const payload = mapTipsWithContext([
    { node: 210, name: "Panthera leo" },
    { node: 211, name: "Rosa canina" },
    { node: 212, name: "Felis catus" },
  ], taxonomy, TARGET_RANKS, 99, { rejectEmbeddedBroadRankRuns: true });

  expect(payload.tipRanks.map((tip) => tip.node)).toEqual([210, 212]);
});

test("broad-rank guard preserves ordinary adjacent phylum blocks", async () => {
  const taxonomy = buildParsedTaxonomy();
  addTaxonomyIndexEntry(taxonomy.speciesIndex, "felis catus", 15);
  addTaxonomyIndexEntry(taxonomy.speciesIndex, "rosa canina", 25);

  const payload = mapTipsWithContext([
    { node: 220, name: "Panthera leo" },
    { node: 221, name: "Felis catus" },
    { node: 222, name: "Rosa canina" },
    { node: 223, name: "Malus domestica" },
  ], taxonomy, TARGET_RANKS, 99, { rejectEmbeddedBroadRankRuns: true });

  expect(payload.mappedCount).toBe(4);
});

test("species synonym matches win before a conflicting genus fallback", async () => {
  const nodes = new Map<number, TaxonomyNodeInfo>();
  const rankNames = new Map<number, string>();
  const speciesIndex = new Map<string, number[]>();
  const genusIndex = new Map<string, number[]>();
  const namedTaxonIndex = new Map<string, number[]>();

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
  addTaxonomyIndexEntry(namedTaxonIndex, "sclerotium", 24);

  const payload = mapTipsWithContext([
    { node: 300, name: "Sclerotium perniciosum" },
  ], { nodes, rankNames, speciesIndex, genusIndex, namedTaxonIndex }, TARGET_RANKS, 99);

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
  const namedTaxonIndex = new Map<string, number[]>();

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
  addTaxonomyIndexEntry(namedTaxonIndex, "testudo", 13);
  addTaxonomyIndexEntry(namedTaxonIndex, "mysteria", 22);

  const payload = mapTipsWithContext([
    { node: 400, name: "Testudo graeca" },
    { node: 401, name: "Mysteria obscura" },
  ], { nodes, rankNames, speciesIndex, genusIndex, namedTaxonIndex }, TARGET_RANKS, 99);

  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));
  expect(byNode.get(400)?.ranks.class).toBeUndefined();
  expect(byNode.get(400)?.collapseFallbacks?.class?.label).toBe("Testudines");
  expect(byNode.get(400)?.collapseFallbacks?.class?.rank).toBe("order");
  expect(byNode.get(401)?.ranks.class).toBeUndefined();
  expect(byNode.get(401)?.collapseFallbacks?.class?.label).toBe("Chelonoidea");
  expect(byNode.get(401)?.collapseFallbacks?.class?.rank).toBe("superfamily");
});

test("single-token higher-rank tip labels map by exact NCBI taxon name", async () => {
  const taxonomy = buildParsedTaxonomy();
  const payload = mapTipsWithContext([
    { node: 500, name: "Rosaceae" },
  ], taxonomy, TARGET_RANKS, 99);

  expect(payload.mappedCount).toBe(1);
  const mapped = payload.tipRanks[0];
  expect(mapped?.ranks.family).toBe("Rosaceae");
  expect(mapped?.ranks.order).toBe("Rosales");
  expect(mapped?.ranks.phylum).toBe("Tracheophyta");
  expect(mapped?.ranks.genus).toBeUndefined();
});
