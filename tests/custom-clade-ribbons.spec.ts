import { expect, test, type Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, strFromU8 } from "fflate";
import { buildMetadataCladeRibbons, normalizeCustomCladeRibbons, remapCladeRibbonsForSubtree, remapCladeRibbonsForTree, type CustomCladeRibbon } from "../src/lib/customCladeRibbons";
import { parseTreePayload } from "../src/lib/treeParser";
import { rerootTreePayload } from "../src/lib/rerootTree";
import { serializeSubtreeToNewick } from "../src/components/treeCanvasUtils";
import type { TreeModel } from "../src/types/tree";
import { resolveCladeRibbons } from "../src/lib/cladeRibbons";

const parse = (text: string) => ({ ...parseTreePayload(text).payload, branchLengthMinPositive: 1 }) as TreeModel;
const ribbon = (node: number, id = `r${node}`): CustomCladeRibbon => ({ id, node, label: `Clade ${node}`, color: "#aAbB00", placement: "outside", enabled: true });

const demoNewick = "(((A:1,B:1)AB:1,C:2)ABC:1,(D:2,E:2)DE:1)Root;";
const demoTree = parse(demoNewick);
const demoRibbons: CustomCladeRibbon[] = [
  { ...ribbon(demoTree.names.indexOf("ABC"), "parent"), label: "Northern clade", color: "#d43b6a", placement: "inside" },
  { ...ribbon(demoTree.names.indexOf("AB"), "nested"), label: "Sister pair", color: "#159b83", placement: "inside" },
  { ...ribbon(demoTree.names.indexOf("DE"), "adjacent"), label: "Southern clade", color: "#e3a122", placement: "inside" },
  { ...ribbon(demoTree.names.indexOf("ABC"), "outer"), label: "Study group", color: "#8659ba", placement: "outside" },
];

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function loadRibbonTree(page: Page, ribbons: CustomCladeRibbon[] = demoRibbons) {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(({ newick, ribbons }) => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick, visual: { customCladeRibbons: ribbons, viewMode: "rectangular", order: "input", showGenusLabels: false },
  } }, "*"), { newick: demoNewick, ribbons });
  await expect.poll(() => readRibbons(page)).toEqual(ribbons);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names?.includes("ABC"));
  await settle(page);
}

function readRibbons(page: Page) {
  return page.evaluate(() => (window.__BIG_TREE_VIEWER_APP_TEST__!.getState() as unknown as { customCladeRibbons: CustomCladeRibbon[] }).customCladeRibbons);
}

async function openRibbonControls(page: Page) {
  const metadata = page.locator(".panel-section .section-toggle").filter({ hasText: "Metadata" });
  if (await metadata.getAttribute("aria-expanded") !== "true") await metadata.click();
  const settings = page.getByRole("button", { name: "Subtree ribbons settings", exact: true });
  if (await settings.getAttribute("aria-expanded") !== "true") await settings.click();
}

async function openRibbonMenu(page: Page, id: string) {
  const point = await page.evaluate(id => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getSubtreeRibbonHitboxes().find(hit => hit.id === id)!, id);
  const box = (await page.getByTestId("tree-canvas").boundingBox())!;
  await page.mouse.click(box.x + point.x, box.y + point.y, { button: "right" });
  await expect(page.getByRole("button", { name: "Rename ribbon", exact: true })).toBeVisible();
}

async function exportRibbonSvg(page: Page): Promise<string> {
  await settle(page);
  return page.evaluate(() => new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => { window.removeEventListener("message", listener); reject(new Error("SVG export timed out")); }, 15000);
    const listener = (event: MessageEvent) => {
      if (!["big-tree-viewer:exported", "big-tree-viewer:export-error"].includes(event.data?.type)) return;
      clearTimeout(timeout); window.removeEventListener("message", listener);
      if (event.data.ok) resolve(event.data.text); else reject(new Error(event.data.error));
    };
    window.addEventListener("message", listener);
    window.postMessage({ type: "big-tree-viewer:export", payload: { format: "svg", delivery: "postMessage" } }, "*");
  }));
}

async function svgGeometry(page: Page, svg: string) {
  return page.evaluate(text => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden";
    host.innerHTML = text;
    document.body.append(host);
    try {
      return Array.from(host.querySelectorAll<SVGGraphicsElement>("rect,path,text")).map(element => {
        const box = element.getBBox();
        return { kind: element.tagName, fill: element.getAttribute("fill")?.toLowerCase(), text: element.textContent,
          x: box.x, y: box.y, width: box.width, height: box.height, d: element.getAttribute("d") };
      });
    } finally { host.remove(); }
  }, svg);
}

async function enableDemoTaxonomy(page: Page) {
  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!;
    app.setTaxonomyMapForTest({ version: 1, mappedCount: 5, totalTips: 5, activeRanks: ["genus"],
      tipRanks: internal.leafNodes.map(node => ({ node, ranks: { genus: ["A", "B", "C"].includes(internal.names![node]) ? "Alpha" : "Beta" } })),
    });
    app.setTaxonomyEnabled(true);
    app.setTaxonomyBranchColoringEnabled(false);
    app.setTaxonomyRankVisibilityAutoForTest(false);
    app.setTaxonomyRankDisplayModeForTest("genus", "ribbon");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setTaxonomyRootColor("Alpha", "#446688");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setTaxonomyRootColor("Beta", "#446688");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView();
  });
  await settle(page);
}

