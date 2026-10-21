import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

for (const mode of ["rectangular", "circular", "fan", "spiral"]) {
  test(`${mode} figure export tightly crops the complete tree independently of pan`, async ({ page }, testInfo) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width: 1200, height: 800 });
    const newick = mode === "spiral"
      ? `(${Array.from({ length: 1000 }, (_, index) => `Species_${index}:1`).join(",")})Root;`
      : "((Species_A:1,Species_B:1):1,(Species_C:1,Species_D:1):1)Root;";
    await page.route("**/figure-tree.nwk", route => route.fulfill({ body: newick, contentType: "text/plain" }));
    const payload = { newickUrl: "/figure-tree.nwk", visual: { viewMode: mode, showTipLabels: true, showGenusLabels: false, showScaleBars: false, showTimeStripes: false } };
    await page.goto(`/?btv_payload=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`);
    await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true);
    await page.getByRole("button", { name: "Export View", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export view settings" });
    await dialog.getByLabel("Width px").fill("900");
    await expect(dialog.getByLabel("Height px", { exact: true })).toHaveCount(0);
    const exportPng = async (name: string) => {
      const download = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Export", exact: true }).click();
      const file = await download;
      await file.saveAs(testInfo.outputPath(`${name}.png`));
      return readFile((await file.path())!);
    };
    const baselineCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera());
    const first = await exportPng("complete-tree");
    expect(first.readUInt32BE(16)).toBe(900);
    const chunks: string[] = [];
    for (let offset = 8; offset + 12 <= first.length; offset += first.readUInt32BE(offset) + 12) chunks.push(first.toString("ascii", offset + 4, offset + 8));
    expect(chunks).toContain("sRGB");
    const originalHeight = first.readUInt32BE(20);
    expect(originalHeight).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera())).toEqual(baselineCamera);
    const margins = await page.evaluate(async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      let left = image.width, top = image.height, right = 0, bottom = 0;
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4;
        if (Math.abs(pixels[i] - 251) < 5 && Math.abs(pixels[i + 1] - 252) < 5 && Math.abs(pixels[i + 2] - 254) < 5) continue;
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      return [left, top, image.width - right - 1, image.height - bottom - 1];
    }, first.toString("base64"));
    expect(Math.max(...margins)).toBeLessThan(35);
    await page.evaluate(() => {
      const controls = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const camera = controls.getCamera()!;
      const offset = { translateX: Number(camera.translateX) - 240, translateY: Number(camera.translateY) + 90 };
      if (camera.kind === "rect") controls.setRectCamera(offset);
      else controls.setCircularCamera(offset);
    });
    const pannedCamera = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera());
    const second = await exportPng("after-panning");
    expect(second.equals(first)).toBe(true);
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera())).toEqual(pannedCamera);
    await dialog.getByRole("combobox", { name: "Format", exact: true }).selectOption("svg");
    const svgDownload = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const svg = await readFile((await (await svgDownload).path())!, "utf8");
    expect(svg).toContain('width="4.5in"');
    expect(svg).toContain(`height="${originalHeight / 200}in"`);
    if (mode !== "spiral") for (const label of ["Species A", "Species B", "Species C", "Species D"]) expect(svg).toContain(label);
    expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera())).toEqual(pannedCamera);
  });
}

for (const position of ["top-right", "bottom-left"]) {
  test(`whole-tree export keeps the ${position} legend clear of complete tip labels`, async ({ page }, testInfo) => {
    const payload = {
      newick: "((Species_A:1,Species_B:1)Group_A:1,(Species_C:1,Species_D:1)Group_B:1)Root;",
      visual: { viewMode: "rectangular", showScaleBars: false, showTimeStripes: false, showGenusLabels: false,
        metadataLegendEnabled: true, metadataLegendPosition: position },
      metadata: { text: "name,Habitat\nGroup_A,Forest\nGroup_B,Grassland\n", keyColumn: "name", valueColumn: "Habitat", enabled: true, applyScope: "subtree" },
    };
    await page.goto(`/?btv_payload=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`);
    await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.metadataLegend));
    await page.getByRole("button", { name: "Export View", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export view settings" });
    await dialog.getByRole("combobox", { name: "Format", exact: true }).selectOption("svg");
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const file = await download;
    await file.saveAs(testInfo.outputPath("complete-tree-and-legend.svg"));
    const svg = await readFile((await file.path())!, "utf8");
    const bounds = await page.evaluate(markup => {
      const wrapper = document.createElement("div");
      wrapper.style.cssText = "position:fixed;left:0;top:0;visibility:hidden";
      wrapper.innerHTML = markup;
      document.body.append(wrapper);
      const box = (node: Element) => {
        const bounds = node.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
      };
      const texts = [...wrapper.querySelectorAll("text")];
      const result = { frame: box(wrapper.querySelector("svg")!),
        tips: texts.filter(node => /^Species [A-D]$/.test(node.textContent ?? "")).map(box),
        heading: box(texts.find(node => node.textContent === "Branch colors: Habitat")!),
        lineSwatches: [...wrapper.querySelectorAll("line")].filter(node => Number(node.getAttribute("stroke-width")) === 3).length };
      wrapper.remove();
      return result;
    }, svg);
    expect(bounds.tips).toHaveLength(4);
    expect(bounds.lineSwatches).toBeGreaterThanOrEqual(2);
    for (const tip of bounds.tips) {
      expect(tip.left).toBeGreaterThan(bounds.frame.left);
      expect(tip.right).toBeLessThan(bounds.frame.right);
      expect(tip.top).toBeGreaterThan(bounds.frame.top);
      expect(tip.bottom).toBeLessThan(bounds.frame.bottom);
      if (position.endsWith("right")) expect(tip.right).toBeLessThan(bounds.heading.left);
      else expect(tip.left).toBeGreaterThan(bounds.heading.right);
    }
  });
}

