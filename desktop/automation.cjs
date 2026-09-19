// Local agent transport. All tools and the JSON command entry point use this backend.
const { BrowserWindow, ipcMain, app, nativeImage } = require('electron');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { toolDefinitions } = require('./automation-tools.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');

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

async function startAutomation({ grantFile, commandFile, mcpSocket, showApplication, hideApplication }) {
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
    open_tree: { ...toolDefinitions.open_tree,
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
    render_tree: { ...toolDefinitions.render_tree,
      run: async (args, signal) => {
        if (!args.treePath && !args.newick) throw new Error('Supply treePath or newick.');
        const payload = await payloadFor(args); const session = await createSession();
        try { await request(session, 'load', payload, signal); const info = await request(session, 'inspect', {}, signal); return { ...await exportArtifact(session, args, signal), tree: info, sessionClosed: true }; }
        finally { if (!session.window.isDestroyed()) session.window.destroy(); }
      } },
    inspect_tree: { ...toolDefinitions.inspect_tree,
      run: (args, signal) => locked(getSession(args.sessionId), () => request(getSession(args.sessionId), 'inspect', {}, signal)) },
    update_tree: { ...toolDefinitions.update_tree,
      run: (args, signal) => locked(getSession(args.sessionId), async () => { const s = getSession(args.sessionId); await request(s, 'update', await payloadFor(args), signal); return { sessionId: s.sessionId, ...await request(s, 'inspect', {}, signal) }; }) },
    export_tree: { ...toolDefinitions.export_tree,
      run: (args, signal) => locked(getSession(args.sessionId), () => exportArtifact(getSession(args.sessionId), args, signal)) },
    handoff_tree: { ...toolDefinitions.handoff_tree,
      run: (args, signal) => locked(getSession(args.sessionId), async () => {
        const directory = path.join(app.getPath('userData'), 'handoffs');
        await fs.mkdir(directory, { recursive: true });
        const result = await exportArtifact(getSession(args.sessionId), { outputPath: path.join(directory, `${crypto.randomUUID()}.btvsession`), overwrite: false }, signal);
        const childEnv = { ...process.env };
        if (childEnv.BTV_HANDOFF_USER_DATA_DIR) childEnv.BTV_USER_DATA_DIR = childEnv.BTV_HANDOFF_USER_DATA_DIR;
        else delete childEnv.BTV_USER_DATA_DIR;
        delete childEnv.BTV_AGENT_PROFILE;
        delete childEnv.BTV_HANDOFF_USER_DATA_DIR;
        const child = spawn(process.env.APPIMAGE || process.execPath, [...(app.isPackaged ? [] : [path.join(__dirname, 'main.cjs')]), result.outputPath], {
          detached: true, env: childEnv, stdio: 'ignore',
        });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        return { ...result, openedInIndependentApp: true };
      }) },
    close_tree: { ...toolDefinitions.close_tree,
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
  let transport;
  if (mcpSocket) {
    const socket = net.createConnection(mcpSocket);
    await new Promise((resolve, reject) => {
      const fail = (error) => { socket.destroy(); reject(error); };
      socket.once('error', fail);
      socket.once('connect', () => { socket.off('error', fail); resolve(); });
    });
    transport = new StdioServerTransport(socket, socket);
    socket.once('close', () => { void transport.close(); });
  } else {
    transport = new StdioServerTransport();
    process.stdin.once('end', () => { void transport.close(); });
    process.stdin.once('close', () => { void transport.close(); });
  }
  await server.connect(transport);
  transport.onclose = () => { for (const s of sessions.values()) s.window.destroy(); app.quit(); }; // handoff_tree windows belong to the independent GUI process.
}
module.exports = { startAutomation, writeArtifact };
