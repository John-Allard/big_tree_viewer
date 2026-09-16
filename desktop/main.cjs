const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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

if (process.env.BTV_USER_DATA_DIR) {
  if (!path.isAbsolute(process.env.BTV_USER_DATA_DIR)) throw new Error("BTV_USER_DATA_DIR must be absolute.");
  app.setPath("userData", process.env.BTV_USER_DATA_DIR);
}
const commandIndex = process.argv.indexOf("--command");
const automationMode = process.argv.includes("--mcp") || commandIndex !== -1;
if (automationMode) {
  const profile = process.env.BTV_AGENT_PROFILE || "default";
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error("BTV_AGENT_PROFILE must contain only letters, digits, hyphens, or underscores.");
  app.setPath("userData", path.join(app.getPath("userData"), "agent-profiles", profile));
}

let mainWindow = null;
let pendingOpenPaths = [];
const grantedFiles = new Map();
let updateCheckIsManual = false;
let updateCheckInProgress = false;
let updateDownloadInProgress = false;

function activeWindow() {
  return BrowserWindow.getFocusedWindow() || mainWindow;
}

function setUpdateProgress(value) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setProgressBar(value);
  }
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
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      updateDownloadInProgress = false;
      setUpdateProgress(-1);
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
  });
  autoUpdater.on("update-downloaded", async (info) => {
    updateDownloadInProgress = false;
    setUpdateProgress(-1);
    const result = await dialog.showMessageBox(activeWindow(), {
      type: "info",
      title: "Update Ready",
      message: `Big Tree Viewer ${info.version} has been downloaded.`,
      detail: "Restart Big Tree Viewer to install the update. Unsaved work will be lost.",
      buttons: ["Restart and Install", "Later"],
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

function sendOpenPaths(paths) {
  const uniquePaths = [...new Set(paths.filter(isSupportedTreePath))];
  if (uniquePaths.length === 0) return;
  const target = automationMode ? BrowserWindow.getFocusedWindow() : mainWindow;
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

async function chooseTreeFiles() {
  const result = await dialog.showOpenDialog(mainWindow, {
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

function installApplicationMenu() {
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
        { label: "Open Tree or Session...", accelerator: "CmdOrCtrl+O", click: () => void chooseTreeFiles() },
        { label: "Save Session...", accelerator: "CmdOrCtrl+S", click: () => sendMenuCommand("save-session") },
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
        { label: "Connect an AI Agent...", click: async () => {
          const args = [...(app.isPackaged ? [] : [path.join(__dirname, "main.cjs")]), "--mcp"];
          const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow() || mainWindow, {
            type: "info", title: "Connect an AI agent", message: "Use Big Tree Viewer from Codex or Claude Code",
            detail: "Copy configuration for your agent, add it to its MCP settings, and restart the agent. The local server can open configured trees and export images using this installed app. No separate browser or Python is required. For Claude Code, merge the copied entry into .mcp.json; for Codex, append it to ~/.codex/config.toml. Use absolute paths for tree inputs and outputs.",
            buttons: ["Copy Codex configuration", "Copy Claude / MCP configuration", "Cancel"], cancelId: 2,
          });
          if (result.response === 0) clipboard.writeText(`[mcp_servers.bigtreeviewer]\ncommand = ${JSON.stringify(process.env.APPIMAGE || process.execPath)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 240\n[mcp_servers.bigtreeviewer.env]\nBTV_AGENT_PROFILE = "codex"\n`);
          if (result.response === 1) clipboard.writeText(JSON.stringify({ mcpServers: { bigtreeviewer: { command: process.env.APPIMAGE || process.execPath, args, env: { BTV_AGENT_PROFILE: "claude" } } } }, null, 2));
        } },
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

if (!app.requestSingleInstanceLock()) {
  if (automationMode) process.stderr.write("This BTV agent profile is already in use. Set BTV_AGENT_PROFILE to a different name for another client.\n");
  app.exit(automationMode ? 1 : 0);
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
    installApplicationMenu();
    ipcMain.handle("btv:grant-file", (_event, filePath) => grantFile(filePath));
    ipcMain.handle("btv:save-file", async (_event, suggestedName, data) => {
      const safeName = typeof suggestedName === "string" && suggestedName.trim()
        ? path.basename(suggestedName.trim())
        : "big-tree-viewer.btvsession";
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "Save Big Tree Viewer session",
        defaultPath: safeName,
        filters: [{ name: "Big Tree Viewer session", extensions: ["btvsession"] }],
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
      await require("./automation.cjs").startAutomation({ grantFile: filePath => grantFile(filePath, true), commandFile: commandIndex !== -1 ? process.argv[commandIndex + 1] : undefined });
      return;
    }
    pendingOpenPaths.push(...collectTreePaths(process.argv));
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
