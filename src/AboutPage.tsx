import { HOME_DESCRIPTION } from "./siteCopy";

const figureSections = [
  {
    title: "Genus bands at low zoom",
    image: `${import.meta.env.BASE_URL}about/example-50k-genus-bands.png`,
    alt: "Circular Big Tree Viewer screenshot showing a 50k-tip tree with genus labels around the perimeter.",
    text: "Individual tip labels are not legible when a tree with tens of thousands of tips is fit to the screen. When binomial species names are detected, genera are inferred from the tip labels and drawn as bands along the tip axis, giving readable structure at any zoom level.",
  },
  {
    title: "Genus column in rectangular layout",
    image: `${import.meta.env.BASE_URL}about/example-rectangular-genus-bands.png`,
    alt: "Rectangular Big Tree Viewer screenshot showing a tree of rodents with a genus label column to the right of the tips.",
    text: "In rectangular layout the inferred genera are placed in a column to the right of the tips, so each clade gets a readable label even where individual species names overlap. As with the circular layout, this works directly from binomial tip names and does not require a taxonomy download.",
  },
  {
    title: "Higher-rank taxonomy ribbons",
    image: `${import.meta.env.BASE_URL}about/example-50k-circular-taxonomy.png`,
    alt: "Circular Big Tree Viewer screenshot showing a mapped 50k-tip tree with taxonomy ribbons.",
    text: "The Taxonomy panel can fetch the NCBI taxonomy and map species names to higher Linnaean ranks. Genus, family, order, class, and phylum are then drawn as colored ribbons, making the broad structure of a species tree readable without panning.",
  },
  {
    title: "Intermediate zoom across multiple ranks",
    image: `${import.meta.env.BASE_URL}about/example-circular-taxonomy-quadrant.png`,
    alt: "Big Tree Viewer screenshot showing one quadrant of a circular vertebrate tree with class, order, and family ribbons and branches colored by class.",
    text: "Zooming into part of the tree exposes finer ranks while keeping coarser ones in view. Here class, order, and family ribbons are visible at the same time, and branches are colored by their assigned class so the taxonomic context is preserved even when only a portion of the tree is on screen.",
  },
  {
    title: "Local detail with global context",
    image: `${import.meta.env.BASE_URL}about/example-50k-primate-ribbons-detail.png`,
    alt: "Big Tree Viewer screenshot showing a zoomed primate clade with species tip labels and four taxonomy ribbons.",
    text: "Zooming into a clade reveals tip labels while the taxonomy ribbons remain aligned with the same tips. Local branch relationships stay anchored to their position in the wider taxonomy.",
  },
  {
    title: "Hundreds of thousands of tips",
    image: `${import.meta.env.BASE_URL}about/tree-200k-rectangular-overview.png`,
    alt: "Rectangular Big Tree Viewer screenshot showing a very large mapped tree with taxonomy ribbons.",
    text: "Layout runs in a Web Worker and rendering is done on a Canvas, so trees with several hundred thousand tips remain responsive on a typical laptop. Pan and zoom recover local detail when needed.",
  },
  {
    title: "Styling and SVG export",
    image: `${import.meta.env.BASE_URL}about/example-50k-style-panel.png`,
    alt: "Big Tree Viewer screenshot showing the style controls panel next to a loaded tree.",
    text: "Typography, branch thickness, ribbon spacing, and metadata overlays are adjusted in the same view used for exploration. The current view can be exported as SVG for use in figures.",
  },
] as const;

const capabilities = [
  {
    label: "Input",
    text: "Newick files loaded from disk, drag-and-drop, or pasted text. Trees are parsed locally; nothing is uploaded.",
  },
  {
    label: "Layouts",
    text: "Rectangular and circular, with input-order and descendant-count tip orderings and continuous rotation in circular mode.",
  },
  {
    label: "Scale",
    text: "Tested with trees from a few hundred to several hundred thousand tips. Parsing and layout run in a Web Worker.",
  },
  {
    label: "Taxonomy",
    text: "Optional NCBI taxonomy download, species-name matching, and ribbons for genus through phylum. Ranks can be collapsed to summarize clades.",
  },
  {
    label: "Metadata",
    text: "CSV/TSV tables can be joined to tip labels to drive label colors, branch colors, and tip markers, with continuous and categorical palettes.",
  },
  {
    label: "Search and navigation",
    text: "Search across tip and internal node names, step through matches, and pin x/y zoom independently in rectangular mode.",
  },
  {
    label: "Export",
    text: "Save the current view as SVG for downstream figure preparation.",
  },
  {
    label: "Privacy",
    text: "Everything runs in the browser. Trees, metadata, and taxonomy mappings stay on your machine.",
  },
] as const;

export default function AboutPage() {
  return (
    <main className="about-page">
      <div className="about-page-frame">
        <header className="about-header">
          <div>
            <p className="about-kicker">Big Tree Viewer</p>
            <h1>About</h1>
            <p className="about-author-line">
              Big Tree Viewer is developed by John Allard in the{" "}
              <a href="https://www.kumarlab.net/" target="_blank" rel="noreferrer">Kumar lab</a>{" "}
              at the Institute for Genomics and Evolutionary Medicine, Temple University.
            </p>
          </div>
          <a className="about-top-link" href={`${import.meta.env.BASE_URL}#`}>
            Back to viewer
          </a>
        </header>

        <section className="about-intro">
          <div className="about-intro-copy">
            <h2>A browser-based viewer for very large phylogenies.</h2>
            <p className="about-lead">{HOME_DESCRIPTION}</p>
            <p className="about-lead">
              The viewer is intended for trees that are too large to be useful in
              traditional desktop tools&mdash;tens of thousands to several hundred
              thousand tips&mdash;where readable structure depends on summarizing
              tip labels into taxonomy bands and ribbons. Trees are parsed and
              rendered locally in the browser, so no data is uploaded.
            </p>
          </div>
          <figure className="about-hero-figure">
            <img src={figureSections[0].image} alt={figureSections[0].alt} />
            <figcaption>{figureSections[0].text}</figcaption>
          </figure>
        </section>

        <section className="about-figure-sections">
          {figureSections.slice(1).map((item, index) => (
            <section
              key={item.title}
              className={`about-figure-section${index % 2 === 1 ? " reverse" : ""}`}
            >
              <figure className="about-gallery-card">
                <img src={item.image} alt={item.alt} loading="lazy" />
              </figure>
              <div className="about-figure-copy">
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </div>
            </section>
          ))}
        </section>

        <section className="about-capabilities">
          <h2>At a glance</h2>
          <dl className="about-capability-list">
            {capabilities.map((item) => (
              <div key={item.label} className="about-capability-row">
                <dt>{item.label}</dt>
                <dd>{item.text}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="about-colophon">
          <h2>Notes</h2>
          <p>
            Big Tree Viewer is a research tool under active development. Layouts
            and rendering are tuned for interactive use at large scale; some
            features common in smaller-tree viewers (e.g.&nbsp;per-edge
            annotations, tree editing) are intentionally out of scope. 
          </p>
        </section>
      </div>
    </main>
  );
}
