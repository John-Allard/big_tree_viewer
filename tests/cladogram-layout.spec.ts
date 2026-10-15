import { expect, test } from "@playwright/test";
import { createCladogramTree, normalizeCladogramLogStrength, ULTRAMETRIC_CLADOGRAM_METHODS } from "../src/lib/cladogram";
import { parseSharedSubtreeStoragePayload } from "../src/lib/sharedSubtreePayload";
import type { TreeModel } from "../src/types/tree";

function treeFromParents(parents: number[]): TreeModel {
  const nodeCount = parents.length;
  const firstChild = new Int32Array(nodeCount).fill(-1);
  const nextSibling = new Int32Array(nodeCount).fill(-1);
  const branchLength = Float64Array.from(parents, (_, node) => node === 0 ? 0 : node + 1);
  const depth = new Float64Array(nodeCount);
  for (let node = 1; node < nodeCount; node += 1) {
    const parent = parents[node];
    nextSibling[node] = firstChild[parent];
    firstChild[parent] = node;
    depth[node] = depth[parent] + branchLength[node];
  }
  const leafCount = new Int32Array(nodeCount);
  const leaves: number[] = [];
  for (let node = nodeCount - 1; node >= 0; node -= 1) {
    if (firstChild[node] < 0) {
      leafCount[node] = 1;
      leaves.push(node);
    }
    if (parents[node] >= 0) leafCount[parents[node]] += leafCount[node];
  }
  const layout = { center: new Float64Array(nodeCount), min: new Float64Array(nodeCount), max: new Float64Array(nodeCount) };
  return {
    root: 0, nodeCount, leafCount: leaves.length,
    leafNodes: Int32Array.from(leaves), names: parents.map((_, node) => `N${node}`),
    maxDepth: Math.max(...depth), rootAge: Math.max(...depth),
    branchLengthMinPositive: 2, hasBranchLengths: true, isUltrametric: false,
    nodeIntervalLower: new Float64Array(nodeCount), nodeIntervalUpper: new Float64Array(nodeCount), nodeIntervalCount: 0,
    buffers: { parent: Int32Array.from(parents), firstChild, nextSibling, branchLength, depth, leafCount },
    layouts: { input: layout, asc: layout, desc: layout },
  };
}

test("Grafen heights use descendant counts throughout an unbalanced tree", () => {
  const source = treeFromParents([-1, 0, 1, 2, 2, 1, 0]);
  const originalDepths = Array.from(source.buffers.depth);
  const result = createCladogramTree(source, true, "grafen");
  const expected = [0, 1 / 3, 2 / 3, 1, 1, 1, 1];
  expected.forEach((depth, node) => expect(result.buffers.depth[node]).toBeCloseTo(depth, 12));
  expect(result.branchLengthMinPositive).toBeCloseTo(1 / 3, 12);
  expect(result.maxDepth).toBe(1);
  expect(result.rootAge).toBe(1);
  expect(result.isUltrametric).toBe(true);
  expect(result.buffers.depth).not.toBe(source.buffers.depth);
  expect(result.buffers.branchLength).toBe(source.buffers.branchLength);
  expect(result.buffers.parent).toBe(source.buffers.parent);
  expect(result.layouts).toBe(source.layouts);
  expect(Array.from(source.buffers.depth)).toEqual(originalDepths);
});

test("Grafen heights support polytomies without resolving them", () => {
  const source = treeFromParents([-1, 0, 0, 0, 3, 3, 3]);
  const result = createCladogramTree(source, true, "grafen");
  expect(Array.from(result.buffers.depth)).toEqual([0, 1, 1, 0.5, 1, 1, 1]);
  expect(result.branchLengthMinPositive).toBe(0.5);
  expect(result.buffers.firstChild).toBe(source.buffers.firstChild);
  expect(result.buffers.nextSibling).toBe(source.buffers.nextSibling);
});

test("Grafen redistributes internal nodes rather than only extending terminal edges", () => {
  const source = treeFromParents([-1, 0, 0, 1, 1, 2, 2, 2, 5, 5]);
  const result = createCladogramTree(source, true, "grafen");
  expect(Array.from(result.buffers.depth)).toEqual([0, 0.8, 0.4, 1, 1, 0.8, 1, 1, 1, 1]);
  expect(result.branchLengthMinPositive).toBeCloseTo(0.2, 12);
});

test("Grafen heights preserve zero display lengths at unary nodes", () => {
  const result = createCladogramTree(treeFromParents([-1, 0, 1, 1]), true, "grafen");
  expect(Array.from(result.buffers.depth)).toEqual([0, 0, 1, 1]);
  expect(result.branchLengthMinPositive).toBe(1);
  expect(result.isUltrametric).toBe(true);
});

