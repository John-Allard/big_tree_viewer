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
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
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
