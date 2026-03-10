import type { UniformGridIndex, IndexedSegment } from "../lib/spatialIndex";
import type { TaxonomyMapPayload } from "../types/taxonomy";
import type { HoverInfo, LayoutOrder, TreeModel, ViewMode, ZoomAxisMode } from "../types/tree";

export interface TreeCanvasProps {
  tree: TreeModel | null;
  order: LayoutOrder;
  viewMode: ViewMode;
  zoomAxisMode: ZoomAxisMode;
  circularRotation: number;
  showTimeStripes: boolean;
  showScaleBars: boolean;
  showGenusLabels: boolean;
  taxonomyEnabled: boolean;
  taxonomyMap: TaxonomyMapPayload | null;
  showNodeHeightLabels: boolean;
  searchQuery: string;
  searchMatches: number[];
  activeSearchNode: number | null;
  activeSearchGenusCenterNode: number | null;
  focusNodeRequest: number;
  fitRequest: number;
  exportSvgRequest: number;
  onHoverChange: (hover: HoverInfo | null) => void;
}

export interface RectCamera {
  kind: "rect";
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
}

export interface CircularCamera {
  kind: "circular";
  scale: number;
  translateX: number;
  translateY: number;
  rotation: number;
  rotationCos: number;
  rotationSin: number;
}

export type CameraState = RectCamera | CircularCamera;

export interface GenusBlock {
  label: string;
  firstNode: number;
  lastNode: number;
  centerNode: number;
  maxDepth: number;
  memberCount: number;
}

export interface RenderCache {
  orderedChildren: Record<LayoutOrder, number[][]>;
  orderedLeaves: Record<LayoutOrder, number[]>;
  genusBlocks: Record<LayoutOrder, GenusBlock[]>;
  genusBlocksPriority: Record<LayoutOrder, GenusBlock[]>;
  rectSegments: Record<LayoutOrder, IndexedSegment[]>;
  rectIndices: Record<LayoutOrder, UniformGridIndex>;
  circularSegments: Record<LayoutOrder, IndexedSegment[]>;
  circularIndices: Record<LayoutOrder, UniformGridIndex>;
}

export interface ScreenLabel {
  x: number;
  y: number;
  text: string;
  alpha: number;
  key?: string;
  rank?: string;
  theta?: number;
  fontSize?: number;
  rotation?: number;
  align?: CanvasTextAlign;
  color?: string;
  offsetY?: number;
  clipArc?: {
    innerRadiusPx: number;
    outerRadiusPx: number;
    startTheta: number;
    endTheta: number;
  };
}

export interface LabelHitbox {
  node: number;
  kind: "rect" | "rotated";
  source?: "label" | "collapse" | "collapse-edge";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  align?: CanvasTextAlign;
}

export interface StripeLevel {
  step: number;
  alpha: number;
}

export interface StripeBoundary {
  value: number;
  alpha: number;
}

export interface CircularScaleTick {
  boundary: StripeBoundary;
  position: number;
}

export interface CircularScaleBar {
  kind: "bottom" | "left";
  axisPosition: number;
  ticks: CircularScaleTick[];
}

export type HoverTargetKind = "stem" | "connector" | "label";
export type HoverSegment = Pick<IndexedSegment, "kind" | "x1" | "y1" | "x2" | "y2">;
export type CanvasHoverInfo = HoverInfo & {
  targetKind: HoverTargetKind;
  hoveredSegment?: HoverSegment;
  ownerNode?: number;
};

export const LABEL_FONT = `"IBM Plex Sans", "Segoe UI", sans-serif`;
export const BRANCH_COLOR = "#0f172a";
export const HOVER_COLOR = "#c2410c";
export const GENUS_COLOR = "#475569";