test("normalization validates nodes, ids, labels and colors without mutation", () => {
  const valid = ribbon(1);
  const input = [null, {}, { ...valid, id: "" }, { ...valid, id: " bad " },
    { ...valid, node: -1 }, { ...valid, node: 1.5 }, { ...valid, node: 3 },
    { ...valid, color: "red" }, { ...valid, color: "#abc" },
    { ...valid, label: "  A\n B\u0000C  ", enabled: undefined, placement: undefined }, valid];
  const before = structuredClone(input);
  expect(normalizeCustomCladeRibbons(input, 3)).toEqual([{ ...valid, label: "A B C" }]);
  expect(input).toEqual(before);
  expect(normalizeCustomCladeRibbons(null)).toEqual([]);
  expect(normalizeCustomCladeRibbons([ribbon(Number.MAX_SAFE_INTEGER + 1)])).toEqual([]);
  expect(normalizeCustomCladeRibbons([{ ...valid, enabled: false, placement: "inside" }])).toEqual([{ ...valid, enabled: false, placement: "inside" }]);
  expect(normalizeCustomCladeRibbons([valid], 0)).toEqual([]);
  expect(normalizeCustomCladeRibbons([{ ...valid, label: " \n ", color: undefined }])).toEqual([{ ...valid, label: "", color: "#2b8cbe" }]);
});

test("normalization permits long labels and limits accepted items to 200", () => {
  expect(normalizeCustomCladeRibbons([{ ...ribbon(0), label: "x".repeat(400) }])[0].label).toHaveLength(256);
  expect(normalizeCustomCladeRibbons(Array.from({ length: 300 }, (_, i) => ribbon(i)))).toHaveLength(200);
});

test("subtrees match parser preorder, clip ancestors and discard disjoint ribbons", () => {
  const tree = parse("(((A,B)AB,C)ABC,(D,E)DE)Root;");
  const node = tree.names.indexOf("ABC");
  const source = tree.names.map((_, index) => ribbon(index));
  const before = structuredClone(source);
  const result = remapCladeRibbonsForSubtree(tree, node, source);
  const subtree = parse(serializeSubtreeToNewick(tree, node));
  for (const item of result) {
    const old = source.find(r => r.id === item.id)!;
    expect(subtree.names[item.node]).toBe(old.node === tree.root ? "ABC" : tree.names[old.node]);
  }
  expect(result).toHaveLength(6);
  expect(source).toEqual(before);
  expect(remapCladeRibbonsForSubtree(tree, -1, source)).toEqual([]);
  expect(remapCladeRibbonsForSubtree(tree, tree.names.indexOf("A"), source).every(r => r.node === 0)).toBe(true);
});

test("reroot preserves exactly the same descendant tips, not reused node numbers", () => {
  const tree = parse("((A:1,B:1)AB:1,(C:1,D:1)CD:1)Root;");
  const next = { ...rerootTreePayload(tree, tree.names.indexOf("A"), "branch")!, branchLengthMinPositive: 1 };
  const result = remapCladeRibbonsForTree(tree, next, [ribbon(tree.names.indexOf("AB")), ribbon(tree.names.indexOf("CD")), ribbon(tree.root)]);
  expect(result.map(r => r.id)).toEqual([`r${tree.names.indexOf("CD")}`, `r${tree.root}`]);
  expect(next.names[result[0].node]).toBe("CD");
  expect(result[1].node).toBe(next.root);
});

test("tip identity is a case-sensitive multiset, independent of order and internal labels", () => {
  const tree = parse("((A,B)AB,(C,D)CD)Root;");
  const reordered = parse("((D,C)Other,(B,A)Changed)NewRoot;");
  expect(remapCladeRibbonsForTree(tree, reordered, [ribbon(1)])[0].node).toBe(reordered.names.indexOf("Changed"));
  expect(remapCladeRibbonsForTree(tree, parse("((A,b)AB,(C,D)CD)Root;"), [ribbon(1)])).toEqual([]);
  expect(remapCladeRibbonsForTree(tree, parse("((A,C)AB,(B,D)CD)Root;"), [ribbon(1)])).toEqual([]);
});

test("duplicate or unnamed tip identities block only affected clades; unary clades use deepest node", () => {
  const tree = parse("((A,A)AA,(C,D)CD)Root;");
  expect(remapCladeRibbonsForTree(tree, tree, [ribbon(1), ribbon(4), ribbon(0)])).toEqual([ribbon(4)]);
  const unique = parse("((A,B)AB,(C,D)CD)Root;");
  expect(remapCladeRibbonsForTree(unique, tree, [ribbon(1), ribbon(4)])).toEqual([ribbon(4)]);
  const unary = parse("(((A,B)AB)Unary,C)Root;");
  expect(remapCladeRibbonsForTree(unary, unary, [ribbon(1), ribbon(2)])).toEqual([{ ...ribbon(1), node: 2 }, ribbon(2)]);
  const unnamed = parse("(A,B)Root;");
  unnamed.names[1] = "";
  expect(remapCladeRibbonsForTree(unnamed, unnamed, [ribbon(0)])).toEqual([]);
});

test("iterative remapping handles deep trees and caches repeated ribbon clades", () => {
  const tree = parse("(".repeat(10000) + "A,B)" + ",C)".repeat(9999) + ";");
  const result = remapCladeRibbonsForTree(tree, tree, Array.from({ length: 200 }, (_, i) => ribbon(tree.nodeCount - 1, `id${i}`)));
  // Repeated C labels make those individual tip identities ambiguous.
  expect(result).toEqual([]);
  expect(remapCladeRibbonsForSubtree(tree, tree.root, [ribbon(tree.root)])[0].node).toBe(0);
});

