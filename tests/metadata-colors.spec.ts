import { expect, test, type Page } from "@playwright/test";

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => {
    return Boolean(
      window.__BIG_TREE_VIEWER_APP_TEST__
      && window.__BIG_TREE_VIEWER_CANVAS_TEST__
      && window.__BIG_TREE_VIEWER_RENDER_DEBUG__
      && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded,
    );
  });
}

async function loadLabeledTree(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill("((A:1,B:1)CladeOne:1,(C:1,D:1)CladeTwo:1)Root;");
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    return Array.isArray(internal?.names) && internal.names.includes("CladeOne") && internal.names.includes("CladeTwo");
  });
}

test("categorical metadata colors matched tip branches", async ({ page }) => {
  await waitForViewer(page);
  const sample = await page.evaluate(() => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const leafNodes = internal?.leafNodes ?? [];
    const names = internal?.names ?? [];
    if (leafNodes.length < 3) {
      throw new Error("Not enough leaf nodes for metadata tip-color test.");
    }
    const chosen = leafNodes.slice(0, 3).map((node) => ({ node, name: names[node] ?? "" }));
    if (chosen.some((entry) => !entry.name)) {
      throw new Error("Missing tip names for metadata tip-color test.");
    }
    return chosen;
  });
  await page.evaluate((chosen) => {
    const csv = `name,group\n"${chosen[0].name}",Alpha\n"${chosen[1].name}",Alpha\n"${chosen[2].name}",Beta\n`;
    window.__BIG_TREE_VIEWER_APP_TEST__?.importMetadataTextForTest(csv, "tip-groups.csv");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
  }, sample);
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.metadataMatchedRowCount === 3 && state?.metadataColoredNodeCount === 3;
  });
  const result = await page.evaluate(() => ({
    state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState(),
    colors: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors() ?? [],
  }));

  expect(result.state?.metadataMatchedRowCount).toBe(3);
  expect(result.state?.metadataColoredNodeCount).toBe(3);
  expect(result.colors[sample[0].node]).toBe(result.colors[sample[1].node]);
  expect(result.colors[sample[0].node]).not.toBe("#0f172a");
  expect(result.colors[sample[2].node]).not.toBe(result.colors[sample[0].node]);
});

test("metadata can color subtree matches keyed by internal node labels", async ({ page }) => {
  await waitForViewer(page);
  await loadLabeledTree(page);
  const result = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.importMetadataTextForTest("label,group\nCladeOne,Alpha\nCladeTwo,Beta\n", "clades.csv");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMetadataApplyScope("subtree");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const names = internal?.names ?? [];
    const firstChild = internal?.firstChild ?? [];
    const nextSibling = internal?.nextSibling ?? [];
    const cladeOne = names.indexOf("CladeOne");
    const cladeTwo = names.indexOf("CladeTwo");
    const firstLeaf = (node: number): number => {
      let current = node;
      while ((firstChild[current] ?? -1) >= 0) {
        current = firstChild[current];
      }
      return current;
    };
    const secondLeaf = (node: number): number => {
      const child = firstChild[node];
      const sibling = typeof child === "number" ? nextSibling[child] : -1;
      let current = sibling;
      while (typeof current === "number" && current >= 0 && (firstChild[current] ?? -1) >= 0) {
        current = firstChild[current];
      }
      return current ?? -1;
    };
    return {
      state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState(),
      cladeOne,
      cladeTwo,
      cladeOneLeafA: firstLeaf(cladeOne),
      cladeOneLeafB: secondLeaf(cladeOne),
      cladeTwoLeafA: firstLeaf(cladeTwo),
      colors: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors() ?? [],
    };
  });

  expect(result.state?.metadataApplyScope).toBe("subtree");
  expect(result.state?.metadataMatchedRowCount).toBe(2);
  expect(result.colors[result.cladeOne]).toBe(result.colors[result.cladeOneLeafA]);
  expect(result.colors[result.cladeOneLeafA]).toBe(result.colors[result.cladeOneLeafB]);
  expect(result.colors[result.cladeTwoLeafA]).not.toBe(result.colors[result.cladeOneLeafA]);
});

test("continuous metadata mapping shows a gradient legend and distinct colors", async ({ page }) => {
  await waitForViewer(page);
  const sample = await page.evaluate(() => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const leafNodes = internal?.leafNodes ?? [];
    const names = internal?.names ?? [];
    if (leafNodes.length < 3) {
      throw new Error("Not enough leaf nodes for metadata gradient test.");
    }
    return leafNodes.slice(0, 3).map((node) => ({ node, name: names[node] ?? "" }));
  });
  await page.getByRole("button", { name: /Metadata/ }).click();
  await page.evaluate((chosen) => {
    const csv = `name,score\n"${chosen[0].name}",0\n"${chosen[1].name}",10\n"${chosen[2].name}",20\n`;
    window.__BIG_TREE_VIEWER_APP_TEST__?.importMetadataTextForTest(csv, "scores.csv");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
  }, sample);
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.metadataColorMode === "continuous" && state?.metadataMatchedRowCount === 3;
  });
  const result = await page.evaluate(() => ({
    state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState(),
    colors: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors() ?? [],
  }));

  expect(result.state?.metadataColorMode).toBe("continuous");
  await expect(page.getByTestId("metadata-gradient-legend")).toBeVisible();
  expect(result.colors[sample[0].node]).not.toBe(result.colors[sample[2].node]);
});

