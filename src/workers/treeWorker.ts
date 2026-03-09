/// <reference lib="webworker" />

import type { ParseProgress, ParsedTreeResponse, ParseTreeError, WorkerRequest } from "../types/messages";
import type { LayoutBuffers, LayoutOrder, WorkerTreePayload } from "../types/tree";

interface TempNode {
  parent: number;
  children: number[];
  name: string;
  branchLength: number;
  hasExplicitLength: boolean;
  depth: number;
  leafCount: number;
}

function createTempNode(parent: number): TempNode {
  return {
    parent,
    children: [],
    name: "",
    branchLength: 0,
    hasExplicitLength: false,
    depth: 0,
    leafCount: 0,
  };
}

function normalizeQuotedLabel(raw: string): string {
  if (!raw) {
    return "";
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replaceAll("\\\"", "\"");
  }
  return trimmed;
}

function parseFloatSafe(raw: string, fallback: number): number {
  const value = Number.parseFloat(raw.trim());
  return Number.isFinite(value) ? value : fallback;
}

function parseNewick(text: string): { nodes: TempNode[]; root: number; maxDepth: number; hasBranchLengths: boolean } {
  const nodes: TempNode[] = [];
  const stack: number[] = [];
  let root = -1;
  let tokenStart = -1;
  let lastNode = -1;
  let expectingChild = false;
  let readingLength = false;
  let lengthTarget = -1;
  let inQuote = false;

  const createNode = (parent: number): number => {
    const id = nodes.length;
    nodes.push(createTempNode(parent));
    if (parent >= 0) {
      nodes[parent].children.push(id);
    }
    return id;
  };

  const materializeLeafIfNeeded = (): void => {
    if (!expectingChild) {
      return;
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : -1;
    const leaf = createNode(parent);
    if (root < 0) {
      root = leaf;
    }
    lastNode = leaf;
    expectingChild = false;
  };

  const assignLabelToken = (raw: string): void => {
    const label = normalizeQuotedLabel(raw);
    if (!label && !expectingChild) {
      return;
    }
    if (expectingChild) {
      materializeLeafIfNeeded();
    } else if (lastNode < 0) {
      const leaf = createNode(-1);
      if (root < 0) {
        root = leaf;
      }
      lastNode = leaf;
    }
    if (lastNode >= 0) {
      nodes[lastNode].name = label;
    }
  };

  const finalizeToken = (endIndex: number): void => {
    const raw = tokenStart >= 0 ? text.slice(tokenStart, endIndex) : "";
    tokenStart = -1;
    if (!raw.trim() && !readingLength) {
      return;
    }
    if (readingLength) {
      if (lengthTarget >= 0) {
        nodes[lengthTarget].branchLength = parseFloatSafe(raw, 0);
        nodes[lengthTarget].hasExplicitLength = true;
      }
      readingLength = false;
      lengthTarget = -1;
      return;
    }
    assignLabelToken(raw);
  };

  const startLength = (): void => {
    if (expectingChild) {
      materializeLeafIfNeeded();
    }
    readingLength = true;
    lengthTarget = lastNode;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i += 1;
        } else {
          inQuote = false;
        }
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      if (tokenStart < 0) {
        tokenStart = i;
      }
      i += 1;
      continue;
    }
    if (ch === "[") {
      finalizeToken(i);
      let depth = 1;
      i += 1;
      while (i < text.length && depth > 0) {
        if (text[i] === "[") {
          depth += 1;
        } else if (text[i] === "]") {
          depth -= 1;
        }
        i += 1;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      finalizeToken(i);
      const parent = stack.length > 0 ? stack[stack.length - 1] : -1;
      const node = createNode(parent);
      if (root < 0) {
        root = node;
      }
      stack.push(node);
      lastNode = -1;
      expectingChild = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      finalizeToken(i);
      lastNode = -1;
      expectingChild = true;
      i += 1;
      continue;
    }
    if (ch === ")") {
      finalizeToken(i);
      if (stack.length === 0) {
        throw new Error("Malformed Newick: unmatched closing parenthesis.");
      }
      lastNode = stack.pop() as number;
      expectingChild = false;
      i += 1;
      continue;
    }
    if (ch === ":") {
      finalizeToken(i);
      startLength();
      i += 1;
      continue;
    }
    if (ch === ";") {
      finalizeToken(i);
      break;
    }
    if (tokenStart < 0) {
      tokenStart = i;
    }
    i += 1;
  }

  finalizeToken(i);

  if (root < 0 || nodes.length === 0) {
    throw new Error("No tree could be parsed from the provided Newick text.");
  }

  let hasAnyExplicitLength = false;
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    if (nodes[nodeIndex].hasExplicitLength) {
      hasAnyExplicitLength = true;
      break;
    }
  }
  if (!hasAnyExplicitLength) {
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      if (nodeIndex !== root) {
        nodes[nodeIndex].branchLength = 1;
      }
    }
  }

  const traversal = [root];
  let maxDepth = 0;
  while (traversal.length > 0) {
    const node = traversal.pop() as number;
    const parent = nodes[node].parent;
    const depth = parent >= 0 ? nodes[parent].depth + nodes[node].branchLength : 0;
    nodes[node].depth = depth;
    if (nodes[node].children.length === 0 && depth > maxDepth) {
      maxDepth = depth;
    }
    const children = nodes[node].children;
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
      traversal.push(children[childIndex]);
    }
  }

  return {
    nodes,
    root,
    maxDepth,
    hasBranchLengths: hasAnyExplicitLength,
  };
}

