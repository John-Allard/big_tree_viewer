const base = import.meta.env.BASE_URL;
const assetBase = `${base}tutorial/metadata/`;

export default function MetadataGuidePage() {
  return (
    <main className="about-page metadata-guide-page">
      <div className="about-page-frame">
        <nav className="site-doc-nav" aria-label="Documentation">
          <a href={`${base}#`}>Viewer</a>
          <a href={`${base}#about`}>About</a>
          <a href={`${base}#faq`}>FAQ</a>
          <a href={`${base}#metadata`} aria-current="page">Metadata</a>
          <a href={`${base}#share`}>Share sessions</a>
          <a href={`${base}#desktop`}>Desktop app</a>
          <a href={`${base}#api`}>API</a>
          <a href={`${base}#agentic-ai`}>Agentic AI</a>
        </nav>

        <header className="about-header">
          <div>
            <p className="about-kicker">Big Tree Viewer</p>
            <h1>Using metadata</h1>
            <p className="about-author-line">
              Big Tree Viewer can display data about species and nodes and
              branches in your tree. Load a CSV or TSV file that contains a
              column with labels that match internal node labels or TIP labels
              and then the other columns containing data can be used to display
              markers, colored branches, pie charts, bars, heat maps, and
              categorical tip tables.
            </p>
          </div>
          <a className="about-top-link" href={`${base}#`}>Back to viewer</a>
        </header>

        <section className="metadata-guide-section metadata-guide-first-section">
          <div className="metadata-guide-heading">
            <p className="metadata-guide-step">1</p>
            <div>
              <h2>Prepare the table</h2>
              <p>
                Use one row per tree tip or named internal node. Put column
                names in the first row and include one dedicated key column.
                Every value in that key column must match a tree label exactly,
                including capitalization, punctuation, spaces, and underscores.
                For example, <code>species_A</code> does not match <code>Species_A</code>.
              </p>
            </div>
          </div>

          <figure className="metadata-guide-figure metadata-guide-table-figure">
            <img
              src={`${assetBase}metadata-table.png`}
              alt="Spreadsheet-style view of synthetic metadata for species A through P. The species key column is followed by categorical, continuous, and composition columns."
              loading="eager"
            />
            <figcaption>
              <code>species</code> is the matching key. The remaining columns
              contain categorical values, a continuous measurement, and four
              numeric pie components.
            </figcaption>
          </figure>

          <dl className="metadata-guide-data-types">
            <div><dt>Categorical</dt><dd>Text values such as activity pattern or cohort.</dd></div>
            <div><dt>Continuous</dt><dd>Numeric measurements such as a trait value or expression level.</dd></div>
            <div><dt>Pie components</dt><dd>Adjacent numeric columns whose values define each node&apos;s slices.</dd></div>
            <div><dt>Tip tables</dt><dd>Numeric or categorical columns aligned beside rectangular tip labels.</dd></div>
          </dl>
        </section>

        <section className="metadata-guide-section">
          <div className="metadata-guide-heading">
            <p className="metadata-guide-step">2</p>
            <div>
              <h2>Load and match the rows</h2>
              <p>
                Load the tree first. Open the <strong>Metadata</strong> section,
                select <strong>Open CSV / TSV</strong>, and choose the table.
                Leave <strong>Treat first line as a header</strong> selected when
                the first row contains column names. Under <strong>Match tree
                labels by column</strong>, choose the key column containing the
                exact tree labels.
              </p>
            </div>
          </div>

          <div className="metadata-guide-panel-steps">
            <figure className="metadata-guide-panel-figure">
              <img
                src={`${assetBase}metadata-panel-empty.png`}
                alt="Closed-width Metadata panel showing the Open CSV or TSV button before a table has been loaded."
                loading="lazy"
              />
              <figcaption>Open the Metadata section and select the table.</figcaption>
            </figure>
            <figure className="metadata-guide-panel-figure">
              <img
                src={`${assetBase}metadata-panel-loaded.png`}
                alt="Metadata panel after loading the synthetic table, with species selected as the matching column and 16 matched rows reported."
                loading="lazy"
              />
              <figcaption>Select the key column and confirm the matched-row count.</figcaption>
            </figure>
          </div>

          <p className="metadata-guide-note">
            If rows do not match, expand <strong>Unmapped rows</strong> in the
            panel. The preview shows the selected key and row values; <strong>Export
            Full List</strong> writes every unmatched row to CSV.
          </p>
        </section>

        <section className="metadata-guide-section">
          <div className="metadata-guide-heading">
            <p className="metadata-guide-step">3</p>
            <div>
              <h2>Choose an overlay</h2>
              <p>
                Overlays can be enabled independently. Select the gear beside an
                enabled overlay to choose its source column and display options.
              </p>
            </div>
          </div>

          <div className="metadata-guide-option-table" role="table" aria-label="Metadata overlay options">
            <div className="metadata-guide-option-row metadata-guide-option-header" role="row">
              <span role="columnheader">Overlay</span>
              <span role="columnheader">Input</span>
              <span role="columnheader">Options</span>
            </div>
            <div className="metadata-guide-option-row" role="row">
              <strong role="cell">Branch colors</strong>
              <span role="cell">Categorical or numeric column</span>
              <span role="cell">Matched branch or matched subtree; categorical or continuous palette.</span>
            </div>
            <div className="metadata-guide-option-row" role="row">
              <strong role="cell">Text labels</strong>
              <span role="cell">Any display column</span>
              <span role="cell">Font, size, count limit, spacing, and x/y offsets.</span>
            </div>
            <div className="metadata-guide-option-row" role="row">
              <strong role="cell">Markers</strong>
              <span role="cell">Categorical column</span>
              <span role="cell">Color, shape, and adaptive size for each category.</span>
            </div>
            <div className="metadata-guide-option-row" role="row">
              <strong role="cell">Pie charts</strong>
              <span role="cell">Contiguous numeric columns</span>
              <span role="cell">First and last column, slice palette, individual colors, and size.</span>
            </div>
            <div className="metadata-guide-option-row" role="row">
              <strong role="cell">Tip data table</strong>
              <span role="cell">One or more tip-level columns</span>
              <span role="cell">Horizontal bars, numeric heat maps, or categorical cells beside rectangular tip labels.</span>
            </div>
          </div>

          <p className="metadata-guide-note">
            <strong>Matched branches</strong> colors only each matched tip or
            node branch. <strong>Matched subtrees</strong> also colors every
            descendant branch. Continuous colors support linear, square-root,
            and log transforms plus optional minimum and maximum clamps.
          </p>
        </section>

        <section className="metadata-guide-section">
          <div className="metadata-guide-heading">
            <p className="metadata-guide-step">4</p>
            <div>
              <h2>Review the result</h2>
              <p>
                Check that the selected column and visual encoding represent the
                intended variable. These views use the same example table.
              </p>
            </div>
          </div>

          <div className="metadata-guide-example-grid">
            <figure className="metadata-guide-figure">
              <img
                src={`${assetBase}metadata-categorical-branches.png`}
                alt="Rectangular synthetic tree with terminal branches colored categorically by study cohort."
                loading="lazy"
              />
              <figcaption>Categorical branch colors: <code>study_cohort</code>.</figcaption>
            </figure>
            <figure className="metadata-guide-figure">
              <img
                src={`${assetBase}metadata-continuous-branches.png`}
                alt="Rectangular synthetic tree with terminal branches colored continuously by a simulated trait value."
                loading="lazy"
              />
              <figcaption>Continuous branch colors: <code>trait_value</code>.</figcaption>
            </figure>
            <figure className="metadata-guide-figure">
              <img
                src={`${assetBase}metadata-markers.png`}
                alt="Rectangular synthetic tree with colored shape markers at tips indicating habitat categories."
                loading="lazy"
              />
              <figcaption>Categorical markers: <code>habitat</code>.</figcaption>
            </figure>
            <figure className="metadata-guide-figure">
              <img
                src={`${assetBase}metadata-pie-charts.png`}
                alt="Circular synthetic tree with four-slice simulated composition pie charts at every tip."
                loading="lazy"
              />
              <figcaption>Pie charts: <code>A_pct</code> through <code>T_pct</code>.</figcaption>
            </figure>
          </div>

          <h3 className="metadata-guide-subheading">Tip-aligned displays</h3>
          <div className="metadata-guide-example-grid metadata-guide-example-grid-three">
            <figure className="metadata-guide-figure">
              <img
                src={`${assetBase}metadata-tip-bars.png`}
                alt="Rectangular synthetic tree with a horizontal quantitative bar aligned to every tip label."
                loading="lazy"
              />
              <figcaption>Horizontal bars: <code>trait_value</code>.</figcaption>
            </figure>
            <figure className="metadata-guide-figure">
              <img
                src={`${assetBase}metadata-tip-heatmap.png`}
                alt="Rectangular synthetic tree with five numeric heat-map columns aligned to the tip labels."
                loading="lazy"
              />
              <figcaption>Heat map: five numeric columns.</figcaption>
            </figure>
            <figure className="metadata-guide-figure">
              <img
                src={`${assetBase}metadata-tip-categorical.png`}
                alt="Rectangular synthetic tree with filled categorical cells for habitat and study cohort aligned to the tip labels."
                loading="lazy"
              />
              <figcaption>Categorical cells: <code>habitat</code> and <code>study_cohort</code>.</figcaption>
            </figure>
          </div>
        </section>

        <section className="metadata-guide-section metadata-guide-finish">
          <h2>Save or export</h2>
          <p>
            <strong>Save Session</strong> stores the table, matching column,
            overlay settings, tree, and current view. <strong>Export View</strong>
            writes the current rendered figure as PNG or SVG.
          </p>
        </section>
      </div>
    </main>
  );
}
