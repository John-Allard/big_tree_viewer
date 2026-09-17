# Local desktop agent interface

The desktop app bundles a local MCP server. No Python, separately installed
Chrome, HTTP server, or live BTV site is used. Rendering runs in the bundled
Electron renderer through a private local transport, reusing BTV's loader,
taxonomy mapping, visual settings, session, and export operations. The website's
URL/postMessage API remains separate and unchanged.

In the app, **Help → Connect an AI Agent** finds Codex or Claude Code, installs
the connection with that client's supported setup command, verifies a real MCP
handshake and tool listing, and reports success. Users do not copy paths or edit
configuration files. Restart the selected client after connecting it.

The bundled server uses the standard local MCP `stdio` transport and is not tied
to either client. BTV currently automates registration for Codex and Claude Code.
Other MCP clients can launch the same server if they support local `stdio`
servers. **Copy Setup Instructions** puts a self-contained message on the
clipboard with the exact command, arguments, and environment for the installed
copy of BTV. Paste that message into the preferred agent so it can perform the
client-specific registration and connection check.

The installed configuration runs a small bundled helper in Electron's Node mode.
It answers MCP initialization and tool discovery without launching the desktop
application. On the first tool call it creates a private local socket or named
pipe and starts an isolated rendering backend. The backend remains available
while agent tree sessions are open and exits when it becomes idle, so opening an
MCP client does not put Big Tree Viewer in the macOS Dock, intercept normal app
launches, or block application updates. Each rendering session avoids Chromium
profile locks, while taxonomy archives and completed mappings are retained in a
shared desktop-agent cache. Temporary renderer profiles are deleted after use.
The AppImage keeps the prior dependency-free eager launcher because its temporary
mount disappears when the GUI exits; its behavior is otherwise unchanged.

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
"allowDownload": false }`. Agent connections share a persistent cache that is
separate from the interactive app's browser-profile cache. Missing archives fail
with an explanation; opt into a first download explicitly or open a session with
a saved map. No tree or metadata upload is required. Mapping downloads still
require network.

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

Implementation validation (macOS, Linux, and Windows, September 2026): packaged builds passed
19 MCP operations, including visible opening, settings/metadata/camera updates,
PNG and SVG exports, editable-session roundtrip, NEXUS and extensionless Newick loading, validation and
existing-file errors, and independent GUI handoff surviving MCP disconnect.
The same run rendered the retained 50,033-tip example as a spiral with its saved
taxonomy (>49,000 mapped tips). The shared agent taxonomy cache was verified
across separate temporary renderer profiles. On Windows, the installed Codex CLI
discovered all seven tools and invoked `render_tree` through the helper to produce
a valid SVG. On macOS, a packaged helper was also verified to list tools without
starting Electron, open a visible tree on demand, render an SVG, and stop its
renderer after the last session closed. Fresh full taxonomy archive downloads
were not exercised in these checks.
