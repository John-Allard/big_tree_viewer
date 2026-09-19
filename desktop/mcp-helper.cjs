// Headless MCP front-end. Electron is started lazily only when a tool is called,
// so merely opening an MCP client never registers the desktop app as running.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ReadBuffer, serializeMessage } = require("@modelcontextprotocol/sdk/shared/stdio.js");
const { toolDefinitions } = require("./automation-tools.cjs");
const version = process.env.BTV_APP_VERSION || require("../package.json").version;

const connectionId = crypto.randomUUID();
const ownerStartedAt = Date.now();
const activeSessions = new Set();
let activeCalls = 0;
let runtimeDirectory;
let socketServer;
let backendSocket;
let backendTransport;
let backendClient;
let backendChild;
let backendPromise;
let idleTimer;
let shuttingDown = false;

function report(message) {
  process.stderr.write(`Big Tree Viewer MCP: ${message}\n`);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function removeRuntime(directory) {
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

async function removeStaleRuntimes() {
  let entries;
  try { entries = await fs.readdir(os.tmpdir(), { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name.startsWith("bigtreeviewer-mcp-")).map(async (entry) => {
    const directory = path.join(os.tmpdir(), entry.name);
    let owner;
    try { owner = JSON.parse(await fs.readFile(path.join(directory, "owner.json"), "utf8")); } catch { owner = null; }
    const namePid = Number(/^bigtreeviewer-mcp-(\d+)-/.exec(entry.name)?.[1]);
    if (processIsAlive(owner?.pid || namePid)) return;
    await removeRuntime(directory).catch(() => {});
  }));
}

async function updateOwner(extra = {}) {
  if (!runtimeDirectory) return;
  await fs.writeFile(path.join(runtimeDirectory, "owner.json"), JSON.stringify({
    kind: "bigtreeviewer-mcp",
    startedAt: ownerStartedAt,
    pid: process.pid,
    ...extra,
  }));
}

async function updateIsInProgress() {
  const sharedDirectory = process.env.BTV_SHARED_USER_DATA_DIR;
  if (!sharedDirectory || !path.isAbsolute(sharedDirectory)) return false;
  try {
    const state = JSON.parse(await fs.readFile(path.join(sharedDirectory, "update-in-progress.json"), "utf8"));
    return Date.now() - Number(state.startedAt) < 10 * 60 * 1000;
  } catch { return false; }
}

class SocketTransport {
  constructor(socket) {
    this.socket = socket;
    this.readBuffer = new ReadBuffer();
    this.started = false;
  }
  async start() {
    if (this.started) throw new Error("Socket transport already started.");
    this.started = true;
    this.socket.on("data", chunk => {
      try {
        this.readBuffer.append(chunk);
        let message;
        while ((message = this.readBuffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) { this.onerror?.(error); }
    });
    this.socket.on("error", error => this.onerror?.(error));
    this.socket.once("close", () => this.onclose?.());
  }
  async send(message) {
    if (!this.started || this.socket.destroyed) throw new Error("Rendering backend is not connected.");
    await new Promise((resolve, reject) => this.socket.write(serializeMessage(message), error => error ? reject(error) : resolve()));
  }
  async close() {
    if (!this.socket.destroyed) this.socket.destroy();
  }
}

async function stopBackend() {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  const client = backendClient;
  const child = backendChild;
  backendClient = undefined;
  backendTransport = undefined;
  backendSocket = undefined;
  backendChild = undefined;
  backendPromise = undefined;
  try { await client?.close(); } catch {}
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  activeSessions.clear();
  await updateOwner().catch(() => {});
}

function scheduleIdleBackendStop() {
  clearTimeout(idleTimer);
  if (activeSessions.size > 0 || activeCalls > 0 || !backendChild) return;
  idleTimer = setTimeout(() => { void stopBackend(); }, 5_000);
  idleTimer.unref();
}

async function startBackend() {
  if (backendClient && backendChild?.exitCode === null) return backendClient;
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    if (await updateIsInProgress()) throw new Error("Big Tree Viewer is installing an update. Try this tool again after the app relaunches.");
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\bigtreeviewer-mcp-${connectionId}`
      : path.join(runtimeDirectory, "transport.sock");
    const connectionPromise = new Promise((resolve, reject) => {
      socketServer = net.createServer(connection => {
        if (backendSocket) return connection.destroy();
        backendSocket = connection;
        socketServer.close();
        resolve(connection);
      });
      socketServer.once("error", reject);
      socketServer.listen(endpoint);
    });

    const executable = process.env.BTV_APP_EXECUTABLE || process.env.APPIMAGE || process.execPath;
    const appMain = process.env.BTV_APP_MAIN;
    const args = [...(appMain ? [appMain] : []), `--mcp-socket=${endpoint}`];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.BTV_APP_EXECUTABLE;
    delete env.BTV_APP_MAIN;
    env.BTV_USER_DATA_DIR = path.join(runtimeDirectory, "profile");
    env.ELECTRON_NO_ATTACH_CONSOLE = "1";
    backendChild = spawn(executable, args, { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    await updateOwner({ childPid: backendChild.pid });
    backendChild.stderr?.on("data", chunk => process.stderr.write(chunk));
    backendChild.once("error", error => report(`could not start the rendering backend: ${error.message}`));
    backendChild.once("exit", (code, signal) => {
      if (!shuttingDown && backendChild) report(`rendering backend exited (${code ?? signal ?? "unknown"}).`);
      backendClient = undefined;
      backendTransport = undefined;
      backendSocket = undefined;
      backendChild = undefined;
      backendPromise = undefined;
      activeSessions.clear();
      void updateOwner().catch(() => {});
    });

    const connection = await Promise.race([
      connectionPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Rendering backend did not connect within 30 seconds.")), 30_000)),
    ]);
    backendTransport = new SocketTransport(connection);
    const client = new Client({ name: "big-tree-viewer-mcp-proxy", version });
    await client.connect(backendTransport);
    backendClient = client;
    return client;
  })();
  try { return await backendPromise; }
  catch (error) { await stopBackend(); throw error; }
}

function trackSessions(name, args, result) {
  const data = result?.structuredContent;
  if (name === "open_tree" && data?.sessionId) activeSessions.add(data.sessionId);
  if (name === "close_tree" && result?.isError !== true) activeSessions.delete(args.sessionId);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  socketServer?.close();
  await stopBackend();
  if (runtimeDirectory) await removeRuntime(runtimeDirectory).catch(() => {});
  process.exitCode = exitCode;
}

async function main() {
  await removeStaleRuntimes();
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `bigtreeviewer-mcp-${process.pid}-`));
  await updateOwner();
  const server = new McpServer({ name: "big-tree-viewer", version });
  for (const [name, definition] of Object.entries(toolDefinitions)) {
    server.registerTool(name, { description: definition.description, inputSchema: definition.shape }, async (args, extra) => {
      clearTimeout(idleTimer);
      activeCalls += 1;
      try {
        const client = await startBackend();
        const result = await client.callTool({ name, arguments: args }, undefined, {
          signal: extra.signal,
          timeout: 190_000,
          onprogress: progress => extra._meta?.progressToken === undefined ? undefined : extra.sendNotification({
            method: "notifications/progress",
            params: { ...progress, progressToken: extra._meta.progressToken },
          }),
        });
        trackSessions(name, args, result);
        return result;
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      } finally {
        activeCalls -= 1;
        scheduleIdleBackendStop();
      }
    });
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  transport.onclose = () => { void shutdown(0); };
}

process.stdin.once("end", () => { void shutdown(0); });
process.stdin.once("close", () => { void shutdown(0); });
process.stdout.once("error", () => { void shutdown(1); });
process.once("SIGINT", () => { void shutdown(0); });
process.once("SIGTERM", () => { void shutdown(0); });
process.once("uncaughtException", error => { report(error.stack || error.message); void shutdown(1); });
process.once("unhandledRejection", error => { report(error instanceof Error ? (error.stack || error.message) : String(error)); void shutdown(1); });

void main().catch(error => { report(error.stack || error.message); void shutdown(1); });
