const { contextBridge, ipcRenderer } = require("electron");

const queuedPaths = [];
const listeners = new Set();
const queuedMenuCommands = [];
const menuCommandListeners = new Set();

ipcRenderer.on("btv:open-paths", (_event, paths) => {
  if (!Array.isArray(paths)) return;
  if (listeners.size === 0) {
    queuedPaths.push(...paths);
    return;
  }
  for (const listener of listeners) listener(paths);
});

ipcRenderer.on("btv:menu-command", (_event, command) => {
  if (typeof command !== "string") return;
  if (menuCommandListeners.size === 0) {
    queuedMenuCommands.push(command);
    return;
  }
  for (const listener of menuCommandListeners) listener(command);
});

const agentListeners = new Set();
const agentQueue = [];
ipcRenderer.on("btv:agent-request", (_event, request) => {
  if (!agentListeners.size) agentQueue.push(request);
  else for (const listener of agentListeners) listener(request);
});

const sharedTaxonomyCache = process.env.BTV_SHARED_USER_DATA_DIR ? {
  readArchive: (source) => ipcRenderer.invoke("btv:taxonomy-cache-read-archive", source),
  writeArchive: (source, data) => ipcRenderer.invoke("btv:taxonomy-cache-write-archive", source, data),
  readValue: (store, key) => ipcRenderer.invoke("btv:taxonomy-cache-read-value", store, key),
  writeValue: (store, key, value) => ipcRenderer.invoke("btv:taxonomy-cache-write-value", store, key, value),
  deleteValue: (store, key) => ipcRenderer.invoke("btv:taxonomy-cache-delete-value", store, key),
} : undefined;

contextBridge.exposeInMainWorld("bigTreeViewerDesktop", {
  async consumePendingOpenPaths() {
    const mainPaths = await ipcRenderer.invoke("btv:consume-pending-open-paths");
    return [...queuedPaths.splice(0, queuedPaths.length), ...mainPaths];
  },
  onOpenPaths(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
  onMenuCommand(callback) {
    menuCommandListeners.add(callback);
    for (const command of queuedMenuCommands.splice(0, queuedMenuCommands.length)) callback(command);
    return () => menuCommandListeners.delete(callback);
  },
  openFiles: () => ipcRenderer.invoke("btv:choose-tree-files"),
  grantFile: (filePath) => ipcRenderer.invoke("btv:grant-file", filePath),
  saveFile: (suggestedName, data) => ipcRenderer.invoke("btv:save-file", suggestedName, data),
  onAgentRequest(callback) {
    agentListeners.add(callback);
    for (const request of agentQueue.splice(0)) callback(request);
    ipcRenderer.send("btv:agent-ready");
    return () => agentListeners.delete(callback);
  },
  agentResult: (result) => ipcRenderer.send("btv:agent-result", result),
  taxonomyCache: sharedTaxonomyCache,
  platform: process.platform,
});
