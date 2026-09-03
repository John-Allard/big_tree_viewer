---
name: bigtreeviewer
description: Use Big Tree Viewer from Codex or another coding agent to open, style, inspect, and render phylogenetic trees from local Newick/NEXUS files, BTV session files, or launch payloads. Trigger when the user asks to view, render, export, style, or make figures of trees with Big Tree Viewer.
metadata:
  short-description: Open and render phylogenetic trees with Big Tree Viewer
---

# Big Tree Viewer

Use this skill when a user asks to open, inspect, style, or render a phylogenetic tree with Big Tree Viewer.

## Quick Choice

- For agent rendering, run `scripts/btv_render.py`. It uses an isolated headless Chrome/Chromium/Edge profile and never opens a tab in the user's active browser.
- To show an interactive tree or saved session to the user, run `scripts/btv_open.py` only when the user explicitly wants a browser window.
- `btv_open.py --download-export png|svg` remains compatible with older commands, but now renders headlessly and saves the named file instead of using the active browser's download UI.
- For huge trees, avoid SVG unless the user explicitly needs vector output for a limited visible region. SVG can become slow or unusable because every visible branch is vector geometry; PNG is usually safer.
- For slide figures, prefer setting PNG `--width`/`--height` to the final on-slide pixel box, or use `--export-viewport-width`/`--export-viewport-height` to preserve slide-scale styling while exporting at higher pixel density.
- Spiral PNG exports must be square. Rectangular and radial trees may use landscape or portrait dimensions; radial geometry remains circular rather than stretching with the canvas.
- Use spiral mode only for trees with at least 1,000 tips; the viewer disables it for smaller trees.
- If the user does not request export dimensions, keep browser-window-scale defaults: rectangular and radial PNG exports default to 1600 x 1000 pixels, and spiral PNG exports default to 1200 x 1200 pixels.
- For large local trees, prefer the scripts' postMessage launch path instead of putting Newick directly into a URL.
- Use Big Tree Viewer's defaults unless the user asks for a different setting or the figure goal clearly requires it. Do not send every possible visual/API setting just because it exists.

## Open an Interactive Viewer

Run examples from the skill folder. If you are elsewhere, use absolute paths to
the scripts.

```bash
python scripts/btv_open.py tree.nwk --view radial --tip-labels true
python scripts/btv_open.py saved-view.btvsession
```

Useful options:

```bash
python scripts/btv_open.py tree.nwk --view spiral --spiral-turns 6 --time-stripes true
python scripts/btv_open.py tree.nwk --view rectangular --order input --branch-thickness 1.4
python scripts/btv_open.py tree.nwk --view radial --radial-span 360 --taxonomy true --taxonomy-branch-colors true --map-taxonomy
python scripts/btv_open.py --session-url https://example.org/tree.btvsession
```

`btv_open.py` uses only Python's standard library. For a local interactive launch, it opens one temporary handoff page in the user's default browser. Current BTV deployments verify that the browser preserves a one-use same-tab transfer, replace the handoff page with a top-level BTV page, and clear the transferred payload as it is consumed. The final address bar therefore shows the configured BTV URL, and BTV has normal top-level access to browser-granted file permissions. Browsers or older deployments that cannot make that transfer fall back to embedding BTV in the same tab. The helper does not request a pop-up or leave a blank launcher tab. Opening the user's browser is intentional only for this explicitly interactive command; do not use it for unattended rendering.

### Use the desktop application when requested

If Big Tree Viewer Desktop is installed and the user explicitly wants a tree opened in that application, launch the tree or `.btvsession` through the operating system instead of opening a browser handoff page. On macOS use `open -a "Big Tree Viewer" /path/to/tree.nwk`; on Linux invoke the installed Big Tree Viewer executable with the file path; on Windows launch the file itself or pass it to the installed application. The desktop application accepts files both at startup and while it is already running.

Do not use the desktop application for unattended rendering. `btv_render.py` remains the reproducible headless path: it uses an isolated browser profile, validates the output, and does not interfere with the user's desktop application or active browser.

