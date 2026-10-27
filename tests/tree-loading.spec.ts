import { expect, test, type Page } from "@playwright/test";
import { canParseTreeInline, parseTreePayload } from "../src/lib/treeParser";

function balancedTree(count: number, offset = 0): string {
  if (count === 1) return `Species_${offset}:1`;
  const left = Math.floor(count / 2);
  return `(${balancedTree(left, offset)},${balancedTree(count - left, offset + left)}):1`;
}

async function emptyViewer(page: Page) {
  await page.addInitScript(() => {
    const workers: Worker[] = [];
    (window as typeof window & { __treeLoadWorkers: Worker[] }).__treeLoadWorkers = workers;
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        workers.push(this);
      }
    };
  });
  await page.goto("/?btv_api=1");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_API_READY__));
}

async function load(page: Page, newick: string) {
  return page.evaluate(text => new Promise<{ type: string; message?: string }>(resolve => {
    const listener = (event: MessageEvent) => {
      if (!["big-tree-viewer:loaded", "big-tree-viewer:error"].includes(event.data?.type)) return;
      window.removeEventListener("message", listener);
      resolve(event.data);
    };
    window.addEventListener("message", listener);
    window.postMessage({ type: "big-tree-viewer:load", payload: { newick: text } }, "*");
  }), newick);
}

test("inline parsing has conservative text and node budgets", () => {
  expect(canParseTreeInline(`${balancedTree(1000)};`)).toBe(true);
  expect(canParseTreeInline(`${balancedTree(2000)};`)).toBe(true);
  expect(canParseTreeInline(`${balancedTree(2049)};`)).toBe(false);
  expect(canParseTreeInline(`(${'A'.repeat(128 * 1024)}:1,B:1);`)).toBe(false);
  expect(canParseTreeInline(`(${Array.from({ length: 5000 }, () => "A").join(",")});`)).toBe(false);
  expect(canParseTreeInline(`('${"(,".repeat(4096)}':1,B:1);`)).toBe(false);
});

test("small primary and comparison trees do not start parsing workers", async ({ page }, testInfo) => {
  await emptyViewer(page);
  const newick = `${balancedTree(1000)};`;
  expect((await load(page, newick)).type).toBe("big-tree-viewer:loaded");
  await expect.poll(() => page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.leafNodes.length)).toBe(1000);
  const pixels = await page.getByTestId("tree-canvas").evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 160 && data[i + 1] < 160 && data[i + 2] < 160) dark += 1;
    return dark;
  });
  expect(pixels).toBeGreaterThan(500);
  await page.getByTestId("tree-canvas").screenshot({ path: testInfo.outputPath("1000-tip-tree.png") });
  await page.getByRole("button", { name: "Tree Comparison" }).click();
  const panel = page.locator(".panel-section").filter({ has: page.getByRole("button", { name: "Tree Comparison" }) });
  await panel.getByRole("button", { name: "Paste Newick", exact: true }).click();
  await panel.getByPlaceholder("Paste the comparison tree in Newick or NEXUS format").fill(newick);
  await panel.getByRole("button", { name: "Load Comparison", exact: true }).click();
  await expect(page.locator(".tree-comparison-summary")).toContainText(/1,?000 shared tips/);
  expect(await page.evaluate(() => (window as typeof window & { __treeLoadWorkers: Worker[] }).__treeLoadWorkers.length)).toBe(0);
});

test("larger trees keep using the background worker", async ({ page }) => {
  await emptyViewer(page);
  expect((await load(page, `${balancedTree(10000)};`)).type).toBe("big-tree-viewer:loaded");
  expect(await page.evaluate(() => (window as typeof window & { __treeLoadWorkers: Worker[] }).__treeLoadWorkers.length)).toBe(1);
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.leafNodes.length)).toBe(10000);
});

