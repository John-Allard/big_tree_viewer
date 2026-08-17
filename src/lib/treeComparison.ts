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

function sharedRanksInDisplayOrder(
  root: number,
  childOrder: Map<number, number[]>,
  rankByNode: Int32Array,
): number[] {
  const ranks: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const children = childOrder.get(node);
    if (!children || children.length === 0) {
      const rank = rankByNode[node];
      if (rank >= 0) ranks.push(rank);
      continue;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return ranks;
}

function crossingsWhenBefore(left: number[], right: number[]): number {
  let rightIndex = 0;
  let crossings = 0;
  for (const rank of left) {
    while (rightIndex < right.length && right[rightIndex] < rank) rightIndex += 1;
    crossings += rightIndex;
  }
  return crossings;
}

function exactMinimumCrossingOrder(sequences: number[][]): number[] {
  const count = sequences.length;
  const pairCost = Array.from({ length: count }, () => new Float64Array(count));
  for (let left = 0; left < count; left += 1) {
    for (let right = left + 1; right < count; right += 1) {
      pairCost[left][right] = crossingsWhenBefore(sequences[left], sequences[right]);
      pairCost[right][left] = crossingsWhenBefore(sequences[right], sequences[left]);
    }
  }
  const stateCount = 1 << count;
  const cost = new Float64Array(stateCount);
  cost.fill(Number.POSITIVE_INFINITY);
  const previousMask = new Int32Array(stateCount);
  const appendedChild = new Int16Array(stateCount);
  previousMask.fill(-1);
  appendedChild.fill(-1);
  cost[0] = 0;
  for (let mask = 0; mask < stateCount; mask += 1) {
    if (!Number.isFinite(cost[mask])) continue;
    for (let child = 0; child < count; child += 1) {
      const bit = 1 << child;
      if ((mask & bit) !== 0) continue;
      let nextCost = cost[mask];
      for (let earlier = 0; earlier < count; earlier += 1) {
        if ((mask & (1 << earlier)) !== 0) nextCost += pairCost[earlier][child];
      }
      const nextMask = mask | bit;
      if (nextCost < cost[nextMask]) {
        cost[nextMask] = nextCost;
        previousMask[nextMask] = mask;
        appendedChild[nextMask] = child;
      }
    }
  }
  const result = new Array<number>(count);
  let mask = stateCount - 1;
  for (let index = count - 1; index >= 0; index -= 1) {
    const child = appendedChild[mask];
    result[index] = child;
    mask = previousMask[mask];
  }
  return result;
}

function improveLargeMultifurcationOrder(order: number[], sequences: number[][]): number[] {
  const pairCost = (left: number, right: number) => crossingsWhenBefore(sequences[left], sequences[right]);
  const result = [...order];
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index + 1 < result.length; index += 1) {
      const left = result[index];
      const right = result[index + 1];
      if (pairCost(right, left) < pairCost(left, right)) {
        result[index] = right;
        result[index + 1] = left;
        changed = true;
      }
    }
  }
  return result;
}

function optimizeMultifurcationOrder(
  children: number[],
  childOrder: Map<number, number[]>,
  rankByNode: Int32Array,
  scoreTotal: Float64Array,
  scoreCount: Uint32Array,
): number[] {
  const matched = children.filter((child) => scoreCount[child] > 0);
  const unmatched = children.filter((child) => scoreCount[child] === 0);
  if (matched.length <= 2) {
    matched.sort((left, right) => (
      (scoreTotal[left] / scoreCount[left]) - (scoreTotal[right] / scoreCount[right])
    ));
    return [...matched, ...unmatched];
  }
  const sequences = matched.map((child) => (
    sharedRanksInDisplayOrder(child, childOrder, rankByNode).sort((left, right) => left - right)
  ));
  const barycenterOrder = matched.map((_, index) => index).sort((left, right) => {
    const leftChild = matched[left];
    const rightChild = matched[right];
    return (scoreTotal[leftChild] / scoreCount[leftChild]) - (scoreTotal[rightChild] / scoreCount[rightChild]);
  });
  const optimizedIndices = matched.length <= 12
    ? exactMinimumCrossingOrder(sequences)
    : matched.length <= 128
      ? improveLargeMultifurcationOrder(barycenterOrder, sequences)
      : barycenterOrder;
  return [...optimizedIndices.map((index) => matched[index]), ...unmatched];
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
  const rankByNode = new Int32Array(comparisonTree.nodeCount);
  rankByNode.fill(-1);
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
        rankByNode[item.node] = rank;
      }
      continue;
    }
    const children: number[] = [];
    for (let child = firstChild[item.node]; child >= 0; child = nextSibling[child]) {
      children.push(child);
      scoreTotal[item.node] += scoreTotal[child];
      scoreCount[item.node] += scoreCount[child];
    }
    childOrder.set(item.node, optimizeMultifurcationOrder(
      children,
      childOrder,
      rankByNode,
      scoreTotal,
      scoreCount,
    ));
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
