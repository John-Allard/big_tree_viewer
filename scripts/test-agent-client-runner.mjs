import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  agentClientEnvironment,
  agentClientRegistrationArguments,
  agentRegistrationMatches,
  ensureAgentClientRegistration,
  genericAgentSetupInstructions,
  probeMcpLaunch,
  runAgentClientCommand,
  windowsCodexCandidates,
} = require("../desktop/agent-client.cjs");
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

  const launch = { command: path.join(fixtureDir, "bigtreeviewer-mcp"), args: ["--helper-version=2"] };
  assert.equal(agentRegistrationMatches({ error: null, stdout: `command: ${launch.command}\nargs: ${launch.args.join(" ")}\n` }, launch), true);
  assert.equal(agentRegistrationMatches({ error: null, stdout: "command: /old/Big Tree Viewer\nargs: --mcp\n" }, launch), false);
  const registrationLaunch = { ...launch, env: { BTV_CACHE: path.join(fixtureDir, "agent cache") } };
  assert.deepEqual(agentClientRegistrationArguments("codex", registrationLaunch), {
    statusArgs: ["mcp", "get", "bigtreeviewer"],
    removeArgs: ["mcp", "remove", "bigtreeviewer"],
    addArgs: ["mcp", "add", "bigtreeviewer", "--env", `BTV_CACHE=${registrationLaunch.env.BTV_CACHE}`, "--", launch.command, ...launch.args],
  });
  assert.deepEqual(agentClientRegistrationArguments("claude", registrationLaunch), {
    statusArgs: ["mcp", "get", "bigtreeviewer"],
    removeArgs: ["mcp", "remove", "bigtreeviewer", "--scope", "user"],
    addArgs: [
      "mcp", "add", "--env", `BTV_CACHE=${registrationLaunch.env.BTV_CACHE}`, "--transport", "stdio", "--scope", "user",
      "bigtreeviewer", "--", launch.command, ...launch.args,
    ],
  });
  const genericInstructions = genericAgentSetupInstructions(registrationLaunch);
  assert.match(genericInstructions, /local Big Tree Viewer MCP server/);
  assert.match(genericInstructions, /user or global scope/);
  assert.match(genericInstructions, new RegExp(launch.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(genericInstructions, /BTV_CACHE/);
  assert.match(genericInstructions, /launch this command on demand/);
  const migrated = await ensureAgentClientRegistration(commandName, {
    status: { error: null, stdout: "command: /old/Big Tree Viewer\nargs: --mcp\n", stderr: "" },
    removeArgs: ["mcp", "remove", "bigtreeviewer"],
    addArgs: ["mcp", "add", "bigtreeviewer", "--", launch.command, ...launch.args],
    launch,
    env,
  });
  assert.equal(migrated.state, "updated", migrated.result.stderr);

  const missing = await runAgentClientCommand("btv-client-that-does-not-exist", [], { env, timeoutMs: 5_000 });
  assert.equal(missing.error?.code, "ENOENT");

  const probeServer = path.join(fixtureDir, "probe-server.cjs");
  await fs.writeFile(probeServer, `
    const readline = require("node:readline").createInterface({ input: process.stdin });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } }) + "\\n");
      if (message.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: ["open_tree","render_tree","inspect_tree","update_tree","export_tree","handoff_tree","close_tree"].map(name => ({ name })) } }) + "\\n");
    });
  `);
  const probe = await probeMcpLaunch({ command: process.execPath, args: [probeServer], env: {} }, { timeoutMs: 5_000 });
  assert.equal(probe.error, null, probe.stderr || probe.error?.message);

  const versionedCodexRoot = path.join(fixtureDir, "OpenAI", "Codex", "bin");
  const olderCodex = path.join(versionedCodexRoot, "older", "codex.exe");
  const newerCodex = path.join(versionedCodexRoot, "newer", "codex.exe");
  await fs.mkdir(path.dirname(olderCodex), { recursive: true });
  await fs.mkdir(path.dirname(newerCodex), { recursive: true });
  await fs.writeFile(olderCodex, "older");
  await new Promise(resolve => setTimeout(resolve, 10));
  await fs.writeFile(newerCodex, "newer");
  const candidates = await windowsCodexCandidates({ LOCALAPPDATA: fixtureDir });
  assert.equal(candidates[0], newerCodex);

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
