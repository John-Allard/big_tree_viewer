import { expect, test, type Page } from "@playwright/test";

async function waitForViewer(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => {
    return Boolean(
      window.__BIG_TREE_VIEWER_APP_TEST__
      && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded,
    );
  });
}

test("quoted Newick labels parse correctly", async ({ page }) => {
  await waitForViewer(page);
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(
    "(\"Alpha beta\":1,(\"Gamma delta\":2,\"Delta epsilon\":3)\"Inner Node\":4)Root;",
  );
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    const names = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? [];
    return names.includes("Alpha beta") && names.includes("Inner Node");
  });

  const names = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? []);
  expect(names).toContain("Alpha beta");
  expect(names).toContain("Gamma delta");
  expect(names).toContain("Delta epsilon");
  expect(names).toContain("Inner Node");
});

test("NEXUS translate handles quoted labels, commas, and utree declarations", async ({ page }) => {
  await waitForViewer(page);
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(`#NEXUS
begin trees;
  translate
    1 'Alpha beta',
    2 Gamma,
    3 'Delta, epsilon';
  utree * sample = [&R] (1:1,(2:2,3:3)'Inner Node':4)Root;
end;`);
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    const names = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? [];
    return names.includes("Alpha beta") && names.includes("Delta, epsilon");
  });

  const names = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? []);
  expect(names).toContain("Alpha beta");
  expect(names).toContain("Gamma");
  expect(names).toContain("Delta, epsilon");
  expect(names).toContain("Inner Node");
});

test("multi-tree NEXUS prefers the starred default tree statement", async ({ page }) => {
  await waitForViewer(page);
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(`#NEXUS
begin trees;
  translate
    1 Alpha,
    2 Beta,
    3 Gamma,
    4 Delta;
  tree ignored = ((1:1,2:1)WrongInner:1,(3:1,4:1)WrongOther:1)WrongRoot;
  tree * chosen = ((1:1,3:1)ChosenInner:1,(2:1,4:1)ChosenOther:1)ChosenRoot;
end;`);
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    const names = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? [];
    return names.includes("ChosenRoot") && names.includes("ChosenInner");
  });

  const names = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? []);
  expect(names).toContain("ChosenRoot");
  expect(names).toContain("ChosenInner");
  expect(names).not.toContain("WrongRoot");
});

test("multi-block NEXUS can load a later starred default tree block", async ({ page }) => {
  await waitForViewer(page);
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(`#NEXUS
begin trees;
  tree first = (A:1,B:1)FirstRoot;
end;
begin trees;
  tree * second = (C:1,D:1)SecondRoot;
end;`);
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    const names = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? [];
    return names.includes("SecondRoot");
  });

  const names = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? []);
  expect(names).toContain("SecondRoot");
  expect(names).not.toContain("FirstRoot");
});

test("tree files are selected by content and BEAST NEXUS annotations are retained", async ({ page }) => {
  await waitForViewer(page);
  const treeInput = page.locator('input[type="file"]').first();
  await expect(treeInput).not.toHaveAttribute("accept", /.+/);

  await treeInput.setInputFiles({
    name: "analysis.mcc",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(`#NEXUS
begin trees;
  translate
    1 'Alpha beta',
    2 Gamma,
    3 Delta,
    4 Epsilon;
  tree MCC = [&R] ((1:1,2:1)[&posterior=0.97,height_95%_HPD={0.6,0.8}]:1,(3:1,4:1)[&support=88,length_95%_HPD={0.2,0.4}]:1)[&posterior=1.0];
end;`),
  });

  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const names = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? [];
    return !state?.loading && names.includes("Alpha beta") && names.includes("0.97");
  });

  const result = await page.evaluate(() => ({
    names: window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names ?? [],
    intervalCount: window.__BIG_TREE_VIEWER_APP_TEST__?.getState().nodeIntervalCount ?? 0,
  }));
  expect(result.names).toContain("Alpha beta");
  expect(result.names).toContain("Gamma");
  expect(result.names).toContain("0.97");
  expect(result.names).toContain("88");
  expect(result.intervalCount).toBeGreaterThanOrEqual(2);
});