function buildTopology(nodes: TempNode[], root: number): {
  buffers: WorkerTreePayload["buffers"];
  leafNodes: Int32Array;
  names: string[];
  isUltrametric: boolean;
  rootAge: number;
  minPositiveBranchLength: number;
} {
  const nodeCount = nodes.length;
  const parent = new Int32Array(nodeCount);
  const firstChild = new Int32Array(nodeCount);
  const nextSibling = new Int32Array(nodeCount);
  const branchLength = new Float64Array(nodeCount);
  const depth = new Float64Array(nodeCount);
  const leafCount = new Int32Array(nodeCount);
  const names = new Array<string>(nodeCount);

  parent.fill(-1);
  firstChild.fill(-1);
  nextSibling.fill(-1);

  const postorder: number[] = [];
  const stack: number[] = [root];

  while (stack.length > 0) {
    const node = stack.pop() as number;
    postorder.push(node);
    const children = nodes[node].children;
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      stack.push(children[childIndex]);
    }
  }

  let minPositiveBranchLength = Number.POSITIVE_INFINITY;
  const leafNodesArray: number[] = [];

  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    const source = nodes[nodeIndex];
    parent[nodeIndex] = source.parent;
    branchLength[nodeIndex] = source.branchLength;
    depth[nodeIndex] = source.depth;
    names[nodeIndex] = source.name;
    const children = source.children;
    if (children.length > 0) {
      firstChild[nodeIndex] = children[0];
      for (let childIndex = 0; childIndex < children.length - 1; childIndex += 1) {
        nextSibling[children[childIndex]] = children[childIndex + 1];
      }
    } else {
      leafNodesArray.push(nodeIndex);
    }
    if (nodeIndex !== root && branchLength[nodeIndex] > 0 && branchLength[nodeIndex] < minPositiveBranchLength) {
      minPositiveBranchLength = branchLength[nodeIndex];
    }
  }

  for (let idx = postorder.length - 1; idx >= 0; idx -= 1) {
    const node = postorder[idx];
    const child = firstChild[node];
    if (child < 0) {
      leafCount[node] = 1;
      nodes[node].leafCount = 1;
      continue;
    }
    let total = 0;
    let cursor = child;
    while (cursor >= 0) {
      total += leafCount[cursor];
      cursor = nextSibling[cursor];
    }
    leafCount[node] = total;
    nodes[node].leafCount = total;
  }

  let leafDepthMin = Number.POSITIVE_INFINITY;
  let leafDepthMax = Number.NEGATIVE_INFINITY;
  let leafDepthTotal = 0;
  for (let idx = 0; idx < leafNodesArray.length; idx += 1) {
    const node = leafNodesArray[idx];
    const value = depth[node];
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

  return {
    buffers: {
      parent,
      firstChild,
      nextSibling,
      branchLength,
      depth,
      leafCount,
    },
    leafNodes: new Int32Array(leafNodesArray),
    names,
    isUltrametric,
    rootAge,
    minPositiveBranchLength: Number.isFinite(minPositiveBranchLength) ? minPositiveBranchLength : 1,
  };
}

