import type { UniformGridIndex, IndexedSegment } from "../lib/spatialIndex";
import type { FigureStyleSettings } from "../lib/figureStyles";
import type { MetadataMarkerStyle, MetadataPieDatum } from "../lib/metadataColors";
import type { PhyloPicSilhouette } from "../lib/phylopic";
import type { TaxonomyColorPaletteKey } from "../lib/taxonomyPalettes";
import type { TimeAxisScale } from "../lib/timeAxis";
import type { TaxonomyCollapseRank, TaxonomyMapPayload, TaxonomyRank } from "../types/taxonomy";
import type { HoverInfo, LayoutOrder, TreeModel, ViewMode, ZoomAxisMode } from "../types/tree";

export type TimeStripeStyle = "bands" | "age-gradient" | "dashed";
export type TaxonomyOverlayStyle = "ribbons" | "strands";
export type TaxonomyRankDisplayMode = "hidden" | "label-only" | "ribbon";
export type AutomationExportFormat = "svg" | "png";
export type AutomationExportDelivery = "download" | "postMessage";

export interface AutomationExportRequest {
  id: number;
  format: AutomationExportFormat;
  delivery: AutomationExportDelivery;
  filename: string;
  width?: number;
  height?: number;
}

export interface AutomationExportResult {
  id: number;
  format: AutomationExportFormat;
  delivery: AutomationExportDelivery;
  filename: string;
  mimeType: string;
  ok: boolean;
  text?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
  message?: string;
}

export interface TreeCanvasProps {
  tree: TreeModel | null;
  order: LayoutOrder;
  viewMode: ViewMode;
  zoomAxisMode: ZoomAxisMode;
  circularRotation: number;
  spiralTurns: number;
  showTimeStripes: boolean;
  timeStripeStyle: TimeStripeStyle;
  timeStripeLineWeight: number;
  showScaleBars: boolean;
  timeAxisScale: TimeAxisScale;
  timeAxisLogBase: number;
  scaleTickInterval: number | null;
  showIntermediateScaleTicks: boolean;
  extendRectScaleToTick: boolean;
  showScaleZeroTick: boolean;
  circularCenterScaleAngleDegrees: number;
  useAutoCircularCenterScaleAngle: boolean;
  showCircularCenterRadialScaleBar: boolean;
  showTipLabels: boolean;
  showGenusLabels: boolean;
  taxonomyEnabled: boolean;
  taxonomyOverlayStyle: TaxonomyOverlayStyle;
  taxonomyBranchColoringEnabled: boolean;
  taxonomyColorJitter: number;
  taxonomyColorPalette: TaxonomyColorPaletteKey;
  taxonomyCustomPaletteColors: string[];
  taxonomyColorRootRank: TaxonomyRank | "auto";
  taxonomyColorJitterRank: TaxonomyRank;
  taxonomyRankDisplayModes: Partial<Record<TaxonomyRank, TaxonomyRankDisplayMode>>;
  useAutomaticTaxonomyRankVisibility: boolean;
  taxonomyRankVisibility: Partial<Record<TaxonomyRank, boolean>>;
  taxonomyCollapseRank: TaxonomyCollapseRank;
  taxonomyMap: TaxonomyMapPayload | null;
  taxonomyColorSourceMap?: TaxonomyMapPayload | null;
  phylopicEnabled: boolean;
  phylopicSilhouettes: PhyloPicSilhouette[];
  phylopicPlacement: "after-label" | "outside-ribbon";
  phylopicSizeScale: number;
  phylopicOffsetXPx: number;
  phylopicOffsetYPx: number;
  onPhyloPicRemoveSilhouette?: (silhouette: PhyloPicSilhouette) => void;
  onPhyloPicTryAnotherSilhouette?: (silhouette: PhyloPicSilhouette) => void;
  hideDownloadNewick?: boolean;
  sharedSubtreeSourceTree?: TreeModel | null;
  sharedSubtreeSourceTaxonomyMap?: TaxonomyMapPayload | null;
  sharedSubtreeSourceNodeByViewNode?: Int32Array | null;
  metadataBranchColors: Array<string | null> | null;
  metadataBranchColorVersion: string;
  metadataLabels: Array<string | null> | null;
  metadataLabelVersion: string;
  metadataMarkers: Array<MetadataMarkerStyle | null> | null;
  metadataMarkerVersion: string;
  metadataPies: Array<MetadataPieDatum | null> | null;
  metadataPieVersion: string;
  metadataPieSizePx: number;
  metadataMarkerSizePx: number;
  metadataLabelMaxCount: number;
  metadataLabelMinSpacingPx: number;
  metadataLabelOffsetXPx: number;
  metadataLabelOffsetYPx: number;
  showInternalNodeLabels: boolean;
  showBootstrapLabels: boolean;
  figureStyles: FigureStyleSettings;
  branchThicknessScale: number;
  showNodeHeightLabels: boolean;
  showNodeErrorBars: boolean;
  errorBarThicknessPx: number;
  errorBarCapSizePx: number;
  searchQuery: string;
  searchMatches: number[];
  activeSearchNode: number | null;
  activeSearchGenusCenterNode: number | null;
  activeSearchTaxonomyNode: number | null;
  activeSearchTaxonomyKey: string | null;
  focusNodeRequest: number;
  fitRequest: number;
  exportSvgRequest: number;
  exportSvgFilename: string;
  exportPngRequest: number;
  exportPngFilename: string;
  exportPngWidth: number;
  exportPngHeight: number;
  automationExportRequest: AutomationExportRequest | null;
  sessionStateRequest: number;
  sessionRestoreRequest: number;
  sessionRestoreState: TreeCanvasSessionState | null;
  visualResetRequest: number;
  tutorialBranchMenuDemoActive?: boolean;
  onHoverChange: (hover: HoverInfo | null) => void;
  onRerootRequest?: (node: number, mode: "branch" | "child" | "parent") => void;
  onViewModeChange?: (mode: ViewMode) => void;
  onSessionStateSnapshot?: (state: TreeCanvasSessionState) => void;
  onSessionRestoreComplete?: () => void;
  onAutomationExportComplete?: (result: AutomationExportResult) => void;
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

export interface TreeCanvasSessionState {
  camera: CameraState | null;
  viewportWidth?: number;
  viewportHeight?: number;
  collapsedNodes: number[];
  manualBranchColors: Array<[number, string]>;
  manualSubtreeColors: Array<[number, string]>;
}

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
  taxonomyDisplayMode?: TaxonomyRankDisplayMode;
  theta?: number;
  fontSize?: number;
  bandSizePx?: number;
  rotation?: number;
  phylopicNormalX?: number;
  phylopicNormalY?: number;
  align?: CanvasTextAlign;
  color?: string;
  searchHighlightColor?: string;
  searchMatchRange?: {
    start: number;
    end: number;
  } | null;
  offsetY?: number;
  taxId?: number | null;
  firstNode?: number;
  lastNode?: number;
  taxonomyTipCount?: number;
  clipArc?: {
    innerRadiusPx: number;
    outerRadiusPx: number;
    startTheta: number;
    endTheta: number;
    skipClip?: boolean;
  };
}

export interface LabelHitbox {
  node: number;
  kind: "rect" | "rotated";
  source?: "label" | "collapse" | "collapse-edge";
  labelKind?: "tip" | "taxonomy" | "genus";
  text?: string;
  taxonomyRank?: string;
  taxonomyTaxId?: number | null;
  taxonomyFirstNode?: number;
  taxonomyLastNode?: number;
  taxonomyTipCount?: number;
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