test("fingerprints are treewide and repeated safe clades are exact-checked once", () => {
  const tree = parse(`(${Array.from({ length: 5000 }, (_, i) => `Tip${i}`).join(",")})Root;`);
  let reads = 0;
  const names = tree.names;
  tree.names = new Proxy(names, { get(target, key, receiver) {
    if (typeof key === "string" && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  const ribbons = Array.from({ length: 200 }, (_, i) => ribbon(tree.root, `safe${i}`));
  expect(remapCladeRibbonsForTree(tree, tree, ribbons)).toEqual(ribbons);
  expect(reads).toBeLessThan(tree.nodeCount * 8);
});

test("browser: empty ribbon controls wait for a table and follow other metadata displays", async ({ page }, testInfo) => {
  await loadRibbonTree(page, []);
  const metadata = page.locator(".panel-section .section-toggle").filter({ hasText: "Metadata" });
  if (await metadata.getAttribute("aria-expanded") !== "true") await metadata.click();
  const summary = page.getByRole("button", { name: "Subtree ribbons settings", exact: true });
  await expect(summary).toHaveCount(0);
  await page.evaluate(newick => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick, metadata: { text: "name,group\nA,One\nB,One\nC,Two\nD,Two\nE,Two\n", keyColumn: "name" },
  } }, "*"), demoNewick);
  await expect(summary).toHaveCount(1);
  const ordering = await summary.evaluate(el => {
    const table = Array.from(document.querySelectorAll("label")).find(label => label.textContent?.trim() === "Show tip data table");
    return Boolean(table && (table.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(ordering).toBe(true);
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  await expect(page.getByRole("button", { name: "Apply metadata ribbons", exact: true })).toBeVisible();
  await expect(page.locator(".clade-ribbon-item")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("clade-ribbons-with-metadata.png") });
  await page.getByRole("button", { name: "Clear Metadata", exact: true }).click();
  await expect(summary).toHaveCount(0);
});

test("browser: API ribbons load without taxonomy and metadata controls edit them", async ({ page }) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(ribbons => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick: "((A:1,B:1)AB:1,C:2)Root;",
    visual: { viewMode: "rectangular", customCladeRibbons: ribbons },
  } }, "*"), [ribbon(1, "custom")]);
  const read = () => page.evaluate(() => (window.__BIG_TREE_VIEWER_APP_TEST__?.getState() as unknown as { customCladeRibbons: CustomCladeRibbon[] })?.customCladeRibbons);
  await expect.poll(read).toEqual([ribbon(1, "custom")]);
  const metadata = page.locator(".panel-section .section-toggle").filter({ hasText: "Metadata" });
  if (await metadata.getAttribute("aria-expanded") !== "true") await metadata.click();
  await openRibbonMenu(page, "custom");
  await page.getByRole("button", { name: "Rename ribbon", exact: true }).click();
  await page.getByLabel("Subtree ribbon name", { exact: true }).fill("Edited clade");
  await page.getByRole("button", { name: "Ribbon color", exact: true }).click();
  await page.getByLabel("Choose custom ribbon color", { exact: true }).fill("#123456");
  await expect.poll(read).toEqual([{ ...ribbon(1, "custom"), label: "Edited clade", color: "#123456" }]);
  await page.getByRole("button", { name: "Remove ribbon", exact: true }).click();
  await expect.poll(read).toEqual([]);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView());
  const point = await page.evaluate(() => {
    const segment = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getBranchScreenSegmentForTest(1)!;
    return { x: (segment.x1 + segment.x2) / 2, y: (segment.y1 + segment.y2) / 2 };
  });
  const box = (await page.getByTestId("tree-canvas").boundingBox())!;
  await page.mouse.click(box.x + point.x, box.y + point.y, { button: "right" });
  const items = await page.locator(".tree-context-menu button").allTextContents();
  expect(items.indexOf("Add subtree ribbon")).toBe(items.findIndex(text => text.trim() === "Color Subtree Branches") + 1);
  await page.getByRole("button", { name: "Add subtree ribbon", exact: true }).click();
  await expect.poll(async () => (await read())?.length).toBe(1);
  expect((await read())[0]).toMatchObject({ node: 1, enabled: true, color: "#2b8cbe" });
});

test("browser: existing ribbons suppress duplicate actions on ribbons and their node menus", async ({ page }) => {
  const openNode = async (node: number) => {
    await page.keyboard.press("Escape");
    await settle(page);
    const p = await page.evaluate(node => {
      const s = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getBranchScreenSegmentForTest(node)!;
      return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
    }, node);
    const box = (await page.getByTestId("tree-canvas").boundingBox())!;
    await page.mouse.click(box.x + p.x, box.y + p.y, { button: "right" });
    await expect(page.locator(".tree-context-menu")).toBeVisible();
  };
  for (const enabled of [true, false]) {
    await loadRibbonTree(page, [{ ...demoRibbons[3], enabled }]);
    if (enabled) {
      await openRibbonMenu(page, "outer");
      await expect(page.getByRole("button", { name: "Add subtree ribbon", exact: true })).toHaveCount(0);
      await page.mouse.click(600, 700);
    }
    await openNode(demoRibbons[3].node);
    await expect(page.getByRole("button", { name: "Add subtree ribbon", exact: true })).toHaveCount(0);
    await openNode(demoTree.names.indexOf("DE"));
    await expect(page.getByRole("button", { name: "Add subtree ribbon", exact: true })).toBeVisible();
  }
});

