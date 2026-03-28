import { expect, test, type Page } from "@playwright/test";

async function waitForViewerReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    return Boolean(
      window.__BIG_TREE_VIEWER_APP_TEST__
      && window.__BIG_TREE_VIEWER_CANVAS_TEST__
      && window.__BIG_TREE_VIEWER_RENDER_DEBUG__
      && window.__BIG_TREE_VIEWER_APP_TEST__.getState().treeLoaded,
    );
  });
}

test("iphone safari completes taxonomy mapping and keeps the viewer alive", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "Safari-focused coverage only runs on WebKit.");
  test.setTimeout(240000);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let pageCrashed = false;

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("crash", () => {
    pageCrashed = true;
  });

  await page.goto("/");
  await waitForViewerReady(page);

  const initialState = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState());

  if (!initialState?.taxonomyCached) {
    await page.evaluate(() => {
      void window.__BIG_TREE_VIEWER_APP_TEST__?.downloadTaxonomyForTest();
    });
    await page.waitForFunction(() => {
      const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
      return Boolean(state?.taxonomyCached) || Boolean(state?.taxonomyError);
    }, { timeout: 120000 });
  }

  await page.evaluate(() => {
    void window.__BIG_TREE_VIEWER_APP_TEST__?.runTaxonomyMappingForTest();
  });

  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return (
      (Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount ?? 0) > 0)
      || Boolean(state?.taxonomyError)
    );
  }, { timeout: 120000 });

  await page.evaluate(async () => {
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const state = await page.evaluate(() => {
    const appState = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const rectDebug = window.__BIG_TREE_VIEWER_RENDER_DEBUG__?.rect as {
      taxonomyVisibleRanks?: string[];
      branchRenderMode?: string;
      taxonomyConnectorSegmentCount?: number;
    } | undefined;
    return {
      taxonomyEnabled: appState?.taxonomyEnabled ?? false,
      taxonomyMappedCount: Number(appState?.taxonomyMappedCount ?? 0),
      loadError: appState?.loadError ?? null,
      taxonomyStatus: appState?.taxonomyStatus ?? "",
      taxonomyError: appState?.taxonomyError ?? null,
      taxonomyCached: appState?.taxonomyCached ?? null,
      taxonomyLoading: appState?.taxonomyLoading ?? false,
      rectDebug,
    };
  });

  expect(pageCrashed, `page crashed; page errors: ${pageErrors.join(" | ")}; console errors: ${consoleErrors.join(" | ")}`).toBe(false);
  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  expect(state.loadError).toBeNull();
  expect(state.taxonomyError, `taxonomy error: ${state.taxonomyError}; status: ${state.taxonomyStatus}; cached: ${state.taxonomyCached}; loading: ${state.taxonomyLoading}; console errors: ${consoleErrors.join(" | ")}`).toBeNull();
  expect(state.taxonomyEnabled).toBe(true);
  expect(state.taxonomyMappedCount).toBeGreaterThan(0);
  expect(state.rectDebug?.taxonomyVisibleRanks ?? []).toContain("class");
  expect(["taxonomy-cached-bitmap", "taxonomy-cached-paths"]).toContain(state.rectDebug?.branchRenderMode ?? "");
  expect(Number(state.rectDebug?.taxonomyConnectorSegmentCount ?? 0)).toBeGreaterThan(0);
});
