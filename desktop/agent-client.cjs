const spawn = require("cross-spawn");
const fs = require("node:fs/promises");
const path = require("node:path");

function runAgentClientCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutError = null;
    let timer = null;
    const child = spawn(command, args, {
      env: options.env || process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error, stdout, stderr });
    };
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", finish);
    child.on("close", (code, signal) => {
      if (timeoutError) finish(timeoutError);
      else if (code === 0) finish(null);
      else {
        const error = new Error(`${command} exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`);
        error.code = code;
        finish(error);
      }
    });
    timer = setTimeout(() => {
      timeoutError = new Error(`${command} did not finish within 30 seconds.`);
      timeoutError.code = "ETIMEDOUT";
      child.kill();
    }, options.timeoutMs || 30_000);
    timer.unref();
  });
}

async function agentClientEnvironment(baseEnv = process.env) {
  if (process.platform === "win32") return { ...baseEnv };
  const shell = baseEnv.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const marker = "__BTV_LOGIN_PATH__";
  const loginPath = await runAgentClientCommand(shell, ["-lc", `printf '${marker}%s' "$PATH"`], {
    env: baseEnv,
    timeoutMs: 5_000,
  });
  const markerIndex = loginPath.stdout.lastIndexOf(marker);
  if (loginPath.error || markerIndex === -1) return { ...baseEnv };
  const discoveredPath = loginPath.stdout.slice(markerIndex + marker.length).trim();
  const pathEntries = [...discoveredPath.split(path.delimiter), ...(baseEnv.PATH || "").split(path.delimiter)]
    .filter((entry, index, entries) => entry && entries.indexOf(entry) === index);
  return { ...baseEnv, PATH: pathEntries.join(path.delimiter) };
}

async function findAgentClientCommand(command, options = {}) {
  if (!/^[a-z0-9-]+$/i.test(command)) return null;
  const env = options.env || await agentClientEnvironment();
  const lookup = process.platform === "win32"
    ? await runAgentClientCommand("where.exe", [command], { env })
    : await runAgentClientCommand(env.SHELL || "/bin/sh", ["-lc", `command -v ${command}`], { env });
  if (!lookup.error) {
    const resolved = lookup.stdout.split(/\r?\n/, 1)[0].trim();
    if (resolved) return resolved;
  }
  const packagedCandidates = command === "codex"
    ? (process.platform === "linux"
      ? ["/usr/lib/chatgpt/resources/codex"]
      : process.platform === "darwin"
        ? [
          "/Applications/Codex.app/Contents/Resources/codex",
          "/Applications/ChatGPT.app/Contents/Resources/codex",
        ]
        : await windowsCodexCandidates(env))
    : [];
  for (const candidate of packagedCandidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue looking for an installed client command.
    }
  }
  return null;
}

async function windowsCodexCandidates(env) {
  const candidates = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "ChatGPT", "resources", "codex.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "ChatGPT", "resources", "codex.exe"),
  ].filter(Boolean);
  const versionedRoot = env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  if (versionedRoot) {
    try {
      const directories = await fs.readdir(versionedRoot, { withFileTypes: true });
      const versioned = await Promise.all(directories.filter(entry => entry.isDirectory()).map(async (entry) => {
        const candidate = path.join(versionedRoot, entry.name, "codex.exe");
        try { return { candidate, modified: (await fs.stat(candidate)).mtimeMs }; } catch { return null; }
      }));
      candidates.unshift(...versioned.filter(Boolean).sort((a, b) => b.modified - a.modified).map(item => item.candidate));
    } catch {
      // Codex is not installed in the desktop runtime location.
    }
  }
  return candidates;
}

function agentRegistrationMatches(status, launch) {
  if (status.error || !status.stdout.includes(launch.command)) return false;
  return launch.args.every((argument) => status.stdout.includes(argument));
}

function environmentArguments(environment) {
  return Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function agentClientRegistrationArguments(client, launch) {
  if (client === "codex") {
    return {
      statusArgs: ["mcp", "get", "bigtreeviewer"],
      removeArgs: ["mcp", "remove", "bigtreeviewer"],
      addArgs: ["mcp", "add", "bigtreeviewer", ...environmentArguments(launch.env), "--", launch.command, ...launch.args],
    };
  }
  if (client === "claude") {
    return {
      statusArgs: ["mcp", "get", "bigtreeviewer"],
      removeArgs: ["mcp", "remove", "bigtreeviewer", "--scope", "user"],
      addArgs: [
        "mcp", "add",
        ...environmentArguments(launch.env),
        "--transport", "stdio", "--scope", "user",
        "bigtreeviewer", "--", launch.command, ...launch.args,
      ],
    };
  }
  throw new Error(`Unsupported agent client: ${client}`);
}

async function ensureAgentClientRegistration(command, { status, removeArgs, addArgs, launch, env }) {
  if (agentRegistrationMatches(status, launch)) return { state: "current", result: status };
  const replacing = !status.error;
  if (replacing) {
    const removed = await runAgentClientCommand(command, removeArgs, { env });
    if (removed.error) return { state: "remove-failed", result: removed };
  }
  const added = await runAgentClientCommand(command, addArgs, { env });
  return { state: added.error ? "add-failed" : (replacing ? "updated" : "added"), result: added };
}

function probeMcpLaunch(launch, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let readBuffer = "";
    let stderr = "";
    let settled = false;
    const child = spawn(launch.command, launch.args, {
      env: { ...process.env, ...launch.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.end();
      setTimeout(() => { if (child.exitCode === null) child.kill(); }, 500).unref();
      resolve({ error, stdout, stderr });
    };
    const inspect = (chunk) => {
      stdout += chunk;
      readBuffer += chunk;
      const lines = readBuffer.split(/\r?\n/);
      readBuffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && message.result) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
          } else if (message.id === 2 && Array.isArray(message.result?.tools)) {
            const names = message.result.tools.map(tool => tool.name);
            const missing = ["open_tree", "render_tree", "inspect_tree", "update_tree", "export_tree", "handoff_tree", "close_tree"].filter(name => !names.includes(name));
            finish(missing.length ? new Error(`MCP probe did not expose: ${missing.join(", ")}`) : null);
          }
        } catch {
          // Wait for a complete valid JSON-RPC line.
        }
      }
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-100_000); });
    child.once("error", finish);
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`MCP helper exited before discovery (${code ?? signal ?? "unknown"}).`));
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "big-tree-viewer-connection-check", version: "1.0" } } })}\n`);
    const timer = setTimeout(() => finish(new Error("MCP helper did not complete discovery within 30 seconds.")), options.timeoutMs || 30_000);
  });
}

module.exports = {
  agentClientEnvironment,
  agentClientRegistrationArguments,
  agentRegistrationMatches,
  ensureAgentClientRegistration,
  findAgentClientCommand,
  probeMcpLaunch,
  runAgentClientCommand,
  windowsCodexCandidates,
};
