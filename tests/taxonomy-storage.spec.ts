import { expect, test, type Page } from "@playwright/test";

const taxonomyUrl = "https://ftp.ncbi.nlm.nih.gov/pub/taxonomy/taxdmp.zip";

async function waitForTaxonomyCheck(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyCached !== null);
  const closeTutorial = page.getByRole("button", { name: "Close tutorial prompt" });
  if (await closeTutorial.isVisible()) {
    await closeTutorial.click();
  }
  await page.getByRole("button", { name: "Taxonomy" }).click();
}

async function browserCacheContainsArchive(page: Page): Promise<boolean> {
  return await page.evaluate(async () => await new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open("big-tree-viewer-taxonomy", 3);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("archives", "readonly");
      const getRequest = transaction.objectStore("archives").get("ncbi-taxdmp-zip");
      getRequest.onerror = () => reject(getRequest.error);
      getRequest.onsuccess = () => resolve(getRequest.result !== undefined);
      transaction.oncomplete = () => db.close();
    };
  }));
}

test("taxonomy setup offers one download action and a quiet existing-file alternative", async ({ page }) => {
  let downloadRequested = false;
  await page.route(taxonomyUrl, async (route) => {
    downloadRequested = true;
    await route.abort();
  });
  await waitForTaxonomyCheck(page);

  await expect(page.getByRole("button", { name: "Download Taxonomy" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Already have taxdmp.zip? Choose it" })).toBeVisible();
  expect(downloadRequested).toBe(false);
});

test("canceling the fallback picker does not block a subsequent taxonomy download", async ({ page }) => {
  await page.route(taxonomyUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/zip",
      body: "PK\u0003\u0004test-taxonomy",
    });
  });
  await waitForTaxonomyCheck(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true);
  await page.evaluate(() => {
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: undefined });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    const nativeInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function click(): void {
      if (this.type === "file") {
        window.setTimeout(() => this.dispatchEvent(new Event("cancel")), 0);
        return;
      }
      nativeInputClick.call(this);
    };
  });

  await page.getByRole("button", { name: "Already have taxdmp.zip? Choose it" }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyLoading === false);

  await expect(page.getByRole("button", { name: "Download Taxonomy" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Already have taxdmp.zip? Choose it" })).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Taxonomy" }).click();
  await downloadPromise;
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.taxonomyCached === true && state?.taxonomyLoading === false;
  });
  await expect(page.getByRole("button", { name: "Run Taxonomy Mapping" })).toBeEnabled();
});

test("canceling the native existing-file picker restores taxonomy controls", async ({ page }) => {
  await waitForTaxonomyCheck(page);
  await page.evaluate(() => {
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true,
      value: async () => {
        throw new DOMException("The user aborted a request.", "AbortError");
      },
    });
  });

  await page.getByRole("button", { name: "Already have taxdmp.zip? Choose it" }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyLoading === false);

  await expect(page.getByRole("button", { name: "Download Taxonomy" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Already have taxdmp.zip? Choose it" })).toBeEnabled();
});

test("selecting an existing taxonomy file does not request another archive", async ({ page }) => {
  let downloadRequested = false;
  await page.route(taxonomyUrl, async (route) => {
    downloadRequested = true;
    await route.abort();
  });
  await waitForTaxonomyCheck(page);
  await page.evaluate(() => {
    const pickerWindow = window as Window & {
      showOpenFilePicker?: (options: unknown) => Promise<Array<{
        kind: "file";
        name: string;
        getFile: () => Promise<File>;
      }>>;
    };
    Object.defineProperty(pickerWindow, "showOpenFilePicker", {
      configurable: true,
      value: async () => [{
        kind: "file",
        name: "taxdmp.zip",
        getFile: async () => new File(["PK\u0003\u0004test-taxonomy"], "taxdmp.zip", { type: "application/zip" }),
      }],
    });
  });

  await page.getByRole("button", { name: "Already have taxdmp.zip? Choose it" }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyCached === true);

  await expect(page.getByText("Taxonomy data is ready.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run Taxonomy Mapping" })).toBeVisible();
  expect(downloadRequested).toBe(false);
  expect(await browserCacheContainsArchive(page)).toBe(false);
});

test("a retained taxonomy file handle is reused after reload", async ({ page }) => {
  let downloadRequested = false;
  await page.route(taxonomyUrl, async (route) => {
    downloadRequested = true;
    await route.abort();
  });
  await waitForTaxonomyCheck(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("taxdmp.zip", { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Blob(["PK\u0003\u0004linked-taxonomy"], { type: "application/zip" }));
    await writable.close();
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true,
      value: async () => [handle],
    });
  });

  await page.getByRole("button", { name: "Already have taxdmp.zip? Choose it" }).click();
  await expect(page.getByText("Taxonomy data is ready.")).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyCached === true);
  const taxonomyToggle = page.locator("button.section-toggle").filter({ hasText: "Taxonomy" });
  if (await taxonomyToggle.getAttribute("aria-expanded") !== "true") {
    await taxonomyToggle.click();
  }

  await expect(page.getByText("Taxonomy data is ready.")).toBeVisible();
  expect(downloadRequested).toBe(false);
  expect(await browserCacheContainsArchive(page)).toBe(false);
});

test("explicit fallback download saves a file without creating a hidden archive copy", async ({ page }) => {
  let downloadRequests = 0;
  await page.route(taxonomyUrl, async (route) => {
    downloadRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/zip",
      body: "PK\u0003\u0004test-taxonomy",
    });
  });
  await waitForTaxonomyCheck(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true);
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Taxonomy" }).click();
  const download = await downloadPromise;
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.taxonomyCached === true && state?.taxonomyLoading === false;
  });

  expect(download.suggestedFilename()).toBe("taxdmp.zip");
  expect(downloadRequests).toBe(1);
  expect(await browserCacheContainsArchive(page)).toBe(false);
  await expect(page.getByRole("button", { name: "Run Taxonomy Mapping" })).toBeEnabled();
  await expect(page.getByText("Select that saved file next time", { exact: false })).toBeVisible();
});

test("native taxonomy download enables mapping and retains the saved file", async ({ page }) => {
  await page.route(taxonomyUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/zip",
      body: "PK\u0003\u0004test-taxonomy",
    });
  });
  await waitForTaxonomyCheck(page);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("taxdmp.zip", { create: true });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async () => handle,
    });
  });

  await page.getByRole("button", { name: "Download Taxonomy" }).click();
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.taxonomyCached === true && state?.taxonomyLoading === false;
  });

  await expect(page.getByRole("button", { name: "Run Taxonomy Mapping" })).toBeEnabled();
  expect(await browserCacheContainsArchive(page)).toBe(false);
});

test("an existing legacy browser archive is detected without a download prompt", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("big-tree-viewer-taxonomy", 3);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("archives", "readwrite");
      transaction.objectStore("archives").put(
        new Blob(["PK\u0003\u0004cached-taxonomy"], { type: "application/zip" }),
        "ncbi-taxdmp-zip",
      );
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
    };
  }));
  await page.reload();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyCached === true);
  const closeTutorial = page.getByRole("button", { name: "Close tutorial prompt" });
  if (await closeTutorial.isVisible()) {
    await closeTutorial.click();
  }
  await page.getByRole("button", { name: "Taxonomy" }).click();

  await expect(page.getByText("Taxonomy data is ready.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run Taxonomy Mapping" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download Taxonomy" })).toHaveCount(0);
  expect(await browserCacheContainsArchive(page)).toBe(true);
});
