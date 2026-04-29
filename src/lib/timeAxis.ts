import type { TreeModel } from "../types/tree";

export type TimeAxisScale = "linear" | "log";

export const DEFAULT_TIME_AXIS_LOG_BASE = 4200;

export function treeTimeAxisExtent(tree: TreeModel): number {
  return Math.max(tree.isUltrametric ? tree.rootAge : tree.maxDepth, tree.branchLengthMinPositive, 1e-9);
}

export function timeAxisLogUnit(extent: number, logBase: number): number {
  const clampedBase = Math.max(1.01, Math.min(10000, logBase));
  return Math.max(extent / clampedBase, extent * 1e-6, 1e-12);
}

export function depthToTimeAxisDepth(tree: TreeModel, depth: number, scale: TimeAxisScale, logBase = DEFAULT_TIME_AXIS_LOG_BASE): number {
  if (scale === "linear") {
    return depth;
  }
  const extent = treeTimeAxisExtent(tree);
  const logUnit = timeAxisLogUnit(extent, logBase);
  const clampedDepth = Math.max(0, Math.min(extent, depth));
  const age = Math.max(0, Math.min(extent, extent - clampedDepth));
  const denominator = Math.log1p(extent / logUnit);
  if (!(denominator > 0)) {
    return clampedDepth;
  }
  const ageRatio = Math.log1p(age / logUnit) / denominator;
  return extent * (1 - Math.max(0, Math.min(1, ageRatio)));
}

export function timeAxisDepthToRawDepth(tree: TreeModel, axisDepth: number, scale: TimeAxisScale, logBase = DEFAULT_TIME_AXIS_LOG_BASE): number {
  if (scale === "linear") {
    return axisDepth;
  }
  const extent = treeTimeAxisExtent(tree);
  const logUnit = timeAxisLogUnit(extent, logBase);
  const clampedAxisDepth = Math.max(0, Math.min(extent, axisDepth));
  const denominator = Math.log1p(extent / logUnit);
  if (!(denominator > 0)) {
    return clampedAxisDepth;
  }
  const ageRatio = 1 - (clampedAxisDepth / extent);
  const age = logUnit * Math.expm1(Math.max(0, Math.min(1, ageRatio)) * denominator);
  return Math.max(0, Math.min(extent, extent - age));
}