test("browser: ribbon menu uses standard row spacing and branch-color swatches", async ({ page }, testInfo) => {
  await loadRibbonTree(page);
  await openRibbonMenu(page, "outer");
  const menu = page.locator(".tree-context-menu");
  const rows = ["Rename ribbon", "Ribbon color", "Remove ribbon"];
  const heights = await Promise.all(rows.map(async name => (await menu.getByRole("button", { name, exact: true }).boundingBox())!.height));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
  await menu.getByRole("button", { name: "Ribbon color", exact: true }).click();
  const ribbonSwatches = await menu.locator(".tree-context-menu-swatch").evaluateAll(buttons => buttons.map(button => button.getAttribute("style")));
  expect(ribbonSwatches.length).toBeGreaterThan(6);
  const swatch = menu.getByRole("button", { name: /^Set ribbon color / }).first();
  await swatch.click();
  const color = (await readRibbons(page)).find(r => r.id === "outer")!.color;
  expect(color).not.toBe(demoRibbons[3].color);
  await expect(swatch).toHaveClass(/active/);
  await expect(menu.getByLabel("Custom ribbon color hex", { exact: true })).toHaveValue(color);
  await page.screenshot({ path: testInfo.outputPath("ribbon-color-menu.png") });
  await menu.getByRole("button", { name: "Color Subtree Branches", exact: true }).click();
  const branchSwatches = await menu.locator(".tree-context-menu-swatch").evaluateAll(buttons => buttons.map(button => button.getAttribute("style")));
  expect(branchSwatches).toEqual(ribbonSwatches);
});

test("browser: tooltip headings use display names and unnamed-node ribbon titles", async ({ page }, testInfo) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(() => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick: "((A:1,B:1):1,(C:1,D:1)NamedGroup:1)Root;",
    metadata: { text: "name,display_name\nA,Alternative species A\n", keyColumn: "name", tipLabelColumn: "display_name" },
    visual: { viewMode: "rectangular", showGenusLabels: false, customCladeRibbons: [
      { id: "unnamed", node: 1, label: "Ribbon title", color: "#229955", placement: "outside", enabled: true },
      { id: "named", node: 4, label: "Other ribbon", color: "#4477bb", placement: "outside", enabled: true },
    ] },
  } }, "*"));
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().tipLabelMetadataColumn === "display_name");
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  const hover = async (node: number) => {
    await settle(page);
    const p = await page.evaluate(node => {
      const segment = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getBranchScreenSegmentForTest(node)!;
      return { x: (segment.x1 + segment.x2) / 2, y: (segment.y1 + segment.y2) / 2 };
    }, node);
    const box = (await page.getByTestId("tree-canvas").boundingBox())!;
    await page.mouse.move(box.x + p.x, box.y + p.y);
    await expect(page.locator(".hover-tooltip")).toBeVisible();
    return page.locator(".hover-tooltip");
  };
  const tip = await hover(2);
  await expect(tip.locator(".hover-tooltip-label")).toHaveText("Alternative species A");
  await expect(tip).toContainText("Original name: A");
  await expect(tip).not.toContainText("Display name:");
  expect((await tip.innerText()).match(/Original name:/g)).toHaveLength(1);
  await expect((await hover(1)).locator(".hover-tooltip-label")).toHaveText("Ribbon title");
  await page.screenshot({ path: testInfo.outputPath("ribbon-title-tooltip.png") });
  await expect((await hover(4)).locator(".hover-tooltip-label")).toHaveText("NamedGroup");
});

test("browser: session roundtrip, unrelated settings import and raw-tree replacement", async ({ page }) => {
  const styled = demoRibbons.map(ribbon => ({ ...ribbon, widthPx: 40, labelSizePx: 18 }));
  await loadRibbonTree(page, styled);
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  const download = await downloading;
  const bytes = await readFile((await download.path())!);
  const session = JSON.parse(strFromU8(gunzipSync(bytes)));
  expect(session.settings.customCladeRibbons).toEqual(styled);
  expect(session.canvas.customCladeRibbons).toBeUndefined();
  expect(session.tree.originalNewick ?? session.tree.newick).toBe(demoNewick);

  await page.evaluate(() => window.postMessage({ type: "big-tree-viewer:load", payload: { newick: "(X:1,Y:1)Replacement;" } }, "*"));
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names?.includes("Replacement"));
  await expect.poll(() => readRibbons(page)).toEqual([]);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load Session", exact: true }).click();
  await (await chooser).setFiles({ name: "ribbon-session.btvsession", mimeType: "application/octet-stream", buffer: bytes });
  await expect.poll(() => readRibbons(page)).toEqual(styled);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names?.includes("ABC"));

  const foreign = { ...session, tree: { ...session.tree, newick: "(OtherA:1,OtherB:1)OtherRoot;", signature: "foreign-tree" },
    settings: { ...session.settings, customCladeRibbons: [{ ...ribbon(0, "foreign"), color: "#ff0000" }] } };
  const settingsChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load Settings", exact: true }).click();
  await (await settingsChooser).setFiles({ name: "foreign.btvsession", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(foreign)) });
  await expect(page.getByText(/Loaded reusable settings from foreign/)).toBeVisible();
  await expect.poll(() => readRibbons(page)).toEqual(styled);
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names)).toContain("ABC");
});

test("browser: shared subtrees remap descendants and clip ancestors without changing source Newick", async ({ page }) => {
  await loadRibbonTree(page);
  const payload = await page.evaluate(node => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildSharedSubtreePayloadForTest(node), demoTree.names.indexOf("AB")) as { newick: string; visual: { customCladeRibbons: CustomCladeRibbon[] } };
  expect(payload.visual.customCladeRibbons).toEqual(demoRibbons.filter(r => r.id !== "adjacent").map(r => ({ ...r, node: 0 })));
  expect(parse(payload.newick).names).toEqual(["AB", "A", "B"]);
  expect(await readRibbons(page)).toEqual(demoRibbons);
  const full = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildSharedSubtreePayloadForTest(0)) as { newick: string };
  expect(full.newick).toBe(demoNewick);
});

