import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync, strFromU8 } from "fflate";

async function exportedLabels(page: Page) {
  const svg = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No SVG export")), 15000);
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== "big-tree-viewer:exported") return;
      clearTimeout(timer); window.removeEventListener("message", listener); resolve(event.data.text);
    };
    window.addEventListener("message", listener);
    window.postMessage({ type: "big-tree-viewer:export", payload: { format: "svg", delivery: "postMessage" } }, "*");
  }));
  return page.evaluate(svg => [...new DOMParser().parseFromString(svg, "image/svg+xml").querySelectorAll("text")]
    .filter(t => t.textContent?.startsWith("Family"))
    .map(t => ({ name: t.textContent, transform: t.getAttribute("transform") ?? "" })), svg);
}

for (const viewMode of ["circular", "fan"] as const) {
  test(`internal labels support radial orientation in ${viewMode} exports and sessions`, async ({ page }) => {
    await page.goto("/?btv_api=1");
    await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
    await page.evaluate(viewMode => window.postMessage({ type: "big-tree-viewer:load", payload: {
      newick: "((A:1,B:1)FamilyA:2,(C:1,D:1)FamilyB:2);",
      visual: { viewMode, showTipLabels: false, showGenusLabels: false, showInternalNodeLabels: true,
        figureStyles: { internalNode: { polarOrientation: "radial" } } },
    } }, "*"), viewMode);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    const visual = page.locator(".panel-section .section-toggle").filter({ hasText: "Visual Options" });
    if (await visual.getAttribute("aria-expanded") !== "true") await visual.click();
    await page.getByRole("button", { name: "Internal node labels settings", exact: true }).click();
    const orientation = page.getByRole("dialog", { name: "Internal node labels settings", exact: true }).getByRole("combobox", { name: "Orientation", exact: true });
    await expect(orientation).toHaveValue("radial");
    const radial = await exportedLabels(page);
    expect(radial).toHaveLength(2);
    await orientation.selectOption("tangential");
    const tangential = await exportedLabels(page);
    expect(tangential.map(t => t.name)).toEqual(radial.map(t => t.name));
    for (let i = 0; i < radial.length; i++) {
      const angle = (value: string) => Number(value.match(/rotate\(([-\d.]+)/)?.[1] ?? 0);
      expect(Math.abs(angle(radial[i].transform) - angle(tangential[i].transform)) % 180).toBeCloseTo(90, 2);
    }
    await orientation.selectOption("radial");
    await page.getByRole("button", { name: "Close Internal node labels settings", exact: true }).click();
    await page.evaluate(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
    const saving = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save Session", exact: true }).click();
    const download = await saving;
    const session = JSON.parse(strFromU8(gunzipSync(await readFile((await download.path())!))));
    expect(session.settings.figureStyles.internalNode.polarOrientation).toBe("radial");
    expect(session.tree.newick).toContain("FamilyA");
    const subtree = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildSharedSubtreePayloadForTest(1));
    expect(subtree?.visual?.figureStyles?.internalNode.polarOrientation).toBe("radial");
  });
}
