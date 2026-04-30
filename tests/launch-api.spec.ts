import { expect, test, type Page } from "@playwright/test";

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function waitForLoadedTree(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && !Boolean(state?.loading);
  });
}

test("spiral view option stays hidden on ordinary page load until the shortcut is pressed", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await expect(page.getByRole("button", { name: "Spiral" })).toHaveCount(0);

  await page.keyboard.down("Shift");
  await page.keyboard.down("S");
  await page.keyboard.down("P");
  await page.keyboard.up("P");
  await page.keyboard.up("S");
  await page.keyboard.up("Shift");

  await expect(page.getByRole("button", { name: "Spiral" })).toBeVisible();
});

test("URL launch parameters load a tree, metadata, and selected visual options", async ({ page }) => {
  const newick = "((Alpha_one:1,Beta_two:1)CladeOne:1,Gamma_three:2)Root;";
  const metadata = "name,group,label,marker\nAlpha_one,A,Alpha label,circle\nBeta_two,B,Beta label,square\n";
  const params = new URLSearchParams({
    btv_newick_b64: toBase64Url(newick),
    btv_label: "url-launch-tree",
    btv_metadata_b64: toBase64Url(metadata),
    btv_metadata_key: "name",
    btv_metadata_value: "group",
    btv_metadata_color_mode: "categorical",
    btv_metadata_labels: "true",
    btv_metadata_label_column: "label",
    btv_metadata_markers: "true",
    btv_metadata_marker_column: "marker",
    btv_view: "circular",
    btv_tip_labels: "false",
    btv_genus_labels: "true",
    btv_taxonomy: "false",
    btv_branch_thickness: "1.75",
  });

  await page.goto(`/?${params.toString()}`);
  await waitForLoadedTree(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataMatchedRowCount === 2);

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null);
  expect(state?.viewMode).toBe("circular");
  expect(state?.showTipLabels).toBe(false);
  expect(state?.showGenusLabels).toBe(true);
  expect(state?.branchThicknessScale).toBeCloseTo(1.75);
  expect(state?.taxonomyEnabled).toBe(false);
  expect(state?.metadataRowCount).toBe(2);
  expect(state?.metadataKeyColumn).toBe("name");
  expect(state?.metadataValueColumn).toBe("group");
  expect(state?.metadataColorMode).toBe("categorical");
  expect(state?.metadataLabelsEnabled).toBe(true);
  expect(state?.metadataLabelColumn).toBe("label");
  expect(state?.metadataMarkersEnabled).toBe(true);
  expect(state?.metadataMarkerColumn).toBe("marker");
  expect(state?.metadataMatchedRowCount).toBe(2);
});

test("postMessage launch API can load a payload after opening an empty viewer", async ({ page }) => {
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));

  await page.evaluate(() => {
    window.postMessage({
      type: "big-tree-viewer:load",
      payload: {
        newick: "(A_species:1,B_species:1)Root;",
        label: "message-launch-tree",
        visual: {
          viewMode: "rectangular",
          showTipLabels: true,
          showGenusLabels: false,
          timeAxisScale: "log",
          timeAxisLogBase: 4,
        },
        metadata: {
          text: "name,score\nA_species,10.5\nB_species,20.75\n",
          keyColumn: "name",
          valueColumn: "score",
          colorMode: "continuous",
          enabled: true,
        },
      },
    }, "*");
  });

  await waitForLoadedTree(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().metadataMatchedRowCount === 2);

  const state = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState() ?? null);
  expect(state?.viewMode).toBe("rectangular");
  expect(state?.showTipLabels).toBe(true);
  expect(state?.showGenusLabels).toBe(false);
  expect(state?.timeAxisScale).toBe("log");
  expect(state?.metadataColorMode).toBe("continuous");
  expect(state?.metadataMatchedRowCount).toBe(2);
});
