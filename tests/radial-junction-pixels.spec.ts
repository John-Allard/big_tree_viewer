import { expect, test } from "@playwright/test";

test("radial arcs do not grow counterclockwise miter spurs", async ({ page }, testInfo) => {
  await page.goto("/?btv_newick=(A:1,B:1);&btv_view=radial");
  const result = await page.evaluate(async () => {
    const moduleUrl = "/src/components/treeCanvasUtils.ts";
    const { strokeRadialConnector } = await import(moduleUrl);
    const failures: unknown[] = [];
    let oldSpurInk = 0;
    let samples = 0;
    const examples: HTMLCanvasElement[] = [];
    for (const dpr of [1, 2]) {
      for (const radius of [100, 10000, 100000]) {
        for (const degrees of [12, 78.5, 102, 145, 165, 210, 238.5, 257, 282.5, 320]) {
          for (const width of [1.2, 2]) {
            for (const cached of [false, true]) {
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 100 * dpr;
              const ctx = canvas.getContext("2d")!;
              ctx.fillStyle = "white";
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.scale(dpr, dpr);
              const theta = degrees * Math.PI / 180;
              const centerX = 50 - Math.cos(theta) * radius;
              const centerY = 50 - Math.sin(theta) * radius;
              const path = new Path2D();
              if (cached) {
                const scale = radius / 10;
                ctx.translate(centerX, centerY);
                ctx.scale(scale, scale);
                path.moveTo(Math.cos(theta) * 10, Math.sin(theta) * 10);
                path.arc(0, 0, 10, theta, theta + 40 / radius);
                ctx.lineWidth = width / scale;
              } else {
                path.moveTo(centerX + Math.cos(theta) * radius, centerY + Math.sin(theta) * radius);
                path.arc(centerX, centerY, radius, theta, theta + 40 / radius);
                ctx.lineWidth = width;
              }
              strokeRadialConnector(ctx, path);
              const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              let outsideInk = 0;
              let totalInk = 0;
              for (let y = 0; y < canvas.height; y += 1) {
                for (let x = 0; x < canvas.width; x += 1) {
                  const ink = 255 - pixels[(y * canvas.width + x) * 4];
                  totalInk += ink;
                  const tangent = -((x + 0.5) / dpr - 50) * Math.sin(theta)
                    + ((y + 0.5) / dpr - 50) * Math.cos(theta);
                  if (tangent < -2) outsideInk += ink;
                }
              }
              samples += 1;
              if (outsideInk > 0 || totalInk < 2000 * dpr * dpr) {
                failures.push({ dpr, radius, degrees, width, cached, outsideInk, totalInk });
              }
              if (dpr === 1 && radius === 10000 && degrees === 145 && width === 2 && !cached) {
                examples.push(canvas);
                const old = document.createElement("canvas");
                old.width = old.height = 100;
                const oldCtx = old.getContext("2d")!;
                oldCtx.fillStyle = "white";
                oldCtx.fillRect(0, 0, 100, 100);
                oldCtx.lineWidth = width;
                oldCtx.lineCap = "butt";
                oldCtx.stroke(path);
                const oldPixels = oldCtx.getImageData(0, 0, 100, 100).data;
                for (let y = 0; y < 100; y += 1) for (let x = 0; x < 100; x += 1) {
                  const tangent = -(x + 0.5 - 50) * Math.sin(theta) + (y + 0.5 - 50) * Math.cos(theta);
                  if (tangent < -2) oldSpurInk += 255 - oldPixels[(y * 100 + x) * 4];
                }
                examples.unshift(old);
              }
            }
          }
        }
      }
    }
    const evidence = document.createElement("div");
    evidence.id = "junction-evidence";
    evidence.style.cssText = "position:fixed;inset:0;z-index:10000;background:white;display:flex;gap:20px;padding:20px;align-items:flex-start";
    for (const [index, canvas] of examples.entries()) {
      const panel = document.createElement("div");
      panel.textContent = index === 0 ? "Default miter join" : "Bevel join";
      canvas.style.cssText = "display:block;width:400px;height:400px;image-rendering:pixelated";
      panel.append(canvas);
      evidence.append(panel);
    }
    document.body.append(evidence);
    return { failures, samples, oldSpurInk };
  });
  await page.locator("#junction-evidence").screenshot({ path: testInfo.outputPath("arc-join-comparison.png") });
  expect(result.samples).toBe(240);
  // Negative control: the same coordinates with the old join must reproduce it.
  expect(result.oldSpurInk).toBeGreaterThan(500);
  expect(result.failures).toEqual([]);
});

