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
