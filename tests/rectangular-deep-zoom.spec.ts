import { expect, test } from "@playwright/test";
import fs from "node:fs";

test.use({
  launchOptions: {
    args: ["--enable-gpu"],
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ?? (fs.existsSync("/usr/bin/google-chrome-stable") ? "/usr/bin/google-chrome-stable" : undefined),
  },
});
test.skip(({ browserName }) => browserName !== "chromium", "Chromium canvas rasterization regression");

for (const tipCount of [1_000, 500_000, 1_000_000, 1_048_576]) {
  test(`${tipCount} tips paint rectangular detail and reach circular tip-level detail`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(process.env.BTV_RENDER_TEST_URL ?? "/?btv_api=1");
    const dismiss = page.getByRole("button", { name: "Don't show again", exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
    const depthLimit = Math.ceil(Math.log2(tipCount));
    const clade = (start: number, count: number, depth = 0): string => {
      if (count === 1) return `Tip_${start}:${depthLimit - depth + 1}`;
      const half = Math.floor(count / 2);
      return `(${clade(start, half, depth + 1)},${clade(start + half, count - half, depth + 1)}):1`;
    };
    const tree = `${clade(0, tipCount)};`;
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "deep-zoom.nwk", mimeType: "text/plain", buffer: Buffer.from(tree),
    });
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.evaluate(() => {
      const app = window.__BIG_TREE_VIEWER_APP_TEST__;
      app?.setViewMode("rectangular");
      app?.setShowTipLabels(true);
      app?.setShowGenusLabels(false);
      app?.setTaxonomyEnabled(false);
      app?.setShowTimeStripes(true);
    });
    const countDarkPixels = async (clip: { x: number; y: number; width: number; height: number }) => {
      // Inspect the composited screenshot, not visibility flags or a canvas readback
      // that could change which rendering backend supplies the pixels.
      const png = await page.screenshot();
      return await page.evaluate(async ({ dataUrl, clip }) => {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(clip.x, clip.y, clip.width, clip.height).data;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] < 130 && pixels[i + 1] < 130 && pixels[i + 2] < 130) count++;
        }
        return count;
      }, { dataUrl: `data:image/png;base64,${png.toString("base64")}`, clip });
    };
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const overviewClip = await page.locator(".tree-canvas").evaluate((canvas) => {
      const r = canvas.getBoundingClientRect();
      return { x: r.x + 40, y: r.y + 40, width: r.width - 260, height: r.height - 80 };
    });
    expect(await countDarkPixels(overviewClip)).toBeGreaterThan(1000);
    const clip = await page.evaluate(async (tipCount) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const canvas = document.querySelector<HTMLCanvasElement>(".tree-canvas")!;
      const rect = canvas.getBoundingClientRect();
      // A whole-tree cache at this scale spans tens of millions of device pixels.
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setRectCamera({
        scaleY: 96,
        translateY: rect.height / 2 - (tipCount / 2) * 96,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const debug = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug();
      const tipX = Number((debug?.rect as { tipSideX?: number } | undefined)?.tipSideX);
      if (!Number.isFinite(tipX)) throw new Error("No tip label position available");
      return { x: rect.x + tipX + 2, y: rect.y + rect.height / 2 - 18, width: 140, height: 36 };
    }, tipCount);
    const darkPixels = await countDarkPixels(clip);
    expect(darkPixels).toBeGreaterThan(30);
    const branchClip = { x: clip.x - 72, y: clip.y - 160, width: 40, height: 360 };
    expect(await countDarkPixels(branchClip), "Terminal branches must remain visible independently of tip text").toBeGreaterThan(30);


    const zoomedBranchClip = await page.evaluate(async (tipCount) => {
      const a = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const r = document.querySelector(".tree-canvas")!.getBoundingClientRect();
      const depth = Number(window.__BIG_TREE_VIEWER_APP_TEST__!.getState().maxDepth);
      a.setRectCamera({ scaleX: 4_000_000, scaleY: 96,
        translateX: r.width - 220 - depth * 4_000_000,
        translateY: r.height / 2 - tipCount / 2 * 96 });
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { x: r.x + r.width - 310, y: r.y + r.height / 2 - 160, width: 50, height: 360 };
    }, tipCount);
    expect(await countDarkPixels(zoomedBranchClip), "Branches must survive extreme two-axis zoom").toBeGreaterThan(30);

    await page.evaluate(() => { window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView(); window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular"); });
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug().viewMode === "circular");
    const anchor = await page.evaluate(() => {
      const a = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const d = a.getRenderDebug() as { radial: { outerRadiusWorld: number } };
      const r = document.querySelector(".tree-canvas")!.getBoundingClientRect();
      const radius = Math.min((r.width - 280) / 2, (r.height - 80) / 2);
      a.setCircularCamera({ scale: radius / d.radial.outerRadiusWorld, translateX: 40 + radius, translateY: r.height / 2 });
      return { x: r.x + 40 + 2 * radius, y: r.y + r.height / 2 };
    });
    await page.mouse.move(anchor.x, anchor.y);
    let rows = Infinity;
    let maximumWheelRenderMs = 0;
    const wheelFrames: {rows: number; ms: number}[] = [];
    for (let step = 0; step < 180 && rows > 12; step++) {
      await page.mouse.wheel(0, -60);
      await page.waitForTimeout(16);
      const frame = await page.evaluate(() => {
        const d = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getRenderDebug() as {
          height: number; tipSpacingPx: number; timing: { totalMs: number };
        };
        return { rows: d.height / d.tipSpacingPx, ms: d.timing.totalMs };
      });
      wheelFrames.push(frame);
      rows = frame.rows;
      maximumWheelRenderMs = Math.max(maximumWheelRenderMs, frame.ms);
    }
    await test.info().attach('wheel-frame-timings', { body: JSON.stringify(wheelFrames), contentType: 'application/json' });
    expect(maximumWheelRenderMs, "Every intermediate wheel frame must avoid the former spatial-index stall").toBeLessThan(1_000);
    expect(rows).toBeGreaterThanOrEqual(8);
    expect(rows).toBeLessThanOrEqual(12);
    const circularLabelClip = await page.evaluate(() => {
      const r = document.querySelector(".tree-canvas")!.getBoundingClientRect();
      const hits = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getLabelHitboxes()
        .filter(h => h.labelKind === "tip" && h.x > 0 && h.x < r.width - 120 && h.y > 40 && h.y < r.height - 40);
      if (!hits.length) throw new Error("No visible circular tip labels");
      const h = hits[Math.floor(hits.length / 2)];
      return { x: r.x + h.x, y: r.y + h.y - 18, width: 110, height: 36 };
    });
    expect(await countDarkPixels(circularLabelClip)).toBeGreaterThan(30);
    expect(await countDarkPixels({ ...circularLabelClip, x: circularLabelClip.x - 80, width: 40 }),
      "Radial terminal branches must appear beside the labels").toBeGreaterThan(20);
    const beforePan = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera());
    await page.mouse.move(anchor.x - 120, anchor.y);
    await page.mouse.down();
    await page.mouse.move(anchor.x - 170, anchor.y + 50, { steps: 4 });
    await page.mouse.up();
    const afterPan = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera());
    expect(afterPan).not.toEqual(beforePan);

  });

}
