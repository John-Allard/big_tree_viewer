const fs = require("node:fs/promises");
const path = require("node:path");

// Only desktop-session routing, never the user's full environment or credentials.
const desktopEnvironmentKeys = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE"];

async function saveDesktopEnvironment(directory, env = process.env) {
  if (process.platform !== "linux") return;
  const values = Object.fromEntries(desktopEnvironmentKeys.filter(key => env[key]).map(key => [key, env[key]]));
  if (!values.DISPLAY && !values.WAYLAND_DISPLAY) return;
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, "desktop-environment.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(values), { mode: 0o600 });
  await fs.rename(temporary, target);
}

async function renderingEnvironment(base = process.env, platform = process.platform) {
  const env = { ...base };
  if (platform !== "linux") return env;
  const directory = env.BTV_SHARED_USER_DATA_DIR;
  if (directory && path.isAbsolute(directory)) {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(directory, "desktop-environment.json"), "utf8"));
      for (const key of desktopEnvironmentKeys) {
        if (!env[key] && typeof saved[key] === "string" && saved[key]) env[key] = saved[key];
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Could not read Big Tree Viewer's desktop session: ${error.message}`);
    }
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw new Error("No Linux graphical session is available. Open Big Tree Viewer normally once in your desktop session, then retry this tool. If the agent is running on another computer or in a container, use Big Tree Viewer on the local desktop instead.");
  }
  return env;
}

module.exports = { desktopEnvironmentKeys, saveDesktopEnvironment, renderingEnvironment };
