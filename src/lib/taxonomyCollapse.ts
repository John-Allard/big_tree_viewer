import { deriveActiveTaxonomyRanks } from "./taxonomyActiveRanks";
import type { TaxonomyMapPayload, TaxonomyRank, TaxonomyTipRanks } from "../types/taxonomy";
import type { LayoutBuffers, LayoutOrder, TreeBuffers, TreeModel, WorkerTreePayload } from "../types/tree";

interface OutputNode {
  name: string;
  parent: number;
  branchLength: number;
  depth: number;
  children: number[];
}

interface CollapseChunk {
  displayName: string;
  representativeTip: TaxonomyTipRanks;
  maxLeafDepth: number;
}

type CollapsedDescriptor =
  | { kind: "chunk"; chunkIndex: number }
  | { kind: "node"; sourceNode: number; children: CollapsedDescriptor[] };

export interface TaxonomyCollapsedTreePayload {
  payload: WorkerTreePayload;
  taxonomyMap: TaxonomyMapPayload | null;
}

function collectBufferChildren(firstChild: Int32Array, nextSibling: Int32Array, node: number): number[] {
  const children: number[] = [];
  for (let child = firstChild[node]; child >= 0; child = nextSibling[child]) {
    children.push(child);
  }
  return children;
}

function sortChildren(
  children: number[],
  leafCount: Int32Array,
  order: LayoutOrder,
): number[] {
  if (order === "input") {
    return children;
  }
  const multiplier = order === "desc" ? -1 : 1;
  const originalOrder = new Map<number, number>();
  for (let index = 0; index < children.length; index += 1) {
    originalOrder.set(children[index], index);
  }
  return [...children].sort((left, right) => {
    const diff = leafCount[left] - leafCount[right];
    if (diff !== 0) {
      return diff * multiplier;
    }
    return (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0);
  });
}

function buildLayout(
  root: number,
  buffers: TreeBuffers,
  order: LayoutOrder,
): LayoutBuffers {
  const { firstChild, nextSibling, leafCount } = buffers;
  const nodeCount = firstChild.length;
  const center = new Float64Array(nodeCount);
  const min = new Float64Array(nodeCount);
  const max = new Float64Array(nodeCount);
  let currentLeaf = 0;
  const stack: Array<{ node: number; expanded: boolean }> = [{ node: root, expanded: false }];

  while (stack.length > 0) {
    const entry = stack.pop()!;
    const node = entry.node;
    const child = firstChild[node];
    if (!entry.expanded && child >= 0) {
      stack.push({ node, expanded: true });
      const children = sortChildren(collectBufferChildren(firstChild, nextSibling, node), leafCount, order);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: children[index], expanded: false });
      }
      continue;
    }
    if (child < 0) {
      center[node] = currentLeaf;
      min[node] = currentLeaf;
      max[node] = currentLeaf;
      currentLeaf += 1;
      continue;
    }
    const children = sortChildren(collectBufferChildren(firstChild, nextSibling, node), leafCount, order);
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < children.length; index += 1) {
      const childNode = children[index];
      if (min[childNode] < first) {
        first = min[childNode];
      }
      if (max[childNode] > last) {
        last = max[childNode];
      }
    }
    min[node] = first;
    max[node] = last;
    center[node] = (center[children[0]] + center[children[children.length - 1]]) * 0.5;
  }

  return { center, min, max };
}

