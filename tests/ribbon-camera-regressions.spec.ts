import { expect, test, type Page } from "@playwright/test";

const newick = "((((A:1,B:1):1,(C:1,D:1):1)Group1:1,((E:1,F:1):1,(G:1,H:1):1)Group2:1):1,(((I:1,J:1):1,(K:1,L:1):1)Group3:1,((M:1,N:1):1,(O:1,P:1):1)Group4:1):1)Root;";
const displayNames = Array.from({ length: 16 }, (_, i) => `${i < 8 ? "Pseudomonas aeruginosa" : "Salmonella enterica"} isolate ${"ABCDEFGHIJKLMNOP"[i]}`);

async function load(page: Page) {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(({ newick, names }) => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick, metadata: { text: "name,display_name\n" + names.map((name, i) => `${"ABCDEFGHIJKLMNOP"[i]},${name}`).join("\n"), keyColumn: "name", tipLabelColumn: "display_name" },
    visual: { viewMode: "circular", showGenusLabels: false, showScaleBars: false,
      customCladeRibbons: [2, 9, 17, 24].map((node, i) => ({ id: `r${i}`, node, label: `Group ${i}`, color: "#229955", enabled: true, placement: "outside", widthPx: 41 })) },
  } }, "*"), { newick, names: displayNames });
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().tipLabelMetadataColumn === "display_name");
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
}

async function camera(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera()!);
}

test("radial parameters retain magnification and pan instead of fitting", async ({ page }) => {
  await load(page);
  for (const zoom of [0.7, 2]) {
    await page.evaluate(zoom => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!; api.fitView(); const c = api.getCamera()!;
      if (c.kind === "circular") api.setCircularCamera({ scale: c.scale * zoom, translateX: c.translateX + 20, translateY: c.translateY + 15 });
    }, zoom);
    const before = await camera(page);
    await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setRadialAngularSpanDegreesForTest(306));
    const after = await camera(page);
    expect(after).toMatchObject({ kind: "circular", translateX: before.translateX, translateY: before.translateY });
    if (before.kind !== "circular" || after.kind !== "circular") throw new Error("Expected polar cameras");
    expect(after.scale).toBeCloseTo(before.scale, 8);
    await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setRadialCenterOpeningRatioForTest(0.65));
    const annular = await camera(page);
    if (annular.kind !== "circular") throw new Error("Expected annular camera");
    expect(annular.translateX).toBeCloseTo(after.translateX, 6);
    expect(annular.translateY).toBeCloseTo(after.translateY, 6);
    expect(annular.scale / 0.35).toBeCloseTo(after.scale, 6);
    await page.evaluate(() => { window.__BIG_TREE_VIEWER_APP_TEST__!.setRadialAngularSpanDegreesForTest(360); window.__BIG_TREE_VIEWER_APP_TEST__!.setRadialCenterOpeningRatioForTest(0); });
  }
});

test("Fit View includes long tip labels and ribbons in full, partial and annular radial trees", async ({ page }, testInfo) => {
  await load(page);
  for (const [span, opening] of [[360, 0], [306, 0], [180, 0], [306, 0.65], [360, 0.85]]) {
    await page.evaluate(([span, opening]) => {
      window.__BIG_TREE_VIEWER_APP_TEST__!.setRadialAngularSpanDegreesForTest(span);
      window.__BIG_TREE_VIEWER_APP_TEST__!.setRadialCenterOpeningRatioForTest(opening);
    }, [span, opening]);
    await camera(page);
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    const bounds = await page.evaluate(names => {
      const svg = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()!;
      const host = document.createElement("div"); host.style.cssText = "position:fixed;left:-10000px;visibility:hidden";
      host.innerHTML = svg; document.body.append(host);
      try {
        const root = host.querySelector("svg")!;
        const vb = root.viewBox.baseVal;
        const elements = Array.from(host.querySelectorAll<SVGGraphicsElement>('path[fill="#229955"],text')).filter(el => el.tagName === "path" || names.includes(el.textContent ?? ""));
        return { viewport: { x: vb.x, y: vb.y, width: vb.width, height: vb.height }, labels: elements.filter(el => el.tagName === "text").length,
          points: elements.flatMap(el => { const b = el.getBBox(); const m = el.transform.baseVal.consolidate()?.matrix ?? new DOMMatrix();
            return [b.x, b.x + b.width].flatMap(x => [b.y, b.y + b.height].map(y => { const p = new DOMPoint(x, y).matrixTransform(m); return { x: p.x, y: p.y }; })); }) };
      } finally { host.remove(); }
    }, displayNames);
    expect(bounds.labels).toBe(16);
    for (const p of bounds.points) {
      expect(p.x, `${span}/${opening} left`).toBeGreaterThanOrEqual(bounds.viewport.x);
      expect(p.x, `${span}/${opening} right`).toBeLessThanOrEqual(bounds.viewport.x + bounds.viewport.width);
      expect(p.y, `${span}/${opening} top`).toBeGreaterThanOrEqual(0);
      expect(p.y, `${span}/${opening} bottom`).toBeLessThanOrEqual(bounds.viewport.height);
    }
    await page.screenshot({ path: testInfo.outputPath(`fit-${span}-${opening}.png`) });
  }
});

test("switching radial overviews to rectangular preserves framing and cannot pan behind the sidebar", async ({ page }) => {
  await load(page);
  for (const opening of [0, 0.85]) {
    await page.evaluate(opening => { const app = window.__BIG_TREE_VIEWER_APP_TEST__!; app.setViewMode("circular"); app.setRadialCenterOpeningRatioForTest(opening); }, opening);
    await camera(page);
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setViewMode("rectangular"));
    const converted = await camera(page);
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    const fitted = await camera(page);
    expect(converted).toEqual(fitted);
    await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setViewMode("circular"));
    await camera(page);
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const c = api.getCamera()!;
      api.setCircularCamera({ translateX: c.translateX + 18, translateY: c.translateY - 12 });
    });
    await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setViewMode("rectangular"));
    const panned = await camera(page);
    expect(panned.translateX).toBeCloseTo(fitted.translateX + 18, 6);
    expect(panned.translateY).toBeCloseTo(fitted.translateY - 12, 6);
    if (panned.kind !== "rect" || fitted.kind !== "rect") throw new Error("Expected rectangular cameras");
    expect(panned.scaleX).toBeCloseTo(fitted.scaleX, 6);
    expect(panned.scaleY).toBeCloseTo(fitted.scaleY, 6);
  }
  await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setRectCamera({ translateX: -1e6, translateY: 200 }));
  const state = await page.evaluate(() => ({ c: window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera()!,
    inset: window.__BIG_TREE_VIEWER_APP_TEST__!.getState().viewerLeftOcclusionPx ?? 0 }));
  if (state.c.kind !== "rect") throw new Error("Expected rectangular camera");
  expect(state.c.translateX + 4 * state.c.scaleX).toBeGreaterThan(state.inset + 8);
});
