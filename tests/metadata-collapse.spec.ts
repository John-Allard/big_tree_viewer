import { expect, test } from "@playwright/test";
import { buildMetadataCollapseGroups } from "../src/lib/metadataCollapse";
import type { TreeModel } from "../src/types/tree";

function treeFromParents(parents: number[], names?: string[]): TreeModel {
  const nodeCount = parents.length;
  const firstChild = new Int32Array(nodeCount).fill(-1);
  const nextSibling = new Int32Array(nodeCount).fill(-1);
  const lastChild = new Int32Array(nodeCount).fill(-1);
  const leaves: number[] = [];
  for (let node = 0; node < nodeCount; node += 1) {
    const parent = parents[node];
    if (parent < 0) continue;
    if (lastChild[parent] < 0) firstChild[parent] = node;
    else nextSibling[lastChild[parent]] = node;
    lastChild[parent] = node;
  }
  for (let node = 0; node < nodeCount; node += 1) {
    if (firstChild[node] < 0) leaves.push(node);
  }
  const layout = { center: new Float64Array(nodeCount), min: new Float64Array(nodeCount), max: new Float64Array(nodeCount) };
  return {
    root: parents.findIndex(parent => parent < 0), nodeCount, leafCount: leaves.length,
    names: names ?? parents.map((_, node) => `N${node}`), leafNodes: Int32Array.from(leaves),
    maxDepth: 0, rootAge: 0, hasBranchLengths: false, isUltrametric: false,
    branchLengthMinPositive: 1, nodeIntervalCount: 0,
    nodeIntervalLower: new Float64Array(nodeCount), nodeIntervalUpper: new Float64Array(nodeCount),
    buffers: {
      parent: Int32Array.from(parents), firstChild, nextSibling,
      branchLength: new Float64Array(nodeCount), depth: new Float64Array(nodeCount),
      leafCount: new Int32Array(nodeCount),
    },
    layouts: { input: layout, asc: layout, desc: layout },
  };
}

function rowsFor(values: Record<string, string>): Array<Record<string, string>> {
  return Object.entries(values).map(([tip, group]) => ({ tip, group }));
}

test("returns only the maximal homogeneous clade with its original node ID and tip count", () => {
  const tree = treeFromParents([-1, 0, 1, 1, 0, 4, 4]);
  expect(buildMetadataCollapseGroups(tree, rowsFor({ N2: "A", N3: "A", N5: "A", N6: "A" }), "tip", "group"))
    .toEqual([{ node: 0, label: "A", tipCount: 4 }]);
});

test("keeps disjoint clades separate even when their metadata values are identical", () => {
  const tree = treeFromParents([-1, 0, 1, 1, 0, 4, 4, 0]);
  expect(buildMetadataCollapseGroups(tree, rowsFor({ N2: "A", N3: "A", N5: "A", N6: "A", N7: "B" }), "tip", "group"))
    .toEqual([{ node: 1, label: "A", tipCount: 2 }, { node: 4, label: "A", tipCount: 2 }]);
});

test("does not merge matching siblings into an invented clade within a mixed polytomy", () => {
  const tree = treeFromParents([-1, 0, 0, 0]);
  expect(buildMetadataCollapseGroups(tree, rowsFor({ N1: "A", N2: "A", N3: "B" }), "tip", "group")).toEqual([]);
  expect(buildMetadataCollapseGroups(tree, rowsFor({ N1: "A", N2: "A", N3: "A" }), "tip", "group"))
    .toEqual([{ node: 0, label: "A", tipCount: 3 }]);
});

test("keeps different homogeneous categories as separate maximal clades", () => {
  const tree = treeFromParents([-1, 0, 1, 1, 0, 4, 4]);
  expect(buildMetadataCollapseGroups(tree, rowsFor({ N2: "A", N3: "A", N5: "B", N6: "B" }), "tip", "group"))
    .toEqual([{ node: 1, label: "A", tipCount: 2 }, { node: 4, label: "B", tipCount: 2 }]);
});