function buildPayloadFromOutput(
  tree: TreeModel,
  output: OutputNode[],
): WorkerTreePayload {
  const nodeCount = output.length;
  const parent = new Int32Array(nodeCount);
  const firstChild = new Int32Array(nodeCount);
  const nextSibling = new Int32Array(nodeCount);
  const branchLength = new Float64Array(nodeCount);
  const depth = new Float64Array(nodeCount);
  const leafCount = new Int32Array(nodeCount);
  const nodeIntervalLower = new Float64Array(nodeCount);
  const nodeIntervalUpper = new Float64Array(nodeCount);
  const names = new Array<string>(nodeCount);
  const leafNodesArray: number[] = [];
  let maxDepth = 0;

  parent.fill(-1);
  firstChild.fill(-1);
  nextSibling.fill(-1);
  nodeIntervalLower.fill(Number.NaN);
  nodeIntervalUpper.fill(Number.NaN);

  for (let node = 0; node < nodeCount; node += 1) {
    const current = output[node];
    parent[node] = current.parent;
    branchLength[node] = current.branchLength;
    depth[node] = current.depth;
    names[node] = current.name;
    if (current.children.length > 0) {
      firstChild[node] = current.children[0];
      for (let index = 0; index < current.children.length - 1; index += 1) {
        nextSibling[current.children[index]] = current.children[index + 1];
      }
    } else {
      leafNodesArray.push(node);
      if (current.depth > maxDepth) {
        maxDepth = current.depth;
      }
    }
  }

  for (let node = nodeCount - 1; node >= 0; node -= 1) {
    const child = firstChild[node];
    if (child < 0) {
      leafCount[node] = 1;
      continue;
    }
    let total = 0;
    for (let cursor = child; cursor >= 0; cursor = nextSibling[cursor]) {
      total += leafCount[cursor];
    }
    leafCount[node] = total;
  }

  let leafDepthMin = Number.POSITIVE_INFINITY;
  let leafDepthMax = Number.NEGATIVE_INFINITY;
  let leafDepthTotal = 0;
  for (let index = 0; index < leafNodesArray.length; index += 1) {
    const value = depth[leafNodesArray[index]];
    leafDepthTotal += value;
    if (value < leafDepthMin) {
      leafDepthMin = value;
    }
    if (value > leafDepthMax) {
      leafDepthMax = value;
    }
  }
  const rootAge = leafNodesArray.length > 0 ? leafDepthTotal / leafNodesArray.length : 0;
  const tolerance = Math.max(1e-6, rootAge * 0.005);
  const isUltrametric = Number.isFinite(leafDepthMin) && Number.isFinite(leafDepthMax)
    ? (leafDepthMax - leafDepthMin) <= tolerance
    : false;

  const buffers = {
    parent,
    firstChild,
    nextSibling,
    branchLength,
    depth,
    leafCount,
  };

  return {
    root: 0,
    nodeCount,
    leafCount: leafNodesArray.length,
    maxDepth,
    rootAge,
    hasBranchLengths: tree.hasBranchLengths,
    isUltrametric,
    leafNodes: new Int32Array(leafNodesArray),
    names,
    nodeIntervalLower,
    nodeIntervalUpper,
    nodeIntervalCount: 0,
    buffers,
    layouts: {
      input: buildLayout(0, buffers, "input"),
      desc: buildLayout(0, buffers, "desc"),
      asc: buildLayout(0, buffers, "asc"),
    },
  };
}

function buildIncludedLeafCounts(
  tree: TreeModel,
  taxonomyMap: TaxonomyMapPayload,
  rank: TaxonomyRank,
): Int32Array {
  const includedLeafCounts = new Int32Array(tree.nodeCount);
  for (let index = 0; index < taxonomyMap.tipRanks.length; index += 1) {
    const tip = taxonomyMap.tipRanks[index];
    if (tip.ranks[rank]) {
      includedLeafCounts[tip.node] = 1;
    }
  }
  for (let node = tree.nodeCount - 1; node >= 0; node -= 1) {
    for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
      includedLeafCounts[node] += includedLeafCounts[child];
    }
  }
  return includedLeafCounts;
}

function computeIncludedLeavesInOrder(
  tree: TreeModel,
  includedLeafCounts: Int32Array,
  order: LayoutOrder,
): number[] {
  const orderedLeaves: number[] = [];
  const stack: number[] = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (includedLeafCounts[node] <= 0) {
      continue;
    }
    const firstChild = tree.buffers.firstChild[node];
    if (firstChild < 0) {
      orderedLeaves.push(node);
      continue;
    }
    const children = sortChildren(
      collectBufferChildren(tree.buffers.firstChild, tree.buffers.nextSibling, node),
      includedLeafCounts,
      order,
    );
    for (let index = children.length - 1; index >= 0; index -= 1) {
      if (includedLeafCounts[children[index]] > 0) {
        stack.push(children[index]);
      }
    }
  }
  return orderedLeaves;
}

