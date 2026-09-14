import type { IndexedSegment } from "./spatialIndex";
import type { LayoutBuffers, TreeModel } from "../types/tree";

/** Cull whole clade sectors, expanding descendants as their angular span becomes visible. */
export class CircularTreeIndex {
  private maximumRadius: Float64Array | null = null;

  constructor(
    private readonly tree: TreeModel,
    private readonly radius: (node: number) => number,
    private readonly theta: (row: number) => number,
  ) {}

  private getMaximumRadius(): Float64Array {
    if (this.maximumRadius) return this.maximumRadius;
    const { tree } = this;
    const maximum = new Float64Array(tree.nodeCount);
    const order = new Int32Array(tree.nodeCount);
    order[0] = tree.root;
    let length = 1;
    for (let i = 0; i < length; i++) {
      const node = order[i];
      maximum[node] = this.radius(node);
      for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
        order[length++] = child;
      }
    }
    // Node ids need not put parents before children; reverse traversal does.
    for (let i = length - 1; i > 0; i--) {
      const node = order[i];
      const parent = tree.buffers.parent[node];
      maximum[parent] = Math.max(maximum[parent], maximum[node]);
    }
    this.maximumRadius = maximum;
    return maximum;
  }

  query(
    layout: LayoutBuffers,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    aggregateWorld = 0,
  ): IndexedSegment[] {
    const { tree, radius, theta } = this;
    const maximum = this.getMaximumRadius();
    const hits: IndexedSegment[] = [];
    const stack = [tree.root];
    const { parent, firstChild, nextSibling } = tree.buffers;
    const overlaps = (inner: number, outer: number, low: number, high: number): boolean => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const add = (angle: number) => {
        const c = Math.cos(angle), s = Math.sin(angle);
        x0 = Math.min(x0, inner * c, outer * c);
        x1 = Math.max(x1, inner * c, outer * c);
        y0 = Math.min(y0, inner * s, outer * s);
        y1 = Math.max(y1, inner * s, outer * s);
      };
      add(low);
      add(high);
      // Sector extrema include every quadrant crossed, even for a rotated fan.
      for (let k = Math.ceil(low / (Math.PI / 2)); k * Math.PI / 2 < high; k++) {
        add(k * Math.PI / 2);
      }
      return x1 >= minX && x0 <= maxX && y1 >= minY && y0 <= maxY;
    };
    const stem = (node: number, from: number, to: number, angle: number) => {
      const c = Math.cos(angle), s = Math.sin(angle);
      const x = from * c, y = from * s;
      const dx = (to - from) * c, dy = (to - from) * s;
      let low = 0, high = 1;
      const clip = (p: number, q: number): boolean => {
        if (p === 0) return q >= 0;
        if (p < 0) low = Math.max(low, q / p);
        else high = Math.min(high, q / p);
        return low <= high;
      };
      // Clip coordinates as well as visibility: GPU paths must not contain
      // branches extending millions of screen pixels outside the viewport.
      if (!clip(-dx, x - minX) || !clip(dx, maxX - x)
        || !clip(-dy, y - minY) || !clip(dy, maxY - y)) return;
      hits.push({ node, kind: "stem", x1: x + low * dx, y1: y + low * dy, x2: x + high * dx, y2: y + high * dy });
    };
    while (stack.length) {
      const node = stack.pop()!;
      const r = radius(node);
      const start = theta(layout.min[node]), end = theta(layout.max[node]);
      const mid = theta(layout.center[node]);
      const parentRadius = parent[node] < 0 ? r : radius(parent[node]);
      if (!overlaps(parentRadius, maximum[node], start, end)) continue;
      if (parent[node] >= 0) stem(node, parentRadius, r, mid);
      if (firstChild[node] < 0) continue;
      if (aggregateWorld > 0 && (end - start) * maximum[node] < aggregateWorld) {
        // Preserve the furthest descendant, including non-ultrametric tips.
        // Resolvable clades always expand into actual branches, without a budget.
        stem(node, r, maximum[node], mid);
        continue;
      }
      let low = Infinity, high = -Infinity, count = 0;
      for (let child = firstChild[node]; child >= 0; child = nextSibling[child]) {
        stack.push(child);
        low = Math.min(low, theta(layout.center[child]));
        high = Math.max(high, theta(layout.center[child]));
        count++;
      }
      if (count >= 2 && overlaps(r, r, low, high)) {
        // The renderer reconstructs the exact arc from this node's children.
        hits.push({ node, kind: "connector", x1: r * Math.cos(low), y1: r * Math.sin(low), x2: r * Math.cos(high), y2: r * Math.sin(high) });
      }
    }
    return hits;
  }
}
