import { expect, test, type Page } from "@playwright/test";
import { createReadStream } from "node:fs";
import { strToU8, Unzip, UnzipInflate, zipSync } from "fflate";
import { createCatalogueOfLifeTextTreeParser } from "../src/lib/catalogueOfLifeTextTree";

const FIXTURE = `Eukaryota Chatton, 1925 [domain]
  Animalia Linnaeus, 1758 [kingdom]
    Chordata Hatschek, 1888 [phylum]
      Mammalia Linnaeus, 1758 [class]
        Primates Linnaeus, 1758 [order]
          Hominidae Gray, 1825 [family]
            Homo Linnaeus, 1758 [genus]
              Homo sapiens Linnaeus, 1758 [species]
                =Homo diurnus Hoppius, 1760 [species]
                Homo sapiens idaltu White et al., 2003 [subspecies]
          Cercopithecidae Gray, 1821 [family]
            Macaca Lacépède, 1799 [genus]
              Macaca mulatta (Zimmermann, 1780) [species]
        Artiodactyla Owen, 1848 [order]
          Bovidae Gray, 1821 [family]
            Bos Linnaeus, 1758 [genus]
              Bos taurus Linnaeus, 1758 [species]
            Cephalophus C. H. Smith, 1827 [genus]
              Cephalophus zebra Gray, 1838 [species]
        Rodentia Bowdich, 1821 [order]
          Muridae Illiger, 1811 [family]
            Mus Linnaeus, 1758 [genus]
              Mus (Mus) musculus Linnaeus, 1758 [species]
    Arthropoda von Siebold, 1848 [phylum]
      Malacostraca Latreille, 1802 [class]
        Amphipoda Latreille, 1816 [order]
          Eriopisidae Example, 1900 [family]
            Eriopisa Stebbing, 1890 [genus]
              =Eriopis Bruzelius, 1859 [genus]
              Eriopisa elongata Bruzelius, 1859 [species]
      Insecta Linnaeus, 1758 [class]
        Coleoptera Linnaeus, 1758 [order]
          Coccinellidae Latreille, 1807 [family]
            Ladybirdus Example, 1900 [genus]
              Ladybirdus anchor Example, 1900 [species]
              Ladybirdus secunda Example, 1901 [species]
  Plantae Haeckel, 1866 [kingdom]
    Tracheophyta Sinnott ex Cavalier-Smith, 1998 [phylum]
      Magnoliopsida Brongniart, 1843 [class]
        Rosales Berchtold & Presl, 1820 [order]
          Rosaceae Jussieu, 1789 [family]
            Malus Miller, 1754 [genus]
              Malus domestica (Suckow) Borkh., 1803 [species]
        Caryophyllales Juss. ex Bercht. & J.Presl, 1820 [order]
          Cactaceae Juss., 1789 [family]
            Cephalophula Example, 1900 [genus]
              Cephalophula vegetabilis Example, 1900 [species]`;

function parseFixture(tips: Array<{ node: number; name: string }>) {
  const parser = createCatalogueOfLifeTextTreeParser(tips);
  for (const line of FIXTURE.split("\n")) {
    parser.consumeLine(line);
  }
  return parser.finish();
}

async function loadTree(page: Page, newick: string): Promise<void> {
  await page.getByRole("button", { name: "Paste Newick" }).click();
  await page.getByPlaceholder("Paste a Newick or NEXUS tree string here").fill(newick);
  await page.getByRole("button", { name: "Load Pasted Tree" }).click();
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && !state?.loading;
  });
}

test("TextTree mapping ignores authorship after an exact scientific-name prefix", () => {
  const payload = parseFixture([
    { node: 1, name: "Homo sapiens" },
    { node: 2, name: "Macaca_mulatta_sample_4" },
    { node: 3, name: "Malus domestica" },
  ]);
  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));

  expect(payload.mappedCount).toBe(3);
  expect(byNode.get(1)?.ranks.genus).toBe("Homo");
  expect(byNode.get(1)?.ranks.family).toBe("Hominidae");
  expect(byNode.get(1)?.ranks.kingdom).toBe("Animalia");
  expect(byNode.get(1)?.ranks.superkingdom).toBe("Eukaryota");
  expect(byNode.get(2)?.ranks.order).toBe("Primates");
  expect(byNode.get(3)?.ranks.phylum).toBe("Tracheophyta");
  expect(byNode.get(3)?.ranks.kingdom).toBe("Plantae");
  expect(payload.activeRanks).toContain("kingdom");
});

