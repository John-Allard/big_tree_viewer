import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { agentClientEnvironment, agentRegistrationMatches, ensureAgentClientRegistration, runAgentClientCommand } = require("../desktop/agent-client.cjs");
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
  const args = ["mcp", "add", "bigtreeviewer", "--", path.join(fixtureDir, "bigtreeviewer-mcp")];
  const result = await runAgentClientCommand(commandName, args, { env, timeoutMs: 5_000 });
  assert.equal(result.error, null, result.stderr || result.error?.message);
  for (const argument of args) assert.match(result.stdout, new RegExp(argument.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const launch = { command: path.join(fixtureDir, "bigtreeviewer-mcp"), args: [] };
  assert.equal(agentRegistrationMatches({ error: null, stdout: `command: ${launch.command}\n` }, launch), true);
  assert.equal(agentRegistrationMatches({ error: null, stdout: "command: /old/Big Tree Viewer\nargs: --mcp\n" }, launch), false);
  const migrated = await ensureAgentClientRegistration(commandName, {
    status: { error: null, stdout: "command: /old/Big Tree Viewer\nargs: --mcp\n", stderr: "" },
    removeArgs: ["mcp", "remove", "bigtreeviewer"],
    addArgs: args,
    launch,
    env,
  });
  assert.equal(migrated.state, "updated", migrated.result.stderr);

  const missing = await runAgentClientCommand("btv-client-that-does-not-exist", [], { env, timeoutMs: 5_000 });
  assert.equal(missing.error?.code, "ENOENT");

  if (process.platform !== "win32") {
    const nodeShim = path.join(fixtureDir, "node");
    const loginShell = path.join(fixtureDir, "login-shell");
    const nodeLauncher = path.join(fixtureDir, "btv-node-launcher");
    await fs.symlink(process.execPath, nodeShim);
    await fs.writeFile(loginShell, "#!/bin/sh\nprintf '__BTV_LOGIN_PATH__%s' \"$BTV_TEST_LOGIN_PATH\"\n");
    await fs.chmod(loginShell, 0o755);
    await fs.writeFile(nodeLauncher, "#!/usr/bin/env node\nconsole.log('node launcher ran');\n");
    await fs.chmod(nodeLauncher, 0o755);
    const guiEnv = {
      ...process.env,
      SHELL: loginShell,
      BTV_TEST_LOGIN_PATH: fixtureDir,
      PATH: "/usr/bin:/bin",
    };
    const resolvedEnv = await agentClientEnvironment(guiEnv);
    assert.equal(resolvedEnv.PATH.split(path.delimiter)[0], fixtureDir);
    const shimResult = await runAgentClientCommand(nodeLauncher, [], { env: resolvedEnv, timeoutMs: 5_000 });
    assert.equal(shimResult.error, null, shimResult.stderr || shimResult.error?.message);
    assert.match(shimResult.stdout, /node launcher ran/);
  }
  console.log(`Agent client launcher passed on ${process.platform}.`);
} finally {
  await fs.rm(fixtureDir, { recursive: true, force: true });
}
