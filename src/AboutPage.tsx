import { useEffect, useRef, useState } from "react";
import { HOME_DESCRIPTION } from "./siteCopy";

const figureSections = [
  {
    title: "Genus bands at low zoom",
    image: `${import.meta.env.BASE_URL}about/example-50k-genus-bands.png`,
    alt: "Circular Big Tree Viewer screenshot showing a 50k-tip tree with genus labels around the perimeter.",
    text: "Individual tip labels are not legible when a tree with tens of thousands of tips is fit to the screen. When binomial species names are detected, genera are inferred from the tip labels and drawn as bands along the tip axis, giving readable structure at any zoom level.",
  },
  {
    title: "Tip labels appear as you zoom in",
    videoWebm: `${import.meta.env.BASE_URL}about/example-rectangular-tip-labels-zoom.webm`,
    videoMp4: `${import.meta.env.BASE_URL}about/example-rectangular-tip-labels-zoom.mp4`,
    poster: `${import.meta.env.BASE_URL}about/example-rectangular-tip-labels-zoom-poster.webp`,
    alt: "Animated rectangular Big Tree Viewer view zooming from the full 50,062-tip example tree into the hominoid region until tip labels appear.",
    text: "Dense trees are summarized at low magnification, then individual species names appear as you zoom into a local region.",
  },
  {
    title: "Automatically map taxonomy and display ribbons",
    image: `${import.meta.env.BASE_URL}about/example-50k-circular-taxonomy.png`,
    alt: "Circular Big Tree Viewer screenshot showing a mapped 50k-tip tree with taxonomy ribbons.",
    text: "The Taxonomy panel can map species names with NCBI Taxonomy or Catalogue of Life. Genus, family, order, class, and phylum can then be drawn as colored ribbons; kingdom is available as an optional rank when multiple kingdoms are present.",
  },
  {
    title: "Smoothly zoom in to display taxonomy detail",
    image: `${import.meta.env.BASE_URL}about/example-circular-taxonomy-quadrant.png`,
    alt: "Big Tree Viewer screenshot showing one quadrant of a circular vertebrate tree with class, order, and family ribbons and branches colored by class.",
    text: "Zooming into part of the tree exposes finer ranks while keeping coarser ones in view. Daughter taxa inherit color from their parent taxon with adjustable jitter; users can choose a built-in palette, define a custom palette, and control the palette anchor rank.",
  },
  {
    title: "Local detail with global context",
    videoWebm: `${import.meta.env.BASE_URL}about/example-50k-primate-ribbons-context-zoom.webm`,
    videoMp4: `${import.meta.env.BASE_URL}about/example-50k-primate-ribbons-context-zoom.mp4`,
    poster: `${import.meta.env.BASE_URL}about/example-50k-primate-ribbons-context-zoom-poster.webp`,
    alt: "Animated rectangular Big Tree Viewer view showing primate tip labels and taxonomy ribbons while zooming out first on the x axis and then on the y axis.",
    text: "In rectangular mode, x and y zoom can be adjusted independently. Zooming out along x first, then y, reveals broader branch-length and taxonomic context while keeping local tip and ribbon alignment clear.",
  },
  {
    title: "Spiral layout for immense trees",
    image: `${import.meta.env.BASE_URL}about/example-50k-spiral-taxonomy.png`,
    alt: "Big Tree Viewer screenshot showing a 50,062-tip taxonomy-mapped tree arranged as a multilevel spiral.",
    text: "Spiral mode distributes very large trees across multiple turns, using more of the available screen area while retaining branch-length structure, taxonomy ribbons, and smooth access to local detail.",
    crop: "cover",
  },
  {
    title: "Map metadata onto trees",
    images: [
      {
        src: `${import.meta.env.BASE_URL}about/example-50k-metadata-overlay.png`,
        alt: "Big Tree Viewer screenshot showing a circular tree with CSV metadata coloring branches gray and blue, with the Metadata panel open.",
      },
      {
        src: `${import.meta.env.BASE_URL}about/example-metadata-pie-charts.png`,
        alt: "Circular Big Tree Viewer tree with multicolored pie charts showing four metadata values at each tip.",
      },
    ],
    alt: "Two Big Tree Viewer metadata examples showing branch coloring and per-tip pie charts.",
    text: "CSV or TSV metadata can color branches, add labels and markers, display several numeric values as pie charts, or place bars, heat maps, and categorical cells beside rectangular tip labels. The examples show a binary branch-color overlay and four-part composition data.",
    wide: true,
  },
  {
    title: "Hundreds of thousands of tips",
    image: `${import.meta.env.BASE_URL}about/tree-200k-rectangular-overview.png`,
    alt: "Rectangular Big Tree Viewer screenshot showing a very large mapped tree with taxonomy ribbons.",
    text: "Display is highly optimized for performance, so trees with several hundred thousand tips remain responsive on a typical computer. Pan and zoom recover local detail when needed.",
  },
  {
    title: "Styling and image export",
    videoWebm: `${import.meta.env.BASE_URL}about/example-50k-style-panel.webm`,
    videoMp4: `${import.meta.env.BASE_URL}about/example-50k-style-panel.mp4`,
    poster: `${import.meta.env.BASE_URL}about/example-50k-style-panel-poster.webp`,
    alt: "Animated Big Tree Viewer view showing styling controls changing taxonomy palettes, visible ribbons, branch thickness, and time stripe settings.",
    text: "Typography, branch thickness, ribbon spacing, metadata overlays and many other settings are adjusted in the same view used for exploration. The current view can be exported as PNG or SVG for use in figures.",
  },
] as const;

