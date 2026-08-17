import type { TreeModel } from "../types/tree";
import { normalizeComparisonTipName } from "./treeComparison";

export interface ComparisonRootDiagnostic {
  available: boolean;
  sharedTipCount: number;
  leftRootGroupSizes: number[] | null;
  originalRootKind: "edge" | "node" | null;
  bestCandidateKind: "edge" | "node" | null;
  unavailableReason: "too-few-shared-tips" | "unresolved-shared-root" | "high-degree-root" | null;
  currentMismatchCount: number | null;
  bestMismatchCount: number | null;
  bestCandidateNode: number | null;
  exactMatchAvailable: boolean;
  rootsMatch: boolean;
  canImprove: boolean;
}

export interface TreeComparisonTopologyAnalysis {
  root: ComparisonRootDiagnostic;
  incompatiblePrimaryNodes: Set<number>;
  comparablePrimarySplitCount: number;
  incompatiblePrimarySplitCount: number;
}

interface TipIndex {
  byName: Map<string, number>;
  nameByNode: Map<number, string>;
}

interface SplitAggregate {
  count: number;
  sumA: number;
  sumB: number;
  xor: number;
}

function uniqueTipsByName(tree: TreeModel): TipIndex {
  const byName = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const node of tree.leafNodes) {
    const name = normalizeComparisonTipName(tree.names[node] ?? "");
    if (!name) {
      continue;
    }
    if (byName.has(name)) {
      duplicates.add(name);
    } else {
      byName.set(name, node);
    }
  }
  duplicates.forEach((name) => byName.delete(name));
  return {
    byName,
    nameByNode: new Map([...byName].map(([name, node]) => [node, name] as const)),
  };
}

function postorder(tree: TreeModel): number[] {
  const order: number[] = [];
  const stack: Array<{ node: number; visited: boolean }> = [{ node: tree.root, visited: false }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.visited) {
      order.push(item.node);
      continue;
    }
    stack.push({ node: item.node, visited: true });
    for (let child = tree.buffers.firstChild[item.node]; child >= 0; child = tree.buffers.nextSibling[child]) {
      stack.push({ node: child, visited: false });
    }
  }
  return order;
}

function descendantCounts(
  tree: TreeModel,
  sharedNameByNode: Map<number, string>,
): Uint32Array {
  const counts = new Uint32Array(tree.nodeCount);
  for (const node of postorder(tree)) {
    if (tree.buffers.firstChild[node] < 0) {
      counts[node] = sharedNameByNode.has(node) ? 1 : 0;
      continue;
    }
    for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
      counts[node] += counts[child];
    }
  }
  return counts;
}

function effectiveRootLocation(tree: TreeModel, sharedCounts: Uint32Array): { node: number; children: number[] } {
  let node = tree.root;
  while (node >= 0) {
    const children: number[] = [];
    for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
      if (sharedCounts[child] > 0) {
        children.push(child);
      }
    }
    if (children.length !== 1) {
      return { node, children };
    }
    node = children[0];
  }
  return { node: -1, children: [] };
}

function descendantSharedNames(
  tree: TreeModel,
  root: number,
  sharedNameByNode: Map<number, string>,
): Set<string> {
  const result = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const name = sharedNameByNode.get(node);
    if (name) {
      result.add(name);
      continue;
    }
    for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
      stack.push(child);
    }
  }
  return result;
}

const MAX_COMPARABLE_ROOT_DEGREE = 8;

function maximumPartitionOverlap(components: number[][], groupCount: number): number {
  const stateCount = 1 << groupCount;
  let scores = new Int32Array(stateCount);
  scores.fill(-1);
  scores[0] = 0;
  for (const component of components) {
    const next = scores.slice();
    for (let mask = 0; mask < stateCount; mask += 1) {
      if (scores[mask] < 0) continue;
      for (let group = 0; group < groupCount; group += 1) {
        const bit = 1 << group;
        if ((mask & bit) !== 0) continue;
        const nextMask = mask | bit;
        next[nextMask] = Math.max(next[nextMask], scores[mask] + component[group]);
      }
    }
    scores = next;
  }
  let best = 0;
  for (let mask = 0; mask < stateCount; mask += 1) best = Math.max(best, scores[mask]);
  return best;
}

