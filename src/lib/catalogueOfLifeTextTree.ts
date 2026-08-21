import {
  addTaxonomyIndexEntry,
  candidateExactTaxonName,
  candidateSpeciesNames,
  extractGenus,
  extractSpeciesEpithet,
  mapTipsWithContext,
  normalizeTaxonomyName,
  TAXONOMY_NAMED_LINEAGE_RANKS,
  type ParsedTaxonomyForMapping,
  type TipTaxonomyRequest,
} from "./taxonomyNameResolver";
import type { TaxonomyMapPayload, TaxonomyRank } from "../types/taxonomy";

const TARGET_RANKS: TaxonomyRank[] = ["genus", "family", "order", "class", "phylum", "superkingdom"];
const COL_MAPPING_VERSION = 2;

interface LineageEntry {
  rank: string;
  mappedRank: string;
  label: string;
  taxId: number | null;
}

export interface CatalogueOfLifeTextTreeParser {
  consumeLine: (line: string) => void;
  finish: () => TaxonomyMapPayload;
  parsedLineCount: () => number;
}

function mappedRank(rank: string): string {
  return rank === "domain" ? "superkingdom" : rank;
}

function isSpeciesLevel(rank: string): boolean {
  return rank === "species"
    || rank === "subspecies"
    || rank === "varietas"
    || rank === "forma";
}

function higherTaxonLabel(recordText: string): string {
  const trimmed = recordText.trim();
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace < 0) {
    return trimmed;
  }
  const first = trimmed.slice(0, firstSpace);
  if (first.toLowerCase() === "candidatus") {
    const rest = trimmed.slice(firstSpace + 1).trimStart();
    const secondSpace = rest.indexOf(" ");
    return secondSpace < 0 ? `${first} ${rest}` : `${first} ${rest.slice(0, secondSpace)}`;
  }
  return first;
}

function withoutParenthesizedSubgenus(recordText: string): string {
  return recordText.replace(/^(\S+)\s+\([^)]*\)\s+/, "$1 ");
}

function parseTextTreeLine(line: string): {
  depth: number;
  synonym: boolean;
  rank: string;
  recordText: string;
} | null {
  let leadingSpaces = 0;
  while (leadingSpaces < line.length && line.charCodeAt(leadingSpaces) === 32) {
    leadingSpaces += 1;
  }
  let recordText = line.slice(leadingSpaces).trimEnd();
  if (!recordText) {
    return null;
  }
  const synonym = recordText.startsWith("=");
  if (synonym) {
    recordText = recordText.slice(1);
  }
  recordText = recordText.replace(/^(?:\?|\u2020)+\s*/, "");
  const rankMatch = recordText.match(/\s\[([^\]]+)\]$/);
  if (!rankMatch || rankMatch.index === undefined) {
    return null;
  }
  const rank = rankMatch[1].trim().toLowerCase();
  return {
    depth: Math.floor(leadingSpaces / 2),
    synonym,
    rank,
    recordText: recordText.slice(0, rankMatch.index).trimEnd(),
  };
}

