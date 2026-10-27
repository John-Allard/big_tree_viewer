import { expect, test } from "@playwright/test";
import { filterTaxonomyMapToRanks } from "../src/lib/taxonomyActiveRanks";
import {
  buildMetadataTaxIdTips,
  buildMetadataTaxonomyMap,
  buildMetadataTipDisplayLabels,
} from "../src/lib/metadataMapping";
import { parseMetadataTable } from "../src/lib/metadataColors";
import { buildTaxonomyBlocksForOrderedLeaves, taxonomyEntityKey } from "../src/lib/taxonomyBlocks";
import type { TaxonomyMapPayload, TaxonomyRank } from "../src/types/taxonomy";
import type { TreeModel } from "../src/types/tree";

function treeWithTips(names: string[]): Pick<TreeModel, "nodeCount" | "names" | "leafNodes"> {
  return {
    nodeCount: names.length + 1,
    names: ["Root", ...names],
    leafNodes: Int32Array.from(names, (_, index) => index + 1),
  };
}

test("saving custom taxonomy preserves explicitly supplied ranks with a single group", () => {
  const tree = treeWithTips(["A", "B"]);
  const map = buildMetadataTaxonomyMap(tree, [{ id: "A", family: "One family", genus: "One genus" }, { id: "B", family: "One family", genus: "One genus" }], "id", { family: "family", genus: "genus" });
  const saved = filterTaxonomyMapToRanks(map, ["family", "genus"]);
  expect(saved?.activeRanks).toEqual(["genus", "family"]);
  expect(saved?.mappingOrigin).toBe("metadata-ranks");
  expect(filterTaxonomyMapToRanks({ ...map, mappingOrigin: undefined }, ["family", "genus"])?.activeRanks).toEqual([]);
});

test("display labels are node-indexed, tip-only, trimmed, and preserve original IDs", () => {
  const tree = treeWithTips(["Sample_A", "Sample_B", "Sample_C", "Sample_D"]);
  const originalNames = [...tree.names];
  const { rows } = parseMetadataTable("id,label\nSample_A,New_Name\nSample_B,\nSample_C,  Another name  \nRoot,Not a tip\n");
  const originalRows = structuredClone(rows);
  const labels = buildMetadataTipDisplayLabels(tree, rows, "id", "label");

  expect(labels).toEqual([null, "New_Name", null, "Another name", null]);
  expect(labels.filter((label) => label !== null)).toHaveLength(2);
  expect(tree.names).toEqual(originalNames);
  expect(rows).toEqual(originalRows);
  expect(labels.map((label, node) => label || tree.names[node])).toEqual([
    "Root", "New_Name", "Sample_B", "Another name", "Sample_D",
  ]);
});

test("all mappings use metadataColors key normalization and map every duplicate tip ID", () => {
  const tree = treeWithTips(["'Sample_A'", '"SAMPLE A"', "Other"]);
  const rows = [{ id: "  sample   a  ", label: "Visible", taxid: "9606", group: "Group_A" }];
  expect(buildMetadataTipDisplayLabels(tree, rows, "id", "label")).toEqual([null, "Visible", "Visible", null]);
  expect(buildMetadataTaxIdTips(tree, rows, "id", "taxid")).toEqual([
    { node: 1, name: "taxid=9606" }, { node: 2, name: "taxid=9606" }, { node: 3, name: "" },
  ]);
  const map = buildMetadataTaxonomyMap(tree, rows, "id", { family: "group" });
  expect(map.mappedCount).toBe(2);
  expect(map.tipRanks.map((tip) => tip.ranks.family)).toEqual(["Group_A", "Group_A"]);
  expect(map.tipRanks[0].taxIds).toEqual(map.tipRanks[1].taxIds);
});

test("taxid mapping includes all tips in leaf order without original-name fallback", () => {
  const tree = treeWithTips(["Homo_sapiens", "Mus_musculus", "taxid=562", "Panthera_leo"]);
  tree.leafNodes = Int32Array.from([4, 2, 1, 3]);
  const rows = [
    { id: "Homo sapiens", taxid: " 009606 " },
    { id: "Mus musculus", taxid: "   " },
    { id: "Panthera leo", taxid: "9689" },
  ];
  const before = structuredClone(tree);
  const tips = buildMetadataTaxIdTips(tree, rows, "id", "taxid");
  expect(tips).toEqual([
    { node: 4, name: "taxid=9689" },
    { node: 2, name: "" },
    { node: 1, name: "taxid=9606" },
    { node: 3, name: "" },
  ]);
  expect(tips.filter((tip) => tip.name)).toHaveLength(2);
  expect(tree).toEqual(before);
});

for (const value of ["0", "-1", "1.2", "1e3", "+9606", "0x10", "9606text", "taxid=9606", "Homo sapiens", "Infinity", "9007199254740992"]) {
  test(`invalid nonempty metadata taxid is an error: ${value}`, () => {
    expect(() => buildMetadataTaxIdTips(treeWithTips(["A"]), [{ id: "A", taxid: value }], "id", "taxid"))
      .toThrow(/Invalid NCBI taxid.*positive integer/);
  });
}

