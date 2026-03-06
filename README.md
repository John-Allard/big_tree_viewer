# Big Tree Viewer

Local-only phylogenetic tree viewer for large Newick trees.

## Current scope

- Rectangular mode with root on the left and tips on the right.
- Circular mode with the root at the center.
- Input-order tip layout plus descendant-count ascending and descending orderings.
- Wheel zoom, drag pan, and rectangular x/y zoom pinning.
- Branch hover metadata without per-edge event handlers.
- Alternating light time-scale stripes.
- Newick parsing and layout in a Web Worker.

## Development

```bash
npm install
npm run dev
```

The app auto-loads `public/example-tree.nwk`, which is a copy of the provided test tree.

## Notes

- `parent age` is only shown when the loaded tree is ultrametric.
- Large trees should be loaded from the local file picker to keep all compute on the client.