type AboutFigure = {
  title: string;
  alt: string;
  text: string;
  image?: string;
  images?: readonly {
    src: string;
    alt: string;
  }[];
  videoWebm?: string;
  videoMp4?: string;
  poster?: string;
  wide?: boolean;
  crop?: "cover";
};

function AboutMedia({ item, eager = false }: { item: AboutFigure; eager?: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [shouldLoadVideo, setShouldLoadVideo] = useState(eager);
  const isVideo = Boolean(item.videoWebm && item.videoMp4 && item.poster);

  useEffect(() => {
    if (!isVideo || shouldLoadVideo || typeof IntersectionObserver === "undefined") {
      return;
    }
    const node = rootRef.current;
    if (!node) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShouldLoadVideo(true);
        observer.disconnect();
      }
    }, { rootMargin: "700px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [isVideo, shouldLoadVideo]);

  if (item.images && item.images.length > 0) {
    return (
      <div ref={rootRef} className="about-media-frame about-media-frame-pair">
        {item.images.map((image) => (
          <img key={image.src} src={image.src} alt={image.alt} loading={eager ? "eager" : "lazy"} />
        ))}
      </div>
    );
  }

  if (isVideo) {
    return (
      <div ref={rootRef} className="about-media-frame">
        {shouldLoadVideo ? (
          <video
            autoPlay
            loop
            muted
            playsInline
            preload={eager ? "metadata" : "none"}
            poster={item.poster}
            aria-label={item.alt}
          >
            <source src={item.videoWebm} type="video/webm" />
            <source src={item.videoMp4} type="video/mp4" />
          </video>
        ) : (
          <img src={item.poster ?? ""} alt={item.alt} loading="lazy" />
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`about-media-frame${item.crop === "cover" ? " about-media-frame-cover" : ""}`}>
      <img src={item.image ?? ""} alt={item.alt} loading={eager ? "eager" : "lazy"} />
    </div>
  );
}

const capabilities = [
  {
    label: "Input",
    text: "Newick files loaded from disk, drag-and-drop, or pasted text. Trees are parsed locally; nothing is uploaded.",
  },
  {
    label: "Layouts",
    text: "Rectangular, radial, and spiral geometries, with adjustable radial span and inner radius, input-order and descendant-count tip orderings, and continuous rotation in radial modes.",
  },
  {
    label: "Scale",
    text: "Tested with trees from a few hundred to several hundred thousand tips. Parsing and layout run in a Web Worker.",
  },
  {
    label: "Taxonomy",
    text: "Optional NCBI Taxonomy or Catalogue of Life mapping, species-name matching, ribbons for genus through phylum, and optional kingdom ribbons. Ranks can be collapsed to summarize clades.",
  },
  {
    label: "Metadata",
    text: "CSV/TSV tables can drive branch colors, labels, markers, multivalue pie charts, and tip-aligned bars, heat maps, or categorical tables.",
  },
  {
    label: "Node annotations",
    text: "Display internal labels, bootstrap support, node heights, and annotated node-height intervals with configurable labels and error-bar styles.",
  },
  {
    label: "Tree comparison",
    text: "Compare two trees as a tanglegram, optimize the right-hand tip order, inspect incompatible splits, and calculate shared-tip Robinson-Foulds statistics.",
  },
  {
    label: "Analysis",
    text: "Inspect whole-tree or selected-subtree statistics and interactively measure patristic distance while highlighting the connecting path.",
  },
  {
    label: "Search and navigation",
    text: "Search across tip and internal node names, step through matches, and pin x/y zoom independently in rectangular mode.",
  },
  {
    label: "Export",
    text: "Save the current view as PNG or SVG, or save a compressed session containing the tree, mappings, metadata, comparison state, and viewport.",
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
        <nav className="site-doc-nav" aria-label="Documentation">
          <a href={`${import.meta.env.BASE_URL}#`}>Viewer</a>
          <a href={`${import.meta.env.BASE_URL}#about`} aria-current="page">About</a>
          <a href={`${import.meta.env.BASE_URL}#faq`}>FAQ</a>
          <a href={`${import.meta.env.BASE_URL}#metadata`}>Metadata</a>
          <a href={`${import.meta.env.BASE_URL}#share`}>Share sessions</a>
          <a href={`${import.meta.env.BASE_URL}#desktop`}>Desktop app</a>
          <a href={`${import.meta.env.BASE_URL}#api`}>API</a>
          <a href={`${import.meta.env.BASE_URL}#agentic-ai`}>Agentic AI</a>
        </nav>
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
          <div className="about-header-actions">
            <a className="about-top-link" href={`${import.meta.env.BASE_URL}#`}>
              Back to viewer
            </a>
            <span aria-hidden="true">|</span>
            <a className="about-top-link" href={`${import.meta.env.BASE_URL}#tutorial`}>
              Start tutorial
            </a>
          </div>
        </header>

        <section className="about-intro">
          <div className="about-intro-copy">
            <h2>A browser-based viewer for very large phylogenies.</h2>
            <p className="about-lead">{HOME_DESCRIPTION}</p>
          </div>
          <figure className="about-hero-figure">
            <AboutMedia item={figureSections[0]} eager />
            <figcaption>{figureSections[0].text}</figcaption>
          </figure>
        </section>

        <section className="about-figure-sections">
          {figureSections.slice(1).map((item, index) => (
            <section
              key={item.title}
              className={`about-figure-section${index % 2 === 1 ? " reverse" : ""}${"wide" in item && item.wide ? " wide" : ""}`}
            >
              <figure className="about-gallery-card">
                <AboutMedia item={item} />
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
            Big Tree Viewer is a research tool under active development. If you
            have a bug report or feature request, please let me know at
            john.allard@temple.edu
          </p>
        </section>
      </div>
    </main>
  );
}