function buildCollapseChunks(
  tree: TreeModel,
  taxonomyMap: TaxonomyMapPayload,
  rank: TaxonomyRank,
  orderedIncludedLeaves: number[],
): {
  chunks: CollapseChunk[];
  chunkIndexByNode: Map<number, number>;
} {
  const tipEntryByNode = new Map<number, TaxonomyTipRanks>();
  for (let index = 0; index < taxonomyMap.tipRanks.length; index += 1) {
    const tip = taxonomyMap.tipRanks[index];
    if (tip.ranks[rank]) {
      tipEntryByNode.set(tip.node, tip);
    }
  }

  const rawChunks: Array<{ label: string; representativeTip: TaxonomyTipRanks; maxLeafDepth: number; nodes: number[] }> = [];
  let index = 0;
  while (index < orderedIncludedLeaves.length) {
    const node = orderedIncludedLeaves[index];
    const tip = tipEntryByNode.get(node);
    if (!tip) {
      index += 1;
      continue;
    }
    const label = tip.ranks[rank];
    if (!label) {
      index += 1;
      continue;
    }
    const nodes = [node];
    let maxLeafDepth = tree.buffers.depth[node];
    let endIndex = index + 1;
    while (endIndex < orderedIncludedLeaves.length) {
      const nextNode = orderedIncludedLeaves[endIndex];
      const nextTip = tipEntryByNode.get(nextNode);
      if (!nextTip || nextTip.ranks[rank] !== label) {
        break;
      }
      nodes.push(nextNode);
      maxLeafDepth = Math.max(maxLeafDepth, tree.buffers.depth[nextNode]);
      endIndex += 1;
    }
    rawChunks.push({
      label,
      representativeTip: tip,
      maxLeafDepth,
      nodes,
    });
    index = endIndex;
  }

  const totalByLabel = new Map<string, number>();
  for (let chunkIndex = 0; chunkIndex < rawChunks.length; chunkIndex += 1) {
    const chunk = rawChunks[chunkIndex];
    totalByLabel.set(chunk.label, (totalByLabel.get(chunk.label) ?? 0) + 1);
  }
  const ordinalByLabel = new Map<string, number>();
  const chunkIndexByNode = new Map<number, number>();
  const chunks: CollapseChunk[] = [];
  for (let chunkIndex = 0; chunkIndex < rawChunks.length; chunkIndex += 1) {
    const chunk = rawChunks[chunkIndex];
    const ordinal = (ordinalByLabel.get(chunk.label) ?? 0) + 1;
    ordinalByLabel.set(chunk.label, ordinal);
    const displayName = (totalByLabel.get(chunk.label) ?? 0) > 1
      ? `${chunk.label}-${ordinal}`
      : chunk.label;
    chunks.push({
      displayName,
      representativeTip: chunk.representativeTip,
      maxLeafDepth: chunk.maxLeafDepth,
    });
    for (let nodeIndex = 0; nodeIndex < chunk.nodes.length; nodeIndex += 1) {
      chunkIndexByNode.set(chunk.nodes[nodeIndex], chunkIndex);
    }
  }
  return { chunks, chunkIndexByNode };
}

function mergeAdjacentChunkDescriptors(descriptors: CollapsedDescriptor[]): CollapsedDescriptor[] {
  const merged: CollapsedDescriptor[] = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    const current = descriptors[index];
    const previous = merged[merged.length - 1];
    if (
      previous
      && previous.kind === "chunk"
      && current.kind === "chunk"
      && previous.chunkIndex === current.chunkIndex
    ) {
      continue;
    }
    merged.push(current);
  }
  return merged;
}