test("taxid mapping accepts positive safe integer endpoints", () => {
  expect(buildMetadataTaxIdTips(treeWithTips(["A", "B"]), [
    { id: "A", taxid: "1" }, { id: "B", taxid: String(Number.MAX_SAFE_INTEGER) },
  ], "id", "taxid")).toEqual([
    { node: 1, name: "taxid=1" }, { node: 2, name: `taxid=${Number.MAX_SAFE_INTEGER}` },
  ]);
});

test("conflicting duplicate normalized keys fail all mappings, including unmatched keys", () => {
  const tree = treeWithTips(["A"]);
  for (const key of ["A", "Not_in_tree"]) {
    const rows = [{ id: key, value: "1" }, { id: ` '${key.toUpperCase()}' `, value: "2" }];
    expect(() => buildMetadataTipDisplayLabels(tree, rows, "id", "value")).toThrow(/Conflicting metadata rows/);
    expect(() => buildMetadataTaxIdTips(tree, rows, "id", "value")).toThrow(/Conflicting metadata rows/);
    expect(() => buildMetadataTaxonomyMap(tree, rows, "id", { family: "value" })).toThrow(/Conflicting metadata rows/);
  }
});

test("blank versus nonblank duplicate values conflict rather than silently overwriting", () => {
  const tree = treeWithTips(["A"]);
  const rows = [{ id: "A", value: "" }, { id: "a", value: "9606" }];
  expect(() => buildMetadataTipDisplayLabels(tree, rows, "id", "value")).toThrow(/Conflicting metadata rows/);
  expect(() => buildMetadataTaxIdTips(tree, rows, "id", "value")).toThrow(/Conflicting metadata rows/);
  expect(() => buildMetadataTaxonomyMap(tree, rows, "id", { genus: "value" })).toThrow(/Conflicting metadata rows/);
});

test("identical selected values permit duplicate keys and ignore unrelated columns", () => {
  const tree = treeWithTips(["A"]);
  const rows = [
    { id: "A", value: " 9606 ", unused: "X" },
    { id: "a", value: "9606", unused: "Y" },
    { id: " ", value: "invalid", unused: "Z" },
  ];
  expect(buildMetadataTipDisplayLabels(tree, rows, "id", "value")).toEqual([null, "9606"]);
  expect(buildMetadataTaxIdTips(tree, rows, "id", "value")).toEqual([{ node: 1, name: "taxid=9606" }]);
  expect(buildMetadataTaxonomyMap(tree, rows, "id", { family: "value" }).mappedCount).toBe(1);
});

test("custom taxonomy returns a standard payload with metadata provenance and matched tip counts", () => {
  const tree = treeWithTips(["A", "B", "C", "D"]);
  const rows = [
    { id: "A", realm: "Realm", cluster: "Cluster", empty: "" },
    { id: "B", realm: "Realm", cluster: "", empty: "" },
    { id: "C", realm: "", cluster: "", empty: "" },
    { id: "Root", realm: "Internal", cluster: "Internal", empty: "" },
    { id: "Unknown", realm: "Unmatched", cluster: "Unmatched", empty: "" },
  ];
  const selection = { genus: "cluster", kingdom: "realm", subgenus: "empty" } as const;
  const before = structuredClone({ tree, rows, selection });
  const map = buildMetadataTaxonomyMap(tree, rows, "id", selection);
  const standardPayload: TaxonomyMapPayload = map;
  expect(standardPayload.mappedCount).toBe(2);
  expect(map).toMatchObject({
    mappingOrigin: "metadata-ranks",
    metadataRankColumns: { kingdom: "realm", genus: "cluster", subgenus: "empty" },
    totalTips: 4,
    resolvedRanks: ["kingdom", "genus", "subgenus"],
    activeRanks: ["genus", "kingdom"],
  });
  expect(map.tipRanks.map(({ node, ranks }) => ({ node, ranks }))).toEqual([
    { node: 1, ranks: { kingdom: "Realm", genus: "Cluster" } },
    { node: 2, ranks: { kingdom: "Realm" } },
  ]);
  expect(map).not.toHaveProperty("source");
  expect(map).not.toHaveProperty("identifierMode");
  expect(map.tipRanks.every((tip) => tip.sourceTaxId === undefined)).toBe(true);
  expect({ tree, rows, selection }).toEqual(before);
  expect(map.metadataRankColumns).not.toBe(selection);
});

