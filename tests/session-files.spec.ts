import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync, strFromU8 } from "fflate";

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__
    && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded,
  ));
}

async function loadTreeFromPaste(page: Page, newick: string): Promise<void> {
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(newick);
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && !Boolean(state?.loading);
  });
}

test("session file saves and reloads tree data, metadata, settings, and canvas state", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
  await loadTreeFromPaste(page, "((A_species:1,B_species:1)CladeOne:1,C_species:2)Root;");

  await page.evaluate(async () => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const firstLeaf = internal?.leafNodes?.[0];
    if (!app || !canvas || typeof firstLeaf !== "number") {
      throw new Error("Test controls unavailable.");
    }
    app.importMetadataTextForTest("name,group\nA_species,Alpha\nB_species,Beta\n", "groups.csv");
    app.setViewMode("circular");
    app.setShowTipLabels(false);
    app.setShowGenusLabels(true);
    canvas.setManualBranchColor(firstLeaf, "#ff0000");
  });
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const camera = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera();
    return state?.viewMode === "circular" && camera?.kind === "circular";
  });
  await page.evaluate(async () => {
    const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    if (!canvas) {
      throw new Error("Canvas test controls unavailable.");
    }
    const camera = canvas.getCamera();
    if (!camera || camera.kind !== "circular") {
      throw new Error("Circular camera unavailable.");
    }
    canvas.setCircularCamera({
      scale: Number(camera.scale) * 1.4,
      translateX: Number(camera.translateX) - 25,
      translateY: Number(camera.translateY) + 15,
    });
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session" }).click();
  const download = await downloadPromise;
  const savedPath = await download.path();
  expect(savedPath).toBeTruthy();

  const savedBytes = await readFile(savedPath as string);
  expect(savedBytes[0]).toBe(0x1f);
  expect(savedBytes[1]).toBe(0x8b);
  const session = JSON.parse(strFromU8(gunzipSync(savedBytes)));
  expect(session.format).toBe("big-tree-viewer-session");
  expect(session.version).toBe(1);
  expect(session.tree?.newick).toContain("A_species");
  expect(session.metadata?.text).toContain("A_species,Alpha");
  expect(session.settings?.viewMode).toBe("circular");
  expect(session.settings?.showTipLabels).toBe(false);
  expect(session.canvas?.camera?.kind).toBe("circular");
  expect(Number(session.canvas?.viewportWidth ?? 0)).toBeGreaterThan(0);
  expect(Number(session.canvas?.viewportHeight ?? 0)).toBeGreaterThan(0);
  expect(session.canvas?.manualBranchColors?.length).toBe(1);

  await page.goto("/");
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__ && window.__BIG_TREE_VIEWER_CANVAS_TEST__));
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load Session" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(savedPath as string);

  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && !Boolean(state?.loading) && state?.metadataRowCount === 2;
  });
  await page.waitForFunction(() => {
    const colors = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors() ?? [];
    return colors.includes("#ff0000");
  });

  const restored = await page.evaluate(() => ({
    app: window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null,
    camera: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCamera() ?? null,
    branchColors: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors() ?? null,
  }));
  expect(restored.app?.viewMode).toBe("circular");
  expect(restored.app?.showTipLabels).toBe(false);
  expect(restored.app?.metadataRowCount).toBe(2);
  expect(restored.camera?.kind).toBe("circular");
  expect(restored.branchColors).toContain("#ff0000");
});
