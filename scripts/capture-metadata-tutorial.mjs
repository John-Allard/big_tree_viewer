import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const assetDirectory = path.join(root, "public", "tutorial", "metadata");
const baseUrl = process.env.BTV_URL ?? "http://127.0.0.1:5173/";
const tutorialNewick = "((((species_A:1,species_B:1):1,(species_C:1,species_D:1):1):1,((species_E:1,species_F:1):1,(species_G:1,species_H:1):1):1):1,(((species_I:1,species_J:1):1,(species_K:1,species_L:1):1):1,((species_M:1,species_N:1):1,(species_O:1,species_P:1):1):1):1)Root;";
const tutorialCsv = `species,habitat,trait_value,study_cohort,A_pct,C_pct,G_pct,T_pct
species_A,forest,0.12,reference,35,15,15,35
species_B,forest,0.18,discovery,38,12,13,37
species_C,grassland,0.25,validation,31,19,20,30
species_D,grassland,0.31,discovery,28,22,23,27
species_E,wetland,0.42,reference,25,25,26,24
species_F,wetland,0.49,validation,22,28,29,21
species_G,urban,0.55,discovery,20,30,30,20
species_H,urban,0.63,reference,24,26,27,23
species_I,forest,0.71,validation,18,32,31,19
species_J,grassland,0.78,discovery,21,29,30,20
species_K,wetland,0.86,reference,16,34,33,17
species_L,urban,0.94,validation,19,31,32,18
species_M,forest,1.02,discovery,23,27,28,22
species_N,grassland,1.11,reference,26,24,25,25
species_O,wetland,1.19,validation,29,21,22,28
species_P,urban,1.28,discovery,32,18,19,31
`;

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function waitForFrames(page, count = 3) {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);
}

async function openMetadataPanel(page) {
  const section = page.locator('[data-tour="metadata"]');
  const toggle = section.locator(".section-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await section.scrollIntoViewIfNeeded();
  await waitForFrames(page);
  return section;
}

async function loadTree(page, newick) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__
    && window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded,
  ));
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(newick.trim());
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes.length === 16);
  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setViewMode("rectangular");
    app?.setOrder("input");
    app?.setShowTipLabels(true);
    app?.setShowGenusLabels(false);
    app?.setShowTimeStripes(false);
    app?.setBranchThicknessScaleForTest(1.25);
    app?.requestFit();
  });
  await waitForFrames(page, 5);
}

