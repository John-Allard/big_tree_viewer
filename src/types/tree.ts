export type LayoutOrder = "input" | "desc" | "asc";

export type ViewMode = "rectangular" | "circular";

export type ZoomAxisMode = "both" | "x" | "y";

export interface LayoutBuffers {
  center: Float64Array;
  min: Float64Array;
  max: Float64Array;
}

export interface TreeBuffers {
  parent: Int32Array;
  firstChild: Int32Array;
  nextSibling: Int32Array;
  branchLength: Float64Array;
  depth: Float64Array;
  leafCount: Int32Array;
}

export interface WorkerTreePayload {
  root: number;
  nodeCount: number;
  leafCount: number;
  maxDepth: number;
  rootAge: number;
  hasBranchLengths: boolean;
  isUltrametric: boolean;
  leafNodes: Int32Array;
  names: string[];
  buffers: TreeBuffers;
  layouts: Record<LayoutOrder, LayoutBuffers>;
}

export interface TreeModel extends WorkerTreePayload {
  branchLengthMinPositive: number;
}

export interface TreeStats {
  nodeCount: number;
  leafCount: number;
  maxDepth: number;
  rootAge: number;
  isUltrametric: boolean;
  minPositiveBranchLength: number;
}

export interface HoverInfo {
  node: number;
  branchLength: number;
  parentDepth: number;
  parentAge: number | null;
  childAge: number | null;
  descendantTipCount: number;
  name: string;
  screenX: number;
  screenY: number;
}

export interface LoadState {
  loading: boolean;
  message: string;
  error: string | null;
}
