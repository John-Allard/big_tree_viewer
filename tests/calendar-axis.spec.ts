import { expect, test, type Page } from "@playwright/test";
import { calendarBands, calendarBoundaries, decimalCalendarYear, formatCalendarYear, inferCalendarRootYear } from "../src/lib/calendarAxis";
import { parseTreePayload } from "../src/lib/treeParser";
import type { TreeModel } from "../src/types/tree";
import { readFile } from "node:fs/promises";
import { gunzipSync, strFromU8 } from "fflate";

const tree = parseTreePayload("((A:1,B:2):1,C:4)Root;").payload as TreeModel;
const dates = (entries: Record<string, string>) => tree.names.map(name => entries[name] ?? null);

async function loadCalendarTree(page: Page, newick: string, timeStripeStyle = "bands") {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(({ newick, timeStripeStyle }) => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick,
    visual: { viewMode: "rectangular", order: "input", showGenusLabels: false, showTimeStripes: true,
      timeStripeStyle, scaleTickInterval: 10, figureStyles: { scale: { calendarAxis: true, calendarRootYear: 1967.912 } } },
  } }, "*"), { newick, timeStripeStyle });
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
}

async function exportSvg(page: Page) {
  return page.evaluate(() => new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("No SVG export")), 15000);
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== "big-tree-viewer:exported" && event.data?.type !== "big-tree-viewer:export-error") return;
      window.clearTimeout(timeout); window.removeEventListener("message", listener);
      if (event.data.ok) resolve(event.data.text); else reject(new Error(event.data.error));
    };
    window.addEventListener("message", listener);
    window.postMessage({ type: "big-tree-viewer:export", payload: { format: "svg", delivery: "postMessage" } }, "*");
  }));
}

test("calendar bands include partial edges and share the tick grid", () => {
  const bands = calendarBands(1967.912, 51, 10);
  expect(bands).toHaveLength(6);
  expect(bands[0]).toEqual({ startDepth: 0, endDepth: 1970 - 1967.912, calendarIndex: 196 });
  expect(bands.at(-1)?.endDepth).toBe(51);
  expect(bands.slice(1).map(band => band.startDepth)).toEqual(
    calendarBoundaries(1967.912, 51, [{ step: 10, alpha: 1 }]).map(tick => tick.value),
  );
  expect(calendarBands(2000, 20, 10)).toEqual([
    { startDepth: 0, endDepth: 10, calendarIndex: 200 },
    { startDepth: 10, endDepth: 20, calendarIndex: 201 },
  ]);
  expect(calendarBands(2000, 20, 0)).toEqual([]);
  expect(calendarBands(NaN, 20, 1)).toEqual([]);
  expect(calendarBands(2000, 20, 0.00001)).toEqual([]);
});

test("rerooting clears the old calendar origin", async ({ page }) => {
  await loadCalendarTree(page, "((A:1,B:2)Internal:1,C:4)Root;");
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().figureStyles.scale.calendarAxis)).toBe(true);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.rerootOnNodeForTest(1, "child"));
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeSignature?.includes(":reroot:"));
  const scale = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().figureStyles.scale);
  expect(scale?.calendarAxis).toBe(false);
  expect(scale?.calendarRootYear).toBeUndefined();
});

test("collapsed subtree exports anchor to the source MRCA rather than its extended display tip", async ({ page }) => {
  await loadCalendarTree(page, "((A:10,B:10)GroupA:2,(C:10,D:10)GroupB:2)Root;");
  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
    app.setTaxonomyMapForTest({ version: 1, mappedCount: 4, totalTips: 4, activeRanks: ["genus"],
      tipRanks: window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.leafNodes.map((node, index) => ({
        node, ranks: { genus: index < 2 ? "Alpha" : "Beta" },
      })),
    });
    app.setTaxonomyEnabled(true);
    app.setTaxonomyCollapseRankForTest("genus");
  });
  await expect.poll(() => page.evaluate(() =>
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildSharedSubtreePayloadForTest(1)?.visual.taxonomyCollapseRank,
  )).toBe("genus");
  const subtree = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildSharedSubtreePayloadForTest(1));
  expect(subtree?.visual.figureStyles.scale.calendarRootYear).toBeCloseTo(1967.912 + 2, 6);
  expect(subtree?.newick).toContain("A");
  expect(subtree?.newick).toContain("B");
});

for (const ultrametric of [false, true]) {
  for (const style of ["bands", "age-gradient"]) {
    test(`${style} calendar bands align with dashed calendar boundaries (ultrametric=${ultrametric})`, async ({ page }) => {
      await loadCalendarTree(page, ultrametric ? "((A:30,B:30):21,C:51)Root;" : "((A:29,B:30):21,C:48)Root;", style);
      const bandEdges = await page.evaluate(svg => {
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        return [...doc.querySelectorAll("rect")].filter(rect => /rgba\((243,244,246|255,255,255|31,41,55),/.test((rect.getAttribute("fill") ?? "").replaceAll(" ", "")))
          .flatMap(rect => [Number(rect.getAttribute("x")), Number(rect.getAttribute("x")) + Number(rect.getAttribute("width"))]);
      }, await exportSvg(page));
      expect(bandEdges.length).toBeGreaterThan(2);
      await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.setTimeStripeStyle("dashed"));
      const ticks = await page.evaluate(({ svg, style }) => {
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        // Gradients use only the major grid; alternating bands also include minor levels.
        return [...doc.querySelectorAll("line")].filter(line => line.getAttribute("stroke") === "#94a3b8"
          && line.hasAttribute("stroke-dasharray") && (style !== "age-gradient" || Number(line.getAttribute("opacity")) > 0.71))
          .map(line => Number(line.getAttribute("x1")));
      }, { svg: await exportSvg(page), style });
      expect(ticks.length).toBeGreaterThan(0);
      for (const x of ticks) expect(Math.min(...bandEdges.map(edge => Math.abs(edge - x)))).toBeLessThan(0.05);
    });
  }
}