test("TextTree synonyms inherit the accepted taxon's lineage", () => {
  const payload = parseFixture([{ node: 10, name: "Homo diurnus" }]);

  expect(payload.mappedCount).toBe(1);
  expect(payload.tipRanks[0]?.ranks.genus).toBe("Homo");
  expect(payload.tipRanks[0]?.ranks.family).toBe("Hominidae");
});

test("a binomial tip is not ambiguously indexed against all of its subspecies", () => {
  const payload = parseFixture([{ node: 11, name: "Homo sapiens" }]);

  expect(payload.mappedCount).toBe(1);
  expect(payload.tipRanks[0]?.ranks.genus).toBe("Homo");
  expect(payload.tipRanks[0]?.ranks.family).toBe("Hominidae");
});

test("an obsolete genus combination maps by epithet only with close family or order context", () => {
  const payload = parseFixture([
    { node: 12, name: "Homo sapiens" },
    { node: 13, name: "Bos taurus" },
    { node: 14, name: "Cephalophula zebra" },
    { node: 15, name: "Macaca mulatta" },
  ]);
  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));

  expect(byNode.get(14)?.ranks.genus).toBe("Cephalophus");
  expect(byNode.get(14)?.ranks.family).toBe("Bovidae");
  expect(byNode.get(14)?.ranks.order).toBe("Artiodactyla");
});

test("a homonymous genus fallback cannot seed a false class mapping", () => {
  const payload = parseFixture([
    { node: 30, name: "Ladybirdus anchor" },
    { node: 31, name: "Eriopis canrash" },
    { node: 32, name: "Ladybirdus secunda" },
  ]);
  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));

  expect(byNode.get(30)?.ranks.class).toBe("Insecta");
  expect(byNode.get(32)?.ranks.class).toBe("Insecta");
  expect(byNode.has(31)).toBe(false);
});

test("an accepted genus can classify a species absent from the TextTree", () => {
  const payload = parseFixture([
    { node: 33, name: "Ladybirdus anchor" },
    { node: 34, name: "Ladybirdus missing" },
    { node: 35, name: "Ladybirdus secunda" },
  ]);
  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));

  expect(payload.mappedCount).toBe(3);
  expect(byNode.get(34)?.ranks.class).toBe("Insecta");
  expect(byNode.get(34)?.ranks.family).toBe("Coccinellidae");
  expect(byNode.get(34)?.ranks.genus).toBe("Ladybirdus");
});

test("an accepted genus can use one trusted class flank at a class boundary", () => {
  const payload = parseFixture([
    { node: 36, name: "Ladybirdus anchor" },
    { node: 37, name: "Ladybirdus missing" },
    { node: 38, name: "Malus domestica" },
  ]);
  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));

  expect(payload.mappedCount).toBe(3);
  expect(byNode.get(37)?.ranks.class).toBe("Insecta");
  expect(byNode.get(37)?.ranks.genus).toBe("Ladybirdus");
});

test("a long run of absent species can use trusted taxonomy at its flanks", () => {
  const missing = Array.from({ length: 80 }, (_, index) => ({
    node: 100 + index,
    name: `Ladybirdus missing${index}`,
  }));
  const payload = parseFixture([
    { node: 99, name: "Ladybirdus anchor" },
    ...missing,
    { node: 180, name: "Ladybirdus secunda" },
  ]);
  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));

  expect(payload.mappedCount).toBe(82);
  expect(byNode.get(140)?.ranks.class).toBe("Insecta");
  expect(byNode.get(140)?.ranks.family).toBe("Coccinellidae");
});

