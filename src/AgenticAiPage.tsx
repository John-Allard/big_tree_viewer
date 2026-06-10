export default function AgenticAiPage() {
  const skillBase = `${import.meta.env.BASE_URL}agentic-ai/bigtreeviewer-agent-skill`;
  return (
    <main className="about-page api-page">
      <div className="about-page-frame">
        <nav className="site-doc-nav" aria-label="Documentation">
          <a href={`${import.meta.env.BASE_URL}#`}>Viewer</a>
          <a href={`${import.meta.env.BASE_URL}#about`}>About</a>
          <a href={`${import.meta.env.BASE_URL}#faq`}>FAQ</a>
          <a href={`${import.meta.env.BASE_URL}#share`}>Share sessions</a>
          <a href={`${import.meta.env.BASE_URL}#api`}>API</a>
          <a href={`${import.meta.env.BASE_URL}#agentic-ai`} aria-current="page">Agentic AI</a>
        </nav>

        <header className="about-header">
          <div>
            <p className="about-kicker">Big Tree Viewer</p>
            <h1>Using BTV with agentic AI</h1>
            <p className="about-author-line">
              Big Tree Viewer can be launched and exported through its browser
              API, which means coding agents can open local trees, apply visual
              settings, and render figure files without requiring you to click
              through the interface.
            </p>
          </div>
          <a className="about-top-link" href={`${import.meta.env.BASE_URL}#`}>
            Back to viewer
          </a>
        </header>

        <section className="api-doc-section">
          <h2>Download the agent skill</h2>
          <p>
            The downloadable skill is a small folder with a `SKILL.md` file and
            Python helper scripts. It is designed for Codex and follows the same
            basic Agent Skills folder structure used by Claude, so Claude Code
            can use the same instructions and scripts when installed in its
            skills directory.
          </p>
          <p>
            <a href={`${import.meta.env.BASE_URL}agentic-ai/bigtreeviewer-agent-skill.zip`}>Download the skill ZIP</a>
            {" · "}
            <a href={`${skillBase}/SKILL.md`}>View the skill instructions</a>
            {" · "}
            <a href={`${skillBase}/scripts/btv_open.py`}>btv_open.py</a>
            {" · "}
            <a href={`${skillBase}/scripts/btv_render.py`}>btv_render.py</a>
          </p>
          <p>
            Codex skill documentation is available from{" "}
            <a href="https://developers.openai.com/codex/skills" rel="noreferrer" target="_blank">OpenAI</a>.
            Claude Agent Skills documentation is available from{" "}
            <a href="https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview" rel="noreferrer" target="_blank">Anthropic</a>,
            and Claude Code documentation is available from{" "}
            <a href="https://docs.anthropic.com/en/docs/claude-code/overview" rel="noreferrer" target="_blank">Anthropic Docs</a>.
          </p>
          <pre><code>{`curl -L -o bigtreeviewer-agent-skill.zip \\
  https://bigtreeviewer.net/agentic-ai/bigtreeviewer-agent-skill.zip
unzip bigtreeviewer-agent-skill.zip`}</code></pre>
          <p>
            For Codex, install or copy the extracted folder as a skill, or
            package it inside a Codex plugin later. For Claude Code, use the
            same extracted skill folder; a separate BTV-specific skill is not
            needed because both systems read the `SKILL.md` workflow and bundled
            scripts.
          </p>
          <p>
            For detailed styling, agents can pass a JSON launch payload with a
            `visual` object. Those setting names mirror the settings saved in
            `.btvsession` files, so the same API can control common view options
            and more detailed figure styling.
          </p>
        </section>

        <section className="api-doc-section">
          <h2>What you can ask an agent to do</h2>
          <ul>
            <li>Open this Newick file in Big Tree Viewer as a circular tree.</li>
            <li>Render this tree as an SVG with tip labels hidden and thicker branches.</li>
            <li>Make a 3000 by 3000 PNG spiral view of this tree for a slide.</li>
            <li>Load this metadata table, color branches by group, and export the current view.</li>
            <li>Create several alternate tree figures with different palettes and save them to a figures folder.</li>
          </ul>
        </section>

        <section className="api-doc-section">
          <h2>How it works</h2>
          <p>
            `btv_open.py` uses only Python&apos;s standard library. It creates a
            temporary launcher page, opens Big Tree Viewer, and sends the local
            tree text through the launch API so the browser can display it
            interactively.
          </p>
          <p>
            `btv_render.py` uses Playwright only when a file needs to be saved
            automatically. The script opens Big Tree Viewer in a browser,
            requests an SVG or PNG export with `postMessage`, and writes the
            returned data to disk.
          </p>
        </section>

        <section className="api-doc-section">
          <h2>Example commands</h2>
          <pre><code>{`python scripts/btv_open.py tree.nwk --view circular --tip-labels true
python scripts/btv_render.py tree.nwk --format svg --out tree.svg --view circular
python scripts/btv_render.py tree.nwk --format png --out tree.png --view spiral --width 3000 --height 3000`}</code></pre>
        </section>
      </div>
    </main>
  );
}