test("sampling dates anchor a serially sampled tree without changing branch lengths", () => {
  const lengths = [...tree.buffers.branchLength];
  const fit = inferCalendarRootYear(tree, dates({ A: "2000-01-01", B: "2001-01-01", C: "2002-01-01" }));
  expect(fit.matchedTips).toBe(3);
  expect(fit.rootYear).toBeCloseTo(1998, 2);
  expect([...tree.buffers.branchLength]).toEqual(lengths);
  expect(tree.isUltrametric).toBe(false);
});

test("calendar anchoring rejects inconsistent distances, missing dates and imprecise origins", () => {
  expect(inferCalendarRootYear(tree, dates({ A: "1980-01-01", B: "2000-01-01" })).rootYear).toBeNull();
  expect(inferCalendarRootYear(tree, dates({ A: "2000-01-01" })).matchedTips).toBe(1);
  expect(inferCalendarRootYear(tree, dates({ A: "2000", B: "2001", C: "2002" })).message).toContain("imprecise");
  expect(inferCalendarRootYear(tree, dates({ A: "2000-02-30", B: "unknown" })).matchedTips).toBe(0);
});

test("calendar ticks align to real years for forward and age-based coordinates", () => {
  const root = 1967.912;
  const forward = calendarBoundaries(root, 51, [{ step: 10, alpha: 1 }]);
  expect(forward.map(tick => formatCalendarYear(root + tick.value))).toEqual(["1970", "1980", "1990", "2000", "2010"]);
  const reverse = calendarBoundaries(root, 51, [{ step: 10, alpha: 1 }], true);
  expect(reverse.map(tick => formatCalendarYear(root + 51 - tick.value))).toEqual(["2010", "2000", "1990", "1980", "1970"]);
  expect(calendarBoundaries(root, 51, [{ step: Infinity, alpha: 1 }])).toEqual([]);
});

test("decimal dates preserve leap-year boundaries and never label invalid dates", () => {
  expect(decimalCalendarYear(Date.UTC(2024, 0, 1))).toBe(2024);
  expect(decimalCalendarYear(Date.UTC(2024, 6, 2))).toBe(2024.5);
  expect(formatCalendarYear(2024.5)).toBe("2024-07-02");
  expect(formatCalendarYear(NaN)).toBe("");
});

test("CSV dates anchor calendar labels in PNG/SVG workflows and saved sessions", async ({ page }, testInfo) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(() => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick: "((A:1,B:2):1,C:4)Root;",
    metadata: { text: "name,date\nA,2000-01-01\nB,2001-01-01\nC,2002-01-01\n", keyColumn: "name", enabled: true, valueColumn: "date", colorMode: "date" },
    visual: { viewMode: "rectangular", showMyaTimeUnit: false, showGenusLabels: false, showTimeStripes: true },
  } }, "*"));
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataColoredNodeCount === 3);
  const visual = page.locator(".panel-section .section-toggle").filter({ hasText: "Visual Options" });
  if (await visual.getAttribute("aria-expanded") !== "true") await visual.click();
  await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
  const calendarToggle = page.getByLabel("Use Calendar Year Axis", { exact: true });
  await expect(calendarToggle).toBeEnabled();
  await expect(calendarToggle).not.toBeChecked();
  await expect(page.getByLabel("Root calendar year", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Anchor calendar axis from CSV dates", exact: true })).toHaveCount(0);
  await calendarToggle.check();
  const rootYear = page.getByLabel("Root calendar year", { exact: true });
  await rootYear.fill("1998");
  await calendarToggle.uncheck();
  await expect(rootYear).toHaveCount(0);
  await calendarToggle.check();
  await expect(rootYear).toHaveValue("1998");
  await page.getByRole("button", { name: "Anchor calendar axis from CSV dates", exact: true }).click();
  await expect(calendarToggle).toBeChecked();
  const svg = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("No SVG export")), 15000);
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== "big-tree-viewer:exported" && event.data?.type !== "big-tree-viewer:export-error") return;
      window.clearTimeout(timeout); window.removeEventListener("message", listener);
      if (event.data.ok) resolve(event.data.text); else reject(new Error(event.data.error));
    };
    window.addEventListener("message", listener);
    window.postMessage({ type: "big-tree-viewer:export", payload: { format: "svg", delivery: "postMessage" } }, "*");
  }));
  expect(svg).toMatch(/>2000<\/text>/);
  expect(svg).not.toContain("mya");
  await page.getByRole("button", { name: "Close Scale labels settings", exact: true }).click();
  await page.evaluate(() => Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }));
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  const download = await downloading;
  const session = JSON.parse(strFromU8(gunzipSync(await readFile((await download.path())!))));
  expect(session.settings.figureStyles.scale).toMatchObject({ calendarAxis: true });
  expect(session.settings.figureStyles.scale.calendarRootYear).toBeCloseTo(1998, 2);
  expect(session.tree.newick).toContain("B:2");
  const subtree = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildSharedSubtreePayloadForTest(1));
  expect(subtree?.visual.figureStyles.scale.calendarRootYear).toBeCloseTo(session.settings.figureStyles.scale.calendarRootYear + 1, 6);
  await page.screenshot({ path: testInfo.outputPath("calendar-axis.png") });
});