test("parenthesized subgenera do not prevent an exact binomial match", () => {
  const payload = parseFixture([{ node: 16, name: "Mus musculus" }]);

  expect(payload.mappedCount).toBe(1);
  expect(payload.tipRanks[0]?.ranks.genus).toBe("Mus");
  expect(payload.tipRanks[0]?.ranks.family).toBe("Muridae");
});

test("single-token higher taxa map without treating the authorship as part of the name", () => {
  const payload = parseFixture([{ node: 20, name: "Hominidae" }]);

  expect(payload.mappedCount).toBe(1);
  expect(payload.tipRanks[0]?.ranks.family).toBe("Hominidae");
  expect(payload.tipRanks[0]?.ranks.order).toBe("Primates");
});

test("Catalogue of Life can be selected, loaded, and mapped through the Taxonomy panel", async ({ page }) => {
  const archive = zipSync({ "test-dataset.txtree": strToU8(FIXTURE) });
  const archiveBase64 = Buffer.from(archive).toString("base64");
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  const closeTutorial = page.getByRole("button", { name: "Close tutorial prompt" });
  if (await closeTutorial.isVisible()) {
    await closeTutorial.click();
  }
  await loadTree(page, "((Homo_sapiens:1,Macaca_mulatta_sample_4:1):1,(Malus_domestica:1,Unknownus_mystery:1):1)Root;");
  await page.getByRole("button", { name: "Taxonomy" }).click();
  await page.getByLabel("Taxonomy source").selectOption("catalogue-of-life");
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyCached === false);
  await page.evaluate((encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const file = new File([bytes], "catalogue-of-life-texttree.zip", { type: "application/zip" });
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true,
      value: async (options: { id?: string }) => {
        Object.defineProperty(window, "__colOpenPickerId", { configurable: true, value: options.id });
        return [{
          kind: "file",
          name: file.name,
          getFile: async () => file,
        }];
      },
    });
  }, archiveBase64);

  await page.getByRole("button", { name: "Already have a TextTree ZIP? Choose it" }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyCached === true);
  const openPickerId = await page.evaluate(() => (window as Window & { __colOpenPickerId?: string }).__colOpenPickerId);
  expect(openPickerId).toBe("btv-taxonomy-col");
  expect(openPickerId?.length).toBeLessThanOrEqual(32);
  await page.getByRole("button", { name: "Run Taxonomy Mapping" }).click();
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return state?.taxonomyMappedCount === 3 && state?.taxonomyLoading === false;
  });

  const payload = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest());
  expect(payload?.source).toBe("catalogue-of-life");
  expect(payload?.mappedCount).toBe(3);
  expect(payload?.tipRanks.map((tip) => tip.ranks.phylum).sort()).toEqual(["Chordata", "Chordata", "Tracheophyta"]);

  const loadedStatus = page.getByText(/Mapped 3 of 4 tips with Catalogue of Life/);
  await expect(loadedStatus).toBeVisible();
  const statusPrecedesSourceSelector = await loadedStatus.evaluate((status, selector) => (
    Boolean(status.compareDocumentPosition(selector as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
  ), await page.getByLabel("Taxonomy source").elementHandle());
  expect(statusPrecedesSourceSelector).toBe(true);

  await expect(page.getByText(/1 of 4 tips \(25%\) were not mapped to Catalogue of Life/)).toBeVisible();
  await page.getByRole("button", { name: "Collapse unmapped tips warning" }).click();
  const compactWarning = page.getByRole("button", { name: "1 of 4 tips (25%) were unmapped." });
  await expect(compactWarning).toBeVisible();
  await compactWarning.click();
  await expect(page.getByText(/1 of 4 tips \(25%\) were not mapped to Catalogue of Life/)).toBeVisible();

  await page.getByLabel("Taxonomy source").selectOption("ncbi");
  const preserved = await page.evaluate(() => ({
    state: window.__BIG_TREE_VIEWER_APP_TEST__?.getState(),
    map: window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest(),
  }));
  expect(preserved.state?.taxonomyEnabled).toBe(true);
  expect(preserved.state?.taxonomyMappedCount).toBe(3);
  expect(preserved.map?.source).toBe("catalogue-of-life");
  await expect(loadedStatus).toBeVisible();
});

