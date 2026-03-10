# Features To Add

## Already Implemented

These are in place and do not need to stay on the active backlog:

- web deployment via GitHub Pages and custom domain deployment
- rectangular and circular viewing modes
- circular rotation with hover and label support
- search, stepping between matches, and focus-to-match navigation
- collapse / expand subtree
- zoom to subtree
- zoom to parent subtree
- open subtree in a new browser tab
- basic node / branch context menu
- paste-in Newick / NEXUS text loading
- drag-and-drop tree loading
- basic current-view SVG export
- basic NEXUS import support
- local taxonomy cache download and taxonomy-to-tip mapping
- taxonomy overlays in rectangular columns and circular rings

## Active Feature Areas

### 1. Context Menu and Manual Branch Styling

- Add subtree branch coloring from the context menu.
- Add single-branch coloring from the context menu.
- Present branch-color actions as a swatch submenu rather than a flat list.
- Add a way to clear branch / subtree color assignments.

### 2. Input and Format Support

- Expand parser support beyond current Newick assumptions to cover more real-world variants.
- Expand NEXUS support beyond the current basic tree extraction workflow.

### 3. External Metadata and Data-Driven Annotation

- Load a CSV file keyed by tip names and/or internal node labels.
- Map categorical CSV data to branch coloring.
- Map continuous numerical CSV data to branch coloring with a color scale.
- Add legends and scale controls for data-driven coloring.
- Plan for additional annotation channels from external tabular data beyond color alone.

### 4. Labels and Text Styling

- Add visual controls for font family selection.
- Add visual controls for font size by label class.
- Add visual controls for label offset by label class.
- Support separate controls for:
  - tip labels
  - internal node labels
  - bootstrap values
  - node height labels
  - future extra metadata labels
- Improve support for bootstrap values and other extra values when they are present in the input tree.

### 5. Node Uncertainty / Error Bars

- Support node-associated error bars when that data is available, similar to FigTree.
- Add controls for whether error bars are shown.
- Add controls for error-bar appearance for figure generation.
- Define how error-bar data is represented in parsed tree input and/or external metadata files.

### 6. Scale Bar and Figure Controls

- Add circular scale bar customization.
- Add rectangular scale bar customization.
- Support explicit tick interval control.
- Support scale label font-size control.
- Support scale line / tick styling controls for figure generation.
- Keep time stripes and scale bars independently configurable.

### 7. Export

- Add true vector SVG export for the current view rather than the current embedded-raster SVG wrapper.
- Preserve annotations in SVG export, including:
  - labels
  - subtree colors
  - scale bars
  - time stripes where appropriate
  - future metadata overlays
- Add a strategy for large-tree export that avoids pathological SVG sizes, for example:
  - vector export for modest visible complexity
  - hybrid raster/vector export for dense branch layers
  - subtree-focused export workflows for publication figures

### 8. Taxonomy Integration

- Refine taxonomy-ring color assignment to better mirror the original `auto-tree` hierarchical color behavior.
- Add clearer controls for which taxonomy ranks are shown.
- Add legends or rank headers for taxonomy overlays.
- Extend taxonomy overlays to interact cleanly with future branch-color and metadata overlays.
- Consider optional nearest-neighbor / inherited mapping behavior for unmapped tips if needed.

## Design and Architecture Work That Still Matters

The main architectural pressure point is still that too much behavior lives in one large canvas component. That was acceptable for initial iteration, but it will become harder to maintain as more interaction modes, render layers, annotation systems, and export features accumulate.

### Suggested Refactoring Direction

#### Split rendering from interaction and app state

Keep extracting smaller modules for:

- camera math and fit logic
- hit-testing and hover targeting
- rectangular rendering
- circular rendering
- label placement
- tooltip and context-menu interaction state

#### Introduce a view model / controller layer

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
- future metadata display options

That state should stay separate from the raw drawing code.

#### Separate tree data from overlay / annotation state

The parsed tree should remain the immutable core dataset.

Feature-specific state should live separately, for example:

- subtree color assignments
- collapsed nodes
- search matches
- temporary UI highlights
- taxonomy mappings
- CSV-derived annotations
- future error-bar data and label visibility settings

#### Add a command / action layer for node operations

Context-menu actions will continue to multiply.

Useful actions already emerging or likely to arrive:

- color branch
- color subtree
- collapse subtree
- expand subtree
- zoom to subtree
- zoom to parent subtree
- open subtree in new tab
- clear annotation from subtree

Centralizing these actions will reduce renderer-specific logic leaks.

#### Keep optional data providers separate

Useful direction:

- core tree logic remains platform-agnostic
- taxonomy loading / indexing lives in separate modules
- CSV metadata loading / validation lives in separate modules
- file / browser storage behavior is abstracted behind small interfaces

## Near-Term Priorities

1. Add manual subtree / branch coloring with context-menu swatches.
2. Add CSV metadata loading with branch-color mapping.
3. Add label / font / offset controls for figure generation.
4. Add true vector / annotation-aware SVG export.
5. Add broader Newick-variant support, including deeper NEXUS coverage.
