import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { runAgentClientCommand } = require("../desktop/agent-client.cjs");
const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "btv-agent-client-"));
const commandName = "btv-test-agent";
const commandPath = path.join(fixtureDir, process.platform === "win32" ? `${commandName}.cmd` : commandName);

try {
  if (process.platform === "win32") {
    await fs.writeFile(commandPath, "@echo off\r\nfor %%A in (%*) do @echo %%~A\r\n");
  } else {
    await fs.writeFile(commandPath, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    await fs.chmod(commandPath, 0o755);
  }
  const env = { ...process.env, PATH: `${fixtureDir}${path.delimiter}${process.env.PATH || ""}` };
  const args = ["mcp", "add", "bigtreeviewer", "--", path.join(fixtureDir, "Big Tree Viewer"), "--mcp"];
  const result = await runAgentClientCommand(commandName, args, { env, timeoutMs: 5_000 });
  assert.equal(result.error, null, result.stderr || result.error?.message);
  for (const argument of args) assert.match(result.stdout, new RegExp(argument.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const missing = await runAgentClientCommand("btv-client-that-does-not-exist", [], { env, timeoutMs: 5_000 });
  assert.equal(missing.error?.code, "ENOENT");
  console.log(`Agent client launcher passed on ${process.platform}.`);
} finally {
  await fs.rm(fixtureDir, { recursive: true, force: true });
}
