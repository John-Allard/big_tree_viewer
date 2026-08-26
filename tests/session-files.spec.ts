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

test("bundled example loads its embedded taxonomy mapping without downloading taxonomy data", async ({ page }) => {
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));

  await waitForViewer(page);
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount ?? 0) > 0;
  });

  const result = await page.evaluate(() => ({
    tipCount: window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes.length ?? 0,
    taxonomy: window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest?.() ?? null,
  }));
  expect(result.tipCount).toBe(50033);
  expect(result.taxonomy?.version).toBe(8);
  expect(result.taxonomy?.mappedCount).toBe(50033);
  expect(result.taxonomy?.totalTips).toBe(50033);
  expect(requestedUrls.some((url) => url.endsWith("/example_tree.btvsession"))).toBe(true);
  expect(requestedUrls.some((url) => url.endsWith("/example_tree.nwk"))).toBe(false);
  expect(requestedUrls.some((url) => url.includes("taxdmp.zip") || url.includes("ncbi.nlm.nih.gov"))).toBe(false);
});

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
    app.setMetadataTipTableEnabled(true);
    app.setMetadataTipTableMode("categorical");
    app.setMetadataTipTableCellStyle("text");
    app.setMetadataTipTableColumns([{ column: "group", label: "Study group" }]);
    app.setFigureStyleForTest("bootstrap", "decimalPlaces", 1);
    app.setFigureStyleForTest("nodeHeight", "decimalPlaces", 3);
    app.setFigureStyleForTest("bootstrap", "polarOrientation", "radial");
    app.setFigureStyleForTest("nodeHeight", "polarOrientation", "tangential");
    app.setViewMode("circular");
    app.setShowTipLabels(false);
    app.setAlignTipLabels(true);
    app.setShowGenusLabels(true);
    app.setMockTaxonomy();
    canvas.setManualBranchColor(firstLeaf, "#ff0000");
    canvas.setTaxonomyRootColor("A-phy", "#00aa44");
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
  expect(session.settings?.alignTipLabels).toBe(true);
  expect(session.settings?.metadataTipTableEnabled).toBe(true);
  expect(session.settings?.metadataTipTableMode).toBe("categorical");
  expect(session.settings?.metadataTipTableCellStyle).toBe("text");
  expect(session.settings?.metadataTipTableColumns).toEqual([{ column: "group", label: "Study group" }]);
  expect(session.settings?.figureStyles?.bootstrap?.decimalPlaces).toBe(1);
  expect(session.settings?.figureStyles?.nodeHeight?.decimalPlaces).toBe(3);
  expect(session.settings?.figureStyles?.bootstrap?.polarOrientation).toBe("radial");
  expect(session.settings?.figureStyles?.nodeHeight?.polarOrientation).toBe("tangential");
  expect(session.canvas?.camera?.kind).toBe("circular");
  expect(Number(session.canvas?.viewportWidth ?? 0)).toBeGreaterThan(0);
  expect(Number(session.canvas?.viewportHeight ?? 0)).toBeGreaterThan(0);
  expect(session.canvas?.manualBranchColors?.length).toBe(1);
  expect(session.canvas?.taxonomyRootColors).toEqual([["A-phy", "#00aa44"]]);

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
    taxonomyRootColors: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getTaxonomyRootColors() ?? [],
  }));
  expect(restored.app?.viewMode).toBe("circular");
  expect(restored.app?.showTipLabels).toBe(false);
  expect(restored.app?.alignTipLabels).toBe(true);
  expect(restored.app?.metadataTipTableEnabled).toBe(true);
  expect(restored.app?.metadataTipTableMode).toBe("categorical");
  expect(restored.app?.metadataTipTableCellStyle).toBe("text");
  expect(restored.app?.figureStyles?.bootstrap?.decimalPlaces).toBe(1);
  expect(restored.app?.figureStyles?.nodeHeight?.decimalPlaces).toBe(3);
  expect(restored.app?.figureStyles?.bootstrap?.polarOrientation).toBe("radial");
  expect(restored.app?.figureStyles?.nodeHeight?.polarOrientation).toBe("tangential");
  expect(restored.app?.metadataTipTableColumns).toEqual([{ column: "group", label: "Study group" }]);
  expect(restored.app?.metadataRowCount).toBe(2);
  expect(restored.camera?.kind).toBe("circular");
  expect(restored.branchColors).toContain("#ff0000");
  expect(restored.taxonomyRootColors).toEqual([["A-phy", "#00aa44"]]);
});

test("session save opens native picker before async session preparation", async ({ page }) => {
  await waitForViewer(page);
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __saveSessionEvents?: Array<{ type: string; status?: string; size?: number }>;
    };
    testWindow.__saveSessionEvents = [];
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async () => {
        testWindow.__saveSessionEvents?.push({
          type: "picker",
          status: document.querySelector(".status-line")?.textContent ?? "",
        });
        return {
          createWritable: async () => ({
            write: async (blob: Blob) => {
              testWindow.__saveSessionEvents?.push({ type: "write", size: blob.size });
            },
            close: async () => {
              testWindow.__saveSessionEvents?.push({ type: "close" });
            },
          }),
        };
      },
    });
  });

  await page.getByRole("button", { name: "Save Session" }).click();
  await expect(page.getByText("Session saved.")).toBeVisible();
  const events = await page.evaluate(() => (
    (window as typeof window & {
      __saveSessionEvents?: Array<{ type: string; status?: string; size?: number }>;
    }).__saveSessionEvents ?? []
  ));

  expect(events[0]).toMatchObject({ type: "picker", status: "" });
  expect(events.some((event) => event.type === "write" && Number(event.size) > 0)).toBe(true);
  expect(events.at(-1)?.type).toBe("close");
});
