import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "btv-mcp-launcher-test-"));
const childScript = path.join(fixtureDirectory, "fake-electron.cjs");
const launcher = path.resolve("desktop/mcp-launcher.cjs");
await fs.writeFile(childScript, `
const fs = require("node:fs");
if (!process.argv.includes("--mcp-child")) process.exit(21);
if (!process.env.BTV_USER_DATA_DIR || process.env.BTV_AGENT_PROFILE || process.env.ELECTRON_RUN_AS_NODE) process.exit(22);
process.stdin.pipe(process.stdout);
process.stdin.on("end", () => setImmediate(() => process.exit(0)));
`);

function runOne(label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        BTV_AGENT_PROFILE: "fixed-profile-must-not-reach-child",
        BTV_ELECTRON_EXECUTABLE: process.execPath,
        BTV_ELECTRON_MAIN: childScript,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => {
      try {
        assert.equal(code, 0, stderr);
        assert.equal(stdout, `${label}\n`);
        resolve();
      } catch (error) { reject(error); }
    });
    child.stdin.end(`${label}\n`);
  });
}

try {
  await Promise.all([runOne("first"), runOne("second")]);
  console.log("MCP launcher relayed concurrent isolated sessions and shut down cleanly.");
} finally {
  await fs.rm(fixtureDirectory, { recursive: true, force: true });
}
