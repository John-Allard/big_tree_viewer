---
name: bigtreeviewer
description: Use Big Tree Viewer from Codex or another coding agent to open, style, inspect, and render phylogenetic trees from local Newick/NEXUS files, BTV session files, or launch payloads. Trigger when the user asks to view, render, export, style, or make figures of trees with Big Tree Viewer.
metadata:
  short-description: Open and render phylogenetic trees with Big Tree Viewer
---

# Big Tree Viewer

Use this skill when a user asks to open, inspect, style, or render a phylogenetic tree with Big Tree Viewer.

## Quick Choice

- To show an interactive tree or saved session to the user, run `scripts/btv_open.py`.
- To trigger a browser SVG/PNG download without extra dependencies, run `scripts/btv_open.py --download-export svg` or `--download-export png`.
- For huge trees, avoid SVG unless the user explicitly needs vector output for a limited visible region. SVG can become slow or unusable because every visible branch is vector geometry; PNG is usually safer.
- For slide figures, prefer setting PNG `--width`/`--height` to the final on-slide pixel box, or use `--export-viewport-width`/`--export-viewport-height` to preserve slide-scale styling while exporting at higher pixel density.
- Circular and spiral PNG exports must be square. Use landscape or portrait dimensions only for rectangular trees.
- If the user does not request export dimensions, keep browser-window-scale defaults: rectangular PNG exports default to 1600 x 1000 pixels, and circular/spiral PNG exports default to 1200 x 1200 pixels.
- For large local trees, prefer the scripts' postMessage launch path instead of putting Newick directly into a URL.
- Use Big Tree Viewer's defaults unless the user asks for a different setting or the figure goal clearly requires it. Do not send every possible visual/API setting just because it exists.

## Open an Interactive Viewer

Run examples from the skill folder. If you are elsewhere, use absolute paths to
the scripts.

```bash
python scripts/btv_open.py tree.nwk --view circular --tip-labels true
python scripts/btv_open.py saved-view.btvsession
python scripts/btv_open.py tree.nwk --view circular --download-export png --export-filename tree.png
```

Useful options:

```bash
python scripts/btv_open.py tree.nwk --view spiral --spiral-turns 6 --time-stripes true
python scripts/btv_open.py tree.nwk --view rectangular --order input --branch-thickness 1.4
python scripts/btv_open.py tree.nwk --view circular --taxonomy true --taxonomy-branch-colors true --map-taxonomy
python scripts/btv_open.py --session-url https://example.org/tree.btvsession
```

`btv_open.py` uses only Python's standard library. It creates a temporary launcher page, opens Big Tree Viewer, and sends the local tree text or session object through the Big Tree Viewer launch API. With `--download-export`, it asks the user's browser to download an SVG or PNG after the tree loads. This is the recommended export route for ordinary desktop use.
It needs a desktop browser.

## Styling

Use command-line options for common settings:

```bash
python scripts/btv_open.py tree.nwk --download-export png --export-filename figure.png --view circular --tip-labels false --genus-labels true --branch-thickness 1.2
```

For advanced settings, pass a JSON launch payload:

```bash
python scripts/btv_open.py tree.nwk --download-export png --export-filename figure.png --payload-json settings.json
```

The JSON file may include Big Tree Viewer launch API fields such as `newickUrl`, `sessionUrl`, `session`, `visual`, `metadata`, `taxonomy`, `canvas`, and `export`. Command-line options are applied after the JSON payload.
Keep launch payloads minimal. Omit `visual`, `metadata`, `taxonomy`, `canvas`, or individual setting keys when the default viewer behavior is acceptable. Only specify settings needed to satisfy the user's request, reproduce a saved view, apply metadata/taxonomy, choose an export format/size, or fix a concrete figure-composition problem.
For session-style programmatic styling, put saved setting names in `visual`; Big Tree Viewer accepts the same setting names saved in `.btvsession` files for view mode, time stripes, label classes, taxonomy ribbons, metadata display settings, branch thickness, and PhyloPic placement.
Use `metadata` for CSV/TSV overlays. Set `enabled`, `keyColumn`, `valueColumn`, `colorMode`, and `applyScope` for metadata branch/subtree coloring; set `labelsEnabled`/`labelColumn`, `markersEnabled`/`markerColumn`, or `piesEnabled` with `pieStartColumn` and `pieEndColumn` for labels, markers, or pie-chart glyphs.
Use `canvas` when the user needs session-style viewport state, collapsed clades, or manual branch/subtree colors. `canvas` accepts the same shape saved in `.btvsession` files: `camera`, `viewportWidth`, `viewportHeight`, `collapsedNodes`, `manualBranchColors`, and `manualSubtreeColors`.
For rectangular camera control, use `canvas.camera` with `kind: "rect"`, `scaleX`, `scaleY`, `translateX`, and `translateY`.
Use `taxonomy.runMapping: true` when an agent needs taxonomy ribbons or taxonomy branch colors. This runs the same NCBI taxonomy mapping code used by the Big Tree Viewer site after the tree has loaded. Automated mapping is cache-only by default: it uses an already cached NCBI taxdump archive and fails with `big-tree-viewer:taxonomy-error` if the archive is missing. Do not let an agent trigger a fresh NCBI taxdump download unless the user explicitly asks; only then set `taxonomy.allowDownload: true` or use `--allow-taxonomy-download`.
Agents should prefer standard BTV taxonomy mapping over building their own taxonomy map, because custom external maps can assign BTV node ids or taxonomic lineages incorrectly.
Use `taxonomy.map` only to provide a precomputed Big Tree Viewer taxonomy map that was produced by Big Tree Viewer or otherwise already matches the loaded tree's BTV node ids.
Use `export.delivery: "postMessage"` when an agent needs bytes back instead of a browser download. Big Tree Viewer replies with `big-tree-viewer:exported` or `big-tree-viewer:export-error`.
The helper script exposes common API fields as flags: `--map-taxonomy`, `--allow-taxonomy-download`, `--taxonomy-low-memory`, `--rect-scale-x`, `--rect-scale-y`, `--rect-translate-x`, and `--rect-translate-y`.

