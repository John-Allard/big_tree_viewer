const { contextBridge, ipcRenderer } = require("electron");

const queuedPaths = [];
const listeners = new Set();

ipcRenderer.on("btv:open-paths", (_event, paths) => {
  if (!Array.isArray(paths)) return;
  if (listeners.size === 0) {
    queuedPaths.push(...paths);
    return;
  }
  for (const listener of listeners) listener(paths);
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
  grantFile: (filePath) => ipcRenderer.invoke("btv:grant-file", filePath),
  platform: process.platform,
});
