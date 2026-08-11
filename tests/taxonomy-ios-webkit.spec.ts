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

test("iphone safari taxonomy long press opens an actionable menu without page selection", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "Safari-focused coverage only runs on WebKit.");

  await page.goto("/");
  await waitForViewerReady(page);
  const target = await page.evaluate(async () => {
    const leafNodes = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes;
    if (!leafNodes || leafNodes.length < 60) {
      throw new Error("Leaf nodes unavailable for mobile taxonomy context-menu test.");
    }
    const split = Math.max(8, Math.floor(leafNodes.length * 0.2));
    window.__BIG_TREE_VIEWER_APP_TEST__?.setTaxonomyMapForTest({
      version: 906,
      mappedCount: leafNodes.length,
      totalTips: leafNodes.length,
      activeRanks: ["class"],
      tipRanks: leafNodes.map((node, index) => ({
        node,
        ranks: { class: index < split ? "Mammalia" : "Aves" },
        taxIds: { class: index < split ? 40674 : 8782 },
      })),
    });
    window.__BIG_TREE_VIEWER_APP_TEST__?.setViewMode("rectangular");
    window.__BIG_TREE_VIEWER_APP_TEST__?.setOrder("input");
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.__BIG_TREE_VIEWER_CANVAS_TEST__?.fitView();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const canvas = document.querySelector("[data-testid=tree-canvas]");
    const taxonomyHit = (window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getLabelHitboxes?.() ?? [])
      .find((hitbox) => hitbox.labelKind === "taxonomy" && hitbox.text === "Aves");
    if (!(canvas instanceof HTMLCanvasElement) || !taxonomyHit) {
      throw new Error("Mobile taxonomy label hitbox unavailable.");
    }
    const rect = canvas.getBoundingClientRect();
    return {
      clientX: rect.left + Number(taxonomyHit.x) + (Number(taxonomyHit.width) * 0.5),
      clientY: rect.top + Number(taxonomyHit.y) + (Number(taxonomyHit.height) * 0.5),
    };
  });

  await page.evaluate(({ clientX, clientY }) => {
    const canvas = document.querySelector("[data-testid=tree-canvas]");
    const panel = document.querySelector(".control-panel");
    if (!(canvas instanceof HTMLCanvasElement) || !panel) {
      throw new Error("Mobile long-press targets unavailable.");
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(panel);
    selection?.removeAllRanges();
    selection?.addRange(range);
    canvas.dispatchEvent(new PointerEvent("pointerdown", {
      pointerId: 41,
      pointerType: "touch",
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX,
      clientY,
    }));
  }, target);

  const zoomButton = page.getByRole("button", { name: "Zoom To Group MRCA" });
  await expect(zoomButton).toBeVisible({ timeout: 2000 });

  const mobileState = await page.evaluate(() => {
    const shell = document.querySelector(".tree-canvas-shell");
    const menu = document.querySelector(".tree-context-menu");
    if (!(shell instanceof HTMLElement) || !(menu instanceof HTMLElement)) {
      throw new Error("Mobile taxonomy context menu unavailable.");
    }
    const shellStyle = getComputedStyle(shell);
    const shellRect = shell.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    return {
      selectionText: window.getSelection()?.toString() ?? "",
      userSelect: shellStyle.userSelect,
      webkitUserSelect: shellStyle.webkitUserSelect,
      touchCalloutSupported: CSS.supports("-webkit-touch-callout", "none"),
      webkitTouchCallout: shellStyle.getPropertyValue("-webkit-touch-callout"),
      shellRect: {
        left: shellRect.left,
        top: shellRect.top,
        right: shellRect.right,
        bottom: shellRect.bottom,
      },
      menuRect: {
        left: menuRect.left,
        top: menuRect.top,
        right: menuRect.right,
        bottom: menuRect.bottom,
      },
      menuContained: (
        menuRect.left >= shellRect.left - 1
        && menuRect.top >= shellRect.top - 1
        && menuRect.right <= shellRect.right + 1
        && menuRect.bottom <= shellRect.bottom + 1
      ),
    };
  });

  expect(mobileState.selectionText).toBe("");
  expect([mobileState.userSelect, mobileState.webkitUserSelect]).toContain("none");
  if (mobileState.touchCalloutSupported) {
    expect(mobileState.webkitTouchCallout).toBe("none");
  }
  expect(mobileState.menuContained, JSON.stringify(mobileState)).toBe(true);

  await zoomButton.tap();
  await expect(page.locator(".tree-context-menu")).toBeHidden();
});
