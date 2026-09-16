# Local desktop agent interface

The app executable accepts `--mcp` to run the bundled MCP server. No Python,
separately installed Chrome, HTTP server, or live BTV site is used. Rendering runs
in the bundled Electron renderer through a private preload IPC bridge, reusing
BTV's loader, taxonomy mapping, visual settings, session, and export operations.
The website's URL/postMessage API remains separate and unchanged.

In the app, **Help → Connect an AI Agent** copies configuration using the actual
executable path. Merge the Codex TOML into `~/.codex/config.toml`, or the Claude
JSON into `.mcp.json`, then restart the client. Use `tool_timeout_sec = 240` in
Codex; allow equivalent time for long calls in other clients.

Example generic MCP configuration (replace the executable path):

```json
{
  "mcpServers": {
    "bigtreeviewer": {
      "command": "/absolute/path/to/big-tree-viewer",
      "args": ["--mcp"],
      "env": { "BTV_AGENT_PROFILE": "claude" }
    }
  }
}
```

On macOS use the executable inside `Big Tree Viewer.app/Contents/MacOS/`;
on Windows use the installed `.exe`. AppImage users should use their stable
AppImage path in configuration rather than a temporary mounted executable path.
In development, run the local Electron executable with arguments
`desktop/main.cjs --mcp` after `npm run build:desktop:web`.

## Tools

- `open_tree`: visible configured Newick/NEXUS/session; returns a session ID.
- `update_tree`: apply settings/metadata/taxonomy/canvas to the existing tree.
- `inspect_tree`: counts, effective settings, mapping coverage, metadata messages.
- `export_tree`: current PNG/SVG, or editable `.btvsession` including its camera.
- `render_tree`: isolated background load/export/close, plus PNG preview.
- `handoff_tree`: save in the app's agent handoff directory and open in the
  independent GUI process; this copy survives the MCP connection ending.
- `close_tree`: close an agent-owned window.

`open_tree` does not replace the user's existing desktop tree. Up to four agent
windows may be open per connection; operations on the same tree are serialized
by rejecting overlapping work with a busy error. Agent-controlled windows close
when MCP disconnects. Call `handoff_tree` before disconnecting if the user wants
to continue independently. Handoff snapshots remain in the agent profile's
`handoffs` directory and can be moved or deleted like other session files.

Use absolute paths. `treePath` and inline `newick` are mutually exclusive.
`layout` is rectangular/circular/fan/spiral. `settings` uses BTV's saved visual
setting names; inspect a session to discover current values. Unknown top-level
setting names and mismatched primitive types are rejected; supported values may
be normalized by BTV, so check the effective settings returned. Spiral requires
at least 1,000 tips. Canvas camera coordinates use the supplied saved viewport
and are rescaled to the actual tree viewport. PNG dimensions may also be
normalized (spiral PNG is square); exported dimensions are returned.

Metadata is local `metadataPath` plus typed `metadata` column/encoding settings.
Taxonomy example: `{ "source": "ncbi", "ranks": ["class", "order"],
"allowDownload": false }`. Each named agent profile has its own persistent
cache, separate from the interactive app's cache. Missing archives fail with an
explanation; opt into downloads explicitly or open a session with a saved map.
No tree/metadata upload is required. Mapping downloads still require network.

Profiles must contain letters, digits, underscores, or hyphens. Only one process
may use a profile at a time. Use distinct profiles for simultaneous clients.
Output files are written atomically and existing files are protected unless
`overwrite: true`. Calls time out at 180 seconds; cancellation/timeouts close the
affected tree so no background mutation continues after a failed operation.
Tools operate with the local app process's filesystem permissions; client
approval/sandbox settings remain relevant. No arbitrary JavaScript execution
or shell-command tool is exposed.

## Single-command fallback

`big-tree-viewer --command /absolute/path/request.json` invokes exactly the same
backend once. This is not a second command hierarchy or a separate settings API.
For example:

```json
{
  "tool": "render_tree",
  "arguments": {
    "treePath": "/data/tree.nwk",
    "layout": "circular",
    "settings": { "showTipLabels": false, "showGenusLabels": true },
    "outputPath": "/data/tree.png",
    "width": 1600,
    "height": 1600
  }
}
```

One JSON result is written to stdout. A background command exits when done; an
`open_tree` command keeps its window alive until closed. Session IDs are scoped
to the process; use MCP for a series of operations. The GUI executable needs a
graphical environment even for hidden rendering; Linux CI can use Xvfb. This is
background desktop rendering, not a display-server-free rendering engine.

## Verification

`npm run build:desktop:web`

`xvfb-run -a npm run test:desktop:agent` on Linux CI (omit Xvfb on a desktop).
Pass a packaged executable to test the packaged runtime. No user browser or
cursor is used. Pack with `npx electron-builder --dir`.

Implementation validation (Linux, September 2026): a packaged build passed
19 MCP operations, including visible opening, settings/metadata/camera updates,
PNG and SVG exports, editable-session roundtrip, NEXUS and extensionless Newick loading, validation and
existing-file errors, and independent GUI handoff surviving MCP disconnect.
The same run rendered the retained 50,033-tip example as a spiral with its saved
taxonomy (>49,000 mapped tips). A single-command background PNG export and the
normal desktop smoke test passed. All 30 website launch API regression tests
passed. These are functional checks, not new performance benchmarks; tests used
Xvfb and software rendering. Fresh full taxonomy archive downloads and macOS/
Windows execution were not exercised in these checks. The Linux preview is in
`release/agent-preview/linux-unpacked/`; it has not been published or installed
as the user's default app.
