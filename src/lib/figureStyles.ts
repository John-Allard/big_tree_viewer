export type FontFamilyKey = "plexSans" | "sourceSerif" | "jetbrainsMono" | "nunito";
export type LabelStyleClass =
  | "tip"
  | "genus"
  | "taxonomy"
  | "internalNode"
  | "bootstrap"
  | "nodeHeight"
  | "scale";

export interface LabelStyleSettings {
  fontFamily: FontFamilyKey;
  sizeScale: number;
  offsetPx: number;
}

export interface FigureStyleSettings {
  tip: LabelStyleSettings;
  genus: LabelStyleSettings;
  taxonomy: LabelStyleSettings;
  internalNode: LabelStyleSettings;
  bootstrap: LabelStyleSettings;
  nodeHeight: LabelStyleSettings;
  scale: LabelStyleSettings;
}

export const FONT_FAMILY_OPTIONS: Array<{ key: FontFamilyKey; label: string; css: string }> = [
  { key: "plexSans", label: "IBM Plex Sans", css: "\"IBM Plex Sans\", \"Segoe UI\", sans-serif" },
  { key: "sourceSerif", label: "Source Serif", css: "\"Source Serif 4\", Georgia, serif" },
  { key: "jetbrainsMono", label: "JetBrains Mono", css: "\"JetBrains Mono\", \"SFMono-Regular\", monospace" },
  { key: "nunito", label: "Nunito", css: "\"Nunito Sans\", \"Trebuchet MS\", sans-serif" },
];

export const LABEL_STYLE_CLASS_LABELS: Record<LabelStyleClass, string> = {
  tip: "Tip labels",
  genus: "Genus labels",
  taxonomy: "Taxonomy labels",
  internalNode: "Internal node labels",
  bootstrap: "Bootstrap labels",
  nodeHeight: "Node height labels",
  scale: "Scale labels",
};

export const DEFAULT_FIGURE_STYLES: FigureStyleSettings = {
  tip: { fontFamily: "plexSans", sizeScale: 1, offsetPx: 0 },
  genus: { fontFamily: "plexSans", sizeScale: 1, offsetPx: 0 },
  taxonomy: { fontFamily: "plexSans", sizeScale: 1, offsetPx: 0 },
  internalNode: { fontFamily: "sourceSerif", sizeScale: 0.95, offsetPx: 0 },
  bootstrap: { fontFamily: "jetbrainsMono", sizeScale: 0.9, offsetPx: 0 },
  nodeHeight: { fontFamily: "jetbrainsMono", sizeScale: 1, offsetPx: 0 },
  scale: { fontFamily: "jetbrainsMono", sizeScale: 1, offsetPx: 0 },
};

export function fontFamilyCss(fontFamily: FontFamilyKey): string {
  return FONT_FAMILY_OPTIONS.find((option) => option.key === fontFamily)?.css
    ?? FONT_FAMILY_OPTIONS[0].css;
}

export function fontFamilyLabel(fontFamily: FontFamilyKey): string {
  return FONT_FAMILY_OPTIONS.find((option) => option.key === fontFamily)?.label
    ?? FONT_FAMILY_OPTIONS[0].label;
}
