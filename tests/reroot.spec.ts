import { expect, test, type Page } from "@playwright/test";

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => {
    return Boolean(
      window.__BIG_TREE_VIEWER_APP_TEST__
      && window.__BIG_TREE_VIEWER_CANVAS_TEST__
      && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded,
    );
  });
}

async function loadSmallTree(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("((A:1,B:1)X:1,(C:1,D:1)Y:1)Root;");
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    return Array.isArray(internal?.names) && internal.names.includes("A") && internal.names.includes("B") && internal.names.includes("Root");
  });
}

test("reroot on branch splits the selected branch length at the midpoint", async ({ page }) => {
  await waitForViewer(page);
  await loadSmallTree(page);
  const initialSignature = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState()?.treeSignature ?? null);

  await page.evaluate(() => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const names = internal?.names ?? [];
    const node = names.indexOf("B");
    if (node < 0) {
      throw new Error("Target tip unavailable for reroot test.");
    }
    window.__BIG_TREE_VIEWER_APP_TEST__?.rerootOnNodeForTest(node, "branch");
  });
  await page.waitForFunction((priorSignature) => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return typeof state?.treeSignature === "string" && state.treeSignature !== priorSignature && state.treeSignature.includes(":reroot:");
  }, initialSignature);

  const result = await page.evaluate(() => {
    const nextInternal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const root = (nextInternal?.parent ?? []).findIndex((value) => value < 0);
    if (root < 0) {
      throw new Error("Rerooted root unavailable.");
    }
    const payload = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildSharedSubtreePayloadForTest(root);
    return {
      state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState(),
      newick: String(payload?.newick ?? ""),
    };
  }) as { state?: { loadError?: string | null }; newick: string };

  expect(result.state?.loadError ?? null).toBeNull();
  expect(result.newick).toContain("A");
  expect(result.newick).toContain("B:0.5");
  expect(result.newick).toContain("C");
  expect(result.newick).toContain("D");
});