function buildCollapsedDescriptors(
  tree: TreeModel,
  order: LayoutOrder,
  includedLeafCounts: Int32Array,
  chunkIndexByNode: Map<number, number>,
): CollapsedDescriptor[] {
  const visit = (node: number): CollapsedDescriptor[] => {
    if (includedLeafCounts[node] <= 0) {
      return [];
    }
    const firstChild = tree.buffers.firstChild[node];
    if (firstChild < 0) {
      const chunkIndex = chunkIndexByNode.get(node);
      return chunkIndex === undefined ? [] : [{ kind: "chunk", chunkIndex }];
    }
    const descriptors: CollapsedDescriptor[] = [];
    const children = sortChildren(
      collectBufferChildren(tree.buffers.firstChild, tree.buffers.nextSibling, node),
      includedLeafCounts,
      order,
    );
    for (let index = 0; index < children.length; index += 1) {
      descriptors.push(...visit(children[index]));
    }
    const merged = mergeAdjacentChunkDescriptors(descriptors);
    if (merged.length <= 1) {
      return merged;
    }
    return [{
      kind: "node",
      sourceNode: node,
      children: merged,
    }];
  };
  return visit(tree.root);
}

export function buildTaxonomyCollapsedTreePayload(
  tree: TreeModel,
  taxonomyMap: TaxonomyMapPayload,
  rank: TaxonomyRank,
  order: LayoutOrder,
): TaxonomyCollapsedTreePayload | null {
  const includedLeafCounts = buildIncludedLeafCounts(tree, taxonomyMap, rank);
  if (includedLeafCounts[tree.root] <= 0) {
    return null;
  }
  const orderedIncludedLeaves = computeIncludedLeavesInOrder(tree, includedLeafCounts, order);
  const { chunks, chunkIndexByNode } = buildCollapseChunks(tree, taxonomyMap, rank, orderedIncludedLeaves);
  if (chunks.length === 0) {
    return null;
  }
  const descriptors = buildCollapsedDescriptors(tree, order, includedLeafCounts, chunkIndexByNode);
  if (descriptors.length === 0) {
    return null;
  }

  const output: OutputNode[] = [];
  const syntheticTipRanks: TaxonomyTipRanks[] = [];

  const appendDescriptor = (descriptor: CollapsedDescriptor, parentOutputNode: number, parentOutputDepth: number): number => {
    if (descriptor.kind === "chunk") {
      const chunk = chunks[descriptor.chunkIndex];
      const nodeDepth = parentOutputNode < 0 ? 0 : chunk.maxLeafDepth;
      const outputNode = output.length;
      output.push({
        name: chunk.displayName,
        parent: parentOutputNode,
        branchLength: parentOutputNode < 0 ? 0 : Math.max(0, nodeDepth - parentOutputDepth),
        depth: nodeDepth,
        children: [],
      });
      syntheticTipRanks.push({
        node: outputNode,
        ranks: chunk.representativeTip.ranks,
        taxIds: chunk.representativeTip.taxIds,
      });
      return outputNode;
    }

    const nodeDepth = parentOutputNode < 0 ? 0 : tree.buffers.depth[descriptor.sourceNode];
    const outputNode = output.length;
    output.push({
      name: tree.names[descriptor.sourceNode] ?? "",
      parent: parentOutputNode,
      branchLength: parentOutputNode < 0 ? 0 : Math.max(0, nodeDepth - parentOutputDepth),
      depth: nodeDepth,
      children: [],
    });
    for (let index = 0; index < descriptor.children.length; index += 1) {
      const childOutputNode = appendDescriptor(descriptor.children[index], outputNode, nodeDepth);
      output[outputNode].children.push(childOutputNode);
    }
    return outputNode;
  };

  const rootDescriptor = descriptors.length === 1
    ? descriptors[0]
    : {
      kind: "node" as const,
      sourceNode: tree.root,
      children: descriptors,
    };
  if (rootDescriptor.kind === "chunk") {
    output.push({
      name: tree.names[tree.root] ?? "",
      parent: -1,
      branchLength: 0,
      depth: 0,
      children: [],
    });
    output[0].children.push(appendDescriptor(rootDescriptor, 0, 0));
  } else {
    appendDescriptor(rootDescriptor, -1, 0);
  }

  const payload = buildPayloadFromOutput(tree, output);
  return {
    payload,
    taxonomyMap: {
      version: taxonomyMap.version,
      mappedCount: syntheticTipRanks.length,
      totalTips: payload.leafCount,
      activeRanks: deriveActiveTaxonomyRanks(syntheticTipRanks.map((tip) => tip.ranks)),
      tipRanks: syntheticTipRanks,
    },
  };
}
