import type { LayoutBuffers, LayoutOrder, TreeModel, WorkerTreePayload } from "../types/tree";

type RerootMode = "branch" | "child" | "parent";

interface OutputNode {
  name: string;
  parent: number;
  branchLength: number;
  depth: number;
  children: number[];
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
  buffers: WorkerTreePayload["buffers"],
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

function collectBufferChildren(firstChild: Int32Array, nextSibling: Int32Array, node: number): number[] {
  const children: number[] = [];
  for (let child = firstChild[node]; child >= 0; child = nextSibling[child]) {
    children.push(child);
  }
  return children;
}

function buildAdjacency(tree: TreeModel): Array<Array<{ node: number; length: number }>> {
  const adjacency = Array.from({ length: tree.nodeCount }, () => [] as Array<{ node: number; length: number }>);
  for (let node = 0; node < tree.nodeCount; node += 1) {
    const parent = tree.buffers.parent[node];
    if (parent < 0) {
      continue;
    }
    const length = tree.buffers.branchLength[node];
    adjacency[node].push({ node: parent, length });
    adjacency[parent].push({ node, length });
  }
  return adjacency;
}

function removeEdge(
  adjacency: Array<Array<{ node: number; length: number }>>,
  left: number,
  right: number,
): void {
  adjacency[left] = adjacency[left].filter((entry) => entry.node !== right);
  adjacency[right] = adjacency[right].filter((entry) => entry.node !== left);
}

function appendOrientedChildren(
  adjacency: Array<Array<{ node: number; length: number }>>,
  orientedChildren: Array<Array<{ node: number; length: number }>>,
  current: number,
  from: number,
): void {
  const neighbors = adjacency[current];
  for (let index = 0; index < neighbors.length; index += 1) {
    const neighbor = neighbors[index];
    if (neighbor.node === from) {
      continue;
    }
    orientedChildren[current].push({ node: neighbor.node, length: neighbor.length });
    appendOrientedChildren(adjacency, orientedChildren, neighbor.node, current);
  }
}

function buildOutputTree(
  tree: TreeModel,
  orientedChildren: Array<Array<{ node: number; length: number }>>,
  syntheticRootIndex: number,
): OutputNode[] {
  const output: OutputNode[] = [];

  const cloneNode = (sourceNode: number, parent: number, branchLength: number, parentDepth: number): number => {
    const rawChildren = orientedChildren[sourceNode];
    if (
      sourceNode !== syntheticRootIndex
      && rawChildren.length === 1
      && !(tree.names[sourceNode] ?? "").trim()
    ) {
      return cloneNode(
        rawChildren[0].node,
        parent,
        branchLength + rawChildren[0].length,
        parentDepth,
      );
    }
    const nextIndex = output.length;
    output.push({
      name: sourceNode === syntheticRootIndex ? "" : (tree.names[sourceNode] ?? ""),
      parent,
      branchLength,
      depth: parent < 0 ? 0 : parentDepth + branchLength,
      children: [],
    });
    for (let index = 0; index < rawChildren.length; index += 1) {
      const child = rawChildren[index];
      const childIndex = cloneNode(child.node, nextIndex, child.length, output[nextIndex].depth);
      output[nextIndex].children.push(childIndex);
    }
    return nextIndex;
  };

  cloneNode(syntheticRootIndex, -1, 0, 0);
  return output;
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

export function rerootTreePayload(
  tree: TreeModel,
  childNode: number,
  mode: RerootMode,
): WorkerTreePayload | null {
  const parentNode = tree.buffers.parent[childNode];
  if (parentNode < 0) {
    return null;
  }
  const originalLength = tree.buffers.branchLength[childNode];
  const childFraction = mode === "branch" ? 0.5 : mode === "child" ? 0 : 1;
  const childLength = originalLength * childFraction;
  const parentLength = originalLength - childLength;
  const adjacency = buildAdjacency(tree);
  removeEdge(adjacency, childNode, parentNode);
  const syntheticRoot = adjacency.length;
  adjacency.push([
    { node: childNode, length: childLength },
    { node: parentNode, length: parentLength },
  ]);
  const orientedChildren = Array.from({ length: adjacency.length }, () => [] as Array<{ node: number; length: number }>);
  orientedChildren[syntheticRoot].push({ node: childNode, length: childLength });
  orientedChildren[syntheticRoot].push({ node: parentNode, length: parentLength });
  appendOrientedChildren(adjacency, orientedChildren, childNode, syntheticRoot);
  appendOrientedChildren(adjacency, orientedChildren, parentNode, syntheticRoot);
  const output = buildOutputTree(tree, orientedChildren, syntheticRoot);
  return buildPayloadFromOutput(tree, output);
}

export type { RerootMode };