async function captureSpreadsheet(browser, csvText) {
  const rows = csvText.trim().split(/\r?\n/).map((line) => line.split(","));
  const page = await browser.newPage({ viewport: { width: 1260, height: 720 }, deviceScaleFactor: 1 });
  const letters = rows[0].map((_, index) => String.fromCharCode(65 + index));
  const bodyRows = rows.map((row, rowIndex) => `
    <tr>
      <th class="row-number">${rowIndex + 1}</th>
      ${row.map((cell, columnIndex) => `<td class="${rowIndex === 0 ? "header-cell" : ""} ${columnIndex === 0 ? "key-cell" : ""}">${escapeHtml(cell)}</td>`).join("")}
    </tr>
  `).join("");
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 28px; background: #f3f5f7; color: #172033; font-family: Arial, sans-serif; }
          .sheet { overflow: hidden; border: 1px solid #b9c1cc; border-radius: 7px; background: white; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.12); }
          .title { padding: 12px 15px; border-bottom: 1px solid #c7ced8; background: #ffffff; font-size: 15px; font-weight: 700; }
          table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; }
          th, td { height: 30px; padding: 5px 8px; overflow: hidden; border-right: 1px solid #d7dce3; border-bottom: 1px solid #d7dce3; text-overflow: ellipsis; white-space: nowrap; }
          thead th { height: 27px; padding: 3px 8px; background: #e9edf2; color: #526071; font-size: 12px; font-weight: 600; text-align: center; }
          .corner, .row-number { width: 38px; background: #e9edf2; color: #657184; text-align: right; font-size: 12px; font-weight: 500; }
          td { text-align: right; }
          td:first-of-type { width: 188px; }
          td:nth-of-type(2) { width: 126px; }
          td:nth-of-type(3) { width: 112px; }
          td:nth-of-type(4) { width: 112px; }
          .header-cell { background: #dcebe3; color: #183d2b; font-weight: 700; text-align: left; }
          .key-cell { text-align: left; }
          tbody tr:hover td { background: #f5faf7; }
        </style>
      </head>
      <body>
        <div class="sheet">
          <div class="title">synthetic-metadata.csv</div>
          <table>
            <colgroup>
              <col style="width: 38px">
              <col style="width: 210px">
              <col style="width: 145px">
              <col style="width: 125px">
              <col style="width: 130px">
              ${rows[0].slice(4).map(() => '<col style="width: 100px">').join("")}
            </colgroup>
            <thead><tr><th class="corner"></th>${letters.map((letter) => `<th>${letter}</th>`).join("")}</tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
      </body>
    </html>`);
  await page.locator(".sheet").screenshot({ path: path.join(assetDirectory, "metadata-table.png") });
  await page.close();
}

async function captureViewer(browser, newick, csvText) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    window.localStorage.setItem("big-tree-viewer-tutorial-dismissed", "true");
    window.sessionStorage.clear();
  });
  await loadTree(page, newick);

  let metadataSection = await openMetadataPanel(page);
  await metadataSection.screenshot({ path: path.join(assetDirectory, "metadata-panel-empty.png") });

  await page.evaluate((text) => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.importMetadataTextForTest(text, "synthetic-metadata.csv");
  }, csvText);
  await page.waitForFunction(() => Number(
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataMatchedRowCount,
  ) === 16);
  metadataSection = await openMetadataPanel(page);
  await metadataSection.screenshot({ path: path.join(assetDirectory, "metadata-panel-loaded.png") });

  const canvas = page.locator(".tree-canvas-shell");
  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setMetadataMarkersEnabled(false);
    app?.setMetadataEnabled(true);
    app?.setMetadataValueColumn("study_cohort");
    app?.setMetadataColorMode("categorical");
    app?.setMetadataApplyScope("branch");
    app?.requestFit();
  });
  await page.waitForFunction(() => Number(
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataColoredNodeCount,
  ) === 16);
  await waitForFrames(page, 5);
  await canvas.screenshot({ path: path.join(assetDirectory, "metadata-categorical-branches.png") });

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setMetadataValueColumn("trait_value");
    app?.setMetadataColorMode("continuous");
    app?.setMetadataContinuousPalette("viridis");
  });
  await waitForFrames(page, 5);
  await canvas.screenshot({ path: path.join(assetDirectory, "metadata-continuous-branches.png") });

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setMetadataEnabled(false);
    app?.setMetadataMarkersEnabled(true);
    app?.setMetadataMarkerColumn("habitat");
    app?.setMetadataMarkerSizePx(78);
  });
  await waitForFrames(page, 5);
  await canvas.screenshot({ path: path.join(assetDirectory, "metadata-markers.png") });

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setMetadataMarkersEnabled(false);
    app?.setMetadataTipTableEnabled(true);
    app?.setMetadataTipTableMode("bars");
    app?.setMetadataTipTableColumns([{ column: "trait_value", label: "Trait value" }]);
  });
  await page.waitForFunction(() => (
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataTipTableMode === "bars"
  ));
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit());
  await waitForFrames(page, 6);
  await canvas.screenshot({ path: path.join(assetDirectory, "metadata-tip-bars.png") });

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setMetadataTipTableMode("heatmap");
    app?.setMetadataTipTableColumns([
      { column: "trait_value", label: "Trait value" },
      { column: "A_pct", label: "A %" },
      { column: "C_pct", label: "C %" },
      { column: "G_pct", label: "G %" },
      { column: "T_pct", label: "T %" },
    ]);
  });
  await page.waitForFunction(() => (
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataTipTableMode === "heatmap"
  ));
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit());
  await waitForFrames(page, 6);
  await canvas.screenshot({ path: path.join(assetDirectory, "metadata-tip-heatmap.png") });

  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setMetadataTipTableMode("categorical");
    app?.setMetadataTipTableCellStyle("filled");
    app?.setMetadataTipTableColumns([
      { column: "habitat", label: "Habitat" },
      { column: "study_cohort", label: "Study cohort" },
    ]);
  });
  await page.waitForFunction(() => (
    window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataTipTableMode === "categorical"
  ));
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.requestFit());
  await waitForFrames(page, 6);
  await canvas.screenshot({ path: path.join(assetDirectory, "metadata-tip-categorical.png") });

  await page.getByLabel("Show tip data table").uncheck();
  await page.getByLabel("Show metadata pie charts").check();
  await page.getByRole("button", { name: "Metadata pie charts settings" }).click();
  const pieDialog = page.getByRole("dialog", { name: "Metadata pie charts settings" });
  await pieDialog.getByLabel("First pie column").selectOption("A_pct");
  await pieDialog.getByLabel("Last pie column").selectOption("T_pct");
  await pieDialog.getByLabel("Pie size").fill("80");
  await page.getByRole("button", { name: "Close Metadata pie charts settings" }).click();
  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__;
    app?.setViewMode("circular");
    app?.requestFit();
  });
  await page.getByText("Pie charts: 16", { exact: true }).waitFor();
  await waitForFrames(page, 6);
  await canvas.screenshot({ path: path.join(assetDirectory, "metadata-pie-charts.png") });

  await page.close();
}

await fs.mkdir(assetDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  await captureSpreadsheet(browser, tutorialCsv);
  await captureViewer(browser, tutorialNewick, tutorialCsv);
} finally {
  await browser.close();
}
