import type { IndexedSegment } from "./spatialIndex";
import type { LayoutBuffers, TreeModel } from "../types/tree";

/** Query clade intervals directly instead of materializing every branch in grid cells. */
export class RectTreeIndex {
  private maximumDepth: Float64Array | null = null;
  constructor(
    private readonly tree: TreeModel,
    private readonly axisDepth: (depth: number) => number,
  ) {}

  private getMaximumDepth(): Float64Array {
    if (this.maximumDepth) return this.maximumDepth;
    const { tree } = this;
    const maximum = new Float64Array(tree.buffers.depth);
    const order = new Int32Array(tree.nodeCount);
    order[0] = tree.root;
    let length = 1;
    for (let i = 0; i < length; i++) {
      for (let child = tree.buffers.firstChild[order[i]]; child >= 0; child = tree.buffers.nextSibling[child]) {
        order[length++] = child;
      }
    }
    for (let i = length - 1; i > 0; i--) {
      const node = order[i];
      const parent = tree.buffers.parent[node];
      maximum[parent] = Math.max(maximum[parent], maximum[node]);
    }
    this.maximumDepth = maximum;
    return maximum;
  }

  query(
    layout: LayoutBuffers,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    aggregateSpan = 0,
  ): IndexedSegment[] {
    const { tree, axisDepth } = this;
    const { parent, depth, firstChild, nextSibling } = tree.buffers;
    const hits: IndexedSegment[] = [];
    const stack = [tree.root];
    const push = (node: number, kind: IndexedSegment["kind"], x1: number, y1: number, x2: number, y2: number) => {
      if (Math.max(x1, x2) < minX || Math.min(x1, x2) > maxX || Math.max(y1, y2) < minY || Math.min(y1, y2) > maxY) return;
      // Clip geometry, not just the canvas: enormous offscreen coordinates can
      // overflow accelerated rasterization at deep two-axis zoom.
      hits.push({
        node,
        kind,
        x1: Math.max(minX, Math.min(maxX, x1)),
        y1: Math.max(minY, Math.min(maxY, y1)),
        x2: Math.max(minX, Math.min(maxX, x2)),
        y2: Math.max(minY, Math.min(maxY, y2)),
      });
    };
    while (stack.length) {
      const node = stack.pop()!;
      if (layout.max[node] < minY || layout.min[node] > maxY) continue;
      const x = axisDepth(depth[node]);
      const y = layout.center[node];
      if (parent[node] >= 0) push(node, "stem", axisDepth(depth[parent[node]]), y, x, y);
      const first = firstChild[node];
      if (first < 0) continue;
      if (aggregateSpan > 0 && layout.max[node] - layout.min[node] < aggregateSpan) {
        // All descendant rows occupy less than half a screen pixel. Preserve
        // their horizontal extent; expand the actual topology as soon as visible.
        push(node, "stem", x, y, axisDepth(this.getMaximumDepth()[node]), y);
        continue;
      }
      let low = Infinity;
      let high = -Infinity;
      let count = 0;
      for (let child = first; child >= 0; child = nextSibling[child]) {
        low = Math.min(low, layout.center[child]);
        high = Math.max(high, layout.center[child]);
        stack.push(child);
        count++;
      }
      if (count >= 2) push(node, "connector", x, low, x, high);
    }
    return hits;
  }
}
