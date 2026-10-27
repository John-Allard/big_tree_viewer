import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import { setImmediate as settle } from "node:timers/promises";

const mainPath = new URL("../desktop/main.cjs", import.meta.url);
const source = await readFile(mainPath, "utf8");
const require = createRequire(mainPath);

function desktop({ platform = "linux", result = null, response = 1, error, holdDialogs = false, check } = {}) {
  const messages = [];
  const links = [];
  const pendingDialogs = [];
  const timers = [];
  let checks = 0;
  const parent = { isDestroyed: () => false };
  let menu;
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = async () => {
    checks += 1;
    if (check) return check(autoUpdater);
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
    dialog: { showMessageBox: (...args) => {
      messages.push(args.at(-1));
      return holdDialogs ? new Promise(resolve => pendingDialogs.push(resolve)) : Promise.resolve({ response });
    } },
    shell: { openExternal: async url => { links.push(url); } },
    protocol: { registerSchemesAsPrivileged() {} },
    Menu: { buildFromTemplate: template => template, setApplicationMenu: template => { menu = template; } },
  };
  const context = vm.createContext({
    require: name => name === "electron" ? electron : name === "electron-updater" ? { autoUpdater } : require(name),
    process: { argv: ["big-tree-viewer"], env: {}, platform },
    __dirname: new URL("../desktop/", import.meta.url).pathname,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return { unref() {} }; },
    setInterval: () => ({ unref() {} }),
  });
  vm.runInContext(source, context, { filename: "desktop/main.cjs" });
  return { messages, links, app, autoUpdater, timers, pendingDialogs, checks: () => checks,
    menu: () => menu, run: code => vm.runInContext(code, context) };
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

for (const { platform, manualFirst } of ["linux", "win32", "darwin"].flatMap(platform => (
  [true, false].map(manualFirst => ({ platform, manualFirst }))
))) {
  const updater = desktop({ platform, holdDialogs: true, check: events => {
    events.emit("update-available", { version: "0.1.25" });
    return { updateInfo: { version: "0.1.25" } };
  } });
  updater.run("configureAutoUpdates()");
  await updater.run(`checkForUpdates(${manualFirst})`);
  assert.equal(updater.messages.length, 1);
  // EventEmitter does not wait for the asynchronous dialog handler. The check
  // has finished, but the user has not answered the first update prompt.
  updater.timers.find(timer => timer.delay === 15000).callback();
  await settle();
  assert.equal(updater.messages.length, 1, `${platform}: the startup check must not duplicate an unanswered update prompt.`);
  await updater.run("checkForUpdates(true)");
  await settle();
  assert.equal(updater.messages.length, 1, `${platform}: startup/manual checks must not duplicate an unanswered update prompt.`);
  assert.equal(updater.checks(), 1, "Do not issue another network check while awaiting the user's choice.");
  updater.autoUpdater.emit("update-available", { version: "0.1.25" });
  assert.equal(updater.messages.length, 1, "Duplicate updater events must not open another prompt either.");
  updater.pendingDialogs.shift()({ response: 1 });
  await settle();
  await updater.run("checkForUpdates(true)");
  assert.equal(updater.messages.length, 2, "Choosing Later must allow a subsequent explicit update check.");
  updater.pendingDialogs.shift()({ response: 1 });
  await settle();
}

let downloadAttempts = 0;
let rejectDownload;
const downloading = desktop({ holdDialogs: true, check: events => {
  events.emit("update-available", { version: "0.1.25" });
  return { updateInfo: { version: "0.1.25" } };
} });
downloading.autoUpdater.downloadUpdate = () => {
  downloadAttempts += 1;
  return new Promise((_resolve, reject) => { rejectDownload = reject; });
};
downloading.run(`
  setUpdateProgress = () => {};
  showUpdateProgressWindow = async () => {};
  closeUpdateProgressWindow = async () => {};
  configureAutoUpdates();
`);
await downloading.run("checkForUpdates(true)");
downloading.pendingDialogs.shift()({ response: 0 });
await settle();
assert.equal(downloadAttempts, 1);
assert.equal(downloading.run("updateDownloadInProgress"), true);
assert.equal(downloading.run("updateAvailablePromptInProgress"), false);
downloading.autoUpdater.emit("update-available", { version: "0.1.25" });
await downloading.run("checkForUpdates(false)");
assert.equal(downloading.messages.length, 1, "Prompt-to-download handoff must not admit another update offer.");
assert.equal(downloading.checks(), 1);
rejectDownload(new Error("Download connection failed"));
await settle();
assert.equal(downloading.messages.length, 2);
assert.equal(downloading.messages[1].title, "Update Download Failed");
assert.equal(downloading.run("updateDownloadInProgress"), false);
downloading.pendingDialogs.shift()({ response: 0 });
await settle();
await downloading.run("checkForUpdates(true)");
assert.equal(downloading.messages.length, 3, "A failed download must allow another explicit check.");
downloading.pendingDialogs.shift()({ response: 1 });
await settle();

for (const platform of ["linux", "win32"]) {
  const window = desktop({ platform });
  window.run("installApplicationMenu()");
  const help = window.menu().find(item => item.role === "help");
  const about = help.submenu.find(item => item.label === "About Big Tree Viewer");
  assert.ok(about, `${platform}: Help must include About Big Tree Viewer.`);
  await window.run("showAboutDialog()");
  assert.match(window.messages[0].detail, /Version 0\.1\.24/);
}

console.log("Update prompts remain single during overlapping checks and downloads; unsupported installs and About dialogs report correctly.");
