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
  matchingClusterInformationDistance: number | null;
  normalizedMatchingClusterInformationDistance: number | null;
  informationMetricReason: string | null;
}

interface ClusterCollection {
  keys: Set<string>;
  members: Map<string, Uint32Array> | null;
}

const MAX_INFORMATION_TIPS = 300;
const MAX_INFORMATION_GROUPS = 250;

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

function collectClusters(
  tree: TreeModel,
  sharedIdByName: Map<string, number>,
  retainMembers: boolean,
): ClusterCollection {
  const count = new Uint32Array(tree.nodeCount);
  const sumA = new Uint32Array(tree.nodeCount);
  const sumB = new Uint32Array(tree.nodeCount);
  const xor = new Uint32Array(tree.nodeCount);
  const memberLists = retainMembers ? new Map<number, number[]>() : null;
  const keys = new Set<string>();
  const members = retainMembers ? new Map<string, Uint32Array>() : null;
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
        memberLists?.set(item.node, [id]);
      }
      continue;
    }

    const nodeMembers = retainMembers ? [] as number[] : null;
    for (let child = firstChild; child >= 0; child = tree.buffers.nextSibling[child]) {
      count[item.node] += count[child];
      sumA[item.node] = (sumA[item.node] + sumA[child]) >>> 0;
      sumB[item.node] = (sumB[item.node] + sumB[child]) >>> 0;
      xor[item.node] ^= xor[child];
      if (nodeMembers) {
        nodeMembers.push(...(memberLists?.get(child) ?? []));
      }
    }
    if (nodeMembers) {
      memberLists!.set(item.node, nodeMembers);
    }
    if (count[item.node] <= 1 || count[item.node] >= sharedIdByName.size) {
      continue;
    }
    const key = `${count[item.node]}:${sumA[item.node]}:${sumB[item.node]}:${xor[item.node] >>> 0}`;
    keys.add(key);
    if (members && nodeMembers && !members.has(key)) {
      members.set(key, Uint32Array.from(nodeMembers));
    }
  }
  return { keys, members };
}

function binaryEntropy(partSize: number, total: number): number {
  const p = partSize / total;
  if (p <= 0 || p >= 1) {
    return 0;
  }
  return -(p * Math.log2(p)) - ((1 - p) * Math.log2(1 - p));
}

function clusterMutualInformation(left: Uint32Array, right: Uint32Array, total: number): number {
  const rightMembers = new Set(right);
  let intersection = 0;
  left.forEach((member) => {
    if (rightMembers.has(member)) {
      intersection += 1;
    }
  });
  const cells = [
    intersection,
    left.length - intersection,
    right.length - intersection,
    total - left.length - right.length + intersection,
  ];
  const rowTotals = [left.length, total - left.length];
  const columnTotals = [right.length, total - right.length];
  let information = 0;
  cells.forEach((cell, index) => {
    if (cell === 0) {
      return;
    }
    const row = index < 2 ? 0 : 1;
    const column = index % 2;
    information += (cell / total) * Math.log2((cell * total) / (rowTotals[row] * columnTotals[column]));
  });
  return information;
}

function maximumWeightMatching(weights: number[][]): number {
  const size = weights.length;
  if (size === 0) {
    return 0;
  }
  const maximum = Math.max(0, ...weights.flat());
  const u = new Float64Array(size + 1);
  const v = new Float64Array(size + 1);
  const p = new Int32Array(size + 1);
  const way = new Int32Array(size + 1);
  for (let row = 1; row <= size; row += 1) {
    p[0] = row;
    let column = 0;
    const minimum = new Float64Array(size + 1);
    minimum.fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(size + 1);
    do {
      used[column] = 1;
      const currentRow = p[column];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= size; candidate += 1) {
        if (used[candidate]) {
          continue;
        }
        const cost = maximum - weights[currentRow - 1][candidate - 1] - u[currentRow] - v[candidate];
        if (cost < minimum[candidate]) {
          minimum[candidate] = cost;
          way[candidate] = column;
        }
        if (minimum[candidate] < delta) {
          delta = minimum[candidate];
          nextColumn = candidate;
        }
      }
      for (let candidate = 0; candidate <= size; candidate += 1) {
        if (used[candidate]) {
          u[p[candidate]] += delta;
          v[candidate] -= delta;
        } else {
          minimum[candidate] -= delta;
        }
      }
      column = nextColumn;
    } while (p[column] !== 0);
    do {
      const previous = way[column];
      p[column] = p[previous];
      column = previous;
    } while (column !== 0);
  }
  let result = 0;
  for (let column = 1; column <= size; column += 1) {
    result += weights[p[column] - 1][column - 1];
  }
  return result;
}

