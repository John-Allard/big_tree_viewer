export default function FaqPage() {
  return (
    <main className="about-page faq-page">
      <div className="about-page-frame">
        <nav className="site-doc-nav" aria-label="Documentation">
          <a href={`${import.meta.env.BASE_URL}#`}>Viewer</a>
          <a href={`${import.meta.env.BASE_URL}#about`}>About</a>
          <a href={`${import.meta.env.BASE_URL}#faq`} aria-current="page">FAQ</a>
          <a href={`${import.meta.env.BASE_URL}#share`}>Share sessions</a>
          <a href={`${import.meta.env.BASE_URL}#api`}>API</a>
          <a href={`${import.meta.env.BASE_URL}#agentic-ai`}>Agentic AI</a>
        </nav>

        <header className="about-header">
          <div>
            <p className="about-kicker">Big Tree Viewer</p>
            <h1>Frequently asked questions</h1>
          </div>
          <a className="about-top-link" href={`${import.meta.env.BASE_URL}#`}>
            Back to viewer
          </a>
        </header>

        <section className="faq-list">
          <article className="faq-entry">
            <h2>What is the tree that loads automatically when you go to BigTreeViewer.net?</h2>
            <figure className="about-gallery-card faq-figure">
              <div className="about-media-frame">
                <img
                  src={`${import.meta.env.BASE_URL}about/example-50k-circular-taxonomy.png`}
                  alt="Circular Big Tree Viewer screenshot of the automatically loaded vertebrate example tree with taxonomy mapped."
                  loading="eager"
                />
              </div>
            </figure>
            <div className="faq-answer">
              <p>
                The tree that loads automatically when you first go to
                BigTreeViewer.net is an early version of a vertebrate tree from a
                forthcoming paper that is currently in preparation. We have
                included it as an example so that users can try out the features
                of BigTreeViewer.net using a relatively large-scale tree (over
                50,000 species).
              </p>
              <p>
                It has many known issues and should not be interpreted as a gold
                standard vertebrate phylogeny. The taxonomy-mapped view shown
                here is intended to make the example tree easier to explore and
                to demonstrate how family-level and broader taxonomic structure
                can be displayed in the viewer.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>What kinds of tree files can I load?</h2>
            <div className="faq-answer">
              <p>
                Big Tree Viewer can load Newick and NEXUS tree files, including
                trees opened from disk, dragged into the browser, or pasted as
                text. Saved Big Tree Viewer session files use the
                <code>.btvsession</code> extension and can restore the tree,
                display settings, metadata, taxonomy mapping, silhouettes, and
                viewport.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>Are my trees or metadata uploaded anywhere?</h2>
            <div className="faq-answer">
              <p>
                No. Tree parsing, rendering, metadata handling, saved sessions,
                taxonomy mappings, and cached taxonomy data are handled locally
                in your browser. Big Tree Viewer does not require uploading your
                tree or metadata to a server.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>Will Big Tree Viewer ever cost money?</h2>
            <div className="faq-answer">
              <p>No.</p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>How do I add metadata to a tree?</h2>
            <div className="faq-answer">
              <p>
                Load a CSV or TSV table with one row per tip or node. Include a
                column containing labels that match the labels in the tree
                exactly, then choose that column under <strong>Match tree labels
                by column</strong>. Other columns can be used for branch colors,
                text labels, or markers.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>How does taxonomy mapping work?</h2>
            <div className="faq-answer">
              <p>
                The Taxonomy panel downloads the NCBI taxonomy dump and caches it
                locally in the browser. Big Tree Viewer maps binomial species
                names and exact single-token{" "}
                <a href="https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi" target="_blank" rel="noreferrer">
                  NCBI Taxonomy Browser
                </a>{" "}
                taxon names, such as genus, family, or order names. Once mapped,
                taxonomy can be used for ribbons, branch coloring, collapsed
                taxonomic views, and{" "}
                <a href="https://www.phylopic.org/" target="_blank" rel="noreferrer">PhyloPic</a>{" "}
                silhouette retrieval.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>Why are some taxa unmapped?</h2>
            <div className="faq-answer">
              <p>
                Taxa may remain unmapped if tree labels are accession IDs,
                sample IDs, strain names, misspelled names, unsupported synonyms,
                ambiguous names, or names that are not present in the{" "}
                <a href="https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi" target="_blank" rel="noreferrer">
                  NCBI Taxonomy Browser
                </a>
                . Single-token labels only map when they exactly match a
                supported NCBI taxon name.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>What are taxonomy ribbons and branch coloring?</h2>
            <div className="faq-answer">
              <p>
                Taxonomy ribbons are colored bands that mark mapped taxonomic
                groups across the tree. Branch coloring can use the same mapped
                taxonomy to color branches by group. You can let Big Tree Viewer
                choose visible ranks automatically, choose ranks manually, adjust
                the palette, and collapse mapped tips to higher taxonomic ranks.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>What are PhyloPic silhouettes and how should attribution be used?</h2>
            <div className="faq-answer">
              <p>
                <a href="https://www.phylopic.org/" target="_blank" rel="noreferrer">PhyloPic</a>{" "}
                silhouettes are organism silhouettes retrieved for mapped
                taxonomy labels. Big Tree Viewer uses
                publication-compatible licenses, caches successful silhouettes in
                the browser, and generates compact attribution text. Required
                attribution is shown separately from additional non-required
                attribution for CC0 or public domain images.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>How do I save or share a finished view?</h2>
            <div className="faq-answer">
              <p>
                <strong>Export View</strong> saves the current view as a PNG or
                SVG figure. <strong>Save Session</strong> saves a
                <code>.btvsession</code> file containing the tree, settings,
                metadata, taxonomy mapping, silhouettes, manual colors, collapsed
                clades, and viewport. A session file can also be hosted at a
                static URL and opened through a{" "}
                <a href={`${import.meta.env.BASE_URL}#share`}>Big Tree Viewer share link</a>.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>What is the difference between saving settings and saving a session?</h2>
            <div className="faq-answer">
              <p>
                <strong>Save Session</strong> creates a <code>.btvsession</code>
                file containing the current tree plus the current view state,
                display settings, metadata, taxonomy mapping, PhyloPic
                silhouettes, manual colors, collapsed clades, and viewport. Use
                it when you want to reopen or share the same tree in the same
                configured state.
              </p>
              <p>
                <strong>Load Settings</strong> reads reusable display settings
                from a session file and applies them to the tree that is already
                open. It is useful when you want to reuse a visual style,
                palette, label configuration, or export setup on a different
                tree without replacing the current tree. <strong>Load
                Session</strong> loads the full saved session, including the
                saved tree when the session contains one.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>How large a tree can Big Tree Viewer handle?</h2>
            <div className="faq-answer">
              <p>
                Performance depends on the number of tips, the browser, available
                RAM, CPU and GPU speed, display resolution, and which overlays
                are enabled. Big Tree Viewer should be fine up to a few hundred
                thousand tips. With taxonomy mapping, performance may slow down
                depending on the system, but on a modern computer performance is
                good with taxonomy mappings past 200,000 tips. Panning, dense
                label rendering, and very large SVG exports may
                lag on lower-memory or older systems.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>What is the difference between rectangular, circular, and spiral views?</h2>
            <div className="faq-answer">
              <p>
                Rectangular view is useful for local detail and independent x/y
                zoom. Circular view is useful for compact whole-tree figures.
                Spiral view is intended for time-calibrated trees where deep
                time and recent tips need to share the same figure.
              </p>
            </div>
          </article>

          <article className="faq-entry">
            <h2>How should I cite Big Tree Viewer?</h2>
            <div className="faq-answer">
              <p>
                A paper is forthcoming:
              </p>
              <p>
                <strong>BigTreeViewer: A browser-based viewer and figure
                renderer for ultra-large phylogenetic trees</strong>
                <br />
                John B. Allard and Sudhir Kumar. 2026. In preparation.
              </p>
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
