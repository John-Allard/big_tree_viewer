import { expect, test, type Page } from "@playwright/test";

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(
    window.__BIG_TREE_VIEWER_APP_TEST__
    && window.__BIG_TREE_VIEWER_CANVAS_TEST__
    && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded,
  ));
}

test("homonymous taxonomy labels with different taxids get distinct branch colors", async ({ page }) => {
  await waitForViewer(page);
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(
    "((A_primate:1,B_primate:1)P:1,(A_plant:1,B_plant:1)Q:1)Root;",
  );
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && !state?.loading;
  });

  const colors = await page.evaluate(async () => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const names = internal?.names ?? [];
    const leafNodes = internal?.leafNodes ?? [];
    const byName = new Map<string, number>();
    for (let index = 0; index < leafNodes.length; index += 1) {
      byName.set(String(names[leafNodes[index]] ?? ""), leafNodes[index]);
    }
    const primateA = byName.get("A_primate");
    const primateB = byName.get("B_primate");
    const plantA = byName.get("A_plant");
    const plantB = byName.get("B_plant");
    if (
      primateA === undefined
      || primateB === undefined
      || plantA === undefined
      || plantB === undefined
    ) {
      throw new Error("Synthetic tree tips not found.");
    }
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      mappedCount: 4,
      totalTips: 4,
      activeRanks: ["genus", "family", "order", "class", "phylum"],
      tipRanks: [
        {
          node: primateA,
          ranks: {
            genus: "Aotus",
            family: "Aotidae",
            order: "Primates",
            class: "Mammalia",
            phylum: "Chordata",
          },
          taxIds: {
            genus: 101,
            family: 1001,
            order: 10001,
            class: 100001,
            phylum: 1000001,
          },
        },
        {
          node: primateB,
          ranks: {
            genus: "Aotus",
            family: "Aotidae",
            order: "Primates",
            class: "Mammalia",
            phylum: "Chordata",
          },
          taxIds: {
            genus: 101,
            family: 1001,
            order: 10001,
            class: 100001,
            phylum: 1000001,
          },
        },
        {
          node: plantA,
          ranks: {
            genus: "Aotus",
            family: "Fabaceae",
            order: "Fabales",
            class: "Magnoliopsida",
            phylum: "Streptophyta",
          },
          taxIds: {
            genus: 202,
            family: 2002,
            order: 20002,
            class: 200002,
            phylum: 2000002,
          },
        },
        {
          node: plantB,
          ranks: {
            genus: "Aotus",
            family: "Fabaceae",
            order: "Fabales",
            class: "Magnoliopsida",
            phylum: "Streptophyta",
          },
          taxIds: {
            genus: 202,
            family: 2002,
            order: 20002,
            class: 200002,
            phylum: 2000002,
          },
        },
      ],
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyBranchColoringEnabled(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyRankVisibilityAutoForTest(false);
    for (const rank of ["phylum", "class", "order", "family", "genus"] as const) {
      window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyRankVisibilityForTest(rank, rank === "genus");
    }
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const branchColors = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors();
    if (!branchColors) {
      throw new Error("Branch colors unavailable.");
    }
    return {
      primateA: branchColors[primateA],
      primateB: branchColors[primateB],
      plantA: branchColors[plantA],
      plantB: branchColors[plantB],
    };
  });

  expect(colors.primateA).toBe(colors.primateB);
  expect(colors.plantA).toBe(colors.plantB);
  expect(colors.primateA).not.toBe(colors.plantA);
});
