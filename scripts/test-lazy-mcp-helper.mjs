import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "btv-lazy-helper-test-"));
const electronExecutable = require("electron");
const packagedApp = process.argv[2] ? await fs.realpath(path.resolve(process.argv[2])) : null;
const externalHelper = process.env.BTV_TEST_HELPER_PATH;
const backendExecutable = process.env.BTV_TEST_APP_EXECUTABLE || electronExecutable;
const helperCommand = packagedApp
  ? path.join(packagedApp, "Contents", "Resources", "bin", "bigtreeviewer-mcp")
  : externalHelper ? backendExecutable : process.execPath;
const transport = new StdioClientTransport({
  command: helperCommand,
  args: packagedApp ? ["--helper-version=3"] : [externalHelper || path.join(root, "desktop", "mcp-helper.cjs")],
  env: {
    ...process.env,
    ...((packagedApp || externalHelper) ? {} : {
      BTV_APP_EXECUTABLE: backendExecutable,
      BTV_APP_MAIN: path.join(root, "desktop", "main.cjs"),
    }),
    ...(externalHelper ? {
      ELECTRON_RUN_AS_NODE: "1",
      BTV_APP_EXECUTABLE: backendExecutable,
      BTV_APP_VERSION: process.env.BTV_APP_VERSION || "0.0.0-test",
    } : {}),
    BTV_SHARED_USER_DATA_DIR: path.join(outputDirectory, "shared"),
    ELECTRON_DISABLE_SANDBOX: "1",
  },
  stderr: "pipe",
});
transport.stderr?.on("data", data => process.stderr.write(data));
const client = new Client({ name: "btv-lifecycle-test", version: "1.0.0" });
let ordinaryGuiPid;

async function ownerState() {
  const entries = await fs.readdir(os.tmpdir(), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`bigtreeviewer-mcp-${transport.pid}-`)) continue;
    return JSON.parse(await fs.readFile(path.join(os.tmpdir(), entry.name, "owner.json"), "utf8"));
  }
  return null;
}

function assertHeadlessOwner(owner, message) {
  assert.equal(owner?.kind, "bigtreeviewer-mcp", message);
  assert.equal(owner?.pid, transport.pid, message);
  assert.equal(owner?.childPid, undefined, message);
}

async function verifyOrdinaryMacLaunch() {
  if (process.platform !== "darwin" || !packagedApp) return;
  const executable = path.join(packagedApp, "Contents", "MacOS", "Big Tree Viewer");
  await execFileAsync("open", [packagedApp]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
    const match = stdout.split("\n").map(line => /^(\s*\d+)\s+(.*)$/.exec(line)).find(parts => parts?.[2] === executable);
    if (match) {
      ordinaryGuiPid = Number(match[1]);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail("LaunchServices routed a normal app launch to the headless MCP process instead of starting the GUI.");
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 7);
  assertHeadlessOwner(await ownerState(), "Listing MCP tools must not launch Electron.");
  await verifyOrdinaryMacLaunch();
  if (ordinaryGuiPid) {
    process.kill(ordinaryGuiPid, "SIGTERM");
    ordinaryGuiPid = undefined;
  }

  const opened = await client.callTool({
    name: "open_tree",
    arguments: { treePath: path.join(root, "tests", "fixtures", "agent-skill-tree.nwk") },
  }, undefined, { timeout: 60_000 });
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  assert.equal(opened.structuredContent.windowVisible, true);
  assert.ok((await ownerState())?.childPid, "Opening a tree must launch the visible Electron app.");
  const closed = await client.callTool({
    name: "close_tree",
    arguments: { sessionId: opened.structuredContent.sessionId },
  }, undefined, { timeout: 60_000 });
  assert.notEqual(closed.isError, true, JSON.stringify(closed));
  await new Promise(resolve => setTimeout(resolve, 6_000));
  assertHeadlessOwner(await ownerState(), "Closing the last agent tree must stop Electron.");

  const result = await client.callTool({
    name: "render_tree",
    arguments: {
      treePath: path.join(root, "tests", "fixtures", "agent-skill-tree.nwk"),
      outputPath: path.join(outputDirectory, "tree.svg"),
    },
  }, undefined, { timeout: 60_000 });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok((await ownerState())?.childPid, "Calling a rendering tool must launch Electron.");
  assert.match(await fs.readFile(path.join(outputDirectory, "tree.svg"), "utf8"), /<svg/);

  await new Promise(resolve => setTimeout(resolve, 6_000));
  assertHeadlessOwner(await ownerState(), "An idle renderer must quit while the MCP server stays connected.");
  console.log("Lazy MCP lifecycle passed: discovery stayed headless, visible launch and rendering worked, and Electron exited when idle.");
} finally {
  if (ordinaryGuiPid) {
    try { process.kill(ordinaryGuiPid, "SIGTERM"); } catch {}
  }
  await client.close().catch(() => {});
  await fs.rm(outputDirectory, { recursive: true, force: true });
}
