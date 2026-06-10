export default function AgenticAiPage() {
  const skillZipUrl = "https://bigtreeviewer.net/agentic-ai/bigtreeviewer-agent-skill.zip";
  const skillZipSha256 = "e4ebd0c37773c4bf1509a241e74a8ad49cf172bf414d63f13d92a60b81c6525e";

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
            <a href={skillZipUrl}>Download the skill ZIP</a>
            {" · "}
            <a href={`${import.meta.env.BASE_URL}agentic-ai/bigtreeviewer-agent-skill/SKILL.md`}>View the skill instructions</a>
          </p>
          <p>
            Codex skill documentation is available from{" "}
            <a href="https://developers.openai.com/codex/skills" rel="noreferrer" target="_blank">OpenAI</a>.
            Claude Agent Skills documentation is available from{" "}
            <a href="https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview" rel="noreferrer" target="_blank">Anthropic</a>,
            and Claude Code documentation is available from{" "}
            <a href="https://docs.anthropic.com/en/docs/claude-code/overview" rel="noreferrer" target="_blank">Anthropic Docs</a>.
          </p>
          <pre><code>{`curl -L -o bigtreeviewer-agent-skill.zip ${skillZipUrl}
sha256sum bigtreeviewer-agent-skill.zip
# expected: ${skillZipSha256}
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
            and more detailed figure styling. Agents can also pass a `canvas`
            object for saved viewport state, collapsed clades, and manual branch
            or subtree colors, or pass a saved BTV session when the task should
            reuse a full saved state.
          </p>
        </section>

        <section className="api-doc-section">
          <h2>Ask an agent to install it</h2>
          <p>
            You can ask Codex or Claude Code to fetch and inspect the skill for
            you instead of downloading it by hand.
          </p>
          <pre><code>{`Please install the Big Tree Viewer agent skill from:
${skillZipUrl}

Before installing it, download the ZIP to a temporary directory, verify that its
SHA-256 hash is:
${skillZipSha256}

Then unzip it, show me the file list, read SKILL.md and the Python scripts, and
confirm that the scripts only use Python's standard library. If it looks safe,
install the extracted bigtreeviewer-agent-skill folder in the appropriate skills
directory for this agent.`}</code></pre>
        </section>

        <section className="api-doc-section">
          <h2>Safety and transparency</h2>
          <p>
            Agent skills are ordinary folders with a `SKILL.md` file and optional
            bundled resources. This skill is distributed as an inspectable ZIP
            from `bigtreeviewer.net`; it contains the instructions, UI metadata,
            and small Python helper scripts. There is no installer script, no
            compiled binary, and no bundled dependency manager command.
          </p>
          <p>
            Before installing any agent skill, inspect the file list and read
            `SKILL.md` plus any scripts it contains. The BTV helper scripts use
            Python&apos;s standard library, open Big Tree Viewer in the user&apos;s
            browser, and pass tree/session data to the BTV launch API. Use the
            SHA-256 hash above to check that the downloaded ZIP matches the
            version described on this page.
          </p>
        </section>

        <section className="api-doc-section">
          <h2>What you can ask an agent to do</h2>
          <ul>
            <li>Open this Newick file in Big Tree Viewer as a circular tree.</li>
            <li>Render this tree as an SVG with tip labels hidden and thicker branches.</li>
            <li>Make a 3000 by 3000 PNG spiral view of this tree for a slide.</li>
            <li>Load this metadata table, color branches by group, and export the current view.</li>
            <li>Render this saved BTV session as an SVG without opening the UI.</li>
            <li>Create several alternate tree figures with different palettes and save them to a figures folder.</li>
          </ul>
        </section>

        <section className="api-doc-section">
          <h2>How it works</h2>
          <p>
            `btv_open.py` uses only Python&apos;s standard library. It creates a
            temporary launcher page, opens Big Tree Viewer, and sends the local
            tree text or session through the launch API so the browser can
            display it interactively. It can also ask Big Tree Viewer to trigger
            an SVG or PNG download in the browser without installing extra
            Python packages.
          </p>
        </section>

        <section className="api-doc-section">
          <h2>Example commands</h2>
          <pre><code>{`python scripts/btv_open.py tree.nwk --view circular --tip-labels true
python scripts/btv_open.py tree.nwk --download-export svg --export-filename tree.svg
python scripts/btv_open.py tree.nwk --download-export png --export-filename tree.png --view spiral --width 3000 --height 3000
python scripts/btv_open.py saved-view.btvsession --download-export svg --export-filename saved-view.svg`}</code></pre>
        </section>
      </div>
    </main>
  );
}