test("metadata peers stay aligned when manual ribbons nest inside or outside their level", () => {
  const tree = parse("(((((A:1,B:1)Inner:1,C:2)Country1:1,(D:2,E:2)Country2:1)Umbrella:1,(F:2,G:2)Country3:2)Root:1);");
  const make = (name: string, metadata: boolean) => ({ ...ribbon(tree.names.indexOf(name), metadata ? `metadata-ribbon:tips:${name}` : name), label: name });
  const countries = ["Country1", "Country2", "Country3"].map(name => make(name, true));
  const leaves = tree.names.flatMap((_, node) => tree.buffers.firstChild[node] < 0 ? [node] : []);
  for (const inner of [false, true]) for (const outer of [false, true]) {
    const entries = [...countries, ...(inner ? [make("Inner", false)] : []), ...(outer ? [make("Umbrella", false)] : [])];
    for (const input of [entries, [...entries].reverse()]) {
      const layout = resolveCladeRibbons(input, tree, leaves);
      const lanes = new Map(layout.ranges.map(r => [r.label, r.lane]));
      expect(countries.map(r => lanes.get(r.label))).toEqual([Number(inner), Number(inner), Number(inner)]);
      if (inner) expect(lanes.get("Inner")).toBe(0);
      if (outer) expect(lanes.get("Umbrella")).toBe(Number(inner) + 1);
      expect(layout.outside).toBe(1 + Number(inner) + Number(outer));
    }
  }
  const nested = resolveCladeRibbons([make("Inner", true), ...countries, make("Umbrella", true)], tree, leaves);
  const lanes = new Map(nested.ranges.map(r => [r.label, r.lane]));
  expect(lanes.get("Inner")).toBe(0);
  expect(lanes.get("Country1")).toBe(1);
  expect(lanes.get("Umbrella")).toBe(2);
});

test("browser: metadata peers share one band between manual inner and umbrella ribbons", async ({ page }, testInfo) => {
  const countries = buildMetadataCladeRibbons(demoTree, ["A", "B", "C", "D", "E"].map(name => ({ name, country: "ABC".includes(name) ? "France" : "Canada" })), "name", "country", "tips");
  const inner = { ...demoRibbons[1], placement: "outside" as const };
  const outer = { ...demoRibbons[3], node: demoTree.root };
  await loadRibbonTree(page, [...countries, inner, outer]);
  for (const mode of ["rectangular", "circular"] as const) {
    await page.evaluate(mode => window.__BIG_TREE_VIEWER_APP_TEST__!.setViewMode(mode), mode);
    await settle(page);
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    const shapes = await svgGeometry(page, await exportRibbonSvg(page));
    const position = (color: string) => {
      const shape = shapes.find(s => s.kind === (mode === "rectangular" ? "rect" : "path") && s.fill === color)!;
      expect(shape).toBeTruthy();
      return mode === "rectangular" ? shape.x : Number(shape.d?.match(/[Aa]\s*([\d.e+-]+)/)?.[1]);
    };
    expect(position(countries[0].color)).toBeCloseTo(position(countries[1].color), 6);
    expect(position(inner.color)).toBeLessThan(position(countries[0].color));
    expect(position(outer.color)).toBeGreaterThan(position(countries[0].color));
    await page.screenshot({ path: testInfo.outputPath(`metadata-levels-${mode}.png`) });
  }
});

test("nested ribbons put ancestors outside descendants regardless of input order or clipping", () => {
  const tree = parse("((((A:1,B:1)Small:1,C:2)Medium:1,D:3)Large:1,(E:1,F:1)Other:1)Root;");
  const entries = ["Large", "Medium", "Small", "Other"].map(label => ({ ...ribbon(tree.names.indexOf(label), label), label }));
  const leaves = tree.names.flatMap((_, node) => tree.buffers.firstChild[node] < 0 ? [node] : []);
  for (const placement of ["inside", "outside"] as const) {
    for (const input of [entries, [...entries].reverse()]) {
      for (const visible of [leaves, leaves.slice(0, 2)]) {
        const layout = resolveCladeRibbons(input.map(r => ({ ...r, placement })), tree, visible);
        const lanes = new Map(layout.ranges.map(r => [r.label, r.lane]));
        expect(lanes.get("Large")!).toBeGreaterThan(lanes.get("Medium")!);
        expect(lanes.get("Medium")!).toBeGreaterThan(lanes.get("Small")!);
        expect(layout[placement]).toBe(3);
      }
    }
  }
});

