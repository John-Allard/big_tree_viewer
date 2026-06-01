import { UniformGridIndex, type IndexedSegment } from "../lib/spatialIndex";
import { DEFAULT_TIME_AXIS_LOG_BASE, depthToTimeAxisDepth, treeTimeAxisExtent, type TimeAxisScale } from "../lib/timeAxis";
import type { LayoutOrder, TreeModel } from "../types/tree";
import type { GenusBlock, RenderCache } from "./treeCanvasTypes";
import {
  appendCircularArcSegments,
  extractGenusToken,
  polarToCartesian,
  thetaFor,
  arcAnglesWithinSpan,
} from "./treeCanvasUtils";

const ORDER_KEYS: LayoutOrder[] = ["input", "desc", "asc"];

function lazyOrderRecord<T>(factory: (order: LayoutOrder) => T): Record<LayoutOrder, T> {
  const values: Partial<Record<LayoutOrder, T>> = {};
  const record = {} as Record<LayoutOrder, T>;
  for (const order of ORDER_KEYS) {
    Object.defineProperty(record, order, {
      enumerable: true,
      configurable: false,
      get: () => {
        if (!(order in values)) {
          values[order] = factory(order);
        }
        return values[order] as T;
      },
    });
  }
  return record;
}

export function computeOrderedLeaves(tree: TreeModel, order: LayoutOrder): number[] {
  return [...tree.leafNodes].sort((left, right) => tree.layouts[order].center[left] - tree.layouts[order].center[right]);
}

export function computeGenusBlocks(tree: TreeModel, orderedLeaves: number[], timeAxisScale: TimeAxisScale, timeAxisLogBase = DEFAULT_TIME_AXIS_LOG_BASE): GenusBlock[] {
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
    let maxDepth = depthToTimeAxisDepth(tree, tree.buffers.depth[node], timeAxisScale, timeAxisLogBase);
    while (end < orderedLeaves.length) {
      const nextNode = orderedLeaves[end];
      const nextToken = extractGenusToken(tree.names[nextNode] || "");
      if (nextToken !== token) {
        break;
      }
      maxDepth = Math.max(maxDepth, depthToTimeAxisDepth(tree, tree.buffers.depth[nextNode], timeAxisScale, timeAxisLogBase));
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

export function buildCache(tree: TreeModel, timeAxisScale: TimeAxisScale = "linear", timeAxisLogBase = DEFAULT_TIME_AXIS_LOG_BASE): RenderCache {
  const orderedChildren = lazyOrderRecord((order) => computeOrderedChildren(tree, order));
  const orderedLeaves = lazyOrderRecord((order) => computeOrderedLeaves(tree, order));
  const genusBlocks = lazyOrderRecord((order) => computeGenusBlocks(tree, orderedLeaves[order], timeAxisScale, timeAxisLogBase));
  const genusBlocksPriority = lazyOrderRecord((order) => prioritizeGenusBlocks(tree, order, genusBlocks[order]));

  const axisExtent = timeAxisScale === "log" ? treeTimeAxisExtent(tree) : Math.max(tree.maxDepth, 1);
  const axisDepth = (node: number): number => depthToTimeAxisDepth(tree, tree.buffers.depth[node], timeAxisScale, timeAxisLogBase);
  const boundsRect = {
    minX: 0,
    minY: 0,
    maxX: Math.max(axisExtent, 1),
    maxY: Math.max(tree.leafCount - 1, 1),
  };
  const radius = Math.max(axisExtent, 1);
  const boundsCircular = {
    minX: -radius,
    minY: -radius,
    maxX: radius,
    maxY: radius,
  };

  const buildRectSegments = (order: LayoutOrder): IndexedSegment[] => {
    const center = tree.layouts[order].center;
    const children = orderedChildren[order];
    const rect: IndexedSegment[] = [];
    for (let node = 0; node < tree.nodeCount; node += 1) {
      const parent = tree.buffers.parent[node];
      if (parent < 0) {
        if (children[node].length >= 2) {
          rect.push({
            node,
            kind: "connector",
            x1: axisDepth(node),
            y1: center[children[node][0]],
            x2: axisDepth(node),
            y2: center[children[node][children[node].length - 1]],
          });
        }
        continue;
      }
      const y = center[node];
      rect.push({
        node,
        kind: "stem",
        x1: axisDepth(parent),
        y1: y,
        x2: axisDepth(node),
        y2: y,
      });
      if (children[node].length >= 2) {
        rect.push({
          node,
          kind: "connector",
          x1: axisDepth(node),
          y1: center[children[node][0]],
          x2: axisDepth(node),
          y2: center[children[node][children[node].length - 1]],
        });
      }
    }
    return rect;
  };

  const buildCircularSegments = (order: LayoutOrder): IndexedSegment[] => {
    const center = tree.layouts[order].center;
    const layout = tree.layouts[order];
    const children = orderedChildren[order];
    const radial: IndexedSegment[] = [];
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
          appendCircularArcSegments(radial, node, axisDepth(node), arcAngles.start, arcAngles.end);
        }
        continue;
      }
      const theta = thetaFor(center, node, tree.leafCount);
      const start = polarToCartesian(axisDepth(parent), theta);
      const end = polarToCartesian(axisDepth(node), theta);
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
        appendCircularArcSegments(radial, node, axisDepth(node), arcAngles.start, arcAngles.end);
      }
    }
    return radial;
  };

  const rectSegments = lazyOrderRecord(buildRectSegments);
  const circularSegments = lazyOrderRecord(buildCircularSegments);
  const rectIndices = lazyOrderRecord((order) => new UniformGridIndex(rectSegments[order], boundsRect));
  const circularIndices = lazyOrderRecord((order) => new UniformGridIndex(circularSegments[order], boundsCircular));

  return {
    orderedChildren,
    orderedLeaves,
    genusBlocks,
    genusBlocksPriority,
    rectSegments,
    rectIndices,
    circularSegments,
    circularIndices,
  };
}
