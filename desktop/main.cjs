const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } = require("electron");
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

let mainWindow = null;
let pendingOpenPaths = [];
const grantedFiles = new Map();

function isSupportedTreePath(filePath) {
  return typeof filePath === "string" && TREE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function collectTreePaths(argv) {
  return argv.filter(isSupportedTreePath).map((filePath) => path.resolve(filePath));
}

function sendOpenPaths(paths) {
  const uniquePaths = [...new Set(paths.filter(isSupportedTreePath))];
  if (uniquePaths.length === 0) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingOpenPaths.push(...uniquePaths);
    return;
  }
  mainWindow.webContents.send("btv:open-paths", uniquePaths);
  mainWindow.show();
  mainWindow.focus();
}

function sendMenuCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("btv:menu-command", command);
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
        { role: "about" }, { type: "separator" }, { role: "services" }, { type: "separator" },
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

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#fbfcfe",
    show: false,
    icon: path.resolve(__dirname, "..", "public", "icon-512.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("btv://app/") || url.startsWith("http://127.0.0.1:5173/")) {
      return { action: "allow" };
    }
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const isLocalRenderer = url.startsWith("btv://app/") || url.startsWith("http://127.0.0.1:5173/");
    if (!isLocalRenderer) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    }
  });
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
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
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

  app.whenReady().then(() => {
    registerAppProtocol();
    installApplicationMenu();
    ipcMain.handle("btv:grant-file", async (_event, filePath) => {
      if (!isSupportedTreePath(filePath)) throw new Error("Unsupported tree file type.");
      const resolvedPath = path.resolve(filePath);
      const fileInfo = await fs.stat(resolvedPath);
      if (!fileInfo.isFile()) throw new Error("The selected tree path is not a file.");
      const token = crypto.randomUUID();
      grantedFiles.set(token, resolvedPath);
      return {
        name: path.basename(resolvedPath),
        url: `btv-file://open/${token}/${encodeURIComponent(path.basename(resolvedPath))}`,
      };
    });
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
    pendingOpenPaths.push(...collectTreePaths(process.argv));
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
