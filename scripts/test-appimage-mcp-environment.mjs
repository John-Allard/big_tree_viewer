import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const { desktopEnvironmentKeys, saveDesktopEnvironment } = require("../desktop/agent-environment.cjs");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "btv-appimage-env-test-"));
const root = path.resolve(".");
const executable = process.argv[2] ? path.resolve(process.argv[2]) : require("electron");
const env = { ...process.env };
await saveDesktopEnvironment(directory);
if (process.platform === "linux") for (const key of desktopEnvironmentKeys) delete env[key];
// Exercise the external AppImage helper, not the lazy non-AppImage proxy.
const transport = new StdioClientTransport({
  command: executable,
  args: [path.join(root, "desktop/mcp-appimage-helper.cjs")],
  env: {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
    BTV_APP_EXECUTABLE: executable,
    ...(process.argv[2] ? {} : { BTV_APP_MAIN: path.join(root, "desktop/main.cjs") }),
    BTV_SHARED_USER_DATA_DIR: directory,
    ELECTRON_DISABLE_SANDBOX: "1",
  },
  stderr: "pipe",
});
transport.stderr?.on("data", chunk => process.stderr.write(chunk));
const client = new Client({ name: "btv-appimage-env-test", version: "1" });
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 7);
  const outputPath = path.join(directory, "tree.svg");
  const result = await client.callTool({ name: "render_tree", arguments: {
    treePath: path.join(root, "tests/fixtures/agent-skill-tree.nwk"), outputPath,
  } }, undefined, { timeout: 60_000 });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.match(await fs.readFile(outputPath, "utf8"), /<svg/);
  console.log("AppImage MCP environment passed: filtered environment, seven tools, actual SVG render.");
} finally {
  await client.close();
  await fs.rm(directory, { recursive: true, force: true });
}
