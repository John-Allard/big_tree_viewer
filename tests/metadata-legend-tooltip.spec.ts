import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync, strFromU8 } from "fflate";

const smallTree = "((A:1,B:1)CladeOne:1,(C:1,D:1)CladeTwo:1)Root;";
async function load(page: Page, mode = "rectangular") {
  await page.setViewportSize({ width: 1200, height: 800 });
  const newick = mode === "spiral" ? `(${["A", "B", ...Array.from({ length: 998 }, (_, i) => `Tip${i}`)].map(name => `${name}:1`).join(",")})Root;` : smallTree;
  await page.route("**/legend-tree.nwk", route => route.fulfill({ body: newick, contentType: "text/plain" }));
  await page.goto(`/?btv_newick_url=/legend-tree.nwk&btv_view=${mode}`);
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.treeLoaded && !state.loading;
  });
}
async function openMetadata(page: Page) {
  const section = page.locator(".panel-section .section-toggle").filter({ hasText: "Metadata" }).first();
  if (await section.getAttribute("aria-expanded") !== "true") await section.click();
}
async function hoverBranch(page: Page, name: string) {
  const point = await page.evaluate(target => {
    const node = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.names!.indexOf(target);
    const segment = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getBranchScreenSegmentForTest(node)!;
    return { x: (segment.x1 + segment.x2) / 2, y: (segment.y1 + segment.y2) / 2 };
  }, name);
  const box = (await page.getByTestId("tree-canvas").boundingBox())!;
  await page.mouse.move(box.x + point.x, box.y + point.y);
  await expect(page.locator(".hover-tooltip")).toBeVisible();
  return page.locator(".hover-tooltip");
}

for (const mode of ["rectangular", "circular", "fan", "spiral"]) {
  test(`${mode} metadata legend is exportable and does not change the camera`, async ({ page }, testInfo) => {
    test.setTimeout(45000);
    await load(page, mode);
    await page.evaluate(() => {
      const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
      app.importMetadataTextForTest("name,state,trait,P,Q\nA,Alpha,Present,3,1\nB,Beta,Absent,1,3\n", "traits.csv");
      app.setMetadataMarkersEnabled(true);
      app.setMetadataMarkerColumn("trait");
      app.setMetadataPiesEnabled(true);
      app.setMetadataPieStartColumn("P");
      app.setMetadataPieEndColumn("Q");
    });
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().metadataMatchedRowCount === 2);
    await openMetadata(page);
    if (mode === "rectangular") {
      await page.getByRole("button", { name: "Hide side panel", exact: true }).click();
      await page.getByRole("button", { name: "Show side panel", exact: true }).click();
    }
    const toggle = page.getByLabel("Show metadata legend", { exact: true });
    await expect(toggle).not.toBeChecked();
    const camera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera());
    await toggle.check();
    await page.getByRole("button", { name: "Metadata legend settings", exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getRenderDebug()?.metadataLegend));
    const svg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest());
    for (const text of ["Branch colors: state", "Alpha", "Beta", "Markers: trait", "Present", "Absent", "Pie charts", ">P<", ">Q<"]) expect(svg).toContain(text);
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera())).toEqual(camera);
    await page.getByRole("combobox", { name: "Legend position", exact: true }).selectOption("bottom-left");
    const canvasBox = (await page.getByTestId("tree-canvas").boundingBox())!;
    const legend = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getRenderDebug()!.metadataLegend as { x: number; y: number; width: number; height: number });
    expect(legend.x).toBeGreaterThanOrEqual(0);
    expect(legend.y + legend.height).toBeLessThanOrEqual(canvasBox.height);
    await page.getByRole("button", { name: "Export View", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export view settings" });
    await dialog.getByLabel("Width px").fill("1800");
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    await (await download).saveAs(testInfo.outputPath("metadata-legend.png"));
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("metadata-legend-screen.png") });
    await toggle.uncheck();
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest())).not.toContain("Branch colors: state");
  });
}

test("branch tooltip reports effective subtree states, labels, markers and pie values", async ({ page }, testInfo) => {
  await load(page);
  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
    app.importMetadataTextForTest("name,state,note,trait,P,Q\nRoot,Ancestral,,,,\nCladeOne,Derived,,,,\nA,Special,,,,\nB,,sample,Present,1,3\n", "states.csv");
    app.setMetadataApplyScope("subtree");
    app.setMetadataLabelsEnabled(true);
    app.setMetadataLabelColumn("note");
    app.setMetadataMarkersEnabled(true);
    app.setMetadataMarkerColumn("trait");
    app.setMetadataPiesEnabled(true);
    app.setMetadataPieStartColumn("P");
    app.setMetadataPieEndColumn("Q");
    app.setOrder("input");
    app.requestFit();
  });
  await page.waitForFunction(() => Number(window.__BIG_TREE_VIEWER_APP_TEST__!.getState().metadataColoredNodeCount) > 3);
  const tooltip = await hoverBranch(page, "B");
  for (const value of ["state: Derived", "note: sample", "trait: Present", "P: 1", "Q: 3"]) await expect(tooltip).toContainText(value);
  await page.screenshot({ path: testInfo.outputPath("branch-metadata-tooltip.png") });
  await page.mouse.move(0, 0);
  await expect(await hoverBranch(page, "A")).toContainText("state: Special");
  await page.mouse.move(0, 0);
  await expect(await hoverBranch(page, "C")).toContainText("state: Ancestral");
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setMetadataApplyScope("branch"));
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().metadataApplyScope === "branch");
  await page.mouse.move(0, 0);
  await expect(await hoverBranch(page, "B")).not.toContainText("state:");
});

