// Local agent transport. All tools and the JSON command entry point use this backend.
const { BrowserWindow, ipcMain, app, nativeImage } = require('electron');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const object = z.record(z.string(), z.unknown());
const taxonomy = z.object({
  source: z.enum(['ncbi', 'catalogue-of-life']).default('ncbi'),
  ranks: z.array(z.enum(['superkingdom', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus'])).optional(),
  allowDownload: z.boolean().default(false).describe('Allow a first-time taxonomy archive download. Otherwise use cached data only.'),
}).strict();
const metadataOptions = z.object({
  text: z.string().optional(), label: z.string().optional(), firstRowIsHeader: z.boolean().optional(),
  enabled: z.boolean().optional(), keyColumn: z.string().optional(), valueColumn: z.string().optional(),
  colorMode: z.enum(['categorical', 'continuous']).optional(), applyScope: z.enum(['branch', 'subtree']).optional(),
  labelsEnabled: z.boolean().optional(), labelColumn: z.string().optional(),
  markersEnabled: z.boolean().optional(), markerColumn: z.string().optional(),
  piesEnabled: z.boolean().optional(), pieStartColumn: z.string().optional(), pieEndColumn: z.string().optional(),
  piePalette: z.enum(['categorical', 'viridis', 'warm']).optional(), pieColorOverrides: z.record(z.string(), z.string()).optional(),
  pieSizePx: z.number().positive().optional(), reverseScale: z.boolean().optional(),
  continuousPalette: z.enum(['blueOrange', 'viridis', 'redBlue', 'tealRose']).optional(),
  continuousTransform: z.enum(['linear', 'sqrt', 'log']).optional(), continuousMinInput: z.string().optional(), continuousMaxInput: z.string().optional(),
  categoryColorOverrides: z.record(z.string(), z.string()).optional(),
  markerStyleOverrides: z.record(z.string(), z.object({ color: z.string().optional(), shape: z.enum(['circle','square','diamond','triangle']).optional() }).strict()).optional(),
  markerSizePx: z.number().positive().optional(), labelMaxCount: z.number().int().nonnegative().optional(),
  labelMinSpacingPx: z.number().nonnegative().optional(), labelOffsetXPx: z.number().optional(), labelOffsetYPx: z.number().optional(),
}).strict();
const style = {
  layout: z.enum(['rectangular', 'circular', 'fan', 'spiral']).optional(),
  canvas: object.optional().describe('Optional saved viewport state, e.g. camera with kind, scaleX, scaleY, translateX, translateY for rectangular zoom.'),
  settings: object.optional().describe('Saved BTV visual setting names; use inspect_tree to see current settings. Unknown keys are rejected.'),
  metadataPath: z.string().optional().describe('Absolute local CSV/TSV path.'),
  metadata: metadataOptions.optional().describe('Metadata column and encoding settings. Use metadataPath for a local CSV/TSV file.'),
  taxonomy: taxonomy.optional(),
};
const input = {
  treePath: z.string().optional().describe('Absolute local Newick, NEXUS, or .btvsession path. Supply this OR newick.'),
  newick: z.string().optional().describe('Inline Newick for small trees; prefer treePath for large inputs.'),
  ...style,
};
const output = {
  outputPath: z.string().describe('Absolute destination ending .png, .svg, or .btvsession. Existing files are protected unless overwrite=true.'),
  width: z.number().int().min(64).max(16384).optional(),
  height: z.number().int().min(64).max(16384).optional(),
  overwrite: z.boolean().default(false),
};
const id = { sessionId: z.string() };

function absolute(p) {
  if (!path.isAbsolute(p)) throw new Error(`Use an absolute local path: ${p}`);
  return path.resolve(p);
}
async function writeArtifact(destination, bytes, overwrite) {
  const target = absolute(destination);
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, bytes, { flag: 'wx' });
    if (overwrite) await fs.rename(temp, target);
    else { await fs.link(temp, target); await fs.unlink(temp); }
  } finally { await fs.unlink(temp).catch(() => {}); }
  return target;
}

async function startAutomation({ grantFile, commandFile, showApplication, hideApplication }) {
  const sessions = new Map();
  let keepAlive = true;
  app.on('window-all-closed', () => { if (!keepAlive) app.quit(); });
  const pending = new Map();
  const ready = new Map();
  function hideApplicationIfIdle() {
    setImmediate(() => {
      if (![...sessions.values()].some((session) => !session.window.isDestroyed() && session.window.isVisible())) {
        hideApplication?.();
      }
    });
  }
  function reply(event, data) {
    const item = pending.get(data?.id);
    if (!item || item.webContents !== event.sender) return;
    pending.delete(data.id);
    clearTimeout(item.timer);
    data.ok ? item.resolve(data.result) : item.reject(new Error(data.message || 'Desktop operation failed.'));
  }
  ipcMain.on('btv:agent-result', reply);
  ipcMain.on('btv:agent-ready', (event) => ready.get(event.sender.id)?.());

  async function createSession() {
    if (sessions.size >= 4) throw new Error('Four agent trees are already open. Close a tree before opening another.');
    const sessionId = crypto.randomUUID();
    const window = new BrowserWindow({ width: 1600, height: 1000, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const contents = window.webContents;
    const session = { window, sessionId, busy: false };
    sessions.set(sessionId, session);
    window.on('closed', () => {
      sessions.delete(sessionId);
      for (const [key, item] of pending) if (item.webContents === contents) {
        clearTimeout(item.timer); pending.delete(key); item.reject(new Error('Tree window closed.'));
      }
      hideApplicationIfIdle();
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ready.delete(window.webContents.id); reject(new Error('Desktop renderer did not become ready.')); }, 30000);
        ready.set(window.webContents.id, () => { clearTimeout(timer); ready.delete(window.webContents.id); resolve(); });
        window.loadURL('btv://app/index.html?btv_desktop_open=1').catch(error => { clearTimeout(timer); reject(error); });
      });
      return session;
    } catch (error) { window.destroy(); throw error; }
  }
  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.window.isDestroyed()) throw new Error('Unknown or closed sessionId. Open a tree first.');
    return session;
  }
  async function request(session, operation, payload = {}, signal) {
    if (signal?.aborted) throw new Error('Operation cancelled.');
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const cleanupReject = (error) => { pending.delete(requestId); signal?.removeEventListener('abort', cancel); reject(error); };
      const timer = setTimeout(() => { cleanupReject(new Error('Operation exceeded 180 seconds; its tree session was closed.')); session.window.destroy(); }, 180000);
      const cancel = () => { clearTimeout(timer); cleanupReject(new Error('Operation cancelled; its tree session was closed.')); session.window.destroy(); };
      signal?.addEventListener('abort', cancel, { once: true });
      const clean = (fn) => value => { signal?.removeEventListener('abort', cancel); fn(value); };
      pending.set(requestId, { resolve: clean(resolve), reject: clean(reject), timer, webContents: session.window.webContents });
      session.window.webContents.send('btv:agent-request', { id: requestId, operation, payload });
    });
  }
  async function payloadFor(args) {
    const payload = { canvas: args.canvas, visual: { ...args.settings }, metadata: args.metadata ? { ...args.metadata } : undefined };
    if (args.layout) payload.visual.viewMode = args.layout;
    if (args.treePath && args.newick) throw new Error('Supply treePath or newick, not both.');
    if (args.treePath) {
      const local = absolute(args.treePath);
      const granted = await grantFile(local);
      payload.label = path.basename(local);
      payload[local.toLowerCase().endsWith('.btvsession') ? 'sessionUrl' : 'newickUrl'] = granted.url;
    } else if (args.newick) payload.newick = args.newick;
    if (args.metadataPath) payload.metadata = { ...payload.metadata, text: await fs.readFile(absolute(args.metadataPath), 'utf8'), label: path.basename(args.metadataPath) };
    if (args.taxonomy) {
      payload.taxonomy = { runMapping: true, source: args.taxonomy.source, allowDownload: args.taxonomy.allowDownload };
      payload.visual.taxonomyEnabled = true;
      if (args.taxonomy.ranks) {
        payload.visual.useAutomaticTaxonomyRankVisibility = false;
        payload.visual.taxonomyOverlayStyle = "ribbons";
        payload.visual.taxonomyRankVisibility = Object.fromEntries(['superkingdom','kingdom','phylum','class','order','family','genus'].map(rank => [rank, args.taxonomy.ranks.includes(rank)]));
      }
    }
    return payload;
  }
  async function exportArtifact(session, args, signal) {
    const destination = absolute(args.outputPath);
    const extension = path.extname(destination).toLowerCase();
    if (!['.png', '.svg', '.btvsession'].includes(extension)) throw new Error('outputPath must end in .png, .svg, or .btvsession.');
    if (!args.overwrite) { try { await fs.stat(destination); throw new Error(`Output already exists: ${destination}`); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    const result = await request(session, extension === '.btvsession' ? 'save-session' : 'export', {
      format: extension.slice(1), width: args.width, height: args.height,
    }, signal);
    let bytes;
    if (extension === '.btvsession') bytes = Buffer.from(JSON.stringify(result.session));
    else if (extension === '.svg') {
      if (!result.text?.includes('<svg')) throw new Error('Renderer returned invalid SVG.');
      bytes = Buffer.from(result.text);
    } else {
      if (!result.dataUrl?.startsWith('data:image/png;base64,')) throw new Error('Renderer returned invalid PNG.');
      bytes = Buffer.from(result.dataUrl.split(',')[1], 'base64');
      if (bytes.length < 24 || bytes.subarray(1, 4).toString() !== 'PNG') throw new Error('Renderer returned invalid PNG bytes.');
    }
    await writeArtifact(destination, bytes, args.overwrite);
    return { sessionId: session.sessionId, outputPath: destination, bytes: bytes.length,
      width: result.width, height: result.height, format: extension.slice(1) };
  }
  async function locked(session, action) {
    if (session.busy) throw new Error('This tree is busy. Wait for its current operation to finish.');
    session.busy = true;
    try { return await action(); } finally { session.busy = false; }
  }
  const definitions = {
    open_tree: { description: 'Open a local Newick/NEXUS tree or BTV session in a visible Big Tree Viewer desktop window with requested settings. Returns a sessionId for later edits. Does not replace the user\'s existing tree.', shape: input,
      run: async (args, signal) => {
        if (!args.treePath && !args.newick) throw new Error('Supply treePath or newick.');
        const payload = await payloadFor(args); const session = await createSession();
        try {
          await request(session, 'load', payload, signal);
          await showApplication?.();
          session.window.show();
          session.window.focus();
          return { sessionId: session.sessionId, windowVisible: session.window.isVisible(), ...await request(session, 'inspect', {}, signal) };
        }
        catch (error) { session.window.destroy(); throw error; }
      } },
    render_tree: { description: 'Render a local tree to PNG/SVG or save a configured .btvsession in the background using bundled Electron. No external Chrome, Python, or website. The temporary tree closes after export; use open_tree for interactive work.', shape: { ...input, ...output },
      run: async (args, signal) => {
        if (!args.treePath && !args.newick) throw new Error('Supply treePath or newick.');
        const payload = await payloadFor(args); const session = await createSession();
        try { await request(session, 'load', payload, signal); const info = await request(session, 'inspect', {}, signal); return { ...await exportArtifact(session, args, signal), tree: info, sessionClosed: true }; }
        finally { if (!session.window.isDestroyed()) session.window.destroy(); }
      } },
    inspect_tree: { description: 'Inspect an agent-opened tree: counts, layout, current visual settings, taxonomy coverage, and metadata messages.', shape: id,
      run: (args, signal) => locked(getSession(args.sessionId), () => request(getSession(args.sessionId), 'inspect', {}, signal)) },
    update_tree: { description: 'Change layout, visual settings, metadata, or taxonomy on an existing agent tree without reparsing its topology. The visible desktop window updates.', shape: { ...id, ...style },
      run: (args, signal) => locked(getSession(args.sessionId), async () => { const s = getSession(args.sessionId); await request(s, 'update', await payloadFor(args), signal); return { sessionId: s.sessionId, ...await request(s, 'inspect', {}, signal) }; }) },
    export_tree: { description: 'Export the current agent tree view to PNG/SVG, or save its editable .btvsession with metadata, taxonomy, and camera.', shape: { ...id, ...output },
      run: (args, signal) => locked(getSession(args.sessionId), () => exportArtifact(getSession(args.sessionId), args, signal)) },
    handoff_tree: { description: 'Open the configured tree in the independent desktop app so the user can keep working after the agent disconnects. Saves a session in BTV agent storage and returns its path.', shape: id,
      run: (args, signal) => locked(getSession(args.sessionId), async () => {
        const directory = path.join(app.getPath('userData'), 'handoffs');
        await fs.mkdir(directory, { recursive: true });
        const result = await exportArtifact(getSession(args.sessionId), { outputPath: path.join(directory, `${crypto.randomUUID()}.btvsession`), overwrite: false }, signal);
        const child = spawn(process.env.APPIMAGE || process.execPath, [...(app.isPackaged ? [] : [path.join(__dirname, 'main.cjs')]), result.outputPath], { detached: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        return { ...result, openedInIndependentApp: true };
      }) },
    close_tree: { description: 'Close an agent-created tree window and release its memory. Does not close independently opened user windows.', shape: id,
      run: async args => { getSession(args.sessionId).window.destroy(); return { closed: true }; } },
  };
  async function execute(name, args, signal) {
    const tool = definitions[name];
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.run(z.object(tool.shape).strict().parse(args), signal);
  }
  if (commandFile) {
    try {
      const command = JSON.parse(await fs.readFile(absolute(commandFile), 'utf8'));
      const result = await execute(command.tool, command.arguments || {});
      process.stdout.write(`${JSON.stringify(result)}\n`);
      keepAlive = false;
      if (![...sessions.values()].some(s => s.window.isVisible())) app.quit();
    } catch (error) { process.stderr.write(`${error.message}\n`); app.exit(1); }
    return;
  }
  const server = new McpServer({ name: 'big-tree-viewer', version: app.getVersion() });
  for (const [name, definition] of Object.entries(definitions)) server.registerTool(name, {
    description: definition.description, inputSchema: definition.shape,
  }, async (args, extra) => {
    try {
      if (extra._meta?.progressToken !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, progress: 0, message: `BTV: ${name}` } });
      const result = await execute(name, args, extra.signal);
      const content = [{ type: 'text', text: JSON.stringify(result) }];
      if (result.outputPath && result.format === 'png') {
        const preview = nativeImage.createFromPath(result.outputPath);
        if (!preview.isEmpty()) content.push({ type: 'image', mimeType: 'image/png', data: preview.resize({ width: Math.min(1000, preview.getSize().width) }).toPNG().toString('base64') });
      }
      return { content, structuredContent: result };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  transport.onclose = () => { for (const s of sessions.values()) s.window.destroy(); app.quit(); }; // handoff_tree windows belong to the independent GUI process.
}
module.exports = { startAutomation, writeArtifact };
