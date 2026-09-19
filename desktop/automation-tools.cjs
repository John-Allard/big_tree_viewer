const { z } = require("zod");

const object = z.record(z.string(), z.unknown());
const taxonomy = z.object({
  source: z.enum(["ncbi", "catalogue-of-life"]).default("ncbi"),
  ranks: z.array(z.enum(["superkingdom", "kingdom", "phylum", "class", "order", "family", "genus"])).optional(),
  allowDownload: z.boolean().default(false).describe("Allow a first-time taxonomy archive download. Otherwise use cached data only."),
}).strict();
const metadataOptions = z.object({
  text: z.string().optional(), label: z.string().optional(), firstRowIsHeader: z.boolean().optional(),
  enabled: z.boolean().optional(), keyColumn: z.string().optional(), valueColumn: z.string().optional(),
  colorMode: z.enum(["categorical", "continuous"]).optional(), applyScope: z.enum(["branch", "subtree"]).optional(),
  labelsEnabled: z.boolean().optional(), labelColumn: z.string().optional(),
  markersEnabled: z.boolean().optional(), markerColumn: z.string().optional(),
  piesEnabled: z.boolean().optional(), pieStartColumn: z.string().optional(), pieEndColumn: z.string().optional(),
  piePalette: z.enum(["categorical", "viridis", "warm"]).optional(), pieColorOverrides: z.record(z.string(), z.string()).optional(),
  pieSizePx: z.number().positive().optional(), reverseScale: z.boolean().optional(),
  continuousPalette: z.enum(["blueOrange", "viridis", "redBlue", "tealRose"]).optional(),
  continuousTransform: z.enum(["linear", "sqrt", "log"]).optional(), continuousMinInput: z.string().optional(), continuousMaxInput: z.string().optional(),
  categoryColorOverrides: z.record(z.string(), z.string()).optional(),
  markerStyleOverrides: z.record(z.string(), z.object({ color: z.string().optional(), shape: z.enum(["circle", "square", "diamond", "triangle"]).optional() }).strict()).optional(),
  markerSizePx: z.number().positive().optional(), labelMaxCount: z.number().int().nonnegative().optional(),
  labelMinSpacingPx: z.number().nonnegative().optional(), labelOffsetXPx: z.number().optional(), labelOffsetYPx: z.number().optional(),
}).strict();
const style = {
  layout: z.enum(["rectangular", "circular", "fan", "spiral"]).optional(),
  canvas: object.optional().describe("Optional saved viewport state, e.g. camera with kind, scaleX, scaleY, translateX, translateY for rectangular zoom."),
  settings: object.optional().describe("Saved BTV visual setting names; use inspect_tree to see current settings. Unknown keys are rejected."),
  metadataPath: z.string().optional().describe("Absolute local CSV/TSV path."),
  metadata: metadataOptions.optional().describe("Metadata column and encoding settings. Use metadataPath for a local CSV/TSV file."),
  taxonomy: taxonomy.optional(),
};
const input = {
  treePath: z.string().optional().describe("Absolute local Newick, NEXUS, or .btvsession path. Supply this OR newick."),
  newick: z.string().optional().describe("Inline Newick for small trees; prefer treePath for large inputs."),
  ...style,
};
const output = {
  outputPath: z.string().describe("Absolute destination ending .png, .svg, or .btvsession. Existing files are protected unless overwrite=true."),
  width: z.number().int().min(64).max(16384).optional(),
  height: z.number().int().min(64).max(16384).optional(),
  overwrite: z.boolean().default(false),
};
const id = { sessionId: z.string() };

const toolDefinitions = {
  open_tree: { description: "Open a local Newick/NEXUS tree or BTV session in a visible Big Tree Viewer desktop window with requested settings. Returns a sessionId for later edits. Does not replace the user's existing tree.", shape: input },
  render_tree: { description: "Render a local tree to PNG/SVG or save a configured .btvsession in the background using bundled Electron. No external Chrome, Python, or website. The temporary tree closes after export; use open_tree for interactive work.", shape: { ...input, ...output } },
  inspect_tree: { description: "Inspect an agent-opened tree: counts, layout, current visual settings, taxonomy coverage, and metadata messages.", shape: id },
  update_tree: { description: "Change layout, visual settings, metadata, or taxonomy on an existing agent tree without reparsing its topology. The visible desktop window updates.", shape: { ...id, ...style } },
  export_tree: { description: "Export the current agent tree view to PNG/SVG, or save its editable .btvsession with metadata, taxonomy, and camera.", shape: { ...id, ...output } },
  handoff_tree: { description: "Open the configured tree in the independent desktop app so the user can keep working after the agent disconnects. Saves a session in BTV agent storage and returns its path.", shape: id },
  close_tree: { description: "Close an agent-created tree window and release its memory. Does not close independently opened user windows.", shape: id },
};

module.exports = { toolDefinitions };
