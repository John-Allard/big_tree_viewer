# Big Tree Viewer

Local-only phylogenetic tree viewer for large Newick trees.

## Current scope

- Rectangular mode with root on the left and tips on the right.
- Circular mode with the root at the center.
- Input-order tip layout plus descendant-count ascending and descending orderings.
- Circular rotation with label and hover support.
- Wheel zoom, drag pan, and rectangular x/y zoom pinning.
- Branch hover metadata without per-edge event handlers.
- Search over tip and node names, with stepping and focus.
- Alternating light time-scale stripes.
- Newick parsing and layout in a Web Worker.

## Development

```bash
npm install
npm run dev
```

The app auto-loads `public/example-tree.nwk`, which is a copy of the provided test tree.

## GitHub Pages

The repo now includes a GitHub Pages workflow at `.github/workflows/deploy-pages.yml`.

- Normal local builds: `npm run build`
- Pages build with repo base path: `npm run build:pages`

The Vite base path is controlled by `BIG_TREE_VIEWER_BASE`, so the same code can build locally at `/` and on Pages at `/big_tree_viewer/`.

## Notes

- `parent age` is only shown when the loaded tree is ultrametric.
- Large trees should be loaded from the local file picker to keep all compute on the client.
