import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULT_EXECUTABLE = process.env.BIG_TREE_VIEWER_BENCH_BROWSER ?? "/usr/bin/google-chrome-stable";

function parseArgs(argv) {
  const options = {
    tree: null,
    url: process.env.BIG_TREE_VIEWER_BENCH_URL ?? "http://127.0.0.1:5173",
    taxonomy: "mock",
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    dragDx: 480,
    dragDy: 120,
    steps: 24,
    label: "cli-benchmark",
    executablePath: DEFAULT_EXECUTABLE,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--tree" && next) {
      options.tree = path.resolve(next);
      index += 1;
    } else if (arg === "--url" && next) {
      options.url = next;
      index += 1;
    } else if (arg === "--taxonomy" && next) {
      options.taxonomy = next;
      index += 1;
    } else if (arg === "--width" && next) {
      options.width = Number(next);
      index += 1;
    } else if (arg === "--height" && next) {
      options.height = Number(next);
      index += 1;
    } else if (arg === "--dpr" && next) {
      options.deviceScaleFactor = Number(next);
      index += 1;
    } else if (arg === "--dx" && next) {
      options.dragDx = Number(next);
      index += 1;
    } else if (arg === "--dy" && next) {
      options.dragDy = Number(next);
      index += 1;
    } else if (arg === "--steps" && next) {
      options.steps = Number(next);
      index += 1;
    } else if (arg === "--label" && next) {
      options.label = next;
      index += 1;
    } else if (arg === "--browser" && next) {
      options.executablePath = next;
      index += 1;
    }
  }
  if (!options.tree) {
    throw new Error("Missing required --tree /absolute/or/relative/path.nwk");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv);
  const browser = await chromium.launch({
    headless: true,
    executablePath: options.executablePath || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: options.deviceScaleFactor,
  });

  try {
    await page.goto(options.url);
    await page.setInputFiles('input[type="file"]', options.tree);
    await page.waitForFunction(() => {
      const app = window.__BIG_TREE_VIEWER_APP_TEST__;
      return Boolean(app && app.getState().treeLoaded && !app.getState().loading && window.__BIG_TREE_VIEWER_CANVAS_TEST__);
    }, { timeout: 180000 });

    await page.evaluate(async (taxonomyMode) => {
      window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("circular");
      if (taxonomyMode === "mock") {
        window.__BIG_TREE_VIEWER_APP_TEST__?.setMockTaxonomy();
      } else if (taxonomyMode === "off") {
        window.__BIG_TREE_VIEWER_APP_TEST__?.clearTaxonomy();
      }
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, options.taxonomy);

    const canvas = page.getByTestId("tree-canvas");
    const box = await canvas.boundingBox();
    if (!box) {
      throw new Error("Canvas not found.");
    }

    await page.evaluate((label) => {
      window.__BIG_TREE_VIEWER_CANVAS_TEST__?.startPanBenchmark(label);
    }, options.label);

    const startX = box.x + (box.width * 0.5);
    const startY = box.y + (box.height * 0.5);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + options.dragDx, startY + options.dragDy, { steps: options.steps });
    await page.mouse.up();
    await page.waitForTimeout(150);

    const result = await page.evaluate(() => ({
      benchmark: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.stopPanBenchmark?.() ?? null,
      renderDebug: window.__BIG_TREE_VIEWER_RENDER_DEBUG__ ?? null,
      state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState?.() ?? null,
    }));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
