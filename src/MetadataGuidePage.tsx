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
              categorical tip tables. The same table can also supply displayed
              tip names, clade groups, NCBI TaxIDs, or custom taxonomy ranks.
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
            <div><dt>Dates</dt><dd>ISO years, months, or days colored in chronological order.</dd></div>
            <div><dt>Pie components</dt><dd>Adjacent numeric columns whose values define each node&apos;s slices.</dd></div>
            <div><dt>Tip tables</dt><dd>Numeric or categorical columns aligned beside rectangular tip labels.</dd></div>
          </dl>

          <h3 className="metadata-guide-subheading">One table, several uses</h3>
          <p>
            An existing sample table can keep sequence IDs, display names,
            collection information, and taxonomy together. For example, use
            <code> seq_id</code> as the matching key for this table; the tree
            should retain those original sequence IDs as its tip labels.
          </p>
          <pre style={{ maxWidth: "100%", overflowX: "auto" }}><code>{`seq_id,display_name,country,date,ncbi_taxid,genus,family
seq_001,Human sample A,UK,2024-02-29,9606,Homo,Hominidae
seq_002,Human sample B,UK,2024-03,9606,Homo,Hominidae
seq_003,Chimpanzee sample,Uganda,2023,9598,Pan,Hominidae`}</code></pre>
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
          <p>
            You can also select <strong>Open label mapping file</strong> in the
            tip-label detail settings under <strong>Visual Options</strong>, or
            <strong> Open taxonomy mapping file</strong> under <strong>Taxonomy</strong>.
            These buttons load the same shared metadata table, replacing any
            previously loaded table; they do not create independent mappings.
            The <strong>Mapping key column</strong> in Taxonomy is shared with
            Metadata and alternative tip labels. Set it to <code>seq_id</code>
            for the example above, then reuse the table for each display.
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
              <span role="cell">Categorical, numeric, or ISO date column</span>
              <span role="cell">Matched branch or matched subtree; categorical, continuous, or chronological date colors.</span>
            </div>
            <div className="metadata-guide-option-row" role="row">
              <strong role="cell">Text labels</strong>
              <span role="cell">Any display column</span>
              <span role="cell">Font, size, count limit, spacing, and offsets. Label named internal nodes beside the node or incoming branch; match the branch color or choose a fixed color. Automatic placement fits labels along sufficiently long incoming branches, otherwise above the crossbar and to one side of the parent stem. Placement is recalculated as you zoom. Circular incoming-branch labels support radial or tangential orientation. All circular and fan metadata-label offsets are angular (degrees around the center, bounded to ±180°) or radial (pixels toward or away from the center), for both node and incoming-branch placement.</span>
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
              <span role="cell">Horizontal bars, numeric or date heat maps, or categorical cells beside rectangular tip labels.</span>
            </div>
          </div>

          <p className="metadata-guide-note">
            <strong>Matched branches</strong> colors only each matched tip or
            node branch. <strong>Matched subtrees</strong> also colors every
            descendant branch. Continuous colors support linear, square-root,
            and log transforms plus optional minimum and maximum clamps.
          </p>

          <h3 className="metadata-guide-subheading">Chronological date colors</h3>
          <p>
            Select the <code>date</code> column and choose <strong>Chronological
            dates</strong> as the color mode (<code>colorMode: &quot;date&quot;</code>
            in the launch API). Accepted formats are <code>YYYY</code>,
            <code> YYYY-MM</code>, and <code>YYYY-MM-DD</code>, for example
            <code> 2024</code>, <code>2024-03</code>, and <code>2024-02-29</code>.
            Dates are validated in UTC, including leap years. Slash-separated
            dates, ambiguous US-style dates, timestamps, and impossible dates
            such as <code>2023-02-29</code> are rejected; invalid or missing dates
            receive no metadata color.
          </p>
          <p>
            Partial dates are approximations: a year uses January 1 and a
            year-month uses the first day of that month. Colors follow elapsed
            calendar time on a linear scale, not alphabetical order. Date mode
            uses the same <strong>Palette</strong> choices as numeric colors:
            Blue to orange, Viridis, Red to blue, and Teal to rose. Reverse the
            scale to swap the early and late colors. Enter ISO dates in
            <strong> Clamp minimum</strong> and <strong>Clamp maximum</strong>,
            or leave them blank for the data bounds; dates outside the bounds
            use the nearest endpoint color. Legend bounds are displayed as dates.
          </p>
          <p>
            For a tip heat map, set the date column&apos;s value type to dates
            (<code>valueType: &quot;date&quot;</code> in
            <code> visual.metadataTipTableColumns</code>). This uses chronological
            bounds and the existing heat-map palettes without a separate table mode.
          </p>
          <p>
            Samples collected in different years need not end at the same horizontal
            position. For an already dated tree with branch lengths in years, open
            <strong> Scale labels settings</strong>, enter its <strong>Root calendar
            year</strong>, and enable <strong>Show calendar-year axis</strong> in a
            linear rectangular view. With chronological dates applied to matched
            branches, <strong>Anchor calendar axis from CSV dates</strong> checks
            whether the tip dates agree with branch lengths in years. It declines
            inconsistent or overly imprecise dates. This anchors an existing time
            tree; it does not infer a molecular clock or convert substitutions to
            years. Sampling-date colors remain available on genetic-distance trees.
            The API settings are <code>visual.figureStyles.scale.calendarAxis</code>
            and <code>visual.figureStyles.scale.calendarRootYear</code>.
          </p>
        </section>

        <section className="metadata-guide-section">
          <div className="metadata-guide-heading">
            <p className="metadata-guide-step">4</p>
            <div>
              <h2>Reuse IDs for labels, groups, and taxonomy</h2>
              <p>
                Keep original sequence IDs in the tree and choose other columns
                for display and grouping. All of these mappings use the loaded
                metadata table and its selected key column.
              </p>
            </div>
          </div>
          <h3 className="metadata-guide-subheading">Display names without renaming tips</h3>
          <p>
            In the tip-label detail settings, choose <code>display_name</code>
            under <strong>Tip label source</strong>. This is display-only:
            matching still uses the original tree IDs and exported Newick keeps
            those IDs. Missing display names fall back to the original labels.
            In launch payloads and desktop updates, use
            <code> metadata.tipLabelColumn: &quot;display_name&quot;</code>, which sets
            the same setting as <code>visual.tipLabelMetadataColumn</code>;
            an empty string restores original labels.
          </p>
          <h3 className="metadata-guide-subheading">Collapse uniform clades</h3>
          <p>
            Under <strong>Metadata</strong>, set <strong>Collapse by metadata</strong>
            to <code>country</code> (API:
            <code> metadata.collapseColumn: &quot;country&quot;</code>, equivalent to
            <code> visual.metadataCollapseColumn</code>).
            Only maximal clades with at least two descendant tips sharing the
            same nonempty value are collapsed. A missing value, unmatched tip,
            or conflicting duplicate key blocks collapse of any clade containing
            that tip. Separate occurrences of the same value remain separate
            clades; metadata on an internal node is not inherited by its tips.
            Clear the column to disable metadata grouping.
          </p>
          <h3 className="metadata-guide-subheading">NCBI TaxIDs from a column</h3>
          <p>
            Under <strong>Taxonomy</strong>, choose <strong>NCBI Taxonomy</strong>
            and set <strong>NCBI TaxID column</strong> to <code>ncbi_taxid</code>.
            The IDs in that column,
            rather than display names or sequence IDs, supply the NCBI lookup.
            Use positive integer TaxIDs; empty or unmatched rows remain unmapped.
            This route still requires the NCBI taxonomy database. For launch or
            desktop API mapping, use
            <code> metadata.taxIdColumn: &quot;ncbi_taxid&quot;</code> with
            <code> taxonomy.source: &quot;ncbi&quot;</code> and
            <code> taxonomy.runMapping: true</code>.
            <code> visual.metadataTaxIdColumn</code> only selects the UI control;
            it does not supply CSV IDs to an automatic API mapping request.
          </p>
          <h3 className="metadata-guide-subheading">Custom taxonomy from existing columns</h3>
          <p>
            Expand <strong>Custom taxonomy from metadata</strong> under
            <strong> Taxonomy</strong>, assign <code>genus</code> and
            <code> family</code> to their existing rank slots, and select
            <strong> Apply custom taxonomy ribbons</strong>. No taxonomy database
            or TaxID column is required for this route. Use
            <strong> Additional custom rank</strong> for other supported rank
            slots; arbitrary new rank names are not created.
          </p>
          <p>
            For an immediate custom import during launch or a desktop update,
            use <code>metadata.rankColumns</code>, for example
            <code>{` { genus: "genus", family: "family" }`}</code>. Do not include
            a <code>taxonomy</code> payload in the same request; these routes are
            mutually exclusive. <code>visual.metadataRankColumns</code> only
            preselects the controls and still needs the UI Apply button. The
            visual setting is not named <code>taxonomyRankColumns</code>.
            Assignments map existing rank slots to table column names.
            The resulting custom mapping records
            <code> mappingOrigin: &quot;metadata-ranks&quot;</code> and uses the existing
            taxonomy ribbon and rank-visibility controls.
          </p>
          <h3 className="metadata-guide-subheading">Independent clade ribbons</h3>
          <p>
            To mark a gene family, duplication group, or other named clade,
            right-click its internal branch and choose <strong>Add Clade Ribbon</strong>.
            The <strong>Clade ribbons</strong> section under <strong>Metadata</strong>
            lets you edit its label and color, show or hide it, remove it, and
            place it inside or outside the mapped taxonomy ribbons. These ribbons
            do not need a CSV file or taxonomy database and remain visible when
            taxonomy overlays are turned off. Nested clades use separate bands.
            They are saved in sessions and included in image exports and shared
            subtrees. Clade ribbons are hidden during tree comparison.
          </p>
        </section>

        <section className="metadata-guide-section">
          <div className="metadata-guide-heading">
            <p className="metadata-guide-step">5</p>
            <div>
              <h2>Review the result</h2>
              <p>
                Check that the selected column and visual encoding represent the
                intended variable. These views use the same example table.
                Enable Show metadata legend to include a color and symbol key in
                the view and exported images. Its settings select the position
                and included components; the legend can also be dragged or
                right-clicked to open settings or hide it. Hover over a branch to inspect its
                mapped metadata values, including inherited subtree colors.
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
            writes the complete tree and enabled legend as a tightly cropped
            PNG or SVG. Choose the width; height follows the figure proportions.
          </p>
        </section>
      </div>
    </main>
  );
}
