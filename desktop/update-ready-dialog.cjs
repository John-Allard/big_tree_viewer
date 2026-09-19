// Never parent the install confirmation to the transient download window.
// macOS dismisses a sheet when its parent closes, which can make the prompt
// flash for a frame and silently resolve before the user can choose.
async function showUpdateReadyDialog({ dialog, mainWindow, closeProgressWindow, version }) {
  await closeProgressWindow();
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const options = {
    type: "info",
    title: "Update Ready",
    message: `Big Tree Viewer ${version} has been downloaded.`,
    detail: "Relaunch Big Tree Viewer to install the update. Unsaved work will be lost.",
    buttons: ["Relaunch Big Tree Viewer and Install", "Later"],
    defaultId: 1,
    cancelId: 1,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}

module.exports = { showUpdateReadyDialog };
