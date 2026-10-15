import type { TreeModel } from "../types/tree";

// Geometry only: retain the original branch lengths and all node identities.
export function createCladogramTree(source: TreeModel, ultrametric: boolean): TreeModel {
  const depth = new Float64Array(source.nodeCount);
  const stack = new Int32Array(source.nodeCount);
  let count = 1;
  stack[0] = source.root;
  let maxDepth = 0;
  while (count > 0) {
    const node = stack[--count];
    maxDepth = Math.max(maxDepth, depth[node]);
    for (let child = source.buffers.firstChild[node]; child >= 0; child = source.buffers.nextSibling[child]) {
      depth[child] = depth[node] + 1;
      stack[count++] = child;
    }
  }
  let minimumTipDepth = maxDepth;
  for (const node of source.leafNodes) {
    if (ultrametric) depth[node] = maxDepth;
    minimumTipDepth = Math.min(minimumTipDepth, depth[node]);
  }
  return {
    ...source,
    buffers: { ...source.buffers, depth },
    maxDepth,
    rootAge: maxDepth,
    isUltrametric: minimumTipDepth === maxDepth,
    branchLengthMinPositive: 1,
  };
}
