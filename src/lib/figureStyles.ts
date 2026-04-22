export type FontFamilyKey =
  | "arial"
  | "helvetica"
  | "trebuchet"
  | "verdana"
  | "georgia"
  | "palatino"
  | "timesNewRoman"
  | "courierNew"
  | "systemMono";
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
  offsetXPx: number;
  offsetYPx: number;
  bold?: boolean;
  italic?: boolean;
  bandThicknessScale?: number;
  taxonomyGapPx?: number;
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
  { key: "arial", label: "Arial", css: "Arial, \"Helvetica Neue\", sans-serif" },
  { key: "helvetica", label: "Helvetica", css: "Helvetica, Arial, sans-serif" },
  { key: "trebuchet", label: "Trebuchet MS", css: "\"Trebuchet MS\", Arial, sans-serif" },
  { key: "verdana", label: "Verdana", css: "Verdana, Geneva, sans-serif" },
  { key: "georgia", label: "Georgia", css: "Georgia, serif" },
  { key: "palatino", label: "Palatino", css: "\"Palatino Linotype\", Palatino, serif" },
  { key: "timesNewRoman", label: "Times New Roman", css: "\"Times New Roman\", Times, serif" },
  { key: "courierNew", label: "Courier New", css: "\"Courier New\", Courier, monospace" },
  { key: "systemMono", label: "System Monospace", css: "\"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace" },
];

export const LABEL_STYLE_CLASS_LABELS: Record<LabelStyleClass, string> = {
  tip: "Tip labels",
  genus: "Genus labels",
  taxonomy: "Taxonomy overlays",
  internalNode: "Internal node labels",
  bootstrap: "Bootstrap labels",
  nodeHeight: "Node height labels",
  scale: "Scale labels",
};

export const TAXONOMY_LABEL_SIZE_SCALE_MIN = 0.55;
export const TAXONOMY_LABEL_SIZE_SCALE_MAX = 1;

export const DEFAULT_FIGURE_STYLES: FigureStyleSettings = {
  tip: { fontFamily: "arial", sizeScale: 1, offsetPx: 0, offsetXPx: 0, offsetYPx: 0, bold: false, italic: false, bandThicknessScale: 1, taxonomyGapPx: 0 },
  genus: { fontFamily: "arial", sizeScale: 1, offsetPx: 0, offsetXPx: 0, offsetYPx: 0, bold: false, italic: false, bandThicknessScale: 1, taxonomyGapPx: 0 },
  taxonomy: { fontFamily: "arial", sizeScale: 1, offsetPx: 0, offsetXPx: 0, offsetYPx: 0, bold: false, italic: false, bandThicknessScale: 1, taxonomyGapPx: 0 },
  internalNode: { fontFamily: "georgia", sizeScale: 0.95, offsetPx: 0, offsetXPx: 0, offsetYPx: 0, bold: false, italic: false, bandThicknessScale: 1, taxonomyGapPx: 0 },
  bootstrap: { fontFamily: "courierNew", sizeScale: 0.9, offsetPx: 0, offsetXPx: 0, offsetYPx: 0, bold: false, italic: false, bandThicknessScale: 1, taxonomyGapPx: 0 },
  nodeHeight: { fontFamily: "courierNew", sizeScale: 1, offsetPx: 0, offsetXPx: 0, offsetYPx: 0, bold: false, italic: false, bandThicknessScale: 1, taxonomyGapPx: 0 },
  scale: { fontFamily: "arial", sizeScale: 1, offsetPx: 0, offsetXPx: 0, offsetYPx: 0, bold: false, italic: false, bandThicknessScale: 1, taxonomyGapPx: 0 },
};

export function fontFamilyCss(fontFamily: FontFamilyKey): string {
  return FONT_FAMILY_OPTIONS.find((option) => option.key === fontFamily)?.css
    ?? FONT_FAMILY_OPTIONS[0].css;
}

export function fontFamilyLabel(fontFamily: FontFamilyKey): string {
  return FONT_FAMILY_OPTIONS.find((option) => option.key === fontFamily)?.label
    ?? FONT_FAMILY_OPTIONS[0].label;
}

export function cloneDefaultFigureStyles(): FigureStyleSettings {
  return {
    tip: { ...DEFAULT_FIGURE_STYLES.tip },
    genus: { ...DEFAULT_FIGURE_STYLES.genus },
    taxonomy: { ...DEFAULT_FIGURE_STYLES.taxonomy },
    internalNode: { ...DEFAULT_FIGURE_STYLES.internalNode },
    bootstrap: { ...DEFAULT_FIGURE_STYLES.bootstrap },
    nodeHeight: { ...DEFAULT_FIGURE_STYLES.nodeHeight },
    scale: { ...DEFAULT_FIGURE_STYLES.scale },
  };
}

export function fontStyleCss(settings: LabelStyleSettings): string {
  return `${settings.italic ? "italic " : ""}${settings.bold ? "700 " : ""}`.trim();
}
