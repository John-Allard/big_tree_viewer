export default function ApiPage() {
  const origin = "https://bigtreeviewer.net/";
  const simpleNewick = `${origin}?btv_newick=%28A%3A1%2CB%3A1%29Root%3B`;
  const remoteNewick = `${origin}?btv_newick_url=https%3A%2F%2Fexample.org%2Ftrees%2Fmy-tree.nwk&btv_view=circular`;
  const remoteSession = `${origin}?btv_session_url=https%3A%2F%2Fexample.org%2Ftrees%2Fmy-tree.btvsession`;
  const metadataExample = `${origin}?btv_newick=%28A%3A1%2C%28B%3A1%2CC%3A1%29Clade1%3A1%29Root%3B&btv_metadata=name%2Cgroup%0AA%2Cred_group%0AB%2Cblue_group%0AC%2Cblue_group%0A&btv_metadata_key=name&btv_metadata_value=group&btv_metadata_enabled=true`;

  return (
    <main className="about-page api-page">
      <div className="about-page-frame">
        <nav className="site-doc-nav" aria-label="Documentation">
          <a href={`${import.meta.env.BASE_URL}#`}>Viewer</a>
          <a href={`${import.meta.env.BASE_URL}#about`}>About</a>
          <a href={`${import.meta.env.BASE_URL}#api`} aria-current="page">API</a>
        </nav>
        <header className="about-header">
          <div>
            <p className="about-kicker">Big Tree Viewer</p>
            <h1>Launch API</h1>
            <p className="about-author-line">
              Open Big Tree Viewer with a tree, metadata, and selected display
              settings already applied. Everything still runs locally in the
              user&apos;s browser.
            </p>
          </div>
          <a className="about-top-link" href={`${import.meta.env.BASE_URL}#`}>
            Back to viewer
          </a>
        </header>

        <section className="api-doc-section">
          <h2>Small trees in a URL</h2>
          <p>
            For short Newick strings, put the tree in the query string with
            `btv_newick`. The Newick text must be URL encoded with
            `encodeURIComponent`.
          </p>
          <pre><code>{simpleNewick}</code></pre>
          <pre><code>{`const newick = "(A:1,B:1)Root;";
const url = \`${origin}?btv_newick=\${encodeURIComponent(newick)}\`;
window.open(url, "_blank");`}</code></pre>
        </section>

        <section className="api-doc-section">
          <h2>Remote tree or session files</h2>
          <p>
            Use `btv_newick_url` to load a public Newick or NEXUS file, or
            `btv_session_url` to load a saved Big Tree Viewer session containing
            the tree, metadata, visual settings, manual clade colors, collapsed
            clades, taxonomy mappings, and viewport. A session saved after
            taxonomy mapping can therefore open with taxonomy ribbons already
            available, without requiring the visitor to download the NCBI
            taxonomy dump. The file is fetched directly by the visitor&apos;s browser,
            so the host must allow cross-origin requests from `bigtreeviewer.net`.
          </p>
          <pre><code>{remoteNewick}</code></pre>
          <pre><code>{remoteSession}</code></pre>
        </section>

        <section className="api-doc-section">
          <h2>Base64url parameters</h2>
          <p>
            Use `btv_newick_b64` and `btv_metadata_b64` when a tree or metadata
            table contains characters that are awkward in a URL. The value is
            UTF-8 text encoded as base64url. This still has browser URL length
            limits, so it is intended for modest trees.
          </p>
          <pre><code>{`function base64Url(text) {
  return btoa(unescape(encodeURIComponent(text)))
    .replace(/\\+/g, "-")
    .replace(/\\//g, "_")
    .replace(/=+$/g, "");
}

const url = \`${origin}?btv_newick_b64=\${base64Url(newick)}\`;`}</code></pre>
        </section>

        <section className="api-doc-section">
          <h2>Metadata-driven branch colors</h2>
          <p>
            Metadata is supplied as CSV or TSV text. `btv_metadata_key` names the
            column matched to tree labels, and `btv_metadata_value` names the
            column used for colors. Set `btv_metadata_scope=subtree` if keys are
            internal node labels and the whole matched subtree should be colored.
          </p>
          <pre><code>{metadataExample}</code></pre>
        </section>

        <section className="api-doc-section">
          <h2>Useful URL options</h2>
          <dl className="api-option-list">
            <div><dt>btv_view</dt><dd>`rectangular`, `circular`, or `spiral`.</dd></div>
            <div><dt>btv_order</dt><dd>`asc`, `desc`, or `input`.</dd></div>
            <div><dt>btv_tip_labels</dt><dd>`true` or `false`.</dd></div>
            <div><dt>btv_genus_labels</dt><dd>`true` or `false`.</dd></div>
            <div><dt>btv_taxonomy</dt><dd>Show taxonomy overlays if taxonomy is loaded in the payload.</dd></div>
            <div><dt>btv_taxonomy_branch_colors</dt><dd>Color branches from taxonomy mapping.</dd></div>
            <div><dt>btv_palette</dt><dd>Taxonomy color palette key.</dd></div>
            <div><dt>btv_branch_thickness</dt><dd>Branch thickness scale, for example `1.5`.</dd></div>
            <div><dt>btv_time_axis</dt><dd>`linear` or `log`.</dd></div>
            <div><dt>btv_metadata_labels</dt><dd>Show metadata text labels.</dd></div>
            <div><dt>btv_metadata_markers</dt><dd>Show metadata markers.</dd></div>
            <div><dt>btv_newick_url</dt><dd>Public URL for a Newick or NEXUS file. Requires host CORS support.</dd></div>
            <div><dt>btv_session_url</dt><dd>Public URL for a `.btvsession` file. Requires host CORS support.</dd></div>
          </dl>
        </section>

        <section className="api-doc-section">
          <h2>Large trees with postMessage</h2>
          <p>
            URLs are not suitable for large trees. Open Big Tree Viewer with
            `?btv_api=1`, wait for `big-tree-viewer:ready`, then send a load
            message containing the payload.
          </p>
          <pre><code>{`const viewer = window.open("${origin}?btv_api=1", "_blank");

window.addEventListener("message", (event) => {
  if (event.data?.type !== "big-tree-viewer:ready") return;
  viewer.postMessage({
    type: "big-tree-viewer:load",
    payload: {
      newick: "(A_species:1,B_species:1)Root;",
      label: "example tree",
      visual: {
        viewMode: "circular",
        showTipLabels: true,
        showGenusLabels: false
      },
      metadata: {
        text: "name,group\\nA_species,Alpha\\nB_species,Beta\\n",
        keyColumn: "name",
        valueColumn: "group",
        enabled: true
      }
    }
  }, "${origin.replace(/\/$/, "")}");
});`}</code></pre>
        </section>

        <section className="api-doc-section">
          <h2>Payload shape</h2>
          <pre><code>{`{
  newick: string,
  label?: string,
  visual?: {
    viewMode?: "rectangular" | "circular" | "spiral",
    order?: "asc" | "desc" | "input",
    showTipLabels?: boolean,
    showGenusLabels?: boolean,
    branchThicknessScale?: number,
    taxonomyEnabled?: boolean,
    taxonomyBranchColoringEnabled?: boolean
  },
  metadata?: {
    text?: string,
    label?: string,
    firstRowIsHeader?: boolean,
    enabled?: boolean,
    keyColumn?: string,
    valueColumn?: string,
    colorMode?: "categorical" | "continuous",
    applyScope?: "branch" | "subtree",
    labelsEnabled?: boolean,
    markersEnabled?: boolean
  }
}`}</code></pre>
        </section>
      </div>
    </main>
  );
}
