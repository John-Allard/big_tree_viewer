const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const executable = process.env.BTV_ELECTRON_EXECUTABLE || process.execPath;
const electronMain = process.env.BTV_ELECTRON_MAIN;
const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "big-tree-viewer-mcp-"));
const childEnvironment = {
  ...process.env,
  BTV_USER_DATA_DIR: runtimeDirectory,
  BTV_MCP_LAUNCHED: "1",
};
delete childEnvironment.BTV_AGENT_PROFILE;
delete childEnvironment.ELECTRON_RUN_AS_NODE;
delete childEnvironment.BTV_ELECTRON_EXECUTABLE;
delete childEnvironment.BTV_ELECTRON_MAIN;

const childArguments = [...(electronMain ? [electronMain] : []), "--mcp-child"];
const child = spawn(executable, childArguments, {
  env: childEnvironment,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let shuttingDown = false;
let forceTimer = null;

function removeRuntimeDirectory() {
  try { fs.rmSync(runtimeDirectory, { recursive: true, force: true }); } catch {}
}

function stopChild(signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(signal); } catch {}
}

function beginShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  child.stdin.end();
  forceTimer = setTimeout(() => stopChild("SIGKILL"), 5_000);
  forceTimer.unref();
}

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

process.stdin.once("end", beginShutdown);
process.stdin.once("close", beginShutdown);
process.stdout.once("error", beginShutdown);
process.once("SIGINT", () => { stopChild("SIGINT"); beginShutdown(); });
process.once("SIGTERM", () => { stopChild("SIGTERM"); beginShutdown(); });

child.once("error", (error) => {
  process.stderr.write(`Big Tree Viewer MCP launcher could not start Electron: ${error.message}\n`);
  setTimeout(() => {
    removeRuntimeDirectory();
    process.exit(1);
  }, 250);
});

child.once("exit", (code, signal) => {
  if (forceTimer) clearTimeout(forceTimer);
  if (signal && !shuttingDown) process.stderr.write(`Big Tree Viewer MCP Electron process ended with ${signal}.\n`);
  const launcherExitCode = code === 0 || shuttingDown ? 0 : (code ?? 1);
  setTimeout(() => {
    removeRuntimeDirectory();
    process.exit(launcherExitCode);
  }, 250);
});

process.once("exit", () => {
  stopChild("SIGKILL");
  removeRuntimeDirectory();
});
