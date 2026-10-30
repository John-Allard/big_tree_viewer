# Metadata, Ribbons, and Scales

Desktop MCP `open_tree`, `update_tree`, and `render_tree` accept `metadata` and
saved visual `settings`. The browser launch API uses the same metadata object
but calls the visual object `visual`. For a local CSV/TSV, MCP uses
`metadataPath`; browser helpers can put file contents in `metadata.text`.
The browser API also accepts an HTTP(S) `metadata.url`.

## Metadata Encodings

Use exact CSV/TSV header names. Match `keyColumn` to the original Newick tip IDs,
not replacement display names. On `update_tree`, omit file/text to reuse the
current table. Unspecified encoding settings are preserved.

- Chronological colors: `enabled: true`, `valueColumn: "date"`,
  `colorMode: "date"`; accepts ISO years, year-months, or full dates. Palette,
  reversal, transform, and range use `continuousPalette`, `reverseScale`,
  `continuousTransform`, `continuousMinInput`, and `continuousMaxInput`.
  Date coloring does not infer a time tree from genetic distances.
- Alternative names: `tipLabelColumn: "display_name"`; `""` restores original
  labels. Original IDs, topology, and metadata joins are unchanged.
- Collapse: `collapseColumn: "country"` collapses maximal clades whose tips all
  share the same nonempty value. It does not combine scattered tips by changing
  topology. `""` disables this grouping without changing manual collapse choices.
- CSV TaxIDs: `taxIdColumn: "taxid"` plus MCP
  `taxonomy: {"source":"ncbi","allowDownload":false}`; the browser API also
  needs `taxonomy.runMapping: true`. This is NCBI-only. Cached archives are
  required unless a first download is explicitly authorized.
- Custom taxonomy ribbons: `rankColumns: {"family":"family_group",
  "genus":"gene_family"}` maps supported rank names to columns and applies
  ribbons immediately, without an archive. Omit `taxonomy`: database mapping
  and custom ranks are mutually exclusive. `visual.metadataRankColumns` alone
  only preselects UI controls; use `metadata.rankColumns` to apply them.

Example MCP arguments for an already-open tree:

```json
{
  "sessionId": "SESSION_ID",
  "metadataPath": "/data/samples.csv",
  "metadata": {
    "keyColumn": "sequence_id", "enabled": true,
    "valueColumn": "collection_date", "colorMode": "date",
    "tipLabelColumn": "display_name", "collapseColumn": "country"
  },
  "settings": {
    "metadataLegendEnabled": true,
    "metadataLegendComponents": {"branchColors":true,"markers":false,"pies":false}
  }
}
```

## Independent Clade Ribbons

These can coexist with mapped taxonomy. Set `settings.customCladeRibbons` (or
browser `visual.customCladeRibbons`) to an array of:

```json
{"id":"study-group","node":0,"label":"Study group","color":"#159b83","placement":"outside","enabled":true}
```

`node` is the original parsed tree's zero-based Newick preorder node index,
including internal nodes, not a tip index or current sorted/display index.
Root is 0. Use known IDs from a matching BTV session or the original tree; do
not guess an arbitrary internal ID. `inside` and `outside` are relative to
taxonomy ribbons. Overlapping clades receive separate lanes. Setting the array
replaces the ribbon list; `[]` clears it. Limit: 200 ribbons; colors are six-digit
hex. Labels, placement, and IDs survive session export. Ribbons render in
rectangular, radial, and spiral modes, but not comparison mode.

## Tables and Legends

Tip-aligned tables use visual settings, not additional metadata encodings:
`metadataTipTableEnabled: true`, `metadataTipTableMode: "bars"|"heatmap"|"categorical"`,
and `metadataTipTableColumns: [{"column":"trait","label":"Trait","valueType":"number"}]`.
Use `valueType: "date"` for chronological cells. Categorical cells accept
`metadataTipTableCellStyle: "filled"|"circle"|"square"|"check"|"text"`.
Tables require rectangular layout. They can be used without branch coloring.

Set `metadataLegendEnabled`; choose `metadataLegendComponents` (branchColors,
markers, pies), `metadataLegendPosition` (top-left/top-right/bottom-left/bottom-right),
or normalized `metadataLegendPlacement: {"x":0.8,"y":0.1}`. Legend colors follow
the corresponding metadata palette and overrides, not an independent palette.

## Scale Controls

- `showScaleBars` is the master switch for axes, ticks, labels, and stripes.
- `showTimeStripes` and `timeStripeStyle` (bands/age-gradient/dashed) control guides.
- `figureStyles.scale.showScaleBar`, `.showScaleBarLabels`, and
  `.showTimeGuideLabels` independently control the axis and label components.
  `showTimeGuideLabels` is the UI's **Show Time Stripe Labels**: labels at the top
  of rectangular stripes, or retained radial/spiral labels when scale labels are
  off. In radial/spiral mode it has no extra effect while scale labels are on.
- `figureStyles.scale.showPartialRadialScaleBar` defaults true for fans/partial
  circles. Below 270 degrees, placement follows the more visible opening edge;
  equally visible edges prefer the one nearest zero degrees. No manual placement
  parameter is needed. At 270 to 359 degrees, the central scale shows time labels
  only, without an axis or ticks. Viewport-edge scales are bottom or left, never right.
- Full-circle radial controls are `showCircularCenterRadialScaleBar`,
  `useAutoCircularCenterScaleAngle`, and `circularCenterScaleAngleDegrees`.
  The angle applies only when auto is false; it does not position opening-edge scales.
- `timeAxisScale: "log"` enables `timeAxisLogBase`. Spiral always uses log scaling.
- `scaleTickIntervalInput: "10"` sets tick spacing; `""` restores auto spacing.
  `showScaleZeroTick` includes the zero tick without affecting placement;
  `extendRectScaleToTick` is rectangular-only.
- `showMyaTimeUnit: false` enables a custom `customTimeUnit` string (empty for none).
- For an already dated tree in years, use linear rectangular layout and
  `figureStyles.scale: {"calendarAxis":true,"calendarRootYear":1998}`.
  CSV date colors alone do not enable a calendar axis. Rerooting clears the old
  calendar origin; subtree sessions adjust it to the new root.

MCP `inspect_tree.metadata` includes table columns/row counts, matched and colored
nodes, collapse-group counts, matched tip-table tips, and enabled clade-ribbon
counts. Inspect those results and effective settings, then verify a PNG/SVG preview.
Editable `.btvsession` exports retain these settings and the metadata table.
