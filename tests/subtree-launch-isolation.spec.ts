import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const demo = {
  newick: "(Escherichia_coli:1,Salmonella_enterica:1,Pseudomonas_aeruginosa:1)OldDemo;",
  metadata: { text: "name,country\nEscherichia_coli,UK\nSalmonella_enterica,US\nPseudomonas_aeruginosa,FR\n",
    keyColumn: "name", valueColumn: "country", enabled: true, colorMode: "categorical" },
  visual: { viewMode: "rectangular", metadataLegendEnabled: true, showGenusLabels: false },
};
const encodedDemo = Buffer.from(JSON.stringify(demo)).toString("base64url");
const newick = "((Musca_domestica:1,Drosophila_melanogaster:1)Diptera:1,(Homo_sapiens:1,Mus_musculus:1)Mammalia:1)Eukaryota;";

async function ready(page: Page, root: string) {
  await page.waitForFunction(root => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names.includes(root)
    && !window.__BIG_TREE_VIEWER_APP_TEST__?.getState().loading, root);
}

test("dropped replacement session opens the selected taxon, not the URL's old metadata demo", async ({ page, context }) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(newick => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick, visual: { viewMode: "rectangular", order: "input", showGenusLabels: false, metadataLegendEnabled: false },
  } }, "*"), newick);
  await ready(page, "Eukaryota");
  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
    app.setTaxonomyMapForTest({ version: 1, mappedCount: 4, totalTips: 4, activeRanks: ["order"],
      tipRanks: window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.leafNodes.map((node, index) => ({
        node, ranks: { order: index < 2 ? "Diptera" : "Mammalia" },
      })),
    });
    app.setTaxonomyEnabled(true);
    app.setTaxonomyRankVisibilityForTest("order", true);
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
  });
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount)).toBe(4);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  const session = await readFile((await (await downloading).path())!);

  await page.goto(`/?btv_payload=${encodedDemo}#`);
  await ready(page, "OldDemo");
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataColoredNodeCount)).toBe(3);
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataLegendEnabled)).toBe(true);
  await page.evaluate(bytes => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(bytes)], "eukaryota.btvsession", { type: "application/octet-stream" }));
    document.querySelector(".viewer-panel")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, [...session]);
  await ready(page, "Eukaryota");
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount)).toBe(4);
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataRowCount)).toBe(0);
  expect(new URL(page.url()).searchParams.has("btv_payload")).toBe(true);
  await page.evaluate(() => history.replaceState(history.state, "", `${location.pathname}${location.search}#old-launch-anchor`));
  const urls: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes().some(hit => hit.labelKind === "taxonomy" && hit.text === "Diptera"));
    const point = await page.evaluate(() => {
      const hit = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getLabelHitboxes().find(hit => hit.labelKind === "taxonomy" && hit.text === "Diptera")!;
      const rect = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect();
      return { x: rect.left + Number(hit.x), y: rect.top + Number(hit.y) };
    });
    await page.mouse.click(point.x, point.y, { button: "right" });
    const opening = context.waitForEvent("page");
    await page.getByRole("button", { name: "Open Group Subtree In New Tab", exact: true }).click();
    const child = await opening;
    await ready(child, "Diptera");
    const url = new URL(child.url());
    expect([...url.searchParams.keys()]).toEqual(["subtree"]);
    expect(url.hash).toBe("");
    urls.push(url.searchParams.get("subtree")!);
    expect(await child.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names)).toEqual(["Diptera", "Musca_domestica", "Drosophila_melanogaster"]);
    expect(await child.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataRowCount)).toBe(0);
    expect(await child.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataLegendEnabled)).toBe(false);
    await child.close();
  }
  expect(new Set(urls).size).toBe(2);
});

for (const source of ["payload", "newick", "session", "api", "staged", "window"] as const) {
  test(`existing subtree links take priority over stale ${source} launch options`, async ({ page }) => {
    await page.goto("/?btv_api=1");
    const key = `big-tree-viewer:subtree:priority-${source}`;
    await page.evaluate(key => localStorage.setItem(key, "(Musca_domestica:1,Drosophila_melanogaster:1)Diptera;"), key);
    const params = new URLSearchParams({ subtree: key });
    if (source === "payload") params.set("btv_payload", encodedDemo);
    if (source === "newick") params.set("btv_newick", demo.newick);
    if (source === "session") params.set("btv_session_url", "/must-not-load-session.btvsession");
    if (source === "api") params.set("btv_api", "1");
    if (source === "staged") params.set("btv_staged_launch", "expired-key");
    if (source === "window") params.set("btv_window_launch", "1");
    await page.goto(`/?${params}`);
    await ready(page, "Diptera");
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names)).not.toContain("OldDemo");
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataRowCount)).toBe(0);
  });
}

test("a missing explicit subtree reports an error instead of silently loading an unrelated launch", async ({ page }) => {
  await page.goto(`/?subtree=missing-subtree&btv_payload=${encodedDemo}`);
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().loadError));
  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState());
  expect(state.treeLoaded).toBe(false);
  expect(state.loadError).toContain("subtree payload");
});
