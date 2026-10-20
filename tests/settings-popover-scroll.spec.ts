import { expect, test } from "@playwright/test";

const newick = "((Homo_sapiens:1,Homo_neanderthalensis:1):1,(Mus_musculus:1,Mus_spretus:1):1)Root;";

for (const width of [1100, 390]) {
  for (const title of ["Tip labels", "Scale labels", "Taxonomy overlays", "Cladogram"]) {
    test(`${title} details scroll with the sidebar at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=rectangular`);
      await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
      await page.getByRole("button", { name: /Visual Options/ }).click();
      if (title === "Taxonomy overlays") {
        await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.setMockTaxonomy());
      }
      if (title === "Cladogram") await page.getByLabel("Show cladogram", { exact: true }).check();
      await page.getByRole("button", { name: `${title} settings`, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `${title} settings`, exact: true });
      await dialog.locator(".label-style-body > :first-child").scrollIntoViewIfNeeded();
      const before = await dialog.evaluate(element => {
        const panel = element.closest<HTMLElement>(".control-panel")!;
        const body = element.querySelector<HTMLElement>(".label-style-body")!;
        const bounds = body.getBoundingClientRect();
        return {
          top: element.getBoundingClientRect().top,
          scrollTop: panel.scrollTop,
          remainingScroll: panel.scrollHeight - panel.clientHeight - panel.scrollTop,
          position: getComputedStyle(element).position,
          bodyOverflow: getComputedStyle(body).overflowY,
          bodyOverflowPx: body.scrollHeight - body.clientHeight,
          x: bounds.right - 5,
          y: Math.max(24, Math.min(innerHeight - 24, bounds.top + 5)),
          camera: window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera(),
        };
      });
      expect(before.position).toBe("absolute");
      expect(before.bodyOverflow).toBe("visible");
      expect(before.bodyOverflowPx).toBeLessThanOrEqual(1);
      expect(await dialog.evaluate((element, { x, y }) => element.contains(document.elementFromPoint(x, y)), before)).toBe(true);
      await page.mouse.move(before.x, before.y);
      const direction = before.remainingScroll > 80 ? 1 : -1;
      await page.mouse.wheel(0, direction * 180);
      await expect.poll(() => page.locator(".control-panel").evaluate((panel, before) =>
        (panel.scrollTop - before.scrollTop) * before.direction, { scrollTop: before.scrollTop, direction }))
        .toBeGreaterThan(40);
      const after = await dialog.evaluate(element => ({
        top: element.getBoundingClientRect().top,
        scrollTop: element.closest<HTMLElement>(".control-panel")!.scrollTop,
        camera: window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera(),
      }));
      expect(after.top - before.top).toBeCloseTo(before.scrollTop - after.scrollTop, 0);
      expect(after.camera).toEqual(before.camera);
      const close = page.getByRole("button", { name: `Close ${title} settings`, exact: true });
      await close.scrollIntoViewIfNeeded();
      if (title === "Scale labels" || title === "Tip labels") {
        await page.screenshot({ path: `test-results/settings-scroll-${title.replaceAll(" ", "-")}-${width}.png` });
      }
      await close.click();
      await expect(dialog).toHaveCount(0);
    });
  }
}