test("browser: SVG bands obey enabled flags and ordering without changing descendant identities", async ({ page }) => {
  await loadRibbonTree(page);
  await openRibbonControls(page);
  for (const order of ["input", "asc", "desc"] as const) {
    await page.evaluate(order => { window.__BIG_TREE_VIEWER_APP_TEST__!.setOrder(order); window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView(); }, order);
    const geometry = await svgGeometry(page, await exportRibbonSvg(page));
    const broad = geometry.find(shape => shape.kind === "rect" && shape.fill === demoRibbons[0].color)!;
    const narrow = geometry.find(shape => shape.kind === "rect" && shape.fill === demoRibbons[1].color)!;
    expect(broad.x).toBeGreaterThan(narrow.x);
    for (const item of demoRibbons) {
      const bands = geometry.filter(shape => shape.kind === "rect" && shape.fill === item.color);
      expect(bands, `${order}: ${item.id} band`).toHaveLength(1);
      const band = bands[0];
      const expectedTips = item.id === "nested" ? ["A", "B"] : item.id === "adjacent" ? ["D", "E"] : ["A", "B", "C"];
      for (const tip of ["A", "B", "C", "D", "E"]) {
        const label = geometry.find(shape => shape.kind === "text" && shape.text === tip);
        expect(label, `${order}: ${tip} label`).toBeTruthy();
        const center = label!.y + label!.height / 2;
        expect(center >= band.y && center <= band.y + band.height, `${item.id} covers ${tip} in ${order}`).toBe(expectedTips.includes(tip));
      }
    }
    expect(await readRibbons(page)).toEqual(demoRibbons);
  }
  await loadRibbonTree(page, demoRibbons.map(ribbon => ribbon.id === "nested" ? { ...ribbon, enabled: false } : ribbon));
  const disabledSvg = await exportRibbonSvg(page);
  expect(disabledSvg.toLowerCase()).not.toContain(demoRibbons[1].color);
  expect(disabledSvg.toLowerCase()).toContain(demoRibbons[0].color);
  await loadRibbonTree(page);
  expect((await exportRibbonSvg(page)).toLowerCase()).toContain(demoRibbons[1].color);
  const payload = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildSharedSubtreePayloadForTest(0)) as { newick: string };
  expect(payload.newick).toBe(demoNewick);
});

test("metadata ribbons match unique internal names or maximal homogeneous tip clades", () => {
  const rows = [{ name: "'A_B'", group: "Sister group" }, { name: "DE", group: "Other group" }];
  // Underscores and spaces follow the existing metadata matching rules.
  const named = parse("((A:1,B:1)'A B':1,(D:1,E:1)DE:1)Root;");
  expect(buildMetadataCladeRibbons(named, rows, "name", "group", "nodes").map(r => [r.node, r.label, r.placement]))
    .toEqual([[1, "Sister group", "outside"], [4, "Other group", "outside"]]);
  expect(() => buildMetadataCladeRibbons(named, [...rows, { name: "DE", group: "Conflict" }], "name", "group", "nodes")).toThrow(/Conflicting/);
  const repeated = parse("((A:1,B:1)X:1,(D:1,E:1)X:1)Root;");
  expect(() => buildMetadataCladeRibbons(repeated, [{ name: "X", group: "G" }], "name", "group", "nodes")).toThrow(/not unique/);
  const tips = [{ name: "A", group: "One" }, { name: "B", group: "One" }, { name: "D", group: "One" }, { name: "E", group: "One" }];
  const result = buildMetadataCladeRibbons(demoTree, tips, "name", "group", "tips");
  expect(result.map(r => demoTree.names[r.node]).sort()).toEqual(["AB", "DE"]);
  expect(new Set(result.map(r => r.color)).size).toBe(1);
  expect(buildMetadataCladeRibbons(demoTree, tips.slice(1), "name", "group", "tips").map(r => demoTree.names[r.node])).toEqual(["DE"]);
});

test("ribbon layout reads visible tips once, even with a hundred ribbons", () => {
  const tree = parse(`(${Array.from({ length: 1000 }, (_, i) => `T${i}:1`).join(",")})Root;`);
  let reads = 0;
  const leaves = new Proxy(Array.from(tree.leafNodes), { get(target, key, receiver) {
    if (typeof key === "string" && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  const layout = resolveCladeRibbons(Array.from({ length: 100 }, (_, i) => ribbon(tree.root, `r${i}`)), tree, leaves);
  expect(layout.ranges).toHaveLength(100);
  expect(layout.outside).toBe(100);
  expect(reads).toBeLessThanOrEqual(leaves.length * 2);
});

test("ribbon style sizes are bounded and survive shared subtree serialization", () => {
  const styles = normalizeCustomCladeRibbons([{ ...ribbon(1), widthPx: 999, labelSizePx: -5 }]);
  expect(styles[0]).toMatchObject({ widthPx: 120, labelSizePx: 5 });
  expect(remapCladeRibbonsForSubtree(demoTree, 1, styles)[0]).toMatchObject({ node: 0, widthPx: 120, labelSizePx: 5 });
});

test("radial subtree ribbons clear metadata tip names with taxonomy visible or hidden", async ({ page }, testInfo) => {
  const ribbons = [
    { ...ribbon(demoTree.names.indexOf("ABC"), "first"), color: "#445566" },
    { ...ribbon(demoTree.names.indexOf("DE"), "second"), color: "#773311" },
  ];
  const names = ["Pseudomonas aeruginosa isolate Alpha", "Escherichia coli isolate Beta", "Salmonella enterica isolate Gamma", "Bacillus subtilis isolate Delta", "Pseudomonas aeruginosa isolate Epsilon"];
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(({ newick, ribbons, csv }) => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick, metadata: { text: csv, keyColumn: "name", tipLabelColumn: "display_name" },
    visual: { viewMode: "circular", showTipLabels: true, showGenusLabels: false, taxonomyEnabled: false,
      customCladeRibbons: ribbons, figureStyles: { tip: { sizeScale: 1.5, offsetPx: 24 } } },
  } }, "*"), { newick: demoNewick, ribbons, csv: "name,display_name\n" + names.map((name, i) => `${"ABCDE"[i]},${name}`).join("\n") });
  await expect.poll(() => readRibbons(page)).toHaveLength(2);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().tipLabelMetadataColumn === "display_name");
  const geometry = () => page.evaluate(names => {
    const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
    const svg = api.buildCurrentSvgForTest()!;
    const camera = api.getCamera()!;
    if (camera.kind !== "circular") throw new Error("Expected radial camera");
    const host = document.createElement("div"); host.style.cssText = "position:fixed;left:-10000px;visibility:hidden";
    host.innerHTML = svg; document.body.append(host);
    try {
      const paths = Array.from(host.querySelectorAll("path")).filter(path => ["#445566", "#773311"].includes(path.getAttribute("fill") ?? ""));
      const inner = Math.min(...paths.flatMap(path => Array.from((path.getAttribute("d") ?? "").matchAll(/A ([\d.]+)/g), match => Number(match[1]))));
      const labels = Array.from(host.querySelectorAll<SVGTextElement>("text")).filter(text => names.includes(text.textContent ?? ""));
      const outer = Math.max(...labels.flatMap(text => {
        const box = text.getBBox();
        const transform = text.transform.baseVal.consolidate()?.matrix ?? new DOMMatrix();
        return [box.x, box.x + box.width].flatMap(x => [box.y, box.y + box.height].map(y => {
          const p = new DOMPoint(x, y).matrixTransform(transform);
          return Math.hypot(p.x - camera.translateX, p.y - camera.translateY);
        }));
      }));
      return { inner, outer, labels: labels.length };
    } finally { host.remove(); }
  }, names);
  for (const span of [360, 306, 180]) {
    await page.evaluate(span => window.__BIG_TREE_VIEWER_APP_TEST__!.setRadialAngularSpanDegreesForTest(span), span);
    await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView());
    for (const zoom of [1, 1.4, 0.8]) {
      await page.evaluate(zoom => {
        const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!; const camera = api.getCamera()!;
        if (camera.kind === "circular") api.setCircularCamera({ scale: camera.scale * zoom });
      }, zoom);
      const result = await geometry();
      expect(result.labels).toBe(5);
      expect(result.inner, `${span} degrees, zoom ${zoom}`).toBeGreaterThan(result.outer + 3);
    }
  }
  await enableDemoTaxonomy(page);
  expect((await geometry()).inner).toBeGreaterThan((await geometry()).outer + 3);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setTaxonomyEnabled(false));
  await settle(page);
  expect((await geometry()).inner).toBeGreaterThan((await geometry()).outer + 3);
  await page.screenshot({ path: testInfo.outputPath("radial-metadata-label-clearance.png") });
});

