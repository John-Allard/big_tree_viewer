import { chromium } from "playwright";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

// Measure opening a tree in an already-ready production viewer, not navigation.
// Run against `npm run preview -- --port 4174`; BTV_BENCH_OUTPUT saves stage timings.
const base = process.env.BTV_BENCH_URL || "http://127.0.0.1:4174/";
const counts = (process.env.BTV_BENCH_COUNTS || "1000,10000,50000").split(",").map(Number);
const samples = Number(process.env.BTV_BENCH_SAMPLES || 3);
if (!counts.length || counts.some(count => !Number.isSafeInteger(count) || count < 1)
  || !Number.isSafeInteger(samples) || samples < 1) throw new Error("Tip counts and sample count must be positive integers.");
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
  || (existsSync("/usr/bin/google-chrome-stable") ? "/usr/bin/google-chrome-stable" : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
function tree(count, offset = 0) {
  if (count === 1) return `Species_${offset}:1`;
  const left = Math.floor(count / 2);
  return `(${tree(left, offset)},${tree(count - left, offset + left)}):1`;
}
try {
  for (const count of counts) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await context.addInitScript(() => {
      localStorage.setItem("big-tree-viewer-tutorial-dismissed", "true");
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(...args) {
          super(...args);
          window.__loadProbe?.events.push({ kind: "worker-created", at: performance.now() });
          this.addEventListener("message", event => {
            if (window.__loadProbe) window.__loadProbe.events.push({ kind: event.data.type, message: event.data.message, at: performance.now() });
          });
        }
        postMessage(...args) {
          if (args[0]?.type === "parse-tree") window.__loadProbe?.events.push({ kind: "parse-request", at: performance.now() });
          super.postMessage(...args);
        }
      };
      let debug;
      Object.defineProperty(window, "__BIG_TREE_VIEWER_RENDER_DEBUG__", {
        configurable: true,
        get: () => debug,
        set: value => {
          debug = value;
          window.__loadProbe?.draws.push({ at: performance.now(), duration: value.timing?.totalMs });
        },
      });
    });
    let page = await context.newPage();
    await page.goto(`${base}?btv_api=1`);
    await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_API_READY__));
    for (let sample = 0; sample < samples; sample++) {
      if (sample > 0) {
        await page.close();
        page = await context.newPage();
        await page.goto(`${base}?btv_api=1`);
        await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_API_READY__));
      }
      const result = await page.evaluate(async ({ text, count }) => {
        const probe = { start: performance.now(), events: [], draws: [] };
        window.__loadProbe = probe;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Load timed out")), 30000);
          const listener = event => {
            if (event.data?.type === "big-tree-viewer:error") {
              removeEventListener("message", listener);
              clearTimeout(timeout);
              reject(new Error(event.data.message));
              return;
            }
            if (event.data?.type !== "big-tree-viewer:loaded") return;
            probe.loaded = performance.now();
            removeEventListener("message", listener);
            clearTimeout(timeout);
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          };
          addEventListener("message", listener);
          postMessage({ type: "big-tree-viewer:load", payload: { newick: text, label: `${count}-tip tree`, visual: { viewMode: "circular" } } }, "*");
        });
        const parsed = probe.events.find(event => event.kind === "parsed-tree")?.at;
        const draw = probe.draws.find(draw => parsed === undefined || draw.at >= parsed);
        if (!draw) throw new Error("The tree did not produce a completed canvas draw.");
        const events = probe.events.map(event => ({ ...event, at: event.at - probe.start }));
        return { replyMs: probe.loaded - probe.start, paintMs: performance.now() - probe.start,
          firstDrawMs: draw?.at - probe.start, drawMs: draw?.duration, events };
      }, { text: `${tree(count)};`, count });
      results.push({ count, sample, ...result });
      console.log(JSON.stringify({ count, sample, replyMs: result.replyMs, firstDrawMs: result.firstDrawMs, paintMs: result.paintMs }));
    }
    await context.close();
  }
  if (process.env.BTV_BENCH_OUTPUT) await fs.writeFile(process.env.BTV_BENCH_OUTPUT, JSON.stringify(results, null, 2));
} finally { await browser.close(); }
