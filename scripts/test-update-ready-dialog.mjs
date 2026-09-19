import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { showUpdateReadyDialog } = require("../desktop/update-ready-dialog.cjs");

async function check(response, expectedConfirmation) {
  let closeProgress;
  let shown = false;
  const progressClosed = new Promise(resolve => { closeProgress = resolve; });
  const mainWindow = { isDestroyed: () => false };
  let choose;
  const choice = new Promise(resolve => { choose = resolve; });
  const prompt = showUpdateReadyDialog({
    dialog: {
      showMessageBox: async (parent, options) => {
        assert.equal(parent, mainWindow, "The prompt must be parented to the persistent main window.");
        assert.equal(options.defaultId, 1, "Install must require an explicit click.");
        assert.equal(options.cancelId, 1);
        shown = true;
        return choice;
      },
    },
    mainWindow,
    closeProgressWindow: () => progressClosed,
    version: "0.1.16",
  });
  await Promise.resolve();
  assert.equal(shown, false, "Do not show the prompt while its previous window is closing.");
  closeProgress();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shown, true);
  let settled = false;
  void prompt.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "The prompt must remain open until the user chooses.");
  choose({ response });
  assert.equal(await prompt, expectedConfirmation);
}

await check(1, false);
await check(0, true);
console.log("Update-ready dialog waits for the download window to close and remains pending for an explicit choice.");