Example `settings.json`:

```json
{
  "visual": {
    "viewMode": "circular",
    "showTipLabels": false,
    "taxonomyEnabled": true,
    "taxonomyRankVisibility": { "family": true, "order": true },
    "branchThicknessScale": 1.4
  },
  "canvas": {
    "camera": {
      "kind": "rect",
      "scaleX": 4.2,
      "scaleY": 1.8,
      "translateX": 60,
      "translateY": 120
    },
    "collapsedNodes": [12],
    "manualSubtreeColors": [[12, "#1f77b4"]]
  },
  "taxonomy": {
    "runMapping": true
  },
  "export": {
    "format": "png",
    "delivery": "postMessage",
    "filename": "tree.png",
    "width": 1600,
    "height": 1000
  }
}
```

## Taxonomy Mapping

To map taxonomy for the current loaded tree without reloading it, send:

```js
viewer.postMessage({
  type: "big-tree-viewer:map-taxonomy",
  payload: {}
}, "https://bigtreeviewer.net");
```

Big Tree Viewer replies with `big-tree-viewer:taxonomy-mapped` and includes `taxonomy.map`, or `big-tree-viewer:taxonomy-error` if mapping failed. Use the returned map only with the same loaded tree/node ids.
For URL launches, `btv_map_taxonomy=true` is equivalent to `taxonomy.runMapping: true` in a payload. It is cache-only unless `btv_taxonomy_allow_download=true` is also provided.

## Current View Export

After a tree has loaded, an agent can request an export of the current view without reloading the tree:

```js
viewer.postMessage({
  type: "big-tree-viewer:export",
  payload: {
    format: "svg",
    delivery: "postMessage",
    filename: "current-view.svg"
  }
}, "https://bigtreeviewer.net");
```

For PNG, include `width` and `height` only when the user needs dimensions other than the browser-window-scale defaults. The exported message includes SVG text for SVG exports or a PNG data URL for PNG exports.
For high-density PNGs that should keep the same apparent label, marker, ribbon, and scale styling as a smaller slide view, also include `viewportWidth` and `viewportHeight`. Example: `width: 4200`, `height: 4200`, `viewportWidth: 1200`, `viewportHeight: 1200` renders a 1200 x 1200 CSS-pixel view at 3.5x pixel density instead of making the renderer behave as though the viewport itself were 4200 x 4200.

Useful Poales/C4-style circular settings:

```json
{
  "visual": {
    "order": "asc",
    "circularRotationDegrees": 0,
    "useAutoCircularCenterScaleAngle": true,
    "showCircularCenterRadialScaleBar": false,
    "metadataMarkerSizePx": 100,
    "taxonomyRankDisplayModes": { "family": "ribbon", "genus": "ribbon" },
    "taxonomyRankVisibility": { "family": true, "genus": true },
    "figureStyles": {
      "taxonomy": { "sizeScale": 1, "bold": true, "bandThicknessScale": 1.6 }
    }
  }
}
```

## Defaults

- Default Big Tree Viewer URL: `https://bigtreeviewer.net/`
- Override with `--btv-url http://localhost:5173/` when testing a local development server.
- SVG is appropriate for smaller or moderately detailed vector output.
- PNG is preferred for huge trees, slides, previews, and bitmap workflows.
