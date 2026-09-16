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

async function findAgentClientCommand(command) {
  if (!/^[a-z0-9-]+$/i.test(command)) return null;
  const lookup = process.platform === "win32"
    ? await runAgentClientCommand("where.exe", [command])
    : await runAgentClientCommand(process.env.SHELL || "/bin/sh", ["-lc", `command -v ${command}`]);
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
        : [
          process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "ChatGPT", "resources", "codex.exe"),
          process.env.ProgramFiles && path.join(process.env.ProgramFiles, "ChatGPT", "resources", "codex.exe"),
        ].filter(Boolean))
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

module.exports = { findAgentClientCommand, runAgentClientCommand };