for (const missing of [undefined, "", " \t "]) {
  test(`missing tip value ${JSON.stringify(missing)} blocks ancestors but not a complete child clade`, () => {
    const tree = treeFromParents([-1, 0, 1, 1, 0]);
    const rows = rowsFor({ N2: "A", N3: "A" });
    if (missing !== undefined) rows.push({ tip: "N4", group: missing });
    else rows.push({ tip: "N4" });
    expect(buildMetadataCollapseGroups(tree, rows, "tip", "group"))
      .toEqual([{ node: 1, label: "A", tipCount: 2 }]);
  });
}

test("unmatched tips block collapse, and internal node rows do not fill descendant metadata", () => {
  const tree = treeFromParents([-1, 0, 0], ["Root", "A", "B"]);
  expect(buildMetadataCollapseGroups(tree, rowsFor({ Root: "X", A: "X", Unmatched: "X" }), "tip", "group")).toEqual([]);
  expect(buildMetadataCollapseGroups(tree, rowsFor({ Root: "Other", A: "X", B: "X" }), "tip", "group"))
    .toEqual([{ node: 0, label: "X", tipCount: 2 }]);
});

test("uses the existing metadata key normalization and trims category values", () => {
  const tree = treeFromParents([-1, 0, 0], ["Root", "'Alpha_beta'", '"GAMMA   delta"']);
  const rows = [{ tip: ' "ALPHA   BETA" ', group: " Habitat_A " }, { tip: "gamma_delta", group: "Habitat_A" }];
  expect(buildMetadataCollapseGroups(tree, rows, "tip", "group"))
    .toEqual([{ node: 0, label: "Habitat_A", tipCount: 2 }]);
});

test("does not apply key normalization to category values", () => {
  const tree = treeFromParents([-1, 0, 0]);
  for (const value of ["a", "'A'", "A_", "A B"]) {
    expect(buildMetadataCollapseGroups(tree, rowsFor({ N1: "A", N2: value }), "tip", "group")).toEqual([]);
  }
  expect(buildMetadataCollapseGroups(tree, rowsFor({ N1: "0", N2: "0" }), "tip", "group"))
    .toEqual([{ node: 0, label: "0", tipCount: 2 }]);
});

test("accepts agreeing duplicate normalized keys and matches all duplicate tree labels", () => {
  const tree = treeFromParents([-1, 0, 0], ["Root", "Alpha_beta", "ALPHA BETA"]);
  const rows = [{ tip: "alpha beta", group: "X" }, { tip: "'Alpha_beta'", group: " X " }];
  expect(buildMetadataCollapseGroups(tree, rows, "tip", "group"))
    .toEqual([{ node: 0, label: "X", tipCount: 2 }]);
});

test("conflicting duplicate normalized keys stay blocked in every row order", () => {
  const tree = treeFromParents([-1, 0, 0], ["Root", "Alpha_beta", "B"]);
  for (const conflict of ["Y", "", "  "]) {
    const rows = [
      { tip: "alpha beta", group: "X" },
      { tip: "'ALPHA_BETA'", group: conflict },
      { tip: "alpha_beta", group: "X" },
      { tip: "B", group: "X" },
    ];
    for (let offset = 0; offset < rows.length; offset += 1) {
      const rotated = [...rows.slice(offset), ...rows.slice(0, offset)];
      expect(buildMetadataCollapseGroups(tree, rotated, "tip", "group")).toEqual([]);
      expect(buildMetadataCollapseGroups(tree, rotated.reverse(), "tip", "group")).toEqual([]);
    }
  }
});

test("ambiguous keys block only affected clades", () => {
  const tree = treeFromParents([-1, 0, 1, 1, 0, 4, 4]);
  const rows = [...rowsFor({ N2: "A", N3: "A", N5: "B", N6: "B" }), { tip: "n5", group: "C" }];
  expect(buildMetadataCollapseGroups(tree, rows, "tip", "group"))
    .toEqual([{ node: 1, label: "A", tipCount: 2 }]);
});

test("empty keys cannot match unnamed tips and prototype-like names remain ordinary keys", () => {
  const tree = treeFromParents([-1, 0, 0], ["Root", "", "B"]);
  expect(buildMetadataCollapseGroups(tree, [{ tip: " ", group: "X" }, { tip: "B", group: "X" }], "tip", "group")).toEqual([]);
  tree.names = ["Root", "constructor", "toString"];
  expect(buildMetadataCollapseGroups(tree, rowsFor({ constructor: "X", toString: "X" }), "tip", "group"))
    .toEqual([{ node: 0, label: "X", tipCount: 2 }]);
});