test("continuous legend and raw tooltip values follow the selected palette and clamps", async ({ page }, testInfo) => {
  await load(page);
  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
    app.importMetadataTextForTest("name,score\nA,2\nB,7\nC,20\n", "scores.csv");
    app.setMetadataColorMode("continuous");
    app.setMetadataContinuousMaxInput("5");
    app.setMetadataContinuousMinInput("0");
    app.setMetadataContinuousPalette("viridis");
    app.setMetadataReverseScale(true);
    app.setOrder("input");
    app.requestFit();
  });
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().metadataColoredNodeCount === 3);
  await openMetadata(page);
  await page.getByLabel("Show metadata legend", { exact: true }).check();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getRenderDebug()?.metadataLegend));
  const svg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest());
  expect(svg).toContain("Branch colors: score");
  expect(svg).toContain("0 to 5");
  await expect(await hoverBranch(page, "B")).toContainText("score: 7");
  await page.mouse.move(0, 0);
  await expect(await hoverBranch(page, "C")).toContainText("score: 20");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath("continuous-legend.png") });
});

test("metadata legend selection and position survive session reload", async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
    window.__BIG_TREE_VIEWER_APP_TEST__!.importMetadataTextForTest("name,state\nA,Alpha\nB,Beta\n", "states.csv");
  });
  await openMetadata(page);
  await page.getByLabel("Show metadata legend", { exact: true }).check();
  await page.getByRole("button", { name: "Metadata legend settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Legend position", exact: true }).selectOption("bottom-left");
  const details = page.getByRole("dialog", { name: "Metadata legend settings" });
  await details.getByLabel("Markers", { exact: true }).uncheck();
  await details.getByLabel("Pie charts", { exact: true }).uncheck();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save Session", exact: true }).click();
  const savedPath = (await (await download).path())!;
  const session = JSON.parse(strFromU8(gunzipSync(await readFile(savedPath))));
  expect(session.settings.metadataLegendEnabled).toBe(true);
  expect(session.settings.metadataLegendPosition).toBe("bottom-left");
  expect(session.settings.metadataLegendComponents).toEqual({ branchColors: true, markers: false, pies: false });
  await page.getByLabel("Show metadata legend", { exact: true }).uncheck();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Load Session", exact: true }).click();
  await (await chooserPromise).setFiles(savedPath);
  await expect(page.getByLabel("Show metadata legend", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Metadata legend settings", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Legend position", exact: true })).toHaveValue("bottom-left");
  await expect(details.getByLabel("Markers", { exact: true })).not.toBeChecked();
});

test("legend components, dragging, and context-menu settings work without panning the tree", async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const app = window.__BIG_TREE_VIEWER_APP_TEST__!;
    app.importMetadataTextForTest("name,state,trait,P,Q\nA,Alpha,Present,3,1\nB,Beta,Absent,1,3\n", "traits.csv");
    app.setMetadataMarkersEnabled(true); app.setMetadataMarkerColumn("trait");
    app.setMetadataPiesEnabled(true); app.setMetadataPieStartColumn("P"); app.setMetadataPieEndColumn("Q");
  });
  await openMetadata(page);
  await page.getByLabel("Show metadata legend", { exact: true }).check();
  await page.getByRole("button", { name: "Metadata legend settings", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Metadata legend settings" });
  await details.getByLabel("Markers", { exact: true }).uncheck();
  await details.getByLabel("Pie charts", { exact: true }).uncheck();
  const svg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest());
  expect(svg).toContain("Branch colors: state");
  expect(svg).not.toContain("Markers: trait");
  expect(svg).not.toContain("Pie charts");
  await details.getByRole("button", { name: "Close Metadata legend settings" }).click();
  const legendPoint = async () => {
    const bounds = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getRenderDebug()!.metadataLegend as { x: number; y: number });
    const box = (await page.getByTestId("tree-canvas").boundingBox())!;
    return { x: box.x + bounds.x + 80, y: box.y + bounds.y + 20 };
  };
  const camera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera());
  const point = await legendPoint();
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x - 150, point.y + 180, { steps: 10 }); await page.mouse.up();
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__!.getState().metadataLegendPlacement));
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera())).toEqual(camera);
  await page.getByRole("button", { name: "Hide side panel", exact: true }).click();
  const moved = await legendPoint();
  await page.mouse.click(moved.x, moved.y, { button: "right" });
  await page.getByRole("button", { name: "Legend settings", exact: true }).click();
  await expect(details).toBeVisible();
  await expect(details.getByRole("combobox", { name: "Legend position", exact: true })).toHaveValue("custom");
  const panel = (await page.locator(".control-panel-shell").boundingBox())!;
  const heading = (await details.boundingBox())!;
  expect(heading.y).toBeGreaterThanOrEqual(panel.y);
  expect(heading.y).toBeLessThan(panel.y + panel.height);
  const current = await legendPoint();
  await page.mouse.click(current.x, current.y, { button: "right" });
  await page.getByRole("button", { name: "Hide legend", exact: true }).click();
  await expect(page.getByLabel("Show metadata legend", { exact: true })).not.toBeChecked();
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().metadataEnabled)).toBe(true);
});
