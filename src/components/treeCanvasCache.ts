import { UniformGridIndex, type IndexedSegment } from "../lib/spatialIndex";
import type { LayoutOrder, TreeModel } from "../types/tree";
import type { GenusBlock, RenderCache } from "./treeCanvasTypes";
import {
  appendCircularArcSegments,
  extractGenusToken,
  polarToCartesian,
  thetaFor,
  arcAnglesWithinSpan,
} from "./treeCanvasUtils";

export function computeOrderedLeaves(tree: TreeModel, order: LayoutOrder): number[] {
  return [...tree.leafNodes].sort((left, right) => tree.layouts[order].center[left] - tree.layouts[order].center[right]);
}

export function computeGenusBlocks(tree: TreeModel, orderedLeaves: number[]): GenusBlock[] {
  const blocks: GenusBlock[] = [];
  let index = 0;
  while (index < orderedLeaves.length) {
    const node = orderedLeaves[index];
    const token = extractGenusToken(tree.names[node] || "");
    if (!token) {
      index += 1;
      continue;
    }
    let end = index + 1;
    let maxDepth = tree.buffers.depth[node];
    while (end < orderedLeaves.length) {
      const nextNode = orderedLeaves[end];
      const nextToken = extractGenusToken(tree.names[nextNode] || "");
      if (nextToken !== token) {
        break;
      }
      maxDepth = Math.max(maxDepth, tree.buffers.depth[nextNode]);
      end += 1;
    }
    if ((end - index) >= 2) {
      const centerIndex = Math.floor((index + end - 1) * 0.5);
      blocks.push({
        label: token,
        firstNode: orderedLeaves[index],
        lastNode: orderedLeaves[end - 1],
        centerNode: orderedLeaves[centerIndex],
        maxDepth,
        memberCount: end - index,
      });
    }
    index = end;
  }
  return blocks;
}

export function prioritizeGenusBlocks(tree: TreeModel, order: LayoutOrder, blocks: GenusBlock[]): GenusBlock[] {
  return [...blocks].sort((left, right) => (
    right.memberCount - left.memberCount
    || tree.layouts[order].center[left.centerNode] - tree.layouts[order].center[right.centerNode]
  ));
}

export function computeOrderedChildren(tree: TreeModel, order: LayoutOrder): number[][] {
  const childrenByNode = new Array<number[]>(tree.nodeCount);
  for (let node = 0; node < tree.nodeCount; node += 1) {
    const children: number[] = [];
    let child = tree.buffers.firstChild[node];
    while (child >= 0) {
      children.push(child);
      child = tree.buffers.nextSibling[child];
    }
    if (children.length <= 1 || order === "input") {
      childrenByNode[node] = children;
      continue;
    }
    const originalOrder = new Map<number, number>();
    for (let index = 0; index < children.length; index += 1) {
      originalOrder.set(children[index], index);
    }
    const direction = order === "desc" ? -1 : 1;
    childrenByNode[node] = [...children].sort((left, right) => {
      const diff = tree.buffers.leafCount[left] - tree.buffers.leafCount[right];
      if (diff !== 0) {
        return diff * direction;
      }
      return (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0);
    });
  }
  return childrenByNode;
}