test("handles empty trees, empty selections, absent columns, singleton tips, and unary chains", () => {
  expect(buildMetadataCollapseGroups(treeFromParents([]), [], "tip", "group")).toEqual([]);
  for (const parents of [[-1], [-1, 0, 1]]) {
    const tree = treeFromParents(parents);
    expect(buildMetadataCollapseGroups(tree, rowsFor({ [`N${parents.length - 1}`]: "A" }), "tip", "group")).toEqual([]);
  }
  const tree = treeFromParents([-1, 0, 0]);
  const rows = rowsFor({ N1: "A", N2: "A" });
  for (const [key, value] of [["", "group"], ["tip", ""], ["absent", "group"], ["tip", "absent"]]) {
    expect(buildMetadataCollapseGroups(tree, rows, key, value)).toEqual([]);
  }
  expect(buildMetadataCollapseGroups(tree, [], "tip", "group")).toEqual([]);
});

test("supports nonzero roots and arbitrary node numbering after rerooting", () => {
  const tree = treeFromParents([3, 4, 3, 4, -1]);
  const rows = rowsFor({ N0: "A", N1: "B", N2: "A" });
  expect(buildMetadataCollapseGroups(tree, rows, "tip", "group"))
    .toEqual([{ node: 3, label: "A", tipCount: 2 }]);
  rows[1].group = "A";
  expect(buildMetadataCollapseGroups(tree, rows, "tip", "group"))
    .toEqual([{ node: 4, label: "A", tipCount: 3 }]);
});

test("does not mutate the tree, metadata rows, or previously returned groups", () => {
  const tree = treeFromParents([-1, 0, 1, 1, 0]);
  const rows = Object.freeze(rowsFor({ N2: " A ", N3: "A", N4: "B" }).map(row => Object.freeze(row)));
  const before = structuredClone(tree);
  const result = buildMetadataCollapseGroups(tree, rows, "tip", "group");
  expect(result).toEqual([{ node: 1, label: "A", tipCount: 2 }]);
  result[0].label = "Changed";
  expect(buildMetadataCollapseGroups(tree, rows, "tip", "group"))
    .toEqual([{ node: 1, label: "A", tipCount: 2 }]);
  expect(tree).toEqual(before);
  expect(rows[0].group).toBe(" A ");
});

test("handles a deep comb iteratively without scanning ancestors per candidate", () => {
  const depth = 30_000;
  const parents = [-1];
  const rows: Array<Record<string, string>> = [];
  for (let node = 1; node < depth; node += 1) parents.push(node - 1);
  for (let node = 0; node < depth; node += 1) {
    rows.push({ tip: `N${parents.length}`, group: "A" });
    parents.push(node);
  }
  rows.push({ tip: `N${parents.length}`, group: "A" });
  parents.push(depth - 1);
  const tree = treeFromParents(parents);
  expect(buildMetadataCollapseGroups(tree, rows, "tip", "group"))
    .toEqual([{ node: 0, label: "A", tipCount: depth + 1 }]);
  rows[0].group = "B";
  expect(buildMetadataCollapseGroups(tree, rows, "tip", "group"))
    .toEqual([{ node: 1, label: "A", tipCount: depth }]);
});

test("reads each metadata row once for a large polytomy", () => {
  const count = 30_000;
  const tree = treeFromParents([-1, ...new Array<number>(count).fill(0)]);
  let keyReads = 0;
  let valueReads = 0;
  const rows = Array.from({ length: count }, (_, index) => ({
    get tip() { keyReads += 1; return `N${index + 1}`; },
    get group() { valueReads += 1; return "A"; },
  }));
  expect(buildMetadataCollapseGroups(tree, rows, "tip", "group"))
    .toEqual([{ node: 0, label: "A", tipCount: count }]);
  expect(keyReads).toBe(count);
  expect(valueReads).toBe(count);
});
