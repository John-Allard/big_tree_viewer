export const TAXONOMY_COLOR_PALETTES = {
  classic: {
    label: "Classic spectrum",
    colors: [] as string[],
  },
  okabeIto: {
    label: "Okabe-Ito",
    colors: [
      "#0072b2",
      "#e69f00",
      "#009e73",
      "#d55e00",
      "#cc79a7",
      "#56b4e9",
      "#f0e442",
      "#000000",
    ],
  },
  tableau: {
    label: "Tableau",
    colors: [
      "#4e79a7",
      "#f28e2b",
      "#59a14f",
      "#e15759",
      "#76b7b2",
      "#edc948",
      "#b07aa1",
      "#ff9da7",
      "#9c755f",
      "#bab0ac",
    ],
  },
  scholarly: {
    label: "Scholarly muted",
    colors: [
      "#4c78a8",
      "#72b7b2",
      "#f58518",
      "#54a24b",
      "#eeca3b",
      "#b279a2",
      "#ff9da6",
      "#9d755d",
      "#8cd17d",
      "#b6992d",
    ],
  },
  botanical: {
    label: "Botanical",
    colors: [
      "#2f6f4e",
      "#5bbf9d",
      "#b4d66d",
      "#e6b655",
      "#d97c45",
      "#a83f5f",
      "#6d4c8d",
      "#4f7fbf",
      "#7bc8d6",
      "#8f6a3f",
    ],
  },
  ocean: {
    label: "Ocean and coral",
    colors: [
      "#245e8f",
      "#2a9d8f",
      "#8ab17d",
      "#e9c46a",
      "#f4a261",
      "#e76f51",
      "#bc5090",
      "#58508d",
      "#00a6d6",
      "#7a5195",
    ],
  },
  custom: {
    label: "Custom",
    colors: [] as string[],
  },
} as const;

export type TaxonomyColorPaletteKey = keyof typeof TAXONOMY_COLOR_PALETTES;

export const DEFAULT_TAXONOMY_COLOR_PALETTE: TaxonomyColorPaletteKey = "classic";

export const TAXONOMY_COLOR_PALETTE_KEYS = Object.keys(TAXONOMY_COLOR_PALETTES) as TaxonomyColorPaletteKey[];

export function isTaxonomyColorPaletteKey(value: unknown): value is TaxonomyColorPaletteKey {
  return typeof value === "string" && value in TAXONOMY_COLOR_PALETTES;
}

export function parseCustomTaxonomyPalette(value: string): string[] {
  const seen = new Set<string>();
  const colors: string[] = [];
  const matches = value.match(/#(?:[\da-f]{3}|[\da-f]{6})\b/gi) ?? [];
  for (let index = 0; index < matches.length; index += 1) {
    const raw = matches[index].toLowerCase();
    const color = raw.length === 4
      ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
      : raw;
    if (!seen.has(color)) {
      seen.add(color);
      colors.push(color);
    }
  }
  return colors;
}
