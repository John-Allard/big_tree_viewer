import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const executablePath = process.argv[2];
if (!executablePath) {
  throw new Error("Usage: npm run test:desktop:smoke -- <desktop-executable>");
}

const fixturePath = path.resolve("tests/fixtures/agent-skill-tree.nwk");
const profileDir = await mkdtemp(path.join(os.tmpdir(), "btv-desktop-smoke-"));
const desktopEnv = { ...process.env, ELECTRON_DISABLE_SANDBOX: "1", BTV_USER_DATA_DIR: profileDir };
const emptyApp = await electron.launch({
  executablePath: path.resolve(executablePath),
  env: desktopEnv,
});

try {
  const emptyPage = await emptyApp.firstWindow();
  const hasWindowIcon = await emptyApp.evaluate(({ app, nativeImage }) => {
    const icon = nativeImage.createFromPath(`${app.getAppPath()}/dist/icon-512.png`);
    return !icon.isEmpty();
  });
  if (!hasWindowIcon) {
    throw new Error("The desktop application window is missing its packaged icon.");
  }
  await emptyPage.getByText("Drag a tree file here to load", { exact: true }).waitFor({ timeout: 15_000 });
  if (await emptyPage.getByRole("button", { name: "Load Example", exact: true }).count() !== 0) {
    throw new Error("The desktop application exposed the web-only bundled example control.");
  }
  if (await emptyPage.locator(".panel-title-description").count() !== 0) {
    throw new Error("The desktop application exposed the web-only descriptive header text.");
  }
  if (await emptyPage.getByText("John B. Allard", { exact: true }).count() !== 0) {
    throw new Error("The desktop application exposed the web-only author line.");
  }
  if (await emptyPage.getByRole("link", { name: "Learn more", exact: true }).count() !== 0) {
    throw new Error("The desktop application exposed a duplicate Learn More link in the side panel.");
  }
  const hasLearnMoreHelpItem = await emptyApp.evaluate(({ Menu }) => {
    const applicationMenu = Menu.getApplicationMenu();
    const helpMenu = applicationMenu?.items.find((item) => item.role === "help" || item.label === "Help");
    return Boolean(helpMenu?.submenu?.items.some((item) => item.label === "Learn More"));
  });
  if (!hasLearnMoreHelpItem) {
    throw new Error("The desktop application is missing Learn More from its Help menu.");
  }
  const taxonomyStorageCapabilities = await emptyPage.evaluate(() => ({
    indexedDb: typeof indexedDB !== "undefined",
    openPicker: typeof window.showOpenFilePicker === "function",
    savePicker: typeof window.showSaveFilePicker === "function",
  }));
  if (!taxonomyStorageCapabilities.indexedDb || !taxonomyStorageCapabilities.openPicker || !taxonomyStorageCapabilities.savePicker) {
    throw new Error(`The desktop taxonomy file/cache APIs are unavailable: ${JSON.stringify(taxonomyStorageCapabilities)}`);
  }
} finally {
  await emptyApp.close();
}

const app = await electron.launch({
  executablePath: path.resolve(executablePath),
  args: [fixturePath],
  env: desktopEnv,
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")]
      .find((element) => element.textContent?.trim() === "Download Newick");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 15_000 });
  if (!await page.getByRole("button", { name: "Spiral", exact: true }).isDisabled()) {
    throw new Error("The loaded fixture did not produce the expected 16-tip tree state.");
  }
  const subtreeKey = `big-tree-viewer:subtree:desktop-smoke-${Date.now()}`;
  await page.evaluate((key) => {
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes ?? [];
    const parent = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.parent;
    const node = parent && typeof leafNodes[0] === "number" ? parent[leafNodes[0]] : -1;
    const payload = node >= 0
      ? window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildSharedSubtreePayloadForTest(node)
      : null;
    if (!payload) throw new Error("Desktop subtree payload was unavailable.");
    window.localStorage.setItem(key, JSON.stringify(payload));
  }, subtreeKey);
  const childWindowPromise = app.waitForEvent("window");
  await page.evaluate((key) => {
    const url = new URL(window.location.href);
    url.searchParams.set("subtree", key);
    window.open(url.toString(), "_blank", "noopener");
  }, subtreeKey);
  const childPage = await childWindowPromise;
  try {
    await childPage.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true, undefined, { timeout: 15_000 });
  } catch {
    const details = await childPage.evaluate(() => ({
      url: window.location.href,
      state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null,
      text: document.body.innerText.slice(0, 500),
    }));
    throw new Error(`Desktop subtree window did not load: ${JSON.stringify(details)}`);
  }
  if (!await childPage.evaluate(() => Boolean(window.bigTreeViewerDesktop))) {
    throw new Error("A desktop subtree window was opened without the desktop preload bridge.");
  }
} finally {
  await app.close();
  await rm(profileDir, { recursive: true, force: true });
}