## Render Without Opening the User's Browser

```bash
python scripts/btv_render.py tree.nwk --output tree.png --view radial --tip-labels false
python scripts/btv_render.py tree.nwk --metadata traits.csv --metadata-key name --metadata-value group --output traits.png
python scripts/btv_render.py saved-view.btvsession --output saved-view.png
python scripts/btv_render.py tree.nwk --output tree.svg --view rectangular
```

`btv_render.py` requires Python 3.10 or newer and an installed Chrome, Chromium, or Edge executable. It uses no third-party Python package and never downloads a browser. Use `--browser /path/to/browser` only when auto-detection cannot find it.

The renderer starts a loopback-only transfer server and a headless browser process with a dedicated profile in the operating system's user cache directory (`~/.cache` on Linux, `~/Library/Caches` on macOS, or `%LOCALAPPDATA%` on Windows). It receives PNG/SVG bytes directly from BTV, writes the requested output atomically, validates the file type and dimensions, and rejects blank PNG output. The dedicated profile is separate from the user's normal browser and preserves BTV's cached taxonomy archive between agent runs. Concurrent renders are serialized around that profile on Linux, macOS, and Windows. Set `BTV_AGENT_CACHE_HOME` to override the cache root.

Use `--profile-dir` to choose a different dedicated automation profile and `--timeout` for unusually large trees. Rendering can target a local development server with `--btv-url http://127.0.0.1:5173/`.

## Styling

Use command-line options for common settings:

```bash
python scripts/btv_render.py tree.nwk --output figure.png --view radial --tip-labels false --genus-labels true --branch-thickness 1.2
```

For advanced settings, pass a JSON launch payload:

```bash
python scripts/btv_render.py tree.nwk --output figure.png --payload-json settings.json
```

