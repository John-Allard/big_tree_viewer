import { expect, test, type Page } from "@playwright/test";

const newick = "((A_a:1,B_b:1)AB:1,(C_c:1,D_d:1)CD:1)Root;";
const columns = ["name", "country", "date", "trait_a", "trait_b", "trait_c", "trait_d", "trait_e", "trait_f", "family"];
const csv = [columns.join(","), ...["A_a", "B_b", "C_c", "D_d"].map((name, i) =>
  [name, i < 2 ? "France" : "Canada", `202${i}-01-01`, i + 1, i + 2, i + 3, i + 4, i + 5, i + 6, i < 2 ? "Alpha" : "Beta"].join(","))].join("\n");

async function openPanel(page: Page, name: string) {
  const toggle = page.locator(".panel-section .section-toggle").filter({ hasText: name }).first();
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

async function load(page: Page) {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.evaluate(payload => window.postMessage({ type: "big-tree-viewer:load", payload }, "*"), {
    newick, metadata: { text: csv, keyColumn: "name", enabled: false },
    visual: { viewMode: "rectangular", metadataTipTableEnabled: true,
      metadataTipTableMode: "heatmap", metadataTipTableColumns: columns.filter(c => c.startsWith("trait_")).map(column => ({ column, label: column })) },
  });
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataTipTableMatchedTipCount === 4);
  await openPanel(page, "Metadata");
}

for (const width of [1280, 390]) {
  test(`metadata settings are contextual and scroll normally at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await load(page);
    await expect(page.getByText("Matched rows: 4", { exact: true })).toHaveCount(1);
    await page.getByLabel("Show metadata legend", { exact: true }).check();
    await page.getByRole("button", { name: "Metadata legend settings", exact: true }).click();
    await expect(page.getByText("No active legend entries.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close Metadata legend settings", exact: true }).click();
    await page.getByRole("button", { name: "Tip data table settings", exact: true }).click();
    const list = page.getByTestId("metadata-tip-table-columns");
    expect(await list.evaluate(el => getComputedStyle(el).overflowY)).toBe("visible");
    await page.getByRole("combobox", { name: "Display", exact: true }).selectOption("bars");
    await expect(page.getByRole("combobox", { name: "Add column", exact: true })).toHaveCount(0);
    await expect(list.locator(".metadata-tip-table-column")).toHaveCount(1);
    await page.getByRole("combobox", { name: "Bar data column", exact: true }).selectOption("trait_b");
    await expect(page.getByRole("textbox", { name: "Display label for trait_b", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move trait_b left", exact: true })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Display", exact: true }).selectOption("heatmap");
    await expect(list.locator(".metadata-tip-table-column")).toHaveCount(6);
    await expect(page.getByRole("textbox", { name: "Display label for trait_b", exact: true })).toHaveValue("trait_b");
    const last = page.getByRole("textbox", { name: "Display label for trait_f", exact: true });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`table-settings-${width}.png`) });
    await page.getByRole("button", { name: "Close Tip data table settings", exact: true }).click();

    await page.getByLabel("Enable metadata branch colors", { exact: true }).check();
    await page.getByRole("button", { name: "Metadata branch colors settings", exact: true }).click();
    await page.getByRole("combobox", { name: "Color by column", exact: true }).selectOption("date");
    await expect(page.getByRole("combobox", { name: "Color mode", exact: true })).toHaveValue("date");
    await expect(page.getByPlaceholder("YYYY-MM-DD (auto)")).toHaveCount(2);
    await expect(page.getByRole("combobox", { name: "Transform", exact: true })).toHaveCount(0);
    await page.getByLabel("Clamp maximum", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`date-settings-${width}.png`) });
    await page.getByRole("button", { name: "Close Metadata branch colors settings", exact: true }).click();
    await openPanel(page, "Taxonomy");
    const custom = page.locator(".metadata-disclosure > summary");
    await custom.click();
    expect(await custom.evaluate(el => getComputedStyle(el).listStyleType)).toBe("none");
    expect((await custom.locator("svg").boundingBox())!.width).toBe(12);
    await page.getByRole("combobox", { name: "Family column", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`custom-taxonomy-${width}.png`) });
  });
}

test("comparison disables metadata displays without discarding the settings", async ({ page }) => {
  await load(page);
  await page.getByLabel("Enable metadata branch colors", { exact: true }).check();
  await openPanel(page, "Tree Comparison");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open Comparison Tree", exact: true }).click();
  await (await chooser).setFiles({ name: "comparison.nwk", mimeType: "text/plain", buffer: Buffer.from(newick) });
  await page.getByRole("button", { name: "Turn Off Comparison", exact: true }).waitFor();
  await expect(page.getByLabel("Enable metadata branch colors", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Show tip data table", { exact: true })).toBeDisabled();
  await expect(page.getByText("Metadata displays are unavailable during tree comparison. Your settings are retained.", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Turn Off Comparison", exact: true }).click();
  await expect(page.getByLabel("Enable metadata branch colors", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Enable metadata branch colors", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("Show tip data table", { exact: true })).toBeChecked();
});

test("metadata text, marker, and pie details remain usable on mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page);
  const displays = [
    { toggle: "Show metadata text labels", title: "Metadata text labels", column: "Text label column", value: "country", last: "Metadata label Y offset" },
    { toggle: "Show metadata markers", title: "Metadata markers", column: "Marker category column", value: "country", last: "Marker size" },
    { toggle: "Show metadata pie charts", title: "Metadata pie charts", column: "First pie column", value: "trait_a", last: "Pie size" },
  ];
  for (const display of displays) {
    await page.getByLabel(display.toggle, { exact: true }).check();
    await page.getByRole("button", { name: `${display.title} settings`, exact: true }).click();
    await page.getByRole("combobox", { name: display.column, exact: true }).selectOption(display.value);
    if (display.title === "Metadata pie charts") await page.getByRole("combobox", { name: "Last pie column", exact: true }).selectOption("trait_b");
    await page.getByLabel(display.last, { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByLabel(display.last, { exact: true })).toBeInViewport();
    if (display.title === "Metadata markers") await page.getByLabel("Set metadata marker shape for Canada", { exact: true }).scrollIntoViewIfNeeded();
    if (display.title === "Metadata pie charts") await page.getByLabel("Set metadata pie color for trait_b", { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${display.title.replaceAll(" ", "-")}.png`) });
    await page.getByRole("button", { name: `Close ${display.title} settings`, exact: true }).click();
  }
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataLabeledNodeCount)).toBe(4);
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataMarkedNodeCount)).toBe(4);
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataPieNodeCount)).toBe(4);
});