function multifurcatingRootDiagnostic(
  primaryTree: TreeModel,
  comparisonTree: TreeModel,
  comparisonSharedByNode: Map<number, string>,
  sharedNames: string[],
  primaryRootChildren: number[],
  primarySharedByNode: Map<number, string>,
): ComparisonRootDiagnostic {
  const groupCount = primaryRootChildren.length;
  if (groupCount > MAX_COMPARABLE_ROOT_DEGREE) {
    return {
      available: false,
      sharedTipCount: sharedNames.length,
      leftRootGroupSizes: null,
      originalRootKind: null,
      bestCandidateKind: null,
      unavailableReason: "high-degree-root",
      currentMismatchCount: null,
      bestMismatchCount: null,
      bestCandidateNode: null,
      exactMatchAvailable: false,
      rootsMatch: false,
      canImprove: false,
    };
  }

  const targetGroupByName = new Map<string, number>();
  const targetGroupSizes = new Array<number>(groupCount).fill(0);
  for (let group = 0; group < groupCount; group += 1) {
    const names = descendantSharedNames(primaryTree, primaryRootChildren[group], primarySharedByNode);
    names.forEach((name) => targetGroupByName.set(name, group));
    targetGroupSizes[group] = names.size;
  }

  const counts = new Uint32Array(comparisonTree.nodeCount * groupCount);
  const comparisonPostorder = postorder(comparisonTree);
  for (const node of comparisonPostorder) {
    const offset = node * groupCount;
    if (comparisonTree.buffers.firstChild[node] < 0) {
      const name = comparisonSharedByNode.get(node);
      const group = name === undefined ? undefined : targetGroupByName.get(name);
      if (group !== undefined) counts[offset + group] = 1;
      continue;
    }
    for (let child = comparisonTree.buffers.firstChild[node]; child >= 0; child = comparisonTree.buffers.nextSibling[child]) {
      const childOffset = child * groupCount;
      for (let group = 0; group < groupCount; group += 1) {
        counts[offset + group] += counts[childOffset + group];
      }
    }
  }

  const componentsAtNode = (node: number): number[][] => {
    const components: number[][] = [];
    for (let child = comparisonTree.buffers.firstChild[node]; child >= 0; child = comparisonTree.buffers.nextSibling[child]) {
      const childOffset = child * groupCount;
      const component = targetGroupSizes.map((_, group) => counts[childOffset + group]);
      if (component.some((count) => count > 0)) components.push(component);
    }
    if (comparisonTree.buffers.parent[node] >= 0) {
      const offset = node * groupCount;
      const complement = targetGroupSizes.map((size, group) => size - counts[offset + group]);
      if (complement.some((count) => count > 0)) components.push(complement);
    }
    return components;
  };
  const mismatchAtNode = (node: number): number | null => {
    const components = componentsAtNode(node);
    if (components.length !== groupCount) return null;
    return sharedNames.length - maximumPartitionOverlap(components, groupCount);
  };

  let bestCandidateNode: number | null = null;
  let bestMismatchCount = Number.POSITIVE_INFINITY;
  for (let node = 0; node < comparisonTree.nodeCount; node += 1) {
    if (comparisonTree.buffers.firstChild[node] < 0) continue;
    const mismatch = mismatchAtNode(node);
    if (mismatch !== null && mismatch < bestMismatchCount) {
      bestMismatchCount = mismatch;
      bestCandidateNode = node;
    }
  }
  const comparisonSharedCounts = descendantCounts(comparisonTree, comparisonSharedByNode);
  const comparisonRootLocation = effectiveRootLocation(comparisonTree, comparisonSharedCounts);
  const currentMismatchCount = comparisonRootLocation.node >= 0
    ? mismatchAtNode(comparisonRootLocation.node)
    : null;
  const finiteBest = Number.isFinite(bestMismatchCount) ? bestMismatchCount : null;
  return {
    available: finiteBest !== null,
    sharedTipCount: sharedNames.length,
    leftRootGroupSizes: targetGroupSizes,
    originalRootKind: "node",
    bestCandidateKind: finiteBest === null ? null : "node",
    unavailableReason: finiteBest === null ? "unresolved-shared-root" : null,
    currentMismatchCount,
    bestMismatchCount: finiteBest,
    bestCandidateNode,
    exactMatchAvailable: finiteBest === 0,
    rootsMatch: currentMismatchCount === 0,
    canImprove: bestCandidateNode !== null && (
      currentMismatchCount === null || (finiteBest !== null && finiteBest < currentMismatchCount)
    ),
  };
}