function collectChildren(firstChild: Int32Array, nextSibling: Int32Array, node: number): number[] {
  const children: number[] = [];
  let cursor = firstChild[node];
  while (cursor >= 0) {
    children.push(cursor);
    cursor = nextSibling[cursor];
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
    const entry = stack.pop() as { node: number; expanded: boolean };
    const node = entry.node;
    const child = firstChild[node];
    if (!entry.expanded && child >= 0) {
      stack.push({ node, expanded: true });
      const children = sortChildren(collectChildren(firstChild, nextSibling, node), leafCount, order);
      for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
        stack.push({ node: children[childIndex], expanded: false });
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
    const children = sortChildren(collectChildren(firstChild, nextSibling, node), leafCount, order);
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const childNode = children[childIndex];
      if (min[childNode] < first) {
        first = min[childNode];
      }
      if (max[childNode] > last) {
        last = max[childNode];
      }
    }
    min[node] = first;
    max[node] = last;
    const firstChildCenter = center[children[0]];
    const lastChildCenter = center[children[children.length - 1]];
    center[node] = (firstChildCenter + lastChildCenter) * 0.5;
  }

  return { center, min, max };
}

function buildPayload(
  text: string,
  onProgress: (message: string) => void,
): { payload: WorkerTreePayload; transfers: Transferable[] } {
  onProgress("Parsing Newick text...");
  const parsed = parseNewick(text);
  onProgress("Building topology arrays...");
  const topology = buildTopology(parsed.nodes, parsed.root);
  onProgress("Computing input-order layout...");
  const layouts = {
    input: buildLayout(parsed.root, topology.buffers, "input"),
    desc: (() => {
      onProgress("Computing descendant-first layout...");
      return buildLayout(parsed.root, topology.buffers, "desc");
    })(),
    asc: (() => {
      onProgress("Computing descendant-last layout...");
      return buildLayout(parsed.root, topology.buffers, "asc");
    })(),
  } satisfies Record<LayoutOrder, LayoutBuffers>;

  const payload: WorkerTreePayload = {
    root: parsed.root,
    nodeCount: parsed.nodes.length,
    leafCount: topology.leafNodes.length,
    maxDepth: parsed.maxDepth,
    rootAge: topology.rootAge,
    hasBranchLengths: parsed.hasBranchLengths,
    isUltrametric: topology.isUltrametric,
    leafNodes: topology.leafNodes,
    names: topology.names,
    buffers: topology.buffers,
    layouts,
  };

  const transfers: Transferable[] = [
    payload.leafNodes.buffer,
    payload.buffers.parent.buffer,
    payload.buffers.firstChild.buffer,
    payload.buffers.nextSibling.buffer,
    payload.buffers.branchLength.buffer,
    payload.buffers.depth.buffer,
    payload.buffers.leafCount.buffer,
    payload.layouts.input.center.buffer,
    payload.layouts.input.min.buffer,
    payload.layouts.input.max.buffer,
    payload.layouts.desc.center.buffer,
    payload.layouts.desc.min.buffer,
    payload.layouts.desc.max.buffer,
    payload.layouts.asc.center.buffer,
    payload.layouts.asc.min.buffer,
    payload.layouts.asc.max.buffer,
  ];

  return { payload, transfers };
}

function postProgress(message: string): void {
  const response: ParseProgress = {
    type: "parse-progress",
    message,
  };
  self.postMessage(response);
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function postParsed(payload: WorkerTreePayload, transfers: Transferable[]): void {
  const response: ParsedTreeResponse = {
    type: "parsed-tree",
    payload,
  };
  self.postMessage(response, transfers);
}

function postError(error: unknown): void {
  const response: ParseTreeError = {
    type: "parse-error",
    message: error instanceof Error ? error.message : String(error),
  };
  self.postMessage(response);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type !== "parse-tree") {
    return;
  }
  try {
    postProgress("Worker started.");
    await yieldToLoop();
    const { payload, transfers } = buildPayload(message.text, postProgress);
    await yieldToLoop();
    postProgress("Layout complete. Sending tree to UI...");
    await yieldToLoop();
    postParsed(payload, transfers);
  } catch (error) {
    postError(error);
  }
};
