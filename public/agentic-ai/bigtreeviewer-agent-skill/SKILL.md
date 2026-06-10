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
- To save an SVG or PNG to a specific path without browser interaction, run `scripts/btv_render.py`.
- For large local trees, prefer the scripts' postMessage launch path instead of putting Newick directly into a URL.

## Open an Interactive Viewer

Run examples from the skill folder. If you are elsewhere, use absolute paths to
the scripts.

```bash
python scripts/btv_open.py tree.nwk --view circular --tip-labels true
python scripts/btv_open.py saved-view.btvsession
python scripts/btv_open.py tree.nwk --view circular --download-export svg --export-filename tree.svg
```

Useful options:

```bash
python scripts/btv_open.py tree.nwk --view spiral --spiral-turns 6 --time-stripes true
python scripts/btv_open.py tree.nwk --view rectangular --order input --branch-thickness 1.4
python scripts/btv_open.py --session-url https://example.org/tree.btvsession
```

`btv_open.py` uses only Python's standard library. It creates a temporary launcher page, opens Big Tree Viewer, and sends the local tree text or session object through the Big Tree Viewer launch API. With `--download-export`, it asks the user's browser to download an SVG or PNG after the tree loads. This is the easiest export route for ordinary desktop use.
It needs a desktop browser. In SSH, CI, containers, or other headless environments, use `btv_render.py` instead.

## Save a File Automatically

Use `btv_render.py` only when the agent must write the rendered SVG or PNG to an exact output path, run headlessly, or batch-render without browser download prompts. This requires Playwright because a browser engine must run Big Tree Viewer and return the rendered bytes to Python:

```bash
python scripts/btv_render.py tree.nwk --format svg --out tree.svg --view circular
python scripts/btv_render.py tree.nwk --format png --out tree.png --view spiral --width 3000 --height 3000
python scripts/btv_render.py saved-view.btvsession --out saved-view.svg
```

If Playwright is missing, install it:

```bash
python -m pip install playwright
python -m playwright install chromium
```

On Linux CI images, Playwright may also need browser system packages:

```bash
python -m playwright install --with-deps chromium
```

The render script opens Big Tree Viewer headlessly, posts the tree/session and requested settings, receives the exported SVG or PNG through `postMessage`, and writes it to the requested output path.
It supports local Newick, NEXUS, and `.btvsession` files. For remote session links, use `btv_open.py --session-url` interactively or pass a `sessionUrl` field through `--payload-json`.

## Styling

Use command-line options for common settings:

```bash
python scripts/btv_render.py tree.nwk --out figure.svg --view circular --tip-labels false --genus-labels true --branch-thickness 1.2
```

For advanced settings, pass a JSON launch payload:

```bash
python scripts/btv_render.py tree.nwk --out figure.svg --payload-json settings.json
```

The JSON file may include Big Tree Viewer launch API fields such as `newickUrl`, `sessionUrl`, `session`, `visual`, and `metadata`. Command-line options are applied after the JSON payload.
For session-style programmatic styling, put saved setting names in `visual`; Big Tree Viewer accepts the same setting names saved in `.btvsession` files for view mode, time stripes, label classes, taxonomy ribbons, metadata display settings, branch thickness, and PhyloPic placement.
Use `canvas` when the user needs session-style viewport state, collapsed clades, or manual branch/subtree colors. `canvas` accepts the same shape saved in `.btvsession` files: `camera`, `viewportWidth`, `viewportHeight`, `collapsedNodes`, `manualBranchColors`, and `manualSubtreeColors`.

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
    "collapsedNodes": [12],
    "manualSubtreeColors": [[12, "#1f77b4"]]
  }
}
```

## Defaults

- Default Big Tree Viewer URL: `https://bigtreeviewer.net/`
- Override with `--btv-url http://localhost:5173/` when testing a local development server.
- SVG is preferred for publication-quality vector output.
- PNG is useful for slides, previews, and bitmap workflows.