test("zero and near-zero stems retain continuous radial junctions", async ({ page }) => {
  await page.goto("/?btv_newick=(A:1,B:1);&btv_view=radial");
  const failures = await page.evaluate(async () => {
    const moduleUrl = "/src/components/treeCanvasUtils.ts";
    const { strokeRadialConnector } = await import(moduleUrl);
    const failures: unknown[] = [];
    for (const dpr of [1, 2]) for (const degrees of [45, 145, 225, 315]) {
      for (const length of [0, 0.000001, 0.1]) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 100 * dpr;
        const ctx = canvas.getContext("2d")!;
        ctx.scale(dpr, dpr);
        const theta = degrees * Math.PI / 180, radius = 10000;
        const cx = 50 - Math.cos(theta) * radius, cy = 50 - Math.sin(theta) * radius;
        const path = new Path2D();
        path.moveTo(cx + Math.cos(theta - 30 / radius) * radius, cy + Math.sin(theta - 30 / radius) * radius);
        path.arc(cx, cy, radius, theta - 30 / radius, theta);
        path.moveTo(cx + Math.cos(theta) * (radius + length), cy + Math.sin(theta) * (radius + length));
        path.arc(cx, cy, radius + length, theta, theta + 30 / radius);
        ctx.lineWidth = 1.2;
        strokeRadialConnector(ctx, path);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(50, 50);
        ctx.lineTo(50 + Math.cos(theta) * length, 50 + Math.sin(theta) * length);
        ctx.stroke();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let t = -3; t <= 3; t += 0.25) {
          const x = (50 - Math.sin(theta) * t) * dpr;
          const y = (50 + Math.cos(theta) * t) * dpr;
          let alpha = 0;
          for (let dy = -0.5; dy <= 0.5; dy += 1) for (let dx = -0.5; dx <= 0.5; dx += 1) {
            const index = (Math.floor(y + dy) * canvas.width + Math.floor(x + dx)) * 4 + 3;
            alpha = Math.max(alpha, pixels[index]);
          }
          if (alpha < 40) failures.push({ dpr, degrees, length, t, alpha });
        }
      }
    }
    return failures;
  });
  expect(failures).toEqual([]);
});

function smallTree(first = 0, count = 256): string {
  if (count === 1) return `Species_${first}:1`;
  return `(${smallTree(first, count / 2)},${smallTree(first + count / 2, count / 2)}):1`;
}