test("single-tip Grafen layouts have finite coordinates and zoom bounds", () => {
  for (const parents of [[-1], [-1, 0, 1]]) {
    const result = createCladogramTree(treeFromParents(parents), true, "grafen");
    expect(Array.from(result.buffers.depth)).toEqual(parents.map(() => 0));
    expect(result.maxDepth).toBe(0);
    expect(result.isUltrametric).toBe(true);
    expect(result.branchLengthMinPositive).toBe(1);
  }
});

test("ordinary cladograms give every edge unit display length", () => {
  const source = treeFromParents([-1, 0, 1, 2, 2, 1, 0]);
  const result = createCladogramTree(source, false);
  expect(Array.from(result.buffers.depth)).toEqual([0, 1, 2, 3, 3, 2, 1]);
  expect(result.maxDepth).toBe(3);
  expect(result.isUltrametric).toBe(false);
  expect(result.branchLengthMinPositive).toBe(1);
  expect(result.buffers.branchLength).toBe(source.buffers.branchLength);
});

test("branching levels redistribute internal stems from the tips upward", () => {
  const source = treeFromParents([-1, 0, 0, 1, 1, 2, 2, 2, 5, 5]);
  const result = createCladogramTree(source, true);
  const expected = [0, 2 / 3, 1 / 3, 1, 1, 2 / 3, 1, 1, 1, 1];
  expected.forEach((depth, node) => expect(result.buffers.depth[node]).toBeCloseTo(depth, 12));
  expect(result.branchLengthMinPositive).toBeCloseTo(1 / 3, 12);
  // The old root-first layout put both root children at one third of the span.
  expect(result.buffers.depth[1]).not.toBe(result.buffers.depth[2]);
});

test("branching levels work after node indices are reordered by rerooting", () => {
  const source = treeFromParents([-1, 0, 0, 1, 1, 2, 2, 2, 5, 5]);
  const flip = (node: number) => node < 0 ? node : source.nodeCount - 1 - node;
  const reversed = {
    ...source,
    root: flip(source.root),
    names: [...source.names].reverse(),
    leafNodes: source.leafNodes.map(flip),
    buffers: {
      parent: source.buffers.parent.map(flip).reverse(),
      firstChild: source.buffers.firstChild.map(flip).reverse(),
      nextSibling: source.buffers.nextSibling.map(flip).reverse(),
      leafCount: source.buffers.leafCount.slice().reverse(),
      depth: source.buffers.depth.slice().reverse(),
      branchLength: source.buffers.branchLength.slice().reverse(),
    },
  };
  const expected = Array.from(createCladogramTree(source, true).buffers.depth).reverse();
  expect(Array.from(createCladogramTree(reversed, true).buffers.depth)).toEqual(expected);
});

test("logarithmic heights space successive doublings of clade size equally", () => {
  const source = treeFromParents([-1, 0, 0, 1, 1, 2, 2, 2, 5, 5]);
  const result = createCladogramTree(source, true, "logarithmic");
  const expected = [0, 1 - Math.log(2) / Math.log(6), 1 - Math.log(4) / Math.log(6), 1, 1, 1 - Math.log(2) / Math.log(6), 1, 1, 1, 1];
  expected.forEach((depth, node) => expect(result.buffers.depth[node]).toBeCloseTo(depth, 12));
  expect(1 - result.buffers.depth[1]).toBeCloseTo(result.buffers.depth[1] - result.buffers.depth[2], 12);
});

test("logarithmic strength redistributes internal heights monotonically without moving tips", () => {
  const source = treeFromParents([-1, 0, 0, 1, 1, 2, 2, 2, 5, 5]);
  const originalDepths = Array.from(source.buffers.depth);
  let previous: Float64Array | undefined;
  for (const strength of [1, 2, 4, 7, 10]) {
    const result = createCladogramTree(source, true, "logarithmic", strength);
    for (let node = 0; node < source.nodeCount; node++) {
      const parent = source.buffers.parent[node];
      const expected = 1 - Math.pow(Math.log(source.buffers.leafCount[node]) / Math.log(source.leafCount), strength);
      expect(result.buffers.depth[node]).toBeCloseTo(expected, 12);
      if (previous && node !== source.root && source.buffers.firstChild[node] >= 0) {
        expect(result.buffers.depth[node]).toBeGreaterThan(previous[node]);
      }
      if (parent >= 0) expect(result.buffers.depth[node]).toBeGreaterThanOrEqual(result.buffers.depth[parent]);
    }
    for (const leaf of source.leafNodes) expect(result.buffers.depth[leaf]).toBe(1);
    expect(result.buffers.depth[source.root]).toBe(0);
    expect(result.buffers.branchLength).toBe(source.buffers.branchLength);
    expect(Array.from(source.buffers.depth)).toEqual(originalDepths);
    previous = result.buffers.depth;
  }
  for (const method of ["levels", "grafen"] as const) {
    expect(createCladogramTree(source, true, method, 1).buffers.depth)
      .toEqual(createCladogramTree(source, true, method, 10).buffers.depth);
  }
  expect(createCladogramTree(source, false, "logarithmic", 1).buffers.depth)
    .toEqual(createCladogramTree(source, false, "logarithmic", 10).buffers.depth);
});