export function createCatalogueOfLifeTextTreeParser(
  tips: TipTaxonomyRequest[],
  lowMemoryMode = false,
): CatalogueOfLifeTextTreeParser {
  const nodes: ParsedTaxonomyForMapping["nodes"] = new Map([[1, { parentId: 1, rank: "no rank" }]]);
  const rankNames: ParsedTaxonomyForMapping["rankNames"] = new Map();
  const speciesIndex: ParsedTaxonomyForMapping["speciesIndex"] = new Map();
  const speciesEpithetIndex: NonNullable<ParsedTaxonomyForMapping["speciesEpithetIndex"]> = new Map();
  const genusIndex: ParsedTaxonomyForMapping["genusIndex"] = new Map();
  const namedTaxonIndex: ParsedTaxonomyForMapping["namedTaxonIndex"] = new Map();
  const speciesNames = new Set<string>();
  const speciesEpithets = new Set<string>();
  const genera = new Set<string>();
  const namedTaxa = new Set<string>();
  let maxSpeciesNameTokens = 2;

  for (const tip of tips) {
    for (const candidate of candidateSpeciesNames(tip.name)) {
      speciesNames.add(candidate);
      maxSpeciesNameTokens = Math.max(maxSpeciesNameTokens, candidate.split(" ").length);
    }
    const epithet = extractSpeciesEpithet(tip.name);
    if (epithet) {
      speciesEpithets.add(epithet);
    }
    const genus = extractGenus(tip.name);
    if (genus) {
      genera.add(genus);
    }
    const namedTaxon = candidateExactTaxonName(tip.name);
    if (namedTaxon) {
      namedTaxa.add(namedTaxon);
    }
  }

  const lineage: LineageEntry[] = [];
  let nextTaxId = 2;
  let lineCount = 0;
  const prefixTokenLimit = Math.min(8, maxSpeciesNameTokens);

  const ensureLineageIds = (): number => {
    let parentId = 1;
    for (const entry of lineage) {
      if (!TAXONOMY_NAMED_LINEAGE_RANKS.has(entry.mappedRank)) {
        continue;
      }
      if (entry.taxId === null) {
        entry.taxId = nextTaxId;
        nextTaxId += 1;
      }
      nodes.set(entry.taxId, { parentId, rank: entry.mappedRank });
      rankNames.set(entry.taxId, entry.label);
      parentId = entry.taxId;
    }
    return parentId;
  };

  const matchingSpeciesPrefixes = (recordText: string, rank: string): string[] => {
    const tokens = normalizeTaxonomyName(withoutParenthesizedSubgenus(recordText)).split(" ").filter(Boolean);
    const matches: string[] = [];
    let prefix = "";
    for (let index = 0; index < Math.min(tokens.length, prefixTokenLimit); index += 1) {
      prefix = index === 0 ? tokens[index] : `${prefix} ${tokens[index]}`;
      const taxonTokenCount = index + 1;
      const minimumTaxonTokens = rank === "species"
        ? (tokens[0] === "candidatus" ? 3 : 2)
        : (tokens[0] === "candidatus" ? 4 : 3);
      if (taxonTokenCount >= minimumTaxonTokens && speciesNames.has(prefix)) {
        matches.push(prefix);
      }
    }
    return matches;
  };

  return {
    consumeLine(line: string): void {
      lineCount += 1;
      const parsed = parseTextTreeLine(line);
      if (!parsed) {
        return;
      }
      const speciesMatches = isSpeciesLevel(parsed.rank)
        ? matchingSpeciesPrefixes(parsed.recordText, parsed.rank)
        : [];
      const speciesEpithet = parsed.rank === "species"
        ? extractSpeciesEpithet(withoutParenthesizedSubgenus(parsed.recordText))
        : "";
      const shouldIndexSpeciesEpithet = speciesEpithets.has(speciesEpithet);
      const genusMatch = parsed.rank === "genus" ? higherTaxonLabel(parsed.recordText) : "";
      const normalizedGenusMatch = normalizeTaxonomyName(genusMatch);

      if (parsed.synonym) {
        if (
          lineage.length === 0
          || (speciesMatches.length === 0 && !genera.has(normalizedGenusMatch) && !shouldIndexSpeciesEpithet)
        ) {
          return;
        }
        const acceptedTaxId = ensureLineageIds();
        for (const match of speciesMatches) {
          addTaxonomyIndexEntry(speciesIndex, match, acceptedTaxId);
        }
        if (shouldIndexSpeciesEpithet) {
          addTaxonomyIndexEntry(speciesEpithetIndex, speciesEpithet, acceptedTaxId);
        }
        if (parsed.rank === "genus" && genera.has(normalizedGenusMatch)) {
          addTaxonomyIndexEntry(genusIndex, normalizedGenusMatch, acceptedTaxId);
        }
        const synonymLabel = higherTaxonLabel(parsed.recordText);
        const normalizedSynonymLabel = normalizeTaxonomyName(synonymLabel);
        if (!isSpeciesLevel(parsed.rank) && namedTaxa.has(normalizedSynonymLabel)) {
          addTaxonomyIndexEntry(namedTaxonIndex, normalizedSynonymLabel, acceptedTaxId);
        }
        return;
      }

      lineage.length = Math.min(lineage.length, parsed.depth);
      const label = higherTaxonLabel(parsed.recordText);
      lineage.push({
        rank: parsed.rank,
        mappedRank: mappedRank(parsed.rank),
        label,
        taxId: null,
      });

      const normalizedLabel = normalizeTaxonomyName(label);
      const shouldIndexNamedTaxon = !isSpeciesLevel(parsed.rank) && namedTaxa.has(normalizedLabel);
      const shouldIndexGenus = parsed.rank === "genus" && genera.has(normalizedLabel);
      if (speciesMatches.length === 0 && !shouldIndexSpeciesEpithet && !shouldIndexGenus && !shouldIndexNamedTaxon) {
        return;
      }
      const taxId = ensureLineageIds();
      for (const match of speciesMatches) {
        addTaxonomyIndexEntry(speciesIndex, match, taxId);
      }
      if (shouldIndexSpeciesEpithet) {
        addTaxonomyIndexEntry(speciesEpithetIndex, speciesEpithet, taxId);
      }
      if (shouldIndexGenus) {
        addTaxonomyIndexEntry(genusIndex, normalizedLabel, taxId);
      }
      if (shouldIndexNamedTaxon) {
        addTaxonomyIndexEntry(namedTaxonIndex, normalizedLabel, taxId);
      }
    },
    finish(): TaxonomyMapPayload {
      const taxonomy: ParsedTaxonomyForMapping = {
        nodes,
        rankNames,
        speciesIndex,
        speciesEpithetIndex,
        genusIndex,
        namedTaxonIndex,
      };
      return mapTipsWithContext(tips, taxonomy, TARGET_RANKS, COL_MAPPING_VERSION, {
        enableCollapseFallbacks: !lowMemoryMode,
        rejectEmbeddedBroadRankRuns: true,
      });
    },
    parsedLineCount(): number {
      return lineCount;
    },
  };
}
