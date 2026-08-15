import type { LayoutOrder, TreeModel } from "../types/tree";

export interface ComparisonLayout {
  primaryLeaves: number[];
  comparisonLeaves: number[];
  comparisonCenter: Float64Array;
  commonPairs: Array<{
    name: string;
    primaryNode: number;
    comparisonNode: number;
    primaryPosition: number;
    comparisonPosition: number;
    discordance: number;
  }>;
  primaryOnlyCount: number;
  comparisonOnlyCount: number;
}

export function normalizeComparisonTipName(value: string): string {
  return value.trim().replaceAll("_", " ").replace(/\s+/g, " ").toLocaleLowerCase();
}

function uniqueTipNodesByName(tree: TreeModel, leaves: number[]): Map<string, number> {
  const nodes = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const node of leaves) {
    const key = normalizeComparisonTipName(tree.names[node] ?? "");
    if (!key) {
      continue;
    }
    if (nodes.has(key)) {
      duplicates.add(key);
    } else {
      nodes.set(key, node);
    }
  }
  for (const key of duplicates) {
    nodes.delete(key);
  }
  return nodes;
}

export function buildComparisonLayout(
  primaryTree: TreeModel,
  comparisonTree: TreeModel,
  order: LayoutOrder,
): ComparisonLayout {
  const primaryLeaves = [...primaryTree.leafNodes].sort(
    (left, right) => primaryTree.layouts[order].center[left] - primaryTree.layouts[order].center[right],
  );
  const primaryByName = uniqueTipNodesByName(primaryTree, primaryLeaves);
  const comparisonInputByName = uniqueTipNodesByName(comparisonTree, [...comparisonTree.leafNodes]);
  const sharedKeys = new Set(
    [...primaryByName.keys()].filter((key) => comparisonInputByName.has(key)),
  );
  const primarySharedLeaves = primaryLeaves.filter((node) => {
    const key = normalizeComparisonTipName(primaryTree.names[node] ?? "");
    return sharedKeys.has(key) && primaryByName.get(key) === node;
  });
  const primaryRank = new Map<string, number>();
  primarySharedLeaves.forEach((node, index) => {
    const key = normalizeComparisonTipName(primaryTree.names[node] ?? "");
    primaryRank.set(key, index);
  });

  const { firstChild, nextSibling } = comparisonTree.buffers;
  const childOrder = new Map<number, number[]>();
  const scoreTotal = new Float64Array(comparisonTree.nodeCount);
  const scoreCount = new Uint32Array(comparisonTree.nodeCount);
  const stack: Array<{ node: number; visited: boolean }> = [{ node: comparisonTree.root, visited: false }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (!item.visited) {
      stack.push({ node: item.node, visited: true });
      for (let child = firstChild[item.node]; child >= 0; child = nextSibling[child]) {
        stack.push({ node: child, visited: false });
      }
      continue;
    }
    if (firstChild[item.node] < 0) {
      const key = normalizeComparisonTipName(comparisonTree.names[item.node] ?? "");
      const rank = primaryRank.get(key);
      if (rank !== undefined) {
        scoreTotal[item.node] = rank;
        scoreCount[item.node] = 1;
      }
      continue;
    }
    const children: number[] = [];
    for (let child = firstChild[item.node]; child >= 0; child = nextSibling[child]) {
      children.push(child);
      scoreTotal[item.node] += scoreTotal[child];
      scoreCount[item.node] += scoreCount[child];
    }
    children.sort((left, right) => {
      const leftCount = scoreCount[left];
      const rightCount = scoreCount[right];
      if (leftCount === 0 || rightCount === 0) {
        return leftCount === rightCount ? 0 : leftCount === 0 ? 1 : -1;
      }
      return (scoreTotal[left] / leftCount) - (scoreTotal[right] / rightCount);
    });
    childOrder.set(item.node, children);
  }

  const comparisonLeaves: number[] = [];
  const traversal = [comparisonTree.root];
  while (traversal.length > 0) {
    const node = traversal.pop()!;
    const children = childOrder.get(node);
    if (!children || children.length === 0) {
      comparisonLeaves.push(node);
      continue;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      traversal.push(children[index]);
    }
  }

  const comparisonCenter = new Float64Array(comparisonTree.nodeCount);
  comparisonLeaves.forEach((node, index) => {
    comparisonCenter[node] = index;
  });
  const centerStack: Array<{ node: number; visited: boolean }> = [{ node: comparisonTree.root, visited: false }];
  while (centerStack.length > 0) {
    const item = centerStack.pop()!;
    const children = childOrder.get(item.node);
    if (!children || children.length === 0) {
      continue;
    }
    if (!item.visited) {
      centerStack.push({ node: item.node, visited: true });
      for (const child of children) {
        centerStack.push({ node: child, visited: false });
      }
      continue;
    }
    comparisonCenter[item.node] = (comparisonCenter[children[0]] + comparisonCenter[children[children.length - 1]]) / 2;
  }

  const comparisonByName = uniqueTipNodesByName(comparisonTree, comparisonLeaves);
  const primaryIndexByNode = new Map<number, number>();
  primaryLeaves.forEach((node, index) => primaryIndexByNode.set(node, index));
  const comparisonIndexByNode = new Map<number, number>();
  comparisonLeaves.forEach((node, index) => comparisonIndexByNode.set(node, index));
  const primaryDenominator = Math.max(1, primaryLeaves.length - 1);
  const comparisonDenominator = Math.max(1, comparisonLeaves.length - 1);
  const comparisonSharedLeaves = comparisonLeaves.filter((node) => {
    const key = normalizeComparisonTipName(comparisonTree.names[node] ?? "");
    return sharedKeys.has(key) && comparisonByName.get(key) === node;
  });
  const comparisonSharedIndexByNode = new Map<number, number>();
  comparisonSharedLeaves.forEach((node, index) => comparisonSharedIndexByNode.set(node, index));
  const primarySharedDenominator = Math.max(1, primarySharedLeaves.length - 1);
  const comparisonSharedDenominator = Math.max(1, comparisonSharedLeaves.length - 1);
  const commonPairs: ComparisonLayout["commonPairs"] = [];
  primarySharedLeaves.forEach((primaryNode, primarySharedIndex) => {
    const name = primaryTree.names[primaryNode] ?? "";
    const key = normalizeComparisonTipName(name);
    const comparisonNode = comparisonByName.get(key);
    if (comparisonNode === undefined) {
      return;
    }
    const primaryIndex = primaryIndexByNode.get(primaryNode) ?? 0;
    const comparisonIndex = comparisonIndexByNode.get(comparisonNode) ?? 0;
    const comparisonSharedIndex = comparisonSharedIndexByNode.get(comparisonNode) ?? 0;
    const primaryPosition = primaryIndex / primaryDenominator;
    const comparisonPosition = comparisonIndex / comparisonDenominator;
    const primarySharedPosition = primarySharedIndex / primarySharedDenominator;
    const comparisonSharedPosition = comparisonSharedIndex / comparisonSharedDenominator;
    commonPairs.push({
      name: name.replaceAll("_", " "),
      primaryNode,
      comparisonNode,
      primaryPosition,
      comparisonPosition,
      discordance: Math.abs(primarySharedPosition - comparisonSharedPosition),
    });
  });

  return {
    primaryLeaves,
    comparisonLeaves,
    comparisonCenter,
    commonPairs,
    primaryOnlyCount: primaryLeaves.length - commonPairs.length,
    comparisonOnlyCount: comparisonLeaves.length - commonPairs.length,
  };
}
