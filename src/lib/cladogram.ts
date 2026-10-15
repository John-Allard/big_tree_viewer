import type { TreeModel } from "../types/tree";

export const ULTRAMETRIC_CLADOGRAM_METHODS = ["levels", "logarithmic", "grafen"] as const;
export type UltrametricCladogramMethod = typeof ULTRAMETRIC_CLADOGRAM_METHODS[number];
export const DEFAULT_ULTRAMETRIC_CLADOGRAM_METHOD: UltrametricCladogramMethod = "levels";
export const DEFAULT_CLADOGRAM_LOG_STRENGTH = 1;
export const MIN_CLADOGRAM_LOG_STRENGTH = 1;
export const MAX_CLADOGRAM_LOG_STRENGTH = 10;

export function normalizeCladogramLogStrength(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(MIN_CLADOGRAM_LOG_STRENGTH, Math.min(MAX_CLADOGRAM_LOG_STRENGTH, value))
    : DEFAULT_CLADOGRAM_LOG_STRENGTH;
}

export function isUltrametricCladogramMethod(value: unknown): value is UltrametricCladogramMethod {
  return typeof value === "string" && (ULTRAMETRIC_CLADOGRAM_METHODS as readonly string[]).includes(value);
}

// Geometry only: retain the original branch lengths and all node identities.
export function createCladogramTree(
  source: TreeModel,
  ultrametric: boolean,
  method: UltrametricCladogramMethod = DEFAULT_ULTRAMETRIC_CLADOGRAM_METHOD,
  logStrength = DEFAULT_CLADOGRAM_LOG_STRENGTH,
): TreeModel {
  const depth = new Float64Array(source.nodeCount);
  let maxDepth = 0;
  let minPositiveBranchLength = Number.POSITIVE_INFINITY;
  if (ultrametric) {
    if (method === "levels") {
      // Build a parent-before-child order; node indices need not be topological.
      const traversal = new Int32Array(source.nodeCount);
      traversal[0] = source.root;
      let count = 1;
      for (let index = 0; index < count; index += 1) {
        for (let child = source.buffers.firstChild[traversal[index]]; child >= 0; child = source.buffers.nextSibling[child]) {
          traversal[count++] = child;
        }
      }
      // Heights are measured back from the tips, not forward from the root.
      for (let index = count - 1; index >= 0; index -= 1) {
        const node = traversal[index];
        const parent = source.buffers.parent[node];
        if (parent >= 0) depth[parent] = Math.max(depth[parent], depth[node] + 1);
      }
    } else {
      for (let node = 0; node < source.nodeCount; node += 1) {
        const descendants = source.buffers.leafCount[node];
        depth[node] = method === "logarithmic" ? Math.log(descendants) : descendants - 1;
      }
    }
    const rootHeight = depth[source.root];
    const exponent = method === "logarithmic" ? normalizeCladogramLogStrength(logStrength) : 1;
    maxDepth = rootHeight > 0 ? 1 : 0;
    for (let node = 0; node < source.nodeCount; node += 1) {
      depth[node] = rootHeight > 0
        ? exponent === 1 ? (rootHeight - depth[node]) / rootHeight : 1 - Math.pow(depth[node] / rootHeight, exponent)
        : 0;
    }
    for (let node = 0; node < source.nodeCount; node += 1) {
      const parent = source.buffers.parent[node];
      if (parent >= 0) {
        const length = depth[node] - depth[parent];
        if (length > 0) minPositiveBranchLength = Math.min(minPositiveBranchLength, length);
      }
    }
  } else {
    const stack = new Int32Array(source.nodeCount);
    let count = 1;
    stack[0] = source.root;
    while (count > 0) {
      const node = stack[--count];
      maxDepth = Math.max(maxDepth, depth[node]);
      for (let child = source.buffers.firstChild[node]; child >= 0; child = source.buffers.nextSibling[child]) {
        depth[child] = depth[node] + 1;
        stack[count++] = child;
      }
    }
    minPositiveBranchLength = 1;
  }
  let minimumTipDepth = maxDepth;
  for (const node of source.leafNodes) {
    minimumTipDepth = Math.min(minimumTipDepth, depth[node]);
  }
  return {
    ...source,
    buffers: { ...source.buffers, depth },
    maxDepth,
    rootAge: maxDepth,
    isUltrametric: minimumTipDepth === maxDepth,
    branchLengthMinPositive: Number.isFinite(minPositiveBranchLength) ? minPositiveBranchLength : 1,
  };
}
