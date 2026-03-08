# Features To Add

## Overview

This document captures feature areas that we expect to add to Big Tree Viewer, along with some organizational notes to keep the codebase maintainable as the application grows.

The project currently targets the web only. There is no Tauri scaffold in the repository yet:

- no `src-tauri/`
- no `tauri.conf.*`
- no `Cargo.toml`

That means we are not currently set up to build a distributable Tauri app, but nothing in the current structure prevents us from planning for that.

## Planned Feature Areas

### Deployment targets

- Continue supporting deployment as a web app.
- Add possible future support for distributing the app as a Tauri desktop application.
- Keep open the option to ship a distributable desktop app via Tauri.
- Prefer architecture that does not hard-wire browser-only assumptions into core tree logic.

### Taxonomy integration

- Add an optional mode that downloads the NCBI taxonomy dump locally.
- Parse and index taxonomy data for local lookup.
- Map taxonomic groups to tree tips.
- Use taxonomy group membership to color branches, tips, or subtrees.
- Keep taxonomy support optional so the base viewer remains lightweight.

### Context menu and node actions

- Add a context menu for nodes and possibly branches.
- Support actions on a node or subtree such as:
  - color subtree
  - collapse subtree to a triangle
  - zoom to subtree extent
  - open subtree as a standalone tree
- Support opening a subtree in a new browser tab, and later possibly a new standalone window.

### Circular view improvements

- Allow rotating the circular tree.
- Keep all label orientations correct while rotating.
- Ensure hover, hit-testing, and context menu targeting continue to work correctly under rotation.

### Tooltip and metadata improvements

- Show the number of descendant tips in the tooltip for internal nodes.
- Continue expanding tooltip content with useful per-node metadata.

### Visual options

- Add many more visual controls, including options commonly found in tools like FigTree.
- Expand styling and annotation controls without making the control panel unmanageable.

### Search and navigation

- Add text search over tip and node names.
- Highlight matching results.
- Allow stepping or zooming between matches.

## Organizational Concerns

The main architectural pressure point is that too much behavior currently lives in one large canvas component. That was acceptable for initial iteration, but it will become hard to maintain as more interaction modes, render layers, and feature-specific state accumulate.

## Suggested Refactoring Direction

### 1. Split rendering from interaction and app state

The canvas component should stop being the place where everything happens.

Useful separations:

- camera math and fit logic
- hit-testing and hover targeting
- rectangular rendering
- circular rendering
- label placement
- tooltip/context-menu interaction state

Even if these remain canvas-based, they should become smaller modules with explicit inputs and outputs.

### 2. Introduce a view model / controller layer

It would be useful to have a single place that represents the current tree view state:

- view mode
- order
- zoom mode
- camera state
- selected node
- hovered node
- highlighted search results
- collapsed subtrees
- subtree colors
- rotation angle for circular mode

That state should be separate from the raw drawing code.

### 3. Separate tree data from overlay/stateful annotations

The parsed tree should remain the immutable core dataset.

Feature-specific state should live separately, for example:

- subtree color assignments
- collapsed nodes
- taxonomy mappings
- search matches
- temporary UI highlights

This will make undo/redo, context-menu actions, and opening subtrees in new tabs much easier later.

### 4. Plan for multiple tabs / tree sessions

If we want “open subtree as standalone tree in a new tab” or in a new window, we should eventually move toward a session model:

- one app shell
- multiple tree sessions / tabs
- each session has its own tree, camera, annotations, search state, and options

This does not need to be implemented yet, but future code should avoid assuming there is only one global tree view forever.

### 5. Add a command/action layer for node operations

Context-menu actions will multiply quickly.

It would help to centralize actions like:

- color subtree
- collapse subtree
- expand subtree
- focus subtree
- open subtree in new tab
- copy node data

That can start as a simple action registry rather than a full command framework, but the important thing is to avoid scattering per-action logic throughout rendering code.

### 6. Abstract data providers for optional local resources

The optional taxonomy dump is a good reason to avoid mixing data acquisition with rendering.

Useful direction:

- core tree logic remains platform-agnostic
- taxonomy loading/indexing lives in a separate service/module
- platform-specific file or local-storage behavior is abstracted behind adapters

That will help if we later support:

- pure web mode
- Tauri desktop mode
- cached local datasets

### 7. Prepare for Tauri without adding it prematurely

We do not need to add Tauri scaffolding immediately unless we want to start testing desktop packaging soon.

What is worth doing now:

- keep core logic in plain TypeScript modules
- avoid baking browser-only storage/file APIs directly into feature logic
- keep optional local-file workflows behind small interfaces
- think of “open in new tab/window” as a session/window abstraction, not a browser-specific trick

What can wait:

- `src-tauri/`
- Rust commands
- desktop packaging config
- desktop updater and installer work

### 8. Consider render layers explicitly

The canvas already has multiple logical layers, even if they are not formalized yet:

- tree geometry
- hover highlights
- tip labels
- genus labels
- node height labels
- time stripes and scales
- future search highlights
- future taxonomy/group coloring
- future collapsed-subtree glyphs

Making these layers explicit in code would reduce regressions when new features are added.

## Suggested Near-Term Scaffolding

These are the steps most likely to help soon without over-engineering:

1. Break `TreeCanvas.tsx` into smaller modules for:
   - camera math
   - hover/hit-testing
   - rectangular draw
   - circular draw
   - label placement

2. Introduce a `TreeViewState` shape that is independent from the raw parsed tree.

3. Introduce an annotation/state layer for:
   - subtree colors
   - collapsed nodes
   - search matches
   - future taxonomy-derived groups

4. Add a simple node-action abstraction before building the context menu.

5. Keep taxonomy loading/indexing in separate modules or services, not inside the renderer.

6. Delay Tauri scaffolding until we are ready to actually test desktop packaging, but keep new feature logic platform-neutral.

## What Not To Do Yet

- Do not move everything into a large global state system just because more features are coming.
- Do not add Tauri-specific code until we have a concrete desktop flow to test.
- Do not keep packing new behavior directly into one canvas file if a small extracted module would make ownership clearer.

## Summary

The next major growth areas are:

- optional taxonomy-aware coloring and mapping
- richer node actions via context menu
- circular rotation
- subtree operations
- search/navigation
- more visual controls
- eventual web + Tauri deployment flexibility

The codebase is not yet set up for Tauri, but it can be prepared for that path by keeping tree logic, interaction logic, data services, and render layers more modular from this point onward.