The JSON file may include Big Tree Viewer launch API fields such as `newickUrl`, `sessionUrl`, `session`, `visual`, `metadata`, `taxonomy`, `canvas`, and `export`. Command-line options are applied after the JSON payload.
Keep launch payloads minimal. Omit `visual`, `metadata`, `taxonomy`, `canvas`, or individual setting keys when the default viewer behavior is acceptable. Only specify settings needed to satisfy the user's request, reproduce a saved view, apply metadata/taxonomy, choose an export format/size, or fix a concrete figure-composition problem.
For session-style programmatic styling, put saved setting names in `visual`; Big Tree Viewer accepts the same setting names saved in `.btvsession` files for view mode, time stripes, label classes, taxonomy ribbons, metadata display settings, branch thickness, and PhyloPic placement.
Current visual controls include radial angular span and inner radius; aligned and width-limited tip labels; bootstrap and node-height labels; rectangular or capped-line node-height error bars; custom scale units; taxonomy ribbon thickness, gap, and display modes; metadata pies and tip-aligned tables; and PhyloPic placement. Use the exact saved-setting names shown by the launch API documentation, and omit settings the user did not ask to change.
Tree-comparison state, including the comparison tree, camera, incompatible-split display, connector sensitivity, and center-zone width, is preserved in `.btvsession` payloads. Prefer loading or constructing a session payload when an automated output must reproduce comparison mode.
For non-ultrametric rectangular or radial trees, set `visual.alignTipLabels: true` to align terminal labels at the tree edge. Rectangular views draw dotted leaders from shorter tips; radial views use a common outer label radius without leaders.
Use `metadata` for CSV/TSV overlays. Set `enabled`, `keyColumn`, `valueColumn`, `colorMode`, and `applyScope` for metadata branch/subtree coloring; set `labelsEnabled`/`labelColumn`, `markersEnabled`/`markerColumn`, or `piesEnabled` with `pieStartColumn` and `pieEndColumn` for labels, markers, or pie-chart glyphs.
For node-height uncertainty in trees that contain compatible interval annotations, set `visual.showNodeErrorBars: true`. The current controls are `errorBarStyle` (`rectangle` or `capped-line`), `errorBarColor`, `errorBarOpacity`, `errorBarShowNodeDot`, `errorBarThicknessPx`, and `errorBarCapSizePx`; spiral mode intentionally does not draw these bars.
For a rectangular tip-aligned data display, set `visual.metadataTipTableEnabled: true`, choose `metadataTipTableMode` as `bars`, `heatmap`, or `categorical`, and provide `metadataTipTableColumns` as ordered `{ "column": "source_column", "label": "Display label" }` objects. Heat maps accept `metadataTipTablePalette`; categorical tables accept `metadataTipTableCellStyle` values `filled`, `circle`, `square`, `check`, or `text`. Omit width settings unless the user requests them.
Use `canvas` when the user needs session-style viewport state, collapsed clades, or manual branch/subtree/taxonomy colors. `canvas` accepts the same shape saved in `.btvsession` files: `camera`, `viewportWidth`, `viewportHeight`, `collapsedNodes`, `manualBranchColors`, `manualSubtreeColors`, and `taxonomyRootColors`.
For rectangular camera control, use `canvas.camera` with `kind: "rect"`, `scaleX`, `scaleY`, `translateX`, and `translateY`.
Use `taxonomy.runMapping: true` when an agent needs taxonomy ribbons or taxonomy branch colors. This runs the same mapping code used by the site after the tree has loaded. NCBI is the default; set `taxonomy.source: "catalogue-of-life"` or use `--taxonomy-source catalogue-of-life` to use Catalogue of Life. Automated mapping is cache-only by default and fails with `big-tree-viewer:taxonomy-error` if the selected archive is missing. Do not let an agent trigger a fresh taxonomy download unless the user explicitly asks; only then set `taxonomy.allowDownload: true` or use `--allow-taxonomy-download`.
Agents should prefer standard BTV taxonomy mapping over building their own taxonomy map, because custom external maps can assign BTV node ids or taxonomic lineages incorrectly.
Use `taxonomy.map` only to provide a precomputed Big Tree Viewer taxonomy map that was produced by Big Tree Viewer or otherwise already matches the loaded tree's BTV node ids.
When an external system already has taxonomy but does not have BTV node ids, use `taxonomy.compact` with `format: "big-tree-viewer-compact-taxonomy"`, `version: 1`, a deduplicated `taxa` parent graph, and `tips` keyed by zero-based left-to-right Newick `tipIndex`. Include `tipLabel` as a validation check. BTV resolves the graph after parsing and does not download the NCBI taxdump.
Use `export.delivery: "postMessage"` when an agent needs bytes back instead of a browser download. Big Tree Viewer replies with `big-tree-viewer:exported` or `big-tree-viewer:export-error`.
For postMessage clients, BTV emits `big-tree-viewer:ready` once per viewer document. After a `big-tree-viewer:load` request, `big-tree-viewer:loaded` means the tree, requested canvas restoration, taxonomy mapping, and metadata overlays are ready; it is safe to request a current-view export immediately.
The helper script exposes common API fields as flags, including `--radial-span`, `--radial-inner-radius`, `--map-taxonomy`, `--taxonomy-source`, `--allow-taxonomy-download`, `--taxonomy-low-memory`, and the rectangular-camera `--rect-*` options.

Example `settings.json`:

```json
{
  "visual": {
    "viewMode": "radial",
    "radialAngularSpanDegrees": 360,
    "radialCenterOpeningRatio": 0,
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
    "runMapping": true,
    "source": "ncbi"
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
  payload: { source: "ncbi" }
}, "https://bigtreeviewer.net");
```

Big Tree Viewer replies with `big-tree-viewer:taxonomy-mapped` and includes `taxonomy.map`, or `big-tree-viewer:taxonomy-error` if mapping failed. Use the returned map only with the same loaded tree/node ids.
For URL launches, `btv_map_taxonomy=true` is equivalent to `taxonomy.runMapping: true` in a payload. Set `btv_taxonomy_source=catalogue-of-life` to select Catalogue of Life. Mapping is cache-only unless `btv_taxonomy_allow_download=true` is also provided.

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

Useful Poales/C4-style radial settings:

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