test("browser: spiral ribbons open the same subtree context menu", async ({ page }, testInfo) => {
  const branch = (start: number, count: number): string => count === 1 ? `T${start}:1`
    : `(${branch(start, count / 2)},${branch(start + count / 2, count / 2)}):1`;
  const newick = `${branch(0, 1024)};`;
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(({ newick, ribbon }) => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick, visual: { viewMode: "spiral", customCladeRibbons: [ribbon], showGenusLabels: false },
  } }, "*"), { newick, ribbon: { ...ribbon(1, "spiral"), label: "Spiral subtree" } });
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getSubtreeRibbonHitboxes().length === 1);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView());
  await settle(page);
  await openRibbonMenu(page, "spiral");
  await expect(page.getByRole("button", { name: "Zoom To Subtree", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("spiral-ribbon-context-menu.png") });
});

test("browser: metadata imports, shared styles and radial ribbon context menus", async ({ page }, testInfo) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(newick => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick, metadata: { text: "name,group\nA,One\nB,One\nC,Other\nD,Two\nE,Two\n", keyColumn: "name" },
    visual: { viewMode: "rectangular", showGenusLabels: false },
  } }, "*"), demoNewick);
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataFileName)).toBeTruthy();
  await openRibbonControls(page);
  await page.getByLabel("Metadata ribbon matching", { exact: true }).selectOption("tips");
  await page.getByLabel("Ribbon label column", { exact: true }).selectOption("group");
  await page.getByRole("button", { name: "Apply metadata ribbons", exact: true }).click();
  await expect.poll(async () => (await readRibbons(page)).length).toBe(2);
  await page.getByLabel("Ribbon thickness", { exact: true }).fill("40");
  await page.getByLabel("Ribbon label size", { exact: true }).fill("18");
  expect((await readRibbons(page)).every(r => r.widthPx === 40 && r.labelSizePx === 18 && r.placement === "outside")).toBe(true);
  await page.getByRole("button", { name: "Close Subtree ribbons settings", exact: true }).click();
  await page.evaluate(() => { window.__BIG_TREE_VIEWER_APP_TEST__!.setViewMode("circular"); });
  await settle(page);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView());
  await settle(page);
  const id = (await readRibbons(page))[0].id;
  await openRibbonMenu(page, id);
  await expect(page.getByRole("button", { name: "Zoom To Subtree", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename ribbon", exact: true }).click();
  await page.getByLabel("Subtree ribbon name").fill("Renamed group");
  await page.getByLabel("Subtree ribbon name").press("Enter");
  expect((await readRibbons(page))[0].label).toBe("Renamed group");
  await page.screenshot({ path: testInfo.outputPath("radial-subtree-ribbons.png") });
});

test("browser: subtree labels fit their bands, scale with thickness and match taxonomy direction", async ({ page }, testInfo) => {
  await loadRibbonTree(page, [{ ...demoRibbons[3], widthPx: 12 }]);
  await enableDemoTaxonomy(page);
  const readLabels = async () => {
    await settle(page);
    return page.evaluate(() => {
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:-10000px;visibility:hidden";
      host.innerHTML = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()!;
      document.body.append(host);
      try {
        return Array.from(host.querySelectorAll<SVGTextElement>("text"))
          .filter(el => ["Study group", "Alpha"].includes(el.textContent ?? ""))
          .map(el => { const m = el.transform.baseVal.consolidate()!.matrix;
            return { text: el.textContent, size: Number(el.getAttribute("font-size")), angle: Math.atan2(m.b, m.a), height: el.getBBox().height };
          });
      } finally { host.remove(); }
    });
  };
  const small = (await readLabels()).find(label => label.text === "Study group")!;
  expect(small).toBeTruthy();
  await openRibbonControls(page);
  await page.getByLabel("Ribbon thickness", { exact: true }).fill("41");
  await expect.poll(async () => (await readRibbons(page))[0].widthPx).toBe(41);
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  const large = await readLabels();
  const subtree = large.find(label => label.text === "Study group")!;
  const taxonomy = large.find(label => label.text === "Alpha")!;
  expect(subtree.size).toBeGreaterThan(24);
  expect(subtree.size).toBeGreaterThan(small.size * 1.5);
  expect(subtree.height).toBeLessThan(41);
  expect(subtree.angle).toBeCloseTo(Math.PI / 2, 6);
  expect(subtree.angle).toBeCloseTo(taxonomy.angle, 6);
  await page.screenshot({ path: testInfo.outputPath("subtree-labels-rectangular.png") });
  await openRibbonControls(page);
  await page.getByLabel("Ribbon label size", { exact: true }).fill("6");
  await expect.poll(async () => (await readRibbons(page))[0].labelSizePx).toBe(6);
  const reduced = (await readLabels()).find(label => label.text === "Study group")!;
  expect(reduced.size).toBeCloseTo(subtree.size / 2, 4);
});

test("browser: taxonomy placement geometry and illustrative rectangular/radial screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loadRibbonTree(page);
  await enableDemoTaxonomy(page);
  const directory = path.resolve("tmp/custom-clade-ribbons");
  await mkdir(directory, { recursive: true });
  for (const view of ["rectangular", "circular"] as const) {
    await page.evaluate(view => { window.__BIG_TREE_VIEWER_APP_TEST__!.setViewMode(view); window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView(); }, view);
    const svg = await exportRibbonSvg(page);
    const geometry = await svgGeometry(page, svg);
    const kind = view === "rectangular" ? "rect" : "path";
    const taxonomy = geometry.filter(shape => shape.kind === kind && shape.fill === "#446688");
    expect(taxonomy.length, `${view} taxonomy bands`).toBeGreaterThan(0);
    const inside = geometry.find(shape => shape.kind === kind && shape.fill === demoRibbons[0].color)!;
    const outside = geometry.find(shape => shape.kind === kind && shape.fill === demoRibbons[3].color)!;
    expect(inside).toBeTruthy(); expect(outside).toBeTruthy();
    if (view === "rectangular") {
      expect(inside.x + inside.width).toBeLessThanOrEqual(Math.min(...taxonomy.map(shape => shape.x)));
      expect(outside.x).toBeGreaterThanOrEqual(Math.max(...taxonomy.map(shape => shape.x + shape.width)));
    } else {
      // Circular ribbon paths begin with M followed by the outer-radius point,
      // then A radius radius; compare actual radii, not state or paint order.
      const radius = (d: string | null) => Number(d?.match(/[Aa]\s*([\d.e+-]+)/)?.[1]);
      const taxonomyRadii = taxonomy.map(shape => radius(shape.d));
      const nested = geometry.find(shape => shape.kind === kind && shape.fill === demoRibbons[1].color)!;
      expect(radius(inside.d), "umbrella ribbon lies outside its nested ribbon").toBeGreaterThan(radius(nested.d));
      expect(radius(inside.d)).toBeGreaterThan(0);
      expect(radius(inside.d)).toBeLessThan(Math.min(...taxonomyRadii));
      expect(radius(outside.d)).toBeGreaterThan(Math.max(...taxonomyRadii));
    }
    await page.screenshot({ path: path.join(directory, `${view}.png`), fullPage: true });
    if (view === "circular") {
      const pixels = await page.getByTestId("tree-canvas").evaluate(element => {
        const canvas = element as HTMLCanvasElement;
        const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        const points: Record<string, Array<[number, number]>> = { "446688": [], "d43b6a": [], "8659ba": [] };
        for (let y = 0; y < canvas.height; y += 2) for (let x = 0; x < canvas.width; x += 2) {
          const offset = (y * canvas.width + x) * 4;
          const color = [data[offset], data[offset + 1], data[offset + 2]].map(value => value.toString(16).padStart(2, "0")).join("");
          points[color]?.push([x, y]);
        }
        const taxonomy = points["446688"];
        const xs = taxonomy.map(point => point[0]), ys = taxonomy.map(point => point[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        return Object.fromEntries(Object.entries(points).map(([color, points]) => {
          const radii = points.map(([x, y]) => Math.hypot(x - cx, y - cy));
          return [color, { count: points.length, min: Math.min(...radii), max: Math.max(...radii) }];
        }));
      });
      expect(pixels["446688"].count).toBeGreaterThan(100);
      expect(pixels["d43b6a"].count).toBeGreaterThan(100);
      expect(pixels["8659ba"].count).toBeGreaterThan(20);
      expect(pixels["d43b6a"].max, "canvas inside ribbon must be inside taxonomy").toBeLessThan(pixels["446688"].min);
      expect(pixels["8659ba"].min, "canvas outside ribbon must be outside taxonomy, as in SVG").toBeGreaterThan(pixels["446688"].max);
    }
  }
});

test("browser: ribbon controls fit a 390px mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadRibbonTree(page);
  await openRibbonControls(page);
  await page.getByLabel("Ribbon thickness", { exact: true }).fill("40");
  const sizes = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth,
    controls: Array.from(document.querySelectorAll(".clade-ribbon-controls input,.clade-ribbon-controls select,.clade-ribbon-controls button")).map(el => {
      const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right };
    }) }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width);
  for (const control of sizes.controls) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(390);
  }
});
