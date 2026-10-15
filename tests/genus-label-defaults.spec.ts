import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const initialTree = "((Homo_sapiens:1,Homo_neanderthalensis:1):1,(Mus_musculus:1,Mus_spretus:1):1)InitialRoot;";
const newTree = "((Canis_lupus:1,Canis_latrans:1):1,('Felis catus':1,'Felis silvestris':1):1)NewRoot;";

async function dropFile(page: Page, name: string, buffer: Buffer): Promise<void> {
  const transfer = await page.evaluateHandle(({ name, base64 }) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], name));
    return data;
  }, { name, base64: buffer.toString("base64") });
  await page.locator(".app-shell").dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
}

async function openSmallTree(page: Page): Promise<void> {
  await page.goto(`/?btv_newick=${encodeURIComponent(initialTree)}&btv_view=rectangular`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: /Visual Options/ }).click();
}

for (const method of ["file drop", "text drop", "paste", "file input"] as const) {
  test(`${method} enables genus labels for a new binomial tree after taxonomy hid them`, async ({ page }) => {
    await openSmallTree(page);
    await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setMockTaxonomy());
    const checkbox = page.getByLabel("Show genus labels", { exact: true });
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeDisabled();

    if (method === "file drop") {
      await dropFile(page, "new-tree.nwk", Buffer.from(newTree));
    } else if (method === "text drop") {
      const transfer = await page.evaluateHandle(text => {
        const data = new DataTransfer();
        data.setData("text/plain", text);
        return data;
      }, newTree);
      await page.locator(".app-shell").dispatchEvent("drop", { dataTransfer: transfer });
      await transfer.dispose();
    } else if (method === "paste") {
      await page.getByRole("button", { name: "Paste Newick", exact: true }).click();
      await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(newTree);
      await page.getByRole("button", { name: "Load Pasted Tree", exact: true }).click();
    } else {
      await page.locator('input[type="file"]').first().setInputFiles({ name: "new-tree.nwk", mimeType: "text/plain", buffer: Buffer.from(newTree) });
    }
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names?.includes("NewRoot"));
    await expect(checkbox).toBeEnabled();
    await expect(checkbox).toBeChecked();
    await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()))
      .toContain(">Canis</text>");
    const svg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()!);
    expect(svg).toContain(">Felis</text>");
    await checkbox.uncheck();
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    await expect(checkbox).not.toBeChecked();
  });
}

for (const saved of [false, true]) {
  test(`dropping a session preserves its explicit genus-label setting (${saved})`, async ({ page }) => {
    await openSmallTree(page);
    await page.evaluate(() => {
      Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    });
    const checkbox = page.getByLabel("Show genus labels", { exact: true });
    await checkbox.setChecked(saved);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save Session", exact: true }).click();
    const path = (await (await downloadPromise).path())!;
    await checkbox.setChecked(!saved);
    await dropFile(page, "saved-tree.btvsession", await readFile(path));
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await expect(checkbox).toBeChecked({ checked: saved });
  });
}

test("launch options can explicitly disable genus labels for binomial tips", async ({ page }) => {
  await page.goto(`/?btv_newick=${encodeURIComponent(initialTree)}&btv_genus_labels=false`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: /Visual Options/ }).click();
  await expect(page.getByLabel("Show genus labels", { exact: true })).not.toBeChecked();
});

test("identifier-only tips do not enable genus labels", async ({ page }) => {
  await openSmallTree(page);
  await expect(page.getByLabel("Show genus labels", { exact: true })).toBeChecked();
  await dropFile(page, "identifiers.nwk", Buffer.from("(taxid=9606:1,Sequence_123:1,456:1)IdentifierRoot;"));
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names?.includes("IdentifierRoot"));
  await expect(page.getByLabel("Show genus labels", { exact: true })).not.toBeChecked();
});