test("logarithmic strength clamps unsafe launch values and has a backward-compatible default", () => {
  const parse = (value: unknown) => parseSharedSubtreeStoragePayload(JSON.stringify({ newick: "(A,B);", visual: { cladogramLogStrength: value } })).visual!;
  for (const value of [undefined, null, "2", NaN, Infinity]) {
    expect(normalizeCladogramLogStrength(value)).toBe(1);
    expect(parse(value).cladogramLogStrength).toBe(1);
  }
  for (const [input, expected] of [[-10, 1], [0, 1], [0.75, 1], [2.5, 2.5], [40, 10]]) {
    expect(normalizeCladogramLogStrength(input)).toBe(expected);
    expect(parse(input).cladogramLogStrength).toBe(expected);
  }
});

test("logarithmic strength remains finite and ordered on a 7600-tip unbalanced tree", () => {
  const parents = [-1];
  const leaves = [0];
  let seed = 7127;
  while (leaves.length < 7600) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const index = seed % leaves.length;
    const parent = leaves[index];
    leaves[index] = parents.length;
    leaves.push(parents.length + 1);
    parents.push(parent, parent);
  }
  const source = treeFromParents(parents);
  for (const strength of [1, 4, 10]) {
    const result = createCladogramTree(source, true, "logarithmic", strength);
    let invalid = 0;
    for (let node = 0; node < source.nodeCount; node++) {
      const depth = result.buffers.depth[node];
      const parent = source.buffers.parent[node];
      if (!Number.isFinite(depth) || depth < 0 || depth > 1 || (parent >= 0 && depth < result.buffers.depth[parent])) invalid++;
    }
    expect(invalid).toBe(0);
    expect(source.leafCount).toBe(7600);
    expect(Array.from(source.leafNodes, node => result.buffers.depth[node])).toEqual(leaves.map(() => 1));
    expect(result.buffers.branchLength).toBe(source.buffers.branchLength);
  }
});

for (const method of ULTRAMETRIC_CLADOGRAM_METHODS) {
  test(`${method} aligns tips without using input lengths or changing topology`, () => {
    for (const parents of [
      [-1], [-1, 0, 1], [-1, 0, 1, 1],
      [-1, 0, 0, 0], [-1, 0, 1, 2, 2, 1, 0],
      [-1, 0, 0, 1, 1, 2, 2, 2, 5, 5],
    ]) {
      const source = treeFromParents(parents);
      const originalDepths = Array.from(source.buffers.depth);
      const result = createCladogramTree(source, true, method);
      for (const leaf of source.leafNodes) expect(result.buffers.depth[leaf]).toBe(result.maxDepth);
      for (let node = 0; node < source.nodeCount; node += 1) {
        const parent = source.buffers.parent[node];
        expect(Number.isFinite(result.buffers.depth[node])).toBe(true);
        if (parent >= 0) expect(result.buffers.depth[node]).toBeGreaterThanOrEqual(result.buffers.depth[parent]);
      }
      expect(result.buffers.parent).toBe(source.buffers.parent);
      expect(result.buffers.branchLength).toBe(source.buffers.branchLength);
      expect(result.isUltrametric).toBe(true);
      expect(result.branchLengthMinPositive).toBeGreaterThan(0);
      expect(Array.from(source.buffers.depth)).toEqual(originalDepths);
      const altered = { ...source, buffers: { ...source.buffers, branchLength: source.buffers.branchLength.map(length => length * 932 + 500), depth: source.buffers.depth.map(depth => depth * 932 + 500) } };
      expect(Array.from(createCladogramTree(altered, true, method).buffers.depth)).toEqual(Array.from(result.buffers.depth));
    }
  });
}

test("shared cladograms default to equal edges and preserve each ultrametric layout choice", () => {
  const parse = (visual: object) => parseSharedSubtreeStoragePayload(JSON.stringify({ newick: "(A,B);", visual })).visual!;
  expect(parse({}).showCladogram).toBe(false);
  expect(parse({ showCladogram: true }).ultrametricCladogram).toBe(false);
  expect(parse({ showCladogram: true, ultrametricCladogram: true }).ultrametricCladogram).toBe(true);
  expect(parse({}).ultrametricCladogramMethod).toBe("levels");
  expect(parse({ ultrametricCladogramMethod: "unknown" }).ultrametricCladogramMethod).toBe("levels");
  for (const method of ULTRAMETRIC_CLADOGRAM_METHODS) {
    expect(parse({ ultrametricCladogramMethod: method }).ultrametricCladogramMethod).toBe(method);
  }
});