test("Catalogue of Life save picker uses a Chrome-compatible ID", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().treeLoaded === true);
  const closeTutorial = page.getByRole("button", { name: "Close tutorial prompt" });
  if (await closeTutorial.isVisible()) {
    await closeTutorial.click();
  }
  await page.getByRole("button", { name: "Taxonomy" }).click();
  await page.getByRole("combobox", { name: "Taxonomy source" }).selectOption("catalogue-of-life");
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyCached === false);
  await page.evaluate(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async (options: { id?: string }) => {
        Object.defineProperty(window, "__colSavePickerId", { configurable: true, value: options.id });
        throw new DOMException("The user aborted a request.", "AbortError");
      },
    });
  });

  await page.getByRole("button", { name: "Download Taxonomy" }).click();
  const savePickerId = await page.evaluate(() => (window as Window & { __colSavePickerId?: string }).__colSavePickerId);
  expect(savePickerId).toBe("btv-taxonomy-col");
  expect(savePickerId?.length).toBeLessThanOrEqual(32);
});

test("changing taxonomy source preserves the bundled example mapping until mapping is run", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount) > 0;
  });
  const closeTutorial = page.getByRole("button", { name: "Close tutorial prompt" });
  if (await closeTutorial.isVisible()) {
    await closeTutorial.click();
  }
  await page.getByRole("button", { name: "Taxonomy" }).click();
  const before = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount);
  await expect(page.getByText(/Loaded NCBI Taxonomy mapping from session/)).toBeVisible();

  await page.getByLabel("Taxonomy source").selectOption("catalogue-of-life");

  const after = await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getState());
  expect(after?.taxonomyEnabled).toBe(true);
  expect(after?.taxonomyMappedCount).toBe(before);
  await expect(page.getByText(/Loaded NCBI Taxonomy mapping from session/)).toBeVisible();
});

test("saved mappings can be switched by source without rerunning taxonomy mapping", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    return Boolean(state?.treeLoaded) && Boolean(state?.taxonomyEnabled) && Number(state?.taxonomyMappedCount) > 0;
  });
  const closeTutorial = page.getByRole("button", { name: "Close tutorial prompt" });
  if (await closeTutorial.isVisible()) {
    await closeTutorial.click();
  }
  await page.evaluate(async () => {
    await window.__BIG_TREE_VIEWER_APP_TEST__?.cacheCurrentTaxonomyForTest("catalogue-of-life");
  });
  await page.getByRole("button", { name: "Taxonomy" }).click();

  await page.getByLabel("Taxonomy source").selectOption("catalogue-of-life");
  await expect(page.getByRole("button", { name: "Load Taxonomy Mapping" })).toBeVisible();
  await expect(page.getByText("A saved Catalogue of Life mapping is available for this tree.")).toBeVisible();
  await page.getByRole("button", { name: "Load Taxonomy Mapping" }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest()?.source === "catalogue-of-life");
  await expect(page.getByRole("button", { name: "Catalogue of Life Loaded" })).toBeDisabled();

  await page.getByLabel("Taxonomy source").selectOption("ncbi");
  await expect(page.getByRole("button", { name: "Load Taxonomy Mapping" })).toBeVisible();
  await page.getByRole("button", { name: "Load Taxonomy Mapping" }).click();
  await page.waitForFunction(() => window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest()?.source !== "catalogue-of-life");
  await expect(page.getByRole("button", { name: "NCBI Taxonomy Loaded" })).toBeDisabled();

  const collapseRanks = page.getByLabel("Collapse mapped tips to");
  await expect(collapseRanks.locator("option").first()).toHaveText("Choose a taxonomic rank");
  await expect(collapseRanks.locator("option", { hasText: /^Species$/ })).toHaveCount(0);
});

