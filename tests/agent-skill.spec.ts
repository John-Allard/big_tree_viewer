import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, expect, test, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptsDir = path.join(repoRoot, "public/agentic-ai/bigtreeviewer-agent-skill/scripts");
const treePath = path.join(repoRoot, "tests/fixtures/agent-skill-tree.nwk");
const metadataPath = path.join(repoRoot, "tests/fixtures/agent-skill-metadata.csv");
const localBtvUrl = "http://127.0.0.1:4173/";

type PixelBounds = {
  width: number;
  height: number;
  count: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

async function inspectPng(page: Page, imagePath: string): Promise<PixelBounds> {
  const imageBytes = await fs.readFile(imagePath);
  return await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to inspect rendered PNG.");
    }
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width;
    let top = canvas.height;
    let right = -1;
    let bottom = -1;
    let count = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = ((y * canvas.width) + x) * 4;
        if (
          pixels[index + 3] >= 16
          && (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)
        ) {
          count += 1;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      count,
      left,
      top,
      right,
      bottom,
    };
  }, `data:image/png;base64,${imageBytes.toString("base64")}`);
}

async function runSkillScript(script: string, args: string[]): Promise<string> {
  const result = await execFileAsync("python3", ["-S", path.join(scriptsDir, script), ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

async function createInteractiveLauncher(): Promise<string> {
  const bootstrap = [
    "import sys, webbrowser",
    "sys.path.insert(0, sys.argv[1])",
    "import btv_open",
    "webbrowser.open = lambda url, *args, **kwargs: (print(url), True)[1]",
    "sys.argv = ['btv_open.py', *sys.argv[2:]]",
    "btv_open.main()",
  ].join(";");
  const result = await execFileAsync("python3", [
    "-S",
    "-c",
    bootstrap,
    scriptsDir,
    treePath,
    "--btv-url", localBtvUrl,
    "--view", "circular",
    "--tip-labels", "false",
    "--time-stripes", "false",
    "--scale-bars", "false",
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    timeout: 30_000,
  });
  return result.stdout.trim();
}

test("interactive helper promotes a local tree into one top-level BTV tab", async ({ page }) => {
  const launcherUrl = await createInteractiveLauncher();
  const launcherHtml = await fs.readFile(fileURLToPath(launcherUrl), "utf8");
  expect(launcherHtml).toContain('<iframe id="viewer"');
  expect(launcherHtml).not.toContain("window.open(");
  expect(launcherHtml).toContain('capabilities.includes("window-name-launch")');
  expect(launcherHtml).not.toContain("big-tree-viewer:stage-launch");

  let popupCount = 0;
  page.on("popup", () => {
    popupCount += 1;
  });
  await page.goto(launcherUrl);
  await page.waitForURL(`${localBtvUrl}**`);
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && !Boolean(state?.loading);
  });
  expect(page.url()).toBe(localBtvUrl);
  expect(page.frames()).toHaveLength(1);
  expect(popupCount).toBe(0);
  expect(await page.evaluate(() => window.name)).toBe("");
  const stagedPayloadCount = await page.evaluate(async () => await new Promise<number>((resolve, reject) => {
    const request = indexedDB.open("big-tree-viewer-launches", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("payloads", "readonly");
      const countRequest = transaction.objectStore("payloads").count();
      countRequest.onerror = () => reject(countRequest.error);
      countRequest.onsuccess = () => resolve(countRequest.result);
      transaction.oncomplete = () => db.close();
    };
  }));
  expect(stagedPayloadCount).toBe(0);

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState());
  expect(state?.viewMode).toBe("circular");
  const tutorialClose = page.getByRole("button", { name: "Close tutorial prompt" });
  if (await tutorialClose.isVisible()) {
    await tutorialClose.click();
  }
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: undefined });
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("agent-skill-tree.btvsession");
  const sessionPath = await download.path();
  expect(sessionPath).toBeTruthy();

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load Session" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath as string);
  await expect(page.getByText(/Loaded session from/)).toBeVisible();
});

test("agent skill renders all view modes without using the active browser", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const browserPath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();
  const profilePath = testInfo.outputPath("isolated-browser-profile");
  const circularPath = testInfo.outputPath("circular.png");
  const rectangularPath = testInfo.outputPath("rectangular-metadata.png");
  const spiralPath = testInfo.outputPath("spiral.png");
  const svgPath = testInfo.outputPath("circular.svg");
  const sharedArgs = [
    "--btv-url", localBtvUrl,
    "--browser", browserPath,
    "--profile-dir", profilePath,
    "--timeout", "90",
  ];

  await runSkillScript("btv_render.py", [
    treePath,
    "--output", circularPath,
    "--view", "circular",
    "--tip-labels", "false",
    "--genus-labels", "false",
    "--time-stripes", "false",
    "--scale-bars", "false",
    "--width", "600",
    "--height", "600",
    ...sharedArgs,
  ]);
  const circular = await inspectPng(page, circularPath);
  expect(circular.width).toBe(600);
  expect(circular.height).toBe(600);
  expect(circular.count).toBeGreaterThan(100);
  const circularContentWidth = circular.right - circular.left + 1;
  const circularContentHeight = circular.bottom - circular.top + 1;
  expect(circularContentWidth / circularContentHeight).toBeGreaterThan(0.95);
  expect(circularContentWidth / circularContentHeight).toBeLessThan(1.05);
  expect(Math.abs((circular.left + circular.right) - circular.width)).toBeLessThan(circular.width * 0.08);
  expect(Math.abs((circular.top + circular.bottom) - circular.height)).toBeLessThan(circular.height * 0.08);

  await runSkillScript("btv_render.py", [
    treePath,
    "--metadata", metadataPath,
    "--metadata-key", "name",
    "--metadata-value", "group",
    "--output", rectangularPath,
    "--view", "rectangular",
    "--time-stripes", "false",
    "--scale-bars", "false",
    "--width", "800",
    "--height", "500",
    ...sharedArgs,
  ]);
  const rectangular = await inspectPng(page, rectangularPath);
  expect(rectangular.width).toBe(800);
  expect(rectangular.height).toBe(500);
  expect(rectangular.count).toBeGreaterThan(500);

  await runSkillScript("btv_open.py", [
    treePath,
    "--download-export", "png",
    "--export-filename", spiralPath,
    "--view", "spiral",
    "--spiral-turns", "6",
    "--tip-labels", "false",
    "--genus-labels", "false",
    "--time-stripes", "false",
    "--scale-bars", "false",
    "--width", "600",
    "--height", "600",
    ...sharedArgs,
  ]);
  const spiral = await inspectPng(page, spiralPath);
  expect(spiral.width).toBe(600);
  expect(spiral.height).toBe(600);
  expect(spiral.count).toBeGreaterThan(100);

  await runSkillScript("btv_render.py", [
    treePath,
    "--output", svgPath,
    "--view", "circular",
    "--tip-labels", "false",
    "--genus-labels", "false",
    "--time-stripes", "false",
    "--scale-bars", "false",
    ...sharedArgs,
  ]);
  const svg = await fs.readFile(svgPath, "utf8");
  expect(svg).toContain("<svg");
  expect(svg).toContain("<line");
});
