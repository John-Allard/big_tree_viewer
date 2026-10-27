import { expect, test, type Page } from "@playwright/test";
import { parseTreePayload } from "../src/lib/treeParser";

const groups = Array.from({ length: 4 }, (_, group) => `(${Array.from({ length: 64 }, (_, tip) =>
  `Genus${group}_species${tip}_long_sequence_identifier:1`).join(",")})Group${group}:1`);
const newick = `(${groups.join(",")})Root;`;
const parsed = parseTreePayload(newick).payload;

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const viewMode of ["rectangular", "circular", "fan"] as const) {
  test(`zero ribbon gap closes during guide-tick-only zoom in ${viewMode}`, async ({ page }, testInfo) => {
    await page.goto("/?btv_api=1");
    await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
    await page.evaluate(payload => window.postMessage({ type: "big-tree-viewer:load", payload }, "*"), {
      newick,
      taxonomy: { map: { version: 1, mappedCount: 256, totalTips: 256, activeRanks: ["genus"],
        tipRanks: Array.from(parsed.leafNodes, (node, index) => ({ node, ranks: { genus: `Genus${Math.floor(index / 64)}` } })),
      } },
      visual: { viewMode, order: "input", showScaleBars: false, showTipLabels: true, showGenusLabels: false,
        useAutomaticTaxonomyRankVisibility: false, taxonomyRankVisibility: { genus: true },
        taxonomyRankDisplayModes: { genus: "ribbon" }, figureStyles: { taxonomy: { taxonomyGap: 1 } },
      },
    });
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount === 256);
    await settle(page);
    await page.evaluate(() => {
      const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const camera = canvas.getCamera()!;
      if (camera.kind === "rect") canvas.setRectCamera({ scaleY: 2.2 });
      else canvas.setCircularCamera({ scale: camera.scale * 2.2 / Number(canvas.getRenderDebug()?.tipSpacingPx) });
    });
    await settle(page);
    const read = () => page.evaluate(() => {
      const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const debug = canvas.getRenderDebug() as {
        rect: { taxonomyBandXs: number[]; tipBandWidthPx: number; microVisible: boolean };
        circular: { taxonomyFirstRingInnerRadiusPx: number; tipBandWidthPx: number };
        radial: { outerRadiusWorld: number }; tipSpacingPx: number;
      };
      const camera = canvas.getCamera()!;
      return camera.kind === "rect"
        ? { gap: debug.rect.taxonomyBandXs[0] - canvas.getBranchScreenSegmentForTest(2)!.x2,
          reserved: debug.rect.tipBandWidthPx, microVisible: debug.rect.microVisible }
        : { gap: debug.circular.taxonomyFirstRingInnerRadiusPx - camera.scale * debug.radial.outerRadiusWorld,
          reserved: debug.circular.tipBandWidthPx, microVisible: debug.tipSpacingPx > 2.9 };
    });
    const preview = await read();
    expect(preview.microVisible).toBe(false);
    expect(preview.reserved).toBeGreaterThan(0);
    expect(preview.gap).toBeGreaterThan(10);
    await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setFigureStyleForTest("taxonomy", "taxonomyGap", 0));
    await settle(page);
    for (const showGuideTicks of [true, false]) {
      await page.evaluate(show => {
        const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
        (app.setFigureStyleForTest as (kind: string, field: string, value: boolean) => void)("tip", "showGuideTicks", show);
      }, showGuideTicks);
      await settle(page);
      const closed = await read();
      expect(closed.microVisible).toBe(false);
      expect(closed.reserved).toBe(0);
      expect(closed.gap).toBeLessThan(0.5);
      expect(closed.gap).toBeGreaterThan(-8); // Circular fills include a small stroke-inset compensation.
    }
    await page.screenshot({ path: testInfo.outputPath(`${viewMode}-closed-cue-gap.png`) });
    await page.evaluate(() => {
      const canvas = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const camera = canvas.getCamera()!;
      if (camera.kind === "rect") canvas.setRectCamera({ scaleY: 6 });
      else canvas.setCircularCamera({ scale: camera.scale * 6 / Number(canvas.getRenderDebug()?.tipSpacingPx) });
    });
    await settle(page);
    const withText = await read();
    expect(withText.microVisible).toBe(true);
    expect(withText.reserved).toBeGreaterThan(20);
    expect(withText.gap).toBeGreaterThan(20);
  });
}

test("new subtree resets a 300-unit parent interval and calculates its own time ticks", async ({ page, context }, testInfo) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(() => window.postMessage({ type: "big-tree-viewer:load", payload: {
    newick: "((FlyA:40,FlyB:40)Drosophilidae:480,Other:520)Root;",
    visual: { viewMode: "circular", scaleTickIntervalInput: "300", showGenusLabels: false, showScaleBars: true },
  } }, "*"));
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().scaleTickInterval === 300);
  const key = "big-tree-viewer:subtree:automatic-interval";
  const payload = await page.evaluate(key => {
    const payload = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildSharedSubtreePayloadForTest(1)!;
    localStorage.setItem(key, JSON.stringify(payload));
    return payload;
  }, key);
  expect(payload.visual.scaleTickInterval).toBeNull();
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().scaleTickInterval)).toBe(300);
  const child = await context.newPage();
  await child.goto(`/?subtree=${encodeURIComponent(key)}`);
  await child.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names.includes("Drosophilidae"));
  expect(await child.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().scaleTickInterval)).toBeNull();
  const svg = await child.evaluate(() => new Promise<string>(resolve => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== "big-tree-viewer:exported") return;
      window.removeEventListener("message", listener); resolve(event.data.text);
    };
    window.addEventListener("message", listener);
    window.postMessage({ type: "big-tree-viewer:export", payload: { format: "svg", delivery: "postMessage" } }, "*");
  }));
  expect(svg).toContain("10 mya");
  expect(svg).toContain("20 mya");
  expect(svg).toContain("30 mya");
  expect(svg).not.toContain("37.5 mya");
  await child.screenshot({ path: testInfo.outputPath("subtree-automatic-scale.png") });
});
