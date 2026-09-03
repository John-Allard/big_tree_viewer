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
  grantFile: (filePath) => ipcRenderer.invoke("btv:grant-file", filePath),
  saveFile: (suggestedName, data) => ipcRenderer.invoke("btv:save-file", suggestedName, data),
  platform: process.platform,
});