test("loading the same plain tree restores its most recent saved mapping", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__BIG_TREE_VIEWER_APP_TEST__));
  const closeTutorial = page.getByRole("button", { name: "Close tutorial prompt" });
  if (await closeTutorial.isVisible()) {
    await closeTutorial.click();
  }
  const originalTree = "((Homo_sapiens:1,Pan_troglodytes:1):1,Mus_musculus:2)Root;";
  await loadTree(page, originalTree);
  await page.evaluate(() => window.__BIG_TREE_VIEWER_APP_TEST__?.setMockTaxonomy());
  await page.waitForFunction(() => Number(window.__BIG_TREE_VIEWER_APP_TEST__?.getState().taxonomyMappedCount) > 0);
  await page.evaluate(async () => {
    await window.__BIG_TREE_VIEWER_APP_TEST__?.cacheCurrentTaxonomyForTest("ncbi");
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    await window.__BIG_TREE_VIEWER_APP_TEST__?.cacheCurrentTaxonomyForTest("catalogue-of-life");
  });

  await loadTree(page, "(Alpha:1,Beta:1)OtherRoot;");
  await loadTree(page, originalTree);
  await page.waitForFunction(() => {
    const state = window.__BIG_TREE_VIEWER_APP_TEST__?.getState();
    const map = window.__BIG_TREE_VIEWER_APP_TEST__?.getTaxonomyMapForTest();
    return state?.taxonomySource === "catalogue-of-life" && map?.source === "catalogue-of-life";
  });

  await page.getByRole("button", { name: "Taxonomy" }).click();
  await expect(page.getByText(/Loaded cached Catalogue of Life mapping for this tree/)).toBeVisible();
});

const fullArchivePath = process.env.COL_TEXTTREE_PATH;

test("maps representative taxa from a complete Catalogue of Life TextTree release", async () => {
  test.skip(!fullArchivePath, "Set COL_TEXTTREE_PATH to run the full-release integration test.");
  test.setTimeout(120_000);
  const tips = [
    { node: 1, name: "Homo sapiens" },
    { node: 2, name: "Mus musculus" },
    { node: 3, name: "Drosophila melanogaster" },
    { node: 4, name: "Arabidopsis thaliana" },
    { node: 5, name: "Saccharomyces cerevisiae" },
    { node: 6, name: "Escherichia coli" },
    { node: 7, name: "Archaeoglobus fulgidus" },
  ];
  const parser = createCatalogueOfLifeTextTreeParser(tips);

  await new Promise<void>((resolve, reject) => {
    let found = false;
    const unzipper = new Unzip((file) => {
      if (!file.name.endsWith(".txtree")) {
        return;
      }
      found = true;
      const decoder = new TextDecoder();
      let remainder = "";
      file.ondata = (error, data, final) => {
        if (error) {
          reject(error);
          return;
        }
        const text = remainder + decoder.decode(data, { stream: !final });
        const lines = text.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) {
          parser.consumeLine(line);
        }
        if (final) {
          if (remainder) {
            parser.consumeLine(remainder);
          }
          resolve();
        }
      };
      file.start();
    });
    unzipper.register(UnzipInflate);
    const stream = createReadStream(fullArchivePath!);
    stream.on("data", (chunk: Buffer) => unzipper.push(new Uint8Array(chunk), false));
    stream.on("end", () => {
      unzipper.push(new Uint8Array(), true);
      if (!found) {
        reject(new Error("The archive did not contain a TextTree file."));
      }
    });
    stream.on("error", reject);
  });

  const payload = parser.finish();
  const byNode = new Map(payload.tipRanks.map((tip) => [tip.node, tip]));
  expect(parser.parsedLineCount()).toBeGreaterThan(5_000_000);
  expect(payload.mappedCount).toBe(tips.length);
  expect(byNode.get(1)?.ranks.family).toBe("Hominidae");
  expect(byNode.get(2)?.ranks.order).toBe("Rodentia");
  expect(byNode.get(3)?.ranks.phylum).toBe("Arthropoda");
  expect(byNode.get(4)?.ranks.phylum).toBe("Tracheophyta");
  expect(byNode.get(5)?.ranks.phylum).toBe("Ascomycota");
  expect(byNode.get(6)?.ranks.genus).toBe("Escherichia");
  expect(byNode.get(7)?.ranks.class).toBe("Archaeoglobi");
});
