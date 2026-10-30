import { expect, test, type Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, strFromU8 } from "fflate";
import { normalizeCustomCladeRibbons, remapCladeRibbonsForSubtree, remapCladeRibbonsForTree, type CustomCladeRibbon } from "../src/lib/customCladeRibbons";
import { parseTreePayload } from "../src/lib/treeParser";
import { rerootTreePayload } from "../src/lib/rerootTree";
import { serializeSubtreeToNewick } from "../src/components/treeCanvasUtils";
import type { TreeModel } from "../src/types/tree";

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
  const details = page.locator("details").filter({ has: page.locator("summary", { hasText: "Clade ribbons" }) });
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
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
  const summary = page.locator(".clade-ribbon-controls > summary");
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
  expect(await summary.evaluate(el => getComputedStyle(el).listStyleType)).toBe("none");
  expect((await summary.locator("svg").boundingBox())!.width).toBe(12);
  await summary.click();
  await expect(page.getByText("No clade ribbons.", { exact: true })).toBeVisible();
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
  const details = page.locator("details").filter({ has: page.locator("summary", { hasText: "Clade ribbons" }) });
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
  await page.getByLabel("Ribbon label custom", { exact: true }).fill("Edited clade");
  await page.getByLabel("Ribbon color custom", { exact: true }).fill("#123456");
  await page.getByLabel("Ribbon placement custom", { exact: true }).selectOption("inside");
  await page.getByLabel("Show ribbon custom", { exact: true }).uncheck();
  await expect.poll(read).toEqual([{ ...ribbon(1, "custom"), label: "Edited clade", color: "#123456", placement: "inside", enabled: false }]);
  await page.getByLabel("Remove ribbon custom", { exact: true }).click();
  await expect.poll(read).toEqual([]);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView());
  const point = await page.evaluate(() => {
    const segment = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getBranchScreenSegmentForTest(1)!;
    return { x: (segment.x1 + segment.x2) / 2, y: (segment.y1 + segment.y2) / 2 };
  });
  const box = (await page.getByTestId("tree-canvas").boundingBox())!;
  await page.mouse.click(box.x + point.x, box.y + point.y, { button: "right" });
  await page.getByRole("button", { name: "Add Clade Ribbon", exact: true }).click();
  await expect.poll(async () => (await read())?.length).toBe(1);
  expect((await read())[0]).toMatchObject({ node: 1, enabled: true, color: "#2b8cbe" });
});

test("browser: session roundtrip, unrelated settings import and raw-tree replacement", async ({ page }) => {
  await loadRibbonTree(page);
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
  });
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  const download = await downloading;
  const bytes = await readFile((await download.path())!);
  const session = JSON.parse(strFromU8(gunzipSync(bytes)));
  expect(session.settings.customCladeRibbons).toEqual(demoRibbons);
  expect(session.canvas.customCladeRibbons).toBeUndefined();
  expect(session.tree.originalNewick ?? session.tree.newick).toBe(demoNewick);

  await page.evaluate(() => window.postMessage({ type: "big-tree-viewer:load", payload: { newick: "(X:1,Y:1)Replacement;" } }, "*"));
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names?.includes("Replacement"));
  await expect.poll(() => readRibbons(page)).toEqual([]);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load Session", exact: true }).click();
  await (await chooser).setFiles({ name: "ribbon-session.btvsession", mimeType: "application/octet-stream", buffer: bytes });
  await expect.poll(() => readRibbons(page)).toEqual(demoRibbons);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names?.includes("ABC"));

  const foreign = { ...session, tree: { ...session.tree, newick: "(OtherA:1,OtherB:1)OtherRoot;", signature: "foreign-tree" },
    settings: { ...session.settings, customCladeRibbons: [{ ...ribbon(0, "foreign"), color: "#ff0000" }] } };
  const settingsChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load Settings", exact: true }).click();
  await (await settingsChooser).setFiles({ name: "foreign.btvsession", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(foreign)) });
  await expect(page.getByText(/Loaded reusable settings from foreign/)).toBeVisible();
  await expect.poll(() => readRibbons(page)).toEqual(demoRibbons);
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

test("browser: SVG bands obey enabled flags and ordering without changing descendant identities", async ({ page }) => {
  await loadRibbonTree(page);
  await openRibbonControls(page);
  for (const order of ["input", "asc", "desc"] as const) {
    await page.evaluate(order => { window.__BIG_TREE_VIEWER_APP_TEST__!.setOrder(order); window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView(); }, order);
    const geometry = await svgGeometry(page, await exportRibbonSvg(page));
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
  await page.getByLabel("Show ribbon nested", { exact: true }).uncheck();
  const disabledSvg = await exportRibbonSvg(page);
  expect(disabledSvg.toLowerCase()).not.toContain(demoRibbons[1].color);
  expect(disabledSvg.toLowerCase()).toContain(demoRibbons[0].color);
  await page.getByLabel("Show ribbon nested", { exact: true }).check();
  expect((await exportRibbonSvg(page)).toLowerCase()).toContain(demoRibbons[1].color);
  const payload = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildSharedSubtreePayloadForTest(0)) as { newick: string };
  expect(payload.newick).toBe(demoNewick);
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
  await page.getByLabel("Ribbon label parent", { exact: true }).fill("A deliberately long ribbon label that must remain contained on mobile");
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
