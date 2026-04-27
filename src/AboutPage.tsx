import { HOME_DESCRIPTION } from "./siteCopy";

const galleryItems = [
  {
    title: "50k tips, circular overview",
    image: `${import.meta.env.BASE_URL}about/example-50k-circular-taxonomy.png`,
    alt: "Circular Big Tree Viewer screenshot showing a mapped 50k-tip tree with taxonomy ribbons.",
    text: "A full circular overview with taxonomy ribbons turned on. This is the fastest way to assess broad clade structure at a glance.",
  },
  {
    title: "210k tips, rectangular overview",
    image: `${import.meta.env.BASE_URL}about/tree-200k-rectangular-overview.png`,
    alt: "Rectangular Big Tree Viewer screenshot showing a very large mapped tree with taxonomy ribbons.",
    text: "A large rectangular fit view. Rectangular layout is useful for scanning branch density, long stems, and major high-level divisions in extremely large trees.",
  },
  {
    title: "210k tips, circular detail",
    image: `${import.meta.env.BASE_URL}about/tree-200k-circular-detail.png`,
    alt: "Detailed circular Big Tree Viewer screenshot showing a zoomed region with taxonomy overlays.",
    text: "The same large tree after zooming into a local region. Labels and ribbons reveal progressively as the geometry becomes readable.",
  },
  {
    title: "Viewer controls and figure styling",
    image: `${import.meta.env.BASE_URL}about/example-50k-style-panel.png`,
    alt: "Big Tree Viewer screenshot showing the style controls panel next to a loaded tree.",
    text: "Typography, branch width, taxonomy spacing, metadata overlays, and export behavior can all be tuned directly in the viewer before saving figures.",
  },
] as const;

const sections = [
  {
    heading: "Local-first workflow",
    text: "Big Tree Viewer runs in the browser and opens local Newick trees directly. You can inspect large trees without sending data to a remote service.",
  },
  {
    heading: "Taxonomy mapping",
    text: "Species names can be mapped automatically to NCBI taxonomy and displayed as ribbons in both rectangular and circular layouts. The ribbons remain useful from fit view through deeper zoom.",
  },
  {
    heading: "Large-tree navigation",
    text: "The viewer is designed to stay responsive on trees large enough that most of the structure is only meaningful after selective zooming, panning, and layout switching.",
  },
  {
    heading: "Figure preparation",
    text: "Label styling, branch thickness, taxonomy spacing, metadata annotations, subtree extraction, and SVG export are built into the same interface used for exploration.",
  },
] as const;

const workflow = [
  {
    title: "1. Load a tree",
    text: "Begin with the bundled example or open a local file. Rectangular view is often the most efficient starting point for initial inspection.",
  },
  {
    title: "2. Add taxonomy if needed",
    text: "Download the taxonomy once, map names, and turn on taxonomy overlays. The viewer will show only the ranks that are visually meaningful at the current zoom.",
  },
  {
    title: "3. Refine the view for communication",
    text: "Switch to circular layout for compact overviews, adjust typography and spacing, and export the current viewport as an SVG figure.",
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
          </div>
          <a className="about-top-link" href={`${import.meta.env.BASE_URL}#`}>
            Back to viewer
          </a>
        </header>

        <section className="about-intro">
          <div className="about-intro-copy">
            <h2>Explore very large phylogenetic trees directly in the browser.</h2>
            <p className="about-lead">{HOME_DESCRIPTION}</p>
          </div>
          <figure className="about-hero-figure">
            <img src={galleryItems[0].image} alt={galleryItems[0].alt} />
            <figcaption>{galleryItems[0].text}</figcaption>
          </figure>
        </section>

        <section className="about-text-section">
          <h3>What the viewer is for</h3>
          <div className="about-text-grid">
            {sections.map((section) => (
              <article key={section.heading} className="about-text-card">
                <h4>{section.heading}</h4>
                <p>{section.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="about-text-section">
          <h3>Typical workflow</h3>
          <div className="about-workflow-list">
            {workflow.map((item) => (
              <article key={item.title} className="about-workflow-item">
                <h4>{item.title}</h4>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="about-text-section">
          <h3>Examples</h3>
          <div className="about-gallery-grid">
            {galleryItems.map((item) => (
              <figure key={item.title} className="about-gallery-card">
                <img src={item.image} alt={item.alt} loading="lazy" />
                <figcaption>
                  <strong>{item.title}</strong>
                  <span>{item.text}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
