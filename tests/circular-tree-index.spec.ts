import { test, expect } from '@playwright/test';
import { buildCache } from '../src/components/treeCanvasCache';
import type { TreeModel, LayoutBuffers } from '../src/types/tree';
const layout = (center: number[], min: number[], max: number[]): LayoutBuffers => ({center: new Float64Array(center), min: new Float64Array(min), max: new Float64Array(max)});
// Non-ultrametric tree with a root after its descendants in the node arrays.
const tree: TreeModel = {
 root:4,nodeCount:5,leafCount:3,maxDepth:5,rootAge:10/3,isUltrametric:false,hasBranchLengths:true,
 branchLengthMinPositive:1,leafNodes:new Int32Array([0,2,3]),names:['A a','','B b','C c',''],
 nodeIntervalLower:new Float64Array(5),nodeIntervalUpper:new Float64Array(5),nodeIntervalCount:0,
 buffers:{parent:new Int32Array([1,4,1,4,-1]),firstChild:new Int32Array([-1,0,-1,-1,1]),nextSibling:new Int32Array([2,3,-1,-1,-1]),depth:new Float64Array([3,1,2,5,0]),branchLength:new Float64Array([2,1,1,5,0]),leafCount:new Int32Array([1,2,1,1,3])},
 layouts:{input:layout([0,.5,1,2,1.25],[0,0,1,2,0],[0,1,1,2,2]),desc:layout([0,.5,1,2,1.25],[0,0,1,2,0],[0,1,1,2,2]),asc:layout([1,1.5,2,0,.75],[1,1,2,0,0],[1,2,2,0,2])}
};

for (const order of ['input', 'asc', 'desc'] as const) {
  for (const [start, span, inner] of [[0, Math.PI * 2, 0], [-2, Math.PI, 2], [3, 5, 1]]) {
    test(`circular query retains visible geometry: ${order}, ${start}, ${span}, ${inner}`, () => {
      const cache = buildCache(tree, 'linear', undefined, start, span, inner);
      const full = cache.circularSegments[order];
      for (let x = -7; x <= 7; x += 1.7) {
        for (let y = -7; y <= 7; y += 1.7) {
          const result = cache.circularTreeIndex.query(tree.layouts[order], x, y, x + 1, y + 1);
          const keys = new Set(result.map(s => `${s.node}:${s.kind}`));
          // The reference builds the complete tree, independently of clade culling.
          for (const s of full) {
            for (let t = 0; t <= 1; t += 0.1) {
              const px = s.x1 + t * (s.x2 - s.x1), py = s.y1 + t * (s.y2 - s.y1);
              // Arc chords approximate curves: use an interior margin for their samples.
              if (px > x + 0.05 && px < x + 0.95 && py > y + 0.05 && py < y + 0.95) {
                expect(keys.has(`${s.node}:${s.kind}`), `Missing ${s.node}:${s.kind} at ${x},${y}`).toBe(true);
              }
            }
          }
          for (const s of result.filter(s => s.kind === 'stem')) {
            for (const [px, py] of [[s.x1, s.y1], [s.x2, s.y2]]) {
              expect(px).toBeGreaterThanOrEqual(x - 1e-10);
              expect(px).toBeLessThanOrEqual(x + 1 + 1e-10);
              expect(py).toBeGreaterThanOrEqual(y - 1e-10);
              expect(py).toBeLessThanOrEqual(y + 1 + 1e-10);
            }
          }
        }
      }
    });
  }
}
test('aggregation preserves unequal descendant radii and expands to the full topology', () => {
  const cache = buildCache(tree);
  const coarse = cache.circularTreeIndex.query(tree.layouts.input, -6, -6, 6, 6, 100);
  expect(coarse).toHaveLength(1);
  expect(Math.hypot(coarse[0].x2, coarse[0].y2)).toBeCloseTo(5);
  const detail = cache.circularTreeIndex.query(tree.layouts.input, -6, -6, 6, 6);
  expect(detail.filter(s => s.kind === 'stem')).toHaveLength(tree.nodeCount - 1);
  expect(detail.filter(s => s.kind === 'connector')).toHaveLength(2);
});