test("small radial trees use the safe join for base colors and mouse hover", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const arcs = new WeakSet<Path2D>();
    const currentArcs = new WeakSet<CanvasRenderingContext2D>();
    const strokes: Array<{ join: string; cap: string; color: string }> = [];
    const originalPathArc = Path2D.prototype.arc;
    Path2D.prototype.arc = function (...args: Parameters<Path2D["arc"]>) {
      arcs.add(this);
      return originalPathArc.apply(this, args);
    };
    const originalArc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function (...args: Parameters<CanvasRenderingContext2D["arc"]>) {
      currentArcs.add(this);
      return originalArc.apply(this, args);
    };
    const originalBegin = CanvasRenderingContext2D.prototype.beginPath;
    CanvasRenderingContext2D.prototype.beginPath = function () {
      currentArcs.delete(this);
      return originalBegin.call(this);
    };
    const originalStroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (path?: Path2D) {
      if ((path && arcs.has(path)) || (!path && currentArcs.has(this))) {
        strokes.push({ join: this.lineJoin, cap: this.lineCap, color: String(this.strokeStyle) });
        if ((window as unknown as { forceMiterJoins?: boolean }).forceMiterJoins) this.lineJoin = "miter";
      }
      if (path) originalStroke.call(this, path);
      else originalStroke.call(this);
    };
    Object.assign(window, { junctionStrokes: strokes });
  });
  await page.goto(`/?btv_newick=${encodeURIComponent(`${smallTree()};`)}&btv_view=radial`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
    app.setShowTimeStripes(false);
    app.setShowGenusLabels(false);
    app.setShowTipLabels(false);
    app.setShowCircularCenterRadialScaleBar(false);
  });
  const target = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!;
    const camera = api.getCamera()!;
    if (camera.kind !== "circular") throw new Error("No radial camera");
    const candidates = internal.leafNodes.filter((node) => internal.firstChild![internal.parent![node]] === node);
    const node = candidates[Math.floor(candidates.length * 145 / 360)];
    const segment = api.getBranchScreenSegmentForTest(node)!;
    const theta = Math.atan2(segment.y1 - camera.translateY, segment.x1 - camera.translateX);
    const worldRadius = Math.hypot(segment.x1 - camera.translateX, segment.y1 - camera.translateY) / camera.scale;
    window.__BIG_TREE_VIEWER_APP_TEST__!.setCircularRotationDegreesForTest((145 * Math.PI / 180 - theta) * 180 / Math.PI);
    return { node, worldRadius };
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(({ worldRadius }) => {
    const theta = 145 * Math.PI / 180;
    window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setCircularCamera({
      scale: 10000 / worldRadius,
      translateX: 320 - Math.cos(theta) * 10000,
      translateY: 300 - Math.sin(theta) * 10000,
    });
  }, target);
  await page.evaluate(({ node }) => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.setManualSubtreeColor(node, "#e2845b"), target);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const measureSpur = () => page.evaluate(({ node }) => {
    const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
    const segment = api.getBranchScreenSegmentForTest(node)!;
    const canvas = document.querySelector("[data-testid=tree-canvas]") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const left = Math.floor((segment.x1 - 16) * dpr), top = Math.floor((segment.y1 - 16) * dpr);
    const size = Math.ceil(32 * dpr);
    const pixels = ctx.getImageData(left, top, size, size).data;
    const theta = 145 * Math.PI / 180;
    let outsideInk = 0;
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const dx = (left + x + 0.5) / dpr - segment.x1;
      const dy = (top + y + 0.5) / dpr - segment.y1;
      const tangent = -dx * Math.sin(theta) + dy * Math.cos(theta);
      const index = (y * size + x) * 4;
      if (tangent < -2) outsideInk += Math.max(0, pixels[index] - pixels[index + 1] - 10);
    }
    return outsideInk;
  }, target);
  expect(await measureSpur()).toBe(0);
  await page.evaluate(() => {
    Object.assign(window, { forceMiterJoins: true });
    const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
    api.setCircularCamera(api.getCamera()!);
  });
  const oldSpurInk = await measureSpur();
  await page.locator("[data-testid=tree-canvas]").screenshot({ path: testInfo.outputPath("small-tree-old-miter.png") });
  await page.evaluate(() => {
    Object.assign(window, { forceMiterJoins: false });
    const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
    api.setCircularCamera(api.getCamera()!);
  });
  expect(oldSpurInk).toBeGreaterThan(0);
  expect(await measureSpur()).toBe(0);
  const point = await page.evaluate(({ node }) => {
    const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
    const segment = api.getBranchScreenSegmentForTest(node)!;
    const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
    const x = segment.x1 + (segment.x2 - segment.x1) * 20 / length;
    const y = segment.y1 + (segment.y2 - segment.y1) * 20 / length;
    const bounds = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect();
    return { x: bounds.left + x, y: bounds.top + y, hit: api.probeHoverForTest(x, y) };
  }, target);
  expect(point.hit?.node).toBe(target.node);
  await page.mouse.move(point.x, point.y);
  await page.waitForFunction(() => (
    (window as unknown as { junctionStrokes: Array<{ color: string }> }).junctionStrokes.some((stroke) => stroke.color === "#c2410c")
  ));
  expect(await measureSpur()).toBe(0);
  await page.evaluate(() => {
    Object.assign(window, { forceMiterJoins: true });
    const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
    api.setCircularCamera(api.getCamera()!);
  });
  expect(await measureSpur()).toBeGreaterThan(0);
  await page.locator("[data-testid=tree-canvas]").screenshot({ path: testInfo.outputPath("small-tree-hover-old-miter.png") });
  await page.evaluate(() => {
    Object.assign(window, { forceMiterJoins: false });
    const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
    api.setCircularCamera(api.getCamera()!);
  });
  expect(await measureSpur()).toBe(0);
  const strokes = await page.evaluate(() => (window as unknown as {
    junctionStrokes: Array<{ join: string; cap: string; color: string }>;
  }).junctionStrokes);
  expect(strokes.length).toBeGreaterThan(2);
  expect(strokes.some((stroke) => stroke.color === "#e2845b")).toBe(true);
  expect(strokes.every((stroke) => stroke.join === "bevel" && stroke.cap === "butt")).toBe(true);
  await page.locator("[data-testid=tree-canvas]").screenshot({ path: testInfo.outputPath("small-tree-hover.png") });
});