function rootDiagnostic(
  primaryTree: TreeModel,
  comparisonTree: TreeModel,
  primaryTips: TipIndex,
  comparisonTips: TipIndex,
  sharedNames: string[],
): ComparisonRootDiagnostic {
  const unavailable = (sharedTipCount: number): ComparisonRootDiagnostic => ({
    available: false,
    sharedTipCount,
    leftRootGroupSizes: null,
    originalRootKind: null,
    bestCandidateKind: null,
    unavailableReason: sharedTipCount < 3 ? "too-few-shared-tips" : "unresolved-shared-root",
    currentMismatchCount: null,
    bestMismatchCount: null,
    bestCandidateNode: null,
    exactMatchAvailable: false,
    rootsMatch: false,
    canImprove: false,
  });
  if (sharedNames.length < 3) {
    return unavailable(sharedNames.length);
  }

  const sharedSet = new Set(sharedNames);
  const primarySharedByNode = new Map<number, string>();
  primaryTips.nameByNode.forEach((name, node) => {
    if (sharedSet.has(name)) primarySharedByNode.set(node, name);
  });
  const comparisonSharedByNode = new Map<number, string>();
  comparisonTips.nameByNode.forEach((name, node) => {
    if (sharedSet.has(name)) comparisonSharedByNode.set(node, name);
  });
  const primaryCounts = descendantCounts(primaryTree, primarySharedByNode);
  const primaryRootLocation = effectiveRootLocation(primaryTree, primaryCounts);
  const primaryRootChildren = primaryRootLocation.children;
  if (primaryRootChildren.length < 2) {
    return unavailable(sharedNames.length);
  }
  if (primaryRootChildren.length > 2) {
    return multifurcatingRootDiagnostic(
      primaryTree,
      comparisonTree,
      comparisonSharedByNode,
      sharedNames,
      primaryRootChildren,
      primarySharedByNode,
    );
  }
  const targetSide = descendantSharedNames(primaryTree, primaryRootChildren[0], primarySharedByNode);
  const targetSize = targetSide.size;
  const otherSize = sharedNames.length - targetSize;
  if (targetSize === 0 || otherSize === 0) {
    return unavailable(sharedNames.length);
  }

  const comparisonCounts = new Uint32Array(comparisonTree.nodeCount);
  const comparisonTargetCounts = new Uint32Array(comparisonTree.nodeCount);
  for (const node of postorder(comparisonTree)) {
    if (comparisonTree.buffers.firstChild[node] < 0) {
      const name = comparisonSharedByNode.get(node);
      if (name) {
        comparisonCounts[node] = 1;
        comparisonTargetCounts[node] = targetSide.has(name) ? 1 : 0;
      }
      continue;
    }
    for (let child = comparisonTree.buffers.firstChild[node]; child >= 0; child = comparisonTree.buffers.nextSibling[child]) {
      comparisonCounts[node] += comparisonCounts[child];
      comparisonTargetCounts[node] += comparisonTargetCounts[child];
    }
  }

  const mismatchForNode = (node: number): number => {
    const sideCount = comparisonCounts[node];
    const targetInSide = comparisonTargetCounts[node];
    const otherInSide = sideCount - targetInSide;
    const mismatchToTarget = (targetSize - targetInSide) + otherInSide;
    const mismatchToOther = (otherSize - otherInSide) + targetInSide;
    return Math.min(mismatchToTarget, mismatchToOther);
  };

  let bestCandidateNode: number | null = null;
  let bestMismatchCount = Number.POSITIVE_INFINITY;
  for (let node = 0; node < comparisonTree.nodeCount; node += 1) {
    if (comparisonTree.buffers.parent[node] < 0) {
      continue;
    }
    const count = comparisonCounts[node];
    if (count === 0 || count === sharedNames.length) {
      continue;
    }
    const mismatch = mismatchForNode(node);
    if (mismatch < bestMismatchCount) {
      bestMismatchCount = mismatch;
      bestCandidateNode = node;
    }
  }

  const comparisonRootChildren = effectiveRootLocation(comparisonTree, comparisonCounts).children;
  const currentMismatchCount = comparisonRootChildren.length === 2
    ? mismatchForNode(comparisonRootChildren[0])
    : null;
  const finiteBest = Number.isFinite(bestMismatchCount) ? bestMismatchCount : null;
  const rootsMatch = currentMismatchCount === 0;
  const canImprove = bestCandidateNode !== null && (
    currentMismatchCount === null || (finiteBest !== null && finiteBest < currentMismatchCount)
  );
  return {
    available: true,
    sharedTipCount: sharedNames.length,
    leftRootGroupSizes: [targetSize, otherSize],
    originalRootKind: "edge",
    bestCandidateKind: "edge",
    unavailableReason: null,
    currentMismatchCount,
    bestMismatchCount: finiteBest,
    bestCandidateNode,
    exactMatchAvailable: finiteBest === 0,
    rootsMatch,
    canImprove,
  };
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

function aggregateKey(value: SplitAggregate): string {
  return `${value.count}:${value.sumA >>> 0}:${value.sumB >>> 0}:${value.xor >>> 0}`;
}

function canonicalSplitKey(descendant: SplitAggregate, total: SplitAggregate): string | null {
  const complement: SplitAggregate = {
    count: total.count - descendant.count,
    sumA: (total.sumA - descendant.sumA) >>> 0,
    sumB: (total.sumB - descendant.sumB) >>> 0,
    xor: (total.xor ^ descendant.xor) >>> 0,
  };
  if (descendant.count <= 1 || complement.count <= 1) {
    return null;
  }
  if (descendant.count < complement.count) return aggregateKey(descendant);
  if (complement.count < descendant.count) return aggregateKey(complement);
  const descendantKey = aggregateKey(descendant);
  const complementKey = aggregateKey(complement);
  return descendantKey < complementKey ? descendantKey : complementKey;
}

function edgeSplits(
  tree: TreeModel,
  tipIdsByName: Map<string, number>,
  uniqueTips: TipIndex,
): Map<number, string> {
  const aggregateByNode: SplitAggregate[] = Array.from({ length: tree.nodeCount }, () => ({
    count: 0,
    sumA: 0,
    sumB: 0,
    xor: 0,
  }));
  for (const node of postorder(tree)) {
    const aggregate = aggregateByNode[node];
    if (tree.buffers.firstChild[node] < 0) {
      const name = uniqueTips.nameByNode.get(node);
      const id = name ? tipIdsByName.get(name) : undefined;
      if (id !== undefined) {
        const token = id + 1;
        aggregate.count = 1;
        aggregate.sumA = mix32(token);
        aggregate.sumB = mix32(token ^ 0x9e3779b9);
        aggregate.xor = mix32(token ^ 0x85ebca6b);
      }
      continue;
    }
    for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
      const childAggregate = aggregateByNode[child];
      aggregate.count += childAggregate.count;
      aggregate.sumA = (aggregate.sumA + childAggregate.sumA) >>> 0;
      aggregate.sumB = (aggregate.sumB + childAggregate.sumB) >>> 0;
      aggregate.xor ^= childAggregate.xor;
    }
  }
  const total = aggregateByNode[tree.root];
  const result = new Map<number, string>();
  for (let node = 0; node < tree.nodeCount; node += 1) {
    if (tree.buffers.parent[node] < 0) continue;
    const key = canonicalSplitKey(aggregateByNode[node], total);
    if (key) result.set(node, key);
  }
  return result;
}

