import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { ULTRAMETRIC_CLADOGRAM_METHODS } from "../src/lib/cladogram";

const newick = "(((A_a:2,B_b:3)88[&height_95%_HPD={8,10}]:4,C_c:6)99:5,D_d:20)Root;";
const spiralNewick = `(${Array.from({ length: 1000 }, (_, index) => `Tip_${index}:1`).join(",")})Root;`;
const layoutLabels: Record<string, string> = {
  equal: "Standard Cladogram",
  levels: "Branching Levels",
  logarithmic: "Logarithmic Descendant Counts",
  grafen: "Grafen Descendant Counts",
};

for (const view of ["rectangular", "circular", "fan"] as const) {
  test(`${view} keeps whole-tree fit framing when enabling cladograms and changing modes`, async ({ page }) => {
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=${view}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: /Visual Options/ }).click();
    const verifyFit = async () => {
      const before = await page.evaluate(() => {
        const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
        const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!;
        const canvas = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect();
        const panelRight = document.querySelector(".control-panel")!.getBoundingClientRect().right;
        const inset = Math.max(0, panelRight - canvas.left);
        const tips = internal.leafNodes.map(node => api.getBranchScreenSegmentForTest(node)!);
        return { camera: api.getCamera()!, visible: tips.every(tip => tip.x2 >= inset - 1 && tip.x2 <= canvas.width + 1 && tip.y2 >= -1 && tip.y2 <= canvas.height + 1) };
      });
      expect(before.visible).toBe(true);
      await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.fitView());
      const fit = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera()!);
      for (const [key, value] of Object.entries(fit)) {
        if (typeof value === "number") expect((before.camera as unknown as Record<string, number>)[key], key).toBeCloseTo(value, 6);
      }
    };
    await verifyFit();
    await page.getByLabel("Show cladogram", { exact: true }).check();
    await verifyFit();
    await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
    for (const method of ["grafen", "levels", "logarithmic"] as const) {
      await page.getByRole("radio", { name: layoutLabels[method], exact: true }).check();
      await verifyFit();
      if (method === "logarithmic") {
        await page.getByRole("slider", { name: "Logarithmic strength" }).fill("3");
        await verifyFit();
      }
    }
    await page.getByRole("radio", { name: layoutLabels.equal, exact: true }).check();
    await verifyFit();
    await page.getByRole("button", { name: "Close Cladogram settings", exact: true }).click();
    await page.getByLabel("Show cladogram", { exact: true }).uncheck();
    await verifyFit();
  });

  test(`${view} keeps a panned overview offset across cladogram modes`, async ({ page }) => {
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=${view}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: /Visual Options/ }).click();
    await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const camera = api.getCamera()!;
      const pan = { translateX: camera.translateX + 12, translateY: camera.translateY - 8 };
      if (camera.kind === "rect") api.setRectCamera(pan);
      else api.setCircularCamera(pan);
    });
    await page.getByLabel("Show cladogram", { exact: true }).check();
    await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
    for (const method of ["grafen", "levels", "logarithmic", "equal"]) {
      await page.getByRole("radio", { name: layoutLabels[method], exact: true }).check();
      const offset = await page.evaluate(() => {
        const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
        const camera = api.getCamera()!;
        api.fitView();
        const fit = api.getCamera()!;
        const result = { x: camera.translateX - fit.translateX, y: camera.translateY - fit.translateY };
        if (camera.kind === "rect") api.setRectCamera(camera);
        else api.setCircularCamera(camera);
        return result;
      });
      expect(offset.x).toBeCloseTo(12, 6);
      expect(offset.y).toBeCloseTo(-8, 6);
    }
  });

  test(`${view} preserves a zoomed branch when switching cladogram modes and strength`, async ({ page }) => {
    const balanced = (start: number, count: number): string => count === 1
      ? `Tip_${start}:1`
      : `(${balanced(start, count / 2)},${balanced(start + count / 2, count / 2)})Node_${start}_${count}:1`;
    await page.goto(`/?btv_newick=${encodeURIComponent(`${balanced(0, 64)};`)}&btv_view=${view}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: /Visual Options/ }).click();
    await page.getByLabel("Show cladogram", { exact: true }).check();
    const before = await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!;
      const node = internal.names!.indexOf("Node_16_8");
      const camera = api.getCamera()!;
      const canvas = document.querySelector("[data-testid=tree-canvas]")!.getBoundingClientRect();
      const panelRight = document.querySelector(".control-panel")!.getBoundingClientRect().right;
      const x = ((Math.max(canvas.left, panelRight) + canvas.right) / 2) - canvas.left;
      const y = canvas.height / 2;
      if (camera.kind === "rect") api.setRectCamera({ scaleX: camera.scaleX * 5, scaleY: camera.scaleY * 5 });
      else api.setCircularCamera({ scale: camera.scale * 5 });
      const zoomed = api.getCamera()!;
      const point = api.getBranchScreenSegmentForTest(node)!;
      const pan = { translateX: zoomed.translateX + x - point.x2, translateY: zoomed.translateY + y - point.y2 };
      if (zoomed.kind === "rect") api.setRectCamera(pan);
      else api.setCircularCamera(pan);
      return { node, camera: api.getCamera()!, point: api.getBranchScreenSegmentForTest(node)! };
    });
    await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
    const verify = async (span: number) => {
      await expect.poll(() => page.evaluate(({ node, before, span }) => {
        const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
        const camera = api.getCamera()!;
        const point = api.getBranchScreenSegmentForTest(node)!;
        const expectedScale = before.camera.kind === "rect" ? before.camera.scaleX : before.camera.scale;
        const scale = camera.kind === "rect" ? camera.scaleX : camera.scale;
        return Math.abs(point.x2 - before.point.x2) < 1
          && Math.abs(point.y2 - before.point.y2) < 1
          && Math.abs(scale * span / (expectedScale * 6) - 1) < 1e-6
          && (camera.kind !== "rect" || before.camera.kind !== "rect" || Math.abs(camera.scaleY - before.camera.scaleY) < 1e-6);
      }, { node: before.node, before, span })).toBe(true);
    };
    for (const method of ULTRAMETRIC_CLADOGRAM_METHODS) {
      await page.getByRole("radio", { name: layoutLabels[method], exact: true }).check();
      await verify(1);
      if (method === "logarithmic") {
        await page.getByRole("slider", { name: "Logarithmic strength" }).fill("3");
        await verify(1);
      }
    }
    await page.getByRole("radio", { name: layoutLabels.equal, exact: true }).check();
    await verify(6);
    await page.getByRole("heading", { name: "Big Tree Viewer", exact: true }).click();
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    const fit = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera()!);
    const fitScale = fit.kind === "rect" ? fit.scaleX : fit.scale;
    const zoomedScale = before.camera.kind === "rect" ? before.camera.scaleX : before.camera.scale;
    expect(fitScale).toBeLessThan(zoomedScale / 2);
  });
}

for (const view of ["rectangular", "circular", "fan"] as const) {
  test(`${view} cladograms default to unit edges and support all ultrametric layouts without editing the tree`, async ({ page }) => {
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=${view}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: "Visual Options", exact: false }).click();
    await expect(page.getByLabel("Show cladogram", { exact: true })).not.toBeChecked();
    await page.getByLabel("Show node height labels", { exact: true }).check();
    await page.getByLabel("Show node error bars", { exact: true }).check();
    await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!;
      api.setManualBranchColor(internal.leafNodes[0], "#00aa44");
    });
    await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCurrentBranchColors())).toContain("#00aa44");
    const original = await page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      return { maxDepth: window.__BIG_TREE_VIEWER_APP_TEST__!.getState().maxDepth, colors: api.getCurrentBranchColors() };
    });
    await page.getByLabel("Show cladogram", { exact: true }).check();
    // Mode changes retain the viewport; fit explicitly for label visibility checks.
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    await expect(page.getByLabel("Show scale bars", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Show scale bars", { exact: true })).not.toBeChecked();
    await expect(page.getByLabel("Show node error bars", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Show node error bars", { exact: true })).not.toBeChecked();
    await expect(page.getByLabel("Show node height labels", { exact: true })).toBeChecked();
    const readEdges = () => page.evaluate(() => {
      const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const internal = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!;
      const camera = api.getCamera()!;
      const scale = camera.kind === "rect" ? camera.scaleX : camera.scale;
      return internal.parent!.map((parent, node) => {
        const segment = api.getBranchScreenSegmentForTest(node);
        return {
          node, parent, terminal: internal.firstChild![node] < 0,
          name: internal.names![node],
          parentName: parent >= 0 ? internal.names![parent] : "",
          length: segment ? Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1) / scale : 0,
          tipRadius: segment && camera.kind === "circular"
            ? Math.hypot(segment.x2 - camera.translateX, segment.y2 - camera.translateY) / scale
            : segment && camera.kind === "rect" ? (segment.x2 - camera.translateX) / scale : 0,
        };
      }).filter(edge => edge.parent >= 0);
    });
    await expect.poll(async () => (await readEdges()).map(edge => Number(edge.length.toFixed(6))))
      .toEqual([1, 1, 1, 1, 1, 1]);
    await page.screenshot({ path: `test-results/cladogram-${view}-unit.png` });
    const svg = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest());
    expect(svg).toMatch(/>5<\/text>/);
    expect(svg).toMatch(/>9<\/text>/);
    expect(svg).not.toContain("mya");
    await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
    const standard = page.getByRole("radio", { name: "Standard Cladogram", exact: true });
    await expect(standard).toBeChecked();
    await expect(page.getByRole("radiogroup", { name: "Cladogram layout" }).getByRole("radio")).toHaveCount(4);
    await expect(page.getByRole("slider", { name: "Logarithmic strength" })).toHaveCount(0);
    for (const method of ULTRAMETRIC_CLADOGRAM_METHODS) {
      await page.getByRole("radio", { name: layoutLabels[method], exact: true }).check();
      await page.waitForFunction(method => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().ultrametricCladogramMethod === method, method);
      const expectedDepth: Record<string, number> = {
        Root: 0, A_a: 1, B_b: 1, C_c: 1, D_d: 1,
        "99": method === "logarithmic" ? 1 - Math.log(3) / Math.log(4) : 1 / 3,
        "88": method === "logarithmic" ? 0.5 : 2 / 3,
      };
      await expect.poll(async () => (await readEdges()).filter(edge => edge.terminal).map(edge => Number(edge.tipRadius.toFixed(6))))
        .toEqual([1, 1, 1, 1]);
      for (const edge of await readEdges()) {
        expect(edge.length).toBeCloseTo(expectedDepth[edge.name] - expectedDepth[edge.parentName], 8);
      }
      const shared = await page.evaluate(() => {
        const root = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.parent!.findIndex(parent => parent < 0);
        return window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildSharedSubtreePayloadForTest(root);
      });
      expect(shared?.visual?.ultrametricCladogramMethod).toBe(method);
      if (method === "logarithmic") {
        const slider = page.getByRole("slider", { name: "Logarithmic strength" });
        await expect(slider).toHaveAttribute("min", "1");
        await expect(slider).toHaveAttribute("max", "10");
        for (const strength of [2, 10]) {
          await slider.fill(String(strength));
          const depths = Object.fromEntries(Object.entries(expectedDepth).map(([name, depth]) => [name, 1 - Math.pow(1 - depth, strength)]));
          await expect.poll(async () => {
            const edges = await readEdges();
            return edges.every(edge => Math.abs(edge.length - (depths[edge.name] - depths[edge.parentName])) < 1e-8);
          }).toBe(true);
          const changedShared = await page.evaluate(() => {
            const root = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.parent!.findIndex(parent => parent < 0);
            return window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildSharedSubtreePayloadForTest(root);
          });
          expect(changedShared?.visual?.cladogramLogStrength).toBe(strength);
          await page.screenshot({ path: `test-results/cladogram-${view}-logarithmic-${strength}.png` });
        }
        await slider.fill("1");
      }
      await page.screenshot({ path: `test-results/cladogram-${view}-${method}.png` });
      await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCurrentBranchColors())).toEqual(original.colors);
    }
    await standard.check();
    await expect.poll(async () => (await readEdges()).map(edge => Number(edge.length.toFixed(6))))
      .toEqual([1, 1, 1, 1, 1, 1]);
    await page.getByRole("heading", { name: "Big Tree Viewer", exact: true }).click();
    await page.getByLabel("Show cladogram", { exact: true }).uncheck();
    await expect(page.getByLabel("Show scale bars", { exact: true })).toBeEnabled();
    await expect(page.getByLabel("Show node error bars", { exact: true })).toBeChecked();
    await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCurrentBranchColors())).toEqual(original.colors);
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().maxDepth)).toBe(original.maxDepth);
  });
}

test("ultrametric layouts redistribute differently sized sister clades", async ({ page }) => {
  const tree = "((A:1,B:1)AB:1,((C:1,D:1)CD:1,E:1,F:1)CDEF:1)Root;";
  await page.goto(`/?btv_newick=${encodeURIComponent(tree)}&btv_view=rectangular`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: /Visual Options/ }).click();
  await page.getByLabel("Show cladogram", { exact: true }).check();
  const internalDepths = () => page.evaluate(() => {
    const api = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
    const names = window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.names!;
    const camera = api.getCamera()!;
    if (camera.kind !== "rect") throw new Error("Expected rectangular camera");
    return Object.fromEntries(["AB", "CDEF", "CD"].map(name => {
      const segment = api.getBranchScreenSegmentForTest(names.indexOf(name))!;
      return [name, Number(((segment.x2 - camera.translateX) / camera.scaleX).toFixed(8))];
    }));
  });
  await expect.poll(internalDepths).toEqual({ AB: 1, CDEF: 1, CD: 2 });
  await page.screenshot({ path: "test-results/cladogram-sister-clades-unit.png" });
  await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
  const depthForTwo = 1 - Math.log(2) / Math.log(6);
  const cases = [
    { method: "levels", expected: { AB: 2 / 3, CDEF: 1 / 3, CD: 2 / 3 } },
    { method: "logarithmic", expected: { AB: depthForTwo, CDEF: 1 - Math.log(4) / Math.log(6), CD: depthForTwo } },
    { method: "grafen", expected: { AB: 0.8, CDEF: 0.4, CD: 0.8 } },
  ];
  for (const { method, expected } of cases) {
    await page.getByRole("radio", { name: layoutLabels[method], exact: true }).check();
    await expect.poll(internalDepths).toEqual(Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, Number(value.toFixed(8))])));
    await page.screenshot({ path: `test-results/cladogram-sister-clades-${method}.png` });
  }
});

for (const choice of ["equal", ...ULTRAMETRIC_CLADOGRAM_METHODS] as const) {
  test(`cladogram settings round-trip with ${choice} layout while retaining input branch lengths`, async ({ page }) => {
    const ultrametric = choice !== "equal";
    const method = choice === "equal" ? "levels" : choice;
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: "Visual Options", exact: false }).click();
    await page.evaluate(() => {
      Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
      Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
    });
    await page.getByLabel("Show cladogram", { exact: true }).check();
    await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
    await page.getByRole("radio", { name: layoutLabels[choice], exact: true }).check();
    if (choice === "logarithmic") await page.getByRole("slider", { name: "Logarithmic strength" }).fill("2.5");
    await page.getByRole("heading", { name: "Big Tree Viewer", exact: true }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save Session", exact: true }).click();
    const file = await (await downloadPromise).path();
    const bytes = await readFile(file!);
    const session = JSON.parse((bytes[0] === 0x1f ? gunzipSync(bytes) : bytes).toString("utf8"));
    expect(session.settings.showCladogram).toBe(true);
    expect(session.settings.ultrametricCladogram).toBe(ultrametric);
    expect(session.settings.ultrametricCladogramMethod).toBe(method);
    expect(session.settings.cladogramLogStrength).toBe(choice === "logarithmic" ? 2.5 : 1);
    await page.getByLabel("Show cladogram", { exact: true }).uncheck();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Load Session", exact: true }).click();
    await (await chooserPromise).setFiles(file!);
    await expect(page.getByLabel("Show cladogram", { exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
    await expect(page.getByRole("radio", { name: layoutLabels[choice], exact: true })).toBeChecked();
    if (choice === "logarithmic") await expect(page.getByRole("slider", { name: "Logarithmic strength" })).toHaveValue("2.5");
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().maxDepth)).toBe(20);
    if (ultrametric) {
      await page.getByRole("heading", { name: "Big Tree Viewer", exact: true }).click();
      await page.getByRole("button", { name: "Reset Defaults", exact: true }).click();
      await expect(page.getByLabel("Show cladogram", { exact: true })).not.toBeChecked();
      await page.getByLabel("Show cladogram", { exact: true }).check();
      await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
      await expect(page.getByRole("radio", { name: "Standard Cladogram", exact: true })).toBeChecked();
      await page.getByRole("radio", { name: layoutLabels.logarithmic, exact: true }).check();
      await expect(page.getByRole("slider", { name: "Logarithmic strength" })).toHaveValue("1");
    }
  });
}

for (const requested of [...ULTRAMETRIC_CLADOGRAM_METHODS, "invalid"] as const) {
  test(`URL launch selects the ${requested} ultrametric layout safely`, async ({ page }) => {
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_cladogram=true&btv_cladogram_ultrametric=true&btv_cladogram_method=${requested}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: /Visual Options/ }).click();
    await expect(page.getByLabel("Show cladogram", { exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
    await expect(page.getByRole("radio", { name: layoutLabels[requested === "invalid" ? "levels" : requested], exact: true })).toBeChecked();
  });
}

test("shared subtrees restore their selected ultrametric layout", async ({ page }) => {
  const key = "cladogram-layout-share";
  await page.addInitScript(({ key, newick }) => {
    localStorage.setItem(key, JSON.stringify({
      version: 2,
      newick,
      visual: { showCladogram: true, ultrametricCladogram: true, ultrametricCladogramMethod: "logarithmic", cladogramLogStrength: 3 },
    }));
  }, { key, newick });
  await page.goto(`/?subtree=${key}`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: /Visual Options/ }).click();
  await expect(page.getByLabel("Show cladogram", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
  await expect(page.getByRole("radio", { name: layoutLabels.logarithmic, exact: true })).toBeChecked();
  await expect(page.getByRole("slider", { name: "Logarithmic strength" })).toHaveValue("3");
});

test("spiral disables cladogram display and uses original lengths", async ({ page }) => {
  await page.goto(`/?btv_newick=${encodeURIComponent(spiralNewick)}`);
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
  await page.getByRole("button", { name: "Visual Options", exact: false }).click();
  await page.getByLabel("Show cladogram", { exact: true }).check();
  await page.getByRole("button", { name: "Spiral", exact: true }).click();
  await expect(page.getByLabel("Show cladogram", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Show cladogram", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Show scale bars", { exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Radial", exact: true }).click();
  await expect(page.getByLabel("Show cladogram", { exact: true })).toBeChecked();
});

for (const view of ["rectangular", "circular", "spiral"] as const) {
  test(`scale master switch removes stripes, ticks and labels in ${view}`, async ({ page }) => {
    await page.goto(`/?btv_newick=${encodeURIComponent(view === "spiral" ? spiralNewick : newick)}&btv_view=${view}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: "Visual Options", exact: false }).click();
    await page.getByLabel("Show scale bars", { exact: true }).uncheck();
    const decorations = await page.evaluate(() => {
      const svg = window.__BIG_TREE_VIEWER_CANVAS_TEST__!.buildCurrentSvgForTest()!;
      const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=tree-canvas]")!;
      const ctx = canvas.getContext("2d")!;
      const row = ctx.getImageData(0, canvas.height - 28, canvas.width, 1).data;
      let axisPixels = 0;
      for (let i = 0; i < row.length; i += 4) if (row[i] === 107 && row[i + 1] === 114 && row[i + 2] === 128) axisPixels++;
      return { svg, axisPixels };
    });
    expect(decorations.svg).not.toContain("mya");
    expect(decorations.svg).not.toContain("#6b7280");
    expect(decorations.axisPixels).toBe(0);
    await page.getByLabel("Show scale bars", { exact: true }).check();
    await page.getByRole("button", { name: "Scale labels settings", exact: true }).click();
    await expect(page.getByLabel("Show time stripes", { exact: true })).toBeVisible();
    await page.getByLabel("Show time stripes", { exact: true }).uncheck();
    await expect(page.getByLabel("Show scale bars", { exact: true })).toBeChecked();
  });
}

for (const width of [1100, 390]) {
  test(`cladogram settings fit a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/?btv_newick=${encodeURIComponent(newick)}&btv_view=circular`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded);
    await page.getByRole("button", { name: "Visual Options", exact: false }).click();
    await page.getByLabel("Show cladogram", { exact: true }).check();
    await page.getByRole("button", { name: "Cladogram settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cladogram settings", exact: true });
    await expect(dialog).toBeVisible();
    const methodControl = page.getByRole("radio", { name: layoutLabels.logarithmic, exact: true });
    await methodControl.check();
    await methodControl.scrollIntoViewIfNeeded();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await expect(page.getByRole("button", { name: "Close Cladogram settings", exact: true })).toBeInViewport();
    await expect(methodControl).toBeInViewport();
    await expect(page.getByRole("slider", { name: "Logarithmic strength" })).toBeInViewport();
    await page.screenshot({ path: `test-results/cladogram-${width}.png` });
  });
}
