const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { agentClientEnvironment, ensureAgentClientRegistration, findAgentClientCommand, runAgentClientCommand } = require("./agent-client.cjs");

const TREE_EXTENSIONS = new Set([
  ".btvsession", ".contree", ".dnd", ".mcc", ".mctree", ".newick", ".nex",
  ".json", ".nexus", ".nh", ".nhx", ".nwk", ".tre", ".tree", ".treefile", ".trees", ".txt", ".ufboot",
]);

protocol.registerSchemesAsPrivileged([{
  scheme: "btv",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}, {
  scheme: "btv-file",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const commandIndex = process.argv.indexOf("--command");
const automationMode = process.argv.includes("--mcp") || process.argv.includes("--mcp-child") || commandIndex !== -1;
let temporaryAutomationDirectory = null;
if (process.env.BTV_USER_DATA_DIR) {
  if (!path.isAbsolute(process.env.BTV_USER_DATA_DIR)) throw new Error("BTV_USER_DATA_DIR must be absolute.");
  app.setPath("userData", process.env.BTV_USER_DATA_DIR);
} else if (automationMode) {
  temporaryAutomationDirectory = fsSync.mkdtempSync(path.join(os.tmpdir(), "big-tree-viewer-mcp-"));
  app.setPath("userData", temporaryAutomationDirectory);
}
app.setName("Big Tree Viewer");
if (automationMode && process.platform === "darwin") app.setActivationPolicy("accessory");
if (temporaryAutomationDirectory) process.once("exit", () => fsSync.rmSync(temporaryAutomationDirectory, { recursive: true, force: true }));

let mainWindow = null;
let pendingOpenPaths = [];
const grantedFiles = new Map();
let updateCheckIsManual = false;
let updateCheckInProgress = false;
let updateDownloadInProgress = false;
let updateProgressWindow = null;
let recentPaths = [];
const MAX_RECENT_PATHS = 10;

function agentServerLaunch() {
  if (app.isPackaged && process.platform === "darwin") {
    return { command: path.join(process.resourcesPath, "bin", "bigtreeviewer-mcp"), args: [], env: {} };
  }
  if (app.isPackaged) {
    return {
      command: process.execPath,
      args: [path.join(process.resourcesPath, "app.asar", "desktop", "mcp-launcher.cjs")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return {
    command: process.execPath,
    args: [path.join(__dirname, "mcp-launcher.cjs")],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      BTV_ELECTRON_EXECUTABLE: process.execPath,
      BTV_ELECTRON_MAIN: path.join(__dirname, "main.cjs"),
    },
  };
}

async function connectAgentClient({ name, command, statusArgs, removeArgs, addArgs, launch }) {
  const clientEnv = await agentClientEnvironment();
  let clientCommand = command;
  let status = await runAgentClientCommand(clientCommand, statusArgs, { env: clientEnv });
  if (status.error?.code === "ENOENT") {
    clientCommand = await findAgentClientCommand(command, { env: clientEnv });
    if (clientCommand) status = await runAgentClientCommand(clientCommand, statusArgs, { env: clientEnv });
  }
  if (status.error?.code === "ENOENT") {
    await dialog.showMessageBox(activeWindow(), {
      type: "error",
      title: `${name} Was Not Found`,
      message: `Big Tree Viewer could not find ${name} on this computer.`,
      detail: `Make sure ${name} is installed, then restart Big Tree Viewer and try again. No settings files need to be edited.`,
      buttons: ["OK"],
    });
    return;
  }
  const registration = await ensureAgentClientRegistration(clientCommand, {
    status, removeArgs, addArgs, launch, env: clientEnv,
  });
  if (registration.state === "current") {
    await dialog.showMessageBox(activeWindow(), {
      type: "info",
      title: `${name} Is Connected`,
      message: `Big Tree Viewer is already available in ${name}.`,
      detail: `If ${name} is currently open and does not show the Big Tree Viewer tools, close and reopen it.`,
      buttons: ["Done"],
    });
    return;
  }
  if (registration.state === "remove-failed") {
    await dialog.showMessageBox(activeWindow(), {
      type: "error",
      title: `Could Not Update ${name}`,
      message: `Big Tree Viewer found an older ${name} connection but could not replace it.`,
      detail: registration.result.stderr || registration.result.error.message,
      buttons: ["OK"],
    });
    return;
  }
  if (registration.state === "add-failed") {
    await dialog.showMessageBox(activeWindow(), {
      type: "error",
      title: `Could Not Connect ${name}`,
      message: `Big Tree Viewer could not connect to ${name}.`,
      detail: registration.result.stderr || `Close and reopen both applications, make sure they are up to date, and try again. You do not need to edit a settings file.`,
      buttons: ["OK"],
    });
    return;
  }

  await dialog.showMessageBox(activeWindow(), {
    type: "info",
    title: registration.state === "updated" ? `${name} Connection Updated` : `${name} Connected`,
    message: registration.state === "updated" ? `Big Tree Viewer updated its ${name} connection.` : `Big Tree Viewer is now available in ${name}.`,
    detail: `Close and reopen ${name} if it is currently running. You can then ask it to open, style, inspect, or export a tree with Big Tree Viewer.`,
    buttons: ["Done"],
  });
}

async function showAgentConnectionDialog() {
  const choice = await dialog.showMessageBox(activeWindow(), {
    type: "question",
    title: "Connect an AI Agent",
    message: "Which AI app would you like to connect?",
    detail: "Big Tree Viewer can give an AI agent local tools for opening, styling, inspecting, and exporting phylogenetic trees.",
    buttons: ["Codex", "Claude Code", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });

  if (choice.response === 0) {
    const launch = agentServerLaunch();
    await connectAgentClient({
      name: "Codex",
      command: "codex",
      statusArgs: ["mcp", "get", "bigtreeviewer"],
      removeArgs: ["mcp", "remove", "bigtreeviewer"],
      addArgs: ["mcp", "add", "bigtreeviewer", ...Object.entries(launch.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--", launch.command, ...launch.args],
      launch,
    });
  } else if (choice.response === 1) {
    const launch = agentServerLaunch();
    await connectAgentClient({
      name: "Claude Code",
      command: "claude",
      statusArgs: ["mcp", "get", "bigtreeviewer"],
      removeArgs: ["mcp", "remove", "--scope", "user", "bigtreeviewer"],
      addArgs: ["mcp", "add", "--scope", "user", "bigtreeviewer", ...Object.entries(launch.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--", launch.command, ...launch.args],
      launch,
    });
  }
}

function activeWindow() {
  return BrowserWindow.getFocusedWindow() || mainWindow || BrowserWindow.getAllWindows()[0] || null;
}

function setUpdateProgress(value) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setProgressBar(value);
  }
}

function formatUpdateBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = amount >= 100 || unitIndex === 0 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function closeUpdateProgressWindow() {
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) updateProgressWindow.close();
  updateProgressWindow = null;
}

function showUpdateProgressWindow(version) {
  closeUpdateProgressWindow();
  const parent = activeWindow();
  updateProgressWindow = new BrowserWindow({
    width: 440,
    height: 180,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    modal: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#f7f8fa",
    title: "Downloading Big Tree Viewer Update",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  updateProgressWindow.on("closed", () => { updateProgressWindow = null; });
  const safeVersion = String(version || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; padding: 24px; background: #f7f8fa; color: #172033; }
  h1 { margin: 0 0 17px; font-size: 17px; font-weight: 650; letter-spacing: 0; }
  progress { display: block; width: 100%; height: 14px; accent-color: #2563eb; }
  .status { display: flex; justify-content: space-between; gap: 16px; margin-top: 10px; font-size: 13px; color: #536078; }
</style></head><body>
  <h1>Downloading Big Tree Viewer${safeVersion ? ` ${safeVersion}` : ""}</h1>
  <progress id="progress" max="100" value="0"></progress>
  <div class="status"><span id="amount">Preparing download...</span><span id="percent">0%</span></div>
  <script>
    window.setDownloadProgress = ({ percent, amount }) => {
      document.getElementById("progress").value = percent;
      document.getElementById("percent").textContent = percent + "%";
      document.getElementById("amount").textContent = amount || "Downloading update...";
    };
  </script>
</body></html>`;
  void updateProgressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  updateProgressWindow.once("ready-to-show", () => updateProgressWindow?.show());
}

function updateDownloadProgressWindow(progress) {
  if (!updateProgressWindow || updateProgressWindow.isDestroyed()) return;
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
  const transferred = formatUpdateBytes(progress.transferred);
  const total = formatUpdateBytes(progress.total);
  const amount = transferred && total ? `${transferred} of ${total}` : transferred;
  const payload = JSON.stringify({ percent, amount });
  void updateProgressWindow.webContents.executeJavaScript(`window.setDownloadProgress(${payload})`).catch(() => {});
}

async function checkForUpdates(manual = true) {
  if (!app.isPackaged) {
    if (manual) {
      await dialog.showMessageBox(activeWindow(), {
        type: "info",
        title: "Check for Updates",
        message: "Update checks are available in installed builds.",
        detail: `This development build is version ${app.getVersion()}.`,
        buttons: ["OK"],
      });
    }
    return;
  }
  if (updateDownloadInProgress) {
    if (manual) {
      await dialog.showMessageBox(activeWindow(), {
        type: "info",
        title: "Update in Progress",
        message: "Big Tree Viewer is already downloading an update.",
        buttons: ["OK"],
      });
    }
    return;
  }
  if (updateCheckInProgress) return;
  updateCheckIsManual = manual;
  updateCheckInProgress = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    updateCheckIsManual = false;
    if (manual) {
      await dialog.showMessageBox(activeWindow(), {
        type: "error",
        title: "Unable to Check for Updates",
        message: "Big Tree Viewer could not check for updates.",
        detail: error instanceof Error ? error.message : String(error),
        buttons: ["OK"],
      });
    }
  } finally {
    updateCheckInProgress = false;
  }
}

function configureAutoUpdates() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-not-available", async () => {
    updateCheckInProgress = false;
    if (!updateCheckIsManual) return;
    updateCheckIsManual = false;
    await dialog.showMessageBox(activeWindow(), {
      type: "info",
      title: "Big Tree Viewer Is Up to Date",
      message: `You are using the latest version (${app.getVersion()}).`,
      buttons: ["OK"],
    });
  });
  autoUpdater.on("update-available", async (info) => {
    updateCheckInProgress = false;
    updateCheckIsManual = false;
    const result = await dialog.showMessageBox(activeWindow(), {
      type: "info",
      title: "Big Tree Viewer Update Available",
      message: `Version ${info.version} is available.`,
      detail: "Download it now? You can keep working while the update downloads.",
      buttons: ["Download Update", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response !== 0) return;
    updateDownloadInProgress = true;
    setUpdateProgress(0);
    showUpdateProgressWindow(info.version);
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      updateDownloadInProgress = false;
      setUpdateProgress(-1);
      closeUpdateProgressWindow();
      await dialog.showMessageBox(activeWindow(), {
        type: "error",
        title: "Update Download Failed",
        message: "Big Tree Viewer could not download the update.",
        detail: error instanceof Error ? error.message : String(error),
        buttons: ["OK"],
      });
    }
  });
  autoUpdater.on("download-progress", (progress) => {
    setUpdateProgress(Math.max(0, Math.min(1, progress.percent / 100)));
    updateDownloadProgressWindow(progress);
  });
  autoUpdater.on("update-downloaded", async (info) => {
    updateDownloadInProgress = false;
    setUpdateProgress(-1);
    closeUpdateProgressWindow();
    const result = await dialog.showMessageBox(activeWindow(), {
      type: "info",
      title: "Update Ready",
      message: `Big Tree Viewer ${info.version} has been downloaded.`,
      detail: "Relaunch Big Tree Viewer to install the update. Unsaved work will be lost.",
      buttons: ["Relaunch Big Tree Viewer and Install", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on("error", () => {
    updateCheckIsManual = false;
    updateCheckInProgress = false;
    updateDownloadInProgress = false;
    setUpdateProgress(-1);
    closeUpdateProgressWindow();
  });

  const initialCheck = setTimeout(() => void checkForUpdates(false), 15_000);
  initialCheck.unref();
  const periodicCheck = setInterval(() => void checkForUpdates(false), 24 * 60 * 60 * 1000);
  periodicCheck.unref();
}

function isSupportedTreePath(filePath) {
  return typeof filePath === "string" && TREE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function collectTreePaths(argv) {
  return argv.filter(isSupportedTreePath).map((filePath) => path.resolve(filePath));
}

function recentPathsFile() {
  return path.join(app.getPath("userData"), "recent-files.json");
}

async function loadRecentPaths() {
  try {
    const parsed = JSON.parse(await fs.readFile(recentPathsFile(), "utf8"));
    recentPaths = Array.isArray(parsed)
      ? [...new Set(parsed.filter(isSupportedTreePath).map((filePath) => path.resolve(filePath)))].slice(0, MAX_RECENT_PATHS)
      : [];
  } catch (error) {
    if (error.code !== "ENOENT") process.stderr.write(`Could not read recent files: ${error.message}\n`);
    recentPaths = [];
  }
}

async function saveRecentPaths() {
  try {
    await fs.mkdir(path.dirname(recentPathsFile()), { recursive: true });
    await fs.writeFile(recentPathsFile(), `${JSON.stringify(recentPaths, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Could not save recent files: ${error.message}\n`);
  }
}

async function rememberRecentPaths(paths) {
  if (automationMode) return;
  const supported = paths.filter(isSupportedTreePath).map((filePath) => path.resolve(filePath));
  if (supported.length === 0) return;
  recentPaths = [...new Set([...supported, ...recentPaths])].slice(0, MAX_RECENT_PATHS);
  for (const filePath of supported) app.addRecentDocument(filePath);
  await saveRecentPaths();
  installApplicationMenu();
}

async function clearRecentPaths() {
  recentPaths = [];
  app.clearRecentDocuments();
  await saveRecentPaths();
  installApplicationMenu();
}

async function openRecentPath(filePath) {
  try {
    await fs.access(filePath);
    sendOpenPaths([filePath]);
  } catch {
    recentPaths = recentPaths.filter((candidate) => candidate !== filePath);
    await saveRecentPaths();
    installApplicationMenu();
    await dialog.showMessageBox(activeWindow(), {
      type: "warning",
      title: "File Not Found",
      message: `${path.basename(filePath)} could not be opened.`,
      detail: "The file may have been moved, renamed, or deleted. It has been removed from Open Recent.",
      buttons: ["OK"],
    });
  }
}

function sendOpenPaths(paths) {
  const uniquePaths = [...new Set(paths.filter(isSupportedTreePath))];
  if (uniquePaths.length === 0) return;
  if (!automationMode) void rememberRecentPaths(uniquePaths);
  const target = activeWindow();
  if (!target || target.isDestroyed() || target.webContents.isLoading()) {
    pendingOpenPaths.push(...uniquePaths);
    return;
  }
  target.webContents.send("btv:open-paths", uniquePaths);
  target.show();
  target.focus();
}

function sendMenuCommand(command) {
  const target = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!target || target.isDestroyed()) return;
  target.webContents.send("btv:menu-command", command);
}

async function showDefaultApplicationHelp() {
  if (process.platform === "darwin") {
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Set Big Tree Viewer as the Default",
      message: "Set Big Tree Viewer as the default for tree files",
      detail: "Big Tree Viewer sessions are registered with Big Tree Viewer when the app is installed. For Newick and other tree files, select a file in Finder, choose File > Get Info, select Big Tree Viewer under Open with, then click Change All.",
      buttons: ["OK"],
    });
    return;
  }
  if (process.platform === "win32") {
    const result = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Set Big Tree Viewer as the Default",
      message: "Choose Big Tree Viewer for tree file types",
      detail: "Windows controls default applications. Open Default Apps, search for a tree extension such as .nwk, and choose Big Tree Viewer.",
      buttons: ["Open Default Apps", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) void shell.openExternal("ms-settings:defaultapps");
    return;
  }
  await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Set Big Tree Viewer as the Default",
    message: "Set Big Tree Viewer as the default for tree files",
    detail: "In your file manager, right-click a tree file, choose Open With, select Big Tree Viewer, and enable the option to remember or always use that application.",
    buttons: ["OK"],
  });
}

async function chooseTreeFiles(parent = activeWindow()) {
  const result = await dialog.showOpenDialog(parent, {
    title: "Open tree or Big Tree Viewer session",
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Phylogenetic trees and BTV sessions",
        extensions: [...TREE_EXTENSIONS].map((extension) => extension.slice(1)),
      },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!result.canceled) sendOpenPaths(result.filePaths);
}

function installApplicationMenu({ allowNewWindow = !automationMode } = {}) {
  const recentSubmenu = recentPaths.length > 0
    ? [
      ...recentPaths.map((filePath) => ({
        label: path.basename(filePath),
        toolTip: filePath,
        click: () => void openRecentPath(filePath),
      })),
      { type: "separator" },
      { label: "Clear Menu", click: () => void clearRecentPaths() },
    ]
    : [{ label: "No Recent Files", enabled: false }];
  const template = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { label: "Check for Updates...", click: () => void checkForUpdates(true) },
        { type: "separator" }, { role: "services" }, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        ...(allowNewWindow ? [{ label: "New Window", accelerator: "CmdOrCtrl+N", click: () => createWindow() }] : []),
        { label: "Open Tree or Session...", accelerator: "CmdOrCtrl+O", click: () => void chooseTreeFiles() },
        { label: "Open Recent", submenu: recentSubmenu },
        { type: "separator" },
        { label: "Save Session...", accelerator: "CmdOrCtrl+S", click: () => sendMenuCommand("save-session") },
        { label: "Save Tree as Newick...", click: () => sendMenuCommand("save-newick") },
        { label: "Load Settings...", click: () => sendMenuCommand("load-settings") },
        { type: "separator" },
        { label: "Export View...", accelerator: "CmdOrCtrl+Shift+E", click: () => sendMenuCommand("export-view") },
        { type: "separator" },
        { label: "Set as Default for Tree Files...", click: () => void showDefaultApplicationHelp() },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Fit View", accelerator: "CmdOrCtrl+0", click: () => sendMenuCommand("fit-view") },
        { label: "Toggle Side Panel", accelerator: "CmdOrCtrl+Shift+B", click: () => sendMenuCommand("toggle-side-panel") },
        { type: "separator" },
        {
          label: "Toggle Full Screen",
          accelerator: process.platform === "darwin" ? "Control+Command+F" : "F11",
          click: () => sendMenuCommand("toggle-full-screen"),
        },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        ...(process.platform === "darwin" ? [] : [
          { label: "Check for Updates...", click: () => void checkForUpdates(true) },
          { type: "separator" },
        ]),
        { label: "Connect an AI Agent...", click: () => void showAgentConnectionDialog() },
        { label: "Big Tree Viewer Website", click: () => void shell.openExternal("https://bigtreeviewer.net/") },
        { label: "Learn More", click: () => void shell.openExternal("https://bigtreeviewer.net/#about") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerAppProtocol() {
  const webRoot = path.resolve(__dirname, "..", "dist");
  protocol.handle("btv", (request) => {
    const requestUrl = new URL(request.url);
    let relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    if (!relativePath) relativePath = "index.html";
    const resolvedPath = path.resolve(webRoot, relativePath);
    if (resolvedPath !== webRoot && !resolvedPath.startsWith(`${webRoot}${path.sep}`)) {
      return new Response("Invalid application path", { status: 400 });
    }
    return net.fetch(pathToFileURL(resolvedPath).toString());
  });
  protocol.handle("btv-file", (request) => {
    const requestUrl = new URL(request.url);
    const token = requestUrl.pathname.replace(/^\/+/, "").split("/", 1)[0];
    const filePath = grantedFiles.get(token);
    if (requestUrl.hostname !== "open" || !filePath) {
      return new Response("File access was not granted", { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

async function grantFile(filePath, allowAnyExtension = false) {
  if (typeof filePath !== "string" || (!allowAnyExtension && !isSupportedTreePath(filePath))) throw new Error("Unsupported tree file type.");
  const resolvedPath = path.resolve(filePath);
  const fileInfo = await fs.stat(resolvedPath);
  if (!fileInfo.isFile()) throw new Error("The selected tree path is not a file.");
  const token = crypto.randomUUID();
  grantedFiles.set(token, resolvedPath);
  return { name: path.basename(resolvedPath), url: `btv-file://open/${token}/${encodeURIComponent(path.basename(resolvedPath))}` };
}

function viewerWindowOptions({ width = 1440, height = 960, show = false } = {}) {
  const iconPath = path.resolve(
    __dirname,
    "..",
    app.isPackaged ? "dist" : "public",
    "icon-512.png",
  );
  return {
    width,
    height,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#fbfcfe",
    show,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

function configureViewerWindow(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("btv://app/") || url.startsWith("http://127.0.0.1:5173/")) {
      return {
        action: "allow",
        outlivesOpener: true,
        overrideBrowserWindowOptions: viewerWindowOptions({ width: 1280, height: 900, show: true }),
      };
    }
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("did-create-window", (childWindow) => configureViewerWindow(childWindow));
  window.webContents.on("will-navigate", (event, url) => {
    const isLocalRenderer = url.startsWith("btv://app/") || url.startsWith("http://127.0.0.1:5173/");
    if (!isLocalRenderer) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    }
  });
}

function createWindow() {
  const window = new BrowserWindow(viewerWindowOptions());
  configureViewerWindow(window);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  const devArg = process.argv.find((argument) => argument.startsWith("--dev-server-url="));
  const devUrl = devArg?.slice("--dev-server-url=".length);
  const startupUrl = devUrl || "btv://app/index.html";
  const desktopOpenQuery = pendingOpenPaths.length > 0 ? "?btv_desktop_open=1" : "";
  void window.loadURL(`${startupUrl}${desktopOpenQuery}`);
  mainWindow = window;
}

const singleInstanceLockAcquired = automationMode || app.requestSingleInstanceLock();
if (!singleInstanceLockAcquired) {
  app.exit(0);
} else {
  app.on("second-instance", (_event, argv) => {
    if (automationMode) return;
    sendOpenPaths(collectTreePaths(argv));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    sendOpenPaths([filePath]);
  });

  app.whenReady().then(async () => {
    registerAppProtocol();
    ipcMain.handle("btv:grant-file", (_event, filePath) => grantFile(filePath));
    ipcMain.handle("btv:choose-tree-files", (event) => chooseTreeFiles(BrowserWindow.fromWebContents(event.sender) || activeWindow()));
    ipcMain.handle("btv:save-file", async (event, suggestedName, data) => {
      const safeName = typeof suggestedName === "string" && suggestedName.trim()
        ? path.basename(suggestedName.trim())
        : "big-tree-viewer.btvsession";
      const isNewick = [".nwk", ".newick", ".tree", ".tre"].includes(path.extname(safeName).toLowerCase());
      const parent = BrowserWindow.fromWebContents(event.sender) || activeWindow();
      const result = await dialog.showSaveDialog(parent, {
        title: isNewick ? "Save tree as Newick" : "Save Big Tree Viewer session",
        defaultPath: safeName,
        filters: isNewick
          ? [{ name: "Newick tree", extensions: ["nwk", "newick", "tree", "tre"] }]
          : [{ name: "Big Tree Viewer session", extensions: ["btvsession"] }],
      });
      if (result.canceled || !result.filePath) return false;
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
        throw new Error("The session data could not be transferred to the desktop application.");
      }
      const bytes = data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      await fs.writeFile(result.filePath, bytes);
      return true;
    });
    ipcMain.handle("btv:consume-pending-open-paths", () => {
      const paths = [...new Set(pendingOpenPaths)];
      pendingOpenPaths = [];
      return paths;
    });
    if (automationMode) {
      if (commandIndex !== -1 && !process.argv[commandIndex + 1]) throw new Error("--command requires an absolute JSON request file path.");
      await require("./automation.cjs").startAutomation({
        grantFile: filePath => grantFile(filePath, true),
        commandFile: commandIndex !== -1 ? process.argv[commandIndex + 1] : undefined,
        showApplication: async () => {
          installApplicationMenu({ allowNewWindow: false });
          if (process.platform === "darwin") {
            app.setActivationPolicy("regular");
            await app.dock.show();
          }
        },
        hideApplication: () => {
          Menu.setApplicationMenu(null);
          if (process.platform === "darwin") app.setActivationPolicy("accessory");
        },
      });
      return;
    }
    await loadRecentPaths();
    const initialPaths = collectTreePaths(process.argv);
    pendingOpenPaths.push(...initialPaths);
    await rememberRecentPaths(initialPaths);
    installApplicationMenu();
    createWindow();
    configureAutoUpdates();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(error => { process.stderr.write(`${error.message}\n`); app.exit(1); });

  app.on("window-all-closed", () => {
    if (!automationMode && process.platform !== "darwin") app.quit();
  });
}