export function analyzeTreeComparisonTopology(
  primaryTree: TreeModel,
  comparisonTree: TreeModel,
): TreeComparisonTopologyAnalysis {
  const primaryTips = uniqueTipsByName(primaryTree);
  const comparisonTips = uniqueTipsByName(comparisonTree);
  const sharedNames = [...primaryTips.byName.keys()].filter((name) => comparisonTips.byName.has(name)).sort();
  const tipIdsByName = new Map(sharedNames.map((name, index) => [name, index] as const));
  const primarySplits = edgeSplits(primaryTree, tipIdsByName, primaryTips);
  const comparisonSplitKeys = new Set(edgeSplits(comparisonTree, tipIdsByName, comparisonTips).values());
  const incompatiblePrimaryNodes = new Set<number>();
  const primaryNodeBySplitKey = new Map<string, number>();
  const incompatibleUniqueSplitKeys = new Set<string>();
  primarySplits.forEach((key, node) => {
    if (!primaryNodeBySplitKey.has(key)) primaryNodeBySplitKey.set(key, node);
  });
  primaryNodeBySplitKey.forEach((node, key) => {
    if (comparisonSplitKeys.has(key)) return;
    incompatiblePrimaryNodes.add(node);
    incompatibleUniqueSplitKeys.add(key);
  });
  return {
    root: rootDiagnostic(primaryTree, comparisonTree, primaryTips, comparisonTips, sharedNames),
    incompatiblePrimaryNodes,
    comparablePrimarySplitCount: primaryNodeBySplitKey.size,
    incompatiblePrimarySplitCount: incompatibleUniqueSplitKeys.size,
  };
}
