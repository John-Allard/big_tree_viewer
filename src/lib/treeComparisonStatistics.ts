import type { TreeModel } from "../types/tree";
import { normalizeComparisonTipName } from "./treeComparison";

export interface TreeComparisonStatistics {
  sharedTipCount: number;
  primaryOnlyTipCount: number;
  comparisonOnlyTipCount: number;
  primaryGroupCount: number;
  comparisonGroupCount: number;
  sharedGroupCount: number;
  robinsonFouldsDistance: number;
  normalizedRobinsonFouldsDistance: number;
}

function uniqueTipsByName(tree: TreeModel): Map<string, number> {
  const result = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const node of tree.leafNodes) {
    const name = normalizeComparisonTipName(tree.names[node] ?? "");
    if (!name) {
      continue;
    }
    if (result.has(name)) {
      duplicates.add(name);
    } else {
      result.set(name, node);
    }
  }
  duplicates.forEach((name) => result.delete(name));
  return result;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function collectGroups(tree: TreeModel, sharedIdByName: Map<string, number>): Set<string> {
  const count = new Uint32Array(tree.nodeCount);
  const sumA = new Uint32Array(tree.nodeCount);
  const sumB = new Uint32Array(tree.nodeCount);
  const xor = new Uint32Array(tree.nodeCount);
  const keys = new Set<string>();
  const stack: Array<{ node: number; visited: boolean }> = [{ node: tree.root, visited: false }];

  while (stack.length > 0) {
    const item = stack.pop()!;
    const firstChild = tree.buffers.firstChild[item.node];
    if (!item.visited && firstChild >= 0) {
      stack.push({ node: item.node, visited: true });
      for (let child = firstChild; child >= 0; child = tree.buffers.nextSibling[child]) {
        stack.push({ node: child, visited: false });
      }
      continue;
    }

    if (firstChild < 0) {
      const id = sharedIdByName.get(normalizeComparisonTipName(tree.names[item.node] ?? ""));
      if (id !== undefined) {
        const token = id + 1;
        count[item.node] = 1;
        sumA[item.node] = mix32(token);
        sumB[item.node] = mix32(token ^ 0x9e3779b9);
        xor[item.node] = mix32(token ^ 0x85ebca6b);
      }
      continue;
    }

    for (let child = firstChild; child >= 0; child = tree.buffers.nextSibling[child]) {
      count[item.node] += count[child];
      sumA[item.node] = (sumA[item.node] + sumA[child]) >>> 0;
      sumB[item.node] = (sumB[item.node] + sumB[child]) >>> 0;
      xor[item.node] ^= xor[child];
    }
    if (count[item.node] <= 1 || count[item.node] >= sharedIdByName.size) {
      continue;
    }
    keys.add(`${count[item.node]}:${sumA[item.node]}:${sumB[item.node]}:${xor[item.node] >>> 0}`);
  }
  return keys;
}

export function computeTreeComparisonStatistics(
  primaryTree: TreeModel,
  comparisonTree: TreeModel,
): TreeComparisonStatistics {
  const primaryTips = uniqueTipsByName(primaryTree);
  const comparisonTips = uniqueTipsByName(comparisonTree);
  const sharedNames = [...primaryTips.keys()].filter((name) => comparisonTips.has(name)).sort();
  const sharedIdByName = new Map(sharedNames.map((name, index) => [name, index] as const));
  const primaryGroups = collectGroups(primaryTree, sharedIdByName);
  const comparisonGroups = collectGroups(comparisonTree, sharedIdByName);
  let sharedGroupCount = 0;
  primaryGroups.forEach((key) => {
    if (comparisonGroups.has(key)) {
      sharedGroupCount += 1;
    }
  });
  const rf = primaryGroups.size + comparisonGroups.size - (2 * sharedGroupCount);
  const rfMaximum = primaryGroups.size + comparisonGroups.size;

  return {
    sharedTipCount: sharedNames.length,
    primaryOnlyTipCount: primaryTips.size - sharedNames.length,
    comparisonOnlyTipCount: comparisonTips.size - sharedNames.length,
    primaryGroupCount: primaryGroups.size,
    comparisonGroupCount: comparisonGroups.size,
    sharedGroupCount,
    robinsonFouldsDistance: rf,
    normalizedRobinsonFouldsDistance: rfMaximum > 0 ? rf / rfMaximum : 0,
  };
}