export function buildCache(tree: TreeModel): RenderCache {
  const orderedChildren = {
    input: computeOrderedChildren(tree, "input"),
    desc: computeOrderedChildren(tree, "desc"),
    asc: computeOrderedChildren(tree, "asc"),
  } satisfies Record<LayoutOrder, number[][]>;
  const orderedLeaves = {
    input: computeOrderedLeaves(tree, "input"),
    desc: computeOrderedLeaves(tree, "desc"),
    asc: computeOrderedLeaves(tree, "asc"),
  } satisfies Record<LayoutOrder, number[]>;
  const genusBlocks = {
    input: computeGenusBlocks(tree, orderedLeaves.input),
    desc: computeGenusBlocks(tree, orderedLeaves.desc),
    asc: computeGenusBlocks(tree, orderedLeaves.asc),
  } satisfies Record<LayoutOrder, GenusBlock[]>;
  const genusBlocksPriority = {
    input: prioritizeGenusBlocks(tree, "input", genusBlocks.input),
    desc: prioritizeGenusBlocks(tree, "desc", genusBlocks.desc),
    asc: prioritizeGenusBlocks(tree, "asc", genusBlocks.asc),
  } satisfies Record<LayoutOrder, GenusBlock[]>;

  const rectSegments = {
    input: [] as IndexedSegment[],
    desc: [] as IndexedSegment[],
    asc: [] as IndexedSegment[],
  };
  const circularSegments = {
    input: [] as IndexedSegment[],
    desc: [] as IndexedSegment[],
    asc: [] as IndexedSegment[],
  };

  const boundsRect = {
    minX: 0,
    minY: 0,
    maxX: Math.max(tree.maxDepth, 1),
    maxY: Math.max(tree.leafCount - 1, 1),
  };
  const radius = Math.max(tree.maxDepth, 1);
  const boundsCircular = {
    minX: -radius,
    minY: -radius,
    maxX: radius,
    maxY: radius,
  };

  for (const order of ["input", "desc", "asc"] as const) {
    const center = tree.layouts[order].center;
    const layout = tree.layouts[order];
    const children = orderedChildren[order];
    const rect = rectSegments[order];
    const radial = circularSegments[order];
    for (let node = 0; node < tree.nodeCount; node += 1) {
      const parent = tree.buffers.parent[node];
      if (parent < 0) {
        if (children[node].length >= 2) {
          const startTheta = thetaFor(center, children[node][0], tree.leafCount);
          const endTheta = thetaFor(center, children[node][children[node].length - 1], tree.leafCount);
          const arcStart = thetaFor(layout.min, node, tree.leafCount);
          const arcEnd = thetaFor(layout.max, node, tree.leafCount);
          const arcLength = Math.max(0, arcEnd - arcStart);
          const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
          appendCircularArcSegments(radial, node, tree.buffers.depth[node], arcAngles.start, arcAngles.end);
        }
        continue;
      }
      const y = center[node];
      rect.push({
        node,
        kind: "stem",
        x1: tree.buffers.depth[parent],
        y1: y,
        x2: tree.buffers.depth[node],
        y2: y,
      });
      if (children[node].length >= 2) {
        rect.push({
          node,
          kind: "connector",
          x1: tree.buffers.depth[node],
          y1: center[children[node][0]],
          x2: tree.buffers.depth[node],
          y2: center[children[node][children[node].length - 1]],
        });
      }

      const theta = thetaFor(center, node, tree.leafCount);
      const start = polarToCartesian(tree.buffers.depth[parent], theta);
      const end = polarToCartesian(tree.buffers.depth[node], theta);
      radial.push({
        node,
        kind: "stem",
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
      });
      if (children[node].length >= 2) {
        const startTheta = thetaFor(center, children[node][0], tree.leafCount);
        const endTheta = thetaFor(center, children[node][children[node].length - 1], tree.leafCount);
        const arcStart = thetaFor(layout.min, node, tree.leafCount);
        const arcEnd = thetaFor(layout.max, node, tree.leafCount);
        const arcLength = Math.max(0, arcEnd - arcStart);
        const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
        appendCircularArcSegments(radial, node, tree.buffers.depth[node], arcAngles.start, arcAngles.end);
      }
    }
  }

  return {
    orderedChildren,
    orderedLeaves,
    genusBlocks,
    genusBlocksPriority,
    rectSegments,
    rectIndices: {
      input: new UniformGridIndex(rectSegments.input, boundsRect),
      desc: new UniformGridIndex(rectSegments.desc, boundsRect),
      asc: new UniformGridIndex(rectSegments.asc, boundsRect),
    },
    circularSegments,
    circularIndices: {
      input: new UniformGridIndex(circularSegments.input, boundsCircular),
      desc: new UniformGridIndex(circularSegments.desc, boundsCircular),
      asc: new UniformGridIndex(circularSegments.asc, boundsCircular),
    },
  };
}