function informationDistance(
  primary: ClusterCollection,
  comparison: ClusterCollection,
  sharedTipCount: number,
): { distance: number; normalized: number } | null {
  if (!primary.members || !comparison.members) {
    return null;
  }
  const left = [...primary.members.values()];
  const right = [...comparison.members.values()];
  const size = Math.max(left.length, right.length);
  const weights = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => (
    row < left.length && column < right.length
      ? clusterMutualInformation(left[row], right[column], sharedTipCount)
      : 0
  )));
  const totalInformation = left.reduce((sum, cluster) => sum + binaryEntropy(cluster.length, sharedTipCount), 0)
    + right.reduce((sum, cluster) => sum + binaryEntropy(cluster.length, sharedTipCount), 0);
  const distance = Math.max(0, totalInformation - (2 * maximumWeightMatching(weights)));
  return {
    distance,
    normalized: totalInformation > 0 ? distance / totalInformation : 0,
  };
}

export function computeTreeComparisonStatistics(
  primaryTree: TreeModel,
  comparisonTree: TreeModel,
): TreeComparisonStatistics {
  const primaryTips = uniqueTipsByName(primaryTree);
  const comparisonTips = uniqueTipsByName(comparisonTree);
  const sharedNames = [...primaryTips.keys()].filter((name) => comparisonTips.has(name)).sort();
  const sharedIdByName = new Map(sharedNames.map((name, index) => [name, index] as const));
  const initiallyRetainMembers = sharedNames.length <= MAX_INFORMATION_TIPS;
  let primary = collectClusters(primaryTree, sharedIdByName, initiallyRetainMembers);
  let comparison = collectClusters(comparisonTree, sharedIdByName, initiallyRetainMembers);
  const groupCount = Math.max(primary.keys.size, comparison.keys.size);
  const retainMembers = initiallyRetainMembers && groupCount <= MAX_INFORMATION_GROUPS;
  if (!retainMembers && initiallyRetainMembers) {
    primary = { ...primary, members: null };
    comparison = { ...comparison, members: null };
  }
  let sharedGroupCount = 0;
  primary.keys.forEach((key) => {
    if (comparison.keys.has(key)) {
      sharedGroupCount += 1;
    }
  });
  const rf = primary.keys.size + comparison.keys.size - (2 * sharedGroupCount);
  const rfMaximum = primary.keys.size + comparison.keys.size;
  const information = retainMembers
    ? informationDistance(primary, comparison, sharedNames.length)
    : null;
  const informationMetricReason = retainMembers
    ? null
    : sharedNames.length > MAX_INFORMATION_TIPS
      ? `Not calculated above ${MAX_INFORMATION_TIPS.toLocaleString()} shared tips.`
      : `Not calculated above ${MAX_INFORMATION_GROUPS.toLocaleString()} internal groups.`;

  return {
    sharedTipCount: sharedNames.length,
    primaryOnlyTipCount: primaryTips.size - sharedNames.length,
    comparisonOnlyTipCount: comparisonTips.size - sharedNames.length,
    primaryGroupCount: primary.keys.size,
    comparisonGroupCount: comparison.keys.size,
    sharedGroupCount,
    robinsonFouldsDistance: rf,
    normalizedRobinsonFouldsDistance: rfMaximum > 0 ? rf / rfMaximum : 0,
    matchingClusterInformationDistance: information?.distance ?? null,
    normalizedMatchingClusterInformationDistance: information?.normalized ?? null,
    informationMetricReason,
  };
}
