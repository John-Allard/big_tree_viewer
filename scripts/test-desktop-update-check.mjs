import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";

const mainPath = new URL("../desktop/main.cjs", import.meta.url);
const source = await readFile(mainPath, "utf8");
const require = createRequire(mainPath);

function desktop({ platform = "linux", result = null, response = 1, error } = {}) {
  const messages = [];
  const links = [];
  const parent = { isDestroyed: () => false };
  let menu;
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = async () => {
    if (error) throw error;
    return result;
  };
  const app = {
    isPackaged: true,
    setName() {}, setDesktopName() {}, on() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    getVersion: () => "0.1.24",
  };
  const electron = {
    app,
    BrowserWindow: { getFocusedWindow: () => parent, getAllWindows: () => [parent] },
    dialog: { showMessageBox: async (...args) => { messages.push(args.at(-1)); return { response }; } },
    shell: { openExternal: async url => { links.push(url); } },
    protocol: { registerSchemesAsPrivileged() {} },
    Menu: { buildFromTemplate: template => template, setApplicationMenu: template => { menu = template; } },
  };
  const context = vm.createContext({
    require: name => name === "electron" ? electron : name === "electron-updater" ? { autoUpdater } : require(name),
    process: { argv: ["big-tree-viewer"], env: {}, platform },
    __dirname: new URL("../desktop/", import.meta.url).pathname,
  });
  vm.runInContext(source, context, { filename: "desktop/main.cjs" });
  return { messages, links, app, menu: () => menu, run: code => vm.runInContext(code, context) };
}

for (const platform of ["linux", "win32", "darwin"]) {
  const unavailable = desktop({ platform });
  await unavailable.run("checkForUpdates(true)");
  assert.equal(unavailable.messages.length, 1, `${platform}: an inactive updater must not silently ignore a manual check.`);
  assert.match(unavailable.messages[0].message, /not available/i);
  assert.match(unavailable.messages[0].detail, /0\.1\.24/);
  assert.equal(unavailable.links.length, 0, "Do not open the browser without consent.");
  const downloads = desktop({ platform, response: 0 });
  await downloads.run("checkForUpdates(true)");
  assert.deepEqual(downloads.links, ["https://bigtreeviewer.net/#desktop"]);
  const background = desktop({ platform });
  await background.run("checkForUpdates(false)");
  assert.equal(background.messages.length, 0, "An unavailable background check must remain quiet.");
}

const failed = desktop({ error: new Error("Network unavailable") });
await failed.run("checkForUpdates(true)");
assert.equal(failed.messages.length, 1);
assert.match(failed.messages[0].detail, /Network unavailable/);

const active = desktop({ result: { updateInfo: { version: "0.1.25" } } });
await active.run("checkForUpdates(true)");
assert.equal(active.messages.length, 0, "Active updaters keep their existing event-driven prompts.");

for (const platform of ["linux", "win32"]) {
  const window = desktop({ platform });
  window.run("installApplicationMenu()");
  const help = window.menu().find(item => item.role === "help");
  const about = help.submenu.find(item => item.label === "About Big Tree Viewer");
  assert.ok(about, `${platform}: Help must include About Big Tree Viewer.`);
  await window.run("showAboutDialog()");
  assert.match(window.messages[0].detail, /Version 0\.1\.24/);
}

console.log("Manual update checks report unsupported installations; Linux and Windows About dialogs display the version.");