test("homonymous custom taxa under distinct full lineages have stable negative identities and ribbons", () => {
  const tree = treeWithTips(["A", "B", "C", "D"]);
  const rows = [
    { id: "A", top: "Top A", parent: "Same parent", child: "Same child" },
    { id: "B", top: "Top B", parent: "Same parent", child: "Same child" },
    { id: "C", top: "Top A", parent: "Same parent", child: "Same child" },
    { id: "D", top: "", parent: "Same parent", child: "Same child" },
  ];
  const columns = { kingdom: "top", family: "parent", genus: "child" } as const;
  const map = buildMetadataTaxonomyMap(tree, rows, "id", columns);
  const ids = map.tipRanks.map((tip) => tip.taxIds!);
  expect(ids[0]).toEqual(ids[2]);
  expect(new Set(ids.map((entry) => entry.genus)).size).toBe(3);
  expect(new Set(ids.map((entry) => entry.family)).size).toBe(3);
  expect(Object.values(ids[0]).every((id) => Number.isSafeInteger(id) && id < 0)).toBe(true);
  expect(taxonomyEntityKey("Same child", ids[0].genus)).not.toBe(taxonomyEntityKey("Same child", ids[1].genus));
  expect(buildMetadataTaxonomyMap(tree, [...rows].reverse(), "id", { genus: "child", family: "parent", kingdom: "top" })).toEqual(map);

  const reversedTree = { ...tree, leafNodes: Int32Array.from([...tree.leafNodes].reverse()) };
  expect(buildMetadataTaxonomyMap(reversedTree, rows, "id", columns).tipRanks.reverse()).toEqual(map.tipRanks);
  expect(buildMetadataTaxonomyMap(tree, [...rows, { id: "Unknown", top: "Extra", parent: "Extra", child: "Extra" }], "id", columns)).toEqual(map);

  const blocks = buildTaxonomyBlocksForOrderedLeaves([1, 2, 3, 4], map, null).genus;
  expect(blocks).toHaveLength(4);
  expect(new Set(blocks.map((block) => block.entityKey)).size).toBe(3);
});

test("custom taxonomy IDs distinguish rank slots and delimiter-containing lineages", () => {
  const map = buildMetadataTaxonomyMap(treeWithTips(["A", "B"]), [
    { id: "A", parent: "X::Y", child: "Z" },
    { id: "B", parent: "X", child: "Y::Z" },
  ], "id", { family: "parent", genus: "child" });
  const allIds = map.tipRanks.flatMap((tip) => Object.values(tip.taxIds!));
  expect(new Set(allIds).size).toBe(4);
  const sameLabels = buildMetadataTaxonomyMap(treeWithTips(["A"]), [{ id: "A", value: "X" }], "id", { family: "value", genus: "value" });
  expect(sameLabels.tipRanks[0].taxIds?.family).not.toBe(sameLabels.tipRanks[0].taxIds?.genus);
});

test("conflicts in any selected taxonomy rank fail but unselected conflicts do not", () => {
  const tree = treeWithTips(["A"]);
  const rows = [{ id: "A", family: "Same", genus: "One" }, { id: "a", family: "Same", genus: "Two" }];
  expect(() => buildMetadataTaxonomyMap(tree, rows, "id", { family: "family", genus: "genus" })).toThrow(/Conflicting metadata rows/);
  expect(buildMetadataTaxonomyMap(tree, rows, "id", { family: "family" }).mappedCount).toBe(1);
});

test("custom taxonomy rejects invented ranks and supports existing optional rank slots", () => {
  const tree = treeWithTips(["A"]);
  const rows = [{ id: "A", group: "Group" }];
  expect(() => buildMetadataTaxonomyMap(tree, rows, "id", { invented: "group" } as unknown as Partial<Record<TaxonomyRank, string>>))
    .toThrow(/Unsupported metadata taxonomy rank/);
  expect(buildMetadataTaxonomyMap(tree, rows, "id", { tribe: "group", "species group": "group" }).activeRanks)
    .toEqual(["species group", "tribe"]);
});

test("empty inputs and absent selections leave labels/taxids empty and taxonomy unmapped", () => {
  const tree = treeWithTips(["A"]);
  for (const [rows, key, value] of [
    [[], "id", "value"],
    [[{ id: "A", value: "9606" }], "", "value"],
    [[{ id: "A", value: "9606" }], "id", ""],
    [[{ id: "A" }], "id", "missing"],
  ] as const) {
    expect(buildMetadataTipDisplayLabels(tree, rows, key, value)).toEqual([null, null]);
    expect(buildMetadataTaxIdTips(tree, rows, key, value)).toEqual([{ node: 1, name: "" }]);
    const map = buildMetadataTaxonomyMap(tree, rows, key, { family: value });
    expect(map).toMatchObject({ mappedCount: 0, totalTips: 1, activeRanks: [], tipRanks: [] });
  }
  expect(buildMetadataTaxonomyMap(tree, [{ id: "A" }], "id", {}).resolvedRanks).toEqual([]);
  expect(buildMetadataTaxonomyMap(tree, [{ id: "A" }], "id", { family: " " }).metadataRankColumns).toEqual({});
  expect(buildMetadataTipDisplayLabels(treeWithTips([]), [], "id", "value")).toEqual([null]);
  expect(buildMetadataTaxIdTips(treeWithTips([]), [], "id", "value")).toEqual([]);
  expect(buildMetadataTaxonomyMap(treeWithTips([]), [], "id", {})).toMatchObject({ mappedCount: 0, totalTips: 0 });
});
