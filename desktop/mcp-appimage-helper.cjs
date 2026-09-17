// Dependency-free launcher for AppImage, whose temporary mount disappears when
// the GUI exits. Other packages use the lazy MCP proxy in mcp-helper.cjs.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const connectionId = crypto.randomUUID();
let runtimeDirectory;
let server;
let socket;
let child;
let shuttingDown = false;
let startupTimer;

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

function report(message) {
  process.stderr.write(`Big Tree Viewer MCP: ${message}\n`);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(startupTimer);
  process.stdin.unpipe();
  socket?.destroy();
  server?.close();
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (runtimeDirectory) await removeRuntime(runtimeDirectory).catch(() => {});
  process.exitCode = exitCode;
}

async function main() {
  await removeStaleRuntimes();
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `bigtreeviewer-mcp-${process.pid}-`));
  await fs.writeFile(path.join(runtimeDirectory, "owner.json"), JSON.stringify({ pid: process.pid }));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\bigtreeviewer-mcp-${connectionId}`
    : path.join(runtimeDirectory, "transport.sock");

  server = net.createServer(connection => {
    if (socket) return connection.destroy();
    socket = connection;
    clearTimeout(startupTimer);
    connection.on("error", error => { if (!shuttingDown) report(error.message); });
    connection.once("close", () => { void shutdown(0); });
    process.stdin.pipe(connection);
    connection.pipe(process.stdout);
    process.stdin.resume();
  });
  server.on("error", error => { report(error.message); void shutdown(1); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.off("error", reject); resolve(); });
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
  child = spawn(executable, args, { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", chunk => process.stderr.write(chunk));
  child.once("error", error => { report(`could not start the rendering backend: ${error.message}`); void shutdown(1); });
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      report(`rendering backend exited before the MCP connection closed (${code ?? signal ?? "unknown"}).`);
      void shutdown(code === 0 ? 1 : (code ?? 1));
    }
  });
  startupTimer = setTimeout(() => { report("rendering backend did not connect within 30 seconds."); void shutdown(1); }, 30_000);
  startupTimer.unref();
}

process.stdin.once("end", () => { void shutdown(0); });
process.stdin.once("close", () => { void shutdown(0); });
process.stdout.once("error", () => { void shutdown(1); });
process.once("SIGINT", () => { void shutdown(0); });
process.once("SIGTERM", () => { void shutdown(0); });
process.once("uncaughtException", error => { report(error.stack || error.message); void shutdown(1); });
process.once("unhandledRejection", error => { report(error instanceof Error ? (error.stack || error.message) : String(error)); void shutdown(1); });

void main().catch(error => { report(error.stack || error.message); void shutdown(1); });