for (const mode of ["rectangular", "circular"]) {
  test(`${mode} export includes a dragged legend and the full tree when the tree is panned out of view`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    const payload = {
      newick: "((Species_A:1,Species_B:1)Group_A:1,(Species_C:1,Species_D:1)Group_B:1)Root;",
      visual: { viewMode: mode, showScaleBars: false, showTimeStripes: false, showGenusLabels: false, metadataLegendEnabled: true },
      metadata: { text: "name,Habitat\nGroup_A,Forest\nGroup_B,Grassland\n", keyColumn: "name", valueColumn: "Habitat", enabled: true, applyScope: "subtree" },
    };
    await page.goto(`/?btv_payload=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`);
    await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_CANVAS_TEST__?.getRenderDebug()?.metadataLegend));
    const canvasBox = (await page.getByTestId("tree-canvas").boundingBox())!;
    const legend = await page.evaluate(() => window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getRenderDebug()!.metadataLegend as { x: number; y: number });
    await page.mouse.move(canvasBox.x + legend.x + 60, canvasBox.y + legend.y + 20);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + 90, canvasBox.y + canvasBox.height - 110, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__!.getState().metadataLegendPlacement));
    await page.evaluate(() => {
      const controls = window.__BIG_TREE_VIEWER_CANVAS_TEST__!;
      const camera = controls.getCamera()!;
      const offset = { translateX: Number(camera.translateX) - 450, translateY: Number(camera.translateY) - 200 };
      if (camera.kind === "rect") controls.setRectCamera(offset);
      else controls.setCircularCamera(offset);
    });
    const before = await page.evaluate(() => ({ camera: window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera(),
      placement: window.__BIG_TREE_VIEWER_APP_TEST__!.getState().metadataLegendPlacement }));
    await page.getByRole("button", { name: "Export View", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export view settings" });
    await dialog.getByLabel("Width px").fill("1000");
    const pngDownload = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const png = await pngDownload;
    await png.saveAs(testInfo.outputPath("dragged-legend.png"));
    const pngBytes = await readFile((await png.path())!);
    await dialog.getByRole("combobox", { name: "Format", exact: true }).selectOption("svg");
    const svgDownload = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const vector = await svgDownload;
    await vector.saveAs(testInfo.outputPath("dragged-legend.svg"));
    const svg = await readFile((await vector.path())!, "utf8");
    const result = await page.evaluate(async ({ markup, pngData }) => {
      const wrapper = document.createElement("div");
      wrapper.style.cssText = "position:fixed;left:0;top:0;visibility:hidden";
      wrapper.innerHTML = markup;
      document.body.append(wrapper);
      const root = wrapper.querySelector("svg")!;
      const frame = root.getBoundingClientRect();
      const texts = [...wrapper.querySelectorAll("text")];
      const clipped = texts.filter(text => {
        const bounds = text.getBoundingClientRect();
        return bounds.left < frame.left || bounds.right > frame.right || bounds.top < frame.top || bounds.bottom > frame.bottom;
      }).map(text => text.textContent);
      const legend = wrapper.querySelector('rect[fill^="rgba(255"]')!.getBoundingClientRect();
      const labels = texts.map(text => text.textContent);
      const legendContained = legend.left > frame.left && legend.right < frame.right && legend.top > frame.top && legend.bottom < frame.bottom;
      const width = Math.round(parseFloat(root.getAttribute("width")!) * 200);
      const height = Math.round(parseFloat(root.getAttribute("height")!) * 200);
      wrapper.remove();
      const pixels = async (url: string) => {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      };
      const raster = await pixels(`data:image/png;base64,${pngData}`);
      const vector = await pixels(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
      let error = 0;
      for (let i = 0; i < raster.length; i += 4) error += Math.abs(raster[i] - vector[i]) + Math.abs(raster[i + 1] - vector[i + 1]) + Math.abs(raster[i + 2] - vector[i + 2]);
      return { clipped, labels, legendContained, width, height, meanError: error / (width * height * 3) };
    }, { markup: svg, pngData: pngBytes.toString("base64") });
    expect(result.clipped).toEqual([]);
    expect(result.legendContained).toBe(true);
    for (const label of ["Species A", "Species B", "Species C", "Species D", "Branch colors: Habitat", "Forest", "Grassland"]) expect(result.labels).toContain(label);
    expect(result.width).toBe(1000);
    expect(result.height).toBe(pngBytes.readUInt32BE(20));
    expect(result.meanError).toBeLessThan(3);
    expect(await page.evaluate(() => ({ camera: window.__BIG_TREE_VIEWER_CANVAS_TEST__!.getCamera(),
      placement: window.__BIG_TREE_VIEWER_APP_TEST__!.getState().metadataLegendPlacement }))).toEqual(before);
  });
}