test("continuous metadata controls support palette, transform, and clamp settings", async ({ page }) => {
  await waitForViewer(page);
  const sample = await page.evaluate(() => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const leafNodes = internal?.leafNodes ?? [];
    const names = internal?.names ?? [];
    if (leafNodes.length < 3) {
      throw new Error("Not enough leaf nodes for metadata continuous controls test.");
    }
    return leafNodes.slice(0, 3).map((node) => ({ node, name: names[node] ?? "" }));
  });
  await page.evaluate((chosen) => {
    const csv = `name,score\n"${chosen[0].name}",-100\n"${chosen[1].name}",0\n"${chosen[2].name}",100\n`;
    window.__BIG_TREE_VIEWER_APP_TEST__?.importMetadataTextForTest(csv, "signed-scores.csv");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMetadataContinuousPalette("viridis");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMetadataContinuousTransform("sqrt");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMetadataContinuousMinInput("-25");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMetadataContinuousMaxInput("25");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
  }, sample);
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.metadataContinuousPalette === "viridis" && state?.metadataContinuousTransform === "sqrt";
  });
  const result = await page.evaluate(() => ({
    state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState(),
    colors: window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors() ?? [],
  }));

  expect(result.state?.metadataContinuousMin).toBe(-25);
  expect(result.state?.metadataContinuousMax).toBe(25);
  await page.getByRole("button", { name: /Metadata/ }).click();
  await expect(page.getByTestId("metadata-gradient-legend")).toContainText("Viridis");
  await expect(page.getByTestId("metadata-gradient-legend")).toContainText("sqrt");
  expect(result.colors[sample[0].node]).not.toBe(result.colors[sample[1].node]);
  expect(result.colors[sample[2].node]).not.toBe(result.colors[sample[1].node]);
});

test("metadata labels can annotate matched nodes in SVG export", async ({ page }) => {
  await waitForViewer(page);
  await loadLabeledTree(page);
  const svg = await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.importMetadataTextForTest(
      "label,group,note\nCladeOne,Alpha,Major clade\nCladeTwo,Beta,Sister clade\n",
      "notes.csv",
    );
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMetadataApplyScope("subtree");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMetadataLabelsEnabled(true);
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMetadataLabelColumn("note");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.buildCurrentSvgForTest() ?? "";
  });

  expect(svg).toContain("Major clade");
  expect(svg).toContain("Sister clade");
});

test("metadata colors override taxonomy colors and manual colors override metadata", async ({ page }) => {
  await waitForViewer(page);
  const seed = await page.evaluate(async () => {
    const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__;
    const leafNodes = internal?.leafNodes ?? [];
    const names = internal?.names ?? [];
    const node = leafNodes[0];
    const name = names[node] ?? "";
    if (typeof node !== "number" || !name) {
      throw new Error("Leaf node unavailable for metadata precedence test.");
    }
    window.__BIG_TREE_VIEWER_APP_TEST__?.setMockTaxonomy();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const taxonomyColor = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors()?.[node] ?? null;
    return { node, name, taxonomyColor };
  });
  await page.evaluate(({ name }) => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.importMetadataTextForTest(`name,group\n"${name}",Chosen\n`, "override.csv");
  }, seed);
  await page.waitForFunction(({ node, taxonomyColor }) => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const color = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors()?.[node] ?? null;
    return state?.metadataMatchedRowCount === 1 && color !== taxonomyColor;
  }, seed);
  const result = await page.evaluate(({ node }) => {
    const metadataColor = window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors()?.[node] ?? null;
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.setManualBranchColor(node, "#dc2626");
    return {
      taxonomyColor: null,
      metadataColor,
      manualColor: null,
    };
  }, seed);
  await page.waitForFunction(({ node }) => {
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors()?.[node] === "#dc2626";
  }, seed);
  const manualColor = await page.evaluate(({ node }) => {
    return window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getCurrentBranchColors()?.[node] ?? null;
  }, seed);

  expect(seed.taxonomyColor).not.toBeNull();
  expect(result.metadataColor).not.toBe(seed.taxonomyColor);
  expect(manualColor).toBe("#dc2626");
});
