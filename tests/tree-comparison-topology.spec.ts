import { expect, test } from "@playwright/test";
import { buildComparisonLayout } from "../src/lib/treeComparison";
import { analyzeTreeComparisonTopology } from "../src/lib/treeComparisonTopology";
import type { TreeModel } from "../src/types/tree";

type NestedTree = string | NestedTree[];

function treeFromNested(nested: NestedTree): TreeModel {
  const names: string[] = [];
  const parent: number[] = [];
  const children: number[][] = [];
  const visit = (value: NestedTree, parentNode = -1): number => {
    const node = names.length;
    names.push(typeof value === "string" ? value : "");
    parent.push(parentNode);
    children.push([]);
    if (Array.isArray(value)) {
      value.forEach((child) => children[node].push(visit(child, node)));
    }
    return node;
  };
  const root = visit(nested);
  const nodeCount = names.length;
  const firstChild = new Int32Array(nodeCount).fill(-1);
  const nextSibling = new Int32Array(nodeCount).fill(-1);
  children.forEach((nodeChildren, node) => {
    if (nodeChildren.length > 0) firstChild[node] = nodeChildren[0];
    for (let index = 0; index + 1 < nodeChildren.length; index += 1) {
      nextSibling[nodeChildren[index]] = nodeChildren[index + 1];
    }
  });
  const leafNodes = names.map((_, node) => node).filter((node) => firstChild[node] < 0);
  const center = new Float64Array(nodeCount);
  const min = new Float64Array(nodeCount);
  const max = new Float64Array(nodeCount);
  leafNodes.forEach((node, index) => {
    center[node] = index;
    min[node] = index;
    max[node] = index;
  });
  for (let node = nodeCount - 1; node >= 0; node -= 1) {
    if (firstChild[node] < 0) continue;
    const nodeChildren = children[node];
    min[node] = Math.min(...nodeChildren.map((child) => min[child]));
    max[node] = Math.max(...nodeChildren.map((child) => max[child]));
    center[node] = (center[nodeChildren[0]] + center[nodeChildren[nodeChildren.length - 1]]) / 2;
  }
  const branchLength = new Float64Array(nodeCount);
  branchLength.fill(1);
  branchLength[root] = 0;
  const depth = new Float64Array(nodeCount);
  for (let node = 0; node < nodeCount; node += 1) {
    depth[node] = parent[node] < 0 ? 0 : depth[parent[node]] + 1;
  }
  const descendantLeafCount = new Int32Array(nodeCount);
  for (let node = nodeCount - 1; node >= 0; node -= 1) {
    descendantLeafCount[node] = firstChild[node] < 0
      ? 1
      : children[node].reduce((total, child) => total + descendantLeafCount[child], 0);
  }
  const layout = { center, min, max };
  return {
    root,
    nodeCount,
    leafCount: leafNodes.length,
    maxDepth: Math.max(...leafNodes.map((node) => depth[node])),
    rootAge: 0,
    hasBranchLengths: true,
    isUltrametric: false,
    leafNodes: Int32Array.from(leafNodes),
    names,
    nodeIntervalLower: new Float64Array(nodeCount),
    nodeIntervalUpper: new Float64Array(nodeCount),
    nodeIntervalCount: 0,
    branchLengthMinPositive: 1,
    buffers: {
      parent: Int32Array.from(parent),
      firstChild,
      nextSibling,
      branchLength,
      depth,
      leafCount: descendantLeafCount,
    },
    layouts: { input: layout, desc: layout, asc: layout },
  };
}

function crossingCount(layout: ReturnType<typeof buildComparisonLayout>): number {
  let result = 0;
  for (let left = 0; left < layout.commonPairs.length; left += 1) {
    for (let right = left + 1; right < layout.commonPairs.length; right += 1) {
      const a = layout.commonPairs[left];
      const b = layout.commonPairs[right];
      if ((a.primaryPosition - b.primaryPosition) * (a.comparisonPosition - b.comparisonPosition) < 0) {
        result += 1;
      }
    }
  }
  return result;
}

test("comparison ordering perfectly aligns rotated copies of one rooted topology", () => {
  const primary = treeFromNested([["A", "B"], ["C", "D"]]);
  const comparison = treeFromNested([["D", "C"], ["B", "A"]]);
  expect(crossingCount(buildComparisonLayout(primary, comparison, "input"))).toBe(0);
});

test("comparison ordering finds the exact minimum for a small multifurcation", () => {
  const primary = treeFromNested(["A0", "C0", "C1", "B0", "A1", "A2"]);
  const comparison = treeFromNested([["A0", "A1", "A2"], ["B0"], ["C0", "C1"]]);
  const layout = buildComparisonLayout(primary, comparison, "input");
  expect(crossingCount(layout)).toBe(3);
  expect(layout.comparisonLeaves.map((node) => comparison.names[node])).toEqual([
    "C0", "C1", "B0", "A0", "A1", "A2",
  ]);
});

test("root analysis finds an exact reroot edge for differently rooted copies of one unrooted tree", () => {
  const primary = treeFromNested(["A", [["B", "C"], ["D", "E"]]]);
  const comparison = treeFromNested([["B", "C"], ["A", ["D", "E"]]]);
  const analysis = analyzeTreeComparisonTopology(primary, comparison);
  expect(analysis.root.available).toBe(true);
  expect(analysis.root.rootsMatch).toBe(false);
  expect(analysis.root.exactMatchAvailable).toBe(true);
  expect(analysis.root.bestMismatchCount).toBe(0);
  expect(analysis.root.canImprove).toBe(true);
  expect(analysis.incompatiblePrimarySplitCount).toBe(0);
});

test("root analysis distinguishes a closest approximate root from an exact match", () => {
  const primary = treeFromNested([["A", "B"], ["C", ["D", "E"]]]);
  const comparison = treeFromNested([["A", "C"], ["B", ["D", "E"]]]);
  const analysis = analyzeTreeComparisonTopology(primary, comparison);
  expect(analysis.root.available).toBe(true);
  expect(analysis.root.rootsMatch).toBe(false);
  expect(analysis.root.exactMatchAvailable).toBe(false);
  expect(analysis.root.bestMismatchCount).toBeGreaterThan(0);
  expect(analysis.incompatiblePrimarySplitCount).toBe(1);
  expect(analysis.incompatiblePrimaryNodes.size).toBe(1);
});

test("root analysis matches a trifurcating unrooted root to the corresponding comparison node", () => {
  const primary = treeFromNested([["A", "B"], ["C", "D"], ["E", "F"]]);
  const comparison = treeFromNested(["A", ["B", [["C", "D"], ["E", "F"]]]]);
  const analysis = analyzeTreeComparisonTopology(primary, comparison);
  expect(analysis.root.available).toBe(true);
  expect(analysis.root.originalRootKind).toBe("node");
  expect(analysis.root.leftRootGroupSizes).toEqual([2, 2, 2]);
  expect(analysis.root.rootsMatch).toBe(false);
  expect(analysis.root.exactMatchAvailable).toBe(true);
  expect(analysis.root.bestCandidateKind).toBe("node");
  expect(analysis.root.bestMismatchCount).toBe(0);
  expect(analysis.root.canImprove).toBe(true);
});