test("worker and inline parser produce identical annotated NEXUS payloads", async ({ page }) => {
  await emptyViewer(page);
  const text = `#NEXUS
begin trees;
translate 1 'Alpha, beta', 2 Gamma, 3 Delta;
tree selected = [&R] (1:2,(2:1,3:1)[&posterior=0.97,height_95%_HPD={0.6,1.4}]:1)Root;
end;`;
  const expected = JSON.parse(JSON.stringify(parseTreePayload(text).payload, (_key, value) => ArrayBuffer.isView(value) ? Array.from(value as Float64Array) : value));
  const actual = await page.evaluate(source => new Promise((resolve, reject) => {
    const worker = new Worker("/src/workers/treeWorker.ts", { type: "module" });
    worker.onmessage = event => {
      if (event.data.type === "parse-progress") return;
      worker.terminate();
      if (event.data.type === "parse-error") reject(new Error(event.data.message));
      else resolve(JSON.parse(JSON.stringify(event.data.payload, (_key, value) => ArrayBuffer.isView(value) ? Array.from(value as Float64Array) : value)));
    };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ type: "parse-tree", text: source });
  }), text);
  expect(actual).toEqual(expected);
});

test("a small malformed tree can be followed immediately by a valid tree", async ({ page }) => {
  await emptyViewer(page);
  expect((await load(page, "((A:1,B:1);")).type).toBe("big-tree-viewer:error");
  expect((await load(page, "(A:1,B:1)Recovered;")).type).toBe("big-tree-viewer:loaded");
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.names)).toContain("Recovered");
});

test("an older hash completion cannot replace a newer small tree", async ({ page }) => {
  await emptyViewer(page);
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let calls = 0;
    crypto.subtle.digest = (...args: Parameters<typeof digest>) => {
      if (++calls > 1) return digest(...args);
      return new Promise<ArrayBuffer>(resolve => {
        (window as typeof window & { __finishOldTreeHash: () => void }).__finishOldTreeHash = () => { void digest(...args).then(resolve); };
      });
    };
    window.postMessage({ type: "big-tree-viewer:load", payload: { newick: "(A:1,B:1)Old;" } }, "*");
  });
  await page.waitForFunction(() => Boolean((window as typeof window & { __finishOldTreeHash?: () => void }).__finishOldTreeHash));
  expect((await load(page, "(C:1,D:1)Newest;")).type).toBe("big-tree-viewer:loaded");
  const oldReply = page.evaluate(() => new Promise<string>(resolve => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== "big-tree-viewer:error") return;
      window.removeEventListener("message", listener);
      resolve(event.data.message);
    };
    window.addEventListener("message", listener);
    (window as typeof window & { __finishOldTreeHash: () => void }).__finishOldTreeHash();
  }));
  expect(await oldReply).toContain("superseded");
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.names)).toContain("Newest");
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.names)).not.toContain("Old");
});

test("a small tree supersedes a pending worker without accepting its late result", async ({ page }) => {
  await emptyViewer(page);
  await page.evaluate(() => {
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      postMessage() {
        (window as typeof window & { __heldTreeWorker: Worker }).__heldTreeWorker = this;
      }
      terminate() {
        (window as typeof window & { __heldTreeWorkerTerminated: boolean }).__heldTreeWorkerTerminated = true;
        super.terminate();
      }
    };
  });
  await page.evaluate(newick => window.postMessage({ type: "big-tree-viewer:load", payload: { newick } }, "*"), `${balancedTree(10000)};`);
  await page.waitForFunction(() => Boolean((window as typeof window & { __heldTreeWorker?: Worker }).__heldTreeWorker));
  await page.evaluate(() => window.postMessage({ type: "big-tree-viewer:load", payload: { newick: "(C:1,D:1)Newest;" } }, "*"));
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__?.names.includes("Newest"));
  expect(await page.evaluate(() => (window as typeof window & { __heldTreeWorkerTerminated: boolean }).__heldTreeWorkerTerminated)).toBe(true);
  await page.evaluate(async () => {
    const moduleUrl = "/src/lib/treeParser.ts";
    const { parseTreePayload } = await import(moduleUrl);
    const worker = (window as typeof window & { __heldTreeWorker: Worker }).__heldTreeWorker;
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "parsed-tree", payload: parseTreePayload("(X:1,Y:1)Stale;").payload } }));
    worker.dispatchEvent(new ErrorEvent("error", { message: "Stale worker failure" }));
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST_INTERNAL__!.names)).toContain("Newest");
  expect(await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__!.getState().loadError)).toBeNull();
});
