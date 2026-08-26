import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  fontFamilyCss,
  fontStyleCss,
  TAXONOMY_LABEL_SIZE_SCALE_MAX,
  TAXONOMY_LABEL_SIZE_SCALE_MIN,
  type LabelStyleClass,
} from "../lib/figureStyles";
import { putSharedSubtreePayload } from "../lib/taxonomyCache";
import type { SharedSubtreeStoragePayload, SharedSubtreeTaxonomyEntry, SharedSubtreeVisualPayload } from "../lib/sharedSubtreePayload";
import { distanceToSegmentSquared, UniformGridIndex, type IndexedSegment } from "../lib/spatialIndex";
import { buildTaxonomyBlocksForOrderedLeaves, colorForTaxonomy, taxonomyEntityKey, type TaxonomyColorByRank } from "../lib/taxonomyBlocks";
import { TAXONOMY_COLOR_PALETTES, type TaxonomyColorPaletteKey } from "../lib/taxonomyPalettes";
import type { PhyloPicSilhouette } from "../lib/phylopic";
import { metadataTipTableContinuousColor, metadataTipTableValueIsOn } from "../lib/metadataTipTable";
import { depthToTimeAxisDepth, timeAxisDepthToRawDepth, timeAxisLogUnit, treeTimeAxisExtent, type TimeAxisScale } from "../lib/timeAxis";
import { isAutomaticTaxonomyRank, TAXONOMY_RANKS, type TaxonomyBlock, type TaxonomyBlocksByOrder, type TaxonomyMapPayload, type TaxonomyRank } from "../types/taxonomy";
import { buildCache } from "./treeCanvasCache";
import {
  clampCircularCamera,
  clampRectCamera,
  fitCircularCamera,
  fitRadialCamera,
  fitRectCamera,
  lineIntersectsRect,
  rotateCircularWorldPoint,
  setCircularCameraRotation,
  screenToWorldCircular,
  screenToWorldRect,
  worldToScreenCircular,
  worldToScreenRect,
} from "./treeCanvasCamera";
import type { HoverInfo } from "../types/tree";
import type {
  CameraState,
  CircularCamera,
  CanvasHoverInfo,
  CollapsedNodeMode,
  GenusBlock,
  LabelHitbox,
  RectCamera,
  RenderCache,
  ScreenLabel,
  TaxonomyRankDisplayMode,
  TreeCanvasProps,
  TreeCanvasSessionState,
} from "./treeCanvasTypes";
import {
  BRANCH_COLOR,
  GENUS_COLOR,
  HOVER_COLOR,
  LABEL_FONT,
} from "./treeCanvasTypes";
import {
  arcAnglesWithinSpan,
  arcSubspanWithinSpan,
  appendCircularArcSegments,
  buildCircularScaleBar,
  buildStripeBoundaries,
  buildStripeLevels,
  canPlaceLinearLabel,
  clamp01,
  displayLabelText,
  displayNodeName,
  estimateLabelWidth,
  formatAgeNumber,
  formatScaleNumber,
  nodeHeightValue,
  normalizeRotation,
  pickCircularConnectorChild,
  pickRectConnectorChild,
  pointInLabelHitbox,
  polarToCartesian,
  serializeSubtreeToNewick,
  thetaFor,
  wrapPositive,
} from "./treeCanvasUtils";
import type { LayoutBuffers, LayoutOrder, TreeModel, ViewMode } from "../types/tree";

const SOLID_SCALE_TICK_ALPHA_THRESHOLD = 0.6;
const DASHED_STRIPE_DASH_ARRAY = "6 6";
const RECT_BRANCH_HOVER_MIN_SCALE_Y = 1.45;
const CIRCULAR_BRANCH_HOVER_MIN_ANGULAR_SPACING_PX = 1.6;
const CIRCULAR_NEAR_FIT_SCALE_MULTIPLIER = 1.35;
const CIRCULAR_TAXONOMY_BITMAP_SCALE_MULTIPLIER = 1.18;
const CIRCULAR_TAXONOMY_BITMAP_REUSE_SCALE_MULTIPLIER = 1.2;
const CIRCULAR_TAXONOMY_BITMAP_MIN_VISIBLE_FRACTION = 0.15;
const CIRCULAR_TAXONOMY_DIRECT_PATH_MAX_TIPS = 100_000;
const RECT_TAXONOMY_BITMAP_SCALE_MULTIPLIER = 1.16;
const RECT_TAXONOMY_BITMAP_REUSE_SCALE_MULTIPLIER = 1.2;
const RECT_TAXONOMY_BITMAP_MIN_PADDING_PX = 180;
const CIRCULAR_TAXONOMY_LABEL_LOCK_MIN_VISIBLE_FRACTION = 0.15;
const MINIMIZED_TRIANGLE_MIN_VIEWPORT_FRACTION = 0.01;
const MINIMIZED_TRIANGLE_MIN_CIRCUMFERENCE_FRACTION = 0.01;
const MINIMIZED_TRIANGLE_MIN_PX = 4;
const CIRCULAR_TAXONOMY_VISIBLE_FILTER_MAX_VISIBLE_FRACTION = 0.88;
const CIRCULAR_RIBBON_CANVAS_STABILITY_RADIUS_PX = 6000;
const CIRCULAR_RIBBON_CANVAS_STABILITY_ARC_PX = 140;
const CIRCULAR_TAXONOMY_SCREEN_SPACE_RIBBON_MIN_RADIUS_PX = 1200;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const TRACKPAD_PIXEL_ZOOM_MULTIPLIER = 5;
const TRACKPAD_PIXEL_DELTA_THRESHOLD = 32;
const MAC_GESTURE_ZOOM_EXPONENT = 1.7;
const HUGE_TREE_TIP_LIMIT = 500_000;
const HUGE_TREE_CACHED_CIRCULAR_PATH_MAX_ZOOM_MULTIPLIER = 1.6;
const HUGE_TREE_MAX_CIRCULAR_ZOOM_MULTIPLIER = 32_768;
const HUGE_TREE_MAX_TIP_SPACING_PX = 64;
const HUGE_TREE_ZOOMED_SAMPLE_LEAF_LIMIT = 1_500;
const HUGE_TREE_ZOOMED_SEGMENT_BUDGET = 12_000;
const LARGE_METADATA_BRANCH_NODE_LIMIT = 250_000;
const LARGE_METADATA_COLORED_SEGMENT_BUDGET = 120_000;
const LARGE_METADATA_COLORED_SAMPLE_LEAF_LIMIT = 2_400;
const MAX_TIME_STRIPE_BANDS_PER_DRAW = 4_096;
const MIN_ZOOMED_RECT_TREE_SPAN_PX = 96;
const MIN_ZOOMED_CIRCULAR_TREE_RADIUS_PX = 56;
const MAX_TAXONOMY_ARC_HITBOXES = 4_096;
const MAX_GLOBAL_COLORED_BRANCH_CACHE_COLORS = 512;
// Large accelerated Canvas2D Path2Ds can silently fail to stroke in Chromium.
const MAX_SPIRAL_BRANCH_PATH_COMMANDS = 200_000;
const ROTATION_PREVIEW_SETTLE_DELAY_MS = 120;
const DISTANCE_PATH_COLOR = "#dc2626";

type DistanceMeasurement = {
  startNode: number;
  targetNode: number;
  mrcaNode: number;
  distance: number;
  screenX: number;
  screenY: number;
};

type PhyloPicHitbox = {
  silhouette: PhyloPicSilhouette;
  x: number;
  y: number;
  width: number;
  height: number;
  taxonLabel: string;
  rank: TaxonomyRank;
  taxId: number | null;
  firstNode?: number;
  lastNode?: number;
  taxonomyTipCount?: number;
};

type CircularTaxonomyArcMetadata = {
  rank: TaxonomyRank;
  label: string;
  taxId: number | null;
  firstNode: number;
  lastNode: number;
  taxonomyTipCount: number;
  startIndex: number;
  endIndex: number;
};

type CollapsedTaxonomyGroup = {
  label: string;
  rank: TaxonomyRank;
  taxId: number | null;
  firstNode: number;
  lastNode: number;
  descendantTipCount: number;
};

type CollapsedTriangleHitbox = {
  node: number;
  points: Array<{ x: number; y: number }>;
};

type TaxonomyArcHitbox = CircularTaxonomyArcMetadata & {
  startTheta: number;
  endTheta: number;
  innerRadiusPx: number;
  outerRadiusPx: number;
  screenPolygonPoints?: Array<{ x: number; y: number }>;
  screenPolygonBounds?: { left: number; right: number; top: number; bottom: number };
};

type RotationPreviewCache = {
  canvas: HTMLCanvasElement;
  rotation: number;
  translateX: number;
  translateY: number;
  scale: number;
  dpr: number;
  backingWidth: number;
  backingHeight: number;
  viewMode: ViewMode;
  tree: TreeModel;
  order: LayoutOrder;
};

function phylopicImageElementKey(silhouette: Pick<PhyloPicSilhouette, "key" | "imageUuid">): string {
  return `${silhouette.key}:${silhouette.imageUuid}`;
}

function compactCircularOverlayScale(width: number, height: number): number {
  const minDimension = Math.min(width, height);
  if (minDimension >= 620) {
    return 1;
  }
  if (minDimension <= 360) {
    return 0.58;
  }
  return 0.58 + (((minDimension - 360) / 260) * 0.42);
}

function circularFitMinTreeRadiusPx(width: number, height: number): number {
  return compactCircularOverlayScale(width, height) < 1 ? 42 : 120;
}

function minRectZoomScales(tree: TreeModel): { scaleX: number; scaleY: number } {
  const depthExtent = Math.max(tree.maxDepth, tree.branchLengthMinPositive, 1e-9);
  const tipExtent = Math.max(1, tree.leafCount - 1);
  return {
    scaleX: MIN_ZOOMED_RECT_TREE_SPAN_PX / depthExtent,
    scaleY: MIN_ZOOMED_RECT_TREE_SPAN_PX / tipExtent,
  };
}

function minCircularZoomScale(tree: TreeModel, treeRadiusWorld = tree.maxDepth): number {
  const radius = Math.max(treeRadiusWorld, tree.branchLengthMinPositive, 1e-9);
  return MIN_ZOOMED_CIRCULAR_TREE_RADIUS_PX / radius;
}

function maxCircularZoomScale(width: number, height: number, tree: TreeModel, rotation: number): number {
  const fit = fitCircularCamera(width, height, tree, rotation);
  if (tree.leafCount <= HUGE_TREE_TIP_LIMIT) {
    return fit.scale * 1_000_000;
  }
  const maxRadius = Math.max(tree.maxDepth, tree.branchLengthMinPositive, 1e-9);
  const tipSpacingScale = (HUGE_TREE_MAX_TIP_SPACING_PX * tree.leafCount) / (Math.PI * 2 * maxRadius);
  return Math.max(fit.scale * 128, Math.min(fit.scale * HUGE_TREE_MAX_CIRCULAR_ZOOM_MULTIPLIER, tipSpacingScale));
}

function isHorizontalWheelPanEvent(event: WheelEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
    return false;
  }
  const absDeltaX = Math.abs(event.deltaX);
  const absDeltaY = Math.abs(event.deltaY);
  return absDeltaX > 0 && absDeltaX > Math.max(1, absDeltaY * 1.6);
}

function normalizedWheelZoomDelta(event: WheelEvent, viewportHeight: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 16;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * viewportHeight;
  }
  const absDeltaY = Math.abs(event.deltaY);
  const looksLikeTrackpad = absDeltaY > 0
    && absDeltaY < TRACKPAD_PIXEL_DELTA_THRESHOLD
    && Math.abs(event.deltaX) < Math.max(1, absDeltaY * 0.4);
  return event.deltaY * (looksLikeTrackpad ? TRACKPAD_PIXEL_ZOOM_MULTIPLIER : 1);
}

function arcIntersectsViewport(
  centerX: number,
  centerY: number,
  radiusPx: number,
  startTheta: number,
  endTheta: number,
  width: number,
  height: number,
): boolean {
  if (!(radiusPx > 0)) {
    return false;
  }
  const angularSpan = Math.abs(endTheta - startTheta);
  const arcLengthPx = radiusPx * angularSpan;
  const samples = Math.max(16, Math.min(256, Math.ceil(arcLengthPx / 6)));
  let previousX = centerX + (Math.cos(startTheta) * radiusPx);
  let previousY = centerY + (Math.sin(startTheta) * radiusPx);
  if (previousX >= 0 && previousX <= width && previousY >= 0 && previousY <= height) {
    return true;
  }
  for (let index = 1; index <= samples; index += 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / samples);
    const x = centerX + (Math.cos(theta) * radiusPx);
    const y = centerY + (Math.sin(theta) * radiusPx);
    if (x >= 0 && x <= width && y >= 0 && y <= height) {
      return true;
    }
    if (lineIntersectsRect(previousX, previousY, x, y, 0, 0, width, height)) {
      return true;
    }
    previousX = x;
    previousY = y;
  }
  return false;
}

function isNumericInternalLabel(value: string): boolean {
  return /^[+-]?\d+(?:\.\d+)?$/.test(value.trim());
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const editable = target.closest("input, textarea, select, [contenteditable='true']");
  return editable instanceof HTMLElement;
}

function applyCircularPointLabelOffset(
  x: number,
  y: number,
  theta: number,
  rotationAngle: number,
  tangentialOffsetPx: number,
  radialOffsetPx: number,
): { x: number; y: number } {
  const renderedTheta = theta + rotationAngle;
  const tangentX = -Math.sin(renderedTheta);
  const tangentY = Math.cos(renderedTheta);
  const radialX = Math.cos(renderedTheta);
  const radialY = Math.sin(renderedTheta);
  return {
    x: x + (tangentX * tangentialOffsetPx) + (radialX * radialOffsetPx),
    y: y + (tangentY * tangentialOffsetPx) + (radialY * radialOffsetPx),
  };
}

type SpiralMetrics = {
  startTheta: number;
  totalTheta: number;
  innerRadius: number;
  bandWidth: number;
  pitch: number;
  pitchPerRadian: number;
  timeExtent: number;
  logUnit: number;
  spacingOffset: number;
  totalArcLength: number;
  taxonomyRibbonWidth: number;
  taxonomyRibbonGap: number;
  taxonomyLabelGap: number;
  outerRadius: number;
};

function buildSpiralMetrics(
  tree: TreeModel,
  turns: number,
  visibleRankCount: number,
  taxonomyBandThicknessScale: number,
  timeAxisLogBase: number,
): SpiralMetrics {
  const clampedTurns = Math.max(1, Math.min(10, turns));
  const bandWidth = 0.82;
  const clampedBandThicknessScale = Math.max(0.05, Math.min(5, taxonomyBandThicknessScale));
  const taxonomyRibbonWidth = 0.095 * clampedBandThicknessScale;
  const taxonomyRibbonGap = 0.02 * clampedBandThicknessScale;
  const taxonomyLabelGap = 0.05;
  const taxonomyWidth = visibleRankCount > 0
    ? (visibleRankCount * taxonomyRibbonWidth) + (Math.max(0, visibleRankCount - 1) * taxonomyRibbonGap) + taxonomyLabelGap
    : 0;
  const pitch = bandWidth + taxonomyWidth + 0.24;
  const pitchPerRadian = pitch / (Math.PI * 2);
  const innerRadius = 0.54;
  const totalTheta = clampedTurns * Math.PI * 2;
  const timeExtent = Math.max(tree.isUltrametric ? tree.rootAge : tree.maxDepth, tree.branchLengthMinPositive, 1e-9);
  const logUnit = timeAxisLogUnit(timeExtent, timeAxisLogBase);
  const spacingOffset = bandWidth * 0.5;
  const totalArcLength = spiralArcLengthBetween(0, totalTheta, innerRadius + spacingOffset, pitchPerRadian);
  const outerRadius = innerRadius + (pitch * clampedTurns) + bandWidth + taxonomyWidth + 0.28;
  return {
    startTheta: -Math.PI * 0.5,
    totalTheta,
    innerRadius,
    bandWidth,
    pitch,
    pitchPerRadian,
    timeExtent,
    logUnit,
    spacingOffset,
    totalArcLength,
    taxonomyRibbonWidth,
    taxonomyRibbonGap,
    taxonomyLabelGap,
    outerRadius,
  };
}

function expandSpiralMetricsForRibbonGap(
  metrics: SpiralMetrics,
  taxonomyGapControl: number,
  cameraScale: number,
): SpiralMetrics {
  const extraGapWorld = Math.max(0, taxonomyGapControl - 1) / Math.max(cameraScale, 1e-6);
  if (extraGapWorld <= 0) {
    return metrics;
  }
  const pitch = metrics.pitch + extraGapWorld;
  const pitchPerRadian = pitch / (Math.PI * 2);
  const turnCount = metrics.totalTheta / (Math.PI * 2);
  return {
    ...metrics,
    pitch,
    pitchPerRadian,
    totalArcLength: spiralArcLengthBetween(
      0,
      metrics.totalTheta,
      metrics.innerRadius + metrics.spacingOffset,
      pitchPerRadian,
    ),
    outerRadius: metrics.outerRadius + (extraGapWorld * (turnCount + 1)),
  };
}

function spiralArcLengthIntegral(value: number, pitchSquared: number): number {
  const root = Math.sqrt(Math.max(0, (value * value) + pitchSquared));
  return (value * root) + (pitchSquared * Math.log(Math.max(1e-12, value + root)));
}

function spiralArcLengthPrimitive(thetaDelta: number, startRadius: number, pitchPerRadian: number): number {
  const radius = startRadius + (pitchPerRadian * thetaDelta);
  const pitchSquared = pitchPerRadian * pitchPerRadian;
  return (
    spiralArcLengthIntegral(radius, pitchSquared)
    - spiralArcLengthIntegral(startRadius, pitchSquared)
  ) / (2 * Math.max(pitchPerRadian, 1e-12));
}

function spiralArcLengthBetween(startThetaDelta: number, endThetaDelta: number, startRadius: number, pitchPerRadian: number): number {
  return spiralArcLengthPrimitive(endThetaDelta, startRadius, pitchPerRadian)
    - spiralArcLengthPrimitive(startThetaDelta, startRadius, pitchPerRadian);
}

function spiralThetaDeltaForArcLength(targetArcLength: number, metrics: SpiralMetrics): number {
  const clampedTarget = Math.max(0, Math.min(metrics.totalArcLength, targetArcLength));
  if (clampedTarget <= 0) {
    return 0;
  }
  if (clampedTarget >= metrics.totalArcLength) {
    return metrics.totalTheta;
  }
  let low = 0;
  let high = metrics.totalTheta;
  let thetaDelta = (clampedTarget / metrics.totalArcLength) * metrics.totalTheta;
  const startRadius = metrics.innerRadius + metrics.spacingOffset;
  // Newton convergence is rapid here; the bracket preserves monotonic safety at extreme pitches.
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const arcLength = spiralArcLengthPrimitive(thetaDelta, startRadius, metrics.pitchPerRadian);
    if (arcLength < clampedTarget) {
      low = thetaDelta;
    } else {
      high = thetaDelta;
    }
    const radius = startRadius + (metrics.pitchPerRadian * thetaDelta);
    const derivative = Math.sqrt(
      (radius * radius) + (metrics.pitchPerRadian * metrics.pitchPerRadian),
    );
    const candidate = thetaDelta - ((arcLength - clampedTarget) / Math.max(derivative, 1e-12));
    thetaDelta = candidate >= low && candidate <= high
      ? candidate
      : (low + high) * 0.5;
  }
  return thetaDelta;
}

function spiralThetaForY(layoutValue: number, leafCount: number, metrics: SpiralMetrics): number {
  const denominator = Math.max(1, leafCount - 1);
  const targetArcLength = (layoutValue / denominator) * metrics.totalArcLength;
  return metrics.startTheta + spiralThetaDeltaForArcLength(targetArcLength, metrics);
}

function spiralThetaForLeafBoundary(index: number, leafCount: number, metrics: SpiralMetrics): number {
  const fraction = Math.max(0, Math.min(1, (index - 0.5) / Math.max(1, leafCount)));
  return metrics.startTheta + spiralThetaDeltaForArcLength(fraction * metrics.totalArcLength, metrics);
}

function spiralArcFractionForTheta(theta: number, metrics: SpiralMetrics): number {
  const thetaDelta = Math.max(0, Math.min(metrics.totalTheta, theta - metrics.startTheta));
  return spiralArcLengthPrimitive(thetaDelta, metrics.innerRadius + metrics.spacingOffset, metrics.pitchPerRadian)
    / Math.max(metrics.totalArcLength, 1e-12);
}

function closestSpiralThetaForPoint(x: number, y: number, metrics: SpiralMetrics): number {
  let bestTheta = metrics.startTheta;
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  const samples = 720;
  for (let index = 0; index <= samples; index += 1) {
    const theta = metrics.startTheta + ((index / samples) * metrics.totalTheta);
    const point = spiralNormalOffsetPoint(theta, metrics.spacingOffset, metrics);
    const dx = point.x - x;
    const dy = point.y - y;
    const distanceSq = (dx * dx) + (dy * dy);
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      bestTheta = theta;
    }
  }
  const step = metrics.totalTheta / samples;
  let low = Math.max(metrics.startTheta, bestTheta - step);
  let high = Math.min(metrics.startTheta + metrics.totalTheta, bestTheta + step);
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const left = low + ((high - low) / 3);
    const right = high - ((high - low) / 3);
    const leftPoint = spiralNormalOffsetPoint(left, metrics.spacingOffset, metrics);
    const rightPoint = spiralNormalOffsetPoint(right, metrics.spacingOffset, metrics);
    const leftDistanceSq = ((leftPoint.x - x) ** 2) + ((leftPoint.y - y) ** 2);
    const rightDistanceSq = ((rightPoint.x - x) ** 2) + ((rightPoint.y - y) ** 2);
    if (leftDistanceSq < rightDistanceSq) {
      high = right;
    } else {
      low = left;
    }
  }
  return (low + high) * 0.5;
}

function unambiguousVisibleSpiralThetaForViewport(
  camera: CircularCamera,
  metrics: SpiralMetrics,
  viewportWidth: number,
  viewportHeight: number,
): number | null {
  const centerX = viewportWidth * 0.5;
  const centerY = viewportHeight * 0.5;
  const focusHalfWidth = Math.max(24, viewportWidth * 0.24);
  const focusHalfHeight = Math.max(24, viewportHeight * 0.24);
  const offsets = [
    metrics.spacingOffset,
    metrics.bandWidth * 0.08,
    metrics.bandWidth * 0.92,
    metrics.bandWidth + (metrics.taxonomyRibbonWidth * 0.5),
  ];
  const samples = Math.max(720, Math.min(2400, Math.ceil(metrics.totalTheta * 96)));
  let bestTheta: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let visibleSegmentCount = 0;
  let lastVisibleSample = -3;
  for (let index = 0; index <= samples; index += 1) {
    const theta = metrics.startTheta + ((index / samples) * metrics.totalTheta);
    let sampleVisible = false;
    for (let offsetIndex = 0; offsetIndex < offsets.length; offsetIndex += 1) {
      const point = spiralNormalOffsetPoint(theta, offsets[offsetIndex], metrics);
      const screen = worldToScreenCircular(camera, point.x, point.y);
      if (
        screen.x < centerX - focusHalfWidth
        || screen.x > centerX + focusHalfWidth
        || screen.y < centerY - focusHalfHeight
        || screen.y > centerY + focusHalfHeight
      ) {
        continue;
      }
      sampleVisible = true;
      const normalizedDx = (screen.x - centerX) / Math.max(viewportWidth, 1);
      const normalizedDy = (screen.y - centerY) / Math.max(viewportHeight, 1);
      const score = (normalizedDx * normalizedDx) + (normalizedDy * normalizedDy);
      if (score < bestScore) {
        bestScore = score;
        bestTheta = theta;
      }
    }
    if (sampleVisible) {
      if (index > lastVisibleSample + 2) {
        visibleSegmentCount += 1;
      }
      lastVisibleSample = index;
    }
  }
  if (visibleSegmentCount === 1) {
    return bestTheta;
  }

  // Once adjacent turns are widely separated on screen, the turn nearest the
  // viewport center is a meaningful local target even if the same turn crosses
  // the central sampling box more than once. At broader views, retain the
  // conservative fit-view fallback because several turns remain ambiguous.
  const minViewportDimension = Math.max(1, Math.min(viewportWidth, viewportHeight));
  const turnPitchPx = metrics.pitch * camera.scale;
  if (turnPitchPx < minViewportDimension * 0.32) {
    return null;
  }
  const centerWorld = screenToWorldCircular(camera, centerX, centerY);
  const nearestTheta = closestSpiralThetaForPoint(centerWorld.x, centerWorld.y, metrics);
  const nearestPoint = spiralNormalOffsetPoint(nearestTheta, metrics.spacingOffset, metrics);
  const nearestScreen = worldToScreenCircular(camera, nearestPoint.x, nearestPoint.y);
  const centerDistancePx = Math.hypot(nearestScreen.x - centerX, nearestScreen.y - centerY);
  return centerDistancePx <= minViewportDimension * 0.42 ? nearestTheta : null;
}

function spiralBaseRadius(theta: number, metrics: SpiralMetrics): number {
  return metrics.innerRadius + ((theta - metrics.startTheta) * metrics.pitchPerRadian);
}

function spiralFrameAt(theta: number, offset: number, metrics: SpiralMetrics): {
  x: number;
  y: number;
  radius: number;
  tangentX: number;
  tangentY: number;
  normalX: number;
  normalY: number;
} {
  const baseRadius = spiralBaseRadius(theta, metrics);
  const centerX = baseRadius * Math.cos(theta);
  const centerY = baseRadius * Math.sin(theta);
  const dx = (metrics.pitchPerRadian * Math.cos(theta)) - (baseRadius * Math.sin(theta));
  const dy = (metrics.pitchPerRadian * Math.sin(theta)) + (baseRadius * Math.cos(theta));
  const tangentLength = Math.max(1e-12, Math.hypot(dx, dy));
  const tangentX = dx / tangentLength;
  const tangentY = dy / tangentLength;
  let normalX = tangentY;
  let normalY = -tangentX;
  if ((normalX * Math.cos(theta)) + (normalY * Math.sin(theta)) < 0) {
    normalX *= -1;
    normalY *= -1;
  }
  const x = centerX + (normalX * offset);
  const y = centerY + (normalY * offset);
  return {
    x,
    y,
    radius: Math.hypot(x, y),
    tangentX,
    tangentY,
    normalX,
    normalY,
  };
}

function spiralNormalOffsetPoint(theta: number, offset: number, metrics: SpiralMetrics): { x: number; y: number; radius: number } {
  const frame = spiralFrameAt(theta, offset, metrics);
  return { x: frame.x, y: frame.y, radius: frame.radius };
}

function spiralTangentAngle(theta: number, offset: number, metrics: SpiralMetrics): number {
  const frame = spiralFrameAt(theta, offset, metrics);
  return Math.atan2(frame.tangentY, frame.tangentX);
}

function spiralAgeForDepth(tree: TreeModel, depth: number, metrics: SpiralMetrics): number {
  return Math.max(0, Math.min(metrics.timeExtent, (tree.isUltrametric ? tree.rootAge : tree.maxDepth) - depth));
}

function spiralOffsetForAge(age: number, metrics: SpiralMetrics): number {
  const clampedAge = Math.max(0, Math.min(metrics.timeExtent, age));
  const denominator = Math.log1p(metrics.timeExtent / metrics.logUnit);
  if (!(denominator > 0)) {
    return metrics.bandWidth;
  }
  const ageRatio = Math.log1p(clampedAge / metrics.logUnit) / denominator;
  return metrics.bandWidth * (1 - Math.max(0, Math.min(1, ageRatio)));
}

function spiralPointAt(theta: number, age: number, metrics: SpiralMetrics): { x: number; y: number; radius: number } {
  return spiralNormalOffsetPoint(theta, spiralOffsetForAge(age, metrics), metrics);
}

function spiralAgeForPointAtTheta(x: number, y: number, theta: number, metrics: SpiralMetrics): number {
  const frame = spiralFrameAt(theta, 0, metrics);
  const offset = ((x - frame.x) * frame.normalX) + ((y - frame.y) * frame.normalY);
  const ageRatio = 1 - clamp01(offset / Math.max(metrics.bandWidth, 1e-9));
  const denominator = Math.log1p(metrics.timeExtent / metrics.logUnit);
  if (!(denominator > 0)) {
    return 0;
  }
  return Math.max(0, Math.min(
    metrics.timeExtent,
    metrics.logUnit * Math.expm1(ageRatio * denominator),
  ));
}

function buildSpiralTimeBoundaries(timeExtent: number): number[] {
  if (!(timeExtent > 0)) {
    return [0];
  }
  const values = [0];
  const minPower = Math.min(0, Math.floor(Math.log10(timeExtent)) - 3);
  let value = 10 ** minPower;
  while (value < 1 && value < timeExtent) {
    value *= 10;
  }
  value = Math.max(value, 1);
  while (value < timeExtent) {
    values.push(value);
    value *= 10;
  }
  values.push(timeExtent);
  return [...new Map(values.map((entry) => [entry.toPrecision(12), entry])).values()]
    .filter((entry) => entry >= 0 && entry <= timeExtent)
    .sort((left, right) => left - right);
}

function compressedSpiralTaxonomyMetrics(
  metrics: SpiralMetrics,
  cameraScale: number,
  spiralTipSpacingPx: number,
  visibleRankCount: number,
  bandThicknessScale: number,
): SpiralMetrics {
  const spacingProgress = smoothstep01(
    (spiralTipSpacingPx - SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX)
    / Math.max(1e-6, SPIRAL_TAXONOMY_COMPRESSION_COMPLETE_SPACING_PX - SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX),
  );
  const safeScale = Math.max(cameraScale, 1e-6);
  const naturalRibbonWidthPx = metrics.taxonomyRibbonWidth * safeScale;
  const naturalGapPx = metrics.taxonomyRibbonGap * safeScale;
  const naturalLabelGapPx = metrics.taxonomyLabelGap * safeScale;
  const circularLikeBaseSize = Math.max(8.5, Math.min(18, 8.5 + (spiralTipSpacingPx * 0.45)));
  const circularLikeMetrics = taxonomyRingMetricsPx(visibleRankCount, circularLikeBaseSize, bandThicknessScale);
  const circularLikeRibbonWidthPx = circularLikeMetrics.ringWidthsPx[0] ?? 0;
  const targetRibbonWidthPx = Math.min(naturalRibbonWidthPx, circularLikeRibbonWidthPx);
  const screenSizeProgress = targetRibbonWidthPx > 0
    ? smoothstep01(
      (naturalRibbonWidthPx - targetRibbonWidthPx)
      / Math.max(1e-6, targetRibbonWidthPx),
    )
    : 0;
  const progress = Math.max(spacingProgress, screenSizeProgress);
  if (progress <= 0) {
    return metrics;
  }
  const targetGapPx = Math.min(naturalGapPx, circularLikeMetrics.ringGapPx);
  const targetLabelGapPx = Math.min(naturalLabelGapPx, Math.max(5, Math.min(9, spiralTipSpacingPx * 0.5)));
  return {
    ...metrics,
    taxonomyRibbonWidth: ((naturalRibbonWidthPx * (1 - progress)) + (targetRibbonWidthPx * progress)) / safeScale,
    taxonomyRibbonGap: ((naturalGapPx * (1 - progress)) + (targetGapPx * progress)) / safeScale,
    taxonomyLabelGap: ((naturalLabelGapPx * (1 - progress)) + (targetLabelGapPx * progress)) / safeScale,
  };
}

function compressedSpiralGenusStyle(
  metrics: SpiralMetrics,
  cameraScale: number,
  spiralTipSpacingPx: number,
  tipLabelsVisible: boolean,
  tipLabelGapPx: number,
  tipLabelBandWidthPx: number,
): { progress: number; offset: number; lineWidthPx: number } {
  const progress = smoothstep01(
    (spiralTipSpacingPx - SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX)
    / Math.max(1e-6, SPIRAL_TAXONOMY_COMPRESSION_COMPLETE_SPACING_PX - SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX),
  );
  const safeScale = Math.max(cameraScale, 1e-6);
  const naturalOffsetPx = 0.08 * safeScale;
  const targetOffsetPx = tipLabelsVisible
    ? tipLabelGapPx + tipLabelBandWidthPx + 12
    : Math.min(naturalOffsetPx, 12);
  const naturalLineWidthPx = Math.max(1.2, 0.008 * safeScale);
  return {
    progress,
    offset: metrics.bandWidth + (
      ((naturalOffsetPx * (1 - progress)) + (targetOffsetPx * progress)) / safeScale
    ),
    lineWidthPx: (naturalLineWidthPx * (1 - progress)) + (1.2 * progress),
  };
}

function spiralCurveSampleCount(
  startTheta: number,
  endTheta: number,
  scale: number,
  minSamplesPerRadian: number,
  maxSamplesPerRadian: number,
): number {
  const span = Math.abs(endTheta - startTheta);
  return Math.max(2, Math.min(2400, Math.ceil(span * Math.max(minSamplesPerRadian, Math.min(maxSamplesPerRadian, scale * 18)))));
}

function appendSpiralCurve(
  path: Path2D,
  startTheta: number,
  endTheta: number,
  age: number,
  metrics: SpiralMetrics,
  scale = 1,
  minSamplesPerRadian = 90,
  maxSamplesPerRadian = 420,
): void {
  const samples = spiralCurveSampleCount(startTheta, endTheta, scale, minSamplesPerRadian, maxSamplesPerRadian);
  const start = spiralPointAt(startTheta, age, metrics);
  path.moveTo(start.x, start.y);
  for (let index = 1; index <= samples; index += 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / samples);
    const point = spiralPointAt(theta, age, metrics);
    path.lineTo(point.x, point.y);
  }
}

function appendSpiralOffsetCurve(
  path: Path2D,
  startTheta: number,
  endTheta: number,
  offset: number,
  metrics: SpiralMetrics,
  scale = 1,
): void {
  const span = Math.abs(endTheta - startTheta);
  const samples = Math.max(2, Math.min(2400, Math.ceil(span * Math.max(90, Math.min(420, scale * 18)))));
  const start = spiralNormalOffsetPoint(startTheta, offset, metrics);
  path.moveTo(start.x, start.y);
  for (let index = 1; index <= samples; index += 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / samples);
    const point = spiralNormalOffsetPoint(theta, offset, metrics);
    path.lineTo(point.x, point.y);
  }
}

function appendSpiralRibbonPath(
  path: Path2D,
  startTheta: number,
  endTheta: number,
  innerOffset: number,
  outerOffset: number,
  metrics: SpiralMetrics,
  scale = 1,
): void {
  const span = Math.abs(endTheta - startTheta);
  const samples = Math.max(2, Math.min(2600, Math.ceil(span * Math.max(100, Math.min(520, scale * 22)))));
  const outerStart = spiralNormalOffsetPoint(startTheta, outerOffset, metrics);
  path.moveTo(outerStart.x, outerStart.y);
  for (let index = 1; index <= samples; index += 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / samples);
    const point = spiralNormalOffsetPoint(theta, outerOffset, metrics);
    path.lineTo(point.x, point.y);
  }
  for (let index = samples; index >= 0; index -= 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / samples);
    const point = spiralNormalOffsetPoint(theta, innerOffset, metrics);
    path.lineTo(point.x, point.y);
  }
  path.closePath();
}

function drawSpiralRibbonScreenPath(
  ctx: CanvasRenderingContext2D,
  camera: CircularCamera,
  startTheta: number,
  endTheta: number,
  innerOffset: number,
  outerOffset: number,
  metrics: SpiralMetrics,
): void {
  const path = new Path2D();
  appendSpiralRibbonPath(path, startTheta, endTheta, innerOffset, outerOffset, metrics, camera.scale);
  ctx.save();
  ctx.translate(camera.translateX, camera.translateY);
  ctx.scale(camera.scale, camera.scale);
  ctx.rotate(camera.rotation);
  ctx.fill(path);
  ctx.restore();
}

function curvedTextNeeded(textWidthPx: number, fontSizePx: number, curveRadiusPx: number): boolean {
  if (!(curveRadiusPx > 0) || !(textWidthPx > 0)) {
    return false;
  }
  const halfWidthPx = textWidthPx * 0.5;
  const sagittaPx = halfWidthPx >= curveRadiusPx
    ? curveRadiusPx
    : curveRadiusPx - Math.sqrt(Math.max(0, (curveRadiusPx * curveRadiusPx) - (halfWidthPx * halfWidthPx)));
  return sagittaPx > Math.max(1.4, fontSizePx * 0.16) || curveRadiusPx < fontSizePx * 9;
}

function drawCircularCurvedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  centerY: number,
  radiusPx: number,
  centerTheta: number,
  color: string,
  searchHighlightColor: string | null,
  searchMatchRange: { start: number; end: number } | null,
): void {
  if (!(radiusPx > 1)) {
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    return;
  }
  const glyphs = Array.from(text);
  const widths = glyphs.map((glyph) => ctx.measureText(glyph).width);
  const totalWidth = widths.reduce((total, width) => total + width, 0);
  const rawCenterTangent = centerTheta + (Math.PI * 0.5);
  const readableCenterTangent = normalizeRotation(rawCenterTangent * 180 / Math.PI) * Math.PI / 180;
  const wordFlipped = Math.cos(readableCenterTangent - rawCenterTangent) < 0;
  const direction = wordFlipped ? -1 : 1;
  let cursor = -totalWidth * 0.5;
  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = glyphs[index];
    const glyphWidth = widths[index];
    const offsetPx = cursor + (glyphWidth * 0.5);
    const theta = centerTheta + ((direction * offsetPx) / radiusPx);
    const rotation = theta + (Math.PI * 0.5) + (wordFlipped ? Math.PI : 0);
    ctx.save();
    ctx.translate(centerX + (Math.cos(theta) * radiusPx), centerY + (Math.sin(theta) * radiusPx));
    ctx.rotate(rotation);
    ctx.fillStyle = searchHighlightColor && searchMatchRange && index >= searchMatchRange.start && index < searchMatchRange.end
      ? searchHighlightColor
      : color;
    ctx.fillText(glyph, 0, 0);
    ctx.restore();
    cursor += glyphWidth;
  }
}

function spiralThetaForArcOffset(
  centerTheta: number,
  offsetWorld: number,
  centerOffset: number,
  metrics: SpiralMetrics,
): number {
  if (Math.abs(offsetWorld) < 1e-9) {
    return centerTheta;
  }
  const centerDelta = Math.max(0, Math.min(metrics.totalTheta, centerTheta - metrics.startTheta));
  const startRadius = metrics.innerRadius + centerOffset;
  if (offsetWorld > 0) {
    let low = centerDelta;
    let high = metrics.totalTheta;
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const mid = (low + high) * 0.5;
      const distance = spiralArcLengthBetween(centerDelta, mid, startRadius, metrics.pitchPerRadian);
      if (distance < offsetWorld) {
        low = mid;
      } else {
        high = mid;
      }
    }
    return metrics.startTheta + ((low + high) * 0.5);
  }
  let low = 0;
  let high = centerDelta;
  const target = -offsetWorld;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const mid = (low + high) * 0.5;
    const distance = spiralArcLengthBetween(mid, centerDelta, startRadius, metrics.pitchPerRadian);
    if (distance > target) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return metrics.startTheta + ((low + high) * 0.5);
}

function drawSpiralCurvedText(
  ctx: CanvasRenderingContext2D,
  camera: CircularCamera,
  metrics: SpiralMetrics,
  text: string,
  centerTheta: number,
  centerOffset: number,
  color: string,
): void {
  const glyphs = Array.from(text);
  const widths = glyphs.map((glyph) => ctx.measureText(glyph).width);
  const totalWidth = widths.reduce((total, width) => total + width, 0);
  const rawCenterTangent = spiralTangentAngle(centerTheta, centerOffset, metrics) + camera.rotation;
  const readableCenterTangent = normalizeRotation(rawCenterTangent * 180 / Math.PI) * Math.PI / 180;
  const wordFlipped = Math.cos(readableCenterTangent - rawCenterTangent) < 0;
  const direction = wordFlipped ? -1 : 1;
  let cursor = -totalWidth * 0.5;
  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = glyphs[index];
    const glyphWidth = widths[index];
    const offsetPx = cursor + (glyphWidth * 0.5);
    const theta = spiralThetaForArcOffset(
      centerTheta,
      (direction * offsetPx) / Math.max(camera.scale, 1e-6),
      centerOffset,
      metrics,
    );
    const world = spiralNormalOffsetPoint(theta, centerOffset, metrics);
    const screen = worldToScreenCircular(camera, world.x, world.y);
    const rotation = spiralTangentAngle(theta, centerOffset, metrics) + camera.rotation + (wordFlipped ? Math.PI : 0);
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(rotation);
    ctx.fillStyle = color;
    ctx.fillText(glyph, 0, 0);
    ctx.restore();
    cursor += glyphWidth;
  }
}

function spiralLabelIntervalsByTurn(
  spanStartTheta: number,
  spanEndTheta: number,
  metrics: SpiralMetrics,
): Array<{ startTheta: number; endTheta: number }> {
  const spanTheta = spanEndTheta - spanStartTheta;
  if (spanTheta <= Math.PI * 2.05) {
    return [{ startTheta: spanStartTheta, endTheta: spanEndTheta }];
  }
  const intervals: Array<{ startTheta: number; endTheta: number }> = [];
  const firstTurnIndex = Math.floor((spanStartTheta - metrics.startTheta) / (Math.PI * 2));
  const lastTurnIndex = Math.floor((spanEndTheta - metrics.startTheta) / (Math.PI * 2));
  for (let turnIndex = firstTurnIndex; turnIndex <= lastTurnIndex; turnIndex += 1) {
    const turnStart = metrics.startTheta + (turnIndex * Math.PI * 2);
    const turnEnd = turnStart + (Math.PI * 2);
    const startTheta = Math.max(spanStartTheta, turnStart);
    const endTheta = Math.min(spanEndTheta, turnEnd);
    if (endTheta - startTheta > Math.PI * 0.35) {
      intervals.push({ startTheta, endTheta });
    }
  }
  return intervals.length > 0 ? intervals : [{ startTheta: spanStartTheta, endTheta: spanEndTheta }];
}

function spiralMetricCacheKey(metrics: SpiralMetrics): string {
  return [
    metrics.totalTheta.toFixed(6),
    metrics.innerRadius.toFixed(4),
    metrics.bandWidth.toFixed(4),
    metrics.pitch.toFixed(4),
    metrics.timeExtent.toPrecision(8),
    metrics.logUnit.toPrecision(8),
    metrics.taxonomyRibbonWidth.toFixed(4),
    metrics.taxonomyRibbonGap.toFixed(4),
    metrics.taxonomyLabelGap.toFixed(4),
  ].join(",");
}

const spiralBoundaryThetaCaches = new Map<string, Map<number, number>>();
const MAX_SPIRAL_BOUNDARY_THETA_CACHE_ENTRIES = 100_000;

function spiralBoundaryThetaCache(leafCount: number, metrics: SpiralMetrics): Map<number, number> {
  const key = `${leafCount}:${spiralMetricCacheKey(metrics)}`;
  const cached = spiralBoundaryThetaCaches.get(key);
  if (cached) {
    return cached;
  }
  const created = new Map<number, number>();
  spiralBoundaryThetaCaches.set(key, created);
  while (spiralBoundaryThetaCaches.size > 8) {
    const oldestKey = spiralBoundaryThetaCaches.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    spiralBoundaryThetaCaches.delete(oldestKey);
  }
  return created;
}

function buildSpiralBranchPathCache(
  tree: TreeModel,
  layout: TreeModel["layouts"][LayoutOrder],
  orderedChildren: number[][],
  hiddenNodes: Uint8Array,
  collapsedNodes: Set<number>,
  branchColors: string[] | null,
  metrics: SpiralMetrics,
  curveMinSamplesPerRadian: number,
  curveMaxSamplesPerRadian: number,
): SpiralBranchPathCache {
  const paths: SpiralBranchPathCache = new Map();
  const thetaByNode = new Float64Array(tree.nodeCount);
  for (let node = 0; node < tree.nodeCount; node += 1) {
    thetaByNode[node] = spiralThetaForY(layout.center[node], tree.leafCount, metrics);
  }
  const getPath = (color: string, commandCount: number): Path2D => {
    let batches = paths.get(color);
    if (!batches) {
      batches = [];
      paths.set(color, batches);
    }
    let batch = batches[batches.length - 1];
    if (!batch || (
      batch.commandCount > 0
      && batch.commandCount + commandCount > MAX_SPIRAL_BRANCH_PATH_COMMANDS
    )) {
      batch = {
        path: new Path2D(),
        commandCount: 0,
      };
      batches.push(batch);
    }
    batch.commandCount += commandCount;
    return batch.path;
  };
  for (let node = 0; node < tree.nodeCount; node += 1) {
    if (hiddenNodes[node]) {
      continue;
    }
    const parent = tree.buffers.parent[node];
    if (parent >= 0) {
      const color = branchColors?.[node] ?? BRANCH_COLOR;
      const path = getPath(color, 2);
      const theta = thetaByNode[node];
      const start = spiralPointAt(theta, spiralAgeForDepth(tree, tree.buffers.depth[parent], metrics), metrics);
      const end = spiralPointAt(theta, spiralAgeForDepth(tree, tree.buffers.depth[node], metrics), metrics);
      path.moveTo(start.x, start.y);
      path.lineTo(end.x, end.y);
    }
    const ordered = orderedChildren[node];
    if (ordered.length < 2 || collapsedNodes.has(node)) {
      continue;
    }
    const ownerAge = spiralAgeForDepth(tree, tree.buffers.depth[node], metrics);
    const ownerTheta = thetaByNode[node];
    for (let childIndex = 0; childIndex < ordered.length; childIndex += 1) {
      const child = ordered[childIndex];
      if (hiddenNodes[child]) {
        continue;
      }
      const childTheta = thetaByNode[child];
      const startTheta = Math.min(ownerTheta, childTheta);
      const endTheta = Math.max(ownerTheta, childTheta);
      const curveCommandCount = 1 + spiralCurveSampleCount(
        startTheta,
        endTheta,
        1,
        curveMinSamplesPerRadian,
        curveMaxSamplesPerRadian,
      );
      appendSpiralCurve(
        getPath(branchColors?.[child] ?? BRANCH_COLOR, curveCommandCount),
        startTheta,
        endTheta,
        ownerAge,
        metrics,
        1,
        curveMinSamplesPerRadian,
        curveMaxSamplesPerRadian,
      );
    }
  }
  return paths;
}

function buildSpiralTaxonomyRibbonPathCache(
  tree: TreeModel,
  layout: TreeModel["layouts"][LayoutOrder],
  leafBoundaries: Float64Array | null,
  taxonomyBlocks: Record<TaxonomyRank, TaxonomyBlock[]>,
  visibleRanks: TaxonomyRank[],
  metrics: SpiralMetrics,
  taxonomyGapWorld: number,
  excludedFillRanks: TaxonomyRank[] = [],
): SpiralTaxonomyRibbonPathCache {
  const paths: SpiralTaxonomyRibbonPathCache = new Map();
  const thetaForBoundary = (index: number): number => {
    if (!leafBoundaries) {
      return spiralThetaForLeafBoundary(index, tree.leafCount, metrics);
    }
    const clampedIndex = Math.max(0, Math.min(leafBoundaries.length - 1, index));
    return spiralThetaForLeafBoundary(leafBoundaries[clampedIndex] + 0.5, tree.leafCount, metrics);
  };
  const getPath = (color: string): Path2D => {
    const existing = paths.get(color);
    if (existing) {
      return existing;
    }
    const created = new Path2D();
    paths.set(color, created);
    return created;
  };
  for (let rankIndex = 0; rankIndex < visibleRanks.length; rankIndex += 1) {
    const rank = visibleRanks[rankIndex];
    if (excludedFillRanks.includes(rank)) {
      continue;
    }
    const blocks = taxonomyBlocks[rank] ?? [];
    const innerOffset = metrics.bandWidth
      + metrics.taxonomyLabelGap
      + (rankIndex * (metrics.taxonomyRibbonWidth + metrics.taxonomyRibbonGap))
      + taxonomyGapWorld;
    const outerOffset = innerOffset + metrics.taxonomyRibbonWidth;
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      const segments = block.segments && block.segments.length > 0
        ? block.segments
        : [{ firstNode: block.firstNode, lastNode: block.lastNode }];
      const path = getPath(block.color);
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex];
        const startTheta = "startIndex" in segment
          ? thetaForBoundary(segment.startIndex)
          : spiralThetaForY(layout.center[segment.firstNode], tree.leafCount, metrics);
        const endTheta = "endIndex" in segment
          ? thetaForBoundary(segment.endIndex)
          : spiralThetaForY(layout.center[segment.lastNode], tree.leafCount, metrics);
        appendSpiralRibbonPath(path, Math.min(startTheta, endTheta), Math.max(startTheta, endTheta), innerOffset, outerOffset, metrics, 1);
      }
    }
  }
  return paths;
}

function collectSubtreeLeafNodes(tree: TreeModel, rootNode: number): number[] {
  const leaves: number[] = [];
  const stack = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    const firstChild = tree.buffers.firstChild[node];
    if (firstChild < 0) {
      leaves.push(node);
      continue;
    }
    let child = firstChild;
    while (child >= 0) {
      stack.push(child);
      child = tree.buffers.nextSibling[child];
    }
  }
  return leaves;
}

function buildSharedSubtreeStoragePayload(
  tree: TreeModel,
  rootNode: number,
  taxonomyMap: TaxonomyMapPayload | null,
  taxonomyEnabled: boolean,
  visual: SharedSubtreeVisualPayload,
  controls?: SharedSubtreeStoragePayload["controls"],
): SharedSubtreeStoragePayload {
  const payload: SharedSubtreeStoragePayload = {
    version: 2,
    newick: serializeSubtreeToNewick(tree, rootNode),
    visual,
  };
  if (controls?.hideDownloadNewick === true) {
    payload.controls = { hideDownloadNewick: true };
  }
  if (!taxonomyEnabled || !taxonomyMap) {
    return payload;
  }
  const subtreeLeafSet = new Set<number>(collectSubtreeLeafNodes(tree, rootNode));
  const tipEntries: SharedSubtreeTaxonomyEntry[] = [];
  for (let index = 0; index < taxonomyMap.tipRanks.length; index += 1) {
    const tip = taxonomyMap.tipRanks[index];
    if (!subtreeLeafSet.has(tip.node)) {
      continue;
    }
    tipEntries.push({
      name: tree.names[tip.node] ?? "",
      ranks: tip.ranks,
      taxIds: tip.taxIds,
      collapseFallbacks: tip.collapseFallbacks,
    });
  }
  if (tipEntries.length === 0) {
    return payload;
  }
  payload.taxonomy = {
    version: taxonomyMap.version,
    source: taxonomyMap.source,
    sourceVersion: taxonomyMap.sourceVersion,
    sourceDoi: taxonomyMap.sourceDoi,
    mappedCount: tipEntries.length,
    totalTips: subtreeLeafSet.size,
    activeRanks: [...taxonomyMap.activeRanks],
    tipEntries,
  };
  return payload;
}

const GENUS_CONNECTOR_COLORS = ["#111111", "#7a7a7a"] as const;
const CIRCULAR_TAXONOMY_OVERLAY_ALPHA = 1;
const TAXONOMY_DISPLAY_ORDER: TaxonomyRank[] = [
  "genus",
  "family",
  "order",
  "class",
  "phylum",
  "kingdom",
  "superkingdom",
];
const TAXONOMY_LAYER_THRESHOLDS: Record<TaxonomyRank, number> = {
  superkingdom: 0,
  kingdom: 0,
  phylum: 0,
  class: 0.03,
  order: 0.045,
  family: 0.1,
  genus: 0.35,
};
const TAXONOMY_SINGLE_LAYER_ZOOM = 0.012;
const SPIRAL_TIME_AXIS_LOG_BASE_MULTIPLIER = 100;
const SPIRAL_TAXONOMY_RANK_COUNT_ZOOM_THRESHOLDS = [1, 1.45, 2.25, 3.5, 5.25] as const;
const SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX = 2.9;
const SPIRAL_TAXONOMY_COMPRESSION_COMPLETE_SPACING_PX = 12;
const SPIRAL_BRANCH_DETAIL_START_SPACING_PX = 0.6;
const SPIRAL_DENSE_BRANCH_WIDTH_PX = 0.62;
const SPIRAL_DETAIL_BRANCH_WIDTH_PX = 1.05;
const SPIRAL_DENSE_BASE_BRANCH_OPACITY = 0.74;
const SPIRAL_DENSE_COLORED_BRANCH_OPACITY = 0.86;
const SPIRAL_DETAIL_BRANCH_OPACITY = 0.96;
const DETAIL_BRANCH_THICKNESS_MAX_MULTIPLIER = 1.45;
const DETAIL_BRANCH_THICKNESS_FULL_SPACING_PX = 24;

type PolarViewDomain = {
  start: number;
  span: number;
  leafDivisor: number;
};

function polarViewDomain(mode: ViewMode, leafCount: number): PolarViewDomain {
  return mode === "fan"
    ? { start: Math.PI, span: Math.PI, leafDivisor: Math.max(1, leafCount - 1) }
    : { start: 0, span: Math.PI * 2, leafDivisor: Math.max(1, leafCount) };
}

const MANUAL_BRANCH_SWATCHES = [
  { label: "Slate", color: "#334155" },
  { label: "Charcoal", color: "#1f2937" },
  { label: "Indigo", color: "#4338ca" },
  { label: "Blue", color: "#2563eb" },
  { label: "Sky", color: "#0284c7" },
  { label: "Teal", color: "#0f766e" },
  { label: "Cyan", color: "#0891b2" },
  { label: "Green", color: "#16a34a" },
  { label: "Lime", color: "#65a30d" },
  { label: "Olive", color: "#4d7c0f" },
  { label: "Amber", color: "#d97706" },
  { label: "Orange", color: "#ea580c" },
  { label: "Coral", color: "#f97316" },
  { label: "Red", color: "#dc2626" },
  { label: "Rose", color: "#e11d48" },
  { label: "Magenta", color: "#c026d3" },
  { label: "Violet", color: "#7c3aed" },
] as const;

type SvgScenePrimitive =
  | { kind: "rect"; x: number; y: number; width: number; height: number; fill: string; opacity?: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number; opacity?: number; dashArray?: string }
  | { kind: "path"; d: string; stroke?: string; strokeWidth?: number; fill?: string; opacity?: number; dashArray?: string }
  | { kind: "image"; href: string; x: number; y: number; width: number; height: number; opacity?: number }
  | {
    kind: "text";
    text: string;
    x: number;
    y: number;
    fill: string;
    fontSize: number;
    fontFamily: string;
    fontStyle?: string;
    anchor: "start" | "middle" | "end";
    rotation?: number;
  };

interface SvgScene {
  width: number;
  height: number;
  background: string;
  elements: SvgScenePrimitive[];
}

function metadataMarkerPath(shape: "circle" | "square" | "diamond" | "triangle", x: number, y: number, sizePx: number): string {
  const radius = Math.max(2, sizePx * 0.5);
  if (shape === "circle") {
    return [
      `M ${x + radius} ${y}`,
      `A ${radius} ${radius} 0 1 1 ${x - radius} ${y}`,
      `A ${radius} ${radius} 0 1 1 ${x + radius} ${y}`,
      "Z",
    ].join(" ");
  }
  if (shape === "square") {
    return `M ${x - radius} ${y - radius} L ${x + radius} ${y - radius} L ${x + radius} ${y + radius} L ${x - radius} ${y + radius} Z`;
  }
  if (shape === "diamond") {
    return `M ${x} ${y - radius} L ${x + radius} ${y} L ${x} ${y + radius} L ${x - radius} ${y} Z`;
  }
  return `M ${x} ${y - radius} L ${x + radius} ${y + radius} L ${x - radius} ${y + radius} Z`;
}

function metadataPieSlicePath(x: number, y: number, radius: number, startAngle: number, endAngle: number): string {
  const span = Math.max(0, endAngle - startAngle);
  if (span >= (Math.PI * 2) - 1e-5) {
    return [
      `M ${x + radius} ${y}`,
      `A ${radius} ${radius} 0 1 1 ${x - radius} ${y}`,
      `A ${radius} ${radius} 0 1 1 ${x + radius} ${y}`,
      "Z",
    ].join(" ");
  }
  const startX = x + Math.cos(startAngle) * radius;
  const startY = y + Math.sin(startAngle) * radius;
  const endX = x + Math.cos(endAngle) * radius;
  const endY = y + Math.sin(endAngle) * radius;
  const largeArc = span > Math.PI ? 1 : 0;
  return `M ${x} ${y} L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY} Z`;
}

function drawMetadataPie(
  ctx: CanvasRenderingContext2D,
  pie: { slices: Array<{ fraction: number; color: string }> },
  x: number,
  y: number,
  sizePx: number,
): void {
  const radius = Math.max(3, sizePx * 0.5);
  let angle = -Math.PI / 2;
  for (const slice of pie.slices) {
    const nextAngle = angle + (slice.fraction * Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, radius, angle, nextAngle);
    ctx.closePath();
    ctx.fillStyle = slice.color;
    ctx.fill();
    angle = nextAngle;
  }
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.94)";
  ctx.lineWidth = 1.15;
  ctx.stroke();
}

function pushMetadataPieScenePaths(
  pushScenePath: (d: string, stroke: string | undefined, strokeWidth: number | undefined, fill: string | undefined, opacity?: number) => void,
  pie: { slices: Array<{ fraction: number; color: string }> },
  x: number,
  y: number,
  sizePx: number,
): void {
  const radius = Math.max(3, sizePx * 0.5);
  let angle = -Math.PI / 2;
  for (const slice of pie.slices) {
    const nextAngle = angle + (slice.fraction * Math.PI * 2);
    pushScenePath(metadataPieSlicePath(x, y, radius, angle, nextAngle), undefined, undefined, slice.color, 1);
    angle = nextAngle;
  }
  pushScenePath(metadataMarkerPath("circle", x, y, sizePx), "rgba(255,255,255,0.94)", 1.15, "none", 1);
}

function scaledMetadataGlyphSizePx(sizePercent: number, adjacentTipSpacingPx: number): number {
  const percent = Number.isFinite(sizePercent) ? Math.max(0, Math.min(100, sizePercent)) : 50;
  const renderedSize = Number.isFinite(adjacentTipSpacingPx) && adjacentTipSpacingPx > 0
    ? adjacentTipSpacingPx * (percent / 100)
    : 0;
  return renderedSize < 5 ? 0 : renderedSize;
}

function scaledMetadataMarkerSizePx(sizePercent: number, adjacentTipSpacingPx: number): number {
  const percent = Number.isFinite(sizePercent) ? Math.max(10, Math.min(100, sizePercent)) : 50;
  const control = (percent - 10) / 90;
  const dotSizePx = 4 + (20 * control);
  if (!Number.isFinite(adjacentTipSpacingPx) || adjacentTipSpacingPx <= 0) {
    return dotSizePx;
  }
  if (adjacentTipSpacingPx <= dotSizePx) {
    return dotSizePx;
  }
  const spacingFraction = 0.1 + (0.9 * control * control * control);
  return Math.max(dotSizePx, adjacentTipSpacingPx * spacingFraction);
}

function drawMetadataMarker(
  ctx: CanvasRenderingContext2D,
  shape: "circle" | "square" | "diamond" | "triangle",
  x: number,
  y: number,
  sizePx: number,
): void {
  const radius = Math.max(2, sizePx * 0.5);
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    return;
  }
  if (shape === "square") {
    ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
    return;
  }
  if (shape === "diamond") {
    ctx.moveTo(x, y - radius);
    ctx.lineTo(x + radius, y);
    ctx.lineTo(x, y + radius);
    ctx.lineTo(x - radius, y);
    ctx.closePath();
    return;
  }
  ctx.moveTo(x, y - radius);
  ctx.lineTo(x + radius, y + radius);
  ctx.lineTo(x - radius, y + radius);
  ctx.closePath();
}

function metadataRectMarkerScreenPosition(
  tree: TreeModel,
  node: number,
  centerY: number,
  camera: RectCamera,
  _sizePx: number,
): { x: number; y: number } {
  const screen = worldToScreenRect(camera, tree.buffers.depth[node], centerY);
  return {
    x: Math.round(screen.x),
    y: Math.round(screen.y),
  };
}

function metadataCircularMarkerScreenPosition(
  tree: TreeModel,
  node: number,
  theta: number,
  camera: CircularCamera,
  _sizePx: number,
): { x: number; y: number } {
  const point = polarToCartesian(tree.buffers.depth[node], theta);
  const screen = worldToScreenCircular(camera, point.x, point.y);
  return {
    x: Math.round(screen.x),
    y: Math.round(screen.y),
  };
}

function metadataRectPieScreenPosition(
  tree: TreeModel,
  node: number,
  centerY: number,
  camera: RectCamera,
  sizePx: number,
): { x: number; y: number } {
  if (tree.buffers.firstChild[node] >= 0) {
    return metadataRectMarkerScreenPosition(tree, node, centerY, camera, sizePx);
  }
  const screen = worldToScreenRect(camera, tree.buffers.depth[node], centerY);
  return {
    x: Math.round(screen.x),
    y: Math.round(screen.y),
  };
}

function metadataCircularPieScreenPosition(
  tree: TreeModel,
  node: number,
  theta: number,
  camera: CircularCamera,
  sizePx: number,
): { x: number; y: number } {
  if (tree.buffers.firstChild[node] >= 0) {
    return metadataCircularMarkerScreenPosition(tree, node, theta, camera, sizePx);
  }
  const point = polarToCartesian(tree.buffers.depth[node], theta);
  const screen = worldToScreenCircular(camera, point.x, point.y);
  return {
    x: Math.round(screen.x),
    y: Math.round(screen.y),
  };
}

function evenlySampleSortedItems<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount) {
    return items;
  }
  if (maxCount <= 0) {
    return [];
  }
  const sampled: T[] = [];
  const step = items.length / maxCount;
  for (let sampleIndex = 0; sampleIndex < maxCount; sampleIndex += 1) {
    const itemIndex = Math.min(
      items.length - 1,
      Math.floor((sampleIndex + 0.5) * step),
    );
    sampled.push(items[itemIndex]);
  }
  return sampled;
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function svgArcPath(centerX: number, centerY: number, radiusPx: number, startTheta: number, endTheta: number): string {
  const startX = centerX + (Math.cos(startTheta) * radiusPx);
  const startY = centerY + (Math.sin(startTheta) * radiusPx);
  const endX = centerX + (Math.cos(endTheta) * radiusPx);
  const endY = centerY + (Math.sin(endTheta) * radiusPx);
  const delta = Math.abs(endTheta - startTheta);
  const largeArc = delta > Math.PI ? 1 : 0;
  return `M ${startX.toFixed(3)} ${startY.toFixed(3)} A ${radiusPx.toFixed(3)} ${radiusPx.toFixed(3)} 0 ${largeArc} 1 ${endX.toFixed(3)} ${endY.toFixed(3)}`;
}

function svgCircularRibbonPath(
  centerX: number,
  centerY: number,
  innerRadiusPx: number,
  outerRadiusPx: number,
  startTheta: number,
  endTheta: number,
): string {
  const outerStartX = centerX + (Math.cos(startTheta) * outerRadiusPx);
  const outerStartY = centerY + (Math.sin(startTheta) * outerRadiusPx);
  const outerEndX = centerX + (Math.cos(endTheta) * outerRadiusPx);
  const outerEndY = centerY + (Math.sin(endTheta) * outerRadiusPx);
  const innerStartX = centerX + (Math.cos(startTheta) * innerRadiusPx);
  const innerStartY = centerY + (Math.sin(startTheta) * innerRadiusPx);
  const innerEndX = centerX + (Math.cos(endTheta) * innerRadiusPx);
  const innerEndY = centerY + (Math.sin(endTheta) * innerRadiusPx);
  const delta = Math.abs(endTheta - startTheta);
  const largeArc = delta > Math.PI ? 1 : 0;
  return [
    `M ${outerStartX.toFixed(3)} ${outerStartY.toFixed(3)}`,
    `A ${outerRadiusPx.toFixed(3)} ${outerRadiusPx.toFixed(3)} 0 ${largeArc} 1 ${outerEndX.toFixed(3)} ${outerEndY.toFixed(3)}`,
    `L ${innerEndX.toFixed(3)} ${innerEndY.toFixed(3)}`,
    `A ${innerRadiusPx.toFixed(3)} ${innerRadiusPx.toFixed(3)} 0 ${largeArc} 0 ${innerStartX.toFixed(3)} ${innerStartY.toFixed(3)}`,
    "Z",
  ].join(" ");
}

function svgPolygonPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return "";
  }
  return [
    `M ${points[0].x.toFixed(3)} ${points[0].y.toFixed(3)}`,
    ...points.slice(1).map((point) => `L ${point.x.toFixed(3)} ${point.y.toFixed(3)}`),
    "Z",
  ].join(" ");
}

function svgSpiralCurveScreenPath(
  camera: CircularCamera,
  startTheta: number,
  endTheta: number,
  age: number,
  metrics: SpiralMetrics,
  sampleScale = 1,
): string {
  const span = Math.abs(endTheta - startTheta);
  const samples = Math.max(2, Math.min(1600, Math.ceil(span * Math.max(80, Math.min(320, sampleScale * 16)))));
  const start = spiralPointAt(startTheta, age, metrics);
  const startScreen = worldToScreenCircular(camera, start.x, start.y);
  const parts = [`M ${startScreen.x.toFixed(3)} ${startScreen.y.toFixed(3)}`];
  for (let index = 1; index <= samples; index += 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / samples);
    const point = spiralPointAt(theta, age, metrics);
    const screen = worldToScreenCircular(camera, point.x, point.y);
    parts.push(`L ${screen.x.toFixed(3)} ${screen.y.toFixed(3)}`);
  }
  return parts.join(" ");
}

function svgSpiralOffsetCurveScreenPath(
  camera: CircularCamera,
  startTheta: number,
  endTheta: number,
  offset: number,
  metrics: SpiralMetrics,
  sampleScale = 1,
): string {
  const span = Math.abs(endTheta - startTheta);
  const samples = Math.max(2, Math.min(1600, Math.ceil(span * Math.max(80, Math.min(320, sampleScale * 16)))));
  const start = spiralNormalOffsetPoint(startTheta, offset, metrics);
  const startScreen = worldToScreenCircular(camera, start.x, start.y);
  const parts = [`M ${startScreen.x.toFixed(3)} ${startScreen.y.toFixed(3)}`];
  for (let index = 1; index <= samples; index += 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / samples);
    const point = spiralNormalOffsetPoint(theta, offset, metrics);
    const screen = worldToScreenCircular(camera, point.x, point.y);
    parts.push(`L ${screen.x.toFixed(3)} ${screen.y.toFixed(3)}`);
  }
  return parts.join(" ");
}

function svgSpiralRibbonScreenPath(
  camera: CircularCamera,
  startTheta: number,
  endTheta: number,
  innerOffset: number,
  outerOffset: number,
  metrics: SpiralMetrics,
  sampleScale = 1,
): string {
  const span = Math.abs(endTheta - startTheta);
  const samples = Math.max(2, Math.min(1800, Math.ceil(span * Math.max(90, Math.min(360, sampleScale * 18)))));
  const parts: string[] = [];
  for (let index = 0; index <= samples; index += 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / samples);
    const point = spiralNormalOffsetPoint(theta, outerOffset, metrics);
    const screen = worldToScreenCircular(camera, point.x, point.y);
    parts.push(`${index === 0 ? "M" : "L"} ${screen.x.toFixed(3)} ${screen.y.toFixed(3)}`);
  }
  for (let index = samples; index >= 0; index -= 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / samples);
    const point = spiralNormalOffsetPoint(theta, innerOffset, metrics);
    const screen = worldToScreenCircular(camera, point.x, point.y);
    parts.push(`L ${screen.x.toFixed(3)} ${screen.y.toFixed(3)}`);
  }
  parts.push("Z");
  return parts.join(" ");
}

function traceCircularRibbonPath(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  innerRadiusPx: number,
  outerRadiusPx: number,
  startTheta: number,
  endTheta: number,
): void {
  const spanTheta = Math.max(0, endTheta - startTheta);
  const avgRadiusPx = (innerRadiusPx + outerRadiusPx) * 0.5;
  const spanPx = spanTheta * avgRadiusPx;
  const usePolygonFallback = outerRadiusPx >= CIRCULAR_RIBBON_CANVAS_STABILITY_RADIUS_PX
    && spanPx <= CIRCULAR_RIBBON_CANVAS_STABILITY_ARC_PX;
  ctx.beginPath();
  if (!usePolygonFallback) {
    ctx.arc(centerX, centerY, outerRadiusPx, startTheta, endTheta, false);
    ctx.arc(centerX, centerY, innerRadiusPx, endTheta, startTheta, true);
    ctx.closePath();
    return;
  }
  const sampleCount = Math.max(4, Math.min(32, Math.ceil(spanPx / 18)));
  for (let index = 0; index <= sampleCount; index += 1) {
    const theta = startTheta + ((spanTheta * index) / sampleCount);
    const x = centerX + (Math.cos(theta) * outerRadiusPx);
    const y = centerY + (Math.sin(theta) * outerRadiusPx);
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  for (let index = sampleCount; index >= 0; index -= 1) {
    const theta = startTheta + ((spanTheta * index) / sampleCount);
    ctx.lineTo(
      centerX + (Math.cos(theta) * innerRadiusPx),
      centerY + (Math.sin(theta) * innerRadiusPx),
    );
  }
  ctx.closePath();
}

function buildSvgString(scene: SvgScene): string {
  const body = scene.elements.map((element) => {
    if (element.kind === "rect") {
      return `<rect x="${element.x.toFixed(3)}" y="${element.y.toFixed(3)}" width="${element.width.toFixed(3)}" height="${element.height.toFixed(3)}" fill="${element.fill}"${element.opacity !== undefined ? ` opacity="${element.opacity}"` : ""}/>`;
    }
    if (element.kind === "line") {
      return `<line x1="${element.x1.toFixed(3)}" y1="${element.y1.toFixed(3)}" x2="${element.x2.toFixed(3)}" y2="${element.y2.toFixed(3)}" stroke="${element.stroke}" stroke-width="${element.strokeWidth.toFixed(3)}"${element.opacity !== undefined ? ` opacity="${element.opacity}"` : ""}${element.dashArray ? ` stroke-dasharray="${element.dashArray}"` : ""} stroke-linecap="butt"/>`;
    }
    if (element.kind === "path") {
      return `<path d="${element.d}"${element.stroke ? ` stroke="${element.stroke}"` : ""}${element.strokeWidth !== undefined ? ` stroke-width="${element.strokeWidth.toFixed(3)}"` : ""}${element.fill ? ` fill="${element.fill}"` : " fill=\"none\""}${element.opacity !== undefined ? ` opacity="${element.opacity}"` : ""}${element.dashArray ? ` stroke-dasharray="${element.dashArray}"` : ""} stroke-linecap="butt" stroke-linejoin="round"/>`;
    }
    if (element.kind === "image") {
      return `<image href="${escapeSvgText(element.href)}" x="${element.x.toFixed(3)}" y="${element.y.toFixed(3)}" width="${element.width.toFixed(3)}" height="${element.height.toFixed(3)}"${element.opacity !== undefined ? ` opacity="${element.opacity}"` : ""}/>`;
    }
    const transform = element.rotation
      ? ` transform="rotate(${((element.rotation * 180) / Math.PI).toFixed(3)} ${element.x.toFixed(3)} ${element.y.toFixed(3)})"`
      : "";
    const style = element.fontStyle ? ` font-style="${element.fontStyle.includes("italic") ? "italic" : "normal"}" font-weight="${element.fontStyle.includes("700") ? "700" : "400"}"` : "";
    return `<text x="${element.x.toFixed(3)}" y="${element.y.toFixed(3)}" fill="${element.fill}" font-size="${element.fontSize.toFixed(3)}" font-family="${escapeSvgText(element.fontFamily)}"${style} text-anchor="${element.anchor}" dominant-baseline="middle"${transform}>${escapeSvgText(element.text)}</text>`;
  }).join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">`,
    `<rect width="100%" height="100%" fill="${scene.background}"/>`,
    body,
    "</svg>",
  ].join("");
}

function hslColor(hue: number, saturation: number, lightness: number): string {
  const normalizedHue = ((hue % 360) + 360) % 360;
  return `hsl(${normalizedHue.toFixed(2)}deg ${saturation.toFixed(1)}% ${lightness.toFixed(1)}%)`;
}

function ageGradientStripeFill(index: number, bandCount: number, alpha = 1): string {
  const t = bandCount <= 1 ? 1 : Math.max(0, Math.min(1, index / Math.max(1, bandCount - 1)));
  const eased = t ** 2.6;
  const opacity = (0.01 + (0.24 * eased)) * Math.max(0, Math.min(1, alpha));
  return `rgba(31,41,55,${opacity.toFixed(3)})`;
}

function rgbToHsl(red: number, green: number, blue: number): { h: number; s: number; l: number } {
  const r = clamp01(red / 255);
  const g = clamp01(green / 255);
  const b = clamp01(blue / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) * 0.5;
  const delta = max - min;
  if (delta <= 1e-9) {
    return { h: 0, s: 0, l: lightness * 100 };
  }
  const saturation = lightness > 0.5
    ? delta / (2 - max - min)
    : delta / (max + min);
  let hue = 0;
  if (max === r) {
    hue = ((g - b) / delta) + (g < b ? 6 : 0);
  } else if (max === g) {
    hue = ((b - r) / delta) + 2;
  } else {
    hue = ((r - g) / delta) + 4;
  }
  return {
    h: (hue * 60) % 360,
    s: saturation * 100,
    l: lightness * 100,
  };
}

function parseHslColor(fill: string): { h: number; s: number; l: number } | null {
  const match = /hsl\(([-\d.]+)deg\s+([-\d.]+)%\s+([-\d.]+)%\)/i.exec(fill);
  if (match) {
    return {
      h: Number.parseFloat(match[1]),
      s: Number.parseFloat(match[2]),
      l: Number.parseFloat(match[3]),
    };
  }
  const hex = fill.trim();
  const shortHexMatch = /^#([\da-f]{3})$/i.exec(hex);
  if (shortHexMatch) {
    const [red, green, blue] = shortHexMatch[1].split("").map((value) => Number.parseInt(value + value, 16));
    return rgbToHsl(red, green, blue);
  }
  const fullHexMatch = /^#([\da-f]{6})$/i.exec(hex);
  if (fullHexMatch) {
    const value = fullHexMatch[1];
    return rgbToHsl(
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
    );
  }
  const rgbMatch = /^rgb\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/i.exec(fill);
  if (rgbMatch) {
    return rgbToHsl(
      Number.parseFloat(rgbMatch[1]),
      Number.parseFloat(rgbMatch[2]),
      Number.parseFloat(rgbMatch[3]),
    );
  }
  return null;
}

function normalizeColorInput(value: string): string | null {
  const normalized = value.trim();
  if (/^#([\da-f]{3}|[\da-f]{6})$/i.test(normalized)) {
    return normalized.toLowerCase();
  }
  return null;
}

function sortTaxonomyRanksForDisplay(activeRanks: TaxonomyRank[]): TaxonomyRank[] {
  return [...activeRanks].sort(
    (left, right) => TAXONOMY_DISPLAY_ORDER.indexOf(left) - TAXONOMY_DISPLAY_ORDER.indexOf(right),
  );
}

export function taxonomyVisibleRanksForZoom(zoom: number, activeRanks: TaxonomyRank[]): TaxonomyRank[] {
  const outermostRankIndex = activeRanks.length - 1;
  const secondOutermostRankIndex = activeRanks.length - 2;
  const visible = activeRanks.filter((rank, index) => (
    index === outermostRankIndex
    || (index === secondOutermostRankIndex && zoom >= TAXONOMY_SINGLE_LAYER_ZOOM)
    || zoom >= TAXONOMY_LAYER_THRESHOLDS[rank]
  ));
  if (zoom < TAXONOMY_SINGLE_LAYER_ZOOM && visible.length > 1) {
    return visible.slice(-1);
  }
  if (zoom < 0.12 && visible.length > 3) {
    return visible.slice(-2);
  }
  return visible;
}

function chooseAutoTaxonomyColorRootRank(taxonomyMap: TaxonomyMapPayload, activeRanks: TaxonomyRank[]): TaxonomyRank | null {
  const totalMapped = Math.max(1, taxonomyMap.tipRanks.length);
  for (let rankIndex = activeRanks.length - 1; rankIndex >= 0; rankIndex -= 1) {
    const rank = activeRanks[rankIndex];
    const counts = new Map<string, number>();
    for (let tipIndex = 0; tipIndex < taxonomyMap.tipRanks.length; tipIndex += 1) {
      const tip = taxonomyMap.tipRanks[tipIndex];
      const label = tip.ranks[rank];
      if (!label) {
        continue;
      }
      const entityKey = taxonomyEntityKey(label, tip.taxIds?.[rank] ?? null);
      counts.set(entityKey, (counts.get(entityKey) ?? 0) + 1);
    }
    if (counts.size < 2) {
      continue;
    }
    const largestFraction = Math.max(...counts.values()) / totalMapped;
    if (largestFraction <= 0.8) {
      return rank;
    }
  }
  for (let rankIndex = activeRanks.length - 1; rankIndex >= 0; rankIndex -= 1) {
    const rank = activeRanks[rankIndex];
    const distinctCount = new Set(taxonomyMap.tipRanks.map((tip) => {
      const label = tip.ranks[rank];
      return label ? taxonomyEntityKey(label, tip.taxIds?.[rank] ?? null) : null;
    }).filter(Boolean)).size;
    if (distinctCount >= 2) {
      return rank;
    }
  }
  return activeRanks[activeRanks.length - 1] ?? null;
}

function paletteColorForIndex(
  index: number,
  paletteColors: readonly string[],
  fallbackOffset: number,
): string {
  const phi = 0.618033988749895;
  if (paletteColors.length > 0) {
    const baseColor = paletteColors[index % paletteColors.length];
    const cycle = Math.floor(index / paletteColors.length);
    if (cycle === 0) {
      return baseColor;
    }
    const parsed = parseHslColor(baseColor);
    if (parsed) {
      const hue = parsed.h + (cycle * 8);
      const lightness = Math.max(44, Math.min(74, parsed.l + (cycle % 2 === 0 ? 5 : -5)));
      return hslColor(hue, parsed.s, lightness);
    }
  }
  const hue = ((fallbackOffset + index) * phi * 360) % 360;
  return hslColor(hue, 70, 64);
}

const PLANT_TAXON_IDS = new Set([
  33090, // Viridiplantae
  35493, // Streptophyta
  131221, // Streptophytina
  3193, // Embryophyta
  58023, // Tracheophyta
  78536, // Spermatophyta
  3398, // Magnoliophyta
  3399, // Magnoliopsida
]);

const PLANT_TAXON_LABELS = new Set([
  "archaeplastida",
  "chlorobionta",
  "chlorophyta",
  "chloroplastida",
  "embryophyta",
  "magnoliophyta",
  "magnoliopsida",
  "plantae",
  "spermatophyta",
  "streptophyta",
  "tracheophyta",
  "viridiplantae",
]);

function isPlantLikeTaxon(label: string, taxId: number | null): boolean {
  if (taxId !== null && PLANT_TAXON_IDS.has(taxId)) {
    return true;
  }
  return PLANT_TAXON_LABELS.has(label.trim().toLowerCase());
}

function preferredPlantColorIndexForPalette(paletteKey: TaxonomyColorPaletteKey): number | null {
  const palette = TAXONOMY_COLOR_PALETTES[paletteKey];
  if ("plantPreferredIndex" in palette && typeof palette.plantPreferredIndex === "number") {
    return palette.plantPreferredIndex;
  }
  return null;
}

function preferredTaxonColorIndexForPalette(paletteKey: TaxonomyColorPaletteKey, label: string, taxId: number | null): number | null {
  const palette = TAXONOMY_COLOR_PALETTES[paletteKey];
  const preferences = "taxonPreferredColorIndexes" in palette && Array.isArray(palette.taxonPreferredColorIndexes)
    ? palette.taxonPreferredColorIndexes
    : [];
  const normalizedLabel = label.trim().toLowerCase();
  for (let index = 0; index < preferences.length; index += 1) {
    const preference = preferences[index];
    if (taxId !== null && Array.isArray(preference.taxIds) && preference.taxIds.includes(taxId)) {
      return preference.colorIndex;
    }
    if (Array.isArray(preference.labels) && preference.labels.some((candidate: string) => candidate.trim().toLowerCase() === normalizedLabel)) {
      return preference.colorIndex;
    }
  }
  return null;
}

function majorTaxonColorOrderForPalette(paletteKey: TaxonomyColorPaletteKey, paletteColorCount: number): number[] | null {
  const palette = TAXONOMY_COLOR_PALETTES[paletteKey];
  const rawOrder = "majorTaxonColorOrder" in palette && Array.isArray(palette.majorTaxonColorOrder)
    ? palette.majorTaxonColorOrder
    : null;
  if (!rawOrder) {
    return null;
  }
  const seen = new Set<number>();
  const order: number[] = [];
  for (let index = 0; index < rawOrder.length; index += 1) {
    const colorIndex = Math.floor(rawOrder[index]);
    if (colorIndex >= 0 && colorIndex < paletteColorCount && !seen.has(colorIndex)) {
      seen.add(colorIndex);
      order.push(colorIndex);
    }
  }
  for (let colorIndex = 0; colorIndex < paletteColorCount; colorIndex += 1) {
    if (!seen.has(colorIndex)) {
      order.push(colorIndex);
    }
  }
  return order;
}

export function buildTaxonomyColorMap(
  taxonomyMap: TaxonomyMapPayload,
  topLevelOverrides: Map<string, string>,
  jitterScale: number,
  paletteKey: TaxonomyColorPaletteKey,
  customPaletteColors: string[],
  colorRootRank: TaxonomyRank | "auto",
  jitterFloorRank: TaxonomyRank,
): TaxonomyColorByRank {
  const activeRanks = sortTaxonomyRanksForDisplay([...taxonomyMap.activeRanks]);
  if (activeRanks.length === 0) {
    return {};
  }
  const firstSeen = new Map<TaxonomyRank, Map<string, { label: string; taxId: number | null; tipIndex: number }>>();
  for (let rankIndex = 0; rankIndex < activeRanks.length; rankIndex += 1) {
    firstSeen.set(activeRanks[rankIndex], new Map());
  }
  for (let tipIndex = 0; tipIndex < taxonomyMap.tipRanks.length; tipIndex += 1) {
    const tip = taxonomyMap.tipRanks[tipIndex];
    for (let rankIndex = 0; rankIndex < activeRanks.length; rankIndex += 1) {
      const rank = activeRanks[rankIndex];
      const label = tip.ranks[rank];
      if (!label) {
        continue;
      }
      const taxId = tip.taxIds?.[rank] ?? null;
      const entityKey = taxonomyEntityKey(label, taxId);
      const map = firstSeen.get(rank);
      if (map && !map.has(entityKey)) {
        map.set(entityKey, { label, taxId, tipIndex });
      }
    }
  }

  const colorsByRank: TaxonomyColorByRank = {};
  const autoRootRank = chooseAutoTaxonomyColorRootRank(
    taxonomyMap,
    activeRanks.filter(isAutomaticTaxonomyRank),
  );
  const rootRank = colorRootRank === "auto" ? autoRootRank : colorRootRank;
  const rootRankIndex = rootRank ? activeRanks.indexOf(rootRank) : activeRanks.length - 1;
  const effectiveRootRankIndex = rootRankIndex >= 0 ? rootRankIndex : activeRanks.length - 1;
  const jitterRankIndex = Math.min(
    effectiveRootRankIndex,
    Math.max(0, activeRanks.indexOf(jitterFloorRank)),
  );
  const paletteColors = paletteKey === "custom" && customPaletteColors.length > 0
    ? customPaletteColors
    : TAXONOMY_COLOR_PALETTES[paletteKey].colors;
  const useClassicGeneratedSpectrum = paletteColors.length === 0;
  const rootEntries = [...(firstSeen.get(activeRanks[effectiveRootRankIndex])?.entries() ?? [])].sort((left, right) => left[1].tipIndex - right[1].tipIndex);
  const rootEntryColorIndexes = new Map<string, number>();
  rootEntries.forEach(([entityKey], index) => {
    rootEntryColorIndexes.set(entityKey, index);
  });
  if (rootEntries.length > 1 && paletteColors.length > 0) {
    const rootCounts = new Map<string, number>();
    const rootRank = activeRanks[effectiveRootRankIndex];
    for (let tipIndex = 0; tipIndex < taxonomyMap.tipRanks.length; tipIndex += 1) {
      const tip = taxonomyMap.tipRanks[tipIndex];
      const label = tip.ranks[rootRank];
      if (!label) {
        continue;
      }
      const entityKey = taxonomyEntityKey(label, tip.taxIds?.[rootRank] ?? null);
      rootCounts.set(entityKey, (rootCounts.get(entityKey) ?? 0) + 1);
    }
    const colorOrder = majorTaxonColorOrderForPalette(paletteKey, paletteColors.length);
    if (colorOrder && colorOrder.length > 0) {
      rootEntryColorIndexes.clear();
      const assignedColorIndexes = new Set<number>();
      const assignColorIndex = (entityKey: string, colorIndex: number): void => {
        rootEntryColorIndexes.set(entityKey, colorIndex);
        assignedColorIndexes.add(colorIndex);
      };
      const entriesBySize = [...rootEntries].sort((left, right) => {
        const countDelta = (rootCounts.get(right[0]) ?? 0) - (rootCounts.get(left[0]) ?? 0);
        return countDelta !== 0 ? countDelta : left[1].tipIndex - right[1].tipIndex;
      });
      for (let entryIndex = 0; entryIndex < entriesBySize.length; entryIndex += 1) {
        const [entityKey, entry] = entriesBySize[entryIndex];
        const preferredColorIndex = preferredTaxonColorIndexForPalette(paletteKey, entry.label, entry.taxId);
        if (preferredColorIndex === null) {
          continue;
        }
        const boundedColorIndex = Math.max(0, Math.min(paletteColors.length - 1, preferredColorIndex));
        if (!assignedColorIndexes.has(boundedColorIndex)) {
          assignColorIndex(entityKey, boundedColorIndex);
        }
      }
      const plantPreferredIndex = preferredPlantColorIndexForPalette(paletteKey);
      if (plantPreferredIndex !== null) {
        const boundedPreferredIndex = Math.max(0, Math.min(paletteColors.length - 1, plantPreferredIndex));
        const plantEntry = rootEntries
          .filter(([, entry]) => isPlantLikeTaxon(entry.label, entry.taxId))
          .sort((left, right) => (rootCounts.get(right[0]) ?? 0) - (rootCounts.get(left[0]) ?? 0))[0];
        if (plantEntry && !rootEntryColorIndexes.has(plantEntry[0]) && !assignedColorIndexes.has(boundedPreferredIndex)) {
          assignColorIndex(plantEntry[0], boundedPreferredIndex);
        }
      }
      let orderCursor = 0;
      for (let entryIndex = 0; entryIndex < entriesBySize.length; entryIndex += 1) {
        const [entityKey] = entriesBySize[entryIndex];
        if (rootEntryColorIndexes.has(entityKey)) {
          continue;
        }
        while (orderCursor < colorOrder.length && assignedColorIndexes.has(colorOrder[orderCursor])) {
          orderCursor += 1;
        }
        const colorIndex = orderCursor < colorOrder.length
          ? colorOrder[orderCursor]
          : rootEntries.findIndex(([key]) => key === entityKey);
        assignColorIndex(entityKey, colorIndex >= 0 ? colorIndex : entryIndex);
        orderCursor += 1;
      }
    }
  }
  for (let rankIndex = effectiveRootRankIndex; rankIndex < activeRanks.length; rankIndex += 1) {
    const rank = activeRanks[rankIndex];
    const entries = [...(firstSeen.get(rank)?.entries() ?? [])].sort((left, right) => left[1].tipIndex - right[1].tipIndex);
    const rankColors: Record<string, string> = {};
    for (let index = 0; index < entries.length; index += 1) {
      const [entityKey, entry] = entries[index];
      const override = rankIndex === effectiveRootRankIndex ? topLevelOverrides.get(entry.label) ?? null : null;
      const colorIndex = rankIndex === effectiveRootRankIndex
        ? rootEntryColorIndexes.get(entityKey) ?? index
        : index;
      rankColors[entityKey] = override ?? paletteColorForIndex(
        colorIndex,
        rankIndex === effectiveRootRankIndex ? paletteColors : [],
        useClassicGeneratedSpectrum ? 0 : rankIndex * 17,
      );
    }
    colorsByRank[rank] = rankColors;
  }

  for (let rankIndex = effectiveRootRankIndex - 1; rankIndex >= 0; rankIndex -= 1) {
    const childRank = activeRanks[rankIndex];
    const childSeen = firstSeen.get(childRank) ?? new Map<string, { label: string; taxId: number | null; tipIndex: number }>();
    const parentAssignments = new Map<string, {
      childLabel: string;
      childTaxId: number | null;
      parentRank: TaxonomyRank;
      parentLabel: string;
      parentTaxId: number | null;
      firstSeen: number;
    }>();
    for (let tipIndex = 0; tipIndex < taxonomyMap.tipRanks.length; tipIndex += 1) {
      const tip = taxonomyMap.tipRanks[tipIndex];
      const childLabel = tip.ranks[childRank];
      if (!childLabel) {
        continue;
      }
      const childTaxId = tip.taxIds?.[childRank] ?? null;
      const childEntityKey = taxonomyEntityKey(childLabel, childTaxId);
      for (let parentRankIndex = rankIndex + 1; parentRankIndex < activeRanks.length; parentRankIndex += 1) {
        const parentRank = activeRanks[parentRankIndex];
        const parentLabel = tip.ranks[parentRank];
        if (!parentLabel) {
          continue;
        }
        const parentTaxId = tip.taxIds?.[parentRank] ?? null;
        if (!parentAssignments.has(childEntityKey)) {
          parentAssignments.set(childEntityKey, {
            childLabel,
            childTaxId,
            parentRank,
            parentLabel,
            parentTaxId,
            firstSeen: tipIndex,
          });
        }
        break;
      }
    }

    const grouped = new Map<string, Array<{ childEntityKey: string; firstSeen: number }>>();
    parentAssignments.forEach((assignment, childEntityKey) => {
      const key = `${assignment.parentRank}:${taxonomyEntityKey(assignment.parentLabel, assignment.parentTaxId)}`;
      const group = grouped.get(key) ?? [];
      group.push({ childEntityKey, firstSeen: assignment.firstSeen });
      grouped.set(key, group);
    });

    const childColors: Record<string, string> = {};
    grouped.forEach((children, key) => {
      const [parentRankText, ...parentParts] = key.split(":");
      const parentRank = parentRankText as TaxonomyRank;
      const parentEntityKey = parentParts.join(":");
      const parentColor = colorsByRank[parentRank]?.[parentEntityKey] ?? hslColor(0, 0, 55);
      const parsed = parseHslColor(parentColor) ?? { h: 0, s: 0, l: 55 };
      children.sort((left, right) => left.firstSeen - right.firstSeen);
      const effectiveJitterScale = rankIndex >= jitterRankIndex ? jitterScale : 0;
      for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
        if (effectiveJitterScale <= 0) {
          childColors[children[childIndex].childEntityKey] = parentColor;
          continue;
        }
        const position = children.length === 1
          ? 0
          : ((((childIndex + 1) * 0.618033988749895) % 1) * 2) - 1;
        const hue = parsed.h + (position * 18 * effectiveJitterScale);
        const lightnessDelta = position > 0 ? 4 * effectiveJitterScale : position < 0 ? -4 * effectiveJitterScale : 0;
        const lightness = parsed.l + lightnessDelta;
        childColors[children[childIndex].childEntityKey] = hslColor(hue, parsed.s, Math.max(42, Math.min(76, lightness)));
      }
    });

    [...childSeen.keys()].forEach((childEntityKey, index) => {
      if (!childColors[childEntityKey]) {
        childColors[childEntityKey] = paletteColorForIndex(
          index,
          [],
          useClassicGeneratedSpectrum ? rootEntries.length : rootEntries.length + index,
        );
      }
    });
    colorsByRank[childRank] = childColors;
  }

  return colorsByRank;
}

function taxonomyBlockStableKey(block: TaxonomyBlock): string {
  return `${block.rank}:${block.entityKey ?? taxonomyEntityKey(block.label, block.taxId ?? null)}:${block.centerNode}`;
}

function disposeCanvasCache(cache: { canvas: HTMLCanvasElement } | null): void {
  if (!cache) {
    return;
  }
  cache.canvas.width = 0;
  cache.canvas.height = 0;
}

function lowestCommonAncestor(tree: TreeModel, leftNode: number, rightNode: number): number {
  const ancestors = new Set<number>();
  let current = leftNode;
  while (current >= 0 && !ancestors.has(current)) {
    ancestors.add(current);
    current = tree.buffers.parent[current];
  }
  current = rightNode;
  while (current >= 0) {
    if (ancestors.has(current)) {
      return current;
    }
    current = tree.buffers.parent[current];
  }
  return 0;
}

function lowerBoundNumber(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function resolveTaxonomySegmentClade(
  tree: TreeModel,
  layout: LayoutBuffers,
  orderedLeaves: number[],
  taxonomyTipByNode: Map<number, TaxonomyMapPayload["tipRanks"][number]>,
  mappedPrefix: Uint32Array,
  rank: TaxonomyRank,
  label: string,
  taxId: number | null,
  firstNode: number,
  lastNode: number,
): number | null {
  const candidate = lowestCommonAncestor(tree, firstNode, lastNode);
  if (tree.buffers.firstChild[candidate] < 0) {
    return null;
  }
  const leafRange = (node: number): { start: number; end: number } => ({
    start: Math.max(0, Math.floor(layout.min[node] + 1e-6)),
    end: Math.min(tree.leafCount, Math.ceil(layout.max[node] - 1e-6) + 1),
  });
  const candidateRange = leafRange(candidate);
  const matchingIndices: number[] = [];
  for (let leafIndex = candidateRange.start; leafIndex < candidateRange.end; leafIndex += 1) {
    const tip = taxonomyTipByNode.get(orderedLeaves[leafIndex]);
    if (
      tip?.ranks[rank] === label
      && (taxId === null || (tip.taxIds?.[rank] ?? null) === taxId)
    ) {
      matchingIndices.push(leafIndex);
    }
  }
  if (matchingIndices.length < 2) {
    return null;
  }
  const countsForNode = (node: number): { matching: number; mapped: number } => {
    const range = leafRange(node);
    const matching = (
      lowerBoundNumber(matchingIndices, range.end)
      - lowerBoundNumber(matchingIndices, range.start)
    );
    const mapped = mappedPrefix[range.end] - mappedPrefix[range.start];
    return { matching, mapped };
  };
  const isCoherentTaxonomyClade = (node: number): boolean => {
    const { matching, mapped } = countsForNode(node);
    if (matching < 2 || mapped < matching) {
      return false;
    }
    const differentlyMapped = mapped - matching;
    if (differentlyMapped === 0) {
      return true;
    }
    return mapped >= 20 && differentlyMapped <= Math.max(1, Math.floor(mapped * 0.005));
  };
  if (isCoherentTaxonomyClade(candidate)) {
    return candidate;
  }
  const coherentRoots: Array<{ node: number; matching: number }> = [];
  const stack: number[] = [];
  for (let child = tree.buffers.firstChild[candidate]; child >= 0; child = tree.buffers.nextSibling[child]) {
    stack.push(child);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (tree.buffers.firstChild[node] < 0) {
      continue;
    }
    if (isCoherentTaxonomyClade(node)) {
      coherentRoots.push({ node, matching: countsForNode(node).matching });
      continue;
    }
    for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
      stack.push(child);
    }
  }
  coherentRoots.sort((left, right) => (
    right.matching - left.matching
    || tree.buffers.leafCount[right.node] - tree.buffers.leafCount[left.node]
  ));
  return coherentRoots[0]?.node ?? null;
}

function taxonomyTextColor(fill: string): string {
  const parsed = parseHslColor(fill);
  if (!parsed) {
    return "#0f172a";
  }
  return parsed.l >= 64 ? "#0f172a" : "#f8fafc";
}

function taxonomyOverlayTextColor(fill: string, overlayStyle: "ribbons" | "strands"): string {
  return overlayStyle === "strands" ? "#0f172a" : taxonomyTextColor(fill);
}

function taxonomyRingMetricsPx(
  rankCount: number,
  baseFontSize: number,
  bandThicknessScale = 1,
  viewportScale = 1,
  thickenOutermostRibbon = true,
): {
  ringWidthsPx: number[];
  ringGapPx: number;
  labelGapPx: number;
} {
  const compactScale = Math.max(0.5, Math.min(1, viewportScale));
  const clampedBandThicknessScale = Math.max(0.05, bandThicknessScale);
  if (compactScale >= 0.999) {
    const ringBaseWidthPx = Math.max(0.75, Math.min(72, baseFontSize * 3.24 * clampedBandThicknessScale));
    const outerRingWidthPx = ringBaseWidthPx * (thickenOutermostRibbon ? 1.82 : 1);
    const ringGapPx = Math.max(0.25, Math.max(6, baseFontSize * 0.42) * clampedBandThicknessScale);
    const labelGapPx = Math.max(14, baseFontSize * 1.05);
    const ringWidthsPx = Array.from({ length: rankCount }, (_, index) => (
      index === rankCount - 1 ? outerRingWidthPx : ringBaseWidthPx
    ));
    return { ringWidthsPx, ringGapPx, labelGapPx };
  }
  const ringBaseWidthPx = Math.max(0.75, Math.min(72, baseFontSize * 3.24 * clampedBandThicknessScale)) * compactScale;
  const outerRingWidthPx = ringBaseWidthPx * (thickenOutermostRibbon ? 1.82 : 1);
  const ringGapPx = Math.max(0.25, Math.max(4, baseFontSize * 0.42 * compactScale) * clampedBandThicknessScale);
  const labelGapPx = Math.max(8, baseFontSize * 1.05 * compactScale);
  const ringWidthsPx = Array.from({ length: rankCount }, (_, index) => (
    index === rankCount - 1 ? outerRingWidthPx : ringBaseWidthPx
  ));
  return { ringWidthsPx, ringGapPx, labelGapPx };
}

function controlledRibbonGapPx(
  controlValue: number,
  defaultGapPx: number,
  visibleTipLabelSpacePx = 0,
): number {
  const value = Math.max(0, controlValue);
  const extraGapPx = Math.max(0, value - 1);
  const baselineScale = visibleTipLabelSpacePx > 0 ? 1 : Math.min(1, value);
  return visibleTipLabelSpacePx + (Math.max(0, defaultGapPx) * baselineScale) + extraGapPx;
}

function translateCircularOverlayArc(arc: CircularOverlayArc, _dx: number, _dy: number): CircularOverlayArc {
  return arc;
}

function translateScreenLabel(label: ScreenLabel, dx: number, dy: number): ScreenLabel {
  if (dx === 0 && dy === 0) {
    return label;
  }
  return {
    ...label,
    x: label.x + dx,
    y: label.y + dy,
  };
}

const normalizedLabelMetricsCache = new Map<string, { widthAtOnePx: number; heightAtOnePx: number }>();

function measureNormalizedLabelMetrics(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontFamily = LABEL_FONT,
): { widthAtOnePx: number; heightAtOnePx: number } {
  const cacheKey = `${fontFamily}\u0000${text}`;
  const cached = normalizedLabelMetricsCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const sampleFontSize = 100;
  ctx.font = `${sampleFontSize}px ${fontFamily}`;
  const metrics = ctx.measureText(text);
  const ascent = metrics.actualBoundingBoxAscent || (sampleFontSize * 0.72);
  const descent = metrics.actualBoundingBoxDescent || (sampleFontSize * 0.28);
  const normalized = {
    widthAtOnePx: Math.max(metrics.width / sampleFontSize, 1e-6),
    heightAtOnePx: Math.max((ascent + descent) / sampleFontSize, 1e-6),
  };
  normalizedLabelMetricsCache.set(cacheKey, normalized);
  if (normalizedLabelMetricsCache.size > 50_000) {
    normalizedLabelMetricsCache.clear();
    normalizedLabelMetricsCache.set(cacheKey, normalized);
  }
  return normalized;
}

function viewportScaleForCenteredRotatedLabel(
  x: number,
  y: number,
  widthPx: number,
  heightPx: number,
  rotation: number,
  viewportWidth: number,
  viewportHeight: number,
  marginPx: number,
): number {
  const halfWidth = widthPx * 0.5;
  const halfHeight = heightPx * 0.5;
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const extentX = (cos * halfWidth) + (sin * halfHeight);
  const extentY = (sin * halfWidth) + (cos * halfHeight);
  const availableLeft = Math.max(0, x - marginPx);
  const availableRight = Math.max(0, (viewportWidth - marginPx) - x);
  const availableTop = Math.max(0, y - marginPx);
  const availableBottom = Math.max(0, (viewportHeight - marginPx) - y);
  const scaleX = extentX > 1e-6 ? Math.min(availableLeft / extentX, availableRight / extentX) : 1;
  const scaleY = extentY > 1e-6 ? Math.min(availableTop / extentY, availableBottom / extentY) : 1;
  return Math.max(0, Math.min(1, scaleX, scaleY));
}

function centeredRotatedLabelIntersectsViewport(
  x: number,
  y: number,
  widthPx: number,
  heightPx: number,
  rotation: number,
  viewportWidth: number,
  viewportHeight: number,
  marginPx: number,
): boolean {
  const halfWidth = widthPx * 0.5;
  const halfHeight = heightPx * 0.5;
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const extentX = (cos * halfWidth) + (sin * halfHeight);
  const extentY = (sin * halfWidth) + (cos * halfHeight);
  return (
    x + extentX >= -marginPx
    && x - extentX <= viewportWidth + marginPx
    && y + extentY >= -marginPx
    && y - extentY <= viewportHeight + marginPx
  );
}

function intersectWrappedAngularIntervals(
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): Array<{ start: number; end: number }> {
  const normalize = (start: number, end: number): Array<{ start: number; end: number }> => {
    if (end >= start) {
      return [{ start, end }];
    }
    return [
      { start, end: Math.PI * 2 },
      { start: 0, end },
    ];
  };
  const aParts = normalize(startA, endA);
  const bParts = normalize(startB, endB);
  const intersections: Array<{ start: number; end: number }> = [];
  for (let aIndex = 0; aIndex < aParts.length; aIndex += 1) {
    for (let bIndex = 0; bIndex < bParts.length; bIndex += 1) {
      const start = Math.max(aParts[aIndex].start, bParts[bIndex].start);
      const end = Math.min(aParts[aIndex].end, bParts[bIndex].end);
      if (end > start) {
        intersections.push({ start, end });
      }
    }
  }
  return intersections;
}

function wrappedAngleWithinInterval(angle: number, start: number, end: number): boolean {
  const normalizedAngle = wrapPositive(angle);
  const normalizedStart = wrapPositive(start);
  const normalizedEnd = wrapPositive(end);
  if (normalizedEnd >= normalizedStart) {
    return normalizedAngle >= normalizedStart && normalizedAngle <= normalizedEnd;
  }
  return normalizedAngle >= normalizedStart || normalizedAngle <= normalizedEnd;
}

function wrappedAnglesEqual(left: number, right: number, epsilon = 1e-6): boolean {
  const delta = Math.abs(wrapPositive(left) - wrapPositive(right));
  return delta <= epsilon || Math.abs(delta - (Math.PI * 2)) <= epsilon;
}

function pointInPolygon(pointX: number, pointY: number, points: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let index = 0, previousIndex = points.length - 1; index < points.length; previousIndex = index, index += 1) {
    const point = points[index];
    const previousPoint = points[previousIndex];
    if (
      ((point.y > pointY) !== (previousPoint.y > pointY))
      && pointX < ((previousPoint.x - point.x) * (pointY - point.y) / ((previousPoint.y - point.y) || 1e-9)) + point.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygonHitArea(
  pointX: number,
  pointY: number,
  points: Array<{ x: number; y: number }>,
  tolerancePx = 2,
): boolean {
  if (pointInPolygon(pointX, pointY, points)) {
    return true;
  }
  const toleranceSq = tolerancePx * tolerancePx;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    if (distanceToSegmentSquared(pointX, pointY, start.x, start.y, end.x, end.y) <= toleranceSq) {
      return true;
    }
  }
  return false;
}

function pointInCollapsedTriangleHitArea(
  pointX: number,
  pointY: number,
  points: Array<{ x: number; y: number }>,
  tolerancePx = 4,
): boolean {
  if (points.length < 3) {
    return false;
  }
  if (pointInPolygon(pointX, pointY, points)) {
    return true;
  }
  const apex = points[0];
  const baseMidpoint = {
    x: (points[1].x + points[2].x) * 0.5,
    y: (points[1].y + points[2].y) * 0.5,
  };
  const axisX = baseMidpoint.x - apex.x;
  const axisY = baseMidpoint.y - apex.y;
  const axisLengthSq = (axisX * axisX) + (axisY * axisY);
  if (axisLengthSq <= 1e-6) {
    return false;
  }
  const projection = (
    ((pointX - apex.x) * axisX)
    + ((pointY - apex.y) * axisY)
  ) / axisLengthSq;
  if (projection < 0 || projection > 1) {
    return false;
  }
  const toleranceSq = tolerancePx * tolerancePx;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    if (distanceToSegmentSquared(pointX, pointY, start.x, start.y, end.x, end.y) <= toleranceSq) {
      return true;
    }
  }
  return false;
}

function polygonBounds(points: Array<{ x: number; y: number }>): { left: number; right: number; top: number; bottom: number } {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  return { left, right, top, bottom };
}

function isScreenPointVisible(x: number, y: number, width: number, height: number, margin = 12): boolean {
  return x >= -margin && x <= (width + margin) && y >= -margin && y <= (height + margin);
}

function visibleTaxonomyLabelSpans(
  segmentStart: number,
  segmentEnd: number,
  visibleSpans: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const intersections: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < visibleSpans.length; index += 1) {
    const partial = intersectWrappedAngularIntervals(
      segmentStart,
      segmentEnd,
      visibleSpans[index].start,
      visibleSpans[index].end,
    );
    for (let intersectionIndex = 0; intersectionIndex < partial.length; intersectionIndex += 1) {
      intersections.push(partial[intersectionIndex]);
    }
  }
  intersections.sort((left, right) => (right.end - right.start) - (left.end - left.start));
  return intersections;
}

function splitWrappedAngularInterval(start: number, end: number): Array<{ start: number; end: number }> {
  const wrappedStart = wrapPositive(start);
  const wrappedEnd = wrapPositive(end);
  if (wrappedEnd >= wrappedStart) {
    return [{ start: wrappedStart, end: wrappedEnd }];
  }
  return [
    { start: wrappedStart, end: Math.PI * 2 },
    { start: 0, end: wrappedEnd },
  ];
}

function splitWrappedLeafInterval(
  start: number,
  end: number,
  leafCount: number,
): Array<{ start: number; end: number }> {
  if (end > start) {
    return [{ start, end }];
  }
  return [
    { start, end: leafCount },
    { start: 0, end },
  ];
}

function angularIntervalsOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}

function leafIntervalsOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}

function taxonomyBlockIntersectsVisibleLeafRanges(
  blockSegments: Array<{ startIndex: number; endIndex: number }>,
  visibleLeafRanges: Array<{ startIndex: number; endIndex: number }>,
  leafCount: number,
): boolean {
  if (visibleLeafRanges.length === 0) {
    return true;
  }
  for (let segmentIndex = 0; segmentIndex < blockSegments.length; segmentIndex += 1) {
    const segmentIntervals = splitWrappedLeafInterval(
      blockSegments[segmentIndex].startIndex,
      blockSegments[segmentIndex].endIndex,
      leafCount,
    );
    for (let rangeIndex = 0; rangeIndex < visibleLeafRanges.length; rangeIndex += 1) {
      const rangeIntervals = splitWrappedLeafInterval(
        visibleLeafRanges[rangeIndex].startIndex,
        visibleLeafRanges[rangeIndex].endIndex,
        leafCount,
      );
      for (let segmentPartIndex = 0; segmentPartIndex < segmentIntervals.length; segmentPartIndex += 1) {
        for (let rangePartIndex = 0; rangePartIndex < rangeIntervals.length; rangePartIndex += 1) {
          if (leafIntervalsOverlap(segmentIntervals[segmentPartIndex], rangeIntervals[rangePartIndex])) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function canPlaceTaxonomyArcLabel(
  occupied: Array<{ start: number; end: number }>,
  theta: number,
  lineRadiusPx: number,
  textWidthPx: number,
  labelArcSpanTheta: number,
): boolean {
  const angularHalfSpan = (textWidthPx / Math.max(lineRadiusPx, 1e-6)) * 0.5;
  const padTheta = Math.max(0, labelArcSpanTheta * 0.06);
  const intervals = splitWrappedAngularInterval(theta - angularHalfSpan - padTheta, theta + angularHalfSpan + padTheta);
  for (let intervalIndex = 0; intervalIndex < intervals.length; intervalIndex += 1) {
    for (let occupiedIndex = 0; occupiedIndex < occupied.length; occupiedIndex += 1) {
      if (angularIntervalsOverlap(intervals[intervalIndex], occupied[occupiedIndex])) {
        return false;
      }
    }
  }
  return true;
}

type TaxonomyConsensusByRank = Partial<Record<TaxonomyRank, Array<string | null>>>;

function buildTaxonomyConsensusByRank(
  tree: TreeModel,
  taxonomyMap: TaxonomyMapPayload,
  activeRanks: TaxonomyRank[],
): TaxonomyConsensusByRank {
  const tipRanksByNode = new Map<number, Partial<Record<TaxonomyRank, string>>>();
  for (let index = 0; index < taxonomyMap.tipRanks.length; index += 1) {
    tipRanksByNode.set(taxonomyMap.tipRanks[index].node, taxonomyMap.tipRanks[index].ranks);
  }
  const postorder: number[] = [];
  const stack = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    postorder.push(node);
    for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
      stack.push(child);
    }
  }
  const consensus: TaxonomyConsensusByRank = {};
  const mixed = "__mixed__";
  for (let rankIndex = 0; rankIndex < activeRanks.length; rankIndex += 1) {
    const rank = activeRanks[rankIndex];
    const values = new Array<string | null>(tree.nodeCount).fill(null);
    for (let index = postorder.length - 1; index >= 0; index -= 1) {
      const node = postorder[index];
      if (tree.buffers.firstChild[node] < 0) {
        values[node] = tipRanksByNode.get(node)?.[rank] ?? null;
        continue;
      }
      let current: string | null = null;
      let isMixed = false;
      for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
        const childValue = values[child];
        if (!childValue) {
          continue;
        }
        if (childValue === mixed) {
          isMixed = true;
          break;
        }
        if (current === null) {
          current = childValue;
        } else if (current !== childValue) {
          isMixed = true;
          break;
        }
      }
      values[node] = isMixed ? mixed : current;
    }
    consensus[rank] = values.map((value) => (value === mixed ? null : value));
  }
  return consensus;
}

function buildTaxonomyBranchColorArray(
  tree: TreeModel,
  taxonomyConsensus: TaxonomyConsensusByRank,
  blocksByRank: Record<TaxonomyRank, TaxonomyBlock[]>,
  colorsByRank: TaxonomyColorByRank | null,
  activeRanks: TaxonomyRank[],
): string[] {
  const colors = new Array<string>(tree.nodeCount);
  const nodeDepth = new Int32Array(tree.nodeCount);
  const tin = new Int32Array(tree.nodeCount);
  const tout = new Int32Array(tree.nodeCount);
  let dfsTime = 0;
  const traversalStack: Array<{ node: number; expanded: boolean }> = [{ node: tree.root, expanded: false }];
  while (traversalStack.length > 0) {
    const entry = traversalStack.pop()!;
    const node = entry.node;
    if (!entry.expanded) {
      tin[node] = dfsTime;
      dfsTime += 1;
      traversalStack.push({ node, expanded: true });
      for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
        nodeDepth[child] = nodeDepth[node] + 1;
        traversalStack.push({ node: child, expanded: false });
      }
    } else {
      tout[node] = dfsTime;
    }
  }
  const isDescendantOf = (node: number, ancestor: number): boolean => tin[node] >= tin[ancestor] && tout[node] <= tout[ancestor];
  const lca = (leftNode: number, rightNode: number): number => {
    let left = leftNode;
    let right = rightNode;
    while (nodeDepth[left] > nodeDepth[right]) {
      left = tree.buffers.parent[left];
    }
    while (nodeDepth[right] > nodeDepth[left]) {
      right = tree.buffers.parent[right];
    }
    while (left !== right) {
      left = tree.buffers.parent[left];
      right = tree.buffers.parent[right];
    }
    return left;
  };
  const rootsByRankLabel = new Map<TaxonomyRank, Map<string, Array<{ rootNode: number; color: string }>>>();
  for (let rankIndex = 0; rankIndex < activeRanks.length; rankIndex += 1) {
    const rank = activeRanks[rankIndex];
    const byLabel = new Map<string, Array<{ rootNode: number; color: string }>>();
    const blocks = blocksByRank[rank] ?? [];
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      const segments = block.segments ?? [];
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex];
        const rootNode = lca(segment.firstNode, segment.lastNode);
        const roots = byLabel.get(block.label) ?? [];
        if (!roots.some((entry) => entry.rootNode === rootNode)) {
          roots.push({ rootNode, color: block.color || colorForTaxonomy(rank, block.label, colorsByRank, block.taxId ?? null) });
          byLabel.set(block.label, roots);
        }
      }
    }
    rootsByRankLabel.set(rank, byLabel);
  }

  for (let node = 0; node < tree.nodeCount; node += 1) {
    const parent = tree.buffers.parent[node];
    if (parent < 0) {
      colors[node] = BRANCH_COLOR;
      continue;
    }
    let color: string | null = null;
    for (let rankIndex = 0; rankIndex < activeRanks.length; rankIndex += 1) {
      const rank = activeRanks[rankIndex];
      const values = taxonomyConsensus[rank];
      if (!values) {
        continue;
      }
      const nodeLabel = values[node];
      if (!nodeLabel || nodeLabel !== values[parent]) {
        continue;
      }
      const roots = rootsByRankLabel.get(rank)?.get(nodeLabel) ?? [];
      for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
        if (isDescendantOf(node, roots[rootIndex].rootNode) && isDescendantOf(parent, roots[rootIndex].rootNode)) {
          color = roots[rootIndex].color;
          break;
        }
      }
      if (color) {
        break;
      }
    }
    colors[node] = color ?? BRANCH_COLOR;
  }
  return colors;
}

function branchColorAssignmentKey(assignments: Map<number, string>): string {
  if (assignments.size === 0) {
    return "";
  }
  return [...assignments.entries()]
    .sort((left, right) => left[0] - right[0] || left[1].localeCompare(right[1]))
    .map(([node, color]) => `${node}:${color}`)
    .join("|");
}

function buildManualBranchColorOverlay(
  tree: TreeModel,
  subtreeAssignments: Map<number, string>,
  branchAssignments: Map<number, string>,
): { colors: Array<string | null>; hasAny: boolean } {
  const colors = new Array<string | null>(tree.nodeCount).fill(null);
  if (subtreeAssignments.size === 0 && branchAssignments.size === 0) {
    return { colors, hasAny: false };
  }
  const nodeDepth = new Int32Array(tree.nodeCount);
  const stack = [tree.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
      nodeDepth[child] = nodeDepth[node] + 1;
      stack.push(child);
    }
  }
  const orderedSubtrees = [...subtreeAssignments.entries()].sort((left, right) => (
    nodeDepth[left[0]] - nodeDepth[right[0]] || left[0] - right[0]
  ));
  for (let index = 0; index < orderedSubtrees.length; index += 1) {
    const [subtreeRoot, color] = orderedSubtrees[index];
    const subtreeStack = [subtreeRoot];
    while (subtreeStack.length > 0) {
      const node = subtreeStack.pop()!;
      colors[node] = color;
      for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
        subtreeStack.push(child);
      }
    }
  }
  branchAssignments.forEach((color, node) => {
    colors[node] = color;
  });
  return { colors, hasAny: true };
}

function branchColorCardinalityWithinLimit(colors: Array<string | null>, limit: number): boolean {
  const uniqueColors = new Set<string>();
  for (let index = 0; index < colors.length; index += 1) {
    const color = colors[index];
    if (!color) {
      continue;
    }
    uniqueColors.add(color);
    if (uniqueColors.size > limit) {
      return false;
    }
  }
  return true;
}

function branchColorsCoverAllBranches(tree: TreeModel, colors: Array<string | null>): boolean {
  if (colors.length !== tree.nodeCount) {
    return false;
  }
  for (let node = 0; node < tree.nodeCount; node += 1) {
    if (tree.buffers.parent[node] >= 0 && !colors[node]) {
      return false;
    }
  }
  return true;
}

function buildCircularTaxonomyPaths(
  tree: TreeModel,
  layout: TreeModel["layouts"][LayoutOrder],
  orderedChildren: number[][],
  branchColors: string[],
  depthForNode: (node: number) => number,
  angleStart: number,
  angleSpan: number,
): Map<string, CircularBranchPathCache> {
  const paths = new Map<string, CircularBranchPathCache>();
  const getPathCache = (color: string): CircularBranchPathCache => {
    const existing = paths.get(color);
    if (existing) {
      return existing;
    }
    const created = {
      stems: new Path2D(),
      connectors: new Path2D(),
    };
    paths.set(color, created);
    return created;
  };

  for (let node = 0; node < tree.nodeCount; node += 1) {
    const parent = tree.buffers.parent[node];
    if (parent < 0) {
      continue;
    }
    const color = branchColors[node] ?? BRANCH_COLOR;
    const theta = thetaFor(layout.center, node, tree.leafCount, angleStart, angleSpan);
    const startWorld = polarToCartesian(depthForNode(parent), theta);
    const endWorld = polarToCartesian(depthForNode(node), theta);
    const pathCache = getPathCache(color);
    pathCache.stems.moveTo(startWorld.x, startWorld.y);
    pathCache.stems.lineTo(endWorld.x, endWorld.y);
  }

  for (let ownerNode = 0; ownerNode < tree.nodeCount; ownerNode += 1) {
    const ordered = orderedChildren[ownerNode];
    if (ordered.length < 2) {
      continue;
    }
    const ownerTheta = thetaFor(layout.center, ownerNode, tree.leafCount, angleStart, angleSpan);
    const ownerArcStart = thetaFor(layout.min, ownerNode, tree.leafCount, angleStart, angleSpan);
    const ownerArcEnd = thetaFor(layout.max, ownerNode, tree.leafCount, angleStart, angleSpan);
    const ownerArcLength = Math.max(0, ownerArcEnd - ownerArcStart);
    const radius = depthForNode(ownerNode);
    if (radius <= 0) {
      continue;
    }
    for (let childIndex = 0; childIndex < ordered.length; childIndex += 1) {
      const child = ordered[childIndex];
      const color = branchColors[child] ?? BRANCH_COLOR;
      const childTheta = thetaFor(layout.center, child, tree.leafCount, angleStart, angleSpan);
      const arcSpan = arcSubspanWithinSpan(ownerTheta, childTheta, ownerArcStart, ownerArcLength);
      if (!arcSpan) {
        continue;
      }
      const pathCache = getPathCache(color);
      pathCache.connectors.moveTo(Math.cos(arcSpan.start) * radius, Math.sin(arcSpan.start) * radius);
      pathCache.connectors.arc(0, 0, radius, arcSpan.start, arcSpan.end, false);
    }
  }

  return paths;
}

function buildCircularBranchPath(
  tree: TreeModel,
  layout: TreeModel["layouts"][LayoutOrder],
  orderedChildren: number[][],
  depthForNode: (node: number) => number,
  angleStart: number,
  angleSpan: number,
): CircularBranchPathCache {
  const path = {
    stems: new Path2D(),
    connectors: new Path2D(),
  };
  for (let node = 0; node < tree.nodeCount; node += 1) {
    const parent = tree.buffers.parent[node];
    if (parent >= 0) {
      const theta = thetaFor(layout.center, node, tree.leafCount, angleStart, angleSpan);
      const startWorld = polarToCartesian(depthForNode(parent), theta);
      const endWorld = polarToCartesian(depthForNode(node), theta);
      path.stems.moveTo(startWorld.x, startWorld.y);
      path.stems.lineTo(endWorld.x, endWorld.y);
    }
    const ordered = orderedChildren[node];
    if (ordered.length < 2) {
      continue;
    }
    const radius = depthForNode(node);
    if (!(radius > 0)) {
      continue;
    }
    const startTheta = thetaFor(layout.center, ordered[0], tree.leafCount, angleStart, angleSpan);
    const endTheta = thetaFor(layout.center, ordered[ordered.length - 1], tree.leafCount, angleStart, angleSpan);
    const arcStart = thetaFor(layout.min, node, tree.leafCount, angleStart, angleSpan);
    const arcEnd = thetaFor(layout.max, node, tree.leafCount, angleStart, angleSpan);
    const arcLength = Math.max(0, arcEnd - arcStart);
    const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
    path.connectors.moveTo(Math.cos(arcAngles.start) * radius, Math.sin(arcAngles.start) * radius);
    path.connectors.arc(0, 0, radius, arcAngles.start, arcAngles.end, false);
  }
  return path;
}

function buildRectBranchPaths(
  tree: TreeModel,
  layout: TreeModel["layouts"][LayoutOrder],
  orderedChildren: number[][],
  depthForNode: (node: number) => number,
): { stems: Path2D; connectors: Path2D } {
  const stems = new Path2D();
  const connectors = new Path2D();
  for (let node = 0; node < tree.nodeCount; node += 1) {
    const parent = tree.buffers.parent[node];
    if (parent >= 0) {
      const y = layout.center[node];
      stems.moveTo(depthForNode(parent), y);
      stems.lineTo(depthForNode(node), y);
    }
    const ordered = orderedChildren[node];
    if (ordered.length < 2 || isTerminalRectConnector(tree, node)) {
      continue;
    }
    const x = depthForNode(node);
    connectors.moveTo(x, layout.center[ordered[0]]);
    connectors.lineTo(x, layout.center[ordered[ordered.length - 1]]);
  }
  return { stems, connectors };
}

function forEachRectConnectorChildSpan(
  layout: TreeModel["layouts"][LayoutOrder],
  orderedChildren: number[][],
  ownerNode: number,
  visit: (childNode: number, startY: number, endY: number) => void,
): void {
  const ordered = orderedChildren[ownerNode];
  if (ordered.length < 2) {
    return;
  }
  for (let childIndex = 0; childIndex < ordered.length; childIndex += 1) {
    const childNode = ordered[childIndex];
    const childY = layout.center[childNode];
    const previousY = childIndex === 0
      ? childY
      : (layout.center[ordered[childIndex - 1]] + childY) * 0.5;
    const nextY = childIndex === ordered.length - 1
      ? childY
      : (childY + layout.center[ordered[childIndex + 1]]) * 0.5;
    const startY = Math.min(previousY, nextY);
    const endY = Math.max(previousY, nextY);
    if (endY - startY <= 1e-9) {
      continue;
    }
    visit(childNode, startY, endY);
  }
}

function buildRectTaxonomyPaths(
  tree: TreeModel,
  layout: TreeModel["layouts"][LayoutOrder],
  orderedChildren: number[][],
  branchColors: string[],
  depthForNode: (node: number) => number,
): Map<string, RectBranchPathCache> {
  const paths = new Map<string, RectBranchPathCache>();
  const getPathCache = (color: string): RectBranchPathCache => {
    const existing = paths.get(color);
    if (existing) {
      return existing;
    }
    const created = {
      stems: new Path2D(),
      connectors: new Path2D(),
    };
    paths.set(color, created);
    return created;
  };

  for (let node = 0; node < tree.nodeCount; node += 1) {
    const parent = tree.buffers.parent[node];
    if (parent >= 0) {
      const y = layout.center[node];
      const color = branchColors[node] ?? BRANCH_COLOR;
      const path = getPathCache(color);
      path.stems.moveTo(depthForNode(parent), y);
      path.stems.lineTo(depthForNode(node), y);
    }
    const ordered = orderedChildren[node];
    if (ordered.length < 2 || isTerminalRectConnector(tree, node)) {
      continue;
    }
    const x = depthForNode(node);
    forEachRectConnectorChildSpan(layout, orderedChildren, node, (childNode, startY, endY) => {
      const color = branchColors[childNode] ?? BRANCH_COLOR;
      const path = getPathCache(color);
      path.connectors.moveTo(x, startY);
      path.connectors.lineTo(x, endY);
    });
  }

  return paths;
}

function rectLeafRangeBounds(
  orderedLeaves: number[],
  center: Float64Array,
  startIndex: number,
  endIndex: number,
): { topY: number; bottomY: number } | null {
  if (orderedLeaves.length === 0) {
    return null;
  }
  const clampedStart = Math.max(0, Math.min(startIndex, orderedLeaves.length - 1));
  const clampedEndExclusive = Math.max(clampedStart + 1, Math.min(endIndex, orderedLeaves.length));
  const firstCenter = center[orderedLeaves[clampedStart]];
  const lastCenter = center[orderedLeaves[clampedEndExclusive - 1]];
  const previousCenter = clampedStart > 0
    ? center[orderedLeaves[clampedStart - 1]]
    : center[orderedLeaves[Math.min(clampedStart + 1, orderedLeaves.length - 1)]];
  const nextCenter = clampedEndExclusive < orderedLeaves.length
    ? center[orderedLeaves[clampedEndExclusive]]
    : center[orderedLeaves[Math.max(0, clampedEndExclusive - 2)]];
  const topY = clampedStart > 0
    ? (previousCenter + firstCenter) * 0.5
    : firstCenter;
  const bottomY = clampedEndExclusive < orderedLeaves.length
    ? (lastCenter + nextCenter) * 0.5
    : lastCenter;
  return {
    topY: Math.min(topY, bottomY),
    bottomY: Math.max(topY, bottomY),
  };
}

type PanBenchmarkSample = {
  timestampMs: number;
  frameDeltaMs: number | null;
  inputLatencyMs: number | null;
  frameQueueWaitMs: number | null;
  drawTotalMs: number;
  branchBaseMs: number;
  taxonomyOverlayMs: number;
  renderDpr: number;
  branchRenderMode: string | null;
  cameraKind: CameraState["kind"];
};

type CircularTaxonomyBitmapCache = {
  baseSignature: string;
  canvas: HTMLCanvasElement;
  scale: number;
  rotation: number;
  sourceOffsetX: number;
  sourceOffsetY: number;
  viewportWidth: number;
  viewportHeight: number;
};

type RectTaxonomyBitmapCache = {
  baseSignature: string;
  canvas: HTMLCanvasElement;
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
  paddingX: number;
  paddingY: number;
  viewportWidth: number;
  viewportHeight: number;
};

type CircularOverlayArc =
  | {
    mode: "stroke";
    lineRadiusPx: number;
    lineWidthPx: number;
    startTheta: number;
    endTheta: number;
    color: string;
    key?: string;
    taxonomy?: CircularTaxonomyArcMetadata;
  }
  | {
    mode: "divider";
    theta: number;
    innerRadiusPx: number;
    outerRadiusPx: number;
    lineWidthPx: number;
    color: string;
  }
  | {
    mode: "ribbon";
    lineRadiusPx: number;
    lineWidthPx: number;
    startTheta: number;
    endTheta: number;
    innerRadiusPx: number;
    outerRadiusPx: number;
    color: string;
    screenPolygonPoints?: Array<{ x: number; y: number }>;
    taxonomy?: CircularTaxonomyArcMetadata;
  }
  | {
    mode: "band";
    innerRadiusPx: number;
    outerRadiusPx: number;
    startTheta: number;
    endTheta: number;
    color: string;
    screenPolygonPoints?: Array<{ x: number; y: number }>;
    taxonomy?: CircularTaxonomyArcMetadata;
  };

type CircularTaxonomyOverlayLayoutCache = {
  tree: TreeModel;
  order: LayoutOrder;
  signature: string;
  centerX: number;
  centerY: number;
  baseFontSize: number;
  arcs: CircularOverlayArc[];
  labels: ScreenLabel[];
  arcKeys: string[];
  placedKeys: string[];
  taxonomyCandidateDebug: Array<Record<string, unknown>>;
  taxonomyTipBandOuterRadiusPx: number;
  taxonomyFirstRingInnerRadiusPx: number | null;
};

function circularOverlayLineRadiusPx(arc: CircularOverlayArc | null | undefined): number | null {
  if (!arc) {
    return null;
  }
  if (arc.mode === "divider") {
    return (arc.innerRadiusPx + arc.outerRadiusPx) * 0.5;
  }
  return arc.mode === "band"
    ? (arc.innerRadiusPx + arc.outerRadiusPx) * 0.5
    : arc.lineRadiusPx;
}

function circularOverlayLineWidthPx(arc: CircularOverlayArc | null | undefined): number | null {
  if (!arc) {
    return null;
  }
  if (arc.mode === "divider") {
    return arc.lineWidthPx;
  }
  return arc.mode === "band"
    ? Math.max(0, arc.outerRadiusPx - arc.innerRadiusPx)
    : arc.lineWidthPx;
}

function circularOverlayInnerRadiusPx(arc: CircularOverlayArc | null | undefined): number | null {
  if (!arc) {
    return null;
  }
  if (arc.mode === "divider") {
    return arc.innerRadiusPx;
  }
  return arc.mode === "band" || arc.mode === "ribbon"
    ? arc.innerRadiusPx
    : arc.lineRadiusPx - (arc.lineWidthPx * 0.5);
}

function circularOverlayOuterRadiusPx(arc: CircularOverlayArc | null | undefined): number | null {
  if (!arc) {
    return null;
  }
  if (arc.mode === "divider") {
    return arc.outerRadiusPx;
  }
  return arc.mode === "band" || arc.mode === "ribbon"
    ? arc.outerRadiusPx
    : arc.lineRadiusPx + (arc.lineWidthPx * 0.5);
}

type RectBranchPathCache = {
  stems: Path2D;
  connectors: Path2D;
};

type CircularBranchPathCache = {
  stems: Path2D;
  connectors: Path2D;
};

type CircularTaxonomyPathCache = Map<string, CircularBranchPathCache>;

type RectTaxonomyPathCache = Map<string, RectBranchPathCache>;

type SpiralBranchPathBatch = {
  path: Path2D;
  commandCount: number;
};

type SpiralBranchPathCache = Map<string, SpiralBranchPathBatch[]>;

type SpiralTaxonomyRibbonPathCache = Map<string, Path2D>;

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length - 1) * ratio)));
  return sorted[index];
}

function summarizePanBenchmark(
  label: string,
  startedAtMs: number,
  endedAtMs: number,
  samples: PanBenchmarkSample[],
  longTasksMs: number[],
  inputTimesMs: number[],
  scheduledFrameCount: number,
  coalescedScheduleCount: number,
) {
  const frameDeltas = samples
    .map((sample) => sample.frameDeltaMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const inputLatencies = samples
    .map((sample) => sample.inputLatencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const frameQueueWaits = samples
    .map((sample) => sample.frameQueueWaitMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const drawTotals = samples
    .map((sample) => sample.drawTotalMs)
    .filter((value) => Number.isFinite(value));
  const branchTimes = samples
    .map((sample) => sample.branchBaseMs)
    .filter((value) => Number.isFinite(value));
  const taxonomyTimes = samples
    .map((sample) => sample.taxonomyOverlayMs)
    .filter((value) => Number.isFinite(value));
  const durationMs = Math.max(0, endedAtMs - startedAtMs);
  const inputDeltas = inputTimesMs.slice(1).map((value, index) => value - inputTimesMs[index]);
  const jankFrames24 = frameDeltas.filter((value) => value > 24).length;
  const jankFrames33 = frameDeltas.filter((value) => value > 33.3).length;
  const jankFrames50 = frameDeltas.filter((value) => value > 50).length;
  const branchModes = Array.from(new Set(samples.map((sample) => sample.branchRenderMode).filter(Boolean)));
  return {
    label,
    startedAtMs,
    endedAtMs,
    durationMs,
    frameCount: samples.length,
    branchRenderModes: branchModes,
    fpsAvg: frameDeltas.length > 0 ? 1000 / Math.max(1e-6, average(frameDeltas) ?? 0) : null,
    frameDeltaMsAvg: average(frameDeltas),
    frameDeltaMsP95: percentile(frameDeltas, 0.95),
    frameDeltaMsP99: percentile(frameDeltas, 0.99),
    frameQueueWaitMsAvg: average(frameQueueWaits),
    frameQueueWaitMsP95: percentile(frameQueueWaits, 0.95),
    inputLatencyMsAvg: average(inputLatencies),
    inputLatencyMsP95: percentile(inputLatencies, 0.95),
    inputEventCount: inputTimesMs.length,
    inputEventDeltaMsAvg: average(inputDeltas),
    inputEventDeltaMsP95: percentile(inputDeltas, 0.95),
    scheduledFrameCount,
    coalescedScheduleCount,
    drawTotalMsAvg: average(drawTotals),
    drawTotalMsP95: percentile(drawTotals, 0.95),
    branchBaseMsAvg: average(branchTimes),
    branchBaseMsP95: percentile(branchTimes, 0.95),
    taxonomyOverlayMsAvg: average(taxonomyTimes),
    taxonomyOverlayMsP95: percentile(taxonomyTimes, 0.95),
    jankFramesOver24Ms: jankFrames24,
    jankFramesOver33Ms: jankFrames33,
    jankFramesOver50Ms: jankFrames50,
    longTaskCount: longTasksMs.length,
    longTaskMsMax: longTasksMs.length > 0 ? Math.max(...longTasksMs) : null,
    samples,
  };
}

function findSearchMatchRange(text: string, query: string): { start: number; end: number } | null {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return null;
  }
  const normalizedText = text.toLowerCase().replaceAll("_", " ");
  const normalizedQuery = query.toLowerCase().replaceAll("_", " ");
  const hasTrailingSeparator = / $/.test(normalizedQuery);
  const tokens = normalizedQuery.trim().split(/ +/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  const escapedTokens = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = hasTrailingSeparator
    ? `${escapedTokens.join(" +")}(?: +|$)`
    : escapedTokens.join(" +");
  const match = new RegExp(pattern, "i").exec(normalizedText);
  if (!match || match.index < 0) {
    return null;
  }
  return {
    start: match.index,
    end: match.index + match[0].length,
  };
}

function drawHighlightedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  align: CanvasTextAlign,
  baseColor: string,
  highlightColor: string | null,
  matchRange: { start: number; end: number } | null,
): void {
  const fullWidth = ctx.measureText(text).width;
  const baseX = align === "right"
    ? x - fullWidth
    : align === "center"
      ? x - (fullWidth * 0.5)
      : x;
  const previousAlign = ctx.textAlign;
  ctx.textAlign = "left";
  ctx.fillStyle = baseColor;
  ctx.fillText(text, baseX, y);
  if (!highlightColor || !matchRange || matchRange.end <= matchRange.start) {
    ctx.textAlign = previousAlign;
    return;
  }
  const prefixWidth = ctx.measureText(text.slice(0, matchRange.start)).width;
  const matchText = text.slice(matchRange.start, matchRange.end);
  ctx.fillStyle = highlightColor;
  ctx.fillText(matchText, baseX + prefixWidth, y);
  ctx.textAlign = previousAlign;
}

function truncateTextToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidthPx: number,
): string {
  if (ctx.measureText(text).width <= maxWidthPx) {
    return text;
  }
  const ellipsis = "...";
  if (ctx.measureText(ellipsis).width > maxWidthPx) {
    return "";
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${text.slice(0, middle)}${ellipsis}`).width <= maxWidthPx) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${text.slice(0, low).trimEnd()}${ellipsis}`;
}

function smoothstep01(value: number): number {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - (2 * clamped));
}

function detailBranchThicknessMultiplier(
  tipSpacingPx: number,
  fullTipLabelSpacingPx: number,
): number {
  if (tipSpacingPx <= fullTipLabelSpacingPx) {
    return 1;
  }
  const progress = smoothstep01(
    (tipSpacingPx - fullTipLabelSpacingPx)
    / Math.max(1e-6, DETAIL_BRANCH_THICKNESS_FULL_SPACING_PX - fullTipLabelSpacingPx),
  );
  return 1 + ((DETAIL_BRANCH_THICKNESS_MAX_MULTIPLIER - 1) * progress);
}

function pointLabelBaseFontSize(_isBootstrap: boolean, tipSpacingPx: number): number {
  return Math.max(12, Math.min(16, tipSpacingPx * 0.42));
}

function pointLabelHasScreenRoom(
  subtreeSpanPx: number,
  branchSpanPx: number,
  fontSize: number,
  labelWidthPx: number,
): boolean {
  return (
    subtreeSpanPx >= fontSize * 1.35
    || branchSpanPx >= Math.min(labelWidthPx + 8, fontSize * 4.5)
  );
}

function formatLabelDecimals(value: number, decimalPlaces: number | undefined, automatic: () => string): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (typeof decimalPlaces !== "number" || decimalPlaces < 0) {
    return automatic();
  }
  return value.toFixed(Math.max(0, Math.min(6, Math.round(decimalPlaces))));
}

function polarPointLabelRotation(
  renderedTheta: number,
  onRightSide: boolean,
  orientation: "tangential" | "radial",
): number {
  const degrees = renderedTheta * 180 / Math.PI;
  const orientationOffset = orientation === "tangential"
    ? (onRightSide ? 90 : 270)
    : (onRightSide ? 0 : 180);
  return normalizeRotation(degrees + orientationOffset) * Math.PI / 180;
}

function interpolateTipBandWidthPx(
  zoom: number,
  preRampStart: number,
  microStart: number,
  readableStart: number,
  microWidthPx: number,
  readableWidthPx: number,
): number {
  if (zoom <= preRampStart) {
    return 0;
  }
  if (zoom < microStart) {
    const progress = clamp01((zoom - preRampStart) / Math.max(1e-6, microStart - preRampStart));
    return microWidthPx * progress * progress;
  }
  if (zoom < readableStart) {
    const progress = smoothstep01((zoom - microStart) / Math.max(1e-6, readableStart - microStart));
    return microWidthPx + ((readableWidthPx - microWidthPx) * progress);
  }
  return readableWidthPx;
}

function quantizedSegmentKey(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bucket = 1.5,
): string {
  return [
    Math.round(x1 / bucket),
    Math.round(y1 / bucket),
    Math.round(x2 / bucket),
    Math.round(y2 / bucket),
  ].join(":");
}

function lowerBoundLeaves(
  orderedLeaves: number[],
  center: Float64Array,
  target: number,
): number {
  let low = 0;
  let high = orderedLeaves.length;
  while (low < high) {
    const mid = Math.floor((low + high) * 0.5);
    if (center[orderedLeaves[mid]] < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function computeVisibleCircularAngleSpans(
  centerX: number,
  centerY: number,
  radiusPx: number,
  width: number,
  height: number,
  marginPx: number,
): Array<{ start: number; end: number }> {
  if (!(radiusPx > 0)) {
    return [];
  }
  const left = -marginPx;
  const right = width + marginPx;
  const top = -marginPx;
  const bottom = height + marginPx;
  const tau = Math.PI * 2;
  const epsilon = 1e-7;
  const isVisibleAngle = (angle: number): boolean => {
    const x = centerX + (Math.cos(angle) * radiusPx);
    const y = centerY + (Math.sin(angle) * radiusPx);
    return x >= left && x <= right && y >= top && y <= bottom;
  };
  const angles: number[] = [];
  const pushAngle = (angle: number): void => {
    const wrapped = wrapPositive(angle);
    for (let index = 0; index < angles.length; index += 1) {
      const delta = Math.abs(angles[index] - wrapped);
      if (delta <= epsilon || Math.abs(delta - tau) <= epsilon) {
        return;
      }
    }
    angles.push(wrapped);
  };

  const cardinalAngles = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
  for (let index = 0; index < cardinalAngles.length; index += 1) {
    if (isVisibleAngle(cardinalAngles[index])) {
      pushAngle(cardinalAngles[index]);
    }
  }

  const verticalEdges = [left, right];
  for (let edgeIndex = 0; edgeIndex < verticalEdges.length; edgeIndex += 1) {
    const normalizedX = (verticalEdges[edgeIndex] - centerX) / radiusPx;
    if (Math.abs(normalizedX) > 1 + epsilon) {
      continue;
    }
    const clampedX = Math.max(-1, Math.min(1, normalizedX));
    const offsetY = Math.sqrt(Math.max(0, 1 - (clampedX * clampedX))) * radiusPx;
    const y1 = centerY + offsetY;
    const y2 = centerY - offsetY;
    if (y1 >= top - epsilon && y1 <= bottom + epsilon) {
      pushAngle(Math.atan2(y1 - centerY, verticalEdges[edgeIndex] - centerX));
    }
    if (y2 >= top - epsilon && y2 <= bottom + epsilon) {
      pushAngle(Math.atan2(y2 - centerY, verticalEdges[edgeIndex] - centerX));
    }
  }

  const horizontalEdges = [top, bottom];
  for (let edgeIndex = 0; edgeIndex < horizontalEdges.length; edgeIndex += 1) {
    const normalizedY = (horizontalEdges[edgeIndex] - centerY) / radiusPx;
    if (Math.abs(normalizedY) > 1 + epsilon) {
      continue;
    }
    const clampedY = Math.max(-1, Math.min(1, normalizedY));
    const offsetX = Math.sqrt(Math.max(0, 1 - (clampedY * clampedY))) * radiusPx;
    const x1 = centerX + offsetX;
    const x2 = centerX - offsetX;
    if (x1 >= left - epsilon && x1 <= right + epsilon) {
      pushAngle(Math.atan2(horizontalEdges[edgeIndex] - centerY, x1 - centerX));
    }
    if (x2 >= left - epsilon && x2 <= right + epsilon) {
      pushAngle(Math.atan2(horizontalEdges[edgeIndex] - centerY, x2 - centerX));
    }
  }

  if (angles.length === 0) {
    return isVisibleAngle(0) ? [{ start: 0, end: tau }] : [];
  }

  angles.sort((leftAngle, rightAngle) => leftAngle - rightAngle);
  const spans: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < angles.length; index += 1) {
    const start = angles[index];
    const end = index === angles.length - 1 ? angles[0] + tau : angles[index + 1];
    if ((end - start) <= epsilon) {
      continue;
    }
    const mid = start + ((end - start) * 0.5);
    if (isVisibleAngle(mid)) {
      spans.push({ start, end });
    }
  }
  if (spans.length === 0) {
    return isVisibleAngle(0) ? [{ start: 0, end: tau }] : [];
  }
  return spans;
}

function visibleViewportRadialOverlapForAngle(
  centerX: number,
  centerY: number,
  angle: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
  innerRadiusPx: number,
  outerRadiusPx: number,
): { startRadiusPx: number; endRadiusPx: number } | null {
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const epsilon = 1e-9;
  let rayStart = 0;
  let rayEnd = Number.POSITIVE_INFINITY;
  if (Math.abs(dirX) <= epsilon) {
    if (centerX < left || centerX > right) {
      return null;
    }
  } else {
    const tx1 = (left - centerX) / dirX;
    const tx2 = (right - centerX) / dirX;
    rayStart = Math.max(rayStart, Math.min(tx1, tx2));
    rayEnd = Math.min(rayEnd, Math.max(tx1, tx2));
  }
  if (Math.abs(dirY) <= epsilon) {
    if (centerY < top || centerY > bottom) {
      return null;
    }
  } else {
    const ty1 = (top - centerY) / dirY;
    const ty2 = (bottom - centerY) / dirY;
    rayStart = Math.max(rayStart, Math.min(ty1, ty2));
    rayEnd = Math.min(rayEnd, Math.max(ty1, ty2));
  }
  if (rayEnd < Math.max(rayStart, 0)) {
    return null;
  }
  const overlapStart = Math.max(innerRadiusPx, Math.max(rayStart, 0));
  const overlapEnd = Math.min(outerRadiusPx, rayEnd);
  return overlapEnd > overlapStart
    ? { startRadiusPx: overlapStart, endRadiusPx: overlapEnd }
    : null;
}

function computeVisibleCircularBandSpans(
  centerX: number,
  centerY: number,
  innerRadiusPx: number,
  outerRadiusPx: number,
  width: number,
  height: number,
  marginPx: number,
): Array<{ start: number; end: number }> {
  if (!(outerRadiusPx > 0) || !(outerRadiusPx > innerRadiusPx)) {
    return [];
  }
  const left = -marginPx;
  const right = width + marginPx;
  const top = -marginPx;
  const bottom = height + marginPx;
  const tau = Math.PI * 2;
  const sampleCount = Math.max(256, Math.min(2048, Math.ceil((tau * outerRadiusPx) / 48)));
  const stepTheta = tau / sampleCount;
  const visibleSamples = new Array<boolean>(sampleCount).fill(false);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const theta = sampleIndex * stepTheta;
    if (visibleViewportRadialOverlapForAngle(centerX, centerY, theta, left, right, top, bottom, innerRadiusPx, outerRadiusPx)) {
      visibleSamples[sampleIndex] = true;
    }
  }
  if (!visibleSamples.includes(true)) {
    return [];
  }
  if (visibleSamples.every(Boolean)) {
    return [{ start: 0, end: tau }];
  }
  const epsilon = 1e-9;
  const spans: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const visible = visibleSamples[sampleIndex];
    if (visible && runStart < 0) {
      runStart = sampleIndex;
    }
    const closesRun = !visible && runStart >= 0;
    const reachesEnd = visible && sampleIndex === sampleCount - 1 && runStart >= 0;
    if (closesRun || reachesEnd) {
      const runEndIndex = closesRun ? sampleIndex : sampleIndex + 1;
      spans.push({
        start: runStart * stepTheta,
        end: runEndIndex * stepTheta,
      });
      runStart = -1;
    }
  }
  if (spans.length > 1 && spans[0].start <= epsilon && spans[spans.length - 1].end >= tau - epsilon) {
    spans[0] = {
      start: spans[spans.length - 1].start - tau,
      end: spans[0].end,
    };
    spans.pop();
  }
  return spans;
}

function sampleVisibleCircularBandPolygonPoints(
  centerX: number,
  centerY: number,
  innerRadiusPx: number,
  outerRadiusPx: number,
  startTheta: number,
  endTheta: number,
  width: number,
  height: number,
  marginPx: number,
): Array<{ x: number; y: number }> {
  const left = -marginPx;
  const right = width + marginPx;
  const top = -marginPx;
  const bottom = height + marginPx;
  const spanTheta = Math.max(0, endTheta - startTheta);
  const approxSpanPx = spanTheta * outerRadiusPx;
  const sampleCount = Math.max(8, Math.min(96, Math.ceil(approxSpanPx / 20)));
  const outerPoints: Array<{ x: number; y: number }> = [];
  const innerPoints: Array<{ x: number; y: number }> = [];
  for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
    const theta = startTheta + ((spanTheta * sampleIndex) / sampleCount);
    const overlap = visibleViewportRadialOverlapForAngle(
      centerX,
      centerY,
      theta,
      left,
      right,
      top,
      bottom,
      innerRadiusPx,
      outerRadiusPx,
    );
    if (!overlap) {
      continue;
    }
    outerPoints.push({
      x: centerX + (Math.cos(theta) * overlap.endRadiusPx),
      y: centerY + (Math.sin(theta) * overlap.endRadiusPx),
    });
    innerPoints.push({
      x: centerX + (Math.cos(theta) * overlap.startRadiusPx),
      y: centerY + (Math.sin(theta) * overlap.startRadiusPx),
    });
  }
  return outerPoints.length >= 2 && innerPoints.length >= 2
    ? [...outerPoints, ...innerPoints.reverse()]
    : [];
}

function sampleVisibleScreenSpaceCircularRibbonRuns(
  centerX: number,
  centerY: number,
  innerRadiusPx: number,
  outerRadiusPx: number,
  startTheta: number,
  endTheta: number,
  width: number,
  height: number,
  marginPx: number,
): Array<{ startTheta: number; endTheta: number; screenPolygonPoints: Array<{ x: number; y: number }> }> {
  const spanTheta = Math.max(0, endTheta - startTheta);
  if (!(spanTheta > 0) || !(outerRadiusPx > innerRadiusPx)) {
    return [];
  }
  const left = -marginPx;
  const right = width + marginPx;
  const top = -marginPx;
  const bottom = height + marginPx;
  const rectWidth = right - left;
  const rectHeight = bottom - top;
  const pointVisible = (point: { x: number; y: number }): boolean => (
    point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
  );
  const sliceVisible = (
    outerStart: { x: number; y: number },
    outerEnd: { x: number; y: number },
    innerStart: { x: number; y: number },
    innerEnd: { x: number; y: number },
  ): boolean => {
    if (
      pointVisible(outerStart)
      || pointVisible(outerEnd)
      || pointVisible(innerStart)
      || pointVisible(innerEnd)
    ) {
      return true;
    }
    return lineIntersectsRect(outerStart.x, outerStart.y, outerEnd.x, outerEnd.y, left, top, rectWidth, rectHeight)
      || lineIntersectsRect(innerStart.x, innerStart.y, innerEnd.x, innerEnd.y, left, top, rectWidth, rectHeight)
      || lineIntersectsRect(outerStart.x, outerStart.y, innerStart.x, innerStart.y, left, top, rectWidth, rectHeight)
      || lineIntersectsRect(outerEnd.x, outerEnd.y, innerEnd.x, innerEnd.y, left, top, rectWidth, rectHeight);
  };

  const avgRadiusPx = (innerRadiusPx + outerRadiusPx) * 0.5;
  const approxSpanPx = spanTheta * avgRadiusPx;
  const maxSagittaPx = 0.2;
  const maxThetaStepFromCurvature = outerRadiusPx > 0
    ? Math.max(
      1e-4,
      2 * Math.acos(Math.max(-1, Math.min(1, 1 - (maxSagittaPx / outerRadiusPx)))),
    )
    : Math.PI / 8;
  const sampleCount = Math.max(
    16,
    Math.min(
      2048,
      Math.max(
        Math.ceil(approxSpanPx / 24),
        Math.ceil(spanTheta / maxThetaStepFromCurvature),
      ),
    ),
  );
  const thetas: number[] = [];
  const outerPoints: Array<{ x: number; y: number }> = [];
  const innerPoints: Array<{ x: number; y: number }> = [];
  for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
    const theta = startTheta + ((spanTheta * sampleIndex) / sampleCount);
    thetas.push(theta);
    outerPoints.push({
      x: centerX + (Math.cos(theta) * outerRadiusPx),
      y: centerY + (Math.sin(theta) * outerRadiusPx),
    });
    innerPoints.push({
      x: centerX + (Math.cos(theta) * innerRadiusPx),
      y: centerY + (Math.sin(theta) * innerRadiusPx),
    });
  }

  const runs: Array<{ startTheta: number; endTheta: number; screenPolygonPoints: Array<{ x: number; y: number }> }> = [];
  let runStartIndex = -1;
  for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex += 1) {
    const visible = sliceVisible(
      outerPoints[sampleIndex - 1],
      outerPoints[sampleIndex],
      innerPoints[sampleIndex - 1],
      innerPoints[sampleIndex],
    );
    if (visible && runStartIndex < 0) {
      runStartIndex = sampleIndex - 1;
    }
    const closesRun = !visible && runStartIndex >= 0;
    const reachesEnd = visible && sampleIndex === sampleCount && runStartIndex >= 0;
    if (!closesRun && !reachesEnd) {
      continue;
    }
    const runEndIndex = sampleIndex;
    const visibleOuterPoints = outerPoints.slice(runStartIndex, runEndIndex + 1);
    const visibleInnerPoints = innerPoints.slice(runStartIndex, runEndIndex + 1);
    if (visibleOuterPoints.length >= 2 && visibleInnerPoints.length >= 2) {
      runs.push({
        startTheta: thetas[runStartIndex],
        endTheta: thetas[runEndIndex],
        screenPolygonPoints: [...visibleOuterPoints, ...visibleInnerPoints.reverse()],
      });
    }
    runStartIndex = -1;
  }

  return runs;
}

function circularSpansToLeafRanges(
  spans: Array<{ start: number; end: number }>,
  rotationAngle: number,
  orderedLeaves: number[],
  center: Float64Array,
  leafCount: number,
  overscanLeaves: number,
  angleStart = 0,
  angleSpan = Math.PI * 2,
): Array<{ startIndex: number; endIndex: number }> {
  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  const tau = Math.PI * 2;
  const pushRange = (thetaStart: number, thetaEnd: number): void => {
    const divisor = Math.abs(angleSpan - tau) < 1e-9 ? leafCount : Math.max(1, leafCount - 1);
    const startCenter = ((thetaStart - angleStart) / angleSpan) * divisor;
    const endCenter = ((thetaEnd - angleStart) / angleSpan) * divisor;
    const startIndex = Math.max(0, lowerBoundLeaves(orderedLeaves, center, startCenter) - overscanLeaves);
    const endIndex = Math.min(orderedLeaves.length, lowerBoundLeaves(orderedLeaves, center, endCenter) + 1 + overscanLeaves);
    if (endIndex > startIndex) {
      ranges.push({ startIndex, endIndex });
    }
  };
  if (angleSpan < tau - 1e-9) {
    const domainStart = angleStart;
    const domainEnd = angleStart + angleSpan;
    for (let index = 0; index < spans.length; index += 1) {
      const rawStart = spans[index].start - rotationAngle;
      const rawEnd = spans[index].end - rotationAngle;
      for (let shift = -2; shift <= 2; shift += 1) {
        const shiftedStart = rawStart + (shift * tau);
        const shiftedEnd = rawEnd + (shift * tau);
        const intersectionStart = Math.max(domainStart, shiftedStart);
        const intersectionEnd = Math.min(domainEnd, shiftedEnd);
        if (intersectionEnd > intersectionStart) {
          pushRange(intersectionStart, intersectionEnd);
        }
      }
    }
  } else {
  for (let index = 0; index < spans.length; index += 1) {
    const thetaStart = wrapPositive(spans[index].start - rotationAngle);
    const thetaEnd = wrapPositive(spans[index].end - rotationAngle);
    if (spans[index].end - spans[index].start >= tau - 1e-6) {
      ranges.push({ startIndex: 0, endIndex: orderedLeaves.length });
      continue;
    }
    if (thetaEnd < thetaStart) {
      pushRange(thetaStart, tau);
      pushRange(0, thetaEnd);
    } else {
      pushRange(thetaStart, thetaEnd);
    }
  }
  }
  if (ranges.length <= 1) {
    return ranges;
  }
  ranges.sort((left, right) => left.startIndex - right.startIndex);
  const merged: Array<{ startIndex: number; endIndex: number }> = [ranges[0]];
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = merged[merged.length - 1];
    const current = ranges[index];
    if (current.startIndex <= previous.endIndex) {
      previous.endIndex = Math.max(previous.endIndex, current.endIndex);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function measureSubtreeMaxDepth(tree: TreeModel, node: number): number {
  let maxDepth = tree.buffers.depth[node];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const depth = tree.buffers.depth[current];
    if (depth > maxDepth) {
      maxDepth = depth;
    }
    for (let child = tree.buffers.firstChild[current]; child >= 0; child = tree.buffers.nextSibling[child]) {
      stack.push(child);
    }
  }
  return maxDepth;
}

function isTerminalRectConnector(tree: TreeModel, node: number): boolean {
  const firstChild = tree.buffers.firstChild[node];
  if (firstChild < 0) {
    return false;
  }
  const tolerance = Math.max(1e-9, Math.abs(tree.maxDepth) * 1e-10);
  let childCount = 0;
  for (let child = firstChild; child >= 0; child = tree.buffers.nextSibling[child]) {
    if (
      tree.buffers.firstChild[child] >= 0
      || Math.abs(tree.buffers.depth[child] - tree.buffers.depth[node]) > tolerance
    ) {
      return false;
    }
    childCount += 1;
  }
  return childCount >= 2;
}

function expandedMinimizedTriangleBase(
  apex: { x: number; y: number },
  baseStart: { x: number; y: number },
  baseEnd: { x: number; y: number },
  viewportHeight: number,
): [{ x: number; y: number }, { x: number; y: number }] {
  const minimumLength = Math.max(
    MINIMIZED_TRIANGLE_MIN_PX,
    viewportHeight * MINIMIZED_TRIANGLE_MIN_VIEWPORT_FRACTION,
  );
  const dx = baseEnd.x - baseStart.x;
  const dy = baseEnd.y - baseStart.y;
  const currentLength = Math.hypot(dx, dy);
  if (currentLength >= minimumLength) {
    return [baseStart, baseEnd];
  }
  const midpoint = {
    x: (baseStart.x + baseEnd.x) * 0.5,
    y: (baseStart.y + baseEnd.y) * 0.5,
  };
  let unitX = 0;
  let unitY = 1;
  if (currentLength > 1e-6) {
    unitX = dx / currentLength;
    unitY = dy / currentLength;
  } else {
    const radialX = midpoint.x - apex.x;
    const radialY = midpoint.y - apex.y;
    const radialLength = Math.hypot(radialX, radialY);
    if (radialLength > 1e-6) {
      unitX = -radialY / radialLength;
      unitY = radialX / radialLength;
    }
  }
  const halfLength = minimumLength * 0.5;
  return [
    {
      x: midpoint.x - (unitX * halfLength),
      y: midpoint.y - (unitY * halfLength),
    },
    {
      x: midpoint.x + (unitX * halfLength),
      y: midpoint.y + (unitY * halfLength),
    },
  ];
}

export default function TreeCanvas({
  treeRef,
  order,
  viewMode,
  zoomAxisMode,
  circularRotation,
  radialAngularSpanDegrees,
  radialCenterOpeningRatio,
  spiralTurns,
  showTimeStripes,
  timeStripeStyle,
  timeStripeLineWeight,
  showScaleBars,
  timeAxisScale,
  timeAxisLogBase,
  scaleTickInterval,
  showIntermediateScaleTicks,
  extendRectScaleToTick,
  showScaleZeroTick,
  circularCenterScaleAngleDegrees,
  useAutoCircularCenterScaleAngle,
  showCircularCenterRadialScaleBar,
  showTipLabels,
  alignTipLabels,
  showGenusLabels,
  taxonomyEnabled,
  taxonomyOverlayStyle,
  taxonomyBranchColoringEnabled,
  taxonomyColorJitter,
  taxonomyColorPalette,
  taxonomyCustomPaletteColors,
  taxonomyColorRootRank,
  taxonomyColorJitterRank,
  taxonomyRankDisplayModes,
  useAutomaticTaxonomyRankVisibility,
  taxonomyRankVisibility,
  taxonomyCollapseRank,
  taxonomyMapRef,
  taxonomyColorSourceMapRef,
  phylopicEnabled,
  phylopicSilhouettes,
  phylopicPlacement,
  phylopicSizeScale,
  phylopicOffsetXPx,
  phylopicOffsetYPx,
  onPhyloPicRemoveSilhouette,
  onPhyloPicTryAnotherSilhouette,
  hideDownloadNewick = false,
  sharedSubtreeSourceTreeRef,
  sharedSubtreeSourceTaxonomyMapRef,
  sharedSubtreeSourceNodeByViewNode,
  metadataBranchColors,
  metadataBranchColorVersion,
  metadataLabels,
  metadataLabelVersion,
  metadataMarkers,
  metadataMarkerVersion,
  metadataPies,
  metadataPieVersion,
  metadataPieSizePx,
  metadataTipTableData,
  metadataTipTableMode,
  metadataTipTableCellStyle,
  metadataTipTablePalette,
  metadataTipTableBarWidthPx,
  metadataTipTableCellWidthPx,
  metadataMarkerSizePx,
  metadataLabelMaxCount,
  metadataLabelMinSpacingPx,
  metadataLabelOffsetXPx,
  metadataLabelOffsetYPx,
  showInternalNodeLabels,
  showBootstrapLabels,
  figureStyles,
  branchThicknessScale,
  showNodeHeightLabels,
  showNodeErrorBars,
  errorBarStyle,
  errorBarColor,
  errorBarOpacity,
  errorBarShowNodeDot,
  errorBarThicknessPx,
  errorBarCapSizePx,
  searchQuery,
  searchMatches,
  activeSearchNode,
  activeSearchGenusCenterNode,
  activeSearchTaxonomyNode,
  activeSearchTaxonomyKey,
  focusNodeRequest,
  fitRequest,
  exportSvgRequest,
  exportSvgFilename,
  exportPngRequest,
  exportPngFilename,
  exportPngWidth,
  exportPngHeight,
  automationExportRequest,
  sessionStateRequest,
  sessionRestoreRequest,
  sessionRestoreState,
  visualResetRequest,
  tutorialBranchMenuDemoActive = false,
  onHoverChange,
  onTaxonomyColorsChange,
  onSubtreeStatisticsRequest,
  onRerootRequest,
  onViewModeChange,
  onSessionStateSnapshot,
  onSessionRestoreComplete,
  onAutomationExportComplete,
}: TreeCanvasProps) {
  const tree = treeRef.current;
  const taxonomyMap = taxonomyMapRef.current;
  const taxonomyColorSourceMap = taxonomyColorSourceMapRef.current;
  const sharedSubtreeSourceTree = sharedSubtreeSourceTreeRef.current;
  const sharedSubtreeSourceTaxonomyMap = sharedSubtreeSourceTaxonomyMapRef.current;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderCanvasOverrideRef = useRef<HTMLCanvasElement | null>(null);
  const renderSizeOverrideRef = useRef<{ width: number; height: number } | null>(null);
  const renderDprOverrideRef = useRef<number | null>(null);
  const renderCameraOverrideRef = useRef<CameraState | null>(null);
  const cameraRef = useRef<CameraState | null>(null);
  const previousViewModeRef = useRef<ViewMode>(viewMode);
  const frameRequestRef = useRef<number | null>(null);
  const latestDrawRef = useRef<() => void>(() => {});
  const exportCaptureRef = useRef<SvgScene | null>(null);
  const pendingRectSubtreeZoomTargetRef = useRef<number | null>(null);
  const hoverRef = useRef<CanvasHoverInfo | null>(null);
  const hoverProbeRef = useRef<((localX: number, localY: number) => CanvasHoverInfo | null) | null>(null);
  const hoverTooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverTooltipLabelRef = useRef<HTMLDivElement | null>(null);
  const hoverTooltipBodyRef = useRef<HTMLDivElement | null>(null);
  const distanceTooltipRef = useRef<HTMLDivElement | null>(null);
  const distanceTooltipNodesRef = useRef<HTMLDivElement | null>(null);
  const distanceTooltipValueRef = useRef<HTMLDivElement | null>(null);
  const distanceTooltipMrcaRef = useRef<HTMLDivElement | null>(null);
  const distanceStartNodeRef = useRef<number | null>(null);
  const distanceStartAncestorsRef = useRef<Set<number>>(new Set());
  const distanceMeasurementRef = useRef<DistanceMeasurement | null>(null);
  const labelHitsRef = useRef<LabelHitbox[]>([]);
  const collapsedTriangleHitsRef = useRef<CollapsedTriangleHitbox[]>([]);
  const phylopicHitsRef = useRef<PhyloPicHitbox[]>([]);
  const taxonomyArcHitsRef = useRef<TaxonomyArcHitbox[]>([]);
  const phylopicImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [phylopicImageLoadVersion, setPhyloPicImageLoadVersion] = useState(0);
  const renderDebugRef = useRef<Record<string, unknown> | null>(null);
  const taxonomyBlocksByOrderCacheRef = useRef<Partial<TaxonomyBlocksByOrder>>({});
  const taxonomyBlocksCacheKeyRef = useRef<{
    cache: RenderCache | null;
    taxonomyMap: TaxonomyMapPayload | null;
    taxonomyColors: TaxonomyColorByRank | null;
  } | null>(null);
  const taxonomyBranchColorsCacheRef = useRef<Map<string, string[]>>(new Map());
  const effectiveBranchColorsCacheRef = useRef<Map<string, string[]>>(new Map());
  const circularTaxonomyPathCacheRef = useRef<Map<string, CircularTaxonomyPathCache>>(new Map());
  const rectTaxonomyPathCacheRef = useRef<Map<string, RectTaxonomyPathCache>>(new Map());
  const spiralBranchPathCacheRef = useRef<Map<string, SpiralBranchPathCache>>(new Map());
  const spiralTaxonomyRibbonPathCacheRef = useRef<Map<string, SpiralTaxonomyRibbonPathCache>>(new Map());
  const circularBasePathCacheRef = useRef<Map<string, CircularBranchPathCache>>(new Map());
  const rectBasePathCacheRef = useRef<Map<string, RectBranchPathCache>>(new Map());
  const circularTaxonomyBitmapCacheRef = useRef<CircularTaxonomyBitmapCache | null>(null);
  const rectTaxonomyBitmapCacheRef = useRef<RectTaxonomyBitmapCache | null>(null);
  const circularTaxonomyOverlayLayoutCacheRef = useRef<CircularTaxonomyOverlayLayoutCache | null>(null);
  const rotationPreviewRef = useRef<RotationPreviewCache | null>(null);
  const rotationPreviewCommitTimerRef = useRef<number | null>(null);
  const canvasBackingStoreRef = useRef<{ width: number; height: number; dpr: number } | null>(null);
  const hoverCanvasBackingStoreRef = useRef<{ width: number; height: number; dpr: number } | null>(null);
  const detailedRenderDebugEnabledRef = useRef(
    typeof navigator !== "undefined" ? Boolean(navigator.webdriver) : false,
  );
  const panBenchmarkRef = useRef<{
    label: string;
    startedAtMs: number;
    lastFrameAtMs: number | null;
    lastInputAtMs: number | null;
    scheduledFrameAtMs: number | null;
    scheduledFrameCount: number;
    coalescedScheduleCount: number;
    inputTimesMs: number[];
    samples: PanBenchmarkSample[];
    longTasksMs: number[];
    observer: PerformanceObserver | null;
  } | null>(null);
  const handledFocusRequestRef = useRef(0);
  const handledExportRequestRef = useRef(0);
  const handledPngExportRequestRef = useRef(0);
  const handledAutomationExportRequestRef = useRef(0);
  const handledSessionStateRequestRef = useRef(sessionStateRequest);
  const handledSessionRestoreRequestRef = useRef<number | null>(null);
  const activePointersRef = useRef(new Map<number, { clientX: number; clientY: number }>());
  const pinchGestureRef = useRef<{ distance: number; centerX: number; centerY: number } | null>(null);
  const pendingCollapsedRectZoomAnchorRef = useRef<{
    node: number;
    screenY: number;
  } | null>(null);
  const macGestureScaleRef = useRef<number | null>(null);
  const pointerDownRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const lastCanvasPointerRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const genusLabelHistoryRef = useRef<{
    tree: TreeModel | null;
    viewMode: ViewMode;
    order: LayoutOrder;
    zoom: number;
    visibleCenters: number[];
    peakZoom: number;
    peakVisibleCenters: number[];
  } | null>(null);
  const taxonomyLabelHistoryRef = useRef<{
    tree: TreeModel | null;
    viewMode: ViewMode;
    order: LayoutOrder;
    zoom: number;
    visibleKeys: string[];
    labelThetas?: Array<{ key: string; theta: number }>;
    peakZoom: number;
    peakVisibleKeys: string[];
  } | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const previousSizeRef = useRef(size);
  const previousTreeRef = useRef<TreeModel | null>(tree);
  const previousFitRequestRef = useRef(fitRequest);
  const pendingCircularTaxonomyRefitRef = useRef(false);
  const [collapsedNodeModes, setCollapsedNodeModes] = useState<Map<number, CollapsedNodeMode>>(() => new Map());
  const collapsedNodes = useMemo(() => new Set(collapsedNodeModes.keys()), [collapsedNodeModes]);
  const [collapsedLayoutRevision, setCollapsedLayoutRevision] = useState(0);
  const [manualBranchColorAssignments, setManualBranchColorAssignments] = useState<Map<number, string>>(() => new Map());
  const [manualSubtreeColorAssignments, setManualSubtreeColorAssignments] = useState<Map<number, string>>(() => new Map());
  const [taxonomyRootColorAssignments, setTaxonomyRootColorAssignments] = useState<Map<string, string>>(() => new Map());
  const [contextMenuColorMode, setContextMenuColorMode] = useState<"branch" | "subtree" | "taxonomy-root" | null>(null);
  const [contextMenuRootMenuOpen, setContextMenuRootMenuOpen] = useState(false);
  const [contextMenuCollapseMenuOpen, setContextMenuCollapseMenuOpen] = useState(false);
  const [contextMenuCustomColor, setContextMenuCustomColor] = useState("#2563eb");
  const nativeColorPickerActiveRef = useRef(false);
  const hiddenNodesRef = useRef<Uint8Array | null>(null);
  useLayoutEffect(() => {
    if (viewMode === "rectangular") {
      return;
    }
    setCollapsedNodeModes((current) => {
      let changed = false;
      const next = new Map(current);
      next.forEach((mode, node) => {
        if (mode === "preserve-width") {
          next.set(node, "minimize");
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [viewMode]);
  const [contextMenu, setContextMenu] = useState<(
    {
      kind: "node";
      x: number;
      y: number;
      node: number;
      name: string;
      descendantTipCount: number;
      tutorialDemo?: boolean;
    }
    | {
      kind: "taxonomy";
      x: number;
      y: number;
      name: string;
      rank: TaxonomyRank;
      firstNode: number;
      lastNode: number;
      descendantTipCount: number;
      taxId: number | null;
      startIndex?: number;
      endIndex?: number;
      collapseNode?: number;
      tutorialDemo?: boolean;
    }
    | {
      kind: "phylopic";
      x: number;
      y: number;
      name: string;
      rank: TaxonomyRank;
      firstNode?: number;
      lastNode?: number;
      descendantTipCount: number;
      taxId: number | null;
      silhouette: PhyloPicSilhouette;
      tutorialDemo?: boolean;
    }
  ) | null>(null);

  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    const shell = wrapperRef.current;
    if (!contextMenu || !menu || !shell) {
      return;
    }
    const edgePadding = 8;
    const availableWidth = shell.clientWidth;
    const availableHeight = shell.clientHeight;
    const nextX = Math.max(
      edgePadding,
      Math.min(contextMenu.x, Math.max(edgePadding, availableWidth - menu.offsetWidth - edgePadding)),
    );
    const nextY = Math.max(
      edgePadding,
      Math.min(contextMenu.y, Math.max(edgePadding, availableHeight - menu.offsetHeight - edgePadding)),
    );
    if (nextX === contextMenu.x && nextY === contextMenu.y) {
      return;
    }
    setContextMenu((current) => current ? { ...current, x: nextX, y: nextY } : current);
  }, [contextMenu, contextMenuCollapseMenuOpen, contextMenuColorMode, contextMenuRootMenuOpen, size.height, size.width]);

  const isBranchHoverEnabled = useCallback((camera: CameraState): boolean => {
    if (!tree) {
      return false;
    }
    if (tree.leafCount > HUGE_TREE_TIP_LIMIT) {
      return false;
    }
    if (camera.kind === "rect") {
      return camera.scaleY > RECT_BRANCH_HOVER_MIN_SCALE_Y;
    }
    const minDepth = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
    const angularSpacingPx = camera.scale * minDepth * ((Math.PI * 2) / Math.max(1, tree.leafCount));
    return angularSpacingPx > CIRCULAR_BRANCH_HOVER_MIN_ANGULAR_SPACING_PX;
  }, [tree]);

  const updateHoverTooltip = useCallback((hover: HoverInfo | null): void => {
    const tooltip = hoverTooltipRef.current;
    const label = hoverTooltipLabelRef.current;
    const body = hoverTooltipBodyRef.current;
    if (!tooltip || !label || !body) {
      return;
    }
    if (!hover) {
      body.replaceChildren();
      tooltip.hidden = true;
      return;
    }
    const appendLine = (text: string): void => {
      const line = document.createElement("div");
      line.textContent = text;
      body.appendChild(line);
    };
    label.textContent = hover.name;
    body.replaceChildren();
    if (hover.kind === "taxonomy") {
      appendLine(`Rank: ${hover.taxonomyRank ?? "n/a"}`);
      appendLine(`Descendant tips: ${hover.descendantTipCount.toLocaleString()}`);
      appendLine(
        `MRCA age: ${hover.mrcaAge === null || hover.mrcaAge === undefined ? "n/a" : hover.mrcaAge.toPrecision(5)}`,
      );
    } else {
      if (hover.collapsedTaxonomyRank) {
        appendLine(`Rank: ${hover.collapsedTaxonomyRank}`);
        appendLine(`Descendant tips: ${(hover.collapsedTaxonomyDescendantTipCount ?? 0).toLocaleString()}`);
        appendLine(
          `MRCA age: ${hover.collapsedTaxonomyMrcaAge === null || hover.collapsedTaxonomyMrcaAge === undefined ? "n/a" : hover.collapsedTaxonomyMrcaAge.toPrecision(5)}`,
        );
      }
      if (tree && tree.buffers.firstChild[hover.node] >= 0) {
        appendLine(`Descendant tips: ${hover.descendantTipCount.toLocaleString()}`);
      }
      appendLine(`Branch length: ${hover.branchLength.toPrecision(5)}`);
      appendLine(`Parent age: ${hover.parentAge === null ? "n/a" : hover.parentAge.toPrecision(5)}`);
      appendLine(`Child age: ${hover.childAge === null ? "n/a" : hover.childAge.toPrecision(5)}`);
    }
    tooltip.style.left = `${Math.min(size.width - 220, hover.screenX + 16)}px`;
    tooltip.style.top = `${Math.min(size.height - 90, hover.screenY + 16)}px`;
    tooltip.hidden = false;
  }, [size.height, size.width, tree]);

  const effectiveTimeAxisScale: TimeAxisScale = viewMode === "spiral" ? "log" : timeAxisScale;
  const effectiveTimeAxisLogBase = viewMode === "spiral"
    ? timeAxisLogBase * SPIRAL_TIME_AXIS_LOG_BASE_MULTIPLIER
    : timeAxisLogBase;
  const configuredRadialSpanDegrees = viewMode === "fan"
    ? 180
    : Math.max(30, Math.min(360, radialAngularSpanDegrees));
  const polarAngleSpan = viewMode === "spiral"
    ? Math.PI * 2
    : (configuredRadialSpanDegrees * Math.PI) / 180;
  const polarAngleStart = viewMode === "spiral" ? 0 : (Math.PI * 2) - polarAngleSpan;
  const isPartialRadial = polarAngleSpan < (Math.PI * 2) - 1e-9;
  const polarLeafDivisor = Math.max(1, isPartialRadial ? (tree?.leafCount ?? 1) - 1 : tree?.leafCount ?? 1);
  const polarDomainForMode = useCallback((mode: ViewMode): PolarViewDomain => {
    if (mode === "fan") {
      return { start: Math.PI, span: Math.PI, leafDivisor: Math.max(1, (tree?.leafCount ?? 1) - 1) };
    }
    if (mode === "circular") {
      const span = (Math.max(30, Math.min(360, radialAngularSpanDegrees)) * Math.PI) / 180;
      return {
        start: (Math.PI * 2) - span,
        span,
        leafDivisor: Math.max(1, span < (Math.PI * 2) - 1e-9 ? (tree?.leafCount ?? 1) - 1 : tree?.leafCount ?? 1),
      };
    }
    return polarViewDomain(mode, tree?.leafCount ?? 1);
  }, [radialAngularSpanDegrees, tree?.leafCount]);
  const polarLayoutValueForCurrentModeTheta = useCallback((theta: number, mode: ViewMode): number => {
    const domain = polarDomainForMode(mode);
    let adjustedTheta = wrapPositive(theta);
    if (domain.span < (Math.PI * 2) - 1e-9 && adjustedTheta < domain.start) {
      adjustedTheta += Math.PI * 2;
    }
    const fraction = clamp01((adjustedTheta - domain.start) / domain.span);
    return Math.min(Math.max(0, (tree?.leafCount ?? 1) - 1), fraction * domain.leafDivisor);
  }, [polarDomainForMode, tree?.leafCount]);
  const polarThetaForCurrentModeLayoutValue = useCallback((layoutValue: number, mode: ViewMode): number => {
    const domain = polarDomainForMode(mode);
    return domain.start + ((Math.max(0, Math.min((tree?.leafCount ?? 1) - 1, layoutValue)) / domain.leafDivisor) * domain.span);
  }, [polarDomainForMode, tree?.leafCount]);
  const taxonomyCustomPaletteSignature = taxonomyCustomPaletteColors.join(",");
  const timeAxisExtent = useMemo(() => (tree ? treeTimeAxisExtent(tree) : 0), [tree]);
  const polarBaseRadius = tree
    ? Math.max(effectiveTimeAxisScale === "log" ? timeAxisExtent : tree.maxDepth, tree.branchLengthMinPositive)
    : 0;
  const configuredRadialCenterOpeningRatio = Math.max(0, Math.min(0.85, radialCenterOpeningRatio));
  const effectiveRadialCenterOpeningRatio = viewMode === "circular"
    ? configuredRadialCenterOpeningRatio
    : 0;
  const polarInnerRadius = effectiveRadialCenterOpeningRatio > 0
    ? (polarBaseRadius * effectiveRadialCenterOpeningRatio) / (1 - effectiveRadialCenterOpeningRatio)
    : 0;
  const polarOuterRadius = polarInnerRadius + polarBaseRadius;
  const configuredRadialInnerRadius = configuredRadialCenterOpeningRatio > 0
    ? (polarBaseRadius * configuredRadialCenterOpeningRatio) / (1 - configuredRadialCenterOpeningRatio)
    : 0;
  const innerRadiusForMode = useCallback((mode: ViewMode): number => (
    mode === "circular" ? configuredRadialInnerRadius : 0
  ), [configuredRadialInnerRadius]);
  const axisDepthForMode = useCallback((depth: number, mode: ViewMode): number => (
    tree
      ? depthToTimeAxisDepth(tree, depth, effectiveTimeAxisScale, effectiveTimeAxisLogBase) + innerRadiusForMode(mode)
      : depth
  ), [effectiveTimeAxisLogBase, effectiveTimeAxisScale, innerRadiusForMode, tree]);
  const rawDepthFromAxisForMode = useCallback((depth: number, mode: ViewMode): number => (
    tree
      ? timeAxisDepthToRawDepth(tree, depth - innerRadiusForMode(mode), effectiveTimeAxisScale, effectiveTimeAxisLogBase)
      : depth
  ), [effectiveTimeAxisLogBase, effectiveTimeAxisScale, innerRadiusForMode, tree]);
  const cache = useMemo(() => (
    tree
      ? buildCache(tree, effectiveTimeAxisScale, effectiveTimeAxisLogBase, polarAngleStart, polarAngleSpan, polarInnerRadius)
      : null
  ), [effectiveTimeAxisLogBase, effectiveTimeAxisScale, polarAngleSpan, polarAngleStart, polarInnerRadius, tree]);
  const polarThetaFor = useCallback((values: Float64Array, node: number): number => (
    tree ? thetaFor(values, node, tree.leafCount, polarAngleStart, polarAngleSpan) : polarAngleStart
  ), [polarAngleSpan, polarAngleStart, tree]);
  const axisDepth = useCallback((depth: number): number => (
    axisDepthForMode(depth, viewMode)
  ), [axisDepthForMode, viewMode]);
  useEffect(() => {
    setCollapsedNodeModes(new Map());
    setManualBranchColorAssignments(new Map());
    setManualSubtreeColorAssignments(new Map());
    setTaxonomyRootColorAssignments(new Map());
    setContextMenu(null);
    setContextMenuColorMode(null);
    setContextMenuRootMenuOpen(false);
    setContextMenuCollapseMenuOpen(false);
    hoverRef.current = null;
    distanceStartNodeRef.current = null;
    distanceStartAncestorsRef.current.clear();
    distanceMeasurementRef.current = null;
    updateHoverTooltip(null);
    if (distanceTooltipRef.current) {
      distanceTooltipRef.current.hidden = true;
    }
    if (canvasRef.current) {
      canvasRef.current.style.cursor = "";
    }
    const hoverCanvas = hoverCanvasRef.current;
    const ctx = hoverCanvas?.getContext("2d");
    if (hoverCanvas && ctx) {
      ctx.clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);
    }
  }, [tree, updateHoverTooltip]);

  useEffect(() => {
    const allowedKeys = new Set(phylopicSilhouettes.map((silhouette) => phylopicImageElementKey(silhouette)));
    for (const key of Array.from(phylopicImagesRef.current.keys())) {
      if (!allowedKeys.has(key)) {
        phylopicImagesRef.current.delete(key);
      }
    }
    for (const silhouette of phylopicSilhouettes) {
      const imageKey = phylopicImageElementKey(silhouette);
      if (phylopicImagesRef.current.has(imageKey)) {
        continue;
      }
      const image = new Image();
      image.decoding = "async";
      image.onload = () => setPhyloPicImageLoadVersion((version) => version + 1);
      image.onerror = () => {
        phylopicImagesRef.current.delete(imageKey);
        setPhyloPicImageLoadVersion((version) => version + 1);
      };
      phylopicImagesRef.current.set(imageKey, image);
      image.src = silhouette.dataUrl;
    }
  }, [phylopicSilhouettes]);

  useEffect(() => {
    if (!onSessionStateSnapshot || handledSessionStateRequestRef.current === sessionStateRequest) {
      return;
    }
    handledSessionStateRequestRef.current = sessionStateRequest;
    onSessionStateSnapshot({
      camera: cameraRef.current ? { ...cameraRef.current } : null,
      viewportWidth: size.width,
      viewportHeight: size.height,
      collapsedNodes: Array.from(collapsedNodes),
      collapsedNodeModes: Array.from(collapsedNodeModes),
      manualBranchColors: Array.from(manualBranchColorAssignments),
      manualSubtreeColors: Array.from(manualSubtreeColorAssignments),
      taxonomyRootColors: Array.from(taxonomyRootColorAssignments),
    });
  }, [
    collapsedNodes,
    collapsedNodeModes,
    manualBranchColorAssignments,
    manualSubtreeColorAssignments,
    onSessionStateSnapshot,
    sessionStateRequest,
    size.height,
    size.width,
    taxonomyRootColorAssignments,
  ]);
  useEffect(() => {
    setContextMenuColorMode(null);
    setContextMenuRootMenuOpen(false);
    setContextMenuCollapseMenuOpen(false);
  }, [taxonomyMap, visualResetRequest]);
  useEffect(() => {
    setTaxonomyRootColorAssignments(new Map());
  }, [visualResetRequest]);
  useEffect(() => {
    if (!contextMenu) {
      setContextMenuColorMode(null);
      setContextMenuRootMenuOpen(false);
      setContextMenuCollapseMenuOpen(false);
    }
  }, [contextMenu]);
  useEffect(() => {
    if (!contextMenu || !contextMenuColorMode) {
      return;
    }
    if (contextMenu.kind === "node") {
      if (contextMenuColorMode === "branch") {
        setContextMenuCustomColor(manualBranchColorAssignments.get(contextMenu.node) ?? "#2563eb");
        return;
      }
      if (contextMenuColorMode === "subtree") {
        setContextMenuCustomColor(manualSubtreeColorAssignments.get(contextMenu.node) ?? "#2563eb");
        return;
      }
    }
    if (contextMenu.kind === "taxonomy" && contextMenuColorMode === "taxonomy-root") {
      setContextMenuCustomColor(taxonomyRootColorAssignments.get(contextMenu.name) ?? "#2563eb");
    }
  }, [
    contextMenu,
    contextMenuColorMode,
    manualBranchColorAssignments,
    manualSubtreeColorAssignments,
    taxonomyRootColorAssignments,
  ]);
  const taxonomyActiveRanks = useMemo<TaxonomyRank[]>(() => {
    return sortTaxonomyRanksForDisplay(
      (taxonomyMap ? [...taxonomyMap.activeRanks] : [...TAXONOMY_RANKS]).filter(
        (rank) => useAutomaticTaxonomyRankVisibility
          ? isAutomaticTaxonomyRank(rank)
            || (taxonomyRankDisplayModes.kingdom ?? "hidden") !== "hidden"
          : (taxonomyRankDisplayModes[rank] ?? (taxonomyRankVisibility[rank] === false ? "hidden" : "ribbon")) !== "hidden",
      ),
    );
  }, [taxonomyMap, taxonomyRankDisplayModes, taxonomyRankVisibility, useAutomaticTaxonomyRankVisibility]);
  const automaticTaxonomyRanks = useMemo(
    () => taxonomyActiveRanks.filter(isAutomaticTaxonomyRank),
    [taxonomyActiveRanks],
  );
  const supplementalTaxonomyRanks = useMemo(
    () => taxonomyActiveRanks.filter((rank) => !isAutomaticTaxonomyRank(rank)),
    [taxonomyActiveRanks],
  );
  const withSupplementalTaxonomyRanks = useCallback((ranks: TaxonomyRank[]): TaxonomyRank[] => (
    sortTaxonomyRanksForDisplay([...ranks, ...supplementalTaxonomyRanks])
  ), [supplementalTaxonomyRanks]);
  const taxonomyAvailableRanks = useMemo<TaxonomyRank[]>(() => (
    sortTaxonomyRanksForDisplay(taxonomyMap ? [...taxonomyMap.activeRanks] : [...TAXONOMY_RANKS])
  ), [taxonomyMap]);
  const taxonomyRankDisplayModeForRank = useCallback((rank: TaxonomyRank): TaxonomyRankDisplayMode => (
    useAutomaticTaxonomyRankVisibility
      ? rank === "kingdom"
        ? taxonomyRankDisplayModes.kingdom ?? "hidden"
        : "ribbon"
      : taxonomyRankDisplayModes[rank] ?? (taxonomyRankVisibility[rank] === false ? "hidden" : "ribbon")
  ), [taxonomyRankDisplayModes, taxonomyRankVisibility, useAutomaticTaxonomyRankVisibility]);
  const taxonomyColorRanks = useMemo<TaxonomyRank[]>(() => {
    const sourceRanks = taxonomyAvailableRanks;
    if (sourceRanks.length === 0) {
      return [];
    }
    const autoRootRank = taxonomyMap
      ? chooseAutoTaxonomyColorRootRank(taxonomyMap, sourceRanks.filter(isAutomaticTaxonomyRank))
      : null;
    const rootRank = taxonomyColorRootRank === "auto" ? autoRootRank : taxonomyColorRootRank;
    const rootIndex = rootRank ? sourceRanks.indexOf(rootRank) : sourceRanks.length - 1;
    const effectiveRootIndex = rootIndex >= 0 ? rootIndex : sourceRanks.length - 1;
    const jitterIndex = Math.min(
      effectiveRootIndex,
      Math.max(0, sourceRanks.indexOf(taxonomyColorJitterRank)),
    );
    return sourceRanks.slice(jitterIndex, effectiveRootIndex + 1);
  }, [taxonomyAvailableRanks, taxonomyColorJitterRank, taxonomyColorRootRank, taxonomyMap]);
  const effectiveTaxonomyColorSourceMap = taxonomyColorSourceMap ?? taxonomyMap;
  const taxonomyOutermostRank = taxonomyActiveRanks[taxonomyActiveRanks.length - 1] ?? null;
  const taxonomyColors = useMemo(() => (
    effectiveTaxonomyColorSourceMap
      ? buildTaxonomyColorMap(
        effectiveTaxonomyColorSourceMap,
        taxonomyRootColorAssignments,
        Math.max(0, Math.min(4, taxonomyColorJitter)),
        taxonomyColorPalette,
        taxonomyCustomPaletteColors,
        taxonomyColorRootRank,
        taxonomyColorJitterRank,
      )
      : null
  ), [
    effectiveTaxonomyColorSourceMap,
    taxonomyColorJitter,
    taxonomyColorJitterRank,
    taxonomyColorPalette,
    taxonomyColorRootRank,
    taxonomyCustomPaletteColors,
    taxonomyRootColorAssignments,
  ]);
  useEffect(() => {
    onTaxonomyColorsChange?.(taxonomyColors);
  }, [onTaxonomyColorsChange, taxonomyColors]);
  const getTaxonomyBlocks = useCallback((orderKey: LayoutOrder): Record<TaxonomyRank, TaxonomyBlock[]> | null => {
    if (!cache || !taxonomyMap) {
      return null;
    }
    const cacheKey = taxonomyBlocksCacheKeyRef.current;
    if (
      !cacheKey
      || cacheKey.cache !== cache
      || cacheKey.taxonomyMap !== taxonomyMap
      || cacheKey.taxonomyColors !== taxonomyColors
    ) {
      taxonomyBlocksByOrderCacheRef.current = {};
      taxonomyBlocksCacheKeyRef.current = { cache, taxonomyMap, taxonomyColors };
    }
    const existing = taxonomyBlocksByOrderCacheRef.current[orderKey];
    if (existing) {
      return existing;
    }
    const built = buildTaxonomyBlocksForOrderedLeaves(cache.orderedLeaves[orderKey], taxonomyMap, taxonomyColors);
    taxonomyBlocksByOrderCacheRef.current[orderKey] = built;
    return built;
  }, [cache, taxonomyColors, taxonomyMap]);
  const taxonomyBlocks = useMemo<Record<TaxonomyRank, TaxonomyBlock[]> | null>(
    () => getTaxonomyBlocks(order),
    [getTaxonomyBlocks, order],
  );
  const taxonomyOverlayBlocks = useMemo<Record<TaxonomyRank, TaxonomyBlock[]> | null>(() => {
    if (!taxonomyBlocks || !tree || !cache) {
      return taxonomyBlocks;
    }
    const minimizedRanges = Array.from(collapsedNodeModes)
      .filter(([node, mode]) => {
        if (mode !== "minimize") {
          return false;
        }
        for (let ancestor = tree.buffers.parent[node]; ancestor >= 0; ancestor = tree.buffers.parent[ancestor]) {
          if (collapsedNodeModes.has(ancestor)) {
            return false;
          }
        }
        return true;
      })
      .map(([node]) => ({
        startIndex: Math.max(0, Math.floor(tree.layouts[order].min[node] + 1e-6)),
        endIndex: Math.min(tree.leafCount, Math.ceil(tree.layouts[order].max[node] - 1e-6) + 1),
      }));
    if (minimizedRanges.length === 0) {
      return taxonomyBlocks;
    }
    const clipSegment = (
      segment: { firstNode: number; lastNode: number; startIndex: number; endIndex: number },
    ): Array<{ firstNode: number; lastNode: number; startIndex: number; endIndex: number }> => {
      const segmentRuns = segment.endIndex >= segment.startIndex
        ? [{ startIndex: segment.startIndex, endIndex: segment.endIndex }]
        : [
            { startIndex: segment.startIndex, endIndex: tree.leafCount },
            { startIndex: 0, endIndex: segment.endIndex },
          ];
      let visibleRuns = segmentRuns;
      for (let rangeIndex = 0; rangeIndex < minimizedRanges.length; rangeIndex += 1) {
        const range = minimizedRanges[rangeIndex];
        visibleRuns = visibleRuns.flatMap((run) => {
          if (range.endIndex <= run.startIndex || range.startIndex >= run.endIndex) {
            return [run];
          }
          const fragments: Array<{ startIndex: number; endIndex: number }> = [];
          if (range.startIndex > run.startIndex) {
            fragments.push({ startIndex: run.startIndex, endIndex: range.startIndex });
          }
          if (range.endIndex < run.endIndex) {
            fragments.push({ startIndex: range.endIndex, endIndex: run.endIndex });
          }
          return fragments;
        });
      }
      return visibleRuns
        .filter((run) => run.endIndex > run.startIndex)
        .map((run) => ({
          firstNode: cache.orderedLeaves[order][run.startIndex],
          lastNode: cache.orderedLeaves[order][run.endIndex - 1],
          startIndex: run.startIndex,
          endIndex: run.endIndex,
        }));
    };
    const orderedLeaves = cache.orderedLeaves[order];
    return TAXONOMY_RANKS.reduce<Record<TaxonomyRank, TaxonomyBlock[]>>((result, rank) => {
      result[rank] = (taxonomyBlocks[rank] ?? []).flatMap((block) => {
        const segments = block.segments && block.segments.length > 0
          ? block.segments
          : [{
              firstNode: block.firstNode,
              lastNode: block.lastNode,
              startIndex: block.startIndex ?? 0,
              endIndex: block.endIndex ?? tree.leafCount,
            }];
        const visibleSegments = segments.flatMap(clipSegment);
        if (visibleSegments.length === 0) {
          return [];
        }
        const segmentsUnchanged = (
          visibleSegments.length === segments.length
          && visibleSegments.every((segment, index) => (
            segment.startIndex === segments[index].startIndex
            && segment.endIndex === segments[index].endIndex
          ))
        );
        if (segmentsUnchanged) {
          return [block];
        }
        const labelSegment = visibleSegments.reduce((largest, segment) => {
          const largestSpan = largest.endIndex >= largest.startIndex
            ? largest.endIndex - largest.startIndex
            : largest.endIndex + tree.leafCount - largest.startIndex;
          const segmentSpan = segment.endIndex >= segment.startIndex
            ? segment.endIndex - segment.startIndex
            : segment.endIndex + tree.leafCount - segment.startIndex;
          return segmentSpan > largestSpan ? segment : largest;
        });
        const labelEnd = labelSegment.endIndex >= labelSegment.startIndex
          ? labelSegment.endIndex
          : labelSegment.endIndex + tree.leafCount;
        const centerIndex = Math.floor((labelSegment.startIndex + labelEnd - 1) * 0.5) % tree.leafCount;
        return [{
          ...block,
          firstNode: labelSegment.firstNode,
          lastNode: labelSegment.lastNode,
          centerNode: orderedLeaves[centerIndex],
          startIndex: labelSegment.startIndex,
          endIndex: labelSegment.endIndex,
          labelStartIndex: labelSegment.startIndex,
          labelEndIndex: labelSegment.endIndex,
          segments: visibleSegments,
        }];
      });
      return result;
    }, {} as Record<TaxonomyRank, TaxonomyBlock[]>);
  }, [cache, collapsedNodeModes, order, taxonomyBlocks, tree]);
  const circularTaxonomyBlockPriority = useMemo(() => {
    const renderedBlocks = taxonomyOverlayBlocks ?? taxonomyBlocks;
    if (!renderedBlocks || !tree) {
      return null;
    }
    return TAXONOMY_RANKS.reduce<Record<TaxonomyRank, Array<{
      block: TaxonomyBlock;
      key: string;
      totalTipCount: number;
    }>>>((result, rank) => {
      result[rank] = (renderedBlocks[rank] ?? [])
        .map((block) => ({
          block,
          key: taxonomyBlockStableKey(block),
          totalTipCount: (block.segments ?? []).reduce((total, segment) => {
            const end = segment.endIndex >= segment.startIndex
              ? segment.endIndex
              : segment.endIndex + tree.leafCount;
            return total + Math.max(0, end - segment.startIndex);
          }, 0),
        }))
        .sort((left, right) => (
          right.totalTipCount - left.totalTipCount
          || (left.block.startIndex ?? 0) - (right.block.startIndex ?? 0)
        ));
      return result;
    }, {} as Record<TaxonomyRank, Array<{
      block: TaxonomyBlock;
      key: string;
      totalTipCount: number;
    }>>);
  }, [taxonomyBlocks, taxonomyOverlayBlocks, tree]);
  const taxonomyConsensusRanks = useMemo<TaxonomyRank[]>(() => (
    sortTaxonomyRanksForDisplay([...new Set([...taxonomyActiveRanks, ...taxonomyColorRanks])])
  ), [taxonomyActiveRanks, taxonomyColorRanks]);
  const taxonomyConsensus = useMemo(
    () => (tree && taxonomyMap ? buildTaxonomyConsensusByRank(tree, taxonomyMap, taxonomyConsensusRanks) : null),
    [taxonomyConsensusRanks, taxonomyMap, tree],
  );
  const taxonomyTipByNode = useMemo(() => (
    new Map((taxonomyMap?.tipRanks ?? []).map((tip) => [tip.node, tip]))
  ), [taxonomyMap]);
  const taxonomyMappedLeafPrefixByRank = useMemo(() => {
    if (!cache || !taxonomyMap) {
      return null;
    }
    const orderedLeaves = cache.orderedLeaves[order];
    return new Map(taxonomyMap.activeRanks.map((rank) => {
      const prefix = new Uint32Array(orderedLeaves.length + 1);
      for (let leafIndex = 0; leafIndex < orderedLeaves.length; leafIndex += 1) {
        prefix[leafIndex + 1] = (
          prefix[leafIndex]
          + (taxonomyTipByNode.get(orderedLeaves[leafIndex])?.ranks[rank] ? 1 : 0)
        );
      }
      return [rank, prefix] as const;
    }));
  }, [cache, order, taxonomyMap, taxonomyTipByNode]);
  const taxonomySegmentResolutionCacheRef = useRef<{
    tree: TreeModel;
    taxonomyMap: TaxonomyMapPayload;
    order: LayoutOrder;
    values: Map<string, number | null>;
  } | null>(null);
  const resolveTaxonomySegmentNode = useCallback((
    rank: TaxonomyRank,
    label: string,
    taxId: number | null,
    firstNode: number,
    lastNode: number,
    startIndex?: number,
    endIndex?: number,
  ): number | null => {
    if (!tree || !cache || !taxonomyMap || !taxonomyMappedLeafPrefixByRank) {
      return null;
    }
    const mappedPrefix = taxonomyMappedLeafPrefixByRank.get(rank);
    if (!mappedPrefix) {
      return null;
    }
    let resolutionCache = taxonomySegmentResolutionCacheRef.current;
    if (
      !resolutionCache
      || resolutionCache.tree !== tree
      || resolutionCache.taxonomyMap !== taxonomyMap
      || resolutionCache.order !== order
    ) {
      resolutionCache = {
        tree,
        taxonomyMap,
        order,
        values: new Map(),
      };
      taxonomySegmentResolutionCacheRef.current = resolutionCache;
    }
    const key = `${rank}:${taxonomyEntityKey(label, taxId)}:${startIndex ?? "?"}:${endIndex ?? "?"}:${firstNode}:${lastNode}`;
    if (resolutionCache.values.has(key)) {
      return resolutionCache.values.get(key) ?? null;
    }
    const resolved = resolveTaxonomySegmentClade(
      tree,
      tree.layouts[order],
      cache.orderedLeaves[order],
      taxonomyTipByNode,
      mappedPrefix,
      rank,
      label,
      taxId,
      firstNode,
      lastNode,
    );
    resolutionCache.values.set(key, resolved);
    return resolved;
  }, [
    cache,
    order,
    taxonomyMap,
    taxonomyMappedLeafPrefixByRank,
    taxonomyTipByNode,
    tree,
  ]);
  const taxonomyTipRanksByNode = useMemo(() => {
    const byNode = new Map<number, Partial<Record<TaxonomyRank, string>>>();
    if (!taxonomyMap) {
      return byNode;
    }
    for (let index = 0; index < taxonomyMap.tipRanks.length; index += 1) {
      byNode.set(taxonomyMap.tipRanks[index].node, taxonomyMap.tipRanks[index].ranks);
    }
    return byNode;
  }, [taxonomyMap]);
  const collapsedTipTaxonomySummaryByNode = useMemo(() => {
    const byNode = new Map<number, {
      rank: string;
      descendantTipCount: number;
      mrcaAge: number | null;
    }>();
    if (
      !taxonomyMap
      || !sharedSubtreeSourceTree
      || !sharedSubtreeSourceNodeByViewNode
      || taxonomyCollapseRank === "species"
    ) {
      return byNode;
    }
    for (let index = 0; index < taxonomyMap.tipRanks.length; index += 1) {
      const tip = taxonomyMap.tipRanks[index];
      const sourceNode = sharedSubtreeSourceNodeByViewNode[tip.node];
      if (!(sourceNode >= 0)) {
        continue;
      }
      const rank = tip.ranks[taxonomyCollapseRank]
        ? taxonomyCollapseRank
        : (tip.collapseFallbacks?.[taxonomyCollapseRank]?.rank ?? null);
      if (!rank) {
        continue;
      }
      byNode.set(tip.node, {
        rank,
        descendantTipCount: sharedSubtreeSourceTree.buffers.leafCount[sourceNode] ?? 0,
        mrcaAge: sharedSubtreeSourceTree.isUltrametric
          ? Math.max(0, sharedSubtreeSourceTree.rootAge - sharedSubtreeSourceTree.buffers.depth[sourceNode])
          : null,
      });
    }
    return byNode;
  }, [sharedSubtreeSourceNodeByViewNode, sharedSubtreeSourceTree, taxonomyCollapseRank, taxonomyMap]);
  const collapsedTaxonomyGroupByNode = useMemo(() => {
    const byNode = new Map<number, CollapsedTaxonomyGroup>();
    if (
      collapsedNodes.size === 0
      || !taxonomyEnabled
      || !taxonomyBlocks
      || !taxonomyMap
      || !tree
    ) {
      return byNode;
    }
    const collapsedRanges = Array.from(collapsedNodes, (node) => ({
      start: tree.layouts[order].min[node],
      end: tree.layouts[order].max[node],
    }));
    const activeRankSet = new Set(taxonomyMap.activeRanks);
    for (let rankIndex = TAXONOMY_RANKS.length - 1; rankIndex >= 0; rankIndex -= 1) {
      const rank = TAXONOMY_RANKS[rankIndex];
      if (!activeRankSet.has(rank)) {
        continue;
      }
      const blocks = taxonomyBlocks[rank] ?? [];
      for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
        const block = blocks[blockIndex];
        const segments = block.segments && block.segments.length > 0
          ? block.segments
          : [{
              firstNode: block.firstNode,
              lastNode: block.lastNode,
              startIndex: block.startIndex ?? 0,
              endIndex: block.endIndex ?? tree.leafCount,
        }];
        for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
          const segment = segments[segmentIndex];
          const endpointCandidate = lowestCommonAncestor(tree, segment.firstNode, segment.lastNode);
          if (!collapsedRanges.some((range) => (
            range.start >= tree.layouts[order].min[endpointCandidate]
            && range.end <= tree.layouts[order].max[endpointCandidate]
          ))) {
            continue;
          }
          const collapsedNode = resolveTaxonomySegmentNode(
            rank,
            block.label,
            block.taxId ?? null,
            segment.firstNode,
            segment.lastNode,
            segment.startIndex,
            segment.endIndex,
          );
          if (collapsedNode === null) {
            continue;
          }
          if (!collapsedNodes.has(collapsedNode) || byNode.has(collapsedNode)) {
            continue;
          }
          byNode.set(collapsedNode, {
            label: block.label,
            rank,
            taxId: block.taxId ?? null,
            firstNode: segment.firstNode,
            lastNode: segment.lastNode,
            descendantTipCount: tree.buffers.leafCount[collapsedNode],
          });
        }
      }
    }
    return byNode;
  }, [
    collapsedNodes,
    order,
    taxonomyBlocks,
    taxonomyEnabled,
    taxonomyMap,
    resolveTaxonomySegmentNode,
    tree,
  ]);
  const manualBranchColorVersion = useMemo(() => {
    const branchKey = branchColorAssignmentKey(manualBranchColorAssignments);
    const subtreeKey = branchColorAssignmentKey(manualSubtreeColorAssignments);
    if (!branchKey && !subtreeKey) {
      return "";
    }
    return `branch:${branchKey};subtree:${subtreeKey}`;
  }, [manualBranchColorAssignments, manualSubtreeColorAssignments]);
  const manualBranchColorOverlay = useMemo(
    () => (tree ? buildManualBranchColorOverlay(tree, manualSubtreeColorAssignments, manualBranchColorAssignments) : { colors: [], hasAny: false }),
    [manualBranchColorAssignments, manualSubtreeColorAssignments, tree],
  );
  const metadataBranchColorOverlay = useMemo(() => {
    if (!tree || !metadataBranchColors || metadataBranchColors.length !== tree.nodeCount) {
      return { colors: [] as Array<string | null>, hasAny: false };
    }
    return {
      colors: metadataBranchColors,
      hasAny: metadataBranchColors.some((color) => color !== null),
    };
  }, [metadataBranchColors, tree]);
  const metadataBranchColorCacheable = useMemo(() => (
    !metadataBranchColorOverlay.hasAny
    || branchColorCardinalityWithinLimit(metadataBranchColorOverlay.colors, MAX_GLOBAL_COLORED_BRANCH_CACHE_COLORS)
  ), [metadataBranchColorOverlay]);
  const metadataBranchColorsCoverAllBranches = useMemo(() => (
    Boolean(tree && metadataBranchColorOverlay.hasAny && branchColorsCoverAllBranches(tree, metadataBranchColorOverlay.colors))
  ), [metadataBranchColorOverlay, tree]);
  const metadataLabelNodes = useMemo(() => {
    if (!tree || !metadataLabels || metadataLabels.length !== tree.nodeCount) {
      return [] as number[];
    }
    const nodes: number[] = [];
    for (let node = 0; node < tree.nodeCount; node += 1) {
      if (metadataLabels[node]) {
        nodes.push(node);
      }
    }
    return nodes;
  }, [metadataLabels, tree]);
  const metadataMarkerNodes = useMemo(() => {
    if (!tree || !metadataMarkers || metadataMarkers.length !== tree.nodeCount) {
      return [] as number[];
    }
    const nodes: number[] = [];
    for (let node = 0; node < tree.nodeCount; node += 1) {
      if (metadataMarkers[node]) {
        nodes.push(node);
      }
    }
    return nodes;
  }, [metadataMarkers, tree]);
  const metadataPieNodes = useMemo(() => {
    if (!tree || !metadataPies || metadataPies.length !== tree.nodeCount) {
      return [] as number[];
    }
    const nodes: number[] = [];
    for (let node = 0; node < tree.nodeCount; node += 1) {
      if (metadataPies[node]) {
        nodes.push(node);
      }
    }
    return nodes;
  }, [metadataPies, tree]);
  const metadataTipDecorationMaxSizePx = useMemo(() => {
    if (!tree) {
      return 0;
    }
    let maxSize = 0;
    for (let index = 0; index < metadataMarkerNodes.length; index += 1) {
      const node = metadataMarkerNodes[index];
      if (tree.buffers.firstChild[node] < 0) {
        maxSize = Math.max(maxSize, metadataMarkerSizePx);
      }
    }
    for (let index = 0; index < metadataPieNodes.length; index += 1) {
      const node = metadataPieNodes[index];
      if (tree.buffers.firstChild[node] < 0) {
        maxSize = Math.max(maxSize, metadataPieSizePx);
      }
    }
    return maxSize;
  }, [metadataMarkerNodes, metadataMarkerSizePx, metadataPieNodes, metadataPieSizePx, tree]);
  const metadataMarkerNodesByOrder = useMemo<Record<LayoutOrder, number[]>>(() => {
    if (!tree || metadataMarkerNodes.length === 0) {
      return {
        input: [],
        desc: [],
        asc: [],
      };
    }
    const sortForOrder = (orderKey: LayoutOrder): number[] => (
      [...metadataMarkerNodes].sort((left, right) => tree.layouts[orderKey].center[left] - tree.layouts[orderKey].center[right])
    );
    return {
      input: sortForOrder("input"),
      desc: sortForOrder("desc"),
      asc: sortForOrder("asc"),
    };
  }, [metadataMarkerNodes, tree]);
  const metadataPieNodesByOrder = useMemo<Record<LayoutOrder, number[]>>(() => {
    if (!tree || metadataPieNodes.length === 0) {
      return {
        input: [],
        desc: [],
        asc: [],
      };
    }
    const sortForOrder = (orderKey: LayoutOrder): number[] => (
      [...metadataPieNodes].sort((left, right) => tree.layouts[orderKey].center[left] - tree.layouts[orderKey].center[right])
    );
    return {
      input: sortForOrder("input"),
      desc: sortForOrder("desc"),
      asc: sortForOrder("asc"),
    };
  }, [metadataPieNodes, tree]);
  useLayoutEffect(() => {
    taxonomyBlocksByOrderCacheRef.current = {};
    taxonomyBranchColorsCacheRef.current.clear();
    effectiveBranchColorsCacheRef.current.clear();
    circularTaxonomyPathCacheRef.current.clear();
    rectTaxonomyPathCacheRef.current.clear();
    spiralBranchPathCacheRef.current.clear();
    spiralTaxonomyRibbonPathCacheRef.current.clear();
    circularBasePathCacheRef.current.clear();
    rectBasePathCacheRef.current.clear();
    disposeCanvasCache(circularTaxonomyBitmapCacheRef.current);
    disposeCanvasCache(rectTaxonomyBitmapCacheRef.current);
    circularTaxonomyBitmapCacheRef.current = null;
    rectTaxonomyBitmapCacheRef.current = null;
    circularTaxonomyOverlayLayoutCacheRef.current = null;
  }, [
    branchThicknessScale,
    effectiveTimeAxisLogBase,
    effectiveTimeAxisScale,
    getTaxonomyBlocks,
    manualBranchColorVersion,
    metadataBranchColorVersion,
    metadataLabelVersion,
    metadataMarkerVersion,
    spiralTurns,
    taxonomyActiveRanks,
    taxonomyColors,
    taxonomyConsensus,
    tree,
  ]);
  const searchMatchSet = useMemo(() => new Set(searchMatches), [searchMatches]);
  const labelFontFamilies = useMemo<Record<LabelStyleClass, string>>(() => ({
    tip: fontFamilyCss(figureStyles.tip.fontFamily),
    genus: fontFamilyCss(figureStyles.genus.fontFamily),
    taxonomy: fontFamilyCss(figureStyles.taxonomy.fontFamily),
    internalNode: fontFamilyCss(figureStyles.internalNode.fontFamily),
    bootstrap: fontFamilyCss(figureStyles.bootstrap.fontFamily),
    nodeHeight: fontFamilyCss(figureStyles.nodeHeight.fontFamily),
    scale: fontFamilyCss(figureStyles.scale.fontFamily),
  }), [figureStyles]);
  const labelFontStyles = useMemo<Record<LabelStyleClass, string>>(() => ({
    tip: fontStyleCss(figureStyles.tip),
    genus: fontStyleCss(figureStyles.genus),
    taxonomy: fontStyleCss(figureStyles.taxonomy),
    internalNode: fontStyleCss(figureStyles.internalNode),
    bootstrap: fontStyleCss(figureStyles.bootstrap),
    nodeHeight: fontStyleCss(figureStyles.nodeHeight),
    scale: fontStyleCss(figureStyles.scale),
  }), [figureStyles]);
  const fontSpec = useCallback((labelClass: LabelStyleClass, fontSize: number): string => {
    const style = labelFontStyles[labelClass];
    return `${style ? `${style} ` : ""}${fontSize}px ${labelFontFamilies[labelClass]}`;
  }, [labelFontFamilies, labelFontStyles]);
  const scaleLabelFontSize = useCallback((labelClass: LabelStyleClass, baseSize: number): number => (
    Math.max(4, baseSize * figureStyles[labelClass].sizeScale)
  ), [figureStyles]);
  const branchStrokeScale = Math.max(0.5, Math.min(4, branchThicknessScale));
  const taxonomyLabelSizeScale = Math.max(
    TAXONOMY_LABEL_SIZE_SCALE_MIN,
    Math.min(TAXONOMY_LABEL_SIZE_SCALE_MAX, figureStyles.taxonomy.sizeScale),
  );
  const taxonomyBandThicknessScale = Math.max(
    0.05,
    Math.min(viewMode === "spiral" ? 5 : 2, figureStyles.taxonomy.bandThicknessScale ?? 1),
  );
  const taxonomyLabelFitScale = Math.max(1, taxonomyBandThicknessScale);
  const thickenOutermostTaxonomyRibbon = figureStyles.taxonomy.thickenOutermostRibbon !== false;
  const circularOverlayViewportScale = compactCircularOverlayScale(size.width, size.height);
  const compactCircularViewport = circularOverlayViewportScale < 1;
  const taxonomyGapControl = Math.max(
    0,
    figureStyles.taxonomy.taxonomyGap ?? (1 + (figureStyles.taxonomy.taxonomyGapPx ?? 0)),
  );
  const taxonomyBaselineGapPx = 18;
  const spiralMetricsForScale = useCallback((visibleRankCount: number, scale: number): SpiralMetrics => {
    if (!tree) {
      throw new Error("Spiral metrics require a loaded tree.");
    }
    return expandSpiralMetricsForRibbonGap(
      buildSpiralMetrics(
        tree,
        spiralTurns,
        visibleRankCount,
        taxonomyBandThicknessScale,
        effectiveTimeAxisLogBase,
      ),
      taxonomyGapControl,
      scale,
    );
  }, [effectiveTimeAxisLogBase, spiralTurns, taxonomyBandThicknessScale, taxonomyGapControl, tree]);
  const spiralVisibleTaxonomyRanksForScale = useCallback((scale: number): TaxonomyRank[] => {
    if (!taxonomyEnabled || !taxonomyBlocks) {
      return [];
    }
    if (!useAutomaticTaxonomyRankVisibility) {
      return taxonomyActiveRanks;
    }
    if (!tree) {
      return withSupplementalTaxonomyRanks(automaticTaxonomyRanks.slice(-2));
    }
    const fitVisibleRankCount = Math.min(2, automaticTaxonomyRanks.length);
    const fitTotalRankCount = fitVisibleRankCount + supplementalTaxonomyRanks.length;
    const fitRadiusPx = Math.min(size.width, size.height) * 0.46;
    let fitScale = fitRadiusPx / Math.max(
      buildSpiralMetrics(
        tree,
        spiralTurns,
        fitTotalRankCount,
        taxonomyBandThicknessScale,
        effectiveTimeAxisLogBase,
      ).outerRadius,
      1e-9,
    );
    for (let iteration = 0; iteration < 3; iteration += 1) {
      fitScale = fitRadiusPx / Math.max(spiralMetricsForScale(fitTotalRankCount, fitScale).outerRadius, 1e-9);
    }
    const zoomRatio = scale / Math.max(fitScale, 1e-9);
    let visibleRankCount = fitVisibleRankCount;
    for (let index = 1; index < SPIRAL_TAXONOMY_RANK_COUNT_ZOOM_THRESHOLDS.length; index += 1) {
      if (zoomRatio >= SPIRAL_TAXONOMY_RANK_COUNT_ZOOM_THRESHOLDS[index]) {
        visibleRankCount = Math.min(automaticTaxonomyRanks.length, index + 2);
      }
    }
    return withSupplementalTaxonomyRanks(automaticTaxonomyRanks.slice(-visibleRankCount));
  }, [
    automaticTaxonomyRanks,
    effectiveTimeAxisLogBase,
    size.height,
    size.width,
    spiralTurns,
    taxonomyActiveRanks,
    taxonomyBandThicknessScale,
    taxonomyBlocks,
    taxonomyEnabled,
    tree,
    useAutomaticTaxonomyRankVisibility,
    spiralMetricsForScale,
    supplementalTaxonomyRanks.length,
    withSupplementalTaxonomyRanks,
  ]);
  const visibleSpiralTaxonomyRanks = useMemo<TaxonomyRank[]>(() => {
    if (!taxonomyEnabled || !taxonomyBlocks) {
      return [];
    }
    if (!useAutomaticTaxonomyRankVisibility) {
      return taxonomyActiveRanks;
    }
    return withSupplementalTaxonomyRanks(automaticTaxonomyRanks.slice(-Math.min(2, automaticTaxonomyRanks.length)));
  }, [automaticTaxonomyRanks, taxonomyActiveRanks, taxonomyBlocks, taxonomyEnabled, useAutomaticTaxonomyRankVisibility, withSupplementalTaxonomyRanks]);
  const reservedTipLabelCharacters = useMemo(() => {
    if (!tree) {
      return 6;
    }
    const lengths: number[] = [];
    for (let index = 0; index < tree.leafNodes.length; index += 1) {
      const node = tree.leafNodes[index];
      lengths.push(displayLabelText(tree.names[node] || "", `tip-${node}`).length);
    }
    if (lengths.length === 0) {
      return 6;
    }
    lengths.sort((left, right) => left - right);
    const percentileIndex = Math.min(lengths.length - 1, Math.floor((lengths.length - 1) * 0.99));
    return Math.max(6, Math.min(lengths[percentileIndex], 32));
  }, [tree]);
  const maxTipLabelCharacters = useMemo(() => {
    if (!tree) {
      return 6;
    }
    let maximum = 6;
    for (let index = 0; index < tree.leafNodes.length; index += 1) {
      const node = tree.leafNodes[index];
      maximum = Math.max(maximum, displayLabelText(tree.names[node] || "", `tip-${node}`).length);
    }
    return maximum;
  }, [tree]);
  const maxGenusLabelCharacters = useMemo(() => {
    if (!cache) {
      return 0;
    }
    let maxCharacters = 0;
    const blocks = cache.genusBlocks.input;
    for (let index = 0; index < blocks.length; index += 1) {
      if (blocks[index].label.length > maxCharacters) {
        maxCharacters = blocks[index].label.length;
      }
    }
    return maxCharacters;
  }, [cache]);
  const displayTipLabelForView = useCallback((node: number): string => (
    displayLabelText(tree?.names[node] ?? "", `tip-${node}`)
  ), [tree]);
  const displayNodeNameForView = useCallback((node: number): string => {
    if (!tree) {
      return `tip-${node}`;
    }
    return displayNodeName(tree, node);
  }, [tree]);
  const updateDistanceTooltip = useCallback((measurement: DistanceMeasurement | null): void => {
    const tooltip = distanceTooltipRef.current;
    const nodes = distanceTooltipNodesRef.current;
    const value = distanceTooltipValueRef.current;
    const mrca = distanceTooltipMrcaRef.current;
    if (!tooltip || !nodes || !value || !mrca) {
      return;
    }
    if (!measurement) {
      tooltip.hidden = true;
      return;
    }
    const formatDistance = (distance: number): string => distance.toLocaleString(undefined, {
      maximumSignificantDigits: 8,
    });
    nodes.textContent = `${displayNodeNameForView(measurement.startNode)} to ${displayNodeNameForView(measurement.targetNode)}`;
    value.textContent = `Distance: ${formatDistance(measurement.distance)}`;
    mrca.textContent = `MRCA: ${displayNodeNameForView(measurement.mrcaNode)}`;
    tooltip.style.left = `${Math.max(8, Math.min(size.width - 260, measurement.screenX + 16))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(size.height - 120, measurement.screenY + 16))}px`;
    tooltip.hidden = false;
  }, [displayNodeNameForView, size.height, size.width]);
  const descendantTipCountForView = useCallback((node: number): number => (
    tree?.buffers.leafCount[node] ?? 0
  ), [tree]);

  const collapsedView = useMemo(() => {
    if (!tree || !cache) {
      return null;
    }
    const baseLayout = tree.layouts[order];
    const hiddenNodes = new Uint8Array(tree.nodeCount);
    const visibleCollapsedNodes = [...collapsedNodeModes.keys()]
      .filter((node) => {
        let ancestor = tree.buffers.parent[node];
        while (ancestor >= 0) {
          if (collapsedNodeModes.has(ancestor)) {
            return false;
          }
          ancestor = tree.buffers.parent[ancestor];
        }
        return true;
      })
      .sort((left, right) => baseLayout.min[left] - baseLayout.min[right]);
    for (let index = 0; index < visibleCollapsedNodes.length; index += 1) {
      const node = visibleCollapsedNodes[index];
      for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
        const stack = [child];
        while (stack.length > 0) {
          const current = stack.pop()!;
          if (hiddenNodes[current]) {
            continue;
          }
          hiddenNodes[current] = 1;
          for (let descendant = tree.buffers.firstChild[current]; descendant >= 0; descendant = tree.buffers.nextSibling[descendant]) {
            stack.push(descendant);
          }
        }
      }
    }
    if (visibleCollapsedNodes.length === 0) {
      return {
        hiddenNodes,
        visibleCollapsedNodes,
        visibleTerminalNodes: cache.orderedLeaves[order],
        layout: baseLayout,
        leafBoundaries: null,
        effectiveLeafScale: 1,
        signature: "",
      };
    }
    const minimumTriangleSpanPx = Math.max(
      MINIMIZED_TRIANGLE_MIN_PX,
      size.height * MINIMIZED_TRIANGLE_MIN_VIEWPORT_FRACTION,
    );
    const projectionCamera = cameraRef.current;
    const spiralCollapseMetrics = viewMode === "spiral"
      ? spiralMetricsForScale(
        visibleSpiralTaxonomyRanks.length,
        projectionCamera?.kind === "circular" ? projectionCamera.scale : 1,
      )
      : null;
    const projectedPixelsPerLayoutUnit = (): number => {
      if (!projectionCamera || projectionCamera.kind !== "rect") {
        return 0;
      }
      return projectionCamera.scaleY;
    };
    const compactIntervals = visibleCollapsedNodes.map((node) => {
      const originalCount = Math.max(1, tree.buffers.leafCount[node]);
      const mode = collapsedNodeModes.get(node) ?? "preserve-width";
      return {
        node,
        mode,
        start: baseLayout.min[node],
        end: baseLayout.max[node],
        originalCount,
        pixelsPerLayoutUnit: projectedPixelsPerLayoutUnit(),
        targetSpan: mode === "minimize" ? Math.min(2, originalCount - 1) : originalCount - 1,
        targetCount: mode === "minimize" ? Math.min(3, originalCount) : originalCount,
      };
    });
    let effectiveLeafCount = tree.leafCount;
    let compactScale = 1;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      effectiveLeafCount = Math.max(
        1,
        tree.leafCount - compactIntervals.reduce(
          (total, interval) => total + (interval.originalCount - interval.targetCount),
          0,
        ),
      );
      compactScale = tree.leafCount / effectiveLeafCount;
      const iterationCompactOffset = (compactScale - 1) * 0.5;
      const compactPositionForIteration = (value: number): number => {
        let removedCount = 0;
        for (let intervalIndex = 0; intervalIndex < compactIntervals.length; intervalIndex += 1) {
          const candidate = compactIntervals[intervalIndex];
          if (value < candidate.start) {
            break;
          }
          if (value <= candidate.end) {
            const span = Math.max(1, candidate.end - candidate.start);
            const progress = (value - candidate.start) / span;
            const compactValue = candidate.start - removedCount + (progress * candidate.targetSpan);
            return (compactValue * compactScale) + iterationCompactOffset;
          }
          removedCount += candidate.originalCount - candidate.targetCount;
        }
        return ((value - removedCount) * compactScale) + iterationCompactOffset;
      };
      let changed = false;
      for (let index = 0; index < compactIntervals.length; index += 1) {
        const interval = compactIntervals[index];
        if (interval.mode !== "minimize") {
          continue;
        }
        let requiredFinalLayoutSpan = tree.leafCount
          * MINIMIZED_TRIANGLE_MIN_CIRCUMFERENCE_FRACTION;
        if (viewMode === "rectangular") {
          requiredFinalLayoutSpan = interval.pixelsPerLayoutUnit > 0
            ? minimumTriangleSpanPx / interval.pixelsPerLayoutUnit
            : 2;
        } else if (viewMode === "spiral" && spiralCollapseMetrics) {
          const centerLayout = compactPositionForIteration(
            (interval.start + interval.end) * 0.5,
          );
          const centerTheta = spiralThetaForY(
            centerLayout,
            tree.leafCount,
            spiralCollapseMetrics,
          );
          const desiredThetaSpan = Math.PI * 2 * MINIMIZED_TRIANGLE_MIN_CIRCUMFERENCE_FRACTION;
          let startTheta = centerTheta - (desiredThetaSpan * 0.5);
          let endTheta = centerTheta + (desiredThetaSpan * 0.5);
          const spiralStartTheta = spiralCollapseMetrics.startTheta;
          const spiralEndTheta = spiralStartTheta + spiralCollapseMetrics.totalTheta;
          if (startTheta < spiralStartTheta) {
            endTheta += spiralStartTheta - startTheta;
            startTheta = spiralStartTheta;
          }
          if (endTheta > spiralEndTheta) {
            startTheta -= endTheta - spiralEndTheta;
            endTheta = spiralEndTheta;
          }
          const startLayout = spiralArcFractionForTheta(startTheta, spiralCollapseMetrics)
            * Math.max(1, tree.leafCount - 1);
          const endLayout = spiralArcFractionForTheta(endTheta, spiralCollapseMetrics)
            * Math.max(1, tree.leafCount - 1);
          requiredFinalLayoutSpan = Math.max(0, endLayout - startLayout);
        }
        const desiredSpan = Math.min(
          interval.originalCount - 1,
          Math.max(2, requiredFinalLayoutSpan / compactScale),
        );
        const desiredCount = Math.min(interval.originalCount, desiredSpan + 1);
        if (Math.abs(desiredCount - interval.targetCount) > 1e-4) {
          interval.targetSpan = desiredSpan;
          interval.targetCount = desiredCount;
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }
    effectiveLeafCount = Math.max(
      1,
      tree.leafCount - compactIntervals.reduce(
        (total, interval) => total + (interval.originalCount - interval.targetCount),
        0,
      ),
    );
    compactScale = tree.leafCount / effectiveLeafCount;
    const compactOffset = (compactScale - 1) * 0.5;
    const compactPosition = (value: number): number => {
      let removedCount = 0;
      for (let index = 0; index < compactIntervals.length; index += 1) {
        const interval = compactIntervals[index];
        if (value < interval.start) {
          break;
        }
        if (value <= interval.end) {
          const span = Math.max(1, interval.end - interval.start);
          const progress = (value - interval.start) / span;
          const compactValue = interval.start - removedCount + (progress * interval.targetSpan);
          return (compactValue * compactScale) + compactOffset;
        }
        removedCount += interval.originalCount - interval.targetCount;
      }
      return ((value - removedCount) * compactScale) + compactOffset;
    };
    const center = new Float64Array(tree.nodeCount);
    const min = new Float64Array(tree.nodeCount);
    const max = new Float64Array(tree.nodeCount);
    for (let node = 0; node < tree.nodeCount; node += 1) {
      center[node] = compactPosition(baseLayout.center[node]);
      min[node] = compactPosition(baseLayout.min[node]);
      max[node] = compactPosition(baseLayout.max[node]);
    }
    const postorder: number[] = [];
    const stack: number[] = [tree.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      postorder.push(node);
      for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
        stack.push(child);
      }
    }
    for (let index = postorder.length - 1; index >= 0; index -= 1) {
      const node = postorder[index];
      if (hiddenNodes[node] || tree.buffers.firstChild[node] < 0) {
        continue;
      }
      if (collapsedNodes.has(node)) {
        center[node] = (min[node] + max[node]) * 0.5;
        continue;
      }
      const orderedChildren = cache.orderedChildren[order][node];
      let firstVisibleChild = -1;
      let lastVisibleChild = -1;
      for (let childIndex = 0; childIndex < orderedChildren.length; childIndex += 1) {
        const child = orderedChildren[childIndex];
        if (hiddenNodes[child]) {
          continue;
        }
        if (firstVisibleChild < 0) {
          firstVisibleChild = child;
        }
        lastVisibleChild = child;
      }
      if (firstVisibleChild >= 0 && lastVisibleChild >= 0) {
        center[node] = (center[firstVisibleChild] + center[lastVisibleChild]) * 0.5;
      }
    }
    const visibleTerminalNodes = [
      ...cache.orderedLeaves[order].filter((node) => !hiddenNodes[node]),
      ...visibleCollapsedNodes,
    ].sort((left, right) => center[left] - center[right]);
    return {
      hiddenNodes,
      visibleCollapsedNodes,
      visibleTerminalNodes,
      layout: {
        center,
        min,
        max,
      },
      leafBoundaries: Float64Array.from(
        { length: tree.leafCount + 1 },
        (_, index) => compactPosition(index - 0.5),
      ),
      effectiveLeafScale: compactScale,
      signature: compactIntervals.map((interval) => `${interval.node}:${interval.mode}`).join("|"),
    };
  }, [
    cache,
    collapsedLayoutRevision,
    collapsedNodeModes,
    collapsedNodes,
    effectiveTimeAxisLogBase,
    order,
    size.height,
    spiralMetricsForScale,
    spiralTurns,
    taxonomyBandThicknessScale,
    tree,
    viewMode,
    visibleSpiralTaxonomyRanks.length,
  ]);

  useEffect(() => {
    hiddenNodesRef.current = collapsedView?.hiddenNodes ?? null;
  }, [collapsedView]);

  const rectTaxonomyBlockInfo = useMemo(() => {
    const renderedBlocks = taxonomyOverlayBlocks ?? taxonomyBlocks;
    if (!renderedBlocks || !tree || !cache) {
      return null;
    }
    const orderedLeaves = cache.orderedLeaves[order];
    const layout = collapsedView?.layout ?? tree.layouts[order];
    return TAXONOMY_RANKS.reduce<Record<TaxonomyRank, Array<{
      block: TaxonomyBlock;
      key: string;
      totalTipCount: number;
      segments: NonNullable<TaxonomyBlock["segments"]>;
      segmentBounds: Array<{ topY: number; bottomY: number } | null>;
      labelSegment: { firstNode: number; lastNode: number; startIndex: number; endIndex: number };
      labelBounds: { topY: number; bottomY: number } | null;
    }>>>((result, rank) => {
      result[rank] = (renderedBlocks[rank] ?? []).map((block) => {
        const segments = block.segments && block.segments.length > 0
          ? block.segments
          : [{ firstNode: block.firstNode, lastNode: block.lastNode, startIndex: 0, endIndex: 0 }];
        const labelStartIndex = block.labelStartIndex ?? block.startIndex ?? segments[0].startIndex;
        const labelEndIndex = block.labelEndIndex ?? block.endIndex ?? segments[0].endIndex;
        const labelSegment = {
          firstNode: orderedLeaves[labelStartIndex],
          lastNode: orderedLeaves[(labelEndIndex - 1 + orderedLeaves.length) % orderedLeaves.length],
          startIndex: labelStartIndex,
          endIndex: labelEndIndex,
        };
        const totalTipCount = segments.reduce((total, segment) => {
          const end = segment.endIndex >= segment.startIndex
            ? segment.endIndex
            : segment.endIndex + tree.leafCount;
          return total + Math.max(0, end - segment.startIndex);
        }, 0);
        return {
          block,
          key: taxonomyBlockStableKey(block),
          totalTipCount,
          segments,
          segmentBounds: segments.map((segment) => (
            rectLeafRangeBounds(orderedLeaves, layout.center, segment.startIndex, segment.endIndex)
          )),
          labelSegment,
          labelBounds: rectLeafRangeBounds(orderedLeaves, layout.center, labelStartIndex, labelEndIndex),
        };
      }).sort((left, right) => (
        right.totalTipCount - left.totalTipCount
        || (left.block.startIndex ?? 0) - (right.block.startIndex ?? 0)
      ));
      return result;
    }, {} as Record<TaxonomyRank, Array<{
      block: TaxonomyBlock;
      key: string;
      totalTipCount: number;
      segments: NonNullable<TaxonomyBlock["segments"]>;
      segmentBounds: Array<{ topY: number; bottomY: number } | null>;
      labelSegment: { firstNode: number; lastNode: number; startIndex: number; endIndex: number };
      labelBounds: { topY: number; bottomY: number } | null;
    }>>);
  }, [cache, collapsedView?.layout, order, taxonomyBlocks, taxonomyOverlayBlocks, tree]);

  const collapsedSpatialCache = useMemo(() => {
    if (!tree || !cache || !collapsedView || collapsedNodes.size === 0) {
      return null;
    }
    const { hiddenNodes, layout } = collapsedView;
    const children = cache.orderedChildren[order];
    const rectSegments: IndexedSegment[] = [];
    const circularSegments: IndexedSegment[] = [];
    for (let node = 0; node < tree.nodeCount; node += 1) {
      if (hiddenNodes[node]) {
        continue;
      }
      const parent = tree.buffers.parent[node];
      if (parent >= 0) {
        const y = layout.center[node];
        rectSegments.push({
          node,
          kind: "stem",
          x1: axisDepth(tree.buffers.depth[parent]),
          y1: y,
          x2: axisDepth(tree.buffers.depth[node]),
          y2: y,
        });
        const theta = polarThetaFor(layout.center, node);
        const circularStart = polarToCartesian(axisDepth(tree.buffers.depth[parent]), theta);
        const circularEnd = polarToCartesian(axisDepth(tree.buffers.depth[node]), theta);
        circularSegments.push({
          node,
          kind: "stem",
          x1: circularStart.x,
          y1: circularStart.y,
          x2: circularEnd.x,
          y2: circularEnd.y,
        });
      }
      if (collapsedNodes.has(node)) {
        continue;
      }
      const visibleChildren = children[node].filter((child) => !hiddenNodes[child]);
      if (visibleChildren.length < 2) {
        continue;
      }
      const x = axisDepth(tree.buffers.depth[node]);
      rectSegments.push({
        node,
        kind: "connector",
        x1: x,
        y1: layout.center[visibleChildren[0]],
        x2: x,
        y2: layout.center[visibleChildren[visibleChildren.length - 1]],
      });
      const startTheta = polarThetaFor(layout.center, visibleChildren[0]);
      const endTheta = polarThetaFor(layout.center, visibleChildren[visibleChildren.length - 1]);
      const arcStart = polarThetaFor(layout.min, node);
      const arcEnd = polarThetaFor(layout.max, node);
      const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, Math.max(0, arcEnd - arcStart));
      appendCircularArcSegments(circularSegments, node, axisDepth(tree.buffers.depth[node]), arcAngles.start, arcAngles.end);
    }
    const axisExtent = Math.max(timeAxisExtent, 1);
    const rectIndex = new UniformGridIndex(rectSegments, {
      minX: 0,
      minY: 0,
      maxX: axisExtent,
      maxY: Math.max(tree.leafCount - 1, 1),
    });
    const circularIndex = new UniformGridIndex(circularSegments, {
      minX: -axisExtent,
      minY: -axisExtent,
      maxX: axisExtent,
      maxY: axisExtent,
    });
    return {
      rectSegments,
      rectIndex,
      circularSegments,
      circularIndex,
    };
  }, [axisDepth, cache, collapsedNodes, collapsedView, order, timeAxisExtent, tree]);

  const drawHoverHighlightOverlay = useCallback((): void => {
    const canvas = hoverCanvasRef.current;
    if (!canvas || !tree) {
      return;
    }
    const baseDpr = window.devicePixelRatio || 1;
    const dpr = baseDpr;
    const backingWidth = Math.max(1, Math.floor(size.width * dpr));
    const backingHeight = Math.max(1, Math.floor(size.height * dpr));
    const previousBackingStore = hoverCanvasBackingStoreRef.current;
    if (
      !previousBackingStore
      || previousBackingStore.width !== backingWidth
      || previousBackingStore.height !== backingHeight
      || Math.abs(previousBackingStore.dpr - dpr) > 1e-6
    ) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
      hoverCanvasBackingStoreRef.current = {
        width: backingWidth,
        height: backingHeight,
        dpr,
      };
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    const camera = cameraRef.current;
    if (!camera) {
      return;
    }
    const layout = collapsedView?.layout ?? tree.layouts[order];
    const measurement = distanceMeasurementRef.current;
    if (measurement) {
      const pathChildren: number[] = [];
      for (let node = measurement.startNode; node !== measurement.mrcaNode && node >= 0; node = tree.buffers.parent[node]) {
        pathChildren.push(node);
      }
      for (let node = measurement.targetNode; node !== measurement.mrcaNode && node >= 0; node = tree.buffers.parent[node]) {
        pathChildren.push(node);
      }

      ctx.strokeStyle = DISTANCE_PATH_COLOR;
      ctx.fillStyle = DISTANCE_PATH_COLOR;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      if (viewMode === "spiral" && camera.kind === "circular") {
        const visibleRankCount = spiralVisibleTaxonomyRanksForScale(camera.scale).length;
        const metrics = spiralMetricsForScale(visibleRankCount, camera.scale);
        const path = new Path2D();
        for (let index = 0; index < pathChildren.length; index += 1) {
          const child = pathChildren[index];
          const parent = tree.buffers.parent[child];
          if (parent < 0) {
            continue;
          }
          const childTheta = spiralThetaForY(layout.center[child], tree.leafCount, metrics);
          const parentTheta = spiralThetaForY(layout.center[parent], tree.leafCount, metrics);
          if (Math.abs(childTheta - parentTheta) > 1e-9) {
            appendSpiralCurve(
              path,
              Math.min(parentTheta, childTheta),
              Math.max(parentTheta, childTheta),
              spiralAgeForDepth(tree, tree.buffers.depth[parent], metrics),
              metrics,
              Math.max(camera.scale, 1e-6),
            );
          }
          const stemStart = spiralPointAt(
            childTheta,
            spiralAgeForDepth(tree, tree.buffers.depth[parent], metrics),
            metrics,
          );
          const stemEnd = spiralPointAt(
            childTheta,
            spiralAgeForDepth(tree, tree.buffers.depth[child], metrics),
            metrics,
          );
          path.moveTo(stemStart.x, stemStart.y);
          path.lineTo(stemEnd.x, stemEnd.y);
        }
        ctx.save();
        ctx.translate(camera.translateX, camera.translateY);
        ctx.scale(camera.scale, camera.scale);
        ctx.rotate(camera.rotation);
        ctx.lineWidth = 3 / Math.max(camera.scale, 1e-6);
        ctx.stroke(path);
        ctx.restore();
      } else {
        ctx.beginPath();
        for (let index = 0; index < pathChildren.length; index += 1) {
          const child = pathChildren[index];
          const parent = tree.buffers.parent[child];
          if (parent < 0) {
            continue;
          }
          if (camera.kind === "rect") {
            const parentY = layout.center[parent];
            const childY = layout.center[child];
            const connectorStart = worldToScreenRect(camera, axisDepth(tree.buffers.depth[parent]), parentY);
            const connectorEnd = worldToScreenRect(camera, axisDepth(tree.buffers.depth[parent]), childY);
            const stemEnd = worldToScreenRect(camera, axisDepth(tree.buffers.depth[child]), childY);
            ctx.moveTo(connectorStart.x, connectorStart.y);
            ctx.lineTo(connectorEnd.x, connectorEnd.y);
            ctx.lineTo(stemEnd.x, stemEnd.y);
          } else {
            const parentTheta = polarThetaFor(layout.center, parent);
            const childTheta = polarThetaFor(layout.center, child);
            const arcStart = polarThetaFor(layout.min, parent);
            const arcEnd = polarThetaFor(layout.max, parent);
            const arcSpan = arcSubspanWithinSpan(parentTheta, childTheta, arcStart, Math.max(0, arcEnd - arcStart));
            const radiusPx = axisDepth(tree.buffers.depth[parent]) * camera.scale;
            if (arcSpan && radiusPx > 0) {
              ctx.moveTo(
                camera.translateX + Math.cos(arcSpan.start + camera.rotation) * radiusPx,
                camera.translateY + Math.sin(arcSpan.start + camera.rotation) * radiusPx,
              );
              ctx.arc(
                camera.translateX,
                camera.translateY,
                radiusPx,
                arcSpan.start + camera.rotation,
                arcSpan.end + camera.rotation,
                false,
              );
            }
            const stemStartWorld = polarToCartesian(axisDepth(tree.buffers.depth[parent]), childTheta);
            const stemEndWorld = polarToCartesian(axisDepth(tree.buffers.depth[child]), childTheta);
            const stemStart = worldToScreenCircular(camera, stemStartWorld.x, stemStartWorld.y);
            const stemEnd = worldToScreenCircular(camera, stemEndWorld.x, stemEndWorld.y);
            ctx.moveTo(stemStart.x, stemStart.y);
            ctx.lineTo(stemEnd.x, stemEnd.y);
          }
        }
        ctx.stroke();
      }

      const screenPointForNode = (node: number): { x: number; y: number } => {
        if (viewMode === "spiral" && camera.kind === "circular") {
          const visibleRankCount = spiralVisibleTaxonomyRanksForScale(camera.scale).length;
          const metrics = spiralMetricsForScale(visibleRankCount, camera.scale);
          const theta = spiralThetaForY(layout.center[node], tree.leafCount, metrics);
          const point = spiralPointAt(theta, spiralAgeForDepth(tree, tree.buffers.depth[node], metrics), metrics);
          return worldToScreenCircular(camera, point.x, point.y);
        }
        if (camera.kind === "rect") {
          return worldToScreenRect(camera, axisDepth(tree.buffers.depth[node]), layout.center[node]);
        }
        const theta = polarThetaFor(layout.center, node);
        const point = polarToCartesian(axisDepth(tree.buffers.depth[node]), theta);
        return worldToScreenCircular(camera, point.x, point.y);
      };
      const startPoint = screenPointForNode(measurement.startNode);
      const targetPoint = screenPointForNode(measurement.targetNode);
      ctx.beginPath();
      ctx.arc(startPoint.x, startPoint.y, 4, 0, Math.PI * 2);
      ctx.arc(targetPoint.x, targetPoint.y, 4, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const hover = hoverRef.current;
    if (!hover) {
      return;
    }
    const hoveredTriangle = collapsedTriangleHitsRef.current.find((triangle) => (
      triangle.node === hover.node
      && pointInCollapsedTriangleHitArea(hover.screenX, hover.screenY, triangle.points)
    ));
    if (hoveredTriangle) {
      ctx.beginPath();
      ctx.moveTo(hoveredTriangle.points[0].x, hoveredTriangle.points[0].y);
      for (let index = 1; index < hoveredTriangle.points.length; index += 1) {
        ctx.lineTo(hoveredTriangle.points[index].x, hoveredTriangle.points[index].y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(37, 99, 235, 0.16)";
      ctx.strokeStyle = HOVER_COLOR;
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      return;
    }
    const parent = tree.buffers.parent[hover.node];
    if (parent < 0) {
      return;
    }

    ctx.strokeStyle = HOVER_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (viewMode === "spiral" && camera.kind === "circular") {
      const visibleRankCount = spiralVisibleTaxonomyRanksForScale(camera.scale).length;
      const metrics = spiralMetricsForScale(visibleRankCount, camera.scale);
      const ownerNode = hover.targetKind === "connector" && hover.ownerNode !== undefined ? hover.ownerNode : parent;
      const childTheta = spiralThetaForY(layout.center[hover.node], tree.leafCount, metrics);
      const ownerTheta = spiralThetaForY(layout.center[ownerNode], tree.leafCount, metrics);
      const path = new Path2D();
      if (hover.targetKind === "connector") {
        appendSpiralCurve(
          path,
          Math.min(ownerTheta, childTheta),
          Math.max(ownerTheta, childTheta),
          spiralAgeForDepth(tree, tree.buffers.depth[ownerNode], metrics),
          metrics,
          Math.max(camera.scale, 1e-6),
        );
      }
      const stemStart = spiralPointAt(childTheta, spiralAgeForDepth(tree, tree.buffers.depth[ownerNode], metrics), metrics);
      const stemEnd = spiralPointAt(childTheta, spiralAgeForDepth(tree, tree.buffers.depth[hover.node], metrics), metrics);
      path.moveTo(stemStart.x, stemStart.y);
      path.lineTo(stemEnd.x, stemEnd.y);
      ctx.save();
      ctx.translate(camera.translateX, camera.translateY);
      ctx.scale(camera.scale, camera.scale);
      ctx.rotate(camera.rotation);
      ctx.lineWidth = 2 / Math.max(camera.scale, 1e-6);
      ctx.stroke(path);
      ctx.restore();
      return;
    }
    if (camera.kind === "rect") {
      if (hover.targetKind === "connector" && hover.ownerNode !== undefined) {
        const ownerY = layout.center[hover.ownerNode];
        const childY = layout.center[hover.node];
        const connectorSpanPx = Math.abs(childY - ownerY) * camera.scaleY;
        if (connectorSpanPx >= 1) {
          const connectorStart = worldToScreenRect(
            camera,
            tree.buffers.depth[hover.ownerNode],
            Math.min(ownerY, childY),
          );
          const connectorEnd = worldToScreenRect(
            camera,
            tree.buffers.depth[hover.ownerNode],
            Math.max(ownerY, childY),
          );
          ctx.moveTo(connectorStart.x, connectorStart.y);
          ctx.lineTo(connectorEnd.x, connectorEnd.y);
        }
        const start = worldToScreenRect(camera, tree.buffers.depth[hover.ownerNode], childY);
        const end = worldToScreenRect(camera, tree.buffers.depth[hover.node], childY);
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
      } else {
        const parentY = layout.center[parent];
        const childY = layout.center[hover.node];
        if (Math.abs(childY - parentY) > 1e-6) {
          const connectorStart = worldToScreenRect(camera, tree.buffers.depth[parent], Math.min(parentY, childY));
          const connectorEnd = worldToScreenRect(camera, tree.buffers.depth[parent], Math.max(parentY, childY));
          ctx.moveTo(connectorStart.x, connectorStart.y);
          ctx.lineTo(connectorEnd.x, connectorEnd.y);
        }
        const start = worldToScreenRect(camera, tree.buffers.depth[parent], childY);
        const end = worldToScreenRect(camera, tree.buffers.depth[hover.node], childY);
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
      }
      ctx.stroke();
      return;
    }

    const childTheta = polarThetaFor(layout.center, hover.node);
    if (hover.targetKind === "connector" && hover.ownerNode !== undefined) {
      const ownerTheta = polarThetaFor(layout.center, hover.ownerNode);
      const ownerArcStart = polarThetaFor(layout.min, hover.ownerNode);
      const ownerArcEnd = polarThetaFor(layout.max, hover.ownerNode);
      const ownerArcLength = Math.max(0, ownerArcEnd - ownerArcStart);
      const arcSpan = arcSubspanWithinSpan(ownerTheta, childTheta, ownerArcStart, ownerArcLength);
      const radiusPx = axisDepth(tree.buffers.depth[hover.ownerNode]) * camera.scale;
      const connectorSpanPx = (arcSpan?.length ?? 0) * radiusPx;
      if (arcSpan && radiusPx >= 0.25 && connectorSpanPx >= 1) {
        ctx.moveTo(
          camera.translateX + Math.cos(arcSpan.start + camera.rotation) * radiusPx,
          camera.translateY + Math.sin(arcSpan.start + camera.rotation) * radiusPx,
        );
        ctx.arc(camera.translateX, camera.translateY, radiusPx, arcSpan.start + camera.rotation, arcSpan.end + camera.rotation, false);
      }
      const startWorld = polarToCartesian(axisDepth(tree.buffers.depth[hover.ownerNode]), childTheta);
      const endWorld = polarToCartesian(axisDepth(tree.buffers.depth[hover.node]), childTheta);
      const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
      const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
    } else {
      const parentTheta = polarThetaFor(layout.center, parent);
      if (Math.abs(childTheta - parentTheta) > 1e-6) {
        const arcStart = polarThetaFor(layout.min, parent);
        const arcEnd = polarThetaFor(layout.max, parent);
        const arcLength = Math.max(0, arcEnd - arcStart);
        const arcSpan = arcSubspanWithinSpan(parentTheta, childTheta, arcStart, arcLength);
        const radiusPx = axisDepth(tree.buffers.depth[parent]) * camera.scale;
        const connectorSpanPx = (arcSpan?.length ?? 0) * radiusPx;
        if (arcSpan && radiusPx >= 0.25 && connectorSpanPx >= 1) {
          ctx.moveTo(
            camera.translateX + Math.cos(arcSpan.start + camera.rotation) * radiusPx,
            camera.translateY + Math.sin(arcSpan.start + camera.rotation) * radiusPx,
          );
          ctx.arc(camera.translateX, camera.translateY, radiusPx, arcSpan.start + camera.rotation, arcSpan.end + camera.rotation, false);
        }
      }
      const startWorld = polarToCartesian(axisDepth(tree.buffers.depth[parent]), childTheta);
      const endWorld = polarToCartesian(axisDepth(tree.buffers.depth[hover.node]), childTheta);
      const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
      const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
    }
    ctx.stroke();
  }, [axisDepth, collapsedView, order, polarThetaFor, size.height, size.width, spiralMetricsForScale, spiralVisibleTaxonomyRanksForScale, tree, viewMode]);

  const clearDistanceMeasurement = useCallback((): void => {
    distanceStartNodeRef.current = null;
    distanceStartAncestorsRef.current.clear();
    distanceMeasurementRef.current = null;
    updateDistanceTooltip(null);
    if (canvasRef.current) {
      canvasRef.current.style.cursor = "";
    }
    drawHoverHighlightOverlay();
  }, [drawHoverHighlightOverlay, updateDistanceTooltip]);

  const beginDistanceMeasurement = useCallback((startNode: number, screenX: number, screenY: number): void => {
    if (!tree || startNode < 0 || startNode >= tree.nodeCount) {
      return;
    }
    const ancestors = new Set<number>();
    for (let node = startNode; node >= 0; node = tree.buffers.parent[node]) {
      ancestors.add(node);
    }
    distanceStartNodeRef.current = startNode;
    distanceStartAncestorsRef.current = ancestors;
    const measurement: DistanceMeasurement = {
      startNode,
      targetNode: startNode,
      mrcaNode: startNode,
      distance: 0,
      screenX,
      screenY,
    };
    distanceMeasurementRef.current = measurement;
    hoverRef.current = null;
    updateHoverTooltip(null);
    onHoverChange(null);
    updateDistanceTooltip(measurement);
    if (canvasRef.current) {
      canvasRef.current.style.cursor = "crosshair";
    }
    drawHoverHighlightOverlay();
  }, [drawHoverHighlightOverlay, onHoverChange, tree, updateDistanceTooltip, updateHoverTooltip]);

  const updateDistanceMeasurementTarget = useCallback((targetNode: number, screenX: number, screenY: number): void => {
    const startNode = distanceStartNodeRef.current;
    if (!tree || startNode === null || targetNode < 0 || targetNode >= tree.nodeCount) {
      return;
    }
    let mrcaNode = targetNode;
    while (mrcaNode >= 0 && !distanceStartAncestorsRef.current.has(mrcaNode)) {
      mrcaNode = tree.buffers.parent[mrcaNode];
    }
    if (mrcaNode < 0) {
      mrcaNode = tree.root;
    }
    const measurement: DistanceMeasurement = {
      startNode,
      targetNode,
      mrcaNode,
      distance: tree.buffers.depth[startNode]
        + tree.buffers.depth[targetNode]
        - (2 * tree.buffers.depth[mrcaNode]),
      screenX,
      screenY,
    };
    distanceMeasurementRef.current = measurement;
    updateDistanceTooltip(measurement);
    drawHoverHighlightOverlay();
  }, [drawHoverHighlightOverlay, tree, updateDistanceTooltip]);

  const circularClampExtraRadiusPx = useCallback((camera: CircularCamera) => {
    const maxRadius = Math.max(polarOuterRadius, tree?.branchLengthMinPositive ?? 1);
    const angularSpacingPx = (
      camera.scale
      * maxRadius
      * (polarAngleSpan / polarLeafDivisor)
      * (collapsedView?.effectiveLeafScale ?? 1)
    );
    const microTipFontSize = scaleLabelFontSize("tip", Math.max(4.2, Math.min(6.1, angularSpacingPx * 0.3)));
    const tipFontSize = scaleLabelFontSize("tip", Math.max(6.5, Math.min(20, angularSpacingPx * 0.74)));
    const readableBandProgress = smoothstep01((angularSpacingPx - 2.9) / Math.max(1e-6, 4.5 - 2.9));
    const tipBandFontSize = angularSpacingPx <= 2.9
      ? 0
      : microTipFontSize + ((tipFontSize - microTipFontSize) * readableBandProgress);
    const genusFontSize = scaleLabelFontSize("genus", Math.max(10, Math.min(18, Math.max(angularSpacingPx * 0.92, 10))));
    const microBandWidthPx = estimateLabelWidth(Math.max(microTipFontSize, 4.2), reservedTipLabelCharacters);
    const readableBandWidthPx = estimateLabelWidth(Math.max(tipFontSize, 6.5), reservedTipLabelCharacters);
    const tipBandWidthPx = showTipLabels
      ? interpolateTipBandWidthPx(angularSpacingPx, 1.6, 2.9, 4.5, microBandWidthPx, readableBandWidthPx)
      : 0;
    if (taxonomyEnabled) {
      if (taxonomyBlocks) {
        const visibleRanks = useAutomaticTaxonomyRankVisibility
          ? taxonomyVisibleRanksForZoom(angularSpacingPx, taxonomyActiveRanks)
          : taxonomyActiveRanks;
        const hasLabelOnlyRank = visibleRanks.some((rank) => taxonomyRankDisplayModeForRank(rank) === "label-only");
        const reservedRankCount = hasLabelOnlyRank
          ? visibleRanks.length + 1
          : visibleRanks.length;
        const taxonomyMetricBaseSize = Math.max(9, Math.min(14, Math.max(angularSpacingPx * 0.48, 9)));
        const metrics = taxonomyRingMetricsPx(
          reservedRankCount,
          taxonomyMetricBaseSize,
          taxonomyBandThicknessScale,
          circularOverlayViewportScale,
          thickenOutermostTaxonomyRibbon,
        );
        const taxonomyWidthPx = metrics.ringWidthsPx.reduce((total, width) => total + width, 0)
          + (Math.max(0, reservedRankCount - 1) * metrics.ringGapPx)
          + metrics.labelGapPx
          + controlledRibbonGapPx(
            taxonomyGapControl,
            taxonomyBaselineGapPx + metrics.ringGapPx,
            tipBandWidthPx,
          )
          + 26
          + Math.max(0, figureStyles.tip.offsetPx);
        return taxonomyWidthPx;
      }
      if (!showGenusLabels) {
        return tipBandWidthPx + 64 + Math.max(0, figureStyles.tip.offsetPx);
      }
    }
    const labelFontSize = Math.max(4.5, Math.min(20, Math.max(genusFontSize, tipBandFontSize)));
    const genusLabelWidthPx = estimateLabelWidth(labelFontSize, maxGenusLabelCharacters);
    return Math.max(genusLabelWidthPx, tipBandWidthPx) + 120 + Math.max(0, figureStyles.tip.offsetPx, figureStyles.genus.offsetPx);
  }, [circularOverlayViewportScale, collapsedView?.effectiveLeafScale, figureStyles.genus.offsetPx, figureStyles.tip.offsetPx, maxGenusLabelCharacters, polarAngleSpan, polarLeafDivisor, polarOuterRadius, reservedTipLabelCharacters, scaleLabelFontSize, showGenusLabels, showTipLabels, taxonomyActiveRanks, taxonomyBandThicknessScale, taxonomyBaselineGapPx, taxonomyBlocks, taxonomyEnabled, taxonomyGapControl, taxonomyRankDisplayModeForRank, thickenOutermostTaxonomyRibbon, tree, useAutomaticTaxonomyRankVisibility]);

  const circularFitLabelEnvelopePx = useCallback((camera: CircularCamera): number => {
    if (!tree || taxonomyEnabled) {
      return 0;
    }
    const maxRadius = Math.max(polarOuterRadius, tree.branchLengthMinPositive);
    const angularSpacingPx = (
      camera.scale
      * maxRadius
      * (polarAngleSpan / polarLeafDivisor)
      * (collapsedView?.effectiveLeafScale ?? 1)
    );
    const microTipFontSize = scaleLabelFontSize("tip", Math.max(4.2, Math.min(6.1, angularSpacingPx * 0.3)));
    const tipFontSize = scaleLabelFontSize("tip", Math.max(6.5, Math.min(20, angularSpacingPx * 0.74)));
    const readableBandProgress = smoothstep01((angularSpacingPx - 2.9) / Math.max(1e-6, 4.5 - 2.9));
    const tipBandFontSize = angularSpacingPx <= 2.9
      ? 0
      : microTipFontSize + ((tipFontSize - microTipFontSize) * readableBandProgress);
    const microBandWidthPx = estimateLabelWidth(Math.max(microTipFontSize, 4.2), reservedTipLabelCharacters);
    const readableBandWidthPx = estimateLabelWidth(Math.max(tipFontSize, 6.5), reservedTipLabelCharacters);
    const tipBandWidthPx = showTipLabels
      ? interpolateTipBandWidthPx(angularSpacingPx, 1.6, 2.9, 4.5, microBandWidthPx, readableBandWidthPx)
      : 0;
    const tipAnchorGapPx = angularSpacingPx > 2.9 ? 20 : 11;
    let renderedTipLabelWidthPx = 0;
    if (showTipLabels && angularSpacingPx > 2.9) {
      const renderedTipFontSize = angularSpacingPx > 4.5 ? tipFontSize : microTipFontSize;
      let maxRenderedTipCharacters = 0;
      for (let index = 0; index < tree.leafNodes.length; index += 1) {
        const node = tree.leafNodes[index];
        maxRenderedTipCharacters = Math.max(
          maxRenderedTipCharacters,
          displayLabelText(tree.names[node] || "", `tip-${node}`).length,
        );
      }
      renderedTipLabelWidthPx = maxRenderedTipCharacters * renderedTipFontSize * 0.61;
    }
    let envelopePx = renderedTipLabelWidthPx > 0
      ? tipAnchorGapPx + renderedTipLabelWidthPx
      : 0;

    if (showGenusLabels && cache) {
      const polarLayout = collapsedView?.layout ?? tree.layouts[order];
      const baseFontSize = scaleLabelFontSize("genus", Math.max(10, Math.min(18, Math.max(angularSpacingPx * 0.92, 10))));
      const tipLabelPressure = clamp01((angularSpacingPx - 4) / 4);
      const lineGapPx = Math.max(12, tipBandFontSize * 1.9);
      const lineRadiusPx = (maxRadius * camera.scale) + tipAnchorGapPx + tipBandWidthPx + lineGapPx;
      const labelAnchorOffsetPx = tipAnchorGapPx + tipBandWidthPx + lineGapPx;
      const blocks = cache.genusBlocks[order];
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        const startTheta = polarThetaFor(polarLayout.center, block.firstNode);
        const endTheta = polarThetaFor(polarLayout.center, block.lastNode);
        const angularSpan = Math.max(0, endTheta >= startTheta
          ? endTheta - startTheta
          : (endTheta + (Math.PI * 2)) - startTheta);
        const preliminaryArcLengthPx = lineRadiusPx * angularSpan;
        const fontGrowth = 0.018 - (0.007 * tipLabelPressure);
        const maxFontSize = 22 + (2 * tipLabelPressure);
        const fontSize = Math.max(baseFontSize, Math.min(maxFontSize, baseFontSize + (preliminaryArcLengthPx * fontGrowth)));
        envelopePx = Math.max(
          envelopePx,
          labelAnchorOffsetPx
            + fontSize
            + 14
            + estimateLabelWidth(fontSize, block.label.length),
        );
      }
    }

    return envelopePx + Math.max(0, figureStyles.tip.offsetPx, figureStyles.genus.offsetPx);
  }, [cache, collapsedView?.effectiveLeafScale, collapsedView?.layout, figureStyles.genus.offsetPx, figureStyles.tip.offsetPx, order, polarAngleSpan, polarLeafDivisor, polarOuterRadius, reservedTipLabelCharacters, scaleLabelFontSize, showGenusLabels, showTipLabels, taxonomyEnabled, tree]);

  const finalizeCircularCamera = useCallback((camera: CircularCamera) => {
    if (!tree) {
      return;
    }
    const clampRadiusWorld = viewMode === "spiral"
      ? spiralMetricsForScale(
        spiralVisibleTaxonomyRanksForScale(camera.scale).length,
        camera.scale,
      ).outerRadius
      : Math.max(polarOuterRadius, tree.branchLengthMinPositive);
    clampCircularCamera(camera, tree, size.width, size.height, circularClampExtraRadiusPx(camera), clampRadiusWorld);
    clampCircularCamera(camera, tree, size.width, size.height, circularClampExtraRadiusPx(camera), clampRadiusWorld);
  }, [circularClampExtraRadiusPx, polarOuterRadius, size.height, size.width, spiralMetricsForScale, spiralVisibleTaxonomyRanksForScale, tree, viewMode]);

  const fitPolarCamera = useCallback((mode: ViewMode, extraRadiusPx = 0): CircularCamera | null => {
    if (!tree) {
      return null;
    }
    const boundedRadialOverlayMarginPx = Math.min(
      Math.max(0, extraRadiusPx),
      size.width * (size.width < 600 ? 0.22 : 0.14),
      size.height * 0.3,
    );
    if (mode === "spiral") {
      return fitCircularCamera(size.width, size.height, tree, circularRotation);
    }
    if (!isPartialRadial && polarInnerRadius <= 1e-9 && boundedRadialOverlayMarginPx <= 0) {
      return fitCircularCamera(size.width, size.height, tree, circularRotation);
    }
    return fitRadialCamera(
      size.width,
      size.height,
      tree,
      polarAngleStart,
      polarAngleSpan,
      polarInnerRadius,
      polarOuterRadius,
      circularRotation,
      boundedRadialOverlayMarginPx,
    );
  }, [circularRotation, isPartialRadial, polarAngleSpan, polarAngleStart, polarInnerRadius, polarOuterRadius, size.height, size.width, tree]);

  const rectTaxonomyZoom = useCallback((scaleY: number): number => {
    if (!tree || !(scaleY > 0)) {
      return scaleY;
    }
    const fitRect = fitRectCamera(size.width, size.height, tree);
    const fitRectScaleY = Math.max(fitRect.scaleY, 1e-6);
    let fitCircular = fitPolarCamera(viewMode) ?? fitCircularCamera(size.width, size.height, tree, circularRotation);
    if (taxonomyEnabled && taxonomyBlocks) {
      const radius = Math.max(polarOuterRadius, tree.branchLengthMinPositive);
      for (let iteration = 0; iteration < 2; iteration += 1) {
        const extra = circularClampExtraRadiusPx(fitCircular);
        if (isPartialRadial || polarInnerRadius > 0) {
          fitCircular = fitPolarCamera(viewMode, extra) ?? fitCircular;
        } else {
          const availableRadiusPx = Math.max(circularFitMinTreeRadiusPx(size.width, size.height), (Math.min(size.width, size.height) * 0.44) - extra);
          fitCircular.scale = availableRadiusPx / radius;
        }
      }
      finalizeCircularCamera(fitCircular);
    }
    const maxRadius = Math.max(polarOuterRadius, tree.branchLengthMinPositive);
    const fitCircularSpacing = fitCircular.scale * maxRadius * (
      polarAngleSpan / polarLeafDivisor
    );
    if (!(fitCircularSpacing > 0)) {
      return scaleY;
    }
    if (scaleY <= fitRectScaleY) {
      return fitCircularSpacing;
    }
    return scaleY * (fitCircularSpacing / fitRectScaleY);
  }, [
    circularClampExtraRadiusPx,
    circularRotation,
    fitPolarCamera,
    finalizeCircularCamera,
    isPartialRadial,
    size.height,
    size.width,
    taxonomyBlocks,
    taxonomyEnabled,
    polarInnerRadius,
    polarLeafDivisor,
    polarOuterRadius,
    tree,
    viewMode,
    polarAngleSpan,
  ]);

  const rectVisibleTaxonomyRanksForScaleY = useCallback((scaleY: number): TaxonomyRank[] => {
    if (!useAutomaticTaxonomyRankVisibility) {
      return taxonomyActiveRanks;
    }
    const effectiveZoom = rectTaxonomyZoom(scaleY);
    return withSupplementalTaxonomyRanks(taxonomyVisibleRanksForZoom(effectiveZoom, automaticTaxonomyRanks));
  }, [automaticTaxonomyRanks, rectTaxonomyZoom, taxonomyActiveRanks, useAutomaticTaxonomyRankVisibility, withSupplementalTaxonomyRanks]);

  const rectClampPadding = useCallback((camera: RectCamera) => {
    const effectiveTipSpacingPx = camera.scaleY * (collapsedView?.effectiveLeafScale ?? 1);
    const microTipFontSize = scaleLabelFontSize("tip", Math.max(4.2, Math.min(6.25, effectiveTipSpacingPx * 0.34)));
    const tipFontSize = scaleLabelFontSize("tip", Math.max(6.5, Math.min(22, effectiveTipSpacingPx * 0.58)));
    const readableBandProgress = smoothstep01((effectiveTipSpacingPx - 2.7) / Math.max(1e-6, 4.2 - 2.7));
    const tipBandFontSize = effectiveTipSpacingPx <= 2.7
      ? 0
      : microTipFontSize + ((tipFontSize - microTipFontSize) * readableBandProgress);
    const genusFontSize = scaleLabelFontSize("genus", Math.max(10, Math.min(18, camera.scaleY * 0.42)));
    const microBandWidthPx = estimateLabelWidth(Math.max(microTipFontSize, 4.2), reservedTipLabelCharacters);
    const readableBandWidthPx = estimateLabelWidth(Math.max(tipFontSize, 6.5), reservedTipLabelCharacters);
    const defaultTipBandWidthPx = showTipLabels
      ? interpolateTipBandWidthPx(effectiveTipSpacingPx, 1.55, 2.7, 4.2, microBandWidthPx, readableBandWidthPx)
      : 0;
    const renderedTipFontSize = effectiveTipSpacingPx > 4.2 ? tipFontSize : microTipFontSize;
    const naturalTipBandWidthPx = showTipLabels && effectiveTipSpacingPx > 2.7
      ? estimateLabelWidth(renderedTipFontSize, maxTipLabelCharacters)
      : 0;
    const configuredTipBandWidthPx = figureStyles.tip.limitWidth
      ? Math.min(naturalTipBandWidthPx, Math.max(40, figureStyles.tip.maxWidthPx ?? 240))
      : naturalTipBandWidthPx;
    const tipBandWidthPx = Math.max(defaultTipBandWidthPx, configuredTipBandWidthPx);
    const tipTableWidthPx = metadataTipTableData && metadataTipTableData.columns.length > 0
      ? (metadataTipTableMode === "bars"
        ? metadataTipTableBarWidthPx + 36
        : (metadataTipTableData.columns.length * metadataTipTableCellWidthPx) + 36)
      : 0;
    const tipTableMaxHeaderCharacters = metadataTipTableData?.columns.reduce(
      (maximum, column) => Math.max(maximum, column.label.length),
      0,
    ) ?? 0;
    const tipTableTopPx = tipTableWidthPx > 0
      ? Math.max(76, Math.min(160, (estimateLabelWidth(11, tipTableMaxHeaderCharacters) * Math.SQRT1_2) + 24))
      : 0;
    if (taxonomyEnabled && taxonomyBlocks) {
      const visibleRanks = rectVisibleTaxonomyRanksForScaleY(camera.scaleY);
      const taxonomyMetricBaseSize = Math.max(8.5, Math.min(18, 8.5 + (camera.scaleY * 0.45)));
      const metrics = taxonomyRingMetricsPx(
        visibleRanks.length,
        taxonomyMetricBaseSize,
        taxonomyBandThicknessScale,
        1,
        thickenOutermostTaxonomyRibbon,
      );
      const taxonomyWidthPx = metrics.ringWidthsPx.reduce((total, width) => total + width, 0)
        + (Math.max(0, visibleRanks.length - 1) * metrics.ringGapPx)
        + metrics.ringGapPx
        + controlledRibbonGapPx(taxonomyGapControl, taxonomyBaselineGapPx, tipBandWidthPx)
        + 40
        + Math.max(0, figureStyles.tip.offsetPx);
      return {
        right: taxonomyWidthPx + 60 + tipTableWidthPx,
        top: tipTableTopPx,
      };
    }
    const labelFontSize = Math.max(4.5, Math.min(22, Math.max(genusFontSize, tipBandFontSize)));
    const genusLabelWidthPx = estimateLabelWidth(labelFontSize, maxGenusLabelCharacters);
    return {
      right: Math.max(genusLabelWidthPx, tipBandWidthPx) + 140 + Math.max(0, figureStyles.tip.offsetPx, figureStyles.genus.offsetPx) + tipTableWidthPx,
      top: tipTableTopPx,
    };
  }, [collapsedView?.effectiveLeafScale, figureStyles.genus.offsetPx, figureStyles.tip.limitWidth, figureStyles.tip.maxWidthPx, figureStyles.tip.offsetPx, maxGenusLabelCharacters, maxTipLabelCharacters, metadataTipTableBarWidthPx, metadataTipTableCellWidthPx, metadataTipTableData, metadataTipTableMode, rectVisibleTaxonomyRanksForScaleY, reservedTipLabelCharacters, scaleLabelFontSize, showTipLabels, taxonomyBandThicknessScale, taxonomyBaselineGapPx, taxonomyBlocks, taxonomyEnabled, taxonomyGapControl, thickenOutermostTaxonomyRibbon]);

  const fitCameraForMode = useCallback((mode: ViewMode): CameraState | null => {
    if (!tree) {
      return null;
    }
    let nextCamera = mode === "rectangular"
      ? fitRectCamera(size.width, size.height, tree)
      : fitPolarCamera(mode) ?? fitCircularCamera(size.width, size.height, tree, circularRotation);
    if (mode === "spiral" && nextCamera.kind === "circular") {
      const visibleRankCount = mode === "spiral" ? visibleSpiralTaxonomyRanks.length : taxonomyEnabled && taxonomyBlocks && taxonomyActiveRanks.length > 0
        ? taxonomyActiveRanks.length
        : 0;
      const fitRadiusPx = Math.min(size.width, size.height) * 0.46;
      let fitScale = fitRadiusPx / Math.max(
        buildSpiralMetrics(
          tree,
          spiralTurns,
          visibleRankCount,
          taxonomyBandThicknessScale,
          effectiveTimeAxisLogBase,
        ).outerRadius,
        1e-9,
      );
      for (let iteration = 0; iteration < 3; iteration += 1) {
        fitScale = fitRadiusPx / Math.max(spiralMetricsForScale(visibleRankCount, fitScale).outerRadius, 1e-9);
      }
      nextCamera.scale = fitScale;
      nextCamera.translateX = size.width * 0.5;
      nextCamera.translateY = size.height * 0.5;
      finalizeCircularCamera(nextCamera);
      return nextCamera;
    }
    if (nextCamera.kind === "rect") {
      const padding = rectClampPadding(nextCamera);
      const usableWidth = Math.max(1, size.width - 32 - (padding.right ?? 0));
      const usableHeight = Math.max(1, size.height - (padding.top ?? 0) - 58);
      nextCamera.scaleX = Math.min(nextCamera.scaleX, usableWidth / Math.max(effectiveTimeAxisScale === "log" ? timeAxisExtent : tree.maxDepth, tree.branchLengthMinPositive));
      nextCamera.scaleY = Math.min(nextCamera.scaleY, usableHeight / Math.max(1, tree.leafCount - 1));
      nextCamera.translateX = 32;
      nextCamera.translateY = Math.max(24, padding.top ?? 0);
      clampRectCamera(nextCamera, tree, size.width, size.height, padding);
    } else if (mode === "circular" && !taxonomyEnabled) {
      if (isPartialRadial || polarInnerRadius > 0) {
        for (let iteration = 0; iteration < 3; iteration += 1) {
          nextCamera = fitPolarCamera(mode, circularFitLabelEnvelopePx(nextCamera)) ?? nextCamera;
        }
      } else {
        const radius = Math.max(polarOuterRadius, tree.branchLengthMinPositive);
        for (let iteration = 0; iteration < 3; iteration += 1) {
          const labelEnvelopePx = circularFitLabelEnvelopePx(nextCamera);
          const availableRadiusPx = Math.max(
            circularFitMinTreeRadiusPx(size.width, size.height),
            (Math.min(size.width, size.height) * 0.5) - 8 - labelEnvelopePx,
          );
          nextCamera.scale = Math.min(nextCamera.scale, availableRadiusPx / radius);
        }
      }
      finalizeCircularCamera(nextCamera);
    } else if (mode === "fan" || (taxonomyEnabled && taxonomyBlocks)) {
      const radius = Math.max(polarOuterRadius, tree.branchLengthMinPositive);
      for (let iteration = 0; iteration < 2; iteration += 1) {
        const extra = circularClampExtraRadiusPx(nextCamera);
        if (isPartialRadial || polarInnerRadius > 0) {
          nextCamera = fitPolarCamera(mode, extra) ?? nextCamera;
        } else {
          const availableRadiusPx = Math.max(circularFitMinTreeRadiusPx(size.width, size.height), (Math.min(size.width, size.height) * 0.44) - extra);
          nextCamera.scale = availableRadiusPx / radius;
        }
      }
      finalizeCircularCamera(nextCamera);
    }
    return nextCamera;
  }, [circularClampExtraRadiusPx, circularFitLabelEnvelopePx, circularRotation, effectiveTimeAxisLogBase, effectiveTimeAxisScale, finalizeCircularCamera, fitPolarCamera, isPartialRadial, polarInnerRadius, polarOuterRadius, rectClampPadding, size.height, size.width, spiralMetricsForScale, spiralTurns, taxonomyActiveRanks.length, taxonomyBandThicknessScale, taxonomyBlocks, taxonomyEnabled, timeAxisExtent, tree, visibleSpiralTaxonomyRanks.length]);

  const cameraApproximatelyMatchesFit = useCallback((camera: CameraState, mode: ViewMode): boolean => {
    const fit = fitCameraForMode(camera.kind === "rect" ? "rectangular" : mode);
    if (!fit || fit.kind !== camera.kind) {
      return false;
    }
    if (camera.kind === "rect" && fit.kind === "rect") {
      return (
        Math.abs(camera.scaleX - fit.scaleX) <= (fit.scaleX * 0.03)
        && Math.abs(camera.scaleY - fit.scaleY) <= (fit.scaleY * 0.03)
      );
    }
    if (camera.kind === "circular" && fit.kind === "circular") {
      return (
        Math.abs(camera.scale - fit.scale) <= (fit.scale * 0.03)
        && Math.abs(camera.rotation - fit.rotation) <= 1e-6
      );
    }
    return false;
  }, [fitCameraForMode]);

  const fitCamera = useCallback(() => {
    const nextCamera = fitCameraForMode(viewMode);
    if (nextCamera) {
      cameraRef.current = nextCamera;
      if (collapsedNodeModes.size > 0) {
        setCollapsedLayoutRevision((current) => current + 1);
      }
    }
    pendingCircularTaxonomyRefitRef.current = (viewMode === "circular" || viewMode === "fan") && taxonomyEnabled && !taxonomyBlocks;
  }, [collapsedNodeModes.size, fitCameraForMode, taxonomyBlocks, taxonomyEnabled, viewMode]);

  const restoreRectSessionCamera = useCallback((camera: RectCamera, restoreState: TreeCanvasSessionState): RectCamera | null => {
    if (!tree) {
      return null;
    }
    const savedWidth = Number(restoreState.viewportWidth);
    const savedHeight = Number(restoreState.viewportHeight);
    if (!(savedWidth > 0) || !(savedHeight > 0)) {
      return compactCircularOverlayScale(size.width, size.height) < 1 ? fitRectCamera(size.width, size.height, tree) : { ...camera };
    }
    const centerWorldX = ((savedWidth * 0.5) - camera.translateX) / Math.max(camera.scaleX, 1e-9);
    const centerWorldY = ((savedHeight * 0.5) - camera.translateY) / Math.max(camera.scaleY, 1e-9);
    return {
      ...camera,
      scaleX: camera.scaleX * (size.width / savedWidth),
      scaleY: camera.scaleY * (size.height / savedHeight),
      translateX: (size.width * 0.5) - (centerWorldX * camera.scaleX * (size.width / savedWidth)),
      translateY: (size.height * 0.5) - (centerWorldY * camera.scaleY * (size.height / savedHeight)),
    };
  }, [size.height, size.width, tree]);

  const restoreCircularSessionCamera = useCallback((camera: CircularCamera, restoreState: TreeCanvasSessionState): CircularCamera | null => {
    if (!tree) {
      return null;
    }
    const savedWidth = Number(restoreState.viewportWidth);
    const savedHeight = Number(restoreState.viewportHeight);
    if (!(savedWidth > 0) || !(savedHeight > 0)) {
      if (compactCircularOverlayScale(size.width, size.height) < 1) {
        const fit = fitCameraForMode(viewMode);
        return fit?.kind === "circular" ? fit : null;
      }
      return { ...camera };
    }
    const safeScale = Math.max(camera.scale, 1e-9);
    const savedDx = ((savedWidth * 0.5) - camera.translateX) / safeScale;
    const savedDy = ((savedHeight * 0.5) - camera.translateY) / safeScale;
    const centerWorld = {
      x: (savedDx * camera.rotationCos) + (savedDy * camera.rotationSin),
      y: (-savedDx * camera.rotationSin) + (savedDy * camera.rotationCos),
    };
    const nextCamera = {
      ...camera,
      scale: camera.scale * (Math.min(size.width, size.height) / Math.max(1, Math.min(savedWidth, savedHeight))),
    };
    setCircularCameraRotation(nextCamera, camera.rotation);
    const rotatedCenter = rotateCircularWorldPoint(nextCamera, centerWorld.x, centerWorld.y);
    nextCamera.translateX = (size.width * 0.5) - (rotatedCenter.x * nextCamera.scale);
    nextCamera.translateY = (size.height * 0.5) - (rotatedCenter.y * nextCamera.scale);
    return nextCamera;
  }, [fitCameraForMode, size.height, size.width, viewMode]);

  const zoomAtPoint = useCallback((localX: number, localY: number, zoom: number): void => {
    if (!tree || !Number.isFinite(zoom) || zoom <= 0) {
      return;
    }
    const camera = cameraRef.current;
    if (!camera) {
      return;
    }
    if (camera.kind === "rect") {
      const world = screenToWorldRect(camera, localX, localY);
      const { scaleX: minScaleX, scaleY: minScaleY } = minRectZoomScales(tree);
      const previousScaleY = camera.scaleY;
      let collapsedZoomAnchor: { node: number; previousScreenY: number } | null = null;
      if (
        zoomAxisMode !== "x"
        && collapsedView
        && collapsedView.visibleTerminalNodes.length > 0
      ) {
        const insertionIndex = lowerBoundLeaves(
          collapsedView.visibleTerminalNodes,
          collapsedView.layout.center,
          world.y,
        );
        let nearestNode = collapsedView.visibleTerminalNodes[
          Math.min(insertionIndex, collapsedView.visibleTerminalNodes.length - 1)
        ];
        if (insertionIndex > 0) {
          const previousNode = collapsedView.visibleTerminalNodes[insertionIndex - 1];
          if (
            Math.abs(collapsedView.layout.center[previousNode] - world.y)
            < Math.abs(collapsedView.layout.center[nearestNode] - world.y)
          ) {
            nearestNode = previousNode;
          }
        }
        collapsedZoomAnchor = {
          node: nearestNode,
          previousScreenY: camera.translateY + (collapsedView.layout.center[nearestNode] * camera.scaleY),
        };
      }
      if (zoomAxisMode !== "y") {
        camera.scaleX = Math.max(minScaleX, camera.scaleX * zoom);
        camera.translateX = localX - (world.x * camera.scaleX);
      }
      if (zoomAxisMode !== "x") {
        camera.scaleY = Math.max(minScaleY, camera.scaleY * zoom);
        camera.translateY = localY - (world.y * camera.scaleY);
        if (collapsedZoomAnchor) {
          const appliedZoom = camera.scaleY / Math.max(previousScaleY, 1e-9);
          pendingCollapsedRectZoomAnchorRef.current = {
            node: collapsedZoomAnchor.node,
            screenY: localY + ((collapsedZoomAnchor.previousScreenY - localY) * appliedZoom),
          };
        }
      }
      clampRectCamera(camera, tree, size.width, size.height, rectClampPadding(camera));
    } else {
      const world = screenToWorldCircular(camera, localX, localY);
      const minScale = minCircularZoomScale(
        tree,
        viewMode === "circular" ? polarOuterRadius : tree.maxDepth,
      );
      const maxScale = maxCircularZoomScale(size.width, size.height, tree, camera.rotation);
      camera.scale = Math.max(minScale, Math.min(maxScale, camera.scale * zoom));
      const rotated = rotateCircularWorldPoint(camera, world.x, world.y);
      camera.translateX = localX - (rotated.x * camera.scale);
      camera.translateY = localY - (rotated.y * camera.scale);
      finalizeCircularCamera(camera);
    }
    if (
      collapsedNodeModes.size > 0
      && (camera.kind === "circular" || zoomAxisMode !== "x")
    ) {
      const updateCollapsedLayout = (): void => {
        setCollapsedLayoutRevision((current) => current + 1);
      };
      if (camera.kind === "rect" && zoomAxisMode !== "x") {
        flushSync(updateCollapsedLayout);
      } else {
        updateCollapsedLayout();
      }
    }
  }, [collapsedNodeModes.size, collapsedView, finalizeCircularCamera, polarOuterRadius, rectClampPadding, size.height, size.width, tree, viewMode, zoomAxisMode]);

  const getTaxonomyBranchColors = useCallback((orderKey: LayoutOrder, colorRanks: TaxonomyRank[]): string[] | null => {
    if (!tree || !taxonomyConsensus || colorRanks.length === 0) {
      return null;
    }
    const key = `${orderKey}:${colorRanks.join("|")}`;
    const cached = taxonomyBranchColorsCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    const blocksByRank = getTaxonomyBlocks(orderKey);
    if (!blocksByRank) {
      return null;
    }
    const built = buildTaxonomyBranchColorArray(tree, taxonomyConsensus, blocksByRank, taxonomyColors, colorRanks);
    taxonomyBranchColorsCacheRef.current.set(key, built);
    return built;
  }, [getTaxonomyBlocks, taxonomyColors, taxonomyConsensus, tree]);

  const getEffectiveBranchColors = useCallback((orderKey: LayoutOrder, colorRanks: TaxonomyRank[]): string[] | null => {
    if (!tree) {
      return null;
    }
    const key = `${orderKey}:${taxonomyBranchColoringEnabled ? colorRanks.join("|") : ""}:${taxonomyColorPalette}:${taxonomyCustomPaletteSignature}:${taxonomyColorRootRank}:${taxonomyColorJitterRank}:${taxonomyColorJitter.toFixed(3)}:${metadataBranchColorVersion}:${manualBranchColorVersion}`;
    const cached = effectiveBranchColorsCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    const baseColors = taxonomyBranchColoringEnabled && colorRanks.length > 0 && !metadataBranchColorsCoverAllBranches
      ? getTaxonomyBranchColors(orderKey, colorRanks)
      : null;
    if (!metadataBranchColorOverlay.hasAny && !manualBranchColorOverlay.hasAny) {
      if (baseColors) {
        effectiveBranchColorsCacheRef.current.set(key, baseColors);
      }
      return baseColors;
    }
    const merged = baseColors ? [...baseColors] : new Array<string>(tree.nodeCount).fill(BRANCH_COLOR);
    if (metadataBranchColorOverlay.hasAny) {
      for (let node = 0; node < tree.nodeCount; node += 1) {
        const externalColor = metadataBranchColorOverlay.colors[node] ?? null;
        if (externalColor) {
          merged[node] = externalColor;
        }
      }
    }
    for (let node = 0; node < tree.nodeCount; node += 1) {
      const override = manualBranchColorOverlay.colors[node] ?? null;
      if (override) {
        merged[node] = override;
      }
    }
    effectiveBranchColorsCacheRef.current.set(key, merged);
    return merged;
  }, [getTaxonomyBranchColors, manualBranchColorOverlay, manualBranchColorVersion, metadataBranchColorOverlay, metadataBranchColorVersion, metadataBranchColorsCoverAllBranches, taxonomyBranchColoringEnabled, taxonomyColorJitter, taxonomyColorJitterRank, taxonomyColorPalette, taxonomyColorRootRank, taxonomyCustomPaletteSignature, tree]);

  const getCircularTaxonomyPaths = useCallback((
    orderKey: LayoutOrder,
    layout: TreeModel["layouts"][LayoutOrder],
    cacheKey: string,
    branchColors: string[] | null,
  ): CircularTaxonomyPathCache | null => {
    if (!tree || !cache || !branchColors || !cacheKey) {
      return null;
    }
    const key = `${orderKey}:${effectiveTimeAxisScale}:${polarAngleStart}:${polarAngleSpan}:${polarInnerRadius}:${cacheKey}`;
    const cached = circularTaxonomyPathCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    const built = buildCircularTaxonomyPaths(
      tree,
      layout,
      cache.orderedChildren[orderKey],
      branchColors,
      (node) => axisDepth(tree.buffers.depth[node]),
      polarAngleStart,
      polarAngleSpan,
    );
    circularTaxonomyPathCacheRef.current.set(key, built);
    return built;
  }, [axisDepth, cache, effectiveTimeAxisScale, polarAngleSpan, polarAngleStart, polarInnerRadius, tree]);

  const getCircularBasePath = useCallback((
    orderKey: LayoutOrder,
    layout: TreeModel["layouts"][LayoutOrder],
  ): CircularBranchPathCache | null => {
    if (!tree || !cache) {
      return null;
    }
    const key = `${orderKey}:${effectiveTimeAxisScale}:${polarAngleStart}:${polarAngleSpan}:${polarInnerRadius}`;
    const cached = circularBasePathCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    const built = buildCircularBranchPath(
      tree,
      layout,
      cache.orderedChildren[orderKey],
      (node) => axisDepth(tree.buffers.depth[node]),
      polarAngleStart,
      polarAngleSpan,
    );
    circularBasePathCacheRef.current.set(key, built);
    return built;
  }, [axisDepth, cache, effectiveTimeAxisScale, polarAngleSpan, polarAngleStart, polarInnerRadius, tree]);

  const getRectTaxonomyPaths = useCallback((
    orderKey: LayoutOrder,
    layout: TreeModel["layouts"][LayoutOrder],
    cacheKey: string,
    branchColors: string[] | null,
  ): RectTaxonomyPathCache | null => {
    if (!tree || !cache || !branchColors || !cacheKey) {
      return null;
    }
    const key = `${orderKey}:${effectiveTimeAxisScale}:${cacheKey}`;
    const cached = rectTaxonomyPathCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    const built = buildRectTaxonomyPaths(tree, layout, cache.orderedChildren[orderKey], branchColors, (node) => axisDepth(tree.buffers.depth[node]));
    rectTaxonomyPathCacheRef.current.set(key, built);
    return built;
  }, [axisDepth, cache, effectiveTimeAxisScale, tree]);

  const getRectBasePaths = useCallback((
    orderKey: LayoutOrder,
    layout: TreeModel["layouts"][LayoutOrder],
  ): RectBranchPathCache | null => {
    if (!tree || !cache) {
      return null;
    }
    const key = `${orderKey}:${effectiveTimeAxisScale}`;
    const cached = rectBasePathCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    const built = buildRectBranchPaths(tree, layout, cache.orderedChildren[orderKey], (node) => axisDepth(tree.buffers.depth[node]));
    rectBasePathCacheRef.current.set(key, built);
    return built;
  }, [axisDepth, cache, effectiveTimeAxisScale, tree]);

  const getSpiralBranchPaths = useCallback((
    orderKey: LayoutOrder,
    layout: TreeModel["layouts"][LayoutOrder],
    cacheKey: string,
    branchColors: string[] | null,
    metrics: SpiralMetrics,
    hiddenNodesForView: Uint8Array,
    cameraScale: number,
  ): SpiralBranchPathCache | null => {
    if (!tree || !cache || !cacheKey) {
      return null;
    }
    const largeSpiralTree = tree.leafCount >= 100000;
    const curveMinSamplesPerRadian = largeSpiralTree ? 18 : 90;
    const curveMaxSamplesPerRadian = largeSpiralTree ? Math.max(32, Math.min(96, cameraScale * 12)) : 420;
    const key = `${orderKey}:${cacheKey}:${collapsedView?.signature ?? ""}:${spiralMetricCacheKey(metrics)}:${curveMinSamplesPerRadian}:${curveMaxSamplesPerRadian.toFixed(1)}`;
    const cached = spiralBranchPathCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    if (largeSpiralTree) {
      spiralBranchPathCacheRef.current.clear();
    }
    const built = buildSpiralBranchPathCache(
      tree,
      layout,
      cache.orderedChildren[orderKey],
      hiddenNodesForView,
      collapsedNodes,
      branchColors,
      metrics,
      curveMinSamplesPerRadian,
      curveMaxSamplesPerRadian,
    );
    spiralBranchPathCacheRef.current.set(key, built);
    const maxSpiralBranchCaches = tree.leafCount >= 100000 ? 1 : tree.leafCount >= 50000 ? 2 : 6;
    while (spiralBranchPathCacheRef.current.size > maxSpiralBranchCaches) {
      const oldestKey = spiralBranchPathCacheRef.current.keys().next().value;
      if (oldestKey) {
        spiralBranchPathCacheRef.current.delete(oldestKey);
      } else {
        break;
      }
    }
    return built;
  }, [cache, collapsedNodes, collapsedView?.signature, tree]);

  const getSpiralTaxonomyRibbonPaths = useCallback((
    orderKey: LayoutOrder,
    layout: TreeModel["layouts"][LayoutOrder],
    leafBoundaries: Float64Array | null,
    visibleRanks: TaxonomyRank[],
    metrics: SpiralMetrics,
    taxonomyGapWorld: number,
    excludedFillRanks: TaxonomyRank[] = [],
  ): SpiralTaxonomyRibbonPathCache | null => {
    if (!tree || !taxonomyOverlayBlocks || visibleRanks.length === 0) {
      return null;
    }
    const visibleRankBlockCountsSignature = visibleRanks
      .map((rank) => `${rank}:${taxonomyOverlayBlocks[rank]?.length ?? 0}`)
      .join("|");
    const key = [
      orderKey,
      visibleRanks.join("|"),
      excludedFillRanks.join("|"),
      visibleRankBlockCountsSignature,
      collapsedView?.signature ?? "",
      taxonomyGapWorld.toFixed(5),
      spiralMetricCacheKey(metrics),
    ].join(":");
    const cached = spiralTaxonomyRibbonPathCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    if (tree.leafCount >= 100000) {
      spiralTaxonomyRibbonPathCacheRef.current.clear();
    }
    const built = buildSpiralTaxonomyRibbonPathCache(
      tree,
      layout,
      leafBoundaries,
      taxonomyOverlayBlocks,
      visibleRanks,
      metrics,
      taxonomyGapWorld,
      excludedFillRanks,
    );
    spiralTaxonomyRibbonPathCacheRef.current.set(key, built);
    const maxSpiralTaxonomyCaches = tree.leafCount >= 100000 ? 1 : 6;
    while (spiralTaxonomyRibbonPathCacheRef.current.size > maxSpiralTaxonomyCaches) {
      const oldestKey = spiralTaxonomyRibbonPathCacheRef.current.keys().next().value;
      if (oldestKey) {
        spiralTaxonomyRibbonPathCacheRef.current.delete(oldestKey);
      } else {
        break;
      }
    }
    return built;
  }, [collapsedView?.signature, taxonomyOverlayBlocks, tree]);

  const getCircularTaxonomyBitmapCache = useCallback((
    orderKey: LayoutOrder,
    branchColorKey: string,
    paths: CircularTaxonomyPathCache,
    camera: CircularCamera,
  ): CircularTaxonomyBitmapCache | null => {
    if (typeof document === "undefined" || !tree) {
      return null;
    }
    const clampExtraRadiusPx = Math.max(0, circularClampExtraRadiusPx(camera));
    const baseSignature = [
      orderKey,
      branchColorKey,
      branchStrokeScale.toFixed(3),
      size.width,
      size.height,
      polarAngleStart,
      polarAngleSpan,
      polarInnerRadius,
      camera.rotation.toFixed(6),
      Math.ceil(clampExtraRadiusPx),
    ].join(":");
    const cached = circularTaxonomyBitmapCacheRef.current;
    if (cached?.baseSignature === baseSignature && Math.abs(cached.rotation - camera.rotation) <= 1e-6) {
      const scaleRatio = camera.scale / Math.max(cached.scale, 1e-6);
      if (
        scaleRatio >= 1 / CIRCULAR_TAXONOMY_BITMAP_REUSE_SCALE_MULTIPLIER
        && scaleRatio <= CIRCULAR_TAXONOMY_BITMAP_REUSE_SCALE_MULTIPLIER
      ) {
        return cached;
      }
    }
    // This cache only stores branch strokes, so label padding should not inflate the offscreen bitmap.
    const bitmapScale = camera.scale;
    const maxRadiusPx = (Math.max(polarOuterRadius, tree.branchLengthMinPositive) * bitmapScale) + 8;
    // The camera clamp includes the taxonomy and tip-label envelope. Cover that
    // entire legal translation range even though the bitmap itself stores only
    // branch strokes, or a valid edge pan will fall out of the cache forever.
    const cameraClampRadiusPx = maxRadiusPx + clampExtraRadiusPx;
    const visibleMargin = 56;
    const minTranslateX = visibleMargin - cameraClampRadiusPx;
    const maxTranslateX = size.width - visibleMargin + cameraClampRadiusPx;
    const minTranslateY = visibleMargin - cameraClampRadiusPx;
    const maxTranslateY = size.height - visibleMargin + cameraClampRadiusPx;
    const rangeX = Math.max(0, maxTranslateX - minTranslateX);
    const rangeY = Math.max(0, maxTranslateY - minTranslateY);
    const offscreenWidth = Math.max(1, Math.ceil(size.width + rangeX));
    const offscreenHeight = Math.max(1, Math.ceil(size.height + rangeY));
    const canvas = document.createElement("canvas");
    canvas.width = offscreenWidth;
    canvas.height = offscreenHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    ctx.clearRect(0, 0, offscreenWidth, offscreenHeight);
    ctx.translate(maxTranslateX, maxTranslateY);
    ctx.scale(bitmapScale, bitmapScale);
    ctx.rotate(camera.rotation);
    ctx.lineCap = "butt";
    paths.forEach((pathCache, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = (1.2 * branchStrokeScale) / Math.max(bitmapScale, 1e-6);
      ctx.globalAlpha = 0.95;
      ctx.stroke(pathCache.connectors);
      ctx.stroke(pathCache.stems);
    });
    ctx.globalAlpha = 1;
    const built = {
      baseSignature,
      canvas,
      scale: bitmapScale,
      rotation: camera.rotation,
      sourceOffsetX: maxTranslateX,
      sourceOffsetY: maxTranslateY,
      viewportWidth: size.width,
      viewportHeight: size.height,
    };
    disposeCanvasCache(circularTaxonomyBitmapCacheRef.current);
    circularTaxonomyBitmapCacheRef.current = built;
    return built;
  }, [branchStrokeScale, circularClampExtraRadiusPx, polarAngleSpan, polarAngleStart, polarInnerRadius, polarOuterRadius, size.height, size.width, tree]);

  const getRectTaxonomyBitmapCache = useCallback((
    orderKey: LayoutOrder,
    branchColorKey: string,
    paths: RectTaxonomyPathCache,
    camera: RectCamera,
  ): RectTaxonomyBitmapCache | null => {
    if (typeof document === "undefined" || !tree) {
      return null;
    }
    const baseSignature = [
      orderKey,
      branchColorKey,
      branchStrokeScale.toFixed(3),
      size.width,
      size.height,
    ].join(":");
    const cached = rectTaxonomyBitmapCacheRef.current;
    if (cached?.baseSignature === baseSignature) {
      const scaleRatioX = camera.scaleX / Math.max(cached.scaleX, 1e-6);
      const scaleRatioY = camera.scaleY / Math.max(cached.scaleY, 1e-6);
      const sourceWidth = cached.viewportWidth / Math.max(scaleRatioX, 1e-6);
      const sourceHeight = cached.viewportHeight / Math.max(scaleRatioY, 1e-6);
      const sourceX = cached.paddingX + cached.translateX - (camera.translateX / Math.max(scaleRatioX, 1e-6));
      const sourceY = cached.paddingY + cached.translateY - (camera.translateY / Math.max(scaleRatioY, 1e-6));
      if (
        scaleRatioX >= (1 / RECT_TAXONOMY_BITMAP_REUSE_SCALE_MULTIPLIER)
        && scaleRatioX <= RECT_TAXONOMY_BITMAP_REUSE_SCALE_MULTIPLIER
        && scaleRatioY >= (1 / RECT_TAXONOMY_BITMAP_REUSE_SCALE_MULTIPLIER)
        && scaleRatioY <= RECT_TAXONOMY_BITMAP_REUSE_SCALE_MULTIPLIER
        && sourceX >= 0
        && sourceY >= 0
        && sourceX + sourceWidth <= cached.canvas.width
        && sourceY + sourceHeight <= cached.canvas.height
      ) {
        return cached;
      }
      // Keep interaction responsive; cached vector paths are the fallback outside this bitmap's range.
      return null;
    }
    const paddingX = Math.max(RECT_TAXONOMY_BITMAP_MIN_PADDING_PX, Math.ceil(size.width * 0.45));
    const paddingY = Math.max(RECT_TAXONOMY_BITMAP_MIN_PADDING_PX, Math.ceil(size.height * 0.45));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(size.width + (paddingX * 2)));
    canvas.height = Math.max(1, Math.ceil(size.height + (paddingY * 2)));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.translate(camera.translateX + paddingX, camera.translateY + paddingY);
    ctx.scale(camera.scaleX, camera.scaleY);
    ctx.lineCap = "butt";
    paths.forEach((pathCache, color) => {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = (1.2 * branchStrokeScale) / Math.max(camera.scaleX, 1e-6);
      ctx.stroke(pathCache.connectors);
      ctx.lineWidth = (1.2 * branchStrokeScale) / Math.max(camera.scaleY, 1e-6);
      ctx.stroke(pathCache.stems);
    });
    ctx.globalAlpha = 1;
    const built = {
      baseSignature,
      canvas,
      scaleX: camera.scaleX,
      scaleY: camera.scaleY,
      translateX: camera.translateX,
      translateY: camera.translateY,
      paddingX,
      paddingY,
      viewportWidth: size.width,
      viewportHeight: size.height,
    };
    disposeCanvasCache(rectTaxonomyBitmapCacheRef.current);
    rectTaxonomyBitmapCacheRef.current = built;
    return built;
  }, [branchStrokeScale, size.height, size.width, tree]);

  const setCollapsedNodeMode = useCallback((node: number, mode: CollapsedNodeMode | null) => {
    if (!tree || tree.buffers.firstChild[node] < 0) {
      return;
    }
    const normalizedMode = mode === "preserve-width" && viewMode !== "rectangular"
      ? "minimize"
      : mode;
    setCollapsedNodeModes((current) => {
      const next = new Map(current);
      if (normalizedMode === null) {
        next.delete(node);
      } else {
        next.set(node, normalizedMode);
      }
      return next;
    });
  }, [tree, viewMode]);

  const toggleCollapsedNode = useCallback((node: number) => {
    setCollapsedNodeMode(
      node,
      collapsedNodeModes.has(node)
        ? null
        : viewMode === "rectangular"
          ? "preserve-width"
          : "minimize",
    );
  }, [collapsedNodeModes, setCollapsedNodeMode, viewMode]);

  const spiralScaleForViewContinuity = useCallback((initialScale: number, sourcePixelsPerLeaf: number): number => {
    if (!tree) {
      return initialScale;
    }
    const preserveTipLabels = showTipLabels && sourcePixelsPerLeaf > 4.5;
    let scale = initialScale;
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const visibleRankCount = spiralVisibleTaxonomyRanksForScale(scale).length;
      const metrics = spiralMetricsForScale(visibleRankCount, scale);
      const tipSpacingPx = (
        (metrics.totalArcLength / Math.max(1, tree.leafCount - 1))
        * scale
        * (collapsedView?.effectiveLeafScale ?? 1)
      );
      const taxonomyWidth = visibleRankCount > 0
        ? (visibleRankCount * metrics.taxonomyRibbonWidth)
          + (Math.max(0, visibleRankCount - 1) * metrics.taxonomyRibbonGap)
          + metrics.taxonomyLabelGap
        : 0;
      const interTurnGapPx = Math.max(0, (metrics.pitch - metrics.bandWidth - taxonomyWidth) * scale);
      const rampProgress = smoothstep01(
        (tipSpacingPx - SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX)
        / Math.max(1e-6, 20 - SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX),
      );
      const fontSize = scaleLabelFontSize(
        "tip",
        Math.max(1.8, Math.min(15, 2 + (13 * rampProgress), tipSpacingPx * 0.72)),
      );
      const labelBandWidthPx = estimateLabelWidth(Math.max(fontSize, 1.8), reservedTipLabelCharacters);
      const requiredClearancePx = visibleRankCount > 0
        ? Math.max(0, taxonomyGapControl - 1)
          + taxonomyBaselineGapPx
          + labelBandWidthPx
          + Math.max(0, figureStyles.tip.offsetPx)
        : Math.max(5, fontSize * 0.55)
          + Math.max(0, figureStyles.tip.offsetPx)
          + labelBandWidthPx;
      const spacingContinuityMultiplier = sourcePixelsPerLeaf / Math.max(tipSpacingPx, 1e-6);
      const labelsFit = !preserveTipLabels || (
        tipSpacingPx > SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX
        && interTurnGapPx >= requiredClearancePx
      );
      if (spacingContinuityMultiplier <= 1.001 && labelsFit) {
        break;
      }
      const spacingMultiplier = (SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX + 0.1)
        / Math.max(tipSpacingPx, 1e-6);
      const clearanceMultiplier = (requiredClearancePx + 1) / Math.max(interTurnGapPx, 1e-6);
      scale *= Math.max(
        1.01,
        spacingContinuityMultiplier,
        preserveTipLabels ? spacingMultiplier : 0,
        preserveTipLabels ? clearanceMultiplier : 0,
      );
    }
    return scale;
  }, [collapsedView?.effectiveLeafScale, figureStyles.tip.offsetPx, reservedTipLabelCharacters, scaleLabelFontSize, showTipLabels, spiralMetricsForScale, spiralVisibleTaxonomyRanksForScale, taxonomyBaselineGapPx, taxonomyGapControl, tree]);

  const spiralTaxonomyEnvelopePx = useCallback((scale: number, metrics: SpiralMetrics): number => {
    if (
      !tree
      || !taxonomyEnabled
      || !taxonomyMap
      || taxonomyMap.totalTips !== tree.leafCount
      || !taxonomyBlocks
    ) {
      return 0;
    }
    const visibleRankCount = spiralVisibleTaxonomyRanksForScale(scale).length;
    if (visibleRankCount === 0) {
      return 0;
    }
    const tipSpacingPx = (
      (metrics.totalArcLength / Math.max(1, tree.leafCount - 1))
      * scale
      * (collapsedView?.effectiveLeafScale ?? 1)
    );
    const rampProgress = smoothstep01(
      (tipSpacingPx - SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX)
      / Math.max(1e-6, 20 - SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX),
    );
    const fontSize = scaleLabelFontSize(
      "tip",
      Math.max(1.8, Math.min(15, 2 + (13 * rampProgress), tipSpacingPx * 0.72)),
    );
    const labelBandWidthPx = estimateLabelWidth(Math.max(fontSize, 1.8), reservedTipLabelCharacters);
    const taxonomyWidth = (visibleRankCount * metrics.taxonomyRibbonWidth)
      + (Math.max(0, visibleRankCount - 1) * metrics.taxonomyRibbonGap)
      + metrics.taxonomyLabelGap;
    const interTurnGapPx = Math.max(0, (metrics.pitch - metrics.bandWidth - taxonomyWidth) * scale);
    const tipLabelsVisible = showTipLabels
      && tipSpacingPx > SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX
      && interTurnGapPx >= (
        Math.max(0, taxonomyGapControl - 1)
        + taxonomyBaselineGapPx
        + labelBandWidthPx
        + Math.max(0, figureStyles.tip.offsetPx)
      );
    const taxonomyMetrics = compressedSpiralTaxonomyMetrics(
      metrics,
      scale,
      tipSpacingPx,
      visibleRankCount,
      taxonomyBandThicknessScale,
    );
    const renderedFirstGapPx = controlledRibbonGapPx(
      taxonomyGapControl,
      (taxonomyMetrics.taxonomyLabelGap * scale) + (tipLabelsVisible ? taxonomyBaselineGapPx : 0),
      tipLabelsVisible ? labelBandWidthPx + Math.max(0, figureStyles.tip.offsetPx) : 0,
    );
    const outerOffset = taxonomyMetrics.bandWidth
      + (renderedFirstGapPx / Math.max(scale, 1e-6))
      + (visibleRankCount * taxonomyMetrics.taxonomyRibbonWidth)
      + (Math.max(0, visibleRankCount - 1) * taxonomyMetrics.taxonomyRibbonGap);
    return Math.max(0, (outerOffset - taxonomyMetrics.bandWidth) * scale);
  }, [collapsedView?.effectiveLeafScale, figureStyles.tip.offsetPx, reservedTipLabelCharacters, scaleLabelFontSize, showTipLabels, spiralVisibleTaxonomyRanksForScale, taxonomyBandThicknessScale, taxonomyBaselineGapPx, taxonomyBlocks, taxonomyEnabled, taxonomyGapControl, taxonomyMap, tree]);

  const transitionEnvelopeShiftPx = useCallback((envelopePx: number): number => (
    Math.min(
      Math.max(0, envelopePx) * 0.5,
      size.width * 0.34,
      size.height * 0.34,
    )
  ), [size.height, size.width]);

  const convertCameraForViewMode = useCallback((fromCamera: CameraState, previousMode?: ViewMode): CameraState => {
    if (!tree) {
      return fromCamera;
    }
    const sourceMode = previousMode ?? viewMode;
    if (fromCamera.kind === "circular" && sourceMode === "spiral") {
      const visibleRankCount = spiralVisibleTaxonomyRanksForScale(fromCamera.scale).length;
      const sourceMetrics = spiralMetricsForScale(visibleRankCount, fromCamera.scale);
      const renderedRadiusPx = sourceMetrics.outerRadius * fromCamera.scale;
      const visibilityTolerancePx = 2;
      const entireSpiralVisible = (
        fromCamera.translateX - renderedRadiusPx >= -visibilityTolerancePx
        && fromCamera.translateX + renderedRadiusPx <= size.width + visibilityTolerancePx
        && fromCamera.translateY - renderedRadiusPx >= -visibilityTolerancePx
        && fromCamera.translateY + renderedRadiusPx <= size.height + visibilityTolerancePx
      );
      if (entireSpiralVisible) {
        return fitCameraForMode(viewMode) ?? fromCamera;
      }
    }
    if (cameraApproximatelyMatchesFit(fromCamera, sourceMode)) {
      return fitCameraForMode(viewMode) ?? fromCamera;
    }
    const centerScreenX = size.width * 0.5;
    const centerScreenY = size.height * 0.5;
    const sourceIsPolar = sourceMode === "circular" || sourceMode === "fan";
    const destinationIsPolar = viewMode === "circular" || viewMode === "fan";
    const hasCurrentTaxonomyOverlay = Boolean(
      taxonomyEnabled
      && taxonomyMap
      && taxonomyMap.totalTips === tree.leafCount
      && taxonomyBlocks
      && taxonomyActiveRanks.length > 0
    );

    if (fromCamera.kind === "circular" && sourceIsPolar && viewMode === "spiral") {
      const world = screenToWorldCircular(fromCamera, centerScreenX, centerScreenY);
      const sourceRadius = Math.sqrt((world.x * world.x) + (world.y * world.y));
      const rawDepth = rawDepthFromAxisForMode(sourceRadius, sourceMode);
      const targetY = polarLayoutValueForCurrentModeTheta(Math.atan2(world.y, world.x), sourceMode);
      const nextCamera = fitCameraForMode("spiral");
      if (nextCamera?.kind === "circular") {
        const initialMetrics = spiralMetricsForScale(visibleSpiralTaxonomyRanks.length, nextCamera.scale);
        const sourceDomain = polarDomainForMode(sourceMode);
        const sourcePixelsPerLeaf = Math.max(sourceRadius, tree.branchLengthMinPositive)
          * fromCamera.scale
          * (sourceDomain.span / sourceDomain.leafDivisor);
        const spiralWorldPerLeaf = initialMetrics.totalArcLength / Math.max(1, tree.leafCount - 1);
        const angularScale = sourcePixelsPerLeaf / Math.max(spiralWorldPerLeaf, 1e-9);
        nextCamera.scale = spiralScaleForViewContinuity(
          Math.max(nextCamera.scale * 0.65, angularScale),
          sourcePixelsPerLeaf,
        );
        const finalMetrics = spiralMetricsForScale(
          spiralVisibleTaxonomyRanksForScale(nextCamera.scale).length,
          nextCamera.scale,
        );
        const targetTheta = spiralThetaForY(Math.max(0, Math.min(tree.leafCount - 1, targetY)), tree.leafCount, finalMetrics);
        const age = Math.max(0, Math.min(finalMetrics.timeExtent, (tree.isUltrametric ? tree.rootAge : tree.maxDepth) - rawDepth));
        const point = spiralPointAt(targetTheta, age, finalMetrics);
        const targetFrame = spiralFrameAt(targetTheta, 0, finalMetrics);
        const rotatedNormal = rotateCircularWorldPoint(nextCamera, targetFrame.normalX, targetFrame.normalY);
        const envelopeShiftPx = sourcePixelsPerLeaf > SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX
          ? transitionEnvelopeShiftPx(spiralTaxonomyEnvelopePx(nextCamera.scale, finalMetrics))
          : 0;
        const rotatedPoint = rotateCircularWorldPoint(nextCamera, point.x, point.y);
        nextCamera.translateX = centerScreenX - (rotatedNormal.x * envelopeShiftPx) - (rotatedPoint.x * nextCamera.scale);
        nextCamera.translateY = centerScreenY - (rotatedNormal.y * envelopeShiftPx) - (rotatedPoint.y * nextCamera.scale);
        finalizeCircularCamera(nextCamera);
        return nextCamera;
      }
    }

    if (fromCamera.kind === "circular" && sourceMode === "spiral" && destinationIsPolar) {
      const world = screenToWorldCircular(fromCamera, centerScreenX, centerScreenY);
      const visibleRankCount = spiralVisibleTaxonomyRanksForScale(fromCamera.scale).length;
      const spiralMetrics = spiralMetricsForScale(visibleRankCount, fromCamera.scale);
      const sourceTheta = unambiguousVisibleSpiralThetaForViewport(fromCamera, spiralMetrics, size.width, size.height);
      if (sourceTheta === null) {
        return fitCameraForMode(viewMode) ?? fromCamera;
      }
      const targetY = spiralArcFractionForTheta(sourceTheta, spiralMetrics) * Math.max(1, tree.leafCount - 1);
      const sourceAge = spiralAgeForPointAtTheta(world.x, world.y, sourceTheta, spiralMetrics);
      const rawDepth = Math.max(0, (tree.isUltrametric ? tree.rootAge : tree.maxDepth) - sourceAge);
      const targetRadius = axisDepthForMode(rawDepth, viewMode);
      const targetTheta = polarThetaForCurrentModeLayoutValue(targetY, viewMode);
      const targetPoint = polarToCartesian(targetRadius, targetTheta);
      const destinationFitCamera = fitCameraForMode(viewMode);
      const nextCamera = destinationFitCamera?.kind === "circular"
        ? destinationFitCamera
        : fitPolarCamera(viewMode) ?? fitCircularCamera(size.width, size.height, tree, circularRotation);
      const spiralFitCamera = fitCameraForMode("spiral");
      const sourceZoomRatio = spiralFitCamera?.kind === "circular"
        ? fromCamera.scale / Math.max(spiralFitCamera.scale, 1e-9)
        : 1;
      const sourcePixelsPerLeaf = fromCamera.scale
        * (spiralMetrics.totalArcLength / Math.max(1, tree.leafCount - 1));
      // A multi-turn spiral has much more total arc length than a radial tree's
      // single circumference. Equating those lengths makes the radial camera
      // jump as soon as the spiral is no longer at fit. Preserve each geometry's
      // magnification relative to its own fit view instead.
      nextCamera.scale *= Math.max(1, sourceZoomRatio);
      const rotatedNormal = rotateCircularWorldPoint(nextCamera, Math.cos(targetTheta), Math.sin(targetTheta));
      const envelopeShiftPx = hasCurrentTaxonomyOverlay
        && sourcePixelsPerLeaf > SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX
        ? transitionEnvelopeShiftPx(circularClampExtraRadiusPx(nextCamera))
        : 0;
      const rotatedPoint = rotateCircularWorldPoint(nextCamera, targetPoint.x, targetPoint.y);
      nextCamera.translateX = centerScreenX - (rotatedNormal.x * envelopeShiftPx) - (rotatedPoint.x * nextCamera.scale);
      nextCamera.translateY = centerScreenY - (rotatedNormal.y * envelopeShiftPx) - (rotatedPoint.y * nextCamera.scale);
      finalizeCircularCamera(nextCamera);
      return nextCamera;
    }

    if (fromCamera.kind === "circular" && sourceIsPolar && destinationIsPolar) {
      const world = screenToWorldCircular(fromCamera, centerScreenX, centerScreenY);
      const sourceRadius = Math.sqrt((world.x * world.x) + (world.y * world.y));
      const targetY = polarLayoutValueForCurrentModeTheta(Math.atan2(world.y, world.x), sourceMode);
      const targetTheta = polarThetaForCurrentModeLayoutValue(targetY, viewMode);
      const targetPoint = polarToCartesian(sourceRadius, targetTheta);
      const sourceDomain = polarDomainForMode(sourceMode);
      const destinationDomain = polarDomainForMode(viewMode);
      const nextCamera = fitPolarCamera(viewMode) ?? fitCircularCamera(size.width, size.height, tree, circularRotation);
      const preservedSpacingScale = fromCamera.scale
        * (sourceDomain.span / sourceDomain.leafDivisor)
        / (destinationDomain.span / destinationDomain.leafDivisor);
      nextCamera.scale = Math.max(nextCamera.scale, preservedSpacingScale);
      const sourcePixelsPerLeaf = Math.max(sourceRadius, tree.branchLengthMinPositive)
        * fromCamera.scale
        * (sourceDomain.span / sourceDomain.leafDivisor);
      const rotatedNormal = rotateCircularWorldPoint(nextCamera, Math.cos(targetTheta), Math.sin(targetTheta));
      const envelopeShiftPx = hasCurrentTaxonomyOverlay
        && sourcePixelsPerLeaf > SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX
        ? transitionEnvelopeShiftPx(circularClampExtraRadiusPx(nextCamera))
        : 0;
      const rotatedPoint = rotateCircularWorldPoint(nextCamera, targetPoint.x, targetPoint.y);
      nextCamera.translateX = centerScreenX - (rotatedNormal.x * envelopeShiftPx) - (rotatedPoint.x * nextCamera.scale);
      nextCamera.translateY = centerScreenY - (rotatedNormal.y * envelopeShiftPx) - (rotatedPoint.y * nextCamera.scale);
      finalizeCircularCamera(nextCamera);
      return nextCamera;
    }

    if (fromCamera.kind === "circular" && viewMode === "rectangular") {
      const world = screenToWorldCircular(fromCamera, centerScreenX, centerScreenY);
      const visibleRankCount = sourceMode === "spiral" ? spiralVisibleTaxonomyRanksForScale(fromCamera.scale).length : taxonomyEnabled && taxonomyBlocks && taxonomyActiveRanks.length > 0
        ? taxonomyActiveRanks.length
        : 0;
      const sourceHadTaxonomyRibbons = taxonomyEnabled && taxonomyBlocks && visibleRankCount > 0;
      const spiralMetrics = sourceMode === "spiral"
        ? spiralMetricsForScale(visibleRankCount, fromCamera.scale)
        : null;
      const visibleSpiralTheta = spiralMetrics
        ? unambiguousVisibleSpiralThetaForViewport(fromCamera, spiralMetrics, size.width, size.height)
        : null;
      if (spiralMetrics && visibleSpiralTheta === null) {
        return fitCameraForMode(viewMode) ?? fromCamera;
      }
      const theta = spiralMetrics ? visibleSpiralTheta as number : Math.atan2(world.y, world.x);
      const targetY = spiralMetrics
        ? spiralArcFractionForTheta(theta, spiralMetrics) * Math.max(1, tree.leafCount - 1)
        : polarLayoutValueForCurrentModeTheta(theta, sourceMode);
      const radius = Math.sqrt((world.x * world.x) + (world.y * world.y));
      const targetX = spiralMetrics
        ? axisDepthForMode(Math.max(
          0,
          (tree.isUltrametric ? tree.rootAge : tree.maxDepth)
            - spiralAgeForPointAtTheta(world.x, world.y, theta, spiralMetrics),
        ), "rectangular")
        : axisDepthForMode(rawDepthFromAxisForMode(radius, sourceMode), "rectangular");
      const nextCamera = fitRectCamera(size.width, size.height, tree);
      nextCamera.scaleX = Math.max(nextCamera.scaleX * 0.55, spiralMetrics ? nextCamera.scaleX : fromCamera.scale);
      const sourceDomain = sourceIsPolar ? polarDomainForMode(sourceMode) : null;
      const pixelsPerLeaf = Math.max(
        nextCamera.scaleY * 0.55,
        spiralMetrics
          ? fromCamera.scale * (spiralMetrics.totalArcLength / Math.max(1, tree.leafCount - 1))
          : Math.max(radius, tree.branchLengthMinPositive)
            * fromCamera.scale
            * ((sourceDomain?.span ?? Math.PI * 2) / (sourceDomain?.leafDivisor ?? Math.max(1, tree.leafCount))),
      );
      nextCamera.scaleY = pixelsPerLeaf;
      nextCamera.translateX = centerScreenX - (targetX * nextCamera.scaleX);
      nextCamera.translateY = centerScreenY - (targetY * nextCamera.scaleY);
      const padding = rectClampPadding(nextCamera);
      if (sourceHadTaxonomyRibbons) {
        const tipScreenX = nextCamera.translateX + (tree.maxDepth * nextCamera.scaleX);
        const ribbonEnvelopeRight = tipScreenX + (padding.right ?? 0);
        const maxRibbonRight = size.width - 48;
        if (ribbonEnvelopeRight > maxRibbonRight) {
          nextCamera.translateX -= ribbonEnvelopeRight - maxRibbonRight;
        }
      }
      clampRectCamera(nextCamera, tree, size.width, size.height, padding);
      return nextCamera;
    }

    if (fromCamera.kind === "rect" && (viewMode === "circular" || viewMode === "fan" || viewMode === "spiral")) {
      const world = screenToWorldRect(fromCamera, centerScreenX, centerScreenY);
      if (viewMode === "spiral") {
        const rawDepth = rawDepthFromAxisForMode(world.x, "rectangular");
        const nextCamera = fitCameraForMode("spiral");
        if (nextCamera?.kind === "circular") {
          const initialMetrics = spiralMetricsForScale(visibleSpiralTaxonomyRanks.length, nextCamera.scale);
          const spiralWorldPerLeaf = initialMetrics.totalArcLength / Math.max(1, tree.leafCount);
          nextCamera.scale = spiralScaleForViewContinuity(
            Math.max(nextCamera.scale * 0.65, fromCamera.scaleY / Math.max(spiralWorldPerLeaf, 1e-9)),
            fromCamera.scaleY,
          );
          const finalMetrics = spiralMetricsForScale(
            spiralVisibleTaxonomyRanksForScale(nextCamera.scale).length,
            nextCamera.scale,
          );
          const theta = spiralThetaForY(Math.max(0, Math.min(tree.leafCount - 1, world.y)), tree.leafCount, finalMetrics);
          const age = Math.max(0, Math.min(finalMetrics.timeExtent, (tree.isUltrametric ? tree.rootAge : tree.maxDepth) - rawDepth));
          const point = spiralPointAt(theta, age, finalMetrics);
          const targetFrame = spiralFrameAt(theta, 0, finalMetrics);
          const rotatedNormal = rotateCircularWorldPoint(nextCamera, targetFrame.normalX, targetFrame.normalY);
          const envelopeShiftPx = fromCamera.scaleY > SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX
            ? transitionEnvelopeShiftPx(spiralTaxonomyEnvelopePx(nextCamera.scale, finalMetrics))
            : 0;
          const rotatedPoint = rotateCircularWorldPoint(nextCamera, point.x, point.y);
          nextCamera.translateX = centerScreenX - (rotatedNormal.x * envelopeShiftPx) - (rotatedPoint.x * nextCamera.scale);
          nextCamera.translateY = centerScreenY - (rotatedNormal.y * envelopeShiftPx) - (rotatedPoint.y * nextCamera.scale);
          finalizeCircularCamera(nextCamera);
          return nextCamera;
        }
      }
      const rawDepth = rawDepthFromAxisForMode(world.x, "rectangular");
      const theta = polarThetaForCurrentModeLayoutValue(world.y, viewMode);
      const point = polarToCartesian(axisDepthForMode(rawDepth, viewMode), theta);
      const nextCamera = fitPolarCamera(viewMode) ?? fitCircularCamera(size.width, size.height, tree, circularRotation);
      const axisRadius = axisDepthForMode(rawDepth, viewMode);
      const destinationDomain = polarDomainForMode(viewMode);
      const destinationWorldPerLeaf = Math.max(axisRadius, tree.branchLengthMinPositive)
        * (destinationDomain.span / destinationDomain.leafDivisor);
      const angularScale = fromCamera.scaleY / Math.max(destinationWorldPerLeaf, 1e-9);
      nextCamera.scale = Math.max(nextCamera.scale * 0.55, fromCamera.scaleX, angularScale);
      const rotatedNormal = rotateCircularWorldPoint(nextCamera, Math.cos(theta), Math.sin(theta));
      const envelopeShiftPx = hasCurrentTaxonomyOverlay
        && fromCamera.scaleY > SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX
        ? transitionEnvelopeShiftPx(circularClampExtraRadiusPx(nextCamera))
        : 0;
      const rotatedPoint = rotateCircularWorldPoint(nextCamera, point.x, point.y);
      nextCamera.translateX = centerScreenX - (rotatedNormal.x * envelopeShiftPx) - (rotatedPoint.x * nextCamera.scale);
      nextCamera.translateY = centerScreenY - (rotatedNormal.y * envelopeShiftPx) - (rotatedPoint.y * nextCamera.scale);
      finalizeCircularCamera(nextCamera);
      return nextCamera;
    }

    return fromCamera;
  }, [axisDepthForMode, cameraApproximatelyMatchesFit, circularClampExtraRadiusPx, circularRotation, finalizeCircularCamera, fitCameraForMode, fitPolarCamera, polarDomainForMode, polarLayoutValueForCurrentModeTheta, polarThetaForCurrentModeLayoutValue, rawDepthFromAxisForMode, size.height, size.width, spiralMetricsForScale, spiralScaleForViewContinuity, spiralTaxonomyEnvelopePx, spiralVisibleTaxonomyRanksForScale, taxonomyActiveRanks.length, taxonomyBlocks, taxonomyEnabled, taxonomyMap, transitionEnvelopeShiftPx, tree, viewMode, visibleSpiralTaxonomyRanks.length]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      setSize({
        width: Math.max(320, Math.floor(entry.contentRect.width)),
        height: Math.max(320, Math.floor(entry.contentRect.height)),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      panBenchmarkRef.current?.observer?.disconnect();
      panBenchmarkRef.current = null;
    };
  }, []);

  const draw = useCallback(() => {
    const canvas = renderCanvasOverrideRef.current ?? canvasRef.current;
    const renderSize = renderSizeOverrideRef.current ?? size;
    if (!canvas || !tree || !cache) {
      return;
    }
    if (!cameraRef.current || cameraRef.current.kind !== (viewMode === "rectangular" ? "rect" : "circular")) {
      fitCamera();
    }
    const camera = renderCameraOverrideRef.current ?? cameraRef.current;
    if (!camera) {
      return;
    }

    const baseDpr = window.devicePixelRatio || 1;
    const dpr = renderDprOverrideRef.current ?? baseDpr;
    const backingWidth = Math.max(1, Math.floor(renderSize.width * dpr));
    const backingHeight = Math.max(1, Math.floor(renderSize.height * dpr));
    const isOverrideRender = renderCanvasOverrideRef.current !== null;
    const previousBackingStore = isOverrideRender ? null : canvasBackingStoreRef.current;
    if (isOverrideRender || !previousBackingStore
      || previousBackingStore.width !== backingWidth
      || previousBackingStore.height !== backingHeight
      || Math.abs(previousBackingStore.dpr - dpr) > 1e-6
    ) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
      canvas.style.width = `${renderSize.width}px`;
      canvas.style.height = `${renderSize.height}px`;
      if (!isOverrideRender) {
        canvasBackingStoreRef.current = {
          width: backingWidth,
          height: backingHeight,
          dpr,
        };
      }
    }

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      return;
    }
    const scaleLabelText = (value: number): string => (
      tree.isUltrametric ? `${formatAgeNumber(value)} mya` : formatScaleNumber(value)
    );
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fbfcfe";
    ctx.fillRect(0, 0, renderSize.width, renderSize.height);
    const svgExportCapture = exportCaptureRef.current !== null;
    const exportCapture = svgExportCapture || renderCanvasOverrideRef.current !== null;
    if (svgExportCapture) {
      exportCaptureRef.current = {
        width: renderSize.width,
        height: renderSize.height,
        background: "#fbfcfe",
        elements: [],
      };
    }
    const pushSceneRect = (x: number, y: number, width: number, height: number, fill: string, opacity?: number): void => {
      if (!exportCaptureRef.current || width <= 0 || height <= 0) {
        return;
      }
      exportCaptureRef.current.elements.push({ kind: "rect", x, y, width, height, fill, opacity });
    };
    const pushSceneLine = (x1: number, y1: number, x2: number, y2: number, stroke: string, strokeWidth: number, opacity?: number, dashArray?: string): void => {
      if (!exportCaptureRef.current) {
        return;
      }
      exportCaptureRef.current.elements.push({ kind: "line", x1, y1, x2, y2, stroke, strokeWidth, opacity, dashArray });
    };
    const pushScenePath = (path: string | (() => string), stroke?: string, strokeWidth?: number, fill?: string, opacity?: number, dashArray?: string): void => {
      if (!exportCaptureRef.current) {
        return;
      }
      const d = typeof path === "function" ? path() : path;
      if (!d) {
        return;
      }
      exportCaptureRef.current.elements.push({ kind: "path", d, stroke, strokeWidth, fill, opacity, dashArray });
    };
    const pushSceneText = (
      text: string,
      x: number,
      y: number,
      fill: string,
      fontSize: number,
      fontFamily: string,
      anchor: "start" | "middle" | "end",
      rotation?: number,
      fontStyle?: string,
    ): void => {
      if (!exportCaptureRef.current || !text) {
        return;
      }
      exportCaptureRef.current.elements.push({
        kind: "text",
        text,
        x,
        y,
        fill,
        fontSize,
        fontFamily,
        fontStyle,
        anchor,
        rotation,
      });
    };
    const pushSceneImage = (href: string, x: number, y: number, width: number, height: number, opacity?: number): void => {
      if (!exportCaptureRef.current || !href || width <= 0 || height <= 0) {
        return;
      }
      exportCaptureRef.current.elements.push({ kind: "image", href, x, y, width, height, opacity });
    };
    const phylopicByKey = phylopicEnabled
      ? new Map(phylopicSilhouettes.map((silhouette) => [silhouette.key, silhouette]))
      : new Map();
    type PendingPhyloPicImage = {
      image: HTMLImageElement;
      dataUrl: string;
      alpha: number;
      width: number;
      height: number;
      position: (width: number, height: number) => { drawX: number; drawY: number };
      alternatePosition?: (width: number, height: number) => { drawX: number; drawY: number };
      hitbox?: Omit<PhyloPicHitbox, "x" | "y" | "width" | "height">;
    };
    const pendingPhyloPicImages: PendingPhyloPicImage[] = [];
    const phylopicRectsOverlap = (
      left: { left: number; right: number; top: number; bottom: number },
      right: { left: number; right: number; top: number; bottom: number },
      paddingPx: number,
    ): boolean => (
      left.left < right.right + paddingPx
      && left.right > right.left - paddingPx
      && left.top < right.bottom + paddingPx
      && left.bottom > right.top - paddingPx
    );
    const enqueuePhyloPicImage = (
      image: HTMLImageElement,
      dataUrl: string,
      alpha: number,
      width: number,
      height: number,
      position: (width: number, height: number) => { drawX: number; drawY: number },
      alternatePosition?: (width: number, height: number) => { drawX: number; drawY: number },
      hitbox?: Omit<PhyloPicHitbox, "x" | "y" | "width" | "height">,
    ): void => {
      if (isOverrideRender && !dataUrl.startsWith("data:")) {
        return;
      }
      pendingPhyloPicImages.push({ image, dataUrl, alpha, width, height, position, alternatePosition, hitbox });
    };
    const flushPhyloPicImages = (): void => {
      if (pendingPhyloPicImages.length === 0) {
        return;
      }
      const scales = new Array<number>(pendingPhyloPicImages.length).fill(1);
      const useAlternatePositions = new Array<boolean>(pendingPhyloPicImages.length).fill(false);
      const rectFor = (index: number): { left: number; right: number; top: number; bottom: number; drawX: number; drawY: number; width: number; height: number } => {
        const pending = pendingPhyloPicImages[index];
        const width = pending.width * scales[index];
        const height = pending.height * scales[index];
        const position = useAlternatePositions[index] && pending.alternatePosition
          ? pending.alternatePosition(width, height)
          : pending.position(width, height);
        return {
          left: position.drawX,
          right: position.drawX + width,
          top: position.drawY,
          bottom: position.drawY + height,
          drawX: position.drawX,
          drawY: position.drawY,
          width,
          height,
        };
      };
      const collisionCount = (rects: Array<{ left: number; right: number; top: number; bottom: number }>): number => {
        let count = 0;
        for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < rects.length; rightIndex += 1) {
            if (phylopicRectsOverlap(rects[leftIndex], rects[rightIndex], 4)) {
              count += 1;
            }
          }
        }
        return count;
      };
      for (let iteration = 0; iteration < 8; iteration += 1) {
        let rects = pendingPhyloPicImages.map((_, index) => rectFor(index));
        let currentCollisionCount = collisionCount(rects);
        if (currentCollisionCount > 0) {
          let improved = true;
          while (improved && currentCollisionCount > 0) {
            improved = false;
            for (let index = 0; index < pendingPhyloPicImages.length; index += 1) {
              if (!pendingPhyloPicImages[index].alternatePosition) {
                continue;
              }
              useAlternatePositions[index] = !useAlternatePositions[index];
              const candidateRects = pendingPhyloPicImages.map((_, candidateIndex) => rectFor(candidateIndex));
              const candidateCollisionCount = collisionCount(candidateRects);
              if (candidateCollisionCount < currentCollisionCount) {
                rects = candidateRects;
                currentCollisionCount = candidateCollisionCount;
                improved = true;
                if (currentCollisionCount === 0) {
                  break;
                }
              } else {
                useAlternatePositions[index] = !useAlternatePositions[index];
              }
            }
          }
        }
        const parents = rects.map((_, index) => index);
        const find = (index: number): number => {
          let root = index;
          while (parents[root] !== root) {
            root = parents[root];
          }
          while (parents[index] !== index) {
            const next = parents[index];
            parents[index] = root;
            index = next;
          }
          return root;
        };
        const union = (left: number, right: number): void => {
          const leftRoot = find(left);
          const rightRoot = find(right);
          if (leftRoot !== rightRoot) {
            parents[rightRoot] = leftRoot;
          }
        };
        let hasCollision = false;
        for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < rects.length; rightIndex += 1) {
            if (phylopicRectsOverlap(rects[leftIndex], rects[rightIndex], 4)) {
              union(leftIndex, rightIndex);
              hasCollision = true;
            }
          }
        }
        if (!hasCollision) {
          break;
        }
        const groupSizes = new Map<number, number>();
        for (let index = 0; index < rects.length; index += 1) {
          const root = find(index);
          groupSizes.set(root, (groupSizes.get(root) ?? 0) + 1);
        }
        for (let index = 0; index < scales.length; index += 1) {
          if ((groupSizes.get(find(index)) ?? 0) > 1) {
            scales[index] = Math.max(0.38, scales[index] * 0.86);
          }
        }
      }
      for (let index = 0; index < pendingPhyloPicImages.length; index += 1) {
        const pending = pendingPhyloPicImages[index];
        const width = pending.width * scales[index];
        const height = pending.height * scales[index];
        const { drawX, drawY } = useAlternatePositions[index] && pending.alternatePosition
          ? pending.alternatePosition(width, height)
          : pending.position(width, height);
        ctx.save();
        ctx.globalAlpha = pending.alpha;
        ctx.drawImage(pending.image, drawX, drawY, width, height);
        ctx.restore();
        pushSceneImage(pending.dataUrl, drawX, drawY, width, height, pending.alpha);
        if (!isOverrideRender && pending.hitbox) {
          phylopicHitsRef.current.push({
            ...pending.hitbox,
            x: drawX,
            y: drawY,
            width,
            height,
          });
        }
      }
    };
    const drawPhyloPicForTaxonomyLabel = (
      label: ScreenLabel,
      textWidthPx: number,
      fontSizePx: number,
      avoidLabels: ScreenLabel[] = [],
    ): void => {
      if (!phylopicEnabled || !label.rank || !label.text) {
        return;
      }
      if (!TAXONOMY_RANKS.includes(label.rank as TaxonomyRank)) {
        return;
      }
      const rank = label.rank as TaxonomyRank;
      const key = `${rank}:${label.text}:${label.taxId ?? ""}`;
      const silhouette = phylopicByKey.get(key);
      if (!silhouette) {
        return;
      }
      const image = phylopicImagesRef.current.get(phylopicImageElementKey(silhouette));
      if (!image || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        return;
      }
      const naturalAspect = Math.max(0.05, silhouette.width / Math.max(1, silhouette.height));
      const baseHeightPx = Math.max(fontSizePx, label.bandSizePx ?? fontSizePx);
      const boxHeight = Math.max(4, baseHeightPx * Math.max(0.2, phylopicSizeScale));
      const boxWidth = Math.max(boxHeight, boxHeight * 1.55);
      const phylopicHitbox: Omit<PhyloPicHitbox, "x" | "y" | "width" | "height"> = {
        silhouette,
        taxonLabel: label.text,
        rank,
        taxId: label.taxId ?? null,
        firstNode: label.firstNode,
        lastNode: label.lastNode,
        taxonomyTipCount: label.taxonomyTipCount,
      };
      let imageWidth = naturalAspect >= 1
        ? Math.min(boxWidth, boxHeight * naturalAspect)
        : Math.min(boxWidth, boxHeight * naturalAspect);
      let imageHeight = naturalAspect >= 1
        ? imageWidth / naturalAspect
        : Math.min(boxHeight, imageWidth / naturalAspect);
      const isRectangularTaxonomyLabel = viewMode === "rectangular" && Math.abs(Math.abs(label.rotation ?? 0) - (Math.PI * 0.5)) < 0.001;
      const alpha = 1;
      if (phylopicPlacement === "outside-ribbon" && isRectangularTaxonomyLabel) {
        const marginPx = Math.max(6, fontSizePx * 0.45);
        const alongX = Math.cos(label.rotation ?? 0);
        const alongY = Math.sin(label.rotation ?? 0);
        enqueuePhyloPicImage(image, silhouette.dataUrl, alpha, imageWidth, imageHeight, (width, height) => {
          const centerX = label.x
            + (((label.bandSizePx ?? fontSizePx) * 0.5) + marginPx + (width * 0.5) + phylopicOffsetYPx)
            + (alongX * phylopicOffsetXPx);
          const centerY = label.y
            + (label.offsetY ?? 0)
            + (alongY * phylopicOffsetXPx);
          return { drawX: centerX - (width * 0.5), drawY: centerY - (height * 0.5) };
        }, undefined, phylopicHitbox);
        return;
      }
      const rotation = label.rotation ?? 0;
      const directionX = Math.cos(rotation);
      const directionY = Math.sin(rotation);
      const textNormalX = -Math.sin(rotation);
      const textNormalY = Math.cos(rotation);
      const rawNormalX = typeof label.phylopicNormalX === "number"
        ? label.phylopicNormalX
        : isRectangularTaxonomyLabel
          ? 1
          : textNormalX;
      const rawNormalY = typeof label.phylopicNormalY === "number"
        ? label.phylopicNormalY
        : isRectangularTaxonomyLabel
          ? 0
          : textNormalY;
      const normalLength = Math.max(1e-6, Math.hypot(rawNormalX, rawNormalY));
      const normalX = rawNormalX / normalLength;
      const normalY = rawNormalY / normalLength;
      const align = label.align ?? "center";
      const startOffset = align === "right" || align === "end"
        ? -textWidthPx
        : align === "center"
          ? -textWidthPx * 0.5
          : 0;
      const endOffset = startOffset + textWidthPx;
      const marginPx = Math.max(2, Math.min(8, (label.bandSizePx ?? fontSizePx) * 0.08));
      const perpendicularNudgePx = isRectangularTaxonomyLabel
        ? Math.max(2, Math.min(7, (label.bandSizePx ?? fontSizePx) * 0.09))
        : 0;
      const baselineX = label.x + (textNormalX * (label.offsetY ?? 0));
      const baselineY = label.y + (textNormalY * (label.offsetY ?? 0));
      const positionForSide = (side: 1 | -1, width: number, height: number): { drawX: number; drawY: number } => {
        const projectedHalfExtentPx = ((Math.abs(directionX) * width) + (Math.abs(directionY) * height)) * 0.5;
        const sideOffset = side > 0
          ? endOffset + marginPx + projectedHalfExtentPx + phylopicOffsetXPx
          : startOffset - marginPx - projectedHalfExtentPx + phylopicOffsetXPx;
        const centerX = baselineX
          + (directionX * sideOffset)
          + (normalX * (perpendicularNudgePx + phylopicOffsetYPx));
        const centerY = baselineY
          + (directionY * sideOffset)
          + (normalY * (perpendicularNudgePx + phylopicOffsetYPx));
        return { drawX: centerX - (width * 0.5), drawY: centerY - (height * 0.5) };
      };
      const positionFor = (width: number, height: number): { drawX: number; drawY: number } => positionForSide(1, width, height);
      const alternatePositionFor = viewMode === "rectangular"
        ? undefined
        : (width: number, height: number): { drawX: number; drawY: number } => positionForSide(-1, width, height);
      let useAlternateForLabelAvoidance = false;
      const activePositionFor = (): ((width: number, height: number) => { drawX: number; drawY: number }) => (
        useAlternateForLabelAvoidance && alternatePositionFor ? alternatePositionFor : positionFor
      );
      let { drawX, drawY } = activePositionFor()(imageWidth, imageHeight);
      if (avoidLabels.length > 0) {
        const previousFont = ctx.font;
        const overlapsAnotherLabel = (imageRect: { left: number; right: number; top: number; bottom: number }): boolean => avoidLabels.some((other) => {
          if (other === label) {
            return false;
          }
          const otherFontSize = other.fontSize ?? fontSizePx;
          ctx.font = `${otherFontSize}px ${labelFontFamilies.taxonomy}`;
          const otherWidth = ctx.measureText(other.text).width;
          const otherHeight = otherFontSize * 1.1;
          const otherRotation = other.rotation ?? 0;
          const otherDirX = Math.cos(otherRotation);
          const otherDirY = Math.sin(otherRotation);
          const otherNormalX = -Math.sin(otherRotation);
          const otherNormalY = Math.cos(otherRotation);
          const otherAlign = other.align ?? "center";
          const localLeft = otherAlign === "right" || otherAlign === "end"
            ? -otherWidth
            : otherAlign === "center"
              ? -otherWidth * 0.5
              : 0;
          const localRight = localLeft + otherWidth;
          const localTop = -otherHeight * 0.5;
          const localBottom = otherHeight * 0.5;
          const originX = other.x + (otherNormalX * (other.offsetY ?? 0));
          const originY = other.y + (otherNormalY * (other.offsetY ?? 0));
          const corners = [
            [localLeft, localTop],
            [localRight, localTop],
            [localRight, localBottom],
            [localLeft, localBottom],
          ] as const;
          let left = Number.POSITIVE_INFINITY;
          let right = Number.NEGATIVE_INFINITY;
          let top = Number.POSITIVE_INFINITY;
          let bottom = Number.NEGATIVE_INFINITY;
          for (const [localX, localY] of corners) {
            const x = originX + (otherDirX * localX) + (otherNormalX * localY);
            const y = originY + (otherDirY * localX) + (otherNormalY * localY);
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
          const padding = 2;
          return imageRect.left < right + padding
            && imageRect.right > left - padding
            && imageRect.top < bottom + padding
            && imageRect.bottom > top - padding;
        });
        const currentRect = (): { left: number; right: number; top: number; bottom: number } => ({
          left: drawX,
          right: drawX + imageWidth,
          top: drawY,
          bottom: drawY + imageHeight,
        });
        if (overlapsAnotherLabel(currentRect())) {
          if (alternatePositionFor) {
            const alternatePosition = alternatePositionFor(imageWidth, imageHeight);
            const alternateRect = {
              left: alternatePosition.drawX,
              right: alternatePosition.drawX + imageWidth,
              top: alternatePosition.drawY,
              bottom: alternatePosition.drawY + imageHeight,
            };
            if (!overlapsAnotherLabel(alternateRect)) {
              useAlternateForLabelAvoidance = true;
              drawX = alternatePosition.drawX;
              drawY = alternatePosition.drawY;
            }
          }
        }
        if (overlapsAnotherLabel(currentRect())) {
          for (const shrink of [0.82, 0.68, 0.55]) {
            const candidateWidth = imageWidth * shrink;
            const candidateHeight = imageHeight * shrink;
            const candidatePosition = activePositionFor()(candidateWidth, candidateHeight);
            imageWidth = candidateWidth;
            imageHeight = candidateHeight;
            drawX = candidatePosition.drawX;
            drawY = candidatePosition.drawY;
            if (!overlapsAnotherLabel(currentRect())) {
              break;
            }
          }
        }
        ctx.font = previousFont;
      }
      const primaryPositionFor = useAlternateForLabelAvoidance && alternatePositionFor ? alternatePositionFor : positionFor;
      const fallbackPositionFor = useAlternateForLabelAvoidance ? positionFor : alternatePositionFor;
      enqueuePhyloPicImage(image, silhouette.dataUrl, alpha, imageWidth, imageHeight, primaryPositionFor, fallbackPositionFor, phylopicHitbox);
    };
    if (!isOverrideRender) {
      labelHitsRef.current = [];
      collapsedTriangleHitsRef.current = [];
      phylopicHitsRef.current = [];
      taxonomyArcHitsRef.current = [];
    }
    const renderDebug: Record<string, unknown> = {
      viewMode,
      order,
      width: renderSize.width,
      height: renderSize.height,
      renderDpr: dpr,
    };
    const timing = {
      branchBaseMs: 0,
      taxonomyBranchMs: 0,
      taxonomyOverlayMs: 0,
      circularCachePrepMs: 0,
      circularTaxonomyCacheMs: 0,
      circularVisibilityPrepMs: 0,
      totalMs: 0,
    };
    const drawStartTime = performance.now();
    const hiddenNodes = collapsedView?.hiddenNodes ?? new Uint8Array(tree.nodeCount);
    const visibleCollapsedNodes = collapsedView?.visibleCollapsedNodes ?? [];
    const renderedTaxonomyBlocks = taxonomyOverlayBlocks ?? taxonomyBlocks;
    const collapsedLeafBoundaries = collapsedView?.leafBoundaries ?? null;
    const taxonomyBoundaryValue = (index: number): number => {
      if (!collapsedLeafBoundaries) {
        return index - 0.5;
      }
      return collapsedLeafBoundaries[Math.max(0, Math.min(collapsedLeafBoundaries.length - 1, index))];
    };
    const spiralBoundaryThetaCacheByMetrics = new WeakMap<SpiralMetrics, Map<number, number>>();
    const spiralThetaForTaxonomyBoundary = (index: number, metrics: SpiralMetrics): number => {
      const boundary = taxonomyBoundaryValue(index) + 0.5;
      let thetaCache = spiralBoundaryThetaCacheByMetrics.get(metrics);
      if (!thetaCache) {
        thetaCache = spiralBoundaryThetaCache(tree.leafCount, metrics);
        spiralBoundaryThetaCacheByMetrics.set(metrics, thetaCache);
      }
      const cachedTheta = thetaCache.get(boundary);
      if (cachedTheta !== undefined) {
        return cachedTheta;
      }
      const theta = spiralThetaForLeafBoundary(boundary, tree.leafCount, metrics);
      if (thetaCache.size < MAX_SPIRAL_BOUNDARY_THETA_CACHE_ENTRIES) {
        thetaCache.set(boundary, theta);
      }
      return theta;
    };
    const thetaSpanForTaxonomyRange = (startIndex: number, endIndex: number): { startTheta: number; endTheta: number } => {
      if (isPartialRadial) {
        const divisor = Math.max(1, tree.leafCount - 1);
        const startBoundary = Math.max(0, Math.min(divisor, taxonomyBoundaryValue(startIndex)));
        const endBoundary = Math.max(0, Math.min(divisor, taxonomyBoundaryValue(endIndex)));
        return {
          startTheta: polarAngleStart + ((startBoundary / divisor) * polarAngleSpan),
          endTheta: polarAngleStart + ((endBoundary / divisor) * polarAngleSpan),
        };
      }
      const turns = Math.PI * 2;
      const startTheta = (taxonomyBoundaryValue(startIndex) / Math.max(1, tree.leafCount)) * turns;
      let endTheta = (taxonomyBoundaryValue(endIndex) / Math.max(1, tree.leafCount)) * turns;
      if (endTheta <= startTheta) {
        endTheta += turns;
      }
      return { startTheta, endTheta };
    };
    hiddenNodesRef.current = hiddenNodes;
    if (viewMode === "rectangular" && camera.kind === "rect") {
      const layout = collapsedView?.layout ?? tree.layouts[order];
      const children = cache.orderedChildren[order];
      const worldMin = screenToWorldRect(camera, 0, 0);
      const worldMax = screenToWorldRect(camera, renderSize.width, renderSize.height);
      const minX = Math.min(worldMin.x, worldMax.x);
      const maxX = Math.max(worldMin.x, worldMax.x);
      const minY = Math.min(worldMin.y, worldMax.y);
      const maxY = Math.max(worldMin.y, worldMax.y);
      const rectWorldOverscanX = Math.max(tree.branchLengthMinPositive * 2, 48 / Math.max(camera.scaleX, 1e-6));
      const rectWorldOverscanY = Math.max(2, 48 / Math.max(camera.scaleY, 1e-6));
      const axisBarHeight = showScaleBars ? 44 : 0;
      const treeDrawBottom = renderSize.height - axisBarHeight;
      const stripeExtent = effectiveTimeAxisScale === "log" ? timeAxisExtent : (tree.isUltrametric ? tree.rootAge : tree.maxDepth);
      const rectAxisDepthForBoundary = (value: number): number => (
        tree.isUltrametric ? axisDepth(tree.rootAge - value) : axisDepth(value)
      );
      const stripeLevels = buildStripeLevels(Math.max(1e-9, maxX - minX), camera.scaleX, scaleTickInterval);
      const rectScaleStep = scaleTickInterval ?? stripeLevels[0]?.step ?? 0;
      const rectScaleExtent = extendRectScaleToTick && rectScaleStep > 0
        ? Math.max(stripeExtent, Math.ceil(stripeExtent / rectScaleStep) * rectScaleStep)
        : stripeExtent;
      const rectStripeExtent = tree.isUltrametric ? rectScaleExtent : stripeExtent;
      const stripeBoundaries = buildStripeBoundaries(rectStripeExtent, stripeLevels);
      const visibleScaleBoundaries = showIntermediateScaleTicks
        ? stripeBoundaries
        : stripeBoundaries.filter((boundary) => boundary.alpha >= SOLID_SCALE_TICK_ALPHA_THRESHOLD);
      const rectScaleBoundaries = [...visibleScaleBoundaries];
      if (showScaleZeroTick) {
        rectScaleBoundaries.push({ value: 0, alpha: 1 });
      }
      if (tree.isUltrametric && rectScaleExtent > stripeExtent + 1e-9) {
        rectScaleBoundaries.push({ value: rectScaleExtent, alpha: 1 });
      }
      const displayedRectScaleBoundaries = [...new Map(
        rectScaleBoundaries.map((boundary) => [boundary.value.toPrecision(12), boundary]),
      ).values()].sort((left, right) => left.value - right.value);
      const effectiveTipSpacingPx = camera.scaleY * (collapsedView?.effectiveLeafScale ?? 1);
      const tipLabelCueVisible = showTipLabels && effectiveTipSpacingPx > 1.45;
      const microTipLabelsVisible = showTipLabels && effectiveTipSpacingPx > 2.7;
      const tipLabelsVisible = showTipLabels && effectiveTipSpacingPx > 4.2;
      const rectBranchStrokeAutoMultiplier = detailBranchThicknessMultiplier(
        effectiveTipSpacingPx,
        4.2,
      );
      const rectBranchStrokeScale = branchStrokeScale * rectBranchStrokeAutoMultiplier;
      renderDebug.tipSpacingPx = effectiveTipSpacingPx;
      renderDebug.tipLabelsVisible = tipLabelsVisible;
      renderDebug.branchStrokeAutoMultiplier = rectBranchStrokeAutoMultiplier;
      renderDebug.renderedBranchStrokeScale = rectBranchStrokeScale;
      const visibleTaxonomyRanks = taxonomyEnabled && taxonomyConsensus
        ? rectVisibleTaxonomyRanksForScaleY(camera.scaleY)
        : [];
      const branchColorRanks = taxonomyColorRanks.length > 0 ? taxonomyColorRanks : visibleTaxonomyRanks;
      const taxonomyBranchRenderingVisible = taxonomyEnabled && taxonomyBranchColoringEnabled && branchColorRanks.length > 0 && taxonomyColors !== null;
      const coloredBranchKey = taxonomyBranchRenderingVisible
        ? `taxonomy:${branchColorRanks.join("|")}:${taxonomyColorPalette}:${taxonomyCustomPaletteSignature}:${taxonomyColorJitter.toFixed(3)}:${taxonomyColorRootRank}:${taxonomyColorJitterRank}:${metadataBranchColorVersion}:${manualBranchColorVersion}`
        : metadataBranchColorOverlay.hasAny || manualBranchColorOverlay.hasAny
          ? `manual:${metadataBranchColorVersion}:${manualBranchColorVersion}`
          : "";
      const effectiveBranchColors = coloredBranchKey ? getEffectiveBranchColors(order, branchColorRanks) : null;
      const useColoredBranchRendering = effectiveBranchColors !== null;
      const useLargeMetadataBranchLOD = !exportCapture
        && useColoredBranchRendering
        && metadataBranchColorOverlay.hasAny
        && tree.nodeCount >= LARGE_METADATA_BRANCH_NODE_LIMIT;
      const useGlobalColoredBranchCaches = useColoredBranchRendering && metadataBranchColorCacheable && !useLargeMetadataBranchLOD;
      const fitLikeRect = fitCameraForMode("rectangular");
      const nearRectFit = fitLikeRect?.kind === "rect"
        ? camera.scaleY <= (fitLikeRect.scaleY * 3.2)
        : false;
      const useCachedRectTaxonomyPaths = !exportCapture && useGlobalColoredBranchCaches && collapsedNodes.size === 0 && nearRectFit;
      const cachedRectTaxonomyPaths = useCachedRectTaxonomyPaths
        ? getRectTaxonomyPaths(order, layout, coloredBranchKey, effectiveBranchColors)
        : null;
      const useRectTaxonomyBitmapAtCurrentScale = fitLikeRect?.kind === "rect"
        ? camera.scaleY <= (fitLikeRect.scaleY * RECT_TAXONOMY_BITMAP_SCALE_MULTIPLIER)
        : false;
      const useCachedRectTaxonomyBitmap = !exportCapture
        && useCachedRectTaxonomyPaths
        && cachedRectTaxonomyPaths !== null
        && nearRectFit
        && useRectTaxonomyBitmapAtCurrentScale
        && rectBranchStrokeAutoMultiplier === 1;
      const cachedRectTaxonomyBitmap = useCachedRectTaxonomyBitmap
        ? getRectTaxonomyBitmapCache(order, coloredBranchKey, cachedRectTaxonomyPaths, camera)
        : null;
      const useCachedRectBasePath = !exportCapture && !useColoredBranchRendering && collapsedNodes.size === 0;
      const cachedRectBasePaths = useCachedRectBasePath
        ? getRectBasePaths(order, layout)
        : null;
      const largeMetadataRectBasePaths = useLargeMetadataBranchLOD && collapsedNodes.size === 0
        ? getRectBasePaths(order, layout)
        : null;
      const needsVisibleRectSegments = !cachedRectTaxonomyBitmap && !cachedRectTaxonomyPaths && !cachedRectBasePaths;

      if (showTimeStripes) {
        if (timeStripeStyle === "dashed") {
          ctx.save();
          ctx.setLineDash([6, 6]);
          for (let index = 0; index < displayedRectScaleBoundaries.length; index += 1) {
            const boundary = displayedRectScaleBoundaries[index];
            const x = worldToScreenRect(camera, rectAxisDepthForBoundary(boundary.value), 0).x;
            ctx.strokeStyle = `rgba(148,163,184,${0.22 + (0.5 * boundary.alpha)})`;
            ctx.lineWidth = timeStripeLineWeight;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, treeDrawBottom);
            ctx.stroke();
            pushSceneLine(x, 0, x, treeDrawBottom, "#94a3b8", timeStripeLineWeight, 0.22 + (0.5 * boundary.alpha), DASHED_STRIPE_DASH_ARRAY);
          }
          ctx.restore();
        } else {
            const drawBands = (step: number, alpha: number, gradient = false) => {
              if (!Number.isFinite(step) || step <= 0 || alpha <= 0) {
                return;
              }
              const bandCount = Math.max(1, Math.ceil(rectStripeExtent / step));
              if (bandCount > MAX_TIME_STRIPE_BANDS_PER_DRAW) {
                return;
              }
              for (let start = 0, index = 0; start < rectStripeExtent; start += step, index += 1) {
                const next = Math.min(rectStripeExtent, start + step);
              const left = worldToScreenRect(camera, tree.isUltrametric ? rectAxisDepthForBoundary(next) : rectAxisDepthForBoundary(start), 0).x;
              const right = worldToScreenRect(camera, tree.isUltrametric ? rectAxisDepthForBoundary(start) : rectAxisDepthForBoundary(next), 0).x;
              ctx.fillStyle = gradient
                ? ageGradientStripeFill(index, bandCount, alpha)
                : index % 2 === 0
                  ? `rgba(243,244,246,${0.95 * alpha})`
                  : `rgba(255,255,255,${0.95 * alpha})`;
              ctx.fillRect(left, 0, right - left, treeDrawBottom);
              pushSceneRect(left, 0, right - left, treeDrawBottom, ctx.fillStyle, 1);
            }
          };
          if (timeStripeStyle === "age-gradient") {
            drawBands(stripeLevels[0]?.step ?? rectStripeExtent, 1, true);
          } else {
            for (let index = 0; index < stripeLevels.length; index += 1) {
              drawBands(stripeLevels[index].step, index === 0 ? 1 : stripeLevels[index].alpha * 0.82);
            }
          }
        }
      }

      const useDenseRectLOD = !exportCapture && (camera.scaleY < 1.25 || useLargeMetadataBranchLOD);
      const rectConnectorKeys = useDenseRectLOD ? new Set<string>() : null;
      const rectStemKeys = useDenseRectLOD ? new Set<string>() : null;
      const visibleRectSegments = collapsedNodes.size === 0 && needsVisibleRectSegments
        ? cache.rectIndices[order].query(
          (minX + maxX) * 0.5,
          (minY + maxY) * 0.5,
          Math.max(1e-6, (maxX - minX) * 0.5) + rectWorldOverscanX,
          Math.max(1e-6, (maxY - minY) * 0.5) + rectWorldOverscanY,
        )
        : null;
      const rectBranchRenderMode = cachedRectTaxonomyBitmap
        ? "taxonomy-cached-bitmap"
        : cachedRectTaxonomyPaths
          ? "taxonomy-cached-paths"
        : cachedRectBasePaths
          ? "cached-path"
          : useColoredBranchRendering
            ? taxonomyBranchRenderingVisible
              ? visibleRectSegments
                ? "taxonomy-visible-segments"
                : "taxonomy-full-tree"
              : visibleRectSegments
                ? "manual-visible-segments"
                : "manual-full-tree"
            : visibleRectSegments
              ? "visible-segments"
              : "full-tree";
      const baseBranchStartTime = performance.now();
      if (cachedRectTaxonomyBitmap) {
        const bitmapScaleRatioX = camera.scaleX / Math.max(cachedRectTaxonomyBitmap.scaleX, 1e-6);
        const bitmapScaleRatioY = camera.scaleY / Math.max(cachedRectTaxonomyBitmap.scaleY, 1e-6);
        const sourceWidth = Math.max(1, cachedRectTaxonomyBitmap.viewportWidth / Math.max(bitmapScaleRatioX, 1e-6));
        const sourceHeight = Math.max(1, cachedRectTaxonomyBitmap.viewportHeight / Math.max(bitmapScaleRatioY, 1e-6));
        const sourceX = Math.max(
          0,
          Math.min(
            cachedRectTaxonomyBitmap.canvas.width - sourceWidth,
            cachedRectTaxonomyBitmap.paddingX + cachedRectTaxonomyBitmap.translateX - (camera.translateX / Math.max(bitmapScaleRatioX, 1e-6)),
          ),
        );
        const sourceY = Math.max(
          0,
          Math.min(
            cachedRectTaxonomyBitmap.canvas.height - sourceHeight,
            cachedRectTaxonomyBitmap.paddingY + cachedRectTaxonomyBitmap.translateY - (camera.translateY / Math.max(bitmapScaleRatioY, 1e-6)),
          ),
        );
        ctx.drawImage(
          cachedRectTaxonomyBitmap.canvas,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          renderSize.width,
          renderSize.height,
        );
      } else if (cachedRectTaxonomyPaths) {
        ctx.save();
        ctx.translate(camera.translateX, camera.translateY);
        ctx.scale(camera.scaleX, camera.scaleY);
        ctx.lineCap = "butt";
        cachedRectTaxonomyPaths.forEach((paths, color) => {
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.95;
          ctx.lineWidth = (1.2 * rectBranchStrokeScale) / Math.max(camera.scaleX, 1e-6);
          ctx.stroke(paths.connectors);
          ctx.lineWidth = (1.2 * rectBranchStrokeScale) / Math.max(camera.scaleY, 1e-6);
          ctx.stroke(paths.stems);
        });
        ctx.globalAlpha = 1;
        ctx.restore();
      } else if (cachedRectBasePaths) {
        ctx.save();
        ctx.translate(camera.translateX, camera.translateY);
        ctx.scale(camera.scaleX, camera.scaleY);
        ctx.strokeStyle = BRANCH_COLOR;
        ctx.lineCap = "butt";
        ctx.lineWidth = rectBranchStrokeScale / Math.max(camera.scaleX, 1e-6);
        ctx.stroke(cachedRectBasePaths.connectors);
        ctx.lineWidth = rectBranchStrokeScale / Math.max(camera.scaleY, 1e-6);
        ctx.stroke(cachedRectBasePaths.stems);
        ctx.restore();
      } else if (!useColoredBranchRendering) {
        ctx.strokeStyle = BRANCH_COLOR;
        ctx.lineWidth = rectBranchStrokeScale;
        ctx.beginPath();
        if (visibleRectSegments) {
          for (let index = 0; index < visibleRectSegments.length; index += 1) {
            const segment = visibleRectSegments[index];
            if (segment.kind === "connector" && isTerminalRectConnector(tree, segment.node)) {
              continue;
            }
            const start = worldToScreenRect(camera, segment.x1, segment.y1);
            const end = worldToScreenRect(camera, segment.x2, segment.y2);
            if (useDenseRectLOD) {
              const key = quantizedSegmentKey(start.x, start.y, end.x, end.y);
              if ((segment.kind === "connector" ? rectConnectorKeys : rectStemKeys)?.has(key)) {
                continue;
              }
              (segment.kind === "connector" ? rectConnectorKeys : rectStemKeys)?.add(key);
            }
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            pushSceneLine(start.x, start.y, end.x, end.y, BRANCH_COLOR, rectBranchStrokeScale);
          }
        } else {
          for (let node = 0; node < tree.nodeCount; node += 1) {
            if (hiddenNodes[node] || collapsedNodes.has(node) || isTerminalRectConnector(tree, node)) {
              continue;
            }
            const ordered = children[node];
            if (ordered.length < 2) {
              continue;
            }
            const x = tree.buffers.depth[node];
            const firstY = layout.center[ordered[0]];
            const lastY = layout.center[ordered[ordered.length - 1]];
            if (!lineIntersectsRect(x, firstY, x, lastY, minX, minY, maxX, maxY)) {
              continue;
            }
            const start = worldToScreenRect(camera, x, firstY);
            const end = worldToScreenRect(camera, x, lastY);
            if (useDenseRectLOD) {
              const key = quantizedSegmentKey(start.x, start.y, end.x, end.y);
              if (rectConnectorKeys?.has(key)) {
                continue;
              }
              rectConnectorKeys?.add(key);
            }
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            pushSceneLine(start.x, start.y, end.x, end.y, BRANCH_COLOR, rectBranchStrokeScale);
          }
          for (let node = 0; node < tree.nodeCount; node += 1) {
            if (hiddenNodes[node]) {
              continue;
            }
            const parent = tree.buffers.parent[node];
            if (parent < 0) {
              continue;
            }
            const x1 = tree.buffers.depth[parent];
            const x2 = tree.buffers.depth[node];
            const y = layout.center[node];
            if (!lineIntersectsRect(x1, y, x2, y, minX, minY, maxX, maxY)) {
              continue;
            }
            const start = worldToScreenRect(camera, x1, y);
            const end = worldToScreenRect(camera, x2, y);
            if (useDenseRectLOD) {
              const key = quantizedSegmentKey(start.x, start.y, end.x, end.y);
              if (rectStemKeys?.has(key)) {
                continue;
              }
              rectStemKeys?.add(key);
            }
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            pushSceneLine(start.x, start.y, end.x, end.y, BRANCH_COLOR, rectBranchStrokeScale);
          }
        }
        ctx.stroke();
      } else {
        if (largeMetadataRectBasePaths) {
          ctx.save();
          ctx.translate(camera.translateX, camera.translateY);
          ctx.scale(camera.scaleX, camera.scaleY);
          ctx.strokeStyle = BRANCH_COLOR;
          ctx.globalAlpha = 0.62;
          ctx.lineCap = "butt";
          ctx.lineWidth = rectBranchStrokeScale / Math.max(camera.scaleX, 1e-6);
          ctx.stroke(largeMetadataRectBasePaths.connectors);
          ctx.lineWidth = rectBranchStrokeScale / Math.max(camera.scaleY, 1e-6);
          ctx.stroke(largeMetadataRectBasePaths.stems);
          ctx.restore();
          ctx.globalAlpha = 1;
        }
        const colorPaths = new Map<string, Path2D>();
        let coloredSegmentCount = 0;
        const coloredSegmentBudget = useLargeMetadataBranchLOD ? LARGE_METADATA_COLORED_SEGMENT_BUDGET : Number.POSITIVE_INFINITY;
        const getColorPath = (color: string): Path2D => {
          let path = colorPaths.get(color);
          if (!path) {
            path = new Path2D();
            colorPaths.set(color, path);
          }
          return path;
        };
        const pushColoredSegment = (color: string, x1: number, y1: number, x2: number, y2: number): void => {
          if (coloredSegmentCount >= coloredSegmentBudget) {
            return;
          }
          const path = getColorPath(color);
          path.moveTo(x1, y1);
          path.lineTo(x2, y2);
          coloredSegmentCount += 1;
          pushSceneLine(x1, y1, x2, y2, color, rectBranchStrokeScale);
        };
        if (visibleRectSegments) {
          for (let index = 0; index < visibleRectSegments.length && coloredSegmentCount < coloredSegmentBudget; index += 1) {
            const segment = visibleRectSegments[index];
            if (segment.kind === "connector") {
              const ownerNode = segment.node;
              if (isTerminalRectConnector(tree, ownerNode)) {
                continue;
              }
              const x = tree.buffers.depth[ownerNode];
              forEachRectConnectorChildSpan(layout, children, ownerNode, (childNode, startY, endY) => {
                if (coloredSegmentCount >= coloredSegmentBudget) {
                  return;
                }
                if (!lineIntersectsRect(x, startY, x, endY, minX, minY, maxX, maxY)) {
                  return;
                }
                const start = worldToScreenRect(camera, x, startY);
                const end = worldToScreenRect(camera, x, endY);
                if (useDenseRectLOD) {
                  const key = quantizedSegmentKey(start.x, start.y, end.x, end.y);
                  if (rectConnectorKeys?.has(key)) {
                    return;
                  }
                  rectConnectorKeys?.add(key);
                }
                const color = effectiveBranchColors?.[childNode] ?? BRANCH_COLOR;
                pushColoredSegment(color, start.x, start.y, end.x, end.y);
              });
              continue;
            }
            const start = worldToScreenRect(camera, segment.x1, segment.y1);
            const end = worldToScreenRect(camera, segment.x2, segment.y2);
            if (useDenseRectLOD) {
              const key = quantizedSegmentKey(start.x, start.y, end.x, end.y);
              if (rectStemKeys?.has(key)) {
                continue;
              }
              rectStemKeys?.add(key);
            }
            const parent = tree.buffers.parent[segment.node];
            const color = parent < 0
              ? BRANCH_COLOR
              : (effectiveBranchColors?.[segment.node] ?? BRANCH_COLOR);
            pushColoredSegment(color, start.x, start.y, end.x, end.y);
          }
        } else {
          for (let node = 0; node < tree.nodeCount && coloredSegmentCount < coloredSegmentBudget; node += 1) {
            if (hiddenNodes[node] || collapsedNodes.has(node) || isTerminalRectConnector(tree, node)) {
              continue;
            }
            if (children[node].length < 2) {
              continue;
            }
            const x = tree.buffers.depth[node];
            forEachRectConnectorChildSpan(layout, children, node, (childNode, startY, endY) => {
              if (coloredSegmentCount >= coloredSegmentBudget) {
                return;
              }
              if (!lineIntersectsRect(x, startY, x, endY, minX, minY, maxX, maxY)) {
                return;
              }
              const start = worldToScreenRect(camera, x, startY);
              const end = worldToScreenRect(camera, x, endY);
              if (useDenseRectLOD) {
                const key = quantizedSegmentKey(start.x, start.y, end.x, end.y);
                if (rectConnectorKeys?.has(key)) {
                  return;
                }
                rectConnectorKeys?.add(key);
              }
              const color = effectiveBranchColors?.[childNode] ?? BRANCH_COLOR;
              pushColoredSegment(color, start.x, start.y, end.x, end.y);
            });
          }
          for (let node = 0; node < tree.nodeCount && coloredSegmentCount < coloredSegmentBudget; node += 1) {
            if (hiddenNodes[node]) {
              continue;
            }
            const parent = tree.buffers.parent[node];
            if (parent < 0) {
              continue;
            }
            const x1 = tree.buffers.depth[parent];
            const x2 = tree.buffers.depth[node];
            const y = layout.center[node];
            if (!lineIntersectsRect(x1, y, x2, y, minX, minY, maxX, maxY)) {
              continue;
            }
            const start = worldToScreenRect(camera, x1, y);
            const end = worldToScreenRect(camera, x2, y);
            if (useDenseRectLOD) {
              const key = quantizedSegmentKey(start.x, start.y, end.x, end.y);
              if (rectStemKeys?.has(key)) {
                continue;
              }
              rectStemKeys?.add(key);
            }
            const color = effectiveBranchColors?.[node] ?? BRANCH_COLOR;
            pushColoredSegment(color, start.x, start.y, end.x, end.y);
          }
        }
        colorPaths.forEach((path, color) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = rectBranchStrokeScale;
          ctx.globalAlpha = 1;
          ctx.stroke(path);
        });
      }
      {
        const terminalConnectorStrokeWidth = cachedRectTaxonomyPaths
          ? 1.2 * rectBranchStrokeScale
          : rectBranchStrokeScale;
        const terminalConnectorPaths = new Map<string, Path2D>();
        const terminalPathForColor = (color: string): Path2D => {
          const existing = terminalConnectorPaths.get(color);
          if (existing) {
            return existing;
          }
          const path = new Path2D();
          terminalConnectorPaths.set(color, path);
          return path;
        };
        for (let node = 0; node < tree.nodeCount; node += 1) {
          if (
            hiddenNodes[node]
            || collapsedNodes.has(node)
            || !isTerminalRectConnector(tree, node)
          ) {
            continue;
          }
          const ordered = children[node];
          if (ordered.length < 2) {
            continue;
          }
          const terminalWorldX = axisDepth(tree.buffers.depth[node]);
          const terminalBoundaryX = worldToScreenRect(camera, terminalWorldX, 0).x;
          const connectorX = terminalBoundaryX - (terminalConnectorStrokeWidth * 0.5);
          if (useColoredBranchRendering) {
            forEachRectConnectorChildSpan(layout, children, node, (childNode, startY, endY) => {
              if (!lineIntersectsRect(terminalWorldX, startY, terminalWorldX, endY, minX, minY, maxX, maxY)) {
                return;
              }
              const start = worldToScreenRect(camera, terminalWorldX, startY);
              const end = worldToScreenRect(camera, terminalWorldX, endY);
              const color = effectiveBranchColors?.[childNode] ?? BRANCH_COLOR;
              const path = terminalPathForColor(color);
              path.moveTo(connectorX, start.y);
              path.lineTo(connectorX, end.y);
              pushSceneLine(connectorX, start.y, connectorX, end.y, color, terminalConnectorStrokeWidth);
            });
          } else {
            const firstY = layout.center[ordered[0]];
            const lastY = layout.center[ordered[ordered.length - 1]];
            if (!lineIntersectsRect(terminalWorldX, firstY, terminalWorldX, lastY, minX, minY, maxX, maxY)) {
              continue;
            }
            const start = worldToScreenRect(camera, terminalWorldX, firstY);
            const end = worldToScreenRect(camera, terminalWorldX, lastY);
            const path = terminalPathForColor(BRANCH_COLOR);
            path.moveTo(connectorX, start.y);
            path.lineTo(connectorX, end.y);
            pushSceneLine(connectorX, start.y, connectorX, end.y, BRANCH_COLOR, terminalConnectorStrokeWidth);
          }
        }
        ctx.lineCap = "butt";
        ctx.lineWidth = terminalConnectorStrokeWidth;
        ctx.globalAlpha = 1;
        terminalConnectorPaths.forEach((path, color) => {
          ctx.strokeStyle = color;
          ctx.stroke(path);
        });
      }
      timing.branchBaseMs += performance.now() - baseBranchStartTime;

      if (searchMatches.length > 0) {
        const drawSearchBranches = (
          nodes: number[],
          color: string,
          lineWidth: number,
          radius: number,
        ): void => {
          const points: Array<{ x: number; y: number }> = [];
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = lineWidth;
          ctx.beginPath();
          for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            if (hiddenNodes[node] || collapsedNodes.has(node)) {
              continue;
            }
            const parent = tree.buffers.parent[node];
            const y = layout.center[node];
            const x = tree.buffers.depth[node];
            if (parent >= 0) {
              const x1 = tree.buffers.depth[parent];
              if (lineIntersectsRect(x1, y, x, y, minX, minY, maxX, maxY)) {
                const start = worldToScreenRect(camera, x1, y);
                const end = worldToScreenRect(camera, x, y);
                ctx.moveTo(start.x, start.y);
                ctx.lineTo(end.x, end.y);
              }
            }
            if (children[node].length >= 2) {
              const childY1 = layout.center[children[node][0]];
              const childY2 = layout.center[children[node][children[node].length - 1]];
              if (lineIntersectsRect(x, childY1, x, childY2, minX, minY, maxX, maxY)) {
                const start = worldToScreenRect(camera, x, childY1);
                const end = worldToScreenRect(camera, x, childY2);
                ctx.moveTo(start.x, start.y);
                ctx.lineTo(end.x, end.y);
              }
            }
            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
              points.push(worldToScreenRect(camera, x, y));
            }
          }
          ctx.stroke();
          for (let index = 0; index < points.length; index += 1) {
            const point = points[index];
            ctx.beginPath();
            ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
            ctx.fill();
          }
        };

        const passiveMatches = activeSearchNode === null
          ? searchMatches
          : searchMatches.filter((node) => node !== activeSearchNode);
        drawSearchBranches(passiveMatches, "#2563eb", 1.7, 2.2);
        if (activeSearchNode !== null) {
          drawSearchBranches([activeSearchNode], "#c2410c", 2.6, 3.2);
        }
      }

      let visibleTipLabels: Array<{
        node: number;
        text: string;
        fullText: string;
        x: number;
        y: number;
        width: number;
        fittedFontSize: number;
        renderedWidth: number;
        leaderStartX: number;
      }> = [];
      const tipFontSize = scaleLabelFontSize("tip", Math.max(6.5, Math.min(22, effectiveTipSpacingPx * 0.58)));
      const microTipFontSize = scaleLabelFontSize("tip", Math.max(4.2, Math.min(6.25, effectiveTipSpacingPx * 0.34)));
      const readableBandProgress = smoothstep01((effectiveTipSpacingPx - 2.7) / Math.max(1e-6, 4.2 - 2.7));
      const tipBandFontSize = effectiveTipSpacingPx <= 2.7
        ? 0
        : microTipFontSize + ((tipFontSize - microTipFontSize) * readableBandProgress);
      const microBandWidthPx = estimateLabelWidth(Math.max(microTipFontSize, 4.2), reservedTipLabelCharacters);
      const readableBandWidthPx = estimateLabelWidth(Math.max(tipFontSize, 6.5), reservedTipLabelCharacters);
      const renderedMetadataMarkerSizePx = scaledMetadataMarkerSizePx(metadataMarkerSizePx, effectiveTipSpacingPx);
      const renderedMetadataPieSizePx = scaledMetadataGlyphSizePx(metadataPieSizePx, effectiveTipSpacingPx);
      const metadataTipDecorationLabelClearancePx = metadataTipDecorationMaxSizePx > 0
        ? Math.max(8, (Math.max(
          metadataMarkerNodes.length > 0 ? renderedMetadataMarkerSizePx : 0,
          metadataPieNodes.length > 0 ? renderedMetadataPieSizePx : 0,
        ) * 0.5) + 6)
        : 8;
      const metadataTipDecorationLabelExtraPx = Math.max(0, metadataTipDecorationLabelClearancePx - 8);
      const globalTipLabelSpacePx = showTipLabels
        ? interpolateTipBandWidthPx(
          effectiveTipSpacingPx,
          1.55,
          2.7,
          4.2,
          microBandWidthPx,
          readableBandWidthPx,
        ) + metadataTipDecorationLabelExtraPx
        : 0;
      const rectTipLabelOffsetPx = (node: number): number => {
        const tipGlyphSizePx = Math.max(
          metadataMarkers?.[node] ? renderedMetadataMarkerSizePx : 0,
          metadataPies?.[node] ? renderedMetadataPieSizePx : 0,
        );
        return Math.max(8, tipGlyphSizePx > 0 ? (tipGlyphSizePx * 0.5) + 6 : 8);
      };
      const tipSideDepth = axisDepth(tree.maxDepth);
      const tipSideX = worldToScreenRect(camera, tipSideDepth, 0).x + (showTipLabels ? 8 : 0);
      const alignedTipLabelX = tipSideX + metadataTipDecorationLabelExtraPx + figureStyles.tip.offsetPx;
      const orderedLeaves = cache.orderedLeaves[order];
      const startLeafIndex = lowerBoundLeaves(orderedLeaves, layout.center, minY - 2);
      const endLeafIndex = lowerBoundLeaves(orderedLeaves, layout.center, maxY + 2.000001);
      const visibleLeafRanges = [{ startIndex: startLeafIndex, endIndex: endLeafIndex }];
      const visibleLeafCount = Math.max(0, endLeafIndex - startLeafIndex);
      const renderedTipFontSize = tipLabelsVisible ? tipFontSize : microTipFontSize;
      let tipLabelMaxRightPx = tipSideX;
      const measuredLabels: Array<{
        node: number;
        text: string;
        fullText: string;
        x: number;
        y: number;
        width: number;
        fittedFontSize: number;
        renderedWidth: number;
        leaderStartX: number;
      }> = [];
      const maxVisibleLabels = 5200;
      const canRenderMeasuredTipLabels = microTipLabelsVisible && visibleLeafCount <= maxVisibleLabels;
      const needTipEnvelope = canRenderMeasuredTipLabels;
      if (needTipEnvelope) {
        ctx.font = fontSpec("tip", renderedTipFontSize);
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        for (let index = startLeafIndex; index < endLeafIndex; index += 1) {
          const node = orderedLeaves[index];
          if (hiddenNodes[node]) {
            continue;
          }
          const y = layout.center[node];
          const fullText = displayTipLabelForView(node);
          const screen = worldToScreenRect(camera, axisDepth(tree.buffers.depth[node]), y);
          const tipLabelOffsetPx = rectTipLabelOffsetPx(node);
          const x = alignTipLabels
            ? alignedTipLabelX
            : screen.x + tipLabelOffsetPx + figureStyles.tip.offsetPx;
          const naturalWidth = ctx.measureText(fullText).width;
          const widthLimitPx = figureStyles.tip.limitWidth
            ? Math.max(40, figureStyles.tip.maxWidthPx ?? 240)
            : Number.POSITIVE_INFINITY;
          let text = fullText;
          let fittedFontSize = renderedTipFontSize;
          if (naturalWidth > widthLimitPx) {
            if (figureStyles.tip.overflowMode === "scale") {
              fittedFontSize = renderedTipFontSize * (widthLimitPx / naturalWidth);
            } else {
              text = truncateTextToWidth(ctx, fullText, widthLimitPx);
            }
          }
          ctx.font = fontSpec("tip", fittedFontSize);
          const renderedWidth = ctx.measureText(text).width;
          ctx.font = fontSpec("tip", renderedTipFontSize);
          tipLabelMaxRightPx = Math.max(tipLabelMaxRightPx, x + renderedWidth);
          measuredLabels.push({
            node,
            text,
            fullText,
            x,
            y: screen.y,
            width: naturalWidth,
            fittedFontSize,
            renderedWidth,
            leaderStartX: screen.x + Math.max(2, tipLabelOffsetPx - 4),
          });
        }
      }
      if (canRenderMeasuredTipLabels && measuredLabels.length <= maxVisibleLabels) {
        visibleTipLabels = measuredLabels.map(({ node, text, fullText, x, y, width, fittedFontSize, renderedWidth, leaderStartX }) => ({
          node,
          text,
          fullText,
          x,
          y,
          width,
          fittedFontSize,
          renderedWidth,
          leaderStartX,
        }));
      }
      const effectiveTipLabelSpacePx = Math.max(globalTipLabelSpacePx, tipLabelMaxRightPx - tipSideX);

      const genusGapPx = Math.max(12, tipBandFontSize * 1.9);
      let rectangularFirstTaxonomyBandX: number | null = null;
      let rectangularTaxonomyEndX: number | null = null;
      const taxonomyOverlayStartTime = performance.now();
      if (taxonomyEnabled && renderedTaxonomyBlocks) {
        const visibleRanks = visibleTaxonomyRanks;
        const baseFontSize = Math.max(8.5, Math.min(18, 8.5 + (camera.scaleY * 0.45)));
        const taxonomyMetricBaseSize = Math.max(8.5, Math.min(18, 8.5 + (camera.scaleY * 0.45)));
        const metrics = taxonomyRingMetricsPx(
          visibleRanks.length,
          taxonomyMetricBaseSize,
          taxonomyBandThicknessScale,
          1,
          thickenOutermostTaxonomyRibbon,
        );
        const bandXs: number[] = [];
        const bandWidthsPx: number[] = [];
        const placedLabels: ScreenLabel[] = [];
        const placedKeys: string[] = [];
        const renderedBlocksDebug: Array<{ rank: TaxonomyRank; label: string; topY: number; bottomY: number }> = [];
        let taxonomyConnectorSegmentCount = 0;
        let bandCursorX = tipSideX + controlledRibbonGapPx(
          taxonomyGapControl,
          taxonomyBaselineGapPx,
          effectiveTipLabelSpacePx,
        );
        if (visibleRanks.length > 0) {
          rectangularFirstTaxonomyBandX = bandCursorX;
        }
        const previousTaxonomyState = taxonomyLabelHistoryRef.current;
        const preservedKeys = previousTaxonomyState
          && previousTaxonomyState.tree === tree
          && previousTaxonomyState.viewMode === "rectangular"
          && previousTaxonomyState.order === order
          && camera.scaleY > previousTaxonomyState.zoom + 1e-6
          ? previousTaxonomyState.peakVisibleKeys
          : [];
        const preservedKeySet = new Set(preservedKeys);
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        for (let rankIndex = 0; rankIndex < visibleRanks.length; rankIndex += 1) {
          const rank = visibleRanks[rankIndex];
          const rankDisplayMode = taxonomyRankDisplayModeForRank(rank);
          const rankIsLabelOnlyStrand = rankDisplayMode === "label-only";
          const orderedBlockInfo = rectTaxonomyBlockInfo?.[rank] ?? [];
          const bandX = bandCursorX;
          const bandWidthPx = metrics.ringWidthsPx[rankIndex];
          bandXs.push(bandX);
          bandWidthsPx.push(bandWidthPx);
          bandCursorX += bandWidthPx;
          const labelsForRank: ScreenLabel[] = [];
          const pendingRectStrands: Array<{ x: number; y1: number; y2: number; color: string; width: number; blockKey: string }> = [];
          for (let blockIndex = 0; blockIndex < orderedBlockInfo.length; blockIndex += 1) {
            const blockInfo = orderedBlockInfo[blockIndex];
            const block = blockInfo.block;
            const blockKey = blockInfo.key;
            const isPreservedLabel = preservedKeySet.has(blockKey);
            const blockSegments = blockInfo.segments;
            if (!taxonomyBlockIntersectsVisibleLeafRanges(blockSegments, visibleLeafRanges, tree.leafCount)) {
              continue;
            }
            const totalTipCount = blockInfo.totalTipCount;
            for (let segmentIndex = 0; segmentIndex < blockSegments.length; segmentIndex += 1) {
              const segment = blockSegments[segmentIndex];
              const bounds = blockInfo.segmentBounds[segmentIndex];
              if (!bounds) {
                continue;
              }
              const top = worldToScreenRect(camera, tree.buffers.depth[segment.firstNode], bounds.topY).y;
              const bottom = worldToScreenRect(camera, tree.buffers.depth[segment.lastNode], bounds.bottomY).y;
              if (bottom < -18 || top > renderSize.height + 18) {
                continue;
              }
              const verticalInsetPx = Math.min(0.75, Math.max(0, (bottom - top - 1) * 0.5));
              if (taxonomyOverlayStyle === "strands" || rankIsLabelOnlyStrand) {
                const strandX = bandX + (bandWidthPx * 0.5);
                const strandTop = top + verticalInsetPx;
                const strandBottom = bottom - verticalInsetPx;
                const strandWidth = Math.max(1.25, Math.min(3.2, bandWidthPx * 0.14));
                pendingRectStrands.push({
                  x: strandX,
                  y1: strandTop,
                  y2: strandBottom,
                  color: rankIsLabelOnlyStrand ? "#111827" : block.color,
                  width: strandWidth,
                  blockKey,
                });
                if (rankIsLabelOnlyStrand) {
                  const dividerHalfWidthPx = Math.max(3, Math.min(8, bandWidthPx * 0.34));
                  ctx.strokeStyle = "#111827";
                  ctx.lineWidth = Math.max(1, Math.min(2.2, strandWidth));
                  ctx.beginPath();
                  ctx.moveTo(strandX - dividerHalfWidthPx, strandTop);
                  ctx.lineTo(strandX + dividerHalfWidthPx, strandTop);
                  ctx.moveTo(strandX - dividerHalfWidthPx, strandBottom);
                  ctx.lineTo(strandX + dividerHalfWidthPx, strandBottom);
                  ctx.stroke();
                  pushSceneLine(strandX - dividerHalfWidthPx, strandTop, strandX + dividerHalfWidthPx, strandTop, "#111827", ctx.lineWidth, 1);
                  pushSceneLine(strandX - dividerHalfWidthPx, strandBottom, strandX + dividerHalfWidthPx, strandBottom, "#111827", ctx.lineWidth, 1);
                }
              } else {
                const ribbonTop = top + verticalInsetPx;
                const ribbonHeight = Math.max(1, (bottom - top) - (verticalInsetPx * 2));
                ctx.fillStyle = block.color;
                ctx.fillRect(
                  bandX,
                  ribbonTop,
                  bandWidthPx,
                  ribbonHeight,
                );
                pushSceneRect(
                  bandX,
                  ribbonTop,
                  bandWidthPx,
                  ribbonHeight,
                  block.color,
                );
                if (
                  !isOverrideRender
                  && taxonomyArcHitsRef.current.length < MAX_TAXONOMY_ARC_HITBOXES
                ) {
                  const screenPolygonPoints = [
                    { x: bandX, y: ribbonTop },
                    { x: bandX + bandWidthPx, y: ribbonTop },
                    { x: bandX + bandWidthPx, y: ribbonTop + ribbonHeight },
                    { x: bandX, y: ribbonTop + ribbonHeight },
                  ];
                  taxonomyArcHitsRef.current.push({
                    rank,
                    label: block.label,
                    taxId: block.taxId ?? null,
                    firstNode: segment.firstNode,
                    lastNode: segment.lastNode,
                    taxonomyTipCount: Math.max(
                      1,
                      segment.endIndex >= segment.startIndex
                        ? segment.endIndex - segment.startIndex
                        : segment.endIndex + tree.leafCount - segment.startIndex,
                    ),
                    startIndex: segment.startIndex,
                    endIndex: segment.endIndex,
                    startTheta: 0,
                    endTheta: 0,
                    innerRadiusPx: 0,
                    outerRadiusPx: 0,
                    screenPolygonPoints,
                    screenPolygonBounds: {
                      left: bandX,
                      right: bandX + bandWidthPx,
                      top: ribbonTop,
                      bottom: ribbonTop + ribbonHeight,
                    },
                  });
                }
              }
              if (renderedBlocksDebug.length < 240) {
                renderedBlocksDebug.push({
                  rank,
                  label: block.label,
                  topY: Math.min(top + verticalInsetPx, bottom - verticalInsetPx),
                  bottomY: Math.max(top + verticalInsetPx, bottom - verticalInsetPx),
                });
              }
              taxonomyConnectorSegmentCount += 1;
            }

            const labelSegment = blockInfo.labelSegment;
            const taxonomyTaxId = block.taxId ?? null;
            if (!taxonomyBlockIntersectsVisibleLeafRanges([labelSegment], visibleLeafRanges, tree.leafCount)) {
              continue;
            }
            if (totalTipCount <= 1) {
              continue;
            }
            const labelBounds = blockInfo.labelBounds;
            if (!labelBounds) {
              continue;
            }
            const top = worldToScreenRect(camera, tree.buffers.depth[labelSegment.firstNode], labelBounds.topY).y;
            const bottom = worldToScreenRect(camera, tree.buffers.depth[labelSegment.lastNode], labelBounds.bottomY).y;
            const spanPx = Math.max(0, bottom - top);
            const minimumSpanPx = rank === "genus"
              ? (isPreservedLabel ? 10 : 18)
              : rank === "family"
                ? (isPreservedLabel ? 14 : 22)
                : (isPreservedLabel ? 18 : 30);
            if (spanPx < minimumSpanPx) {
              continue;
            }
            const minFontSize = rank === "genus"
              ? (isPreservedLabel ? 4.5 : 5.2)
              : rank === "family"
                ? (isPreservedLabel ? 5.5 : 6.2)
                : (isPreservedLabel ? 6 : 7.5);
            const normalizedMetrics = measureNormalizedLabelMetrics(ctx, block.label, labelFontFamilies.taxonomy);
            const paddingFraction = 0.12;
            const availableSpanPx = Math.max(0, spanPx * (1 - paddingFraction));
            const availableBandPx = Math.max(0, bandWidthPx * (1 - paddingFraction));
            const fitFontSize = Math.min(30 * taxonomyLabelFitScale, Math.min(
              availableSpanPx / normalizedMetrics.widthAtOnePx,
              availableBandPx / normalizedMetrics.heightAtOnePx,
            ) * 0.94);
            if (!Number.isFinite(fitFontSize) || fitFontSize < minFontSize) {
              continue;
            }
            const visibleTop = Math.max(0, top);
            const visibleBottom = Math.min(renderSize.height, bottom);
            const blockSpansViewport = top <= 0 && bottom >= renderSize.height;
            const labelX = bandX + (bandWidthPx * 0.5);
            const labelY = blockSpansViewport
              ? renderSize.height * 0.5
              : Math.max(visibleTop, Math.min((top + bottom) * 0.5, visibleBottom));
            const rotation = Math.PI * 0.5;
            const searchMatchRange = findSearchMatchRange(block.label, searchQuery);
            const searchHighlightColor = searchMatchRange
              ? (activeSearchTaxonomyKey === blockKey ? "#c2410c" : "#2563eb")
              : undefined;
            ctx.font = `${fitFontSize}px ${labelFontFamilies.taxonomy}`;
            let textMetrics = ctx.measureText(block.label);
            let ascent = textMetrics.actualBoundingBoxAscent || (fitFontSize * 0.72);
            let descent = textMetrics.actualBoundingBoxDescent || (fitFontSize * 0.28);
            let textHeightPx = ascent + descent;
            let viewportScale = viewportScaleForCenteredRotatedLabel(
              labelX,
              labelY,
              textMetrics.width,
              textHeightPx,
              rotation,
              renderSize.width,
              renderSize.height,
              2,
            );
            let finalFontSize = fitFontSize * Math.max(0.01, viewportScale) * 0.96;
            if (finalFontSize < minFontSize) {
              continue;
            }
            ctx.font = `${finalFontSize}px ${labelFontFamilies.taxonomy}`;
            textMetrics = ctx.measureText(block.label);
            ascent = textMetrics.actualBoundingBoxAscent || (finalFontSize * 0.72);
            descent = textMetrics.actualBoundingBoxDescent || (finalFontSize * 0.28);
            textHeightPx = ascent + descent;
            viewportScale = viewportScaleForCenteredRotatedLabel(
              labelX,
              labelY,
              textMetrics.width,
              textHeightPx,
              rotation,
              renderSize.width,
              renderSize.height,
              2,
            );
            if (viewportScale < 0.999) {
              finalFontSize *= viewportScale * 0.98;
              if (finalFontSize < minFontSize) {
                continue;
              }
              ctx.font = `${finalFontSize}px ${labelFontFamilies.taxonomy}`;
              textMetrics = ctx.measureText(block.label);
            }
            finalFontSize = Math.max(3.5, finalFontSize * taxonomyLabelSizeScale);
            finalFontSize = Math.min(finalFontSize, Math.max(3.5, fitFontSize * 0.98));
            ctx.font = `${finalFontSize}px ${labelFontFamilies.taxonomy}`;
            textMetrics = ctx.measureText(block.label);
            if (!isPreservedLabel && !canPlaceLinearLabel(
              labelsForRank,
              labelX,
              labelY,
              Math.max(18, textMetrics.width * 0.9),
              Math.max(8, bandWidthPx + metrics.ringGapPx),
            )) {
              continue;
            }
            labelsForRank.push({
              x: labelX,
              y: labelY,
              text: block.label,
              key: blockKey,
              rank,
              alpha: 1,
              fontSize: finalFontSize,
              bandSizePx: bandWidthPx,
              rotation,
              align: "center",
              color: rankIsLabelOnlyStrand ? "#111827" : taxonomyOverlayTextColor(block.color, taxonomyOverlayStyle),
              taxonomyDisplayMode: rankDisplayMode,
              searchHighlightColor,
              searchMatchRange,
              taxId: taxonomyTaxId,
              firstNode: labelSegment.firstNode,
              lastNode: labelSegment.lastNode,
              taxonomyTipCount: totalTipCount,
              taxonomyStartIndex: labelSegment.startIndex,
              taxonomyEndIndex: labelSegment.endIndex,
              offsetY: 0,
            });
            placedKeys.push(blockKey);
          }
          if (taxonomyOverlayStyle === "strands" || rankIsLabelOnlyStrand) {
            const labelByKey = new Map(labelsForRank.map((label) => [label.key ?? "", label]));
            for (let strandIndex = 0; strandIndex < pendingRectStrands.length; strandIndex += 1) {
              const strand = pendingRectStrands[strandIndex];
              const label = labelByKey.get(strand.blockKey) ?? null;
              const y1 = Math.min(strand.y1, strand.y2);
              const y2 = Math.max(strand.y1, strand.y2);
              const intervals: Array<{ start: number; end: number }> = [];
              if (label && typeof label.fontSize === "number") {
                ctx.font = `${label.fontSize}px ${labelFontFamilies.taxonomy}`;
                const labelWidth = ctx.measureText(label.text).width;
                const gapHalfHeight = (labelWidth * 0.5) + Math.max(4, label.fontSize * 0.35);
                const gapStart = label.y - gapHalfHeight;
                const gapEnd = label.y + gapHalfHeight;
                if (gapStart > y1) {
                  intervals.push({ start: y1, end: Math.min(gapStart, y2) });
                }
                if (gapEnd < y2) {
                  intervals.push({ start: Math.max(gapEnd, y1), end: y2 });
                }
              } else {
                intervals.push({ start: y1, end: y2 });
              }
              ctx.strokeStyle = strand.color;
              ctx.lineWidth = strand.width;
              for (let intervalIndex = 0; intervalIndex < intervals.length; intervalIndex += 1) {
                const interval = intervals[intervalIndex];
                if (interval.end - interval.start < 0.8) {
                  continue;
                }
                ctx.beginPath();
                ctx.moveTo(strand.x, interval.start);
                ctx.lineTo(strand.x, interval.end);
                ctx.stroke();
                pushSceneLine(strand.x, interval.start, strand.x, interval.end, strand.color, strand.width, 1);
              }
            }
          }
          placedLabels.push(...labelsForRank);
          bandCursorX += metrics.ringGapPx;
        }
        rectangularTaxonomyEndX = bandCursorX;
        for (let index = 0; index < placedLabels.length; index += 1) {
          const label = placedLabels[index];
          ctx.font = `${label.fontSize ?? baseFontSize}px ${labelFontFamilies.taxonomy}`;
          const labelMetrics = ctx.measureText(label.text);
          ctx.save();
          ctx.translate(label.x, label.y);
          ctx.rotate(label.rotation ?? 0);
          drawHighlightedText(
            ctx,
            label.text,
            0,
            label.offsetY ?? 0,
            "center",
            label.color ?? "#0f172a",
            label.searchHighlightColor ?? null,
            label.searchMatchRange ?? null,
          );
          ctx.restore();
          pushSceneText(
            label.text,
            label.x,
            label.y + (label.offsetY ?? 0),
            label.searchHighlightColor ?? label.color ?? "#0f172a",
            label.fontSize ?? baseFontSize,
            labelFontFamilies.taxonomy,
            "middle",
            label.rotation ?? 0,
          );
          drawPhyloPicForTaxonomyLabel(label, labelMetrics.width, label.fontSize ?? baseFontSize, placedLabels);
          labelHitsRef.current.push({
            node: label.firstNode ?? 0,
            kind: "rect",
            source: "label",
            labelKind: "taxonomy",
            text: label.text,
            taxonomyRank: label.rank,
            taxonomyTaxId: label.taxId ?? null,
            taxonomyFirstNode: label.firstNode,
            taxonomyLastNode: label.lastNode,
            taxonomyTipCount: label.taxonomyTipCount,
            taxonomyStartIndex: label.taxonomyStartIndex,
            taxonomyEndIndex: label.taxonomyEndIndex,
            x: label.x - Math.max(10, (label.fontSize ?? baseFontSize) * 0.7),
            y: label.y - (labelMetrics.width * 0.5),
            width: Math.max(20, (label.fontSize ?? baseFontSize) * 1.4),
            height: Math.max(20, labelMetrics.width),
          });
        }
        renderDebug.rect = {
          branchRenderMode: rectBranchRenderMode,
          cueVisible: tipLabelCueVisible,
          microVisible: microTipLabelsVisible,
          tipVisible: tipLabelsVisible,
          effectiveTipSpacingPx,
          tipBandFontSize,
          tipBandWidthPx: effectiveTipLabelSpacePx,
          tipLabelMaxRightPx,
          tipSideX,
          genusGapPx: null,
          genusBandX: bandXs[0] ?? null,
          genusBandOffsetPx: bandXs.length > 0 ? bandXs[0] - tipSideX : null,
          connectorXs: bandXs.slice(0, 12),
          leafEdgeCenters: orderedLeaves.length > 0
            ? {
              topY: worldToScreenRect(camera, 0, layout.center[orderedLeaves[0]]).y,
              bottomY: worldToScreenRect(camera, 0, layout.center[orderedLeaves[orderedLeaves.length - 1]]).y,
            }
            : null,
          taxonomyVisibleRanks: visibleRanks,
          taxonomyBandXs: bandXs,
          taxonomyBandWidthsPx: bandWidthsPx,
          taxonomyConnectorSegmentCount,
          taxonomyPlacedLabelCount: placedLabels.length,
          taxonomyRenderedBlocks: renderedBlocksDebug,
          taxonomyBlockCounts: Object.fromEntries(
            TAXONOMY_RANKS.map((rank) => [rank, renderedTaxonomyBlocks[rank]?.length ?? 0]),
          ),
          taxonomyPlacedLabels: placedLabels.map((label) => ({
            key: label.key ?? null,
            rank: label.rank ?? null,
            text: label.text,
            x: label.x,
            y: label.y,
            fontSize: label.fontSize ?? 0,
            rotation: label.rotation ?? 0,
            color: label.color ?? null,
            searchHighlightColor: label.searchHighlightColor ?? null,
          })),
        };
        genusLabelHistoryRef.current = {
          tree,
          viewMode: "rectangular",
          order,
          zoom: camera.scaleY,
          visibleCenters: [],
          peakZoom: camera.scaleY,
          peakVisibleCenters: [],
        };
        taxonomyLabelHistoryRef.current = {
          tree,
          viewMode: "rectangular",
          order,
          zoom: camera.scaleY,
          visibleKeys: placedKeys,
          peakZoom: previousTaxonomyState
            && previousTaxonomyState.tree === tree
            && previousTaxonomyState.viewMode === "rectangular"
            && previousTaxonomyState.order === order
            ? Math.max(previousTaxonomyState.peakZoom, camera.scaleY)
            : camera.scaleY,
          peakVisibleKeys: previousTaxonomyState
            && previousTaxonomyState.tree === tree
            && previousTaxonomyState.viewMode === "rectangular"
            && previousTaxonomyState.order === order
            && camera.scaleY > previousTaxonomyState.zoom + 1e-6
            ? Array.from(new Set([...previousTaxonomyState.peakVisibleKeys, ...placedKeys]))
            : placedKeys,
        };
      } else if (!taxonomyEnabled && showGenusLabels) {
        const priorityBlocks = cache.genusBlocksPriority[order];
        const positionalBlocks = cache.genusBlocks[order];
        const previousGenusState = genusLabelHistoryRef.current;
        const preservedCenters = previousGenusState
          && previousGenusState.tree === tree
          && previousGenusState.viewMode === "rectangular"
          && previousGenusState.order === order
          && camera.scaleY > previousGenusState.zoom + 1e-6
          ? previousGenusState.peakVisibleCenters
          : [];
        const blockByCenter = new Map<number, GenusBlock>();
        for (let index = 0; index < priorityBlocks.length; index += 1) {
          blockByCenter.set(priorityBlocks[index].centerNode, priorityBlocks[index]);
        }
        const preservedBlocks = preservedCenters
          .map((centerNode) => blockByCenter.get(centerNode))
          .filter((block): block is GenusBlock => block !== undefined);
        const baseFontSize = scaleLabelFontSize("genus", Math.max(10, Math.min(16, camera.scaleY * 0.38)));
        const genusOrderByCenter = new Map<number, number>();
        for (let index = 0; index < positionalBlocks.length; index += 1) {
          genusOrderByCenter.set(positionalBlocks[index].centerNode, index);
        }
        const genusBandX = tipSideX + effectiveTipLabelSpacePx + genusGapPx;
        ctx.fillStyle = GENUS_COLOR;
        ctx.strokeStyle = GENUS_COLOR;
        ctx.lineWidth = 1;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        const maxGenusLabels = Math.max(18, Math.ceil(renderSize.height / 18));
        const placedLabels: ScreenLabel[] = [];
        const connectorBlocks: Array<{ x: number; y1: number; y2: number; color: string }> = [];
        const placedCenters = new Set<number>();
        const tryPlaceBlock = (block: GenusBlock): void => {
          if (hiddenNodes[block.centerNode]) {
            return;
          }
          if (placedLabels.length >= maxGenusLabels || placedCenters.has(block.centerNode)) {
            return;
          }
          const y1 = layout.center[block.firstNode];
          const y2 = layout.center[block.lastNode];
          if (y2 < minY - 2 || y1 > maxY + 2) {
            return;
          }
          const spanPx = Math.abs(y2 - y1) * camera.scaleY;
          const x = genusBandX;
          if (x < -80 || x > renderSize.width + 160) {
            return;
          }
          const screenStart = worldToScreenRect(camera, block.maxDepth, y1);
          const screenEnd = worldToScreenRect(camera, block.maxDepth, y2);
          const labelY = (screenStart.y + screenEnd.y) * 0.5;
          const fontSize = Math.max(baseFontSize, Math.min(22, baseFontSize + (spanPx * 0.08)));
          if (!canPlaceLinearLabel(
            placedLabels,
            x + 7 + figureStyles.genus.offsetPx,
            labelY,
            fontSize * 0.9,
            Math.max(24, fontSize * 1.75),
          )) {
            return;
          }
          const genusOrderIndex = genusOrderByCenter.get(block.centerNode) ?? 0;
          const isActiveGenus = block.centerNode === activeSearchGenusCenterNode;
          const matchRange = findSearchMatchRange(block.label, searchQuery);
          placedCenters.add(block.centerNode);
          placedLabels.push({
            x: x + 7 + figureStyles.genus.offsetPx,
            y: labelY,
            text: block.label,
            alpha: 1,
            fontSize,
            color: matchRange ? (isActiveGenus ? "#c2410c" : "#2563eb") : undefined,
          });
          connectorBlocks.push({
            x,
            y1: screenStart.y,
            y2: screenEnd.y,
            color: isActiveGenus ? "#c2410c" : GENUS_CONNECTOR_COLORS[genusOrderIndex % GENUS_CONNECTOR_COLORS.length],
          });
        };
        for (let index = 0; index < preservedBlocks.length; index += 1) {
          tryPlaceBlock(preservedBlocks[index]);
          if (placedLabels.length >= maxGenusLabels) {
            break;
          }
        }
        for (let index = 0; index < priorityBlocks.length; index += 1) {
          tryPlaceBlock(priorityBlocks[index]);
          if (placedLabels.length >= maxGenusLabels) {
            break;
          }
        }
        if (placedLabels.length < maxGenusLabels) {
          for (let index = 0; index < positionalBlocks.length; index += 1) {
            tryPlaceBlock(positionalBlocks[index]);
            if (placedLabels.length >= maxGenusLabels) {
              break;
            }
          }
        }
        if (connectorBlocks.length > 0) {
          for (let index = 0; index < connectorBlocks.length; index += 1) {
            const block = connectorBlocks[index];
            ctx.beginPath();
            ctx.moveTo(block.x, block.y1);
            ctx.lineTo(block.x, block.y2);
            ctx.strokeStyle = block.color;
            ctx.globalAlpha = 0.82;
            ctx.stroke();
            pushSceneLine(block.x, block.y1, block.x, block.y2, block.color, 1, 0.82);
          }
          ctx.globalAlpha = 1;
        }
        for (let index = 0; index < placedLabels.length; index += 1) {
          const label = placedLabels[index];
          ctx.font = `${label.fontSize ?? baseFontSize}px ${labelFontFamilies.genus}`;
          drawHighlightedText(
            ctx,
            label.text,
            label.x,
            label.y,
            "left",
            GENUS_COLOR,
            label.color ?? null,
            findSearchMatchRange(label.text, searchQuery),
          );
          pushSceneText(
            label.text,
            label.x,
            label.y,
            label.color ?? GENUS_COLOR,
            label.fontSize ?? baseFontSize,
            labelFontFamilies.genus,
            "start",
          );
        }
        ctx.globalAlpha = 1;
        renderDebug.rect = {
          branchRenderMode: rectBranchRenderMode,
          cueVisible: tipLabelCueVisible,
          microVisible: microTipLabelsVisible,
          tipVisible: tipLabelsVisible,
          effectiveTipSpacingPx,
          tipBandFontSize,
          tipBandWidthPx: effectiveTipLabelSpacePx,
          tipLabelMaxRightPx,
          tipSideX,
          genusGapPx,
          genusBandX,
          genusBandOffsetPx: genusBandX - tipSideX,
          connectorXs: connectorBlocks.slice(0, 12).map((block) => block.x),
        };
        genusLabelHistoryRef.current = {
          tree,
          viewMode: "rectangular",
          order,
          zoom: camera.scaleY,
          visibleCenters: [...placedCenters],
          peakZoom: previousGenusState
            && previousGenusState.tree === tree
            && previousGenusState.viewMode === "rectangular"
            && previousGenusState.order === order
            && camera.scaleY < previousGenusState.peakZoom
            ? previousGenusState.peakZoom
            : camera.scaleY,
          peakVisibleCenters: previousGenusState
            && previousGenusState.tree === tree
            && previousGenusState.viewMode === "rectangular"
            && previousGenusState.order === order
            && camera.scaleY < previousGenusState.peakZoom
            ? previousGenusState.peakVisibleCenters
            : [...placedCenters],
        };
        taxonomyLabelHistoryRef.current = {
          tree,
          viewMode: "rectangular",
          order,
          zoom: camera.scaleY,
          visibleKeys: [],
          peakZoom: camera.scaleY,
          peakVisibleKeys: [],
        };
      } else {
        renderDebug.rect = {
          branchRenderMode: rectBranchRenderMode,
          cueVisible: tipLabelCueVisible,
          microVisible: microTipLabelsVisible,
          tipVisible: tipLabelsVisible,
          effectiveTipSpacingPx,
          tipBandFontSize,
          tipBandWidthPx: effectiveTipLabelSpacePx,
          tipLabelMaxRightPx,
          tipSideX,
          genusGapPx: null,
          genusBandX: null,
          genusBandOffsetPx: null,
          connectorXs: [],
        };
        genusLabelHistoryRef.current = {
          tree,
          viewMode: "rectangular",
          order,
          zoom: camera.scaleY,
          visibleCenters: [],
          peakZoom: camera.scaleY,
          peakVisibleCenters: [],
        };
        taxonomyLabelHistoryRef.current = {
          tree,
          viewMode: "rectangular",
          order,
          zoom: camera.scaleY,
          visibleKeys: [],
          peakZoom: camera.scaleY,
          peakVisibleKeys: [],
        };
      }
      timing.taxonomyOverlayMs += performance.now() - taxonomyOverlayStartTime;

      if (visibleTipLabels.length > 0) {
        if (alignTipLabels) {
          ctx.save();
          ctx.strokeStyle = "rgba(100,116,139,0.7)";
          ctx.lineWidth = 0.9;
          ctx.lineCap = "round";
          ctx.setLineDash([1.5, 3]);
          ctx.beginPath();
          for (let index = 0; index < visibleTipLabels.length; index += 1) {
            const label = visibleTipLabels[index];
            const leaderEndX = label.x - 4;
            if (leaderEndX <= label.leaderStartX + 1) {
              continue;
            }
            ctx.moveTo(label.leaderStartX, label.y);
            ctx.lineTo(leaderEndX, label.y);
            pushSceneLine(
              label.leaderStartX,
              label.y,
              leaderEndX,
              label.y,
              "#64748b",
              0.9,
              0.7,
              "1.5 3",
            );
          }
          ctx.stroke();
          ctx.restore();
        }
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (let index = 0; index < visibleTipLabels.length; index += 1) {
          const label = visibleTipLabels[index];
          const fittedFontSize = label.fittedFontSize;
          ctx.font = fontSpec("tip", fittedFontSize);
          if (tipLabelsVisible) {
            const highlightColor = label.node === activeSearchNode
              ? "#c2410c"
              : searchMatchSet.has(label.node)
                ? "#2563eb"
                : null;
            drawHighlightedText(
              ctx,
              label.text,
              label.x,
              label.y,
              "left",
              "#111827",
              highlightColor,
              highlightColor ? findSearchMatchRange(label.text, searchQuery) : null,
            );
            pushSceneText(
              label.text,
              label.x,
              label.y,
              highlightColor ?? "#111827",
              fittedFontSize,
              labelFontFamilies.tip,
              "start",
              undefined,
              labelFontStyles.tip,
            );
            labelHitsRef.current.push({
              node: label.node,
              kind: "rect",
              source: "label",
              labelKind: "tip",
              text: label.fullText,
              x: label.x,
              y: label.y - (fittedFontSize * 0.55),
              width: label.renderedWidth,
              height: fittedFontSize * 1.1,
            });
          } else {
            ctx.fillStyle = "rgba(15,23,42,0.6)";
            ctx.fillText(label.text, label.x, label.y);
            pushSceneText(label.text, label.x, label.y, "rgba(15,23,42,0.6)", fittedFontSize, labelFontFamilies.tip, "start", undefined, labelFontStyles.tip);
          }
        }
        if (tipLabelsVisible && metadataTipTableData && metadataTipTableData.columns.length > 0) {
          const labelRightX = visibleTipLabels.reduce((right, label) => Math.max(right, label.x + label.renderedWidth), tipSideX);
          const tableStartX = Math.max(labelRightX + 16, (rectangularTaxonomyEndX ?? rectangularFirstTaxonomyBandX ?? labelRightX) + 16);
          const rowHeight = Math.max(3, Math.min(28, effectiveTipSpacingPx * 0.82));
          const firstVisibleY = visibleTipLabels.reduce((top, label) => Math.min(top, label.y), Number.POSITIVE_INFINITY);
          ctx.font = `11px ${LABEL_FONT}`;
          const maximumHeaderRise = metadataTipTableData.columns.reduce(
            (maximum, column) => Math.max(maximum, ctx.measureText(column.label).width * Math.SQRT1_2),
            0,
          );
          const headerY = Math.max(maximumHeaderRise + 8, firstVisibleY - (rowHeight * 0.65) - 7);
          if (renderDebug.rect && typeof renderDebug.rect === "object") {
            (renderDebug.rect as Record<string, unknown>).metadataTipTable = {
              mode: metadataTipTableMode,
              tableStartX,
              headerY,
              columnCount: metadataTipTableData.columns.length,
              visibleMatchedTipCount: visibleTipLabels.reduce((count, label) => (
                metadataTipTableData.valuesByNode[label.node] ? count + 1 : count
              ), 0),
            };
          }
          const drawHeader = (text: string, x: number): void => {
            ctx.save();
            ctx.translate(x, headerY);
            ctx.rotate(-Math.PI / 4);
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.font = `11px ${LABEL_FONT}`;
            ctx.fillStyle = "#334155";
            ctx.fillText(text, 0, 0);
            ctx.restore();
            pushSceneText(text, x, headerY, "#334155", 11, LABEL_FONT, "start", -Math.PI / 4);
          };
          if (metadataTipTableMode === "bars") {
            const column = metadataTipTableData.columns[0];
            if (column) {
              drawHeader(column.label, tableStartX);
              const min = Math.min(0, column.min ?? 0);
              const max = Math.max(0, column.max ?? 0);
              const span = Math.max(1e-9, max - min);
              const zeroX = tableStartX + (((0 - min) / span) * metadataTipTableBarWidthPx);
              ctx.strokeStyle = "rgba(100,116,139,0.52)";
              ctx.lineWidth = 0.8;
              ctx.beginPath();
              ctx.moveTo(zeroX, Math.max(headerY + 6, firstVisibleY - (rowHeight * 0.5)));
              ctx.lineTo(zeroX, Math.min(renderSize.height, visibleTipLabels[visibleTipLabels.length - 1].y + (rowHeight * 0.5)));
              ctx.stroke();
              pushSceneLine(zeroX, Math.max(headerY + 6, firstVisibleY - (rowHeight * 0.5)), zeroX, Math.min(renderSize.height, visibleTipLabels[visibleTipLabels.length - 1].y + (rowHeight * 0.5)), "#64748b", 0.8, 0.52);
              for (let index = 0; index < visibleTipLabels.length; index += 1) {
                const label = visibleTipLabels[index];
                const rawValue = metadataTipTableData.valuesByNode[label.node]?.[0] ?? "";
                const value = Number(rawValue);
                if (!rawValue || !Number.isFinite(value)) {
                  continue;
                }
                const valueX = tableStartX + (((value - min) / span) * metadataTipTableBarWidthPx);
                const left = Math.min(zeroX, valueX);
                const width = Math.max(1, Math.abs(valueX - zeroX));
                const top = label.y - (rowHeight * 0.36);
                const height = Math.max(2, rowHeight * 0.72);
                ctx.fillStyle = "rgba(37,99,235,0.78)";
                ctx.fillRect(left, top, width, height);
                pushSceneRect(left, top, width, height, "#2563eb", 0.78);
              }
            }
          } else {
            const cellWidth = metadataTipTableCellWidthPx;
            for (let columnIndex = 0; columnIndex < metadataTipTableData.columns.length; columnIndex += 1) {
              const column = metadataTipTableData.columns[columnIndex];
              const cellX = tableStartX + (columnIndex * cellWidth);
              drawHeader(column.label, cellX + (cellWidth * 0.5));
              for (let rowIndex = 0; rowIndex < visibleTipLabels.length; rowIndex += 1) {
                const label = visibleTipLabels[rowIndex];
                const value = metadataTipTableData.valuesByNode[label.node]?.[columnIndex] ?? "";
                const top = label.y - (rowHeight * 0.45);
                const height = Math.max(2, rowHeight * 0.9);
                ctx.strokeStyle = "rgba(148,163,184,0.35)";
                ctx.lineWidth = 0.55;
                ctx.strokeRect(cellX, top, cellWidth, height);
                pushScenePath(`M ${cellX.toFixed(3)} ${top.toFixed(3)} h ${cellWidth.toFixed(3)} v ${height.toFixed(3)} h ${(-cellWidth).toFixed(3)} Z`, "#94a3b8", 0.55, "none", 0.35);
                if (!value) {
                  continue;
                }
                if (metadataTipTableMode === "heatmap") {
                  const numeric = Number(value);
                  if (!Number.isFinite(numeric) || column.min === null || column.max === null) {
                    continue;
                  }
                  const color = metadataTipTableContinuousColor(numeric, column.min, column.max, metadataTipTablePalette);
                  ctx.fillStyle = color;
                  ctx.fillRect(cellX, top, cellWidth, height);
                  pushSceneRect(cellX, top, cellWidth, height, color);
                  continue;
                }
                if (!metadataTipTableValueIsOn(value) && metadataTipTableCellStyle === "check") {
                  continue;
                }
                const color = column.categoryColors[value] ?? "#475569";
                const centerX = cellX + (cellWidth * 0.5);
                const size = Math.max(2, Math.min(cellWidth - 4, height - 2));
                if (metadataTipTableCellStyle === "filled") {
                  ctx.fillStyle = color;
                  ctx.fillRect(cellX, top, cellWidth, height);
                  pushSceneRect(cellX, top, cellWidth, height, color);
                } else if (metadataTipTableCellStyle === "circle") {
                  ctx.fillStyle = color;
                  ctx.beginPath();
                  ctx.arc(centerX, label.y, size * 0.5, 0, Math.PI * 2);
                  ctx.fill();
                  pushScenePath(`M ${(centerX - (size * 0.5)).toFixed(3)} ${label.y.toFixed(3)} a ${(size * 0.5).toFixed(3)} ${(size * 0.5).toFixed(3)} 0 1 0 ${size.toFixed(3)} 0 a ${(size * 0.5).toFixed(3)} ${(size * 0.5).toFixed(3)} 0 1 0 ${(-size).toFixed(3)} 0`, undefined, undefined, color);
                } else if (metadataTipTableCellStyle === "square") {
                  ctx.fillStyle = color;
                  ctx.fillRect(centerX - (size * 0.5), label.y - (size * 0.5), size, size);
                  pushSceneRect(centerX - (size * 0.5), label.y - (size * 0.5), size, size, color);
                } else {
                  const text = metadataTipTableCellStyle === "check" ? "\u2713" : value;
                  const fontSize = Math.max(4, Math.min(12, size));
                  ctx.font = `${fontSize}px ${LABEL_FONT}`;
                  ctx.textAlign = "center";
                  ctx.textBaseline = "middle";
                  ctx.fillStyle = metadataTipTableCellStyle === "check" ? color : "#0f172a";
                  ctx.fillText(text, centerX, label.y);
                  pushSceneText(text, centerX, label.y, metadataTipTableCellStyle === "check" ? color : "#0f172a", fontSize, LABEL_FONT, "middle");
                }
              }
            }
          }
        }
      } else if (tipLabelCueVisible && measuredLabels.length <= 9000) {
        ctx.strokeStyle = "rgba(15,23,42,0.42)";
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        for (let index = 0; index < measuredLabels.length; index += 1) {
          const label = measuredLabels[index];
          const cueLength = Math.max(3.5, Math.min(7, camera.scaleY * 0.7));
          ctx.moveTo(label.x, label.y);
          ctx.lineTo(label.x + cueLength, label.y);
          pushSceneLine(label.x, label.y, label.x + cueLength, label.y, "rgba(15,23,42,0.42)", 0.9);
        }
        ctx.stroke();
      }

      if (showInternalNodeLabels || showBootstrapLabels) {
        const labels: ScreenLabel[] = [];
        for (let node = 0; node < tree.nodeCount; node += 1) {
          if (hiddenNodes[node] || tree.buffers.firstChild[node] < 0) {
            continue;
          }
          const rawLabel = (tree.names[node] ?? "").trim();
          if (!rawLabel) {
            continue;
          }
          const isBootstrap = isNumericInternalLabel(rawLabel);
          if ((isBootstrap && !showBootstrapLabels) || (!isBootstrap && !showInternalNodeLabels)) {
            continue;
          }
          const displayLabel = isBootstrap
            ? formatLabelDecimals(Number(rawLabel), figureStyles.bootstrap.decimalPlaces, () => rawLabel)
            : rawLabel;
          const labelClass: LabelStyleClass = isBootstrap ? "bootstrap" : "internalNode";
          const baseFontSize = pointLabelBaseFontSize(isBootstrap, effectiveTipSpacingPx);
          const fontSize = scaleLabelFontSize(labelClass, baseFontSize);
          const labelWidth = estimateLabelWidth(fontSize, displayLabel.length);
          const screen = worldToScreenRect(camera, tree.buffers.depth[node], layout.center[node]);
          const x = screen.x + (isBootstrap ? -labelWidth - 5 : 8) + figureStyles[labelClass].offsetXPx;
          const y = screen.y - (isBootstrap ? Math.max(5, fontSize * 0.6) : 10) + figureStyles[labelClass].offsetYPx;
          if (x < -40 || x > renderSize.width + 140 || y < -20 || y > renderSize.height + 20) {
            continue;
          }
          const parent = tree.buffers.parent[node];
          const subtreeSpanPx = Math.max(0, layout.max[node] - layout.min[node]) * camera.scaleY;
          const branchSpanPx = parent >= 0
            ? Math.max(0, tree.buffers.depth[node] - tree.buffers.depth[parent]) * camera.scaleX
            : 0;
          if (!pointLabelHasScreenRoom(subtreeSpanPx, branchSpanPx, fontSize, labelWidth)) {
            continue;
          }
          if (!canPlaceLinearLabel(labels, x, y, fontSize * 1.3, labelWidth)) {
            continue;
          }
          labels.push({ x, y, text: displayLabel, alpha: 0.92, fontSize, color: isBootstrap ? "#475569" : "#1f2937" });
        }
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (let index = 0; index < labels.length; index += 1) {
          const label = labels[index];
          const labelClass: LabelStyleClass = isNumericInternalLabel(label.text) ? "bootstrap" : "internalNode";
          ctx.font = `${label.fontSize ?? 10}px ${labelFontFamilies[labelClass]}`;
          ctx.fillStyle = label.color ?? "#1f2937";
          ctx.globalAlpha = label.alpha;
          ctx.fillText(label.text, label.x, label.y);
          pushSceneText(label.text, label.x, label.y, label.color ?? "#1f2937", label.fontSize ?? 10, labelFontFamilies[labelClass], "start");
        }
        ctx.globalAlpha = 1;
      }

      if (visibleCollapsedNodes.length > 0) {
        ctx.lineWidth = 1.1;
        for (let index = 0; index < visibleCollapsedNodes.length; index += 1) {
          ctx.fillStyle = "#cbd5e1";
          ctx.strokeStyle = "#64748b";
          const node = visibleCollapsedNodes[index];
          const collapseMode = collapsedNodeModes.get(node) ?? "preserve-width";
          const taxonomyGroup = collapsedTaxonomyGroupByNode.get(node) ?? null;
          const taxonomyHitbox = taxonomyGroup
            ? {
                labelKind: "taxonomy" as const,
                text: taxonomyGroup.label,
                taxonomyRank: taxonomyGroup.rank,
                taxonomyTaxId: taxonomyGroup.taxId,
                taxonomyFirstNode: taxonomyGroup.firstNode,
                taxonomyLastNode: taxonomyGroup.lastNode,
                taxonomyTipCount: taxonomyGroup.descendantTipCount,
                taxonomyCollapseNode: node,
              }
            : {};
          const parent = tree.buffers.parent[node];
          const rawApex = worldToScreenRect(camera, axisDepth(tree.buffers.depth[node]), layout.center[node]);
          const apex = isTerminalRectConnector(tree, node)
            ? { x: rawApex.x - (ctx.lineWidth * 0.5), y: rawApex.y }
            : rawApex;
          const subtreeTipDepth = measureSubtreeMaxDepth(tree, node);
          const rawBaseTop = worldToScreenRect(camera, axisDepth(subtreeTipDepth), layout.min[node]);
          const rawBaseBottom = worldToScreenRect(camera, axisDepth(subtreeTipDepth), layout.max[node]);
          const baseBoundaryX = rawBaseTop.x - (ctx.lineWidth * 0.5);
          let baseTop = { x: baseBoundaryX, y: rawBaseTop.y };
          let baseBottom = { x: baseBoundaryX, y: rawBaseBottom.y };
          if (collapseMode === "minimize") {
            [baseTop, baseBottom] = expandedMinimizedTriangleBase(
              apex,
              baseTop,
              baseBottom,
              renderSize.height,
            );
          }
          ctx.beginPath();
          ctx.moveTo(apex.x, apex.y);
          ctx.lineTo(baseTop.x, baseTop.y);
          ctx.lineTo(baseBottom.x, baseBottom.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          const hitMinX = Math.min(apex.x, baseTop.x, baseBottom.x);
          const hitMaxX = Math.max(apex.x, baseTop.x, baseBottom.x);
          const hitMinY = Math.min(apex.y, baseTop.y, baseBottom.y);
          const hitMaxY = Math.max(apex.y, baseTop.y, baseBottom.y);
          if (!isOverrideRender) {
            collapsedTriangleHitsRef.current.push({
              node,
              points: [apex, baseTop, baseBottom],
            });
          }
          labelHitsRef.current.push({
            node,
            kind: "rect",
            source: "collapse",
            collapsePart: "triangle",
            ...taxonomyHitbox,
            x: hitMinX,
            y: hitMinY,
            width: hitMaxX - hitMinX,
            height: hitMaxY - hitMinY,
          });
          if (collapseMode === "minimize" && taxonomyGroup) {
            const fontSize = scaleLabelFontSize("taxonomy", 14);
            ctx.font = fontSpec("taxonomy", fontSize);
            const labelWidth = ctx.measureText(taxonomyGroup.label).width;
            const labelLeftX = rectangularFirstTaxonomyBandX ?? (hitMaxX + 8);
            const labelX = labelLeftX + (labelWidth * 0.5);
            const labelY = (hitMinY + hitMaxY) * 0.5;
            ctx.fillStyle = "#1f2937";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(taxonomyGroup.label, labelX, labelY);
            pushSceneText(
              taxonomyGroup.label,
              labelX,
              labelY,
              "#1f2937",
              fontSize,
              labelFontFamilies.taxonomy,
              "middle",
            );
            labelHitsRef.current.push({
              node,
              kind: "rect",
              source: "collapse",
              collapsePart: "label",
              ...taxonomyHitbox,
              x: labelX - (labelWidth * 0.5) - 5,
              y: labelY - (fontSize * 0.65),
              width: labelWidth + 10,
              height: fontSize * 1.3,
            });
          }
          if (parent >= 0) {
            const edgeStart = worldToScreenRect(camera, axisDepth(tree.buffers.depth[parent]), layout.center[node]);
            const edgeMinX = Math.min(edgeStart.x, apex.x);
            const edgeMaxX = Math.max(edgeStart.x, apex.x);
            const edgeMinY = Math.min(edgeStart.y, apex.y) - 8;
            const edgeMaxY = Math.max(edgeStart.y, apex.y) + 8;
            labelHitsRef.current.push({
              node,
              kind: "rect",
              source: "collapse-edge",
              x: edgeMinX,
              y: edgeMinY,
              width: Math.max(10, edgeMaxX - edgeMinX),
              height: Math.max(16, edgeMaxY - edgeMinY),
            });
          }
        }
      }

      if (showNodeHeightLabels) {
        const labels: ScreenLabel[] = [];
        const fontSize = scaleLabelFontSize("nodeHeight", pointLabelBaseFontSize(false, effectiveTipSpacingPx));
        ctx.font = `${fontSize}px ${labelFontFamilies.nodeHeight}`;
        ctx.fillStyle = "#64748b";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        for (let node = 0; node < tree.nodeCount; node += 1) {
          if (tree.buffers.firstChild[node] < 0) {
            continue;
          }
          const parent = tree.buffers.parent[node];
          const x = tree.buffers.depth[node];
          const y = layout.center[node];
          if (x < minX || x > maxX || y < minY || y > maxY) {
            continue;
          }
          const subtreeSpanPx = Math.max(0, (layout.max[node] - layout.min[node]) * camera.scaleY);
          const branchSpanPx = parent >= 0
            ? Math.max(0, (tree.buffers.depth[node] - tree.buffers.depth[parent]) * camera.scaleX)
            : 0;
          const text = formatLabelDecimals(
            nodeHeightValue(tree, node),
            figureStyles.nodeHeight.decimalPlaces,
            () => formatAgeNumber(nodeHeightValue(tree, node)),
          );
          const labelWidth = ctx.measureText(text).width;
          if (!pointLabelHasScreenRoom(subtreeSpanPx, branchSpanPx, fontSize, labelWidth)) {
            continue;
          }
          const screen = worldToScreenRect(camera, x, y);
          const labelX = screen.x + figureStyles.nodeHeight.offsetXPx;
          const automaticSeparationY = showBootstrapLabels
            ? Math.max(7, fontSize * 0.75)
            : -Math.max(5, fontSize * 0.6);
          const labelY = screen.y + automaticSeparationY + figureStyles.nodeHeight.offsetYPx;
          if (!canPlaceLinearLabel(labels, labelX, labelY, fontSize * 1.7, Math.max(labelWidth, fontSize * 4.8))) {
            continue;
          }
          labels.push({
            x: labelX,
            y: labelY,
            text,
            alpha: 0.78,
            fontSize,
          });
        }
        for (let index = 0; index < labels.length; index += 1) {
          const label = labels[index];
          ctx.globalAlpha = label.alpha;
          ctx.fillText(label.text, label.x, label.y);
          pushSceneText(label.text, label.x, label.y, "#64748b", label.fontSize ?? fontSize, labelFontFamilies.nodeHeight, "middle");
        }
        ctx.globalAlpha = 1;
      }

      if (metadataPieNodes.length > 0 && metadataPies && camera.scaleX > 0.95 && renderedMetadataPieSizePx > 0) {
        const maxVisibleMetadataPies = 1200;
        const visiblePies: Array<{
          pie: NonNullable<(typeof metadataPies)[number]>;
          x: number;
          y: number;
        }> = [];
        const orderedPieNodes = metadataPieNodesByOrder[order];
        for (let index = 0; index < orderedPieNodes.length; index += 1) {
          const node = orderedPieNodes[index];
          if (hiddenNodes[node]) {
            continue;
          }
          const pie = metadataPies[node];
          if (!pie) {
            continue;
          }
          const x = tree.buffers.depth[node];
          const y = layout.center[node];
          if (x < minX || x > maxX || y < minY || y > maxY) {
            continue;
          }
          const screen = metadataRectPieScreenPosition(tree, node, y, camera, renderedMetadataPieSizePx);
          visiblePies.push({
            pie,
            x: screen.x,
            y: screen.y,
          });
        }
        const sampledPies = evenlySampleSortedItems(visiblePies, maxVisibleMetadataPies);
        for (let index = 0; index < sampledPies.length; index += 1) {
          const pie = sampledPies[index];
          drawMetadataPie(ctx, pie.pie, pie.x, pie.y, renderedMetadataPieSizePx);
          pushMetadataPieScenePaths(pushScenePath, pie.pie, pie.x, pie.y, renderedMetadataPieSizePx);
        }
      }

      if (metadataMarkerNodes.length > 0 && metadataMarkers && renderedMetadataMarkerSizePx > 0) {
        const maxVisibleMetadataMarkers = 1800;
        const visibleMarkers: Array<{
          marker: NonNullable<(typeof metadataMarkers)[number]>;
          x: number;
          y: number;
        }> = [];
        ctx.lineWidth = 1.1;
        const orderedMarkerNodes = metadataMarkerNodesByOrder[order];
        for (let index = 0; index < orderedMarkerNodes.length; index += 1) {
          const node = orderedMarkerNodes[index];
          if (hiddenNodes[node]) {
            continue;
          }
          const marker = metadataMarkers[node];
          if (!marker) {
            continue;
          }
          const x = tree.buffers.depth[node];
          const y = layout.center[node];
          if (x < minX || x > maxX || y < minY || y > maxY) {
            continue;
          }
          const { x: markerX, y: markerY } = metadataRectMarkerScreenPosition(tree, node, y, camera, renderedMetadataMarkerSizePx);
          visibleMarkers.push({
            marker,
            x: markerX,
            y: markerY,
          });
        }
        const sampledMarkers = evenlySampleSortedItems(visibleMarkers, maxVisibleMetadataMarkers);
        for (let index = 0; index < sampledMarkers.length; index += 1) {
          const marker = sampledMarkers[index];
          ctx.fillStyle = marker.marker.color;
          ctx.strokeStyle = "rgba(255,255,255,0.92)";
          drawMetadataMarker(ctx, marker.marker.shape, marker.x, marker.y, renderedMetadataMarkerSizePx);
          ctx.fill();
          ctx.stroke();
          pushScenePath(metadataMarkerPath(marker.marker.shape, marker.x, marker.y, renderedMetadataMarkerSizePx), "rgba(255,255,255,0.92)", 1.1, marker.marker.color, 1);
        }
      }

      if (metadataLabelNodes.length > 0 && metadataLabels && camera.scaleX > 1.05) {
        const fontSize = scaleLabelFontSize("internalNode", Math.max(8, Math.min(12, Math.min(camera.scaleY * 0.25, camera.scaleX * 0.18))));
        const labels: ScreenLabel[] = [];
        ctx.font = `${fontSize}px ${labelFontFamilies.internalNode}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const maxVisibleMetadataLabels = Math.max(1, metadataLabelMaxCount);
        for (let index = 0; index < metadataLabelNodes.length; index += 1) {
          if (labels.length >= maxVisibleMetadataLabels) {
            break;
          }
          const node = metadataLabelNodes[index];
          if (hiddenNodes[node]) {
            continue;
          }
          const labelText = metadataLabels[node];
          if (!labelText) {
            continue;
          }
          const x = tree.buffers.depth[node];
          const y = layout.center[node];
          if (x < minX || x > maxX || y < minY || y > maxY) {
            continue;
          }
          const screen = worldToScreenRect(camera, x, y);
          const labelX = screen.x + 10 + figureStyles.internalNode.offsetXPx + metadataLabelOffsetXPx;
          const labelY = screen.y - 12 + figureStyles.internalNode.offsetYPx + metadataLabelOffsetYPx;
          if (!canPlaceLinearLabel(
            labels,
            labelX,
            labelY,
            (fontSize * 1.5) + metadataLabelMinSpacingPx,
            estimateLabelWidth(fontSize, labelText.length) + metadataLabelMinSpacingPx,
          )) {
            continue;
          }
          labels.push({
            x: labelX,
            y: labelY,
            text: labelText,
            alpha: 0.9,
            fontSize,
            color: effectiveBranchColors?.[node] ?? metadataBranchColorOverlay.colors[node] ?? "#1f2937",
          });
        }
        for (let index = 0; index < labels.length; index += 1) {
          const label = labels[index];
          ctx.globalAlpha = label.alpha;
          ctx.fillStyle = label.color ?? "#1f2937";
          ctx.fillText(label.text, label.x, label.y);
          pushSceneText(label.text, label.x, label.y, label.color ?? "#1f2937", label.fontSize ?? fontSize, labelFontFamilies.internalNode, "start");
        }
        ctx.globalAlpha = 1;
      }

      let rectErrorBarCount = 0;
      if (showNodeErrorBars && tree.nodeIntervalCount > 0 && camera.scaleX > 1.1) {
        const placements: ScreenLabel[] = [];
        const halfCap = Math.max(0, errorBarCapSizePx * 0.5);
        const halfThickness = Math.max(0.25, errorBarThicknessPx * 0.5);
        for (let node = 0; node < tree.nodeCount; node += 1) {
          if (tree.buffers.firstChild[node] < 0) {
            continue;
          }
          const lower = tree.nodeIntervalLower[node];
          const upper = tree.nodeIntervalUpper[node];
          if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
            continue;
          }
          const y = layout.center[node];
          if (y < minY || y > maxY) {
            continue;
          }
          const start = worldToScreenRect(camera, lower, y);
          const end = worldToScreenRect(camera, upper, y);
          const midX = (start.x + end.x) * 0.5;
          const midY = start.y;
          const subtreeSpanPx = Math.max(0, (layout.max[node] - layout.min[node]) * camera.scaleY);
          const intervalSpanPx = Math.abs(end.x - start.x);
          if (camera.scaleY <= 3.2 && subtreeSpanPx < 10 && intervalSpanPx < 12) {
            continue;
          }
          if (!canPlaceLinearLabel(placements, midX, midY, 10, 18)) {
            continue;
          }
          placements.push({ x: midX, y: midY, text: "", alpha: 1 });
          ctx.globalAlpha = errorBarOpacity;
          if (errorBarStyle === "rectangle") {
            const left = Math.min(start.x, end.x);
            const width = Math.max(0.5, Math.abs(end.x - start.x));
            ctx.fillStyle = errorBarColor;
            ctx.fillRect(left, midY - halfThickness, width, errorBarThicknessPx);
            pushSceneRect(left, midY - halfThickness, width, errorBarThicknessPx, errorBarColor, errorBarOpacity);
          } else {
            ctx.strokeStyle = errorBarColor;
            ctx.lineWidth = errorBarThicknessPx;
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            if (halfCap > 0) {
              ctx.moveTo(start.x, start.y - halfCap);
              ctx.lineTo(start.x, start.y + halfCap);
              ctx.moveTo(end.x, end.y - halfCap);
              ctx.lineTo(end.x, end.y + halfCap);
            }
            ctx.stroke();
            pushSceneLine(start.x, start.y, end.x, end.y, errorBarColor, errorBarThicknessPx, errorBarOpacity);
            if (halfCap > 0) {
              pushSceneLine(start.x, start.y - halfCap, start.x, start.y + halfCap, errorBarColor, errorBarThicknessPx, errorBarOpacity);
              pushSceneLine(end.x, end.y - halfCap, end.x, end.y + halfCap, errorBarColor, errorBarThicknessPx, errorBarOpacity);
            }
          }
          if (errorBarShowNodeDot) {
            const nodeScreen = worldToScreenRect(camera, tree.buffers.depth[node], y);
            const radius = Math.max(2, Math.min(5, errorBarThicknessPx * 0.65));
            ctx.globalAlpha = Math.min(1, errorBarOpacity + 0.3);
            ctx.fillStyle = errorBarColor;
            ctx.beginPath();
            ctx.arc(nodeScreen.x, nodeScreen.y, radius, 0, Math.PI * 2);
            ctx.fill();
            pushScenePath(
              `M ${nodeScreen.x - radius} ${nodeScreen.y} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`,
              undefined,
              undefined,
              errorBarColor,
              Math.min(1, errorBarOpacity + 0.3),
            );
          }
          rectErrorBarCount += 1;
        }
        ctx.globalAlpha = 1;
      }
      if (!renderDebug.rect || typeof renderDebug.rect !== "object") {
        renderDebug.rect = {};
      }
      (renderDebug.rect as Record<string, unknown>).errorBarCount = rectErrorBarCount;

      if (showScaleBars) {
        ctx.fillStyle = "rgba(251,252,254,0.96)";
        ctx.fillRect(0, renderSize.height - axisBarHeight, renderSize.width, axisBarHeight);
        const axisY = renderSize.height - 28;
        ctx.strokeStyle = "#6b7280";
        ctx.fillStyle = "#6b7280";
        ctx.lineWidth = 1;
        const scaleFontSize = scaleLabelFontSize("scale", 11);
        ctx.font = fontSpec("scale", scaleFontSize);
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.beginPath();
        const axisStart = tree.isUltrametric
          ? worldToScreenRect(camera, rectAxisDepthForBoundary(rectScaleExtent), 0).x
          : worldToScreenRect(camera, rectAxisDepthForBoundary(0), 0).x;
        const axisEnd = tree.isUltrametric
          ? worldToScreenRect(camera, rectAxisDepthForBoundary(0), 0).x
          : worldToScreenRect(camera, rectAxisDepthForBoundary(stripeExtent), 0).x;
        ctx.moveTo(axisStart, axisY);
        ctx.lineTo(axisEnd, axisY);
        pushSceneLine(axisStart, axisY, axisEnd, axisY, "#6b7280", 1);
        if (displayedRectScaleBoundaries.length > 0) {
          for (let index = 0; index < displayedRectScaleBoundaries.length; index += 1) {
            const boundary = displayedRectScaleBoundaries[index];
            const x = worldToScreenRect(camera, rectAxisDepthForBoundary(boundary.value), 0).x;
            ctx.globalAlpha = 0.35 + (0.65 * boundary.alpha);
            ctx.moveTo(x, axisY);
            ctx.lineTo(x, axisY + (4 + (3 * boundary.alpha)));
            pushSceneLine(x, axisY, x, axisY + (4 + (3 * boundary.alpha)), "#6b7280", 1, 0.35 + (0.65 * boundary.alpha));
          }
          ctx.globalAlpha = 1;
          ctx.stroke();
          for (let index = 0; index < displayedRectScaleBoundaries.length; index += 1) {
            const boundary = displayedRectScaleBoundaries[index];
            const x = worldToScreenRect(camera, rectAxisDepthForBoundary(boundary.value), 0).x;
            ctx.globalAlpha = 0.35 + (0.65 * boundary.alpha);
            ctx.fillText(scaleLabelText(boundary.value), x, axisY + 8);
            pushSceneText(
              scaleLabelText(boundary.value),
              x,
              axisY + 8,
              "#6b7280",
              scaleFontSize,
              labelFontFamilies.scale,
              "middle",
              undefined,
              labelFontStyles.scale,
            );
          }
          ctx.globalAlpha = 1;
        }
      } else {
        ctx.stroke();
      }
    }

    if (viewMode === "spiral" && camera.kind === "circular") {
      const layout = collapsedView?.layout ?? tree.layouts[order];
      const visibleTaxonomyRanks = spiralVisibleTaxonomyRanksForScale(camera.scale);
      const metrics = spiralMetricsForScale(visibleTaxonomyRanks.length, camera.scale);
      const timeBoundaryValues = buildSpiralTimeBoundaries(metrics.timeExtent);
      const spiralToScreen = (point: { x: number; y: number }) => worldToScreenCircular(camera, point.x, point.y);
      const spiralTipSpacingPx = (
        (metrics.totalArcLength / Math.max(1, tree.leafCount - 1))
        * camera.scale
        * (collapsedView?.effectiveLeafScale ?? 1)
      );
      const spiralTaxonomyWidth = visibleTaxonomyRanks.length > 0
        ? (visibleTaxonomyRanks.length * metrics.taxonomyRibbonWidth)
          + (Math.max(0, visibleTaxonomyRanks.length - 1) * metrics.taxonomyRibbonGap)
          + metrics.taxonomyLabelGap
        : 0;
      const spiralInterTurnGapPx = Math.max(
        0,
        (metrics.pitch - metrics.bandWidth - spiralTaxonomyWidth) * camera.scale,
      );
      const spiralTipRampProgress = smoothstep01(
        (spiralTipSpacingPx - SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX)
        / Math.max(1e-6, 20 - SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX),
      );
      const spiralNaturalTipFontSize = scaleLabelFontSize(
        "tip",
        Math.max(
          1.8,
          Math.min(
            15,
            2 + (13 * spiralTipRampProgress),
            spiralTipSpacingPx * 0.72,
          ),
        ),
      );
      const spiralRenderedTipFontSize = spiralNaturalTipFontSize;
      const spiralNaturalTipLabelBandWidthPx = estimateLabelWidth(
        Math.max(spiralRenderedTipFontSize, 1.8),
        reservedTipLabelCharacters,
      );
      const spiralTipLabelGapPx = Math.max(5, spiralRenderedTipFontSize * 0.55)
        + Math.max(0, figureStyles.tip.offsetPx);
      const spiralRequiredTipClearancePx = visibleTaxonomyRanks.length > 0
        ? Math.max(0, taxonomyGapControl - 1)
          + taxonomyBaselineGapPx
          + spiralNaturalTipLabelBandWidthPx
          + Math.max(0, figureStyles.tip.offsetPx)
        : spiralTipLabelGapPx + spiralNaturalTipLabelBandWidthPx;
      const spiralTipLabelsVisible = (
        showTipLabels
        && spiralTipSpacingPx > SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX
        && spiralInterTurnGapPx >= spiralRequiredTipClearancePx
      );
      const spiralTipLabelBandWidthPx = spiralTipLabelsVisible
        ? spiralNaturalTipLabelBandWidthPx
        : 0;
      const taxonomyMetrics = compressedSpiralTaxonomyMetrics(
        metrics,
        camera.scale,
        spiralTipSpacingPx,
        visibleTaxonomyRanks.length,
        taxonomyBandThicknessScale,
      );
      const spiralRenderedTaxonomyWidthPx = visibleTaxonomyRanks.length > 0
        ? (
          (visibleTaxonomyRanks.length * taxonomyMetrics.taxonomyRibbonWidth)
          + (Math.max(0, visibleTaxonomyRanks.length - 1) * taxonomyMetrics.taxonomyRibbonGap)
          + taxonomyMetrics.taxonomyLabelGap
        ) * camera.scale
        : 0;
      const spiralNaturalTaxonomyWidthPx = spiralTaxonomyWidth * camera.scale;
      const hasSpiralTipLabelBand = spiralTipLabelBandWidthPx > 0.5;
      const spiralFirstGapPx = controlledRibbonGapPx(
        taxonomyGapControl,
        (taxonomyMetrics.taxonomyLabelGap * camera.scale)
          + (hasSpiralTipLabelBand ? taxonomyBaselineGapPx : 0),
        hasSpiralTipLabelBand
          ? spiralTipLabelBandWidthPx + Math.max(0, figureStyles.tip.offsetPx)
          : 0,
      );
      const spiralFirstTaxonomyRibbonInnerOffset = taxonomyMetrics.bandWidth
        + (spiralFirstGapPx / Math.max(camera.scale, 1e-6));
      const spiralBranchDetailProgress = smoothstep01(
        (spiralTipSpacingPx - SPIRAL_BRANCH_DETAIL_START_SPACING_PX)
        / Math.max(
          1e-6,
          SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX - SPIRAL_BRANCH_DETAIL_START_SPACING_PX,
        ),
      );
      const spiralBranchStrokeAutoMultiplier = detailBranchThicknessMultiplier(
        spiralTipSpacingPx,
        SPIRAL_TIP_LABEL_VISIBILITY_SPACING_PX,
      );
      const spiralBranchLineWidthPx = (
        SPIRAL_DENSE_BRANCH_WIDTH_PX
        + (
          (SPIRAL_DETAIL_BRANCH_WIDTH_PX - SPIRAL_DENSE_BRANCH_WIDTH_PX)
          * spiralBranchDetailProgress
        )
      ) * branchStrokeScale * spiralBranchStrokeAutoMultiplier;
      renderDebug.tipSpacingPx = spiralTipSpacingPx;
      renderDebug.tipLabelsVisible = spiralTipLabelsVisible;
      renderDebug.branchStrokeAutoMultiplier = spiralBranchStrokeAutoMultiplier;
      renderDebug.renderedBranchStrokeScale = branchStrokeScale * spiralBranchStrokeAutoMultiplier;
      const spiralBaseBranchOpacity = SPIRAL_DENSE_BASE_BRANCH_OPACITY
        + (
          (SPIRAL_DETAIL_BRANCH_OPACITY - SPIRAL_DENSE_BASE_BRANCH_OPACITY)
          * spiralBranchDetailProgress
        );
      const spiralColoredBranchOpacity = SPIRAL_DENSE_COLORED_BRANCH_OPACITY
        + (
          (SPIRAL_DETAIL_BRANCH_OPACITY - SPIRAL_DENSE_COLORED_BRANCH_OPACITY)
          * spiralBranchDetailProgress
        );
      let spiralGenusOffsetFromTipsPx: number | null = null;
      let spiralGenusLineWidthPx: number | null = null;
      let spiralGenusMaxFontSizePx: number | null = null;
      let spiralPlacedGenusLabelCount = 0;
      let spiralFirstGenusWorld: { x: number; y: number } | null = null;

      if (showTimeStripes && timeStripeStyle === "bands") {
        const bandCount = Math.max(1, timeBoundaryValues.length - 1);
        for (let index = 0; index < timeBoundaryValues.length - 1; index += 1) {
          const younger = timeBoundaryValues[index];
          const older = timeBoundaryValues[index + 1];
          const outerOffset = spiralOffsetForAge(younger, metrics);
          const innerOffset = spiralOffsetForAge(older, metrics);
          const isYoungestBand = index === 0;
          const isOldestBand = index === bandCount - 1;
          const isGrayBand = isOldestBand || (!isYoungestBand && (bandCount - 1 - index) % 2 === 0);
          ctx.fillStyle = isGrayBand ? "rgba(229,231,235,0.78)" : "rgba(255,255,255,0.9)";
          drawSpiralRibbonScreenPath(ctx, camera, metrics.startTheta, metrics.startTheta + metrics.totalTheta, innerOffset, outerOffset, metrics);
          pushScenePath(
            () => svgSpiralRibbonScreenPath(camera, metrics.startTheta, metrics.startTheta + metrics.totalTheta, innerOffset, outerOffset, metrics, camera.scale),
            undefined,
            undefined,
            ctx.fillStyle,
            1,
          );
        }
      } else if (showTimeStripes && timeStripeStyle === "age-gradient") {
        const bandCount = Math.max(1, timeBoundaryValues.length - 1);
        for (let index = 0; index < timeBoundaryValues.length - 1; index += 1) {
          const younger = timeBoundaryValues[index];
          const older = timeBoundaryValues[index + 1];
          const outerOffset = spiralOffsetForAge(younger, metrics);
          const innerOffset = spiralOffsetForAge(older, metrics);
          ctx.fillStyle = ageGradientStripeFill(index, bandCount, 1);
          drawSpiralRibbonScreenPath(ctx, camera, metrics.startTheta, metrics.startTheta + metrics.totalTheta, innerOffset, outerOffset, metrics);
          pushScenePath(
            () => svgSpiralRibbonScreenPath(camera, metrics.startTheta, metrics.startTheta + metrics.totalTheta, innerOffset, outerOffset, metrics, camera.scale),
            undefined,
            undefined,
            ctx.fillStyle,
            1,
          );
        }
      } else if (showTimeStripes) {
        const safeScale = Math.max(camera.scale, 1e-6);
        ctx.save();
        ctx.strokeStyle = "rgba(148,163,184,0.58)";
        ctx.lineWidth = timeStripeLineWeight / safeScale;
        ctx.setLineDash([6 / safeScale, 6 / safeScale]);
        ctx.translate(camera.translateX, camera.translateY);
        ctx.scale(camera.scale, camera.scale);
        ctx.rotate(camera.rotation);
        for (let index = 1; index < timeBoundaryValues.length - 1; index += 1) {
          const path = new Path2D();
          appendSpiralCurve(path, metrics.startTheta, metrics.startTheta + metrics.totalTheta, timeBoundaryValues[index], metrics, camera.scale);
          ctx.stroke(path);
          pushScenePath(
            () => svgSpiralCurveScreenPath(camera, metrics.startTheta, metrics.startTheta + metrics.totalTheta, timeBoundaryValues[index], metrics, camera.scale),
            "rgba(148,163,184,0.58)",
            timeStripeLineWeight,
            undefined,
            undefined,
            DASHED_STRIPE_DASH_ARRAY,
          );
        }
        ctx.restore();
      }

      const branchColorRanks = taxonomyColorRanks.length > 0 ? taxonomyColorRanks : visibleTaxonomyRanks;
      const coloredBranchKey = taxonomyEnabled && taxonomyBranchColoringEnabled && branchColorRanks.length > 0 && taxonomyColors !== null
        ? `taxonomy:${branchColorRanks.join("|")}:${taxonomyColorPalette}:${taxonomyCustomPaletteSignature}:${taxonomyColorJitter.toFixed(3)}:${taxonomyColorRootRank}:${taxonomyColorJitterRank}:${metadataBranchColorVersion}:${manualBranchColorVersion}`
        : metadataBranchColorOverlay.hasAny || manualBranchColorOverlay.hasAny
          ? `manual:${metadataBranchColorVersion}:${manualBranchColorVersion}`
          : "";
      const effectiveBranchColors = coloredBranchKey ? getEffectiveBranchColors(order, branchColorRanks) : null;
      const branchPaths = getSpiralBranchPaths(
        order,
        layout,
        coloredBranchKey || `base:${branchStrokeScale.toFixed(3)}`,
        effectiveBranchColors,
        metrics,
        hiddenNodes,
        camera.scale,
      );
      ctx.save();
      ctx.translate(camera.translateX, camera.translateY);
      ctx.scale(camera.scale, camera.scale);
      ctx.rotate(camera.rotation);
      ctx.lineCap = "butt";
      branchPaths?.forEach((batches, color) => {
        ctx.strokeStyle = color;
        ctx.globalAlpha = color === BRANCH_COLOR
          ? spiralBaseBranchOpacity
          : spiralColoredBranchOpacity;
        ctx.lineWidth = spiralBranchLineWidthPx / Math.max(camera.scale, 1e-6);
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          ctx.stroke(batches[batchIndex].path);
        }
      });
      ctx.globalAlpha = 1;
      ctx.restore();
      if (exportCaptureRef.current) {
        const thetaByNode = new Float64Array(tree.nodeCount);
        const spiralChildren = cache.orderedChildren[order];
        for (let node = 0; node < tree.nodeCount; node += 1) {
          thetaByNode[node] = spiralThetaForY(layout.center[node], tree.leafCount, metrics);
        }
        for (let node = 0; node < tree.nodeCount; node += 1) {
          if (hiddenNodes[node]) {
            continue;
          }
          const parent = tree.buffers.parent[node];
          const branchColor = effectiveBranchColors?.[node] ?? BRANCH_COLOR;
          const branchOpacity = branchColor === BRANCH_COLOR
            ? spiralBaseBranchOpacity
            : spiralColoredBranchOpacity;
          if (parent >= 0) {
            const theta = thetaByNode[node];
            const start = spiralPointAt(theta, spiralAgeForDepth(tree, tree.buffers.depth[parent], metrics), metrics);
            const end = spiralPointAt(theta, spiralAgeForDepth(tree, tree.buffers.depth[node], metrics), metrics);
            const startScreen = spiralToScreen(start);
            const endScreen = spiralToScreen(end);
            pushSceneLine(startScreen.x, startScreen.y, endScreen.x, endScreen.y, branchColor, spiralBranchLineWidthPx, branchOpacity);
          }
          const ordered = spiralChildren[node];
          if (ordered.length < 2 || collapsedNodes.has(node)) {
            continue;
          }
          const ownerAge = spiralAgeForDepth(tree, tree.buffers.depth[node], metrics);
          const ownerTheta = thetaByNode[node];
          for (let childIndex = 0; childIndex < ordered.length; childIndex += 1) {
            const child = ordered[childIndex];
            if (hiddenNodes[child]) {
              continue;
            }
            const childColor = effectiveBranchColors?.[child] ?? BRANCH_COLOR;
            pushScenePath(
              () => svgSpiralCurveScreenPath(
                camera,
                Math.min(ownerTheta, thetaByNode[child]),
                Math.max(ownerTheta, thetaByNode[child]),
                ownerAge,
                metrics,
                1,
              ),
              childColor,
              spiralBranchLineWidthPx,
              undefined,
              childColor === BRANCH_COLOR
                ? spiralBaseBranchOpacity
                : spiralColoredBranchOpacity,
            );
          }
        }
      }
      if (visibleCollapsedNodes.length > 0) {
        ctx.lineWidth = 1.1;
        for (let index = 0; index < visibleCollapsedNodes.length; index += 1) {
          ctx.fillStyle = "#cbd5e1";
          ctx.strokeStyle = "#64748b";
          const node = visibleCollapsedNodes[index];
          const collapseMode = collapsedNodeModes.get(node) ?? "preserve-width";
          const taxonomyGroup = collapsedTaxonomyGroupByNode.get(node) ?? null;
          const taxonomyHitbox = taxonomyGroup
            ? {
                labelKind: "taxonomy" as const,
                text: taxonomyGroup.label,
                taxonomyRank: taxonomyGroup.rank,
                taxonomyTaxId: taxonomyGroup.taxId,
                taxonomyFirstNode: taxonomyGroup.firstNode,
                taxonomyLastNode: taxonomyGroup.lastNode,
                taxonomyTipCount: taxonomyGroup.descendantTipCount,
                taxonomyCollapseNode: node,
              }
            : {};
          const apexTheta = spiralThetaForY(layout.center[node], tree.leafCount, metrics);
          const startTheta = spiralThetaForY(layout.min[node], tree.leafCount, metrics);
          const endTheta = spiralThetaForY(layout.max[node], tree.leafCount, metrics);
          const apexWorld = spiralPointAt(
            apexTheta,
            spiralAgeForDepth(tree, tree.buffers.depth[node], metrics),
            metrics,
          );
          const subtreeTipDepth = measureSubtreeMaxDepth(tree, node);
          const baseAge = spiralAgeForDepth(tree, subtreeTipDepth, metrics);
          const baseStartWorld = spiralPointAt(startTheta, baseAge, metrics);
          const baseEndWorld = spiralPointAt(endTheta, baseAge, metrics);
          const apex = spiralToScreen(apexWorld);
          const baseStart = spiralToScreen(baseStartWorld);
          const baseEnd = spiralToScreen(baseEndWorld);
          ctx.beginPath();
          ctx.moveTo(apex.x, apex.y);
          ctx.lineTo(baseStart.x, baseStart.y);
          ctx.lineTo(baseEnd.x, baseEnd.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          pushScenePath(
            `M ${apex.x} ${apex.y} L ${baseStart.x} ${baseStart.y} L ${baseEnd.x} ${baseEnd.y} Z`,
            "#64748b",
            1.1,
            "#cbd5e1",
            1,
          );
          const hitMinX = Math.min(apex.x, baseStart.x, baseEnd.x);
          const hitMaxX = Math.max(apex.x, baseStart.x, baseEnd.x);
          const hitMinY = Math.min(apex.y, baseStart.y, baseEnd.y);
          const hitMaxY = Math.max(apex.y, baseStart.y, baseEnd.y);
          if (!isOverrideRender) {
            collapsedTriangleHitsRef.current.push({
              node,
              points: [apex, baseStart, baseEnd],
            });
          }
          labelHitsRef.current.push({
            node,
            kind: "rect",
            source: "collapse",
            collapsePart: "triangle",
            ...taxonomyHitbox,
            x: hitMinX,
            y: hitMinY,
            width: hitMaxX - hitMinX,
            height: hitMaxY - hitMinY,
          });
          if (collapseMode === "minimize" && taxonomyGroup) {
            const fontSize = scaleLabelFontSize("taxonomy", 14);
            ctx.font = fontSpec("taxonomy", fontSize);
            const labelWidth = ctx.measureText(taxonomyGroup.label).width;
            const labelFrame = spiralFrameAt(
              apexTheta,
              spiralFirstTaxonomyRibbonInnerOffset,
              taxonomyMetrics,
            );
            const labelPoint = spiralToScreen(labelFrame);
            const cosRotation = Math.cos(camera.rotation);
            const sinRotation = Math.sin(camera.rotation);
            const normalX = (labelFrame.normalX * cosRotation) - (labelFrame.normalY * sinRotation);
            const normalY = (labelFrame.normalX * sinRotation) + (labelFrame.normalY * cosRotation);
            const renderedNormalAngle = Math.atan2(normalY, normalX);
            const onRightSide = normalX >= 0;
            const labelRotation = onRightSide
              ? renderedNormalAngle
              : renderedNormalAngle + Math.PI;
            const labelAlign: CanvasTextAlign = onRightSide ? "left" : "right";
            ctx.fillStyle = "#1f2937";
            ctx.textAlign = labelAlign;
            ctx.textBaseline = "middle";
            ctx.save();
            ctx.translate(labelPoint.x, labelPoint.y);
            ctx.rotate(labelRotation);
            ctx.fillText(taxonomyGroup.label, 0, 0);
            ctx.restore();
            pushSceneText(
              taxonomyGroup.label,
              labelPoint.x,
              labelPoint.y,
              "#1f2937",
              fontSize,
              labelFontFamilies.taxonomy,
              onRightSide ? "start" : "end",
              labelRotation,
            );
            labelHitsRef.current.push({
              node,
              kind: "rotated",
              source: "collapse",
              collapsePart: "label",
              ...taxonomyHitbox,
              x: labelPoint.x,
              y: labelPoint.y,
              width: labelWidth,
              height: fontSize * 1.3,
              rotation: labelRotation,
              align: labelAlign,
            });
          }
        }
      }

      if (taxonomyEnabled && renderedTaxonomyBlocks && visibleTaxonomyRanks.length > 0) {
        const taxonomyGapWorld = Math.max(
          0,
          spiralFirstTaxonomyRibbonInnerOffset - taxonomyMetrics.bandWidth,
        );
        const labelOnlySpiralRanks = visibleTaxonomyRanks.filter((rank) => taxonomyRankDisplayModeForRank(rank) === "label-only");
        const taxonomyRibbonPaths = taxonomyOverlayStyle === "ribbons"
          ? getSpiralTaxonomyRibbonPaths(
              order,
              layout,
              collapsedView?.leafBoundaries ?? null,
              visibleTaxonomyRanks,
              taxonomyMetrics,
              taxonomyGapWorld,
              labelOnlySpiralRanks,
            )
          : null;
        if (taxonomyRibbonPaths) {
          ctx.save();
          ctx.translate(camera.translateX, camera.translateY);
          ctx.scale(camera.scale, camera.scale);
          ctx.rotate(camera.rotation);
          taxonomyRibbonPaths.forEach((path, color) => {
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.82;
            ctx.fill(path);
          });
          ctx.globalAlpha = 1;
          ctx.restore();
        }
        if (!isOverrideRender && taxonomyRibbonPaths) {
          for (
            let rankIndex = 0;
            rankIndex < visibleTaxonomyRanks.length
            && taxonomyArcHitsRef.current.length < MAX_TAXONOMY_ARC_HITBOXES;
            rankIndex += 1
          ) {
            const rank = visibleTaxonomyRanks[rankIndex];
            if (taxonomyRankDisplayModeForRank(rank) === "label-only") {
              continue;
            }
            const innerOffset = taxonomyMetrics.bandWidth
              + taxonomyMetrics.taxonomyLabelGap
              + (rankIndex * (taxonomyMetrics.taxonomyRibbonWidth + taxonomyMetrics.taxonomyRibbonGap))
              + taxonomyGapWorld;
            const outerOffset = innerOffset + taxonomyMetrics.taxonomyRibbonWidth;
            const blocks = renderedTaxonomyBlocks[rank] ?? [];
            for (
              let blockIndex = 0;
              blockIndex < blocks.length
              && taxonomyArcHitsRef.current.length < MAX_TAXONOMY_ARC_HITBOXES;
              blockIndex += 1
            ) {
              const block = blocks[blockIndex];
              const segments = block.segments && block.segments.length > 0
                ? block.segments
                : [{
                    firstNode: block.firstNode,
                    lastNode: block.lastNode,
                    startIndex: block.startIndex ?? 0,
                    endIndex: block.endIndex ?? tree.leafCount,
                  }];
              for (
                let segmentIndex = 0;
                segmentIndex < segments.length
                && taxonomyArcHitsRef.current.length < MAX_TAXONOMY_ARC_HITBOXES;
                segmentIndex += 1
              ) {
                const segment = segments[segmentIndex];
                const rawStartTheta = spiralThetaForTaxonomyBoundary(segment.startIndex, taxonomyMetrics);
                const rawEndTheta = spiralThetaForTaxonomyBoundary(segment.endIndex, taxonomyMetrics);
                const startTheta = Math.min(rawStartTheta, rawEndTheta);
                const endTheta = Math.max(rawStartTheta, rawEndTheta);
                const sampleCount = Math.max(
                  4,
                  Math.min(192, Math.ceil((endTheta - startTheta) / (Math.PI / 18))),
                );
                const screenPolygonPoints: Array<{ x: number; y: number }> = [];
                for (let sample = 0; sample <= sampleCount; sample += 1) {
                  const theta = startTheta + (((endTheta - startTheta) * sample) / sampleCount);
                  const frame = spiralFrameAt(theta, innerOffset, taxonomyMetrics);
                  screenPolygonPoints.push(spiralToScreen({ x: frame.x, y: frame.y }));
                }
                for (let sample = sampleCount; sample >= 0; sample -= 1) {
                  const theta = startTheta + (((endTheta - startTheta) * sample) / sampleCount);
                  const frame = spiralFrameAt(theta, outerOffset, taxonomyMetrics);
                  screenPolygonPoints.push(spiralToScreen({ x: frame.x, y: frame.y }));
                }
                const screenPolygonBounds = polygonBounds(screenPolygonPoints);
                if (
                  screenPolygonBounds.right < 0
                  || screenPolygonBounds.left > renderSize.width
                  || screenPolygonBounds.bottom < 0
                  || screenPolygonBounds.top > renderSize.height
                ) {
                  continue;
                }
                taxonomyArcHitsRef.current.push({
                  rank,
                  label: block.label,
                  taxId: block.taxId ?? null,
                  firstNode: segment.firstNode,
                  lastNode: segment.lastNode,
                  taxonomyTipCount: Math.max(
                    1,
                    segment.endIndex >= segment.startIndex
                      ? segment.endIndex - segment.startIndex
                      : segment.endIndex + tree.leafCount - segment.startIndex,
                  ),
                  startIndex: segment.startIndex,
                  endIndex: segment.endIndex,
                  startTheta: 0,
                  endTheta: 0,
                  innerRadiusPx: 0,
                  outerRadiusPx: 0,
                  screenPolygonPoints,
                  screenPolygonBounds,
                });
              }
            }
          }
        }
        if (taxonomyOverlayStyle === "strands" || labelOnlySpiralRanks.length > 0) {
          const strandWidthWorld = Math.max(1.25, Math.min(3.2, taxonomyMetrics.taxonomyRibbonWidth * camera.scale * 0.14)) / Math.max(camera.scale, 1e-6);
          ctx.save();
          ctx.translate(camera.translateX, camera.translateY);
          ctx.scale(camera.scale, camera.scale);
          ctx.rotate(camera.rotation);
          ctx.lineWidth = strandWidthWorld;
          for (let rankIndex = 0; rankIndex < visibleTaxonomyRanks.length; rankIndex += 1) {
            const rank = visibleTaxonomyRanks[rankIndex];
            const rankIsLabelOnlyStrand = taxonomyRankDisplayModeForRank(rank) === "label-only";
            if (taxonomyOverlayStyle !== "strands" && !rankIsLabelOnlyStrand) {
              continue;
            }
            const blocks = renderedTaxonomyBlocks[rank] ?? [];
            const innerOffset = taxonomyMetrics.bandWidth
              + taxonomyMetrics.taxonomyLabelGap
              + (rankIndex * (taxonomyMetrics.taxonomyRibbonWidth + taxonomyMetrics.taxonomyRibbonGap))
              + taxonomyGapWorld;
            const centerOffset = innerOffset + (taxonomyMetrics.taxonomyRibbonWidth * 0.5);
            for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
              const block = blocks[blockIndex];
              const segments = block.segments && block.segments.length > 0
                ? block.segments
                : [{ firstNode: block.firstNode, lastNode: block.lastNode }];
              ctx.strokeStyle = rankIsLabelOnlyStrand ? "#111827" : block.color;
              for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
                const segment = segments[segmentIndex];
                const startTheta = "startIndex" in segment
                  ? spiralThetaForTaxonomyBoundary(segment.startIndex, taxonomyMetrics)
                  : spiralThetaForY(layout.center[segment.firstNode], tree.leafCount, taxonomyMetrics);
                const endTheta = "endIndex" in segment
                  ? spiralThetaForTaxonomyBoundary(segment.endIndex, taxonomyMetrics)
                  : spiralThetaForY(layout.center[segment.lastNode], tree.leafCount, taxonomyMetrics);
                const path = new Path2D();
                appendSpiralOffsetCurve(path, Math.min(startTheta, endTheta), Math.max(startTheta, endTheta), centerOffset, taxonomyMetrics, camera.scale);
                ctx.stroke(path);
                pushScenePath(
                  () => svgSpiralOffsetCurveScreenPath(camera, Math.min(startTheta, endTheta), Math.max(startTheta, endTheta), centerOffset, taxonomyMetrics, camera.scale),
                  rankIsLabelOnlyStrand ? "#111827" : block.color,
                  strandWidthWorld * camera.scale,
                  undefined,
                  1,
                );
                if (rankIsLabelOnlyStrand) {
                  const dividerHalfWidthPx = Math.max(3, Math.min(8, taxonomyMetrics.taxonomyRibbonWidth * camera.scale * 0.34));
                  const dividerHalfWidthWorld = dividerHalfWidthPx / Math.max(camera.scale, 1e-6);
                  const dividerLineWidthPx = Math.max(1, Math.min(2.2, strandWidthWorld * camera.scale));
                  ctx.strokeStyle = "#111827";
                  ctx.lineWidth = dividerLineWidthPx / Math.max(camera.scale, 1e-6);
                  const drawDivider = (theta: number): void => {
                    const frame = spiralFrameAt(theta, centerOffset, taxonomyMetrics);
                    const x1 = frame.x - (frame.normalX * dividerHalfWidthWorld);
                    const y1 = frame.y - (frame.normalY * dividerHalfWidthWorld);
                    const x2 = frame.x + (frame.normalX * dividerHalfWidthWorld);
                    const y2 = frame.y + (frame.normalY * dividerHalfWidthWorld);
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    ctx.stroke();
                    const screenStart = spiralToScreen({ x: x1, y: y1 });
                    const screenEnd = spiralToScreen({ x: x2, y: y2 });
                    pushSceneLine(screenStart.x, screenStart.y, screenEnd.x, screenEnd.y, "#111827", dividerLineWidthPx, 1);
                  };
                  drawDivider(Math.min(startTheta, endTheta));
                  drawDivider(Math.max(startTheta, endTheta));
                  ctx.lineWidth = strandWidthWorld;
                }
              }
            }
          }
          ctx.restore();
        }
        if (exportCaptureRef.current && taxonomyRibbonPaths) {
          for (let rankIndex = 0; rankIndex < visibleTaxonomyRanks.length; rankIndex += 1) {
            const rank = visibleTaxonomyRanks[rankIndex];
            if (taxonomyRankDisplayModeForRank(rank) === "label-only") {
              continue;
            }
            const blocks = renderedTaxonomyBlocks[rank] ?? [];
            const innerOffset = taxonomyMetrics.bandWidth
              + taxonomyMetrics.taxonomyLabelGap
              + (rankIndex * (taxonomyMetrics.taxonomyRibbonWidth + taxonomyMetrics.taxonomyRibbonGap))
              + taxonomyGapWorld;
            const outerOffset = innerOffset + taxonomyMetrics.taxonomyRibbonWidth;
            for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
              const block = blocks[blockIndex];
              const segments = block.segments && block.segments.length > 0
                ? block.segments
                : [{ firstNode: block.firstNode, lastNode: block.lastNode }];
              for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
                const segment = segments[segmentIndex];
                const startTheta = "startIndex" in segment
                  ? spiralThetaForTaxonomyBoundary(segment.startIndex, taxonomyMetrics)
                  : spiralThetaForY(layout.center[segment.firstNode], tree.leafCount, taxonomyMetrics);
                const endTheta = "endIndex" in segment
                  ? spiralThetaForTaxonomyBoundary(segment.endIndex, taxonomyMetrics)
                  : spiralThetaForY(layout.center[segment.lastNode], tree.leafCount, taxonomyMetrics);
                pushScenePath(
                  () => svgSpiralRibbonScreenPath(
                    camera,
                    Math.min(startTheta, endTheta),
                    Math.max(startTheta, endTheta),
                    innerOffset,
                    outerOffset,
                    taxonomyMetrics,
                    camera.scale,
                  ),
                  undefined,
                  undefined,
                  block.color,
                  0.82,
                );
              }
            }
          }
        }
        const ribbonThicknessPx = taxonomyMetrics.taxonomyRibbonWidth * camera.scale;
        const labelFontSize = scaleLabelFontSize(
          "taxonomy",
          Math.max(4, Math.min(36 * taxonomyLabelFitScale, ribbonThicknessPx * 0.88)),
        );
        ctx.font = fontSpec("taxonomy", labelFontSize);
        ctx.textBaseline = "middle";
        const viewportCenterWorld = screenToWorldCircular(camera, renderSize.width * 0.5, renderSize.height * 0.5);
        const viewportCenterTheta = closestSpiralThetaForPoint(viewportCenterWorld.x, viewportCenterWorld.y, metrics);
        for (let rankIndex = 0; rankIndex < visibleTaxonomyRanks.length; rankIndex += 1) {
          const rank = visibleTaxonomyRanks[rankIndex];
          const rankDisplayMode = taxonomyRankDisplayModeForRank(rank);
          const rankIsLabelOnlyStrand = rankDisplayMode === "label-only";
          const blocks = renderedTaxonomyBlocks[rank] ?? [];
          const innerOffset = taxonomyMetrics.bandWidth
            + taxonomyMetrics.taxonomyLabelGap
            + (rankIndex * (taxonomyMetrics.taxonomyRibbonWidth + taxonomyMetrics.taxonomyRibbonGap))
            + taxonomyGapWorld;
          const outerOffset = innerOffset + taxonomyMetrics.taxonomyRibbonWidth;
          for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
            const block = blocks[blockIndex];
            const labelStartTheta = typeof block.labelStartIndex === "number" || typeof block.startIndex === "number"
              ? spiralThetaForTaxonomyBoundary(block.labelStartIndex ?? block.startIndex ?? 0, metrics)
              : spiralThetaForY(layout.center[block.firstNode], tree.leafCount, metrics);
            const labelEndTheta = typeof block.labelEndIndex === "number" || typeof block.endIndex === "number"
              ? spiralThetaForTaxonomyBoundary(block.labelEndIndex ?? block.endIndex ?? 0, metrics)
              : spiralThetaForY(layout.center[block.lastNode], tree.leafCount, metrics);
            const spanStartTheta = Math.min(labelStartTheta, labelEndTheta);
            const spanEndTheta = Math.max(labelStartTheta, labelEndTheta);
            const centerOffset = (innerOffset + outerOffset) * 0.5;
            const labelIntervals = spiralLabelIntervalsByTurn(spanStartTheta, spanEndTheta, taxonomyMetrics);
            for (let labelIndex = 0; labelIndex < labelIntervals.length; labelIndex += 1) {
              const labelInterval = labelIntervals[labelIndex];
              let labelTheta = (labelInterval.startTheta + labelInterval.endTheta) * 0.5;
              const labelSpanPx = Math.abs(spiralArcLengthBetween(
                labelInterval.startTheta - taxonomyMetrics.startTheta,
                labelInterval.endTheta - taxonomyMetrics.startTheta,
                taxonomyMetrics.innerRadius + centerOffset,
                taxonomyMetrics.pitchPerRadian,
              )) * camera.scale;
              const fittedLabelFontSize = Math.max(
                4,
                Math.min(labelFontSize, labelSpanPx / Math.max(1, block.label.length * 0.56)),
              );
              if (labelSpanPx < Math.max(34, block.label.length * fittedLabelFontSize * 0.56)) {
                continue;
              }
              let labelFrame = spiralFrameAt(labelTheta, centerOffset, taxonomyMetrics);
              let labelWorld = { x: labelFrame.x, y: labelFrame.y, radius: labelFrame.radius };
              let labelScreen = spiralToScreen(labelWorld);
              ctx.font = fontSpec("taxonomy", fittedLabelFontSize);
              const measuredLabelWidth = ctx.measureText(block.label).width;
              let tangentAngle = spiralTangentAngle(labelTheta, centerOffset, taxonomyMetrics) + camera.rotation;
              let rotation = normalizeRotation(tangentAngle * 180 / Math.PI) * Math.PI / 180;
              if (
                viewportScaleForCenteredRotatedLabel(
                  labelScreen.x,
                  labelScreen.y,
                  measuredLabelWidth,
                  fittedLabelFontSize * 1.15,
                  rotation,
                  renderSize.width,
                  renderSize.height,
                  2,
                ) < 0.999
                && viewportCenterTheta >= labelInterval.startTheta
                && viewportCenterTheta <= labelInterval.endTheta
              ) {
                labelTheta = Math.max(labelInterval.startTheta, Math.min(labelInterval.endTheta, viewportCenterTheta));
                labelFrame = spiralFrameAt(labelTheta, centerOffset, taxonomyMetrics);
                labelWorld = { x: labelFrame.x, y: labelFrame.y, radius: labelFrame.radius };
                labelScreen = spiralToScreen(labelWorld);
                tangentAngle = spiralTangentAngle(labelTheta, centerOffset, taxonomyMetrics) + camera.rotation;
                rotation = normalizeRotation(tangentAngle * 180 / Math.PI) * Math.PI / 180;
              }
              if (labelScreen.x < -60 || labelScreen.x > renderSize.width + 60 || labelScreen.y < -60 || labelScreen.y > renderSize.height + 60) {
                continue;
              }
              const normalScreenX = (labelFrame.normalX * Math.cos(camera.rotation)) - (labelFrame.normalY * Math.sin(camera.rotation));
              const normalScreenY = (labelFrame.normalX * Math.sin(camera.rotation)) + (labelFrame.normalY * Math.cos(camera.rotation));
              ctx.save();
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              const taxonomyLabelColor = rankIsLabelOnlyStrand ? "#111827" : taxonomyOverlayTextColor(block.color, taxonomyOverlayStyle);
              ctx.fillStyle = taxonomyLabelColor;
              const localRadiusPx = Math.max(1, labelWorld.radius * camera.scale);
              if (taxonomyOverlayStyle === "strands" || rankIsLabelOnlyStrand) {
                const strandWidthPx = Math.max(1.25, Math.min(3.2, taxonomyMetrics.taxonomyRibbonWidth * camera.scale * 0.14));
                const maskLineWidthPx = Math.max(
                  strandWidthPx + 1.2,
                  Math.min(fittedLabelFontSize * 0.55, ribbonThicknessPx * 0.45),
                );
                const maskHalfWidthPx = (measuredLabelWidth * 0.5) + Math.max(1.5, strandWidthPx);
                const maskStartTheta = spiralThetaForArcOffset(labelTheta, -maskHalfWidthPx / Math.max(camera.scale, 1e-6), centerOffset, taxonomyMetrics);
                const maskEndTheta = spiralThetaForArcOffset(labelTheta, maskHalfWidthPx / Math.max(camera.scale, 1e-6), centerOffset, taxonomyMetrics);
                ctx.save();
                ctx.translate(camera.translateX, camera.translateY);
                ctx.scale(camera.scale, camera.scale);
                ctx.rotate(camera.rotation);
                ctx.strokeStyle = "#fbfcfe";
                ctx.lineWidth = maskLineWidthPx / Math.max(camera.scale, 1e-6);
                ctx.lineCap = "round";
                const maskPath = new Path2D();
                appendSpiralOffsetCurve(
                  maskPath,
                  Math.min(maskStartTheta, maskEndTheta),
                  Math.max(maskStartTheta, maskEndTheta),
                  centerOffset,
                  taxonomyMetrics,
                  camera.scale,
                );
                ctx.stroke(maskPath);
                ctx.restore();
                pushScenePath(
                  () => svgSpiralOffsetCurveScreenPath(
                    camera,
                    Math.min(maskStartTheta, maskEndTheta),
                    Math.max(maskStartTheta, maskEndTheta),
                    centerOffset,
                    taxonomyMetrics,
                    camera.scale,
                  ),
                  "#fbfcfe",
                  maskLineWidthPx,
                  undefined,
                  1,
                );
              }
              if (curvedTextNeeded(measuredLabelWidth, fittedLabelFontSize, localRadiusPx)) {
                drawSpiralCurvedText(ctx, camera, taxonomyMetrics, block.label, labelTheta, centerOffset, taxonomyLabelColor);
              } else {
                ctx.translate(labelScreen.x, labelScreen.y);
                ctx.rotate(rotation);
                ctx.fillText(block.label, 0, 0);
              }
              ctx.restore();
              pushSceneText(
                block.label,
                labelScreen.x,
                labelScreen.y,
                taxonomyLabelColor,
                fittedLabelFontSize,
                labelFontFamilies.taxonomy,
                "middle",
                rotation,
                labelFontStyles.taxonomy,
              );
              drawPhyloPicForTaxonomyLabel({
                x: labelScreen.x,
                y: labelScreen.y,
                text: block.label,
                rank,
                alpha: 1,
                fontSize: fittedLabelFontSize,
                bandSizePx: ribbonThicknessPx,
                rotation,
                phylopicNormalX: normalScreenX,
                phylopicNormalY: normalScreenY,
                align: "center",
                color: taxonomyLabelColor,
                taxonomyDisplayMode: rankDisplayMode,
                taxId: block.taxId ?? null,
                firstNode: block.firstNode,
                lastNode: block.lastNode,
              }, measuredLabelWidth, fittedLabelFontSize);
              labelHitsRef.current.push({
                node: block.centerNode,
                kind: "rotated",
                source: "label",
                labelKind: "taxonomy",
                text: block.label,
                taxonomyRank: rank,
                taxonomyTaxId: block.taxId,
                taxonomyFirstNode: block.firstNode,
                taxonomyLastNode: block.lastNode,
                taxonomyTipCount: Math.max(1, Math.abs((block.endIndex ?? 0) - (block.startIndex ?? 0))),
                x: labelScreen.x,
                y: labelScreen.y,
                width: measuredLabelWidth,
                height: fittedLabelFontSize * 1.15,
                rotation,
                align: "center",
              });
            }
          }
        }
        ctx.globalAlpha = 1;
      } else if (!taxonomyEnabled && showGenusLabels) {
        const genusBlocks = cache.genusBlocksPriority[order];
        const genusStyle = compressedSpiralGenusStyle(
          metrics,
          camera.scale,
          spiralTipSpacingPx,
          spiralTipLabelsVisible,
          spiralTipLabelGapPx,
          spiralTipLabelBandWidthPx,
        );
        const genusOffset = genusStyle.offset;
        const genusArcLineWidthPx = genusStyle.lineWidthPx;
        const genusPath = new Path2D();
        const placedGenusLabels: ScreenLabel[] = [];
        const minGenusFontSize = scaleLabelFontSize("genus", 5.8);
        const naturalMaxGenusFontSize = scaleLabelFontSize("genus", Math.max(8, Math.min(30, 7 + (Math.sqrt(Math.max(0, camera.scale)) * 0.95))));
        const targetMaxGenusFontSize = scaleLabelFontSize("genus", Math.max(8, Math.min(18, 7 + (spiralTipSpacingPx * 0.55))));
        const maxGenusFontSize = (naturalMaxGenusFontSize * (1 - genusStyle.progress))
          + (targetMaxGenusFontSize * genusStyle.progress);
        const genusLabelLimit = Math.floor(300 + (Math.max(0, Math.log2(Math.max(1, camera.scale))) * 90));
        for (let index = 0; index < genusBlocks.length; index += 1) {
          const block = genusBlocks[index];
          if (hiddenNodes[block.centerNode]) {
            continue;
          }
          const startTheta = spiralThetaForY(layout.center[block.firstNode], tree.leafCount, metrics);
          const endTheta = spiralThetaForY(layout.center[block.lastNode], tree.leafCount, metrics);
          const midTheta = (startTheta + endTheta) * 0.5;
          const midPoint = spiralNormalOffsetPoint(midTheta, genusOffset, metrics);
          if (spiralFirstGenusWorld === null) {
            spiralFirstGenusWorld = { x: midPoint.x, y: midPoint.y };
          }
          const midScreen = spiralToScreen(midPoint);
          const spanPx = Math.abs(spiralArcLengthBetween(
            Math.min(startTheta, endTheta) - metrics.startTheta,
            Math.max(startTheta, endTheta) - metrics.startTheta,
            metrics.innerRadius + genusOffset,
            metrics.pitchPerRadian,
          )) * camera.scale;
          if (
            spanPx < 3
            || midScreen.x < -240
            || midScreen.x > renderSize.width + 240
            || midScreen.y < -240
            || midScreen.y > renderSize.height + 240
          ) {
            continue;
          }
          appendSpiralOffsetCurve(
            genusPath,
            Math.min(startTheta, endTheta),
            Math.max(startTheta, endTheta),
            genusOffset,
            metrics,
            camera.scale,
          );
          pushScenePath(
            () => svgSpiralOffsetCurveScreenPath(
              camera,
              Math.min(startTheta, endTheta),
              Math.max(startTheta, endTheta),
              genusOffset,
              metrics,
              camera.scale,
            ),
            GENUS_COLOR,
            genusArcLineWidthPx,
            undefined,
            0.82,
          );
          if (placedGenusLabels.length > genusLabelLimit) {
            continue;
          }
          const fittedGenusFontSize = Math.max(
            minGenusFontSize,
            Math.min(maxGenusFontSize, (spanPx * 0.82) / Math.max(1, block.label.length * 0.54)),
          );
          ctx.font = fontSpec("genus", fittedGenusFontSize);
          const measuredLabelWidth = ctx.measureText(block.label).width;
          if (spanPx < Math.max(18, measuredLabelWidth * 1.12) || fittedGenusFontSize < minGenusFontSize) {
            continue;
          }
          const midFrame = spiralFrameAt(midTheta, genusOffset, metrics);
          const normalAngle = Math.atan2(midFrame.normalY, midFrame.normalX) + camera.rotation;
          const labelGapPx = (genusArcLineWidthPx * 0.5) + (fittedGenusFontSize * 0.68) + 3;
          const labelX = midScreen.x + (Math.cos(normalAngle) * labelGapPx);
          const labelY = midScreen.y + (Math.sin(normalAngle) * labelGapPx);
          const rotation = normalizeRotation((spiralTangentAngle(midTheta, genusOffset, metrics) + camera.rotation) * 180 / Math.PI) * Math.PI / 180;
          if (!canPlaceLinearLabel(placedGenusLabels, labelX, labelY, fittedGenusFontSize * 0.9, measuredLabelWidth * 0.34)) {
            continue;
          }
          placedGenusLabels.push({
            x: labelX,
            y: labelY,
            text: block.label,
            alpha: 1,
            fontSize: fittedGenusFontSize,
            rotation,
            color: block.centerNode === activeSearchGenusCenterNode ? "#c2410c" : GENUS_COLOR,
          });
        }
        ctx.save();
        ctx.translate(camera.translateX, camera.translateY);
        ctx.scale(camera.scale, camera.scale);
        ctx.rotate(camera.rotation);
        ctx.strokeStyle = GENUS_COLOR;
        ctx.globalAlpha = 0.82;
        ctx.lineWidth = genusArcLineWidthPx / Math.max(camera.scale, 1e-6);
        ctx.stroke(genusPath);
        ctx.restore();
        ctx.globalAlpha = 1;
        ctx.textBaseline = "middle";
        for (let index = 0; index < placedGenusLabels.length; index += 1) {
          const label = placedGenusLabels[index];
          ctx.save();
          ctx.translate(label.x, label.y);
          ctx.rotate(label.rotation ?? 0);
          ctx.font = fontSpec("genus", label.fontSize ?? minGenusFontSize);
          ctx.fillStyle = label.color ?? GENUS_COLOR;
          ctx.textAlign = "center";
          ctx.fillText(label.text, 0, 0);
          ctx.restore();
          pushSceneText(
            label.text,
            label.x,
            label.y,
            label.color ?? GENUS_COLOR,
            label.fontSize ?? minGenusFontSize,
            labelFontFamilies.genus,
            "middle",
            label.rotation ?? 0,
            labelFontStyles.genus,
          );
        }
        spiralGenusOffsetFromTipsPx = (genusOffset - metrics.bandWidth) * camera.scale;
        spiralGenusLineWidthPx = genusArcLineWidthPx;
        spiralGenusMaxFontSizePx = maxGenusFontSize;
        spiralPlacedGenusLabelCount = placedGenusLabels.length;
      }

      let spiralPlacedTipLabelCount = 0;
      if (spiralTipLabelsVisible) {
        const orderedLeaves = cache.orderedLeaves[order];
        const placedTipLabels: ScreenLabel[] = [];
        ctx.font = fontSpec("tip", spiralRenderedTipFontSize);
        ctx.textBaseline = "middle";
        for (let index = 0; index < orderedLeaves.length; index += 1) {
          const node = orderedLeaves[index];
          if (hiddenNodes[node]) {
            continue;
          }
          const theta = spiralThetaForY(layout.center[node], tree.leafCount, metrics);
          const frame = spiralFrameAt(theta, metrics.bandWidth, metrics);
          const tip = spiralToScreen({ x: frame.x, y: frame.y });
          if (tip.x < -160 || tip.x > renderSize.width + 160 || tip.y < -160 || tip.y > renderSize.height + 160) {
            continue;
          }
          const text = displayTipLabelForView(node);
          const width = ctx.measureText(text).width;
          const normalAngle = Math.atan2(frame.normalY, frame.normalX) + camera.rotation;
          const normalScreenX = Math.cos(normalAngle);
          const normalScreenY = Math.sin(normalAngle);
          const onReadableRightSide = normalScreenX >= 0;
          const rotation = normalizeRotation(
            (onReadableRightSide ? normalAngle : normalAngle + Math.PI) * 180 / Math.PI,
          ) * Math.PI / 180;
          const gapPx = spiralTipLabelGapPx;
          const anchorX = tip.x + (normalScreenX * gapPx);
          const anchorY = tip.y + (normalScreenY * gapPx);
          placedTipLabels.push({
            x: anchorX,
            y: anchorY,
            text,
            alpha: 1,
            fontSize: spiralRenderedTipFontSize,
            rotation,
            align: onReadableRightSide ? "left" : "right",
          });
          labelHitsRef.current.push({
            node,
            kind: "rotated",
            source: "label",
            labelKind: "tip",
            text,
            x: anchorX,
            y: anchorY,
            width,
            height: spiralRenderedTipFontSize * 1.15,
            rotation,
            align: onReadableRightSide ? "left" : "right",
          });
        }
        spiralPlacedTipLabelCount = placedTipLabels.length;
        ctx.fillStyle = "#111827";
        for (let index = 0; index < placedTipLabels.length; index += 1) {
          const label = placedTipLabels[index];
          ctx.save();
          ctx.translate(label.x, label.y);
          ctx.rotate(label.rotation ?? 0);
          ctx.font = `${label.fontSize ?? spiralRenderedTipFontSize}px ${labelFontFamilies.tip}`;
          ctx.textAlign = label.align ?? "left";
          ctx.fillText(label.text, 0, 0);
          ctx.restore();
          pushSceneText(
            label.text,
            label.x,
            label.y,
            "#111827",
            label.fontSize ?? spiralRenderedTipFontSize,
            labelFontFamilies.tip,
            label.align === "right" ? "end" : "start",
            label.rotation ?? 0,
            labelFontStyles.tip,
          );
        }
      }

      if (showScaleBars) {
        const scaleFontSize = Math.max(
          1.5,
          Math.min(
            (Math.max(11.5, Math.min(15, 10 + (camera.scale * 0.02))) * figureStyles.scale.sizeScale),
            metrics.pitch * camera.scale * 0.28,
          ),
        );
        ctx.font = fontSpec("scale", scaleFontSize);
        ctx.fillStyle = "#475569";
        ctx.strokeStyle = "#64748b";
        ctx.lineWidth = 1;
        const axisTheta = metrics.startTheta;
        const axisFrame = spiralFrameAt(axisTheta, metrics.bandWidth * 0.5, metrics);
        const sideWorldX = -axisFrame.tangentX;
        const sideWorldY = -axisFrame.tangentY;
        const axisOffsetWorld = 0.18;
        const labelOffsetWorld = 0.14;
        const tickHalfWorld = Math.max(0.018, 4 / Math.max(camera.scale, 1e-6));
        const labelVector = worldToScreenCircular(camera, sideWorldX, sideWorldY);
        const labelOrigin = worldToScreenCircular(camera, 0, 0);
        const labelAlign: CanvasTextAlign = (labelVector.x - labelOrigin.x) < 0 ? "right" : "left";
        const spiralScaleCandidates = timeBoundaryValues
          .filter((age) => showScaleZeroTick || age > 0)
          .map((age) => {
            const point = spiralPointAt(axisTheta, age, metrics);
            const frame = spiralFrameAt(axisTheta, spiralOffsetForAge(age, metrics), metrics);
            const tickStart = spiralToScreen({
              x: point.x + (sideWorldX * axisOffsetWorld) - (frame.tangentX * tickHalfWorld),
              y: point.y + (sideWorldY * axisOffsetWorld) - (frame.tangentY * tickHalfWorld),
            });
            const tickEnd = spiralToScreen({
              x: point.x + (sideWorldX * axisOffsetWorld) + (frame.tangentX * tickHalfWorld),
              y: point.y + (sideWorldY * axisOffsetWorld) + (frame.tangentY * tickHalfWorld),
            });
            const label = spiralToScreen({
              x: point.x + (sideWorldX * (axisOffsetWorld + labelOffsetWorld)),
              y: point.y + (sideWorldY * (axisOffsetWorld + labelOffsetWorld)),
            });
            const text = scaleLabelText(age);
            const textWidth = ctx.measureText(text).width;
            const labelLeft = labelAlign === "right" ? label.x - textWidth : label.x;
            return {
              age,
              text,
              tickStart,
              tickEnd,
              x: label.x,
              y: label.y,
              bounds: {
                left: labelLeft - 4,
                right: labelLeft + textWidth + 4,
                top: label.y - (scaleFontSize * 0.65),
                bottom: label.y + (scaleFontSize * 0.65),
              },
            };
          });
        const selectedSpiralScaleLabels: typeof spiralScaleCandidates = [];
        const labelBoxesOverlap = (
          left: { left: number; right: number; top: number; bottom: number },
          right: { left: number; right: number; top: number; bottom: number },
        ): boolean => (
          left.left < right.right
          && right.left < left.right
          && left.top < right.bottom
          && right.top < left.bottom
        );
        for (let index = spiralScaleCandidates.length - 1; index >= 0; index -= 1) {
          const candidate = spiralScaleCandidates[index];
          if (selectedSpiralScaleLabels.some((placed) => labelBoxesOverlap(candidate.bounds, placed.bounds))) {
            continue;
          }
          selectedSpiralScaleLabels.push(candidate);
        }
        selectedSpiralScaleLabels.sort((left, right) => left.age - right.age);
        ctx.beginPath();
        for (let index = 0; index < selectedSpiralScaleLabels.length; index += 1) {
          const tick = selectedSpiralScaleLabels[index];
          ctx.moveTo(tick.tickStart.x, tick.tickStart.y);
          ctx.lineTo(tick.tickEnd.x, tick.tickEnd.y);
          pushSceneLine(tick.tickStart.x, tick.tickStart.y, tick.tickEnd.x, tick.tickEnd.y, "#64748b", 1);
        }
        const axisStart = spiralToScreen(spiralPointAt(axisTheta, 0, metrics));
        const axisEnd = spiralToScreen(spiralPointAt(axisTheta, metrics.timeExtent, metrics));
        const axisStartX = axisStart.x + ((labelVector.x - labelOrigin.x) * axisOffsetWorld);
        const axisStartY = axisStart.y + ((labelVector.y - labelOrigin.y) * axisOffsetWorld);
        const axisEndX = axisEnd.x + ((labelVector.x - labelOrigin.x) * axisOffsetWorld);
        const axisEndY = axisEnd.y + ((labelVector.y - labelOrigin.y) * axisOffsetWorld);
        ctx.moveTo(axisStartX, axisStartY);
        ctx.lineTo(axisEndX, axisEndY);
        pushSceneLine(axisStartX, axisStartY, axisEndX, axisEndY, "#64748b", 1);
        ctx.stroke();
        ctx.textAlign = labelAlign;
        ctx.textBaseline = "middle";
        for (let index = 0; index < selectedSpiralScaleLabels.length; index += 1) {
          const label = selectedSpiralScaleLabels[index];
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(251,252,254,0.9)";
          ctx.strokeText(label.text, label.x, label.y);
          ctx.fillStyle = "#475569";
          ctx.fillText(label.text, label.x, label.y);
          pushSceneText(
            label.text,
            label.x,
            label.y,
            "#475569",
            scaleFontSize,
            labelFontFamilies.scale,
            labelAlign === "right" ? "end" : "start",
            undefined,
            labelFontStyles.scale,
          );
        }
      }

      renderDebug.spiral = {
        turns: spiralTurns,
        effectiveTurns: metrics.totalTheta / (Math.PI * 2),
        firstTipWorld: (() => {
          const firstTipNode = cache.orderedLeaves[order][0];
          const firstTipTheta = spiralThetaForY(layout.center[firstTipNode], tree.leafCount, metrics);
          const firstTipFrame = spiralFrameAt(firstTipTheta, metrics.bandWidth, metrics);
          return { x: firstTipFrame.x, y: firstTipFrame.y };
        })(),
        visibleTaxonomyRanks,
        logUnit: metrics.logUnit,
        timeExtent: metrics.timeExtent,
        tipSpacingPx: spiralTipSpacingPx,
        interTurnGapPx: spiralInterTurnGapPx,
        tipLabelsVisible: spiralTipLabelsVisible,
        tipLabelFontSizePx: spiralRenderedTipFontSize,
        tipLabelBandWidthPx: spiralTipLabelBandWidthPx,
        tipLabelRequiredClearancePx: spiralRequiredTipClearancePx,
        placedTipLabelCount: spiralPlacedTipLabelCount,
        taxonomyNaturalRibbonWidthPx: metrics.taxonomyRibbonWidth * camera.scale,
        taxonomyNaturalRibbonGapPx: metrics.taxonomyRibbonGap * camera.scale,
        taxonomyRenderedRibbonWidthPx: taxonomyMetrics.taxonomyRibbonWidth * camera.scale,
        taxonomyNaturalTotalWidthPx: spiralNaturalTaxonomyWidthPx,
        taxonomyRenderedTotalWidthPx: spiralRenderedTaxonomyWidthPx,
        branchDetailProgress: spiralBranchDetailProgress,
        branchLineWidthPx: spiralBranchLineWidthPx,
        baseBranchOpacity: spiralBaseBranchOpacity,
        coloredBranchOpacity: spiralColoredBranchOpacity,
        genusOffsetFromTipsPx: spiralGenusOffsetFromTipsPx,
        genusLineWidthPx: spiralGenusLineWidthPx,
        genusMaxFontSizePx: spiralGenusMaxFontSizePx,
        placedGenusLabelCount: spiralPlacedGenusLabelCount,
        firstGenusWorld: spiralFirstGenusWorld,
        branchPathBatchCount: branchPaths
          ? [...branchPaths.values()].reduce((total, batches) => total + batches.length, 0)
          : 0,
        branchPathMaxCommandCount: branchPaths
          ? Math.max(0, ...[...branchPaths.values()].flatMap((batches) => batches.map((batch) => batch.commandCount)))
          : 0,
        taxonomyFirstRibbonInnerOffsetWorld: spiralFirstTaxonomyRibbonInnerOffset,
        collapsedMinimizedAngularSpans: visibleCollapsedNodes
          .filter((node) => collapsedNodeModes.get(node) === "minimize")
          .map((node) => ({
            node,
            span: Math.abs(
              spiralThetaForY(layout.max[node], tree.leafCount, metrics)
              - spiralThetaForY(layout.min[node], tree.leafCount, metrics)
            ),
          })),
      };
    }

    if ((viewMode === "circular" || viewMode === "fan") && camera.kind === "circular") {
      const layout = collapsedView?.layout ?? tree.layouts[order];
      const children = cache.orderedChildren[order];
      const orderedLeaves = cache.orderedLeaves[order];
      const rotationAngle = camera.rotation;
      const maxRadius = Math.max(polarOuterRadius, tree.branchLengthMinPositive);
      const angularSpacingPx = (
        camera.scale
        * maxRadius
        * (polarAngleSpan / polarLeafDivisor)
        * (collapsedView?.effectiveLeafScale ?? 1)
      );
      const circularBranchStrokeAutoMultiplier = detailBranchThicknessMultiplier(
        angularSpacingPx,
        4.5,
      );
      const circularBranchStrokeScale = branchStrokeScale * circularBranchStrokeAutoMultiplier;
      renderDebug.tipSpacingPx = angularSpacingPx;
      renderDebug.tipLabelsVisible = showTipLabels && angularSpacingPx > 4.5;
      renderDebug.branchStrokeAutoMultiplier = circularBranchStrokeAutoMultiplier;
      renderDebug.renderedBranchStrokeScale = circularBranchStrokeScale;
      renderDebug.radial = {
        angularSpanDegrees: configuredRadialSpanDegrees,
        centerOpeningRatio: effectiveRadialCenterOpeningRatio,
        innerRadiusWorld: polarInnerRadius,
        outerRadiusWorld: polarOuterRadius,
      };
      const stripeExtent = effectiveTimeAxisScale === "log" ? timeAxisExtent : (tree.isUltrametric ? tree.rootAge : tree.maxDepth);
      const circularRadiusForBoundary = (value: number): number => (
        tree.isUltrametric ? axisDepth(tree.rootAge - value) : axisDepth(value)
      );
      const visibleRadius = Math.max(1e-9, Math.min(renderSize.width, renderSize.height) / (2 * camera.scale));
      const visibleTimeSpan = Math.max(1e-9, Math.min(stripeExtent, visibleRadius));
      const stripeLevels = buildStripeLevels(visibleTimeSpan, camera.scale, scaleTickInterval);
      const stripeBoundaries = buildStripeBoundaries(stripeExtent, stripeLevels);
      const visibleScaleBoundaries = showIntermediateScaleTicks
        ? stripeBoundaries
        : stripeBoundaries.filter((boundary) => boundary.alpha >= SOLID_SCALE_TICK_ALPHA_THRESHOLD);
      const circularCenterScaleLevels = buildStripeLevels(
        visibleTimeSpan,
        camera.scale,
        scaleTickInterval,
      );
      const circularCenterScaleBoundariesRaw = buildStripeBoundaries(stripeExtent, circularCenterScaleLevels);
      const circularCenterVisibleBoundaries = showIntermediateScaleTicks
        ? circularCenterScaleBoundariesRaw
        : circularCenterScaleBoundariesRaw.filter((boundary) => boundary.alpha >= SOLID_SCALE_TICK_ALPHA_THRESHOLD);
      const circularCenterScaleBoundaries = showScaleZeroTick
        ? [...circularCenterVisibleBoundaries, { value: 0, alpha: 1 }]
        : circularCenterVisibleBoundaries;
      const displayedCircularCenterScaleBoundaries = [...new Map(
        circularCenterScaleBoundaries.map((boundary) => [boundary.value.toPrecision(12), boundary]),
      ).values()].sort((left, right) => left.value - right.value);
      const circularScaleBoundaries = showScaleZeroTick
        ? [...visibleScaleBoundaries, { value: 0, alpha: 1 }]
        : visibleScaleBoundaries;
      const displayedCircularScaleBoundaries = [...new Map(
        circularScaleBoundaries.map((boundary) => [boundary.value.toPrecision(12), boundary]),
      ).values()].sort((left, right) => left.value - right.value);
      const centerPoint = worldToScreenCircular(camera, 0, 0);
      const fullyVisibleRadiusPx = Math.min(
        centerPoint.x,
        renderSize.width - centerPoint.x,
        centerPoint.y,
        renderSize.height - centerPoint.y,
      );
      const circularCachePrepStartTime = performance.now();
      let visibleTaxonomyRanks = taxonomyEnabled && taxonomyConsensus
        ? (useAutomaticTaxonomyRankVisibility
          ? withSupplementalTaxonomyRanks(taxonomyVisibleRanksForZoom(angularSpacingPx, automaticTaxonomyRanks))
          : taxonomyActiveRanks)
        : [];
      const visibleCircleFraction = fullyVisibleRadiusPx / Math.max(1e-9, polarOuterRadius * camera.scale);
      const fitLikeCircular = fitCameraForMode(viewMode);
      const nearCircularFit = fitLikeCircular?.kind === "circular"
        ? camera.scale <= (fitLikeCircular.scale * CIRCULAR_NEAR_FIT_SCALE_MULTIPLIER)
        : false;
      const lockTaxonomyLabelsToClade = nearCircularFit || visibleCircleFraction >= CIRCULAR_TAXONOMY_LABEL_LOCK_MIN_VISIBLE_FRACTION;
      if (useAutomaticTaxonomyRankVisibility && visibleCircleFraction >= 0.88 && visibleTaxonomyRanks.length > 3) {
        visibleTaxonomyRanks = withSupplementalTaxonomyRanks(
          visibleTaxonomyRanks.filter(isAutomaticTaxonomyRank).slice(-2),
        );
      }
      const branchColorRanks = taxonomyColorRanks.length > 0 ? taxonomyColorRanks : visibleTaxonomyRanks;
      const taxonomyBranchRenderingVisible = taxonomyEnabled && taxonomyBranchColoringEnabled && branchColorRanks.length > 0 && taxonomyColors !== null;
      const circularTaxonomyCacheStartTime = performance.now();
      const coloredBranchKey = taxonomyBranchRenderingVisible
        ? `taxonomy:${branchColorRanks.join("|")}:${taxonomyColorPalette}:${taxonomyCustomPaletteSignature}:${taxonomyColorJitter.toFixed(3)}:${taxonomyColorRootRank}:${taxonomyColorJitterRank}:${metadataBranchColorVersion}:${manualBranchColorVersion}`
        : metadataBranchColorOverlay.hasAny || manualBranchColorOverlay.hasAny
          ? `manual:${metadataBranchColorVersion}:${manualBranchColorVersion}`
          : "";
      const effectiveBranchColors = coloredBranchKey ? getEffectiveBranchColors(order, branchColorRanks) : null;
      const useColoredBranchRendering = effectiveBranchColors !== null;
      const useLargeMetadataBranchLOD = !exportCapture
        && useColoredBranchRendering
        && metadataBranchColorOverlay.hasAny
        && tree.nodeCount >= LARGE_METADATA_BRANCH_NODE_LIMIT;
      const useGlobalColoredBranchCaches = useColoredBranchRendering && metadataBranchColorCacheable && !useLargeMetadataBranchLOD;
      const useCachedCircularTaxonomyPaths = !exportCapture && useGlobalColoredBranchCaches && collapsedNodes.size === 0 && angularSpacingPx < 0.8;
      const cachedCircularTaxonomyPaths = useCachedCircularTaxonomyPaths
        ? getCircularTaxonomyPaths(order, layout, coloredBranchKey, effectiveBranchColors)
        : null;
      const manualDenseTaxonomyRanksVisible = !useAutomaticTaxonomyRankVisibility
        && visibleTaxonomyRanks.includes("genus");
      const useCircularTaxonomyBitmapAtCurrentScale = fitLikeCircular?.kind === "circular"
        ? camera.scale <= (fitLikeCircular.scale * CIRCULAR_TAXONOMY_BITMAP_SCALE_MULTIPLIER) || visibleCircleFraction >= CIRCULAR_TAXONOMY_BITMAP_MIN_VISIBLE_FRACTION
        : visibleCircleFraction >= CIRCULAR_TAXONOMY_BITMAP_MIN_VISIBLE_FRACTION;
      const useCachedCircularTaxonomyBitmap = !exportCapture && useCachedCircularTaxonomyPaths
        && cachedCircularTaxonomyPaths !== null
        && !manualDenseTaxonomyRanksVisible
        && (nearCircularFit || visibleCircleFraction >= CIRCULAR_TAXONOMY_BITMAP_MIN_VISIBLE_FRACTION)
        && useCircularTaxonomyBitmapAtCurrentScale;
      const candidateCircularTaxonomyBitmap = useCachedCircularTaxonomyBitmap
        ? getCircularTaxonomyBitmapCache(
          order,
          coloredBranchKey,
          cachedCircularTaxonomyPaths,
          camera,
        )
        : null;
      let cachedCircularTaxonomyBitmap = candidateCircularTaxonomyBitmap;
      if (cachedCircularTaxonomyBitmap) {
        const bitmapScaleRatio = camera.scale / Math.max(cachedCircularTaxonomyBitmap.scale, 1e-6);
        const sourceWidth = Math.max(1, cachedCircularTaxonomyBitmap.viewportWidth / Math.max(bitmapScaleRatio, 1e-6));
        const sourceHeight = Math.max(1, cachedCircularTaxonomyBitmap.viewportHeight / Math.max(bitmapScaleRatio, 1e-6));
        const sourceX = cachedCircularTaxonomyBitmap.sourceOffsetX - (camera.translateX / Math.max(bitmapScaleRatio, 1e-6));
        const sourceY = cachedCircularTaxonomyBitmap.sourceOffsetY - (camera.translateY / Math.max(bitmapScaleRatio, 1e-6));
        const epsilon = 0.5;
        if (
          sourceX < -epsilon
          || sourceY < -epsilon
          || sourceX + sourceWidth > cachedCircularTaxonomyBitmap.canvas.width + epsilon
          || sourceY + sourceHeight > cachedCircularTaxonomyBitmap.canvas.height + epsilon
        ) {
          if (circularTaxonomyBitmapCacheRef.current === cachedCircularTaxonomyBitmap) {
            disposeCanvasCache(circularTaxonomyBitmapCacheRef.current);
            circularTaxonomyBitmapCacheRef.current = null;
          }
          cachedCircularTaxonomyBitmap = null;
        }
      }
      const useHugeTreeZoomedCircularRendering = viewMode === "circular"
        && tree.leafCount > HUGE_TREE_TIP_LIMIT
        && fitLikeCircular?.kind === "circular"
        && camera.scale > (fitLikeCircular.scale * HUGE_TREE_CACHED_CIRCULAR_PATH_MAX_ZOOM_MULTIPLIER);
      const useCachedCircularBasePath = !exportCapture
        && !useColoredBranchRendering
        && collapsedNodes.size === 0
        && !useHugeTreeZoomedCircularRendering;
      const cachedCircularBasePath = useCachedCircularBasePath
        ? getCircularBasePath(order, layout)
        : null;
      const useSampledColoredCircularRendering = viewMode === "circular"
        && useLargeMetadataBranchLOD
        && collapsedNodes.size === 0
        && angularSpacingPx < 1.1;
      const largeMetadataCircularBasePath = useLargeMetadataBranchLOD && collapsedNodes.size === 0
        ? getCircularBasePath(order, layout)
        : null;
      const drawCachedCircularTaxonomyPaths = Boolean(
        useCachedCircularTaxonomyPaths
        && cachedCircularTaxonomyPaths
        && tree.leafCount <= CIRCULAR_TAXONOMY_DIRECT_PATH_MAX_TIPS,
      );
      timing.circularTaxonomyCacheMs += performance.now() - circularTaxonomyCacheStartTime;
        const circularBranchRenderMode = cachedCircularTaxonomyBitmap
          ? "taxonomy-cached-bitmap"
          : drawCachedCircularTaxonomyPaths
            ? "taxonomy-cached-paths"
          : cachedCircularBasePath
            ? "cached-path"
          : useHugeTreeZoomedCircularRendering && !useColoredBranchRendering && collapsedNodes.size === 0
            ? "huge-tree-sampled"
          : useSampledColoredCircularRendering
            ? "large-metadata-sampled"
          : useColoredBranchRendering
            ? taxonomyBranchRenderingVisible
              ? collapsedNodes.size === 0
                ? "visible-segments"
                : "full-tree"
              : collapsedNodes.size === 0
                ? "manual-visible-segments"
                : "manual-full-tree"
            : collapsedNodes.size === 0
              ? "visible-segments"
              : "full-tree";
      const showCentralTimeLabels = showScaleBars && visibleCircleFraction >= 0.58;
      const centerScaleTheta = (-circularCenterScaleAngleDegrees * Math.PI) / 180;
      const circularScaleBar = showScaleBars && !showCentralTimeLabels
        ? buildCircularScaleBar(
          centerPoint.x,
          centerPoint.y,
          renderSize.width,
          renderSize.height,
          displayedCircularScaleBoundaries,
          (boundary) => circularRadiusForBoundary(boundary.value) * camera.scale,
        )
        : null;
      timing.circularCachePrepMs += performance.now() - circularCachePrepStartTime;

      if (showTimeStripes) {
        const center = { x: camera.translateX, y: camera.translateY };
        const stripeStartTheta = polarAngleStart + rotationAngle;
        const stripeEndTheta = stripeStartTheta + polarAngleSpan;
        if (timeStripeStyle === "dashed") {
          ctx.save();
          ctx.setLineDash([6, 6]);
          for (let index = 0; index < displayedCircularScaleBoundaries.length; index += 1) {
            const boundary = displayedCircularScaleBoundaries[index];
            const radiusPx = circularRadiusForBoundary(boundary.value) * camera.scale;
            ctx.beginPath();
            ctx.strokeStyle = `rgba(148,163,184,${0.22 + (0.5 * boundary.alpha)})`;
            ctx.lineWidth = timeStripeLineWeight;
            ctx.arc(center.x, center.y, radiusPx, stripeStartTheta, stripeEndTheta);
            ctx.stroke();
            pushScenePath(
              () => polarAngleSpan < (Math.PI * 2) - 1e-9
                ? svgArcPath(center.x, center.y, radiusPx, stripeStartTheta, stripeEndTheta)
                : `M ${(center.x + radiusPx).toFixed(3)} ${center.y.toFixed(3)} A ${radiusPx.toFixed(3)} ${radiusPx.toFixed(3)} 0 1 1 ${(center.x - radiusPx).toFixed(3)} ${center.y.toFixed(3)} A ${radiusPx.toFixed(3)} ${radiusPx.toFixed(3)} 0 1 1 ${(center.x + radiusPx).toFixed(3)} ${center.y.toFixed(3)}`,
              "#94a3b8",
              timeStripeLineWeight,
              undefined,
              0.22 + (0.5 * boundary.alpha),
              DASHED_STRIPE_DASH_ARRAY,
            );
          }
          ctx.restore();
        } else {
            const drawBands = (step: number, alpha: number, gradient = false) => {
              if (!Number.isFinite(step) || step <= 0 || alpha <= 0) {
                return;
              }
              const bandCount = Math.max(1, Math.ceil(stripeExtent / step));
              if (bandCount > MAX_TIME_STRIPE_BANDS_PER_DRAW) {
                return;
              }
              for (let start = 0, index = 0; start < stripeExtent; start += step, index += 1) {
                const next = Math.min(stripeExtent, start + step);
              const outer = (tree.isUltrametric ? circularRadiusForBoundary(start) : circularRadiusForBoundary(next)) * camera.scale;
              const inner = (tree.isUltrametric ? circularRadiusForBoundary(next) : circularRadiusForBoundary(start)) * camera.scale;
              if (polarAngleSpan < (Math.PI * 2) - 1e-9) {
                traceCircularRibbonPath(ctx, center.x, center.y, inner, outer, stripeStartTheta, stripeEndTheta);
              } else {
                ctx.beginPath();
                ctx.arc(center.x, center.y, outer, 0, Math.PI * 2);
                ctx.arc(center.x, center.y, inner, 0, Math.PI * 2, true);
                ctx.closePath();
              }
              ctx.fillStyle = gradient
                ? ageGradientStripeFill(index, bandCount, alpha)
                : index % 2 === 0
                  ? `rgba(243,244,246,${0.95 * alpha})`
                  : `rgba(255,255,255,${0.95 * alpha})`;
              ctx.fill();
              pushScenePath(
                () => polarAngleSpan < (Math.PI * 2) - 1e-9
                  ? svgCircularRibbonPath(center.x, center.y, inner, outer, stripeStartTheta, stripeEndTheta)
                  : `M ${(center.x + outer).toFixed(3)} ${center.y.toFixed(3)} A ${outer.toFixed(3)} ${outer.toFixed(3)} 0 1 1 ${(center.x - outer).toFixed(3)} ${center.y.toFixed(3)} A ${outer.toFixed(3)} ${outer.toFixed(3)} 0 1 1 ${(center.x + outer).toFixed(3)} ${center.y.toFixed(3)} M ${(center.x + inner).toFixed(3)} ${center.y.toFixed(3)} A ${inner.toFixed(3)} ${inner.toFixed(3)} 0 1 0 ${(center.x - inner).toFixed(3)} ${center.y.toFixed(3)} A ${inner.toFixed(3)} ${inner.toFixed(3)} 0 1 0 ${(center.x + inner).toFixed(3)} ${center.y.toFixed(3)} Z`,
                undefined,
                undefined,
                ctx.fillStyle,
                1,
              );
            }
          };
          if (timeStripeStyle === "age-gradient") {
            drawBands(stripeLevels[0]?.step ?? stripeExtent, 1, true);
          } else {
            for (let index = 0; index < stripeLevels.length; index += 1) {
              drawBands(stripeLevels[index].step, index === 0 ? 1 : stripeLevels[index].alpha * 0.82);
            }
          }
        }
      }

      const circularVisibilityPrepStartTime = performance.now();
      const needsVisibleCircularSegments = !cachedCircularTaxonomyBitmap
        && !drawCachedCircularTaxonomyPaths
        && !cachedCircularBasePath;
      const useDenseCircularLOD = !exportCapture
        && needsVisibleCircularSegments
        && (angularSpacingPx < 1.1 || useLargeMetadataBranchLOD);
      const circularConnectorKeys = useDenseCircularLOD ? new Set<string>() : null;
      const circularStemKeys = useDenseCircularLOD ? new Set<string>() : null;
      let visibleCircularSegments: ReturnType<typeof cache.circularIndices[typeof order]["query"]> | null = null;
      if (needsVisibleCircularSegments && collapsedNodes.size === 0 && !useHugeTreeZoomedCircularRendering && !useSampledColoredCircularRendering) {
        const cornerWorldPoints = [
          screenToWorldCircular(camera, 0, 0),
          screenToWorldCircular(camera, renderSize.width, 0),
          screenToWorldCircular(camera, 0, renderSize.height),
          screenToWorldCircular(camera, renderSize.width, renderSize.height),
        ];
        let circularMinX = Number.POSITIVE_INFINITY;
        let circularMaxX = Number.NEGATIVE_INFINITY;
        let circularMinY = Number.POSITIVE_INFINITY;
        let circularMaxY = Number.NEGATIVE_INFINITY;
        const circularWorldOverscan = Math.max(tree.branchLengthMinPositive * 2, 24 / camera.scale);
        for (let index = 0; index < cornerWorldPoints.length; index += 1) {
          circularMinX = Math.min(circularMinX, cornerWorldPoints[index].x);
          circularMaxX = Math.max(circularMaxX, cornerWorldPoints[index].x);
          circularMinY = Math.min(circularMinY, cornerWorldPoints[index].y);
          circularMaxY = Math.max(circularMaxY, cornerWorldPoints[index].y);
        }
        visibleCircularSegments = cache.circularIndices[order].query(
          (circularMinX + circularMaxX) * 0.5,
          (circularMinY + circularMaxY) * 0.5,
          Math.max(1e-6, (circularMaxX - circularMinX) * 0.5) + circularWorldOverscan,
          Math.max(1e-6, (circularMaxY - circularMinY) * 0.5) + circularWorldOverscan,
        );
      }
      const circularBranchStartTime = performance.now();
      let circularRenderedColoredStemCount: number | null = null;
      let circularRenderedColoredConnectorCount: number | null = null;
      if (cachedCircularTaxonomyBitmap) {
        const bitmapScaleRatio = camera.scale / Math.max(cachedCircularTaxonomyBitmap.scale, 1e-6);
        const sourceWidth = Math.max(1, cachedCircularTaxonomyBitmap.viewportWidth / Math.max(bitmapScaleRatio, 1e-6));
        const sourceHeight = Math.max(1, cachedCircularTaxonomyBitmap.viewportHeight / Math.max(bitmapScaleRatio, 1e-6));
        const sourceX = cachedCircularTaxonomyBitmap.sourceOffsetX - (camera.translateX / Math.max(bitmapScaleRatio, 1e-6));
        const sourceY = cachedCircularTaxonomyBitmap.sourceOffsetY - (camera.translateY / Math.max(bitmapScaleRatio, 1e-6));
        ctx.drawImage(
          cachedCircularTaxonomyBitmap.canvas,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          renderSize.width,
          renderSize.height,
        );
      } else if (drawCachedCircularTaxonomyPaths && cachedCircularTaxonomyPaths) {
        ctx.save();
        ctx.translate(camera.translateX, camera.translateY);
        ctx.scale(camera.scale, camera.scale);
        ctx.rotate(rotationAngle);
        ctx.lineCap = "butt";
        cachedCircularTaxonomyPaths.forEach((pathCache, color) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = (1.2 * circularBranchStrokeScale) / Math.max(camera.scale, 1e-6);
          ctx.globalAlpha = 0.95;
          ctx.stroke(pathCache.connectors);
          ctx.stroke(pathCache.stems);
        });
        ctx.globalAlpha = 1;
        ctx.restore();
        } else if (cachedCircularBasePath) {
          ctx.save();
          ctx.translate(camera.translateX, camera.translateY);
          ctx.scale(camera.scale, camera.scale);
          ctx.rotate(rotationAngle);
        ctx.strokeStyle = BRANCH_COLOR;
        ctx.lineWidth = circularBranchStrokeScale / Math.max(camera.scale, 1e-6);
          ctx.lineCap = "butt";
          ctx.stroke(cachedCircularBasePath.connectors);
          ctx.stroke(cachedCircularBasePath.stems);
          ctx.restore();
        } else if (!useColoredBranchRendering) {
          ctx.strokeStyle = BRANCH_COLOR;
          ctx.lineWidth = circularBranchStrokeScale;
          const connectorPath = new Path2D();
          const stemPath = new Path2D();
          if (useHugeTreeZoomedCircularRendering && collapsedNodes.size === 0) {
            const tau = Math.PI * 2;
            const screenCenterWorld = screenToWorldCircular(camera, renderSize.width * 0.5, renderSize.height * 0.5);
            const screenCenterTheta = wrapPositive(Math.atan2(screenCenterWorld.y, screenCenterWorld.x) - rotationAngle);
            const viewportContainsOrigin = centerPoint.x >= 0
              && centerPoint.x <= renderSize.width
              && centerPoint.y >= 0
              && centerPoint.y <= renderSize.height;
            let angularHalfSpan = Math.PI;
            if (!viewportContainsOrigin) {
              const cornerAngles = [
                screenToWorldCircular(camera, 0, 0),
                screenToWorldCircular(camera, renderSize.width, 0),
                screenToWorldCircular(camera, 0, renderSize.height),
                screenToWorldCircular(camera, renderSize.width, renderSize.height),
              ].map((point) => {
                let delta = wrapPositive(Math.atan2(point.y, point.x) - rotationAngle) - screenCenterTheta;
                if (delta > Math.PI) {
                  delta -= tau;
                } else if (delta < -Math.PI) {
                  delta += tau;
                }
                return delta;
              });
              angularHalfSpan = Math.min(
                Math.PI,
                Math.max(...cornerAngles.map((angle) => Math.abs(angle))) + (96 / Math.max(1, camera.scale * maxRadius)),
              );
            }
            const ordered = orderedLeaves;
            const drawLeafPath = (leafIndex: number, drawnStems: Set<number>, drawnConnectors: Set<number>, budget: { count: number }): void => {
              let node = ordered[Math.max(0, Math.min(ordered.length - 1, leafIndex))];
              while (node >= 0 && budget.count < HUGE_TREE_ZOOMED_SEGMENT_BUDGET) {
                const parent = tree.buffers.parent[node];
                if (parent >= 0 && !drawnStems.has(node)) {
                  drawnStems.add(node);
                  const theta = polarThetaFor(layout.center, node);
                  const startWorld = polarToCartesian(axisDepth(tree.buffers.depth[parent]), theta);
                  const endWorld = polarToCartesian(axisDepth(tree.buffers.depth[node]), theta);
                  const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
                  const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
                  if (lineIntersectsRect(start.x, start.y, end.x, end.y, -80, -80, renderSize.width + 160, renderSize.height + 160)) {
                    stemPath.moveTo(start.x, start.y);
                    stemPath.lineTo(end.x, end.y);
                    budget.count += 1;
                  }
                }
                if (parent >= 0 && !drawnConnectors.has(parent) && children[parent]?.length >= 2) {
                  drawnConnectors.add(parent);
                  const siblings = children[parent];
                  const radiusPx = axisDepth(tree.buffers.depth[parent]) * camera.scale;
                  if (radiusPx >= 0.25) {
                    const startTheta = polarThetaFor(layout.center, siblings[0]);
                    const endTheta = polarThetaFor(layout.center, siblings[siblings.length - 1]);
                    const arcStart = polarThetaFor(layout.min, parent);
                    const arcEnd = polarThetaFor(layout.max, parent);
                    const arcLength = Math.max(0, arcEnd - arcStart);
                    const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
                    const start = arcAngles.start + rotationAngle;
                    const end = arcAngles.end + rotationAngle;
                    if (arcIntersectsViewport(centerPoint.x, centerPoint.y, radiusPx, start, end, renderSize.width, renderSize.height)) {
                      connectorPath.moveTo(
                        centerPoint.x + Math.cos(start) * radiusPx,
                        centerPoint.y + Math.sin(start) * radiusPx,
                      );
                      connectorPath.arc(centerPoint.x, centerPoint.y, radiusPx, start, end, false);
                      budget.count += 1;
                    }
                  }
                }
                node = parent;
              }
            };
            const drawnStems = new Set<number>();
            const drawnConnectors = new Set<number>();
            const budget = { count: 0 };
            const drawIndexRange = (rawStart: number, rawEnd: number): void => {
              const start = Math.max(0, Math.min(ordered.length - 1, Math.floor(rawStart)));
              const end = Math.max(start, Math.min(ordered.length - 1, Math.ceil(rawEnd)));
              const count = end - start + 1;
              const step = Math.max(1, Math.ceil(count / HUGE_TREE_ZOOMED_SAMPLE_LEAF_LIMIT));
              for (let leafIndex = start; leafIndex <= end && budget.count < HUGE_TREE_ZOOMED_SEGMENT_BUDGET; leafIndex += step) {
                drawLeafPath(leafIndex, drawnStems, drawnConnectors, budget);
              }
            };
            if (viewportContainsOrigin || angularHalfSpan >= Math.PI) {
              drawIndexRange(0, ordered.length - 1);
            } else {
              const startTheta = screenCenterTheta - angularHalfSpan;
              const endTheta = screenCenterTheta + angularHalfSpan;
              if (startTheta < 0) {
                drawIndexRange(((startTheta + tau) / tau) * tree.leafCount, tree.leafCount - 1);
                drawIndexRange(0, (endTheta / tau) * tree.leafCount);
              } else if (endTheta >= tau) {
                drawIndexRange((startTheta / tau) * tree.leafCount, tree.leafCount - 1);
                drawIndexRange(0, ((endTheta - tau) / tau) * tree.leafCount);
              } else {
                drawIndexRange((startTheta / tau) * tree.leafCount, (endTheta / tau) * tree.leafCount);
              }
            }
          } else if (visibleCircularSegments) {
            const drawnConnectorNodes = new Set<number>();
            for (let index = 0; index < visibleCircularSegments.length; index += 1) {
              const segment = visibleCircularSegments[index];
            const start = worldToScreenCircular(camera, segment.x1, segment.y1);
            const end = worldToScreenCircular(camera, segment.x2, segment.y2);
            if (useDenseCircularLOD) {
              const key = quantizedSegmentKey(start.x, start.y, end.x, end.y);
              if ((segment.kind === "connector" ? circularConnectorKeys : circularStemKeys)?.has(key)) {
                continue;
              }
              (segment.kind === "connector" ? circularConnectorKeys : circularStemKeys)?.add(key);
            }
            if (segment.kind === "connector") {
              const node = segment.node;
              if (drawnConnectorNodes.has(node)) {
                continue;
              }
              drawnConnectorNodes.add(node);
              const ordered = children[node];
              if (ordered.length < 2) {
                continue;
              }
              const radiusPx = axisDepth(tree.buffers.depth[node]) * camera.scale;
              if (radiusPx < 0.25) {
                continue;
              }
              const startTheta = polarThetaFor(layout.center, ordered[0]);
              const endTheta = polarThetaFor(layout.center, ordered[ordered.length - 1]);
              const arcStart = polarThetaFor(layout.min, node);
              const arcEnd = polarThetaFor(layout.max, node);
              const arcLength = Math.max(0, arcEnd - arcStart);
              const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
              connectorPath.moveTo(
                centerPoint.x + Math.cos(arcAngles.start + rotationAngle) * radiusPx,
                centerPoint.y + Math.sin(arcAngles.start + rotationAngle) * radiusPx,
              );
              connectorPath.arc(centerPoint.x, centerPoint.y, radiusPx, arcAngles.start + rotationAngle, arcAngles.end + rotationAngle, false);
              pushScenePath(() => svgArcPath(centerPoint.x, centerPoint.y, radiusPx, arcAngles.start + rotationAngle, arcAngles.end + rotationAngle), BRANCH_COLOR, circularBranchStrokeScale);
            } else {
              stemPath.moveTo(start.x, start.y);
              stemPath.lineTo(end.x, end.y);
              pushSceneLine(start.x, start.y, end.x, end.y, BRANCH_COLOR, circularBranchStrokeScale);
            }
          }
        } else {
          for (let node = 0; node < tree.nodeCount; node += 1) {
            if (hiddenNodes[node] || collapsedNodes.has(node)) {
              continue;
            }
            const ordered = children[node];
            if (ordered.length < 2) {
              continue;
            }
            const radius = axisDepth(tree.buffers.depth[node]);
            const startTheta = polarThetaFor(layout.center, ordered[0]);
            const endTheta = polarThetaFor(layout.center, ordered[ordered.length - 1]);
            const arcStart = polarThetaFor(layout.min, node);
            const arcEnd = polarThetaFor(layout.max, node);
            const arcLength = Math.max(0, arcEnd - arcStart);
            const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
            const radiusPx = radius * camera.scale;
            if (radiusPx < 0.25) {
              continue;
            }
            if (!arcIntersectsViewport(
              centerPoint.x,
              centerPoint.y,
              radiusPx,
              arcAngles.start + rotationAngle,
              arcAngles.end + rotationAngle,
              renderSize.width,
              renderSize.height,
            )) {
              continue;
            }
            const startX = centerPoint.x + Math.cos(arcAngles.start + rotationAngle) * radiusPx;
            const startY = centerPoint.y + Math.sin(arcAngles.start + rotationAngle) * radiusPx;
            const endX = centerPoint.x + Math.cos(arcAngles.end + rotationAngle) * radiusPx;
            const endY = centerPoint.y + Math.sin(arcAngles.end + rotationAngle) * radiusPx;
            if (useDenseCircularLOD) {
              const key = quantizedSegmentKey(startX, startY, endX, endY);
              if (circularConnectorKeys?.has(key)) {
                continue;
              }
              circularConnectorKeys?.add(key);
            }
            connectorPath.moveTo(startX, startY);
            connectorPath.arc(centerPoint.x, centerPoint.y, radiusPx, arcAngles.start + rotationAngle, arcAngles.end + rotationAngle, false);
            pushScenePath(() => svgArcPath(centerPoint.x, centerPoint.y, radiusPx, arcAngles.start + rotationAngle, arcAngles.end + rotationAngle), BRANCH_COLOR, circularBranchStrokeScale);
          }
          for (let node = 0; node < tree.nodeCount; node += 1) {
            if (hiddenNodes[node]) {
              continue;
            }
            const parent = tree.buffers.parent[node];
            if (parent < 0) {
              continue;
            }
            const theta = polarThetaFor(layout.center, node);
            const startWorld = polarToCartesian(axisDepth(tree.buffers.depth[parent]), theta);
            const endWorld = polarToCartesian(axisDepth(tree.buffers.depth[node]), theta);
            const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
            const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
            if (!lineIntersectsRect(start.x, start.y, end.x, end.y, 0, 0, renderSize.width, renderSize.height)) {
              continue;
            }
            if (useDenseCircularLOD) {
              const key = quantizedSegmentKey(start.x, start.y, end.x, end.y);
              if (circularStemKeys?.has(key)) {
                continue;
              }
              circularStemKeys?.add(key);
            }
            stemPath.moveTo(start.x, start.y);
            stemPath.lineTo(end.x, end.y);
            pushSceneLine(start.x, start.y, end.x, end.y, BRANCH_COLOR, circularBranchStrokeScale);
          }
        }
        ctx.lineCap = "butt";
        ctx.stroke(connectorPath);
        ctx.stroke(stemPath);
      } else {
        if (largeMetadataCircularBasePath) {
          ctx.save();
          ctx.translate(camera.translateX, camera.translateY);
          ctx.scale(camera.scale, camera.scale);
          ctx.rotate(rotationAngle);
          ctx.strokeStyle = BRANCH_COLOR;
          ctx.globalAlpha = 0.62;
          ctx.lineCap = "butt";
          ctx.lineWidth = circularBranchStrokeScale / Math.max(camera.scale, 1e-6);
          ctx.stroke(largeMetadataCircularBasePath.connectors);
          ctx.stroke(largeMetadataCircularBasePath.stems);
          ctx.restore();
          ctx.globalAlpha = 1;
        }
        const colorStemPaths = new Map<string, Path2D>();
        const colorArcPaths = new Map<string, Path2D>();
        let coloredSegmentCount = 0;
        let coloredStemCount = 0;
        let coloredConnectorCount = 0;
        const coloredSegmentBudget = useLargeMetadataBranchLOD ? LARGE_METADATA_COLORED_SEGMENT_BUDGET : Number.POSITIVE_INFINITY;
        const getColorPath = (paths: Map<string, Path2D>, color: string): Path2D => {
          let path = paths.get(color);
          if (!path) {
            path = new Path2D();
            paths.set(color, path);
          }
          return path;
        };
        const pushStem = (color: string, x1: number, y1: number, x2: number, y2: number): void => {
          if (coloredSegmentCount >= coloredSegmentBudget) {
            return;
          }
          if (useDenseCircularLOD) {
            const key = quantizedSegmentKey(x1, y1, x2, y2);
            if (circularStemKeys?.has(key)) {
              return;
            }
            circularStemKeys?.add(key);
          }
          const path = getColorPath(colorStemPaths, color);
          path.moveTo(x1, y1);
          path.lineTo(x2, y2);
          coloredSegmentCount += 1;
          coloredStemCount += 1;
          pushSceneLine(x1, y1, x2, y2, color, 1.2 * circularBranchStrokeScale, 0.95);
        };
        const pushArc = (color: string, radiusPx: number, start: number, end: number): void => {
          if (radiusPx < 0.25 || end <= start || coloredSegmentCount >= coloredSegmentBudget) {
            return;
          }
          if (useDenseCircularLOD) {
            const startX = centerPoint.x + Math.cos(start) * radiusPx;
            const startY = centerPoint.y + Math.sin(start) * radiusPx;
            const endX = centerPoint.x + Math.cos(end) * radiusPx;
            const endY = centerPoint.y + Math.sin(end) * radiusPx;
            const key = quantizedSegmentKey(startX, startY, endX, endY);
            if (circularConnectorKeys?.has(key)) {
              return;
            }
            circularConnectorKeys?.add(key);
          }
          const path = getColorPath(colorArcPaths, color);
          path.moveTo(
            centerPoint.x + Math.cos(start) * radiusPx,
            centerPoint.y + Math.sin(start) * radiusPx,
          );
          path.arc(centerPoint.x, centerPoint.y, radiusPx, start, end, false);
          coloredSegmentCount += 1;
          coloredConnectorCount += 1;
          pushScenePath(() => svgArcPath(centerPoint.x, centerPoint.y, radiusPx, start, end), color, 1.2 * circularBranchStrokeScale, undefined, 0.95);
        };
        if (useSampledColoredCircularRendering) {
          const tau = Math.PI * 2;
          const screenCenterWorld = screenToWorldCircular(camera, renderSize.width * 0.5, renderSize.height * 0.5);
          const screenCenterTheta = wrapPositive(Math.atan2(screenCenterWorld.y, screenCenterWorld.x) - rotationAngle);
          const viewportContainsOrigin = centerPoint.x >= 0
            && centerPoint.x <= renderSize.width
            && centerPoint.y >= 0
            && centerPoint.y <= renderSize.height;
          let angularHalfSpan = Math.PI;
          if (!viewportContainsOrigin) {
            const cornerAngles = [
              screenToWorldCircular(camera, 0, 0),
              screenToWorldCircular(camera, renderSize.width, 0),
              screenToWorldCircular(camera, 0, renderSize.height),
              screenToWorldCircular(camera, renderSize.width, renderSize.height),
            ].map((point) => {
              let delta = wrapPositive(Math.atan2(point.y, point.x) - rotationAngle) - screenCenterTheta;
              if (delta > Math.PI) {
                delta -= tau;
              } else if (delta < -Math.PI) {
                delta += tau;
              }
              return delta;
            });
            angularHalfSpan = Math.min(
              Math.PI,
              Math.max(...cornerAngles.map((angle) => Math.abs(angle))) + (96 / Math.max(1, camera.scale * maxRadius)),
            );
          }
          const drawnStems = new Set<number>();
          const drawnConnectorEdges = new Set<string>();
          const drawLeafPath = (leafIndex: number): void => {
            let node = orderedLeaves[Math.max(0, Math.min(orderedLeaves.length - 1, leafIndex))];
            while (node >= 0 && coloredSegmentCount < coloredSegmentBudget) {
              const parent = tree.buffers.parent[node];
              if (parent >= 0) {
                if (!drawnStems.has(node)) {
                  drawnStems.add(node);
                  const color = effectiveBranchColors?.[node] ?? BRANCH_COLOR;
                  const theta = polarThetaFor(layout.center, node);
                  const startWorld = polarToCartesian(axisDepth(tree.buffers.depth[parent]), theta);
                  const endWorld = polarToCartesian(axisDepth(tree.buffers.depth[node]), theta);
                  const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
                  const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
                  if (lineIntersectsRect(start.x, start.y, end.x, end.y, -80, -80, renderSize.width + 160, renderSize.height + 160)) {
                    pushStem(color, start.x, start.y, end.x, end.y);
                  }
                }
                const connectorKey = `${parent}:${node}`;
                if (!drawnConnectorEdges.has(connectorKey) && children[parent]?.length >= 2) {
                  drawnConnectorEdges.add(connectorKey);
                  const radiusPx = axisDepth(tree.buffers.depth[parent]) * camera.scale;
                  if (radiusPx >= 0.25) {
                    const ownerTheta = polarThetaFor(layout.center, parent);
                    const ownerArcStart = polarThetaFor(layout.min, parent);
                    const ownerArcEnd = polarThetaFor(layout.max, parent);
                    const ownerArcLength = Math.max(0, ownerArcEnd - ownerArcStart);
                    const childTheta = polarThetaFor(layout.center, node);
                    const arcSpan = arcSubspanWithinSpan(ownerTheta, childTheta, ownerArcStart, ownerArcLength);
                    if (arcSpan) {
                      const start = arcSpan.start + rotationAngle;
                      const end = arcSpan.end + rotationAngle;
                      if (arcIntersectsViewport(centerPoint.x, centerPoint.y, radiusPx, start, end, renderSize.width, renderSize.height)) {
                        const color = effectiveBranchColors?.[node] ?? BRANCH_COLOR;
                        pushArc(color, radiusPx, start, end);
                      }
                    }
                  }
                }
              }
              node = parent;
            }
          };
          const drawIndexRange = (rawStart: number, rawEnd: number): void => {
            const start = Math.max(0, Math.min(orderedLeaves.length - 1, Math.floor(rawStart)));
            const end = Math.max(start, Math.min(orderedLeaves.length - 1, Math.ceil(rawEnd)));
            const count = end - start + 1;
            const step = Math.max(1, Math.ceil(count / LARGE_METADATA_COLORED_SAMPLE_LEAF_LIMIT));
            for (let leafIndex = start; leafIndex <= end && coloredSegmentCount < coloredSegmentBudget; leafIndex += step) {
              drawLeafPath(leafIndex);
            }
          };
          if (viewportContainsOrigin || angularHalfSpan >= Math.PI) {
            drawIndexRange(0, orderedLeaves.length - 1);
          } else {
            const startTheta = screenCenterTheta - angularHalfSpan;
            const endTheta = screenCenterTheta + angularHalfSpan;
            if (startTheta < 0) {
              drawIndexRange(((startTheta + tau) / tau) * tree.leafCount, tree.leafCount - 1);
              drawIndexRange(0, (endTheta / tau) * tree.leafCount);
            } else if (endTheta >= tau) {
              drawIndexRange((startTheta / tau) * tree.leafCount, tree.leafCount - 1);
              drawIndexRange(0, ((endTheta - tau) / tau) * tree.leafCount);
            } else {
              drawIndexRange((startTheta / tau) * tree.leafCount, (endTheta / tau) * tree.leafCount);
            }
          }
        } else if (visibleCircularSegments) {
          const drawnConnectorNodes = new Set<number>();
          for (let index = 0; index < visibleCircularSegments.length && coloredSegmentCount < coloredSegmentBudget; index += 1) {
            const segment = visibleCircularSegments[index];
            if (segment.kind === "connector") {
              const node = segment.node;
              if (drawnConnectorNodes.has(node)) {
                continue;
              }
              drawnConnectorNodes.add(node);
              const ordered = children[node];
              if (ordered.length < 2) {
                continue;
              }
              const radiusPx = axisDepth(tree.buffers.depth[node]) * camera.scale;
              if (radiusPx < 0.25) {
                continue;
              }
              const ownerTheta = polarThetaFor(layout.center, node);
              const ownerArcStart = polarThetaFor(layout.min, node);
              const ownerArcEnd = polarThetaFor(layout.max, node);
              const ownerArcLength = Math.max(0, ownerArcEnd - ownerArcStart);
              for (let childIndex = 0; childIndex < ordered.length && coloredSegmentCount < coloredSegmentBudget; childIndex += 1) {
                const child = ordered[childIndex];
                if (hiddenNodes[child]) {
                  continue;
                }
                const color = effectiveBranchColors?.[child] ?? BRANCH_COLOR;
                const childTheta = polarThetaFor(layout.center, child);
                const arcSpan = arcSubspanWithinSpan(ownerTheta, childTheta, ownerArcStart, ownerArcLength);
                if (!arcSpan) {
                  continue;
                }
                pushArc(color, radiusPx, arcSpan.start + rotationAngle, arcSpan.end + rotationAngle);
              }
              continue;
            }
            const parent = tree.buffers.parent[segment.node];
            if (parent < 0) {
              continue;
            }
            const color = effectiveBranchColors?.[segment.node] ?? BRANCH_COLOR;
            const start = worldToScreenCircular(camera, segment.x1, segment.y1);
            const end = worldToScreenCircular(camera, segment.x2, segment.y2);
            pushStem(color, start.x, start.y, end.x, end.y);
          }
        } else {
          for (let node = 0; node < tree.nodeCount && coloredSegmentCount < coloredSegmentBudget; node += 1) {
            if (hiddenNodes[node]) {
              continue;
            }
            const parent = tree.buffers.parent[node];
            if (parent < 0) {
              if (!collapsedNodes.has(node) && children[node].length >= 2) {
                const startTheta = polarThetaFor(layout.center, children[node][0]);
                const endTheta = polarThetaFor(layout.center, children[node][children[node].length - 1]);
                const arcStart = polarThetaFor(layout.min, node);
                const arcEnd = polarThetaFor(layout.max, node);
                const arcLength = Math.max(0, arcEnd - arcStart);
                const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
                const radiusPx = axisDepth(tree.buffers.depth[node]) * camera.scale;
                pushArc(BRANCH_COLOR, radiusPx, arcAngles.start + rotationAngle, arcAngles.end + rotationAngle);
              }
              continue;
            }
            const color = effectiveBranchColors?.[node] ?? BRANCH_COLOR;
            const theta = polarThetaFor(layout.center, node);
            const startWorld = polarToCartesian(axisDepth(tree.buffers.depth[parent]), theta);
            const endWorld = polarToCartesian(axisDepth(tree.buffers.depth[node]), theta);
            const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
            const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
            if (lineIntersectsRect(start.x, start.y, end.x, end.y, 0, 0, renderSize.width, renderSize.height)) {
              pushStem(color, start.x, start.y, end.x, end.y);
            }
            if (collapsedNodes.has(node) || children[node].length < 2) {
              continue;
            }
            const ownerTheta = polarThetaFor(layout.center, node);
            const ownerArcStart = polarThetaFor(layout.min, node);
            const ownerArcEnd = polarThetaFor(layout.max, node);
            const ownerArcLength = Math.max(0, ownerArcEnd - ownerArcStart);
            const radiusPx = axisDepth(tree.buffers.depth[node]) * camera.scale;
            for (
              let childIndex = 0;
              childIndex < children[node].length && coloredSegmentCount < coloredSegmentBudget;
              childIndex += 1
            ) {
              const child = children[node][childIndex];
              if (hiddenNodes[child]) {
                continue;
              }
              const childTheta = polarThetaFor(layout.center, child);
              const arcSpan = arcSubspanWithinSpan(
                ownerTheta,
                childTheta,
                ownerArcStart,
                ownerArcLength,
              );
              if (!arcSpan) {
                continue;
              }
              pushArc(
                effectiveBranchColors?.[child] ?? BRANCH_COLOR,
                radiusPx,
                arcSpan.start + rotationAngle,
                arcSpan.end + rotationAngle,
              );
            }
          }
        }
        colorArcPaths.forEach((path, color) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2 * circularBranchStrokeScale;
          ctx.lineCap = "butt";
          ctx.globalAlpha = 0.95;
          ctx.stroke(path);
        });
        colorStemPaths.forEach((path, color) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2 * circularBranchStrokeScale;
          ctx.lineCap = "butt";
          ctx.globalAlpha = 0.95;
          ctx.stroke(path);
        });
        circularRenderedColoredStemCount = coloredStemCount;
        circularRenderedColoredConnectorCount = coloredConnectorCount;
      }
      timing.branchBaseMs += performance.now() - circularBranchStartTime;

      if (searchMatches.length > 0) {
        const drawSearchBranches = (
          nodes: number[],
          color: string,
          lineWidth: number,
          radius: number,
        ): void => {
          const points: Array<{ x: number; y: number }> = [];
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = lineWidth;
          ctx.beginPath();
          for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            if (hiddenNodes[node] || collapsedNodes.has(node)) {
              continue;
            }
            const parent = tree.buffers.parent[node];
            const theta = polarThetaFor(layout.center, node);
            const x = axisDepth(tree.buffers.depth[node]);
            if (parent >= 0) {
              const startWorld = polarToCartesian(axisDepth(tree.buffers.depth[parent]), theta);
              const endWorld = polarToCartesian(x, theta);
              const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
              const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
              if (lineIntersectsRect(start.x, start.y, end.x, end.y, 0, 0, renderSize.width, renderSize.height)) {
                ctx.moveTo(start.x, start.y);
                ctx.lineTo(end.x, end.y);
              }
            }
            if (children[node].length >= 2) {
              const startTheta = polarThetaFor(layout.center, children[node][0]);
              const endTheta = polarThetaFor(layout.center, children[node][children[node].length - 1]);
              const arcStart = polarThetaFor(layout.min, node);
              const arcEnd = polarThetaFor(layout.max, node);
              const arcLength = Math.max(0, arcEnd - arcStart);
              const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
              const radiusPx = x * camera.scale;
              if (radiusPx >= 0.25) {
                ctx.moveTo(
                  centerPoint.x + Math.cos(arcAngles.start + rotationAngle) * radiusPx,
                  centerPoint.y + Math.sin(arcAngles.start + rotationAngle) * radiusPx,
                );
                ctx.arc(
                  centerPoint.x,
                  centerPoint.y,
                  radiusPx,
                  arcAngles.start + rotationAngle,
                  arcAngles.end + rotationAngle,
                  false,
                );
              }
            }
            if (x <= maxRadius) {
              const point = worldToScreenCircular(camera, Math.cos(theta) * x, Math.sin(theta) * x);
              if (
                point.x >= -24 && point.x <= renderSize.width + 24 &&
                point.y >= -24 && point.y <= renderSize.height + 24
              ) {
                points.push(point);
              }
            }
          }
          ctx.stroke();
          for (let index = 0; index < points.length; index += 1) {
            const point = points[index];
            ctx.beginPath();
            ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
            ctx.fill();
          }
        };

        const passiveMatches = activeSearchNode === null
          ? searchMatches
          : searchMatches.filter((node) => node !== activeSearchNode);
        drawSearchBranches(passiveMatches, "#2563eb", 1.8, 2.3);
        if (activeSearchNode !== null) {
          drawSearchBranches([activeSearchNode], "#c2410c", 2.7, 3.3);
        }
      }

      const tipLabelCueVisible = showTipLabels && angularSpacingPx > 1.6;
      const microTipLabelsVisible = showTipLabels && angularSpacingPx > 2.9;
      const tipLabelsVisible = showTipLabels && angularSpacingPx > 4.5;
      const tipFontSize = scaleLabelFontSize("tip", Math.max(6.5, Math.min(20, angularSpacingPx * 0.74)));
      const microTipFontSize = scaleLabelFontSize("tip", Math.max(4.2, Math.min(6.1, angularSpacingPx * 0.3)));
      const readableBandProgress = smoothstep01((angularSpacingPx - 2.9) / Math.max(1e-6, 4.5 - 2.9));
      const tipBandFontSize = angularSpacingPx <= 2.9
        ? 0
        : microTipFontSize + ((tipFontSize - microTipFontSize) * readableBandProgress);
      const microBandWidthPx = estimateLabelWidth(Math.max(microTipFontSize, 4.2), reservedTipLabelCharacters);
      const readableBandWidthPx = estimateLabelWidth(Math.max(tipFontSize, 6.5), reservedTipLabelCharacters);
      const renderedMetadataMarkerSizePx = scaledMetadataMarkerSizePx(metadataMarkerSizePx, angularSpacingPx);
      const renderedMetadataPieSizePx = scaledMetadataGlyphSizePx(metadataPieSizePx, angularSpacingPx);
      const metadataTipDecorationLabelClearancePx = metadataTipDecorationMaxSizePx > 0
        ? Math.max(20, (Math.max(
          metadataMarkerNodes.length > 0 ? renderedMetadataMarkerSizePx : 0,
          metadataPieNodes.length > 0 ? renderedMetadataPieSizePx : 0,
        ) * 0.5) + 6)
        : 20;
      const metadataTipDecorationLabelExtraPx = Math.max(0, metadataTipDecorationLabelClearancePx - 20);
      const globalTipLabelSpacePx = showTipLabels
        ? interpolateTipBandWidthPx(
          angularSpacingPx,
          1.6,
          2.9,
          4.5,
          microBandWidthPx,
          readableBandWidthPx,
        ) + metadataTipDecorationLabelExtraPx
        : 0;
      const tipLabelRadius = maxRadius + (metadataTipDecorationLabelClearancePx / camera.scale);
      const cueTipLabelRadius = maxRadius + (Math.max(8, metadataTipDecorationLabelClearancePx * 0.55) / camera.scale);
      const tipBandAnchorRadius = microTipLabelsVisible || tipLabelsVisible ? tipLabelRadius : cueTipLabelRadius;
      const circularTipVisibilityMargin = Math.max(140, Math.ceil(globalTipLabelSpacePx + 96));
      const taxonomyVisibilityOuterRadiusPx = taxonomyEnabled && renderedTaxonomyBlocks && visibleTaxonomyRanks.length > 0
        ? (() => {
          const taxonomyMetricBaseSize = Math.max(8.5, Math.min(18, 8.5 + (angularSpacingPx * 0.45)));
          const metrics = taxonomyRingMetricsPx(
            visibleTaxonomyRanks.length,
            taxonomyMetricBaseSize,
            taxonomyBandThicknessScale,
            circularOverlayViewportScale,
            thickenOutermostTaxonomyRibbon,
          );
          return (maxRadius * camera.scale)
            + controlledRibbonGapPx(
              taxonomyGapControl,
              taxonomyBaselineGapPx + metrics.ringGapPx,
              globalTipLabelSpacePx,
            )
            + metrics.ringWidthsPx.reduce((total, width) => total + width, 0)
            + (Math.max(0, visibleTaxonomyRanks.length - 1) * metrics.ringGapPx)
            + 24;
        })()
        : 0;
      const needsVisibleLeafRanges = tipLabelCueVisible
        || (taxonomyEnabled && renderedTaxonomyBlocks !== null && visibleCircleFraction < CIRCULAR_TAXONOMY_VISIBLE_FILTER_MAX_VISIBLE_FRACTION);
      const circularTaxonomyVisibilityMarginPx = compactCircularViewport ? 220 : 120;
      const circularTaxonomyScreenSampleMarginPx = compactCircularViewport ? 96 : 48;
      const circularTaxonomyLabelAnchorMarginPx = compactCircularViewport ? 120 : 24;
      const circularTaxonomyLabelViewportMarginPx = compactCircularViewport ? 42 : 2;
      const visibleLeafOverscan = needsVisibleLeafRanges
        ? Math.max(12, Math.min(1600, Math.ceil((circularTipVisibilityMargin + 120) / Math.max(0.5, angularSpacingPx))))
        : 0;
      const tipLabelVisibilityOuterRadiusPx = tipLabelCueVisible
        ? (tipBandAnchorRadius * camera.scale) + Math.max(globalTipLabelSpacePx, 28)
        : 0;
      const leafVisibilityRadiusPx = needsVisibleLeafRanges
        ? Math.max(maxRadius * camera.scale, tipLabelVisibilityOuterRadiusPx, taxonomyVisibilityOuterRadiusPx)
        : 0;
      const visibleAngleSpans = needsVisibleLeafRanges
        ? computeVisibleCircularAngleSpans(
          centerPoint.x,
          centerPoint.y,
          leafVisibilityRadiusPx,
          renderSize.width,
          renderSize.height,
          Math.max(circularTipVisibilityMargin + 80, circularTaxonomyVisibilityMarginPx),
        )
        : [];
      const visibleLeafRanges = visibleAngleSpans.length > 0
        ? circularSpansToLeafRanges(
          visibleAngleSpans,
          rotationAngle,
          orderedLeaves,
          layout.center,
          tree.leafCount,
          visibleLeafOverscan,
          polarAngleStart,
          polarAngleSpan,
        )
        : [];
      timing.circularVisibilityPrepMs += performance.now() - circularVisibilityPrepStartTime;
      let circularVisibleTipLabels: Array<{ node: number; theta: number; x: number; y: number; text: string; width: number }> = [];
      let maxVisibleTipLabelWidth = 0;
      if (tipLabelCueVisible) {
        ctx.font = fontSpec("tip", tipFontSize);
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        for (let rangeIndex = 0; rangeIndex < visibleLeafRanges.length; rangeIndex += 1) {
          const range = visibleLeafRanges[rangeIndex];
          for (let index = range.startIndex; index < range.endIndex; index += 1) {
            const node = orderedLeaves[index];
            if (hiddenNodes[node]) {
              continue;
            }
            const theta = polarThetaFor(layout.center, node);
            const labelAnchorRadius = alignTipLabels
              ? (microTipLabelsVisible ? tipLabelRadius : cueTipLabelRadius)
              : axisDepth(tree.buffers.depth[node])
                + (
                  (
                    microTipLabelsVisible
                      ? metadataTipDecorationLabelClearancePx
                      : Math.max(8, metadataTipDecorationLabelClearancePx * 0.55)
                  )
                  / Math.max(camera.scale, 1e-6)
                );
            const point = polarToCartesian(labelAnchorRadius, theta);
            const screen = worldToScreenCircular(camera, point.x, point.y);
            if (
              screen.x < -circularTipVisibilityMargin ||
              screen.x > renderSize.width + circularTipVisibilityMargin ||
              screen.y < -circularTipVisibilityMargin ||
              screen.y > renderSize.height + circularTipVisibilityMargin
            ) {
              continue;
            }
            const text = displayTipLabelForView(node);
            const width = ctx.measureText(text).width;
            circularVisibleTipLabels.push({ node, theta, x: screen.x, y: screen.y, text, width });
            maxVisibleTipLabelWidth = Math.max(maxVisibleTipLabelWidth, width);
          }
        }
      }
      let circularGenusLabels: ScreenLabel[] = [];
      let circularGenusArcs: CircularOverlayArc[] = [];
      let circularGenusBaseFontSize = 0;
      let circularFirstTaxonomyRingInnerRadiusPx: number | null = null;
      const circularTaxonomyOverlayStartTime = performance.now();
      if (taxonomyEnabled && renderedTaxonomyBlocks) {
        const visibleRanks = visibleTaxonomyRanks;
        const baseFontSize = Math.max(8.5, Math.min(18, 8.5 + (angularSpacingPx * 0.45)));
        circularGenusBaseFontSize = baseFontSize;
        const taxonomyMetricBaseSize = Math.max(8.5, Math.min(18, 8.5 + (angularSpacingPx * 0.45)));
        const metrics = taxonomyRingMetricsPx(
          visibleRanks.length,
          taxonomyMetricBaseSize,
          taxonomyBandThicknessScale,
          circularOverlayViewportScale,
          thickenOutermostTaxonomyRibbon,
        );
        const tipBandOuterRadiusPx = (maxRadius * camera.scale) + globalTipLabelSpacePx;
        const firstRibbonStrokeInsetPx = taxonomyOverlayStyle === "ribbons"
          ? (metrics.ringWidthsPx[0] ?? 0) * 0.04
          : 0;
        const closedGapInsetCompensationPx = globalTipLabelSpacePx > 0
          ? 0
          : firstRibbonStrokeInsetPx * (1 - Math.min(1, taxonomyGapControl));
        const firstTaxonomyRingInnerRadiusPx = (maxRadius * camera.scale) + controlledRibbonGapPx(
          taxonomyGapControl,
          taxonomyBaselineGapPx + metrics.ringGapPx,
          globalTipLabelSpacePx,
        ) - closedGapInsetCompensationPx;
        circularFirstTaxonomyRingInnerRadiusPx = visibleRanks.length > 0
          ? firstTaxonomyRingInnerRadiusPx
          : null;
        const viewportCenterRenderedTheta = wrapPositive(Math.atan2((renderSize.height * 0.5) - centerPoint.y, (renderSize.width * 0.5) - centerPoint.x));
        let ringCursorOuterPx = firstTaxonomyRingInnerRadiusPx;
        const placedLabels: ScreenLabel[] = [];
        const placedKeys: string[] = [];
        const includeDetailedTaxonomyDebug = detailedRenderDebugEnabledRef.current;
        const arcKeys: string[] = [];
        const taxonomyCandidateDebug: Array<Record<string, unknown>> = [];
        const pushTaxonomyCandidateDebug = (entry: Record<string, unknown>): void => {
          if (includeDetailedTaxonomyDebug) {
            taxonomyCandidateDebug.push(entry);
          }
        };
        const previousTaxonomyState = taxonomyLabelHistoryRef.current;
        const canReusePreviousTaxonomyLabelHistory = Boolean(
          previousTaxonomyState
          && previousTaxonomyState.tree === tree
          && previousTaxonomyState.viewMode === viewMode
          && previousTaxonomyState.order === order,
        );
        const eligibleTaxonomyLabelKeys = new Set(
          visibleRanks.flatMap((rank) => (
            (circularTaxonomyBlockPriority?.[rank] ?? []).map((entry) => entry.key)
          )),
        );
        const mergeTaxonomyLabelThetas = (labels: ScreenLabel[]): Array<{ key: string; theta: number }> => {
          const current = labels
            .filter((label) => typeof label.key === "string" && typeof label.theta === "number")
            .map((label) => ({ key: label.key as string, theta: label.theta as number }));
          if (!canReusePreviousTaxonomyLabelHistory || !previousTaxonomyState) {
            return current;
          }
          const currentKeys = new Set(current.map((entry) => entry.key));
          return [
            ...current,
            ...(previousTaxonomyState.labelThetas ?? []).filter((entry) => (
              eligibleTaxonomyLabelKeys.has(entry.key) && !currentKeys.has(entry.key)
            )),
          ];
        };
        let previewRingCursorOuterPx = firstTaxonomyRingInnerRadiusPx;
        let taxonomyOverlayRingsFullyVisible = visibleRanks.length > 0;
        for (let rankIndex = 0; rankIndex < visibleRanks.length; rankIndex += 1) {
          const ringOuterPx = previewRingCursorOuterPx + metrics.ringWidthsPx[rankIndex];
          if (ringOuterPx > (fullyVisibleRadiusPx - 24)) {
            taxonomyOverlayRingsFullyVisible = false;
            break;
          }
          previewRingCursorOuterPx = ringOuterPx + metrics.ringGapPx;
        }
        const visibleLeafRangesSignature = visibleLeafRanges.length > 0
          ? visibleLeafRanges
            .map((range) => `${Math.floor(range.startIndex / 128)}-${Math.floor(Math.max(range.startIndex, range.endIndex - 1) / 128)}`)
            .join("|")
          : "all";
        const visibleRankBlockCountsSignature = visibleRanks
          .map((rank) => `${rank}:${renderedTaxonomyBlocks[rank]?.length ?? 0}`)
          .join("|");
        const canUseCircularTaxonomyOverlayLayoutCache = !exportCapture
          && collapsedNodes.size === 0
          && lockTaxonomyLabelsToClade;
        const circularTaxonomyOverlayLayoutSignature = canUseCircularTaxonomyOverlayLayoutCache
          ? [
            order,
            visibleRanks.join("|"),
            taxonomyColorPalette,
            taxonomyCustomPaletteSignature,
            taxonomyColorRootRank,
            taxonomyColorJitterRank,
            taxonomyColorJitter.toFixed(3),
            taxonomyOverlayStyle,
            visibleRanks.map((rank) => `${rank}:${taxonomyRankDisplayModeForRank(rank)}`).join("|"),
            renderSize.width,
            renderSize.height,
            viewMode,
            polarAngleStart,
            polarAngleSpan,
            camera.scale.toFixed(6),
            camera.rotation.toFixed(6),
            taxonomyOverlayRingsFullyVisible
              ? "fully-visible"
              : `${visibleLeafRangesSignature}:${camera.translateX.toFixed(6)}:${camera.translateY.toFixed(6)}`,
            visibleRankBlockCountsSignature,
            taxonomyLabelSizeScale.toFixed(3),
            taxonomyBandThicknessScale.toFixed(3),
            thickenOutermostTaxonomyRibbon ? "thick-outer" : "uniform-ribbons",
            taxonomyGapControl.toFixed(3),
            labelFontFamilies.taxonomy,
            activeSearchTaxonomyKey ?? "",
            searchQuery.trim().toLowerCase(),
            includeDetailedTaxonomyDebug ? "debug" : "nodebug",
          ].join(":")
          : null;
        const cachedCircularTaxonomyOverlay = circularTaxonomyOverlayLayoutSignature
          && circularTaxonomyOverlayLayoutCacheRef.current
          && circularTaxonomyOverlayLayoutCacheRef.current.tree === tree
          && circularTaxonomyOverlayLayoutCacheRef.current.order === order
          && circularTaxonomyOverlayLayoutCacheRef.current.signature === circularTaxonomyOverlayLayoutSignature
          ? circularTaxonomyOverlayLayoutCacheRef.current
          : null;
        if (cachedCircularTaxonomyOverlay) {
          const overlayDx = centerPoint.x - cachedCircularTaxonomyOverlay.centerX;
          const overlayDy = centerPoint.y - cachedCircularTaxonomyOverlay.centerY;
          circularGenusLabels = cachedCircularTaxonomyOverlay.labels.map((label) => translateScreenLabel(label, overlayDx, overlayDy));
          circularGenusArcs = cachedCircularTaxonomyOverlay.arcs.map((arc) => translateCircularOverlayArc(arc, overlayDx, overlayDy));
          const firstCachedTaxonomyArc = cachedCircularTaxonomyOverlay.arcs[0] ?? null;
          const allTaxonomyLabels = circularGenusLabels;
          renderDebug.circular = {
            branchRenderMode: circularBranchRenderMode,
            visibleCircleFraction,
            cueVisible: tipLabelCueVisible,
            microVisible: microTipLabelsVisible,
            tipVisible: tipLabelsVisible,
            tipBandFontSize,
            tipBandWidthPx: globalTipLabelSpacePx,
            tipBandAnchorRadiusPx: tipBandAnchorRadius * camera.scale,
            visibleTipLabelCount: circularVisibleTipLabels.length,
            genusGapPx: null,
            genusLineRadiusPx: circularOverlayLineRadiusPx(firstCachedTaxonomyArc),
            visibleLeafRanges: visibleLeafRanges.map((range) => [range.startIndex, range.endIndex]),
            taxonomyVisibleRanks: visibleRanks,
            taxonomyBandWidthsPx: metrics.ringWidthsPx,
            taxonomyArcCount: circularGenusArcs.length,
            taxonomyPlacedLabelCount: allTaxonomyLabels.length,
            taxonomyBlockCounts: Object.fromEntries(
              TAXONOMY_RANKS.map((rank) => [rank, renderedTaxonomyBlocks[rank]?.length ?? 0]),
            ),
            taxonomyOverlayAlpha: CIRCULAR_TAXONOMY_OVERLAY_ALPHA,
            taxonomyTipBandOuterRadiusPx: cachedCircularTaxonomyOverlay.taxonomyTipBandOuterRadiusPx,
            taxonomyFirstRingInnerRadiusPx: cachedCircularTaxonomyOverlay.taxonomyFirstRingInnerRadiusPx,
            ...(includeDetailedTaxonomyDebug
              ? {
                taxonomyArcKeys: cachedCircularTaxonomyOverlay.arcKeys,
                taxonomyArcDebug: circularGenusArcs.map((arc, index) => ({
                  key: cachedCircularTaxonomyOverlay.arcKeys[index] ?? null,
                  mode: arc.mode,
                  startTheta: arc.mode === "divider" ? arc.theta : arc.startTheta,
                  endTheta: arc.mode === "divider" ? arc.theta : arc.endTheta,
                  lineWidthPx: circularOverlayLineWidthPx(arc),
                  lineRadiusPx: circularOverlayLineRadiusPx(arc),
                  innerRadiusPx: circularOverlayInnerRadiusPx(arc),
                  outerRadiusPx: circularOverlayOuterRadiusPx(arc),
                  screenSampleX: "screenPolygonPoints" in arc && arc.screenPolygonPoints && arc.screenPolygonPoints.length > 0
                    ? arc.screenPolygonPoints.reduce((total: number, point: { x: number; y: number }) => total + point.x, 0) / arc.screenPolygonPoints.length
                    : null,
                  screenSampleY: "screenPolygonPoints" in arc && arc.screenPolygonPoints && arc.screenPolygonPoints.length > 0
                    ? arc.screenPolygonPoints.reduce((total: number, point: { x: number; y: number }) => total + point.y, 0) / arc.screenPolygonPoints.length
                    : null,
                  spanTheta: arc.mode === "divider" ? 0 : arc.endTheta - arc.startTheta,
                  spanPx: arc.mode === "divider" ? 0 : (arc.endTheta - arc.startTheta) * (circularOverlayLineRadiusPx(arc) ?? 0),
                })),
                taxonomyLabelKeys: cachedCircularTaxonomyOverlay.placedKeys,
                taxonomyPlacedLabels: allTaxonomyLabels.map((label) => ({
                  key: label.key ?? null,
                  rank: label.rank ?? null,
                  theta: label.theta ?? null,
                  text: label.text,
                  x: label.x,
                  y: label.y,
                  fontSize: label.fontSize ?? 0,
                  offsetY: label.offsetY ?? 0,
                  rotation: label.rotation ?? 0,
                  color: label.color ?? null,
                  searchHighlightColor: label.searchHighlightColor ?? null,
                  clipArc: label.clipArc ?? null,
                })),
                taxonomyCandidateDebug: cachedCircularTaxonomyOverlay.taxonomyCandidateDebug,
              }
              : {}),
          };
          genusLabelHistoryRef.current = {
            tree,
            viewMode,
            order,
            zoom: camera.scale,
            visibleCenters: [],
            peakZoom: camera.scale,
            peakVisibleCenters: [],
          };
          taxonomyLabelHistoryRef.current = {
            tree,
            viewMode,
            order,
            zoom: camera.scale,
            visibleKeys: cachedCircularTaxonomyOverlay.placedKeys,
            labelThetas: mergeTaxonomyLabelThetas(allTaxonomyLabels),
            peakZoom: previousTaxonomyState && previousTaxonomyState.tree === tree && previousTaxonomyState.viewMode === viewMode && previousTaxonomyState.order === order
              ? Math.max(previousTaxonomyState.peakZoom, camera.scale)
              : camera.scale,
            peakVisibleKeys: previousTaxonomyState && previousTaxonomyState.tree === tree && previousTaxonomyState.viewMode === viewMode && previousTaxonomyState.order === order && camera.scale > previousTaxonomyState.zoom + 1e-6
              ? Array.from(new Set([...previousTaxonomyState.peakVisibleKeys, ...cachedCircularTaxonomyOverlay.placedKeys]))
              : cachedCircularTaxonomyOverlay.placedKeys,
          };
        } else {
        const preservedKeys = previousTaxonomyState
          && previousTaxonomyState.tree === tree
          && previousTaxonomyState.viewMode === viewMode
          && previousTaxonomyState.order === order
          && camera.scale > previousTaxonomyState.zoom + 1e-6
          ? previousTaxonomyState.peakVisibleKeys
          : [];
        const preservedKeySet = new Set(preservedKeys);
        const previousLabelThetaByKey = previousTaxonomyState
          && previousTaxonomyState.tree === tree
          && previousTaxonomyState.viewMode === viewMode
          && previousTaxonomyState.order === order
          ? new Map((previousTaxonomyState.labelThetas ?? []).map((entry) => [entry.key, entry.theta]))
          : new Map<string, number>();
        const connectorArcs: CircularOverlayArc[] = [];
        for (let rankIndex = 0; rankIndex < visibleRanks.length; rankIndex += 1) {
          const rank = visibleRanks[rankIndex];
          const rankDisplayMode = taxonomyRankDisplayModeForRank(rank);
          const rankIsLabelOnlyStrand = rankDisplayMode === "label-only";
          const orderedBlockEntries = circularTaxonomyBlockPriority?.[rank] ?? [];
          const ringWidthPx = metrics.ringWidthsPx[rankIndex];
          const ringInnerPx = ringCursorOuterPx;
          ringCursorOuterPx += ringWidthPx;
          const lineRadiusPx = ringInnerPx + (ringWidthPx * 0.5);
          const lineRadius = lineRadiusPx / camera.scale;
          const ringOuterPx = ringInnerPx + ringWidthPx;
          const ringFullyVisible = ringOuterPx <= (fullyVisibleRadiusPx - 24);
          const useScreenSpaceRibbonGeometry = !ringFullyVisible
            && lineRadiusPx >= CIRCULAR_TAXONOMY_SCREEN_SPACE_RIBBON_MIN_RADIUS_PX;
          const ringVisibilityMarginPx = circularTaxonomyVisibilityMarginPx + (ringWidthPx * 0.5) + 2;
          let ringUsesBandVisibilityFallback = false;
          let ringVisibleSpans = ringFullyVisible || useScreenSpaceRibbonGeometry
            ? []
            : computeVisibleCircularAngleSpans(
              centerPoint.x,
              centerPoint.y,
              lineRadiusPx,
              renderSize.width,
              renderSize.height,
              ringVisibilityMarginPx,
            );
          if (!ringFullyVisible && !useScreenSpaceRibbonGeometry && ringVisibleSpans.length === 0) {
            ringUsesBandVisibilityFallback = true;
            ringVisibleSpans = computeVisibleCircularBandSpans(
              centerPoint.x,
              centerPoint.y,
              ringInnerPx,
              ringOuterPx,
              renderSize.width,
              renderSize.height,
              circularTaxonomyVisibilityMarginPx,
            );
          }
          const occupiedIntervalsForRank: Array<{ start: number; end: number }> = [];
          for (let blockIndex = 0; blockIndex < orderedBlockEntries.length; blockIndex += 1) {
            const blockEntry = orderedBlockEntries[blockIndex];
            const block = blockEntry.block;
            const blockKey = blockEntry.key;
            const isPreservedLabel = preservedKeySet.has(blockKey);
            const blockSegments = block.segments && block.segments.length > 0
              ? block.segments
              : [{ firstNode: block.firstNode, lastNode: block.lastNode, startIndex: 0, endIndex: 0 }];
            if (visibleLeafRanges.length > 0 && !taxonomyBlockIntersectsVisibleLeafRanges(blockSegments, visibleLeafRanges, tree.leafCount)) {
              pushTaxonomyCandidateDebug({
                rank,
                label: block.label,
                accepted: false,
                reason: "outside-visible-ranges",
              });
              continue;
            }
            const totalTipCount = blockEntry.totalTipCount;
            const segmentVisibleDrawSpans = blockSegments.map((segment) => {
              const { startTheta, endTheta } = thetaSpanForTaxonomyRange(segment.startIndex, segment.endIndex);
              let renderedStartTheta = startTheta + rotationAngle;
              let renderedEndTheta = endTheta + rotationAngle;
              if (renderedEndTheta < renderedStartTheta) {
                renderedEndTheta += Math.PI * 2;
              }
              if (ringFullyVisible) {
                return {
                  segmentStartTheta: renderedStartTheta,
                  segmentEndTheta: renderedEndTheta,
                  visibleDrawSpans: [{
                    start: renderedStartTheta,
                    end: renderedEndTheta,
                    debugSuffix: `${segment.startIndex}:${segment.endIndex}:full`,
                    screenPolygonPoints: undefined,
                  }],
                };
              }
              if (useScreenSpaceRibbonGeometry) {
                return {
                  segmentStartTheta: renderedStartTheta,
                  segmentEndTheta: renderedEndTheta,
                  visibleDrawSpans: sampleVisibleScreenSpaceCircularRibbonRuns(
                    centerPoint.x,
                    centerPoint.y,
                    ringInnerPx,
                    ringOuterPx,
                    renderedStartTheta,
                    renderedEndTheta,
                    renderSize.width,
                    renderSize.height,
                    circularTaxonomyScreenSampleMarginPx,
                  ).map((visibleRun, visibleIndex) => ({
                    start: visibleRun.startTheta,
                    end: visibleRun.endTheta,
                    debugSuffix: `${segment.startIndex}:${segment.endIndex}:screen-${visibleIndex}`,
                    screenPolygonPoints: visibleRun.screenPolygonPoints,
                  })),
                };
              }
              const renderedWrappedStart = wrapPositive(renderedStartTheta);
              const renderedWrappedEnd = wrapPositive(renderedEndTheta);
              return {
                segmentStartTheta: renderedWrappedStart,
                segmentEndTheta: renderedWrappedEnd,
                visibleDrawSpans: visibleTaxonomyLabelSpans(renderedWrappedStart, renderedWrappedEnd, ringVisibleSpans)
                  .slice()
                  .sort((left, right) => left.start - right.start)
                  .map((span, visibleIndex) => ({
                    start: span.start,
                    end: span.end,
                    debugSuffix: `${segment.startIndex}:${segment.endIndex}:visible-${visibleIndex}`,
                    screenPolygonPoints: undefined,
                  })),
              };
            });
            for (let segmentIndex = 0; segmentIndex < blockSegments.length; segmentIndex += 1) {
              const blockSegment = blockSegments[segmentIndex];
              const segmentDrawSpans = segmentVisibleDrawSpans[segmentIndex];
              const visibleDrawSpans = segmentDrawSpans?.visibleDrawSpans ?? [];
              const segmentStartTheta = segmentDrawSpans?.segmentStartTheta ?? 0;
              const segmentEndTheta = segmentDrawSpans?.segmentEndTheta ?? 0;
              const taxonomyArcMetadata: CircularTaxonomyArcMetadata = {
                rank,
                label: block.label,
                taxId: block.taxId ?? null,
                firstNode: blockSegment.firstNode,
                lastNode: blockSegment.lastNode,
                taxonomyTipCount: totalTipCount,
                startIndex: blockSegment.startIndex,
                endIndex: blockSegment.endIndex,
              };
              for (let visibleSpanIndex = 0; visibleSpanIndex < visibleDrawSpans.length; visibleSpanIndex += 1) {
                const visibleDrawSpan = visibleDrawSpans[visibleSpanIndex];
                const candidateSpanTheta = visibleDrawSpan.end >= visibleDrawSpan.start
                  ? visibleDrawSpan.end - visibleDrawSpan.start
                  : (visibleDrawSpan.end + (Math.PI * 2)) - visibleDrawSpan.start;
                const candidateArcLengthPx = candidateSpanTheta * lineRadiusPx;
                if (candidateArcLengthPx < 0.8) {
                  continue;
                }
                const angularGapPx = 0;
                const gapTheta = Math.min(
                  ((angularGapPx / Math.max(lineRadiusPx, 1e-6)) * 0.5),
                  Math.max(0, candidateSpanTheta * 0.26),
                );
                const spanStartsAtSegmentBoundary = wrappedAnglesEqual(visibleDrawSpan.start, segmentStartTheta);
                const spanEndsAtSegmentBoundary = wrappedAnglesEqual(visibleDrawSpan.end, segmentEndTheta);
                // Adjacent fills for a single ribbon can show a hairline seam when visibility clipping splits them
                // at a shared boundary. Overlap only those clipped edges; preserve true taxon boundaries.
                const clippedEdgeOverlapPx = Math.min(0.9, Math.max(0.35, ringWidthPx * 0.016));
                const clippedEdgeOverlapTheta = Math.min(
                  clippedEdgeOverlapPx / Math.max(lineRadiusPx, 1e-6),
                  Math.max(0, candidateSpanTheta * 0.18),
                );
                const insetRenderedStart = visibleDrawSpan.start + (spanStartsAtSegmentBoundary ? gapTheta : -clippedEdgeOverlapTheta);
                const insetRenderedEnd = visibleDrawSpan.end - (spanEndsAtSegmentBoundary ? gapTheta : -clippedEdgeOverlapTheta);
                if (insetRenderedEnd <= insetRenderedStart) {
                  continue;
                }
                const lineWidthPx = taxonomyOverlayStyle === "strands" || rankIsLabelOnlyStrand
                  ? Math.max(1.25, Math.min(3.2, ringWidthPx * 0.14))
                  : ringWidthPx * 0.92;
                const innerRadiusPx = lineRadiusPx - (lineWidthPx * 0.5);
                const outerRadiusPx = lineRadiusPx + (lineWidthPx * 0.5);
                const screenPolygonPoints = visibleDrawSpan.screenPolygonPoints ?? (
                  ringUsesBandVisibilityFallback
                    ? sampleVisibleCircularBandPolygonPoints(
                      centerPoint.x,
                      centerPoint.y,
                      innerRadiusPx,
                      outerRadiusPx,
                      insetRenderedStart,
                      insetRenderedEnd,
                      renderSize.width,
                      renderSize.height,
                      2,
                    )
                    : []
                );
                if (includeDetailedTaxonomyDebug) {
                  arcKeys.push(`${rank}:${block.label}:${visibleDrawSpan.debugSuffix}`);
                }
                if (taxonomyOverlayStyle === "strands" || rankIsLabelOnlyStrand) {
                  connectorArcs.push({
                    mode: "stroke",
                    lineRadiusPx,
                    lineWidthPx,
                    startTheta: insetRenderedStart - rotationAngle,
                    endTheta: insetRenderedEnd - rotationAngle,
                    color: rankIsLabelOnlyStrand ? "#111827" : block.color,
                    key: blockKey,
                    taxonomy: taxonomyArcMetadata,
                  });
                  pushScenePath(
                    () => svgArcPath(centerPoint.x, centerPoint.y, lineRadiusPx, insetRenderedStart, insetRenderedEnd),
                    rankIsLabelOnlyStrand ? "#111827" : block.color,
                    lineWidthPx,
                    undefined,
                    CIRCULAR_TAXONOMY_OVERLAY_ALPHA,
                  );
                  if (rankIsLabelOnlyStrand) {
                    const dividerHalfWidthPx = Math.max(3, Math.min(8, ringWidthPx * 0.34));
                    const dividerInnerRadiusPx = Math.max(0, lineRadiusPx - dividerHalfWidthPx);
                    const dividerOuterRadiusPx = lineRadiusPx + dividerHalfWidthPx;
                    const dividerLineWidthPx = Math.max(1, Math.min(2.2, lineWidthPx));
                    const pushDivider = (theta: number): void => {
                      connectorArcs.push({
                        mode: "divider",
                        theta: theta - rotationAngle,
                        innerRadiusPx: dividerInnerRadiusPx,
                        outerRadiusPx: dividerOuterRadiusPx,
                        lineWidthPx: dividerLineWidthPx,
                        color: "#111827",
                      });
                      pushSceneLine(
                        centerPoint.x + (Math.cos(theta) * dividerInnerRadiusPx),
                        centerPoint.y + (Math.sin(theta) * dividerInnerRadiusPx),
                        centerPoint.x + (Math.cos(theta) * dividerOuterRadiusPx),
                        centerPoint.y + (Math.sin(theta) * dividerOuterRadiusPx),
                        "#111827",
                        dividerLineWidthPx,
                        1,
                      );
                    };
                    if (spanStartsAtSegmentBoundary) {
                      pushDivider(insetRenderedStart);
                    }
                    if (spanEndsAtSegmentBoundary) {
                      pushDivider(insetRenderedEnd);
                    }
                  }
                } else {
                  connectorArcs.push({
                    mode: "ribbon",
                    lineRadiusPx,
                    lineWidthPx,
                    startTheta: insetRenderedStart - rotationAngle,
                    endTheta: insetRenderedEnd - rotationAngle,
                    innerRadiusPx,
                    outerRadiusPx,
                    color: block.color,
                    screenPolygonPoints: screenPolygonPoints.length >= 3 ? screenPolygonPoints : undefined,
                    taxonomy: taxonomyArcMetadata,
                  });
                  pushScenePath(
                    () => screenPolygonPoints.length >= 3
                      ? svgPolygonPath(screenPolygonPoints)
                      : svgCircularRibbonPath(
                        centerPoint.x,
                        centerPoint.y,
                        innerRadiusPx,
                        outerRadiusPx,
                        insetRenderedStart,
                        insetRenderedEnd,
                      ),
                    undefined,
                    undefined,
                    block.color,
                    CIRCULAR_TAXONOMY_OVERLAY_ALPHA,
                  );
                }
              }
            }
            let bestLabelCandidate: {
              theta: number;
              visibleStart: number;
              visibleEnd: number;
              arcLengthPx: number;
              fitArcLengthPx: number;
              spanTheta: number;
            } | null = null;
            const primaryLabelSegment = {
              firstNode: orderedLeaves[block.labelStartIndex ?? block.startIndex ?? blockSegments[0].startIndex],
              lastNode: orderedLeaves[((block.labelEndIndex ?? block.endIndex ?? blockSegments[0].endIndex) - 1 + orderedLeaves.length) % orderedLeaves.length],
              startIndex: block.labelStartIndex ?? block.startIndex ?? blockSegments[0].startIndex,
              endIndex: block.labelEndIndex ?? block.endIndex ?? blockSegments[0].endIndex,
            };
            const taxonomyTaxId = block.taxId ?? null;
            const labelSegments = [primaryLabelSegment];
            const centeredArcLengthPx = (
              anchorTheta: number,
              rawStartTheta: number,
              rawEndTheta: number,
            ): number => {
              const tau = Math.PI * 2;
              let start = rawStartTheta;
              let end = rawEndTheta;
              while (end <= start) {
                end += tau;
              }
              let anchor = anchorTheta;
              while (anchor < start) {
                anchor += tau;
              }
              while (anchor > end) {
                anchor -= tau;
              }
              if (anchor < start || anchor > end) {
                return 0;
              }
              return Math.max(0, 2 * Math.min(anchor - start, end - anchor) * lineRadiusPx);
            };
            for (let segmentIndex = 0; segmentIndex < labelSegments.length; segmentIndex += 1) {
              const segment = labelSegments[segmentIndex];
              const { startTheta, endTheta } = thetaSpanForTaxonomyRange(segment.startIndex, segment.endIndex);
              let renderStartTheta = startTheta;
              let renderEndTheta = endTheta;
              if (renderEndTheta < renderStartTheta) {
                renderEndTheta += Math.PI * 2;
              }
              const totalRenderedSpan = renderEndTheta - renderStartTheta;
              const totalArcLengthPx = totalRenderedSpan * lineRadiusPx;
              const totalMidTheta = renderStartTheta + (totalRenderedSpan * 0.5);
              const renderedWrappedStart = wrapPositive(renderStartTheta + rotationAngle);
              const renderedWrappedEnd = wrapPositive(renderEndTheta + rotationAngle);
              const fullMidVisible = ringFullyVisible || (() => {
                const fullLabelPoint = worldToScreenCircular(
                  camera,
                  Math.cos(totalMidTheta) * lineRadius,
                  Math.sin(totalMidTheta) * lineRadius,
                );
                return isScreenPointVisible(fullLabelPoint.x, fullLabelPoint.y, renderSize.width, renderSize.height, circularTaxonomyLabelAnchorMarginPx);
              })();
              if (fullMidVisible) {
                const candidateArcLengthPx = totalRenderedSpan * lineRadiusPx;
                if (!bestLabelCandidate || candidateArcLengthPx > bestLabelCandidate.arcLengthPx) {
                  bestLabelCandidate = {
                    theta: totalMidTheta,
                    visibleStart: renderedWrappedStart,
                    visibleEnd: renderedWrappedEnd >= renderedWrappedStart ? renderedWrappedEnd : renderedWrappedEnd + (Math.PI * 2),
                    arcLengthPx: candidateArcLengthPx,
                    fitArcLengthPx: totalArcLengthPx,
                    spanTheta: totalRenderedSpan,
                  };
                }
              } else {
                const previousTheta = previousLabelThetaByKey.get(blockKey);
                if (typeof previousTheta === "number") {
                  const previousRenderedTheta = wrapPositive(previousTheta);
                  if (wrappedAngleWithinInterval(previousRenderedTheta, renderedWrappedStart, renderedWrappedEnd)) {
                    const previousUnrotatedTheta = previousRenderedTheta - rotationAngle;
                    const previousPoint = worldToScreenCircular(
                      camera,
                      Math.cos(previousUnrotatedTheta) * lineRadius,
                      Math.sin(previousUnrotatedTheta) * lineRadius,
                    );
                    if (isScreenPointVisible(previousPoint.x, previousPoint.y, renderSize.width, renderSize.height, circularTaxonomyLabelAnchorMarginPx)) {
                      const candidateArcLengthPx = centeredArcLengthPx(
                        previousRenderedTheta,
                        renderedWrappedStart,
                        renderedWrappedEnd,
                      );
                      if (!bestLabelCandidate || candidateArcLengthPx > bestLabelCandidate.arcLengthPx) {
                        bestLabelCandidate = {
                          theta: previousUnrotatedTheta,
                          visibleStart: renderedWrappedStart,
                          visibleEnd: renderedWrappedEnd >= renderedWrappedStart ? renderedWrappedEnd : renderedWrappedEnd + (Math.PI * 2),
                          arcLengthPx: candidateArcLengthPx,
                          fitArcLengthPx: candidateArcLengthPx,
                          spanTheta: candidateArcLengthPx / Math.max(lineRadiusPx, 1e-6),
                        };
                      }
                    }
                  }
                }
                if (!rankIsLabelOnlyStrand && wrappedAngleWithinInterval(viewportCenterRenderedTheta, renderedWrappedStart, renderedWrappedEnd)) {
                  const viewportAnchoredPoint = worldToScreenCircular(
                    camera,
                    Math.cos(viewportCenterRenderedTheta - rotationAngle) * lineRadius,
                    Math.sin(viewportCenterRenderedTheta - rotationAngle) * lineRadius,
                  );
                  if (isScreenPointVisible(viewportAnchoredPoint.x, viewportAnchoredPoint.y, renderSize.width, renderSize.height, circularTaxonomyLabelAnchorMarginPx)) {
                    const candidateArcLengthPx = centeredArcLengthPx(
                      viewportCenterRenderedTheta,
                      renderedWrappedStart,
                      renderedWrappedEnd,
                    );
                    if (!bestLabelCandidate || candidateArcLengthPx > bestLabelCandidate.arcLengthPx) {
                      bestLabelCandidate = {
                        theta: viewportCenterRenderedTheta - rotationAngle,
                        visibleStart: renderedWrappedStart,
                        visibleEnd: renderedWrappedEnd >= renderedWrappedStart ? renderedWrappedEnd : renderedWrappedEnd + (Math.PI * 2),
                        arcLengthPx: candidateArcLengthPx,
                        fitArcLengthPx: candidateArcLengthPx,
                        spanTheta: candidateArcLengthPx / Math.max(lineRadiusPx, 1e-6),
                      };
                    }
                  }
                }
                const screenVisibleSpans = useScreenSpaceRibbonGeometry
                  ? sampleVisibleScreenSpaceCircularRibbonRuns(
                    centerPoint.x,
                    centerPoint.y,
                    ringInnerPx,
                    ringOuterPx,
                    renderStartTheta + rotationAngle,
                    renderEndTheta + rotationAngle,
                    renderSize.width,
                    renderSize.height,
                    circularTaxonomyScreenSampleMarginPx,
                  ).map((visibleRun) => ({
                    start: visibleRun.startTheta,
                    end: visibleRun.endTheta,
                  }))
                  : [];
                const lockCladeLabelToCenter = lockTaxonomyLabelsToClade && ringFullyVisible;
                const visibleSpans = lockCladeLabelToCenter
                  ? []
                  : rankIsLabelOnlyStrand
                    ? []
                  : (
                    useScreenSpaceRibbonGeometry
                      ? screenVisibleSpans
                      : visibleTaxonomyLabelSpans(renderedWrappedStart, renderedWrappedEnd, ringVisibleSpans)
                  );
                const fallbackViewportSpan = !rankIsLabelOnlyStrand && !lockCladeLabelToCenter && !useScreenSpaceRibbonGeometry && blockSegments.length === 1
                  && wrappedAngleWithinInterval(viewportCenterRenderedTheta, renderedWrappedStart, renderedWrappedEnd)
                  ? ringVisibleSpans.reduce<{ start: number; end: number } | null>((best, span) => {
                    if (!best || (span.end - span.start) > (best.end - best.start)) {
                      return span;
                    }
                    return best;
                  }, null)
                  : null;
                const visibleCandidates = visibleSpans.length > 0 ? visibleSpans : (fallbackViewportSpan ? [fallbackViewportSpan] : []);
                for (let visibleIndex = 0; visibleIndex < visibleCandidates.length; visibleIndex += 1) {
                  const candidateStart = visibleCandidates[visibleIndex].start;
                  const candidateEnd = visibleCandidates[visibleIndex].end;
                  const candidateSpan = candidateEnd >= candidateStart
                    ? candidateEnd - candidateStart
                    : (candidateEnd + (Math.PI * 2)) - candidateStart;
                  const renderedMidTheta = candidateStart + (candidateSpan * 0.5);
                  const candidatePoint = worldToScreenCircular(
                    camera,
                    Math.cos(renderedMidTheta - rotationAngle) * lineRadius,
                    Math.sin(renderedMidTheta - rotationAngle) * lineRadius,
                  );
                  if (!isScreenPointVisible(candidatePoint.x, candidatePoint.y, renderSize.width, renderSize.height, circularTaxonomyLabelAnchorMarginPx)) {
                    continue;
                  }
                  const candidateArcLengthPx = candidateSpan * lineRadiusPx;
                  if (!bestLabelCandidate || candidateArcLengthPx > bestLabelCandidate.arcLengthPx) {
                    bestLabelCandidate = {
                      theta: renderedMidTheta - rotationAngle,
                      visibleStart: candidateStart,
                      visibleEnd: candidateEnd >= candidateStart ? candidateEnd : candidateEnd + (Math.PI * 2),
                      arcLengthPx: candidateArcLengthPx,
                      fitArcLengthPx: candidateArcLengthPx,
                      spanTheta: candidateSpan,
                    };
                  }
                }
              }
            }
            const minimumArcLengthPx = rank === "genus"
              ? (isPreservedLabel ? 2.5 : 4.5)
              : rank === "family"
                ? (isPreservedLabel ? 4 : 7)
                : (isPreservedLabel ? 8 : 16);
            if (!bestLabelCandidate || bestLabelCandidate.arcLengthPx < minimumArcLengthPx) {
              pushTaxonomyCandidateDebug({
                rank,
                label: block.label,
                accepted: false,
                reason: "arc-too-short",
                arcLengthPx: bestLabelCandidate?.arcLengthPx ?? 0,
              });
              continue;
            }
            const minFontSize = rank === "genus"
              ? (isPreservedLabel ? 4.5 : 5.2)
              : rank === "family"
                ? (isPreservedLabel ? 5.5 : 6.2)
                : (isPreservedLabel ? 6 : 7.5);
            const scaledMinFontSize = Math.max(
              3.5,
              minFontSize * Math.min(1, taxonomyBandThicknessScale),
            );
            const paddingFraction = 0.12;
            const normalizedMetrics = measureNormalizedLabelMetrics(ctx, block.label, labelFontFamilies.taxonomy);
            let textMetrics = ctx.measureText(block.label);
            const widthAtOnePx = normalizedMetrics.widthAtOnePx;
            const heightAtOnePx = normalizedMetrics.heightAtOnePx;
            const availableArcPx = Math.max(0, bestLabelCandidate.fitArcLengthPx * (1 - paddingFraction));
            const availableRadialPx = Math.max(0, ringWidthPx * (1 - paddingFraction));
            const curvatureCoeff = (widthAtOnePx * widthAtOnePx) / Math.max(8 * lineRadiusPx, 1e-6);
            const radialFontLimit = curvatureCoeff > 1e-9
              ? Math.max(0, (-heightAtOnePx + Math.sqrt(Math.max(
                0,
                (heightAtOnePx * heightAtOnePx) + (4 * curvatureCoeff * availableRadialPx),
              ))) / (2 * curvatureCoeff))
              : (availableRadialPx / heightAtOnePx);
            const fitFontSize = Math.min(30 * taxonomyLabelFitScale, Math.min(
              availableArcPx / widthAtOnePx,
              radialFontLimit,
            ) * 0.94);
            if (!Number.isFinite(fitFontSize) || fitFontSize < scaledMinFontSize) {
              pushTaxonomyCandidateDebug({
                rank,
                label: block.label,
                accepted: false,
                reason: "font-too-small",
                arcLengthPx: bestLabelCandidate.arcLengthPx,
                fitFontSize,
              });
              continue;
            }
            const overflowTolerancePx = isPreservedLabel ? 1.6 : 1.1;
            const labelPoint = worldToScreenCircular(
              camera,
              Math.cos(bestLabelCandidate.theta) * lineRadius,
              Math.sin(bestLabelCandidate.theta) * lineRadius,
            );
            const renderedTheta = bestLabelCandidate.theta + rotationAngle;
            const tangentDegrees = (renderedTheta * 180 / Math.PI) + 90;
            const onRightSide = Math.cos(renderedTheta) >= 0;
            const rotation = normalizeRotation(onRightSide ? tangentDegrees : tangentDegrees + 180);
            const rotationRadians = rotation * Math.PI / 180;
            let low = scaledMinFontSize;
            let high = Math.min(30 * taxonomyLabelFitScale, fitFontSize);
            let bestFitFontSize = scaledMinFontSize;
            let bestTextWidthPx = 0;
            let bestRadialHeightPx = 0;
            let bestCurvaturePenaltyPx = 0;
            for (let iteration = 0; iteration < 12; iteration += 1) {
              const candidateFontSize = iteration === 0 ? low : ((low + high) * 0.5);
              ctx.font = `${candidateFontSize}px ${labelFontFamilies.taxonomy}`;
              const candidateMetrics = ctx.measureText(block.label);
              const candidateAscentPx = candidateMetrics.actualBoundingBoxAscent || (candidateFontSize * 0.72);
              const candidateDescentPx = candidateMetrics.actualBoundingBoxDescent || (candidateFontSize * 0.28);
              const candidateRadialHeightPx = candidateAscentPx + candidateDescentPx;
              const candidateHalfWidthPx = candidateMetrics.width * 0.5;
              const candidateCurvaturePenaltyPx = candidateHalfWidthPx < lineRadiusPx
                ? lineRadiusPx - Math.sqrt(Math.max(0, (lineRadiusPx * lineRadiusPx) - (candidateHalfWidthPx * candidateHalfWidthPx)))
                : availableRadialPx + 1;
              const fits = candidateMetrics.width <= (availableArcPx + 0.5)
                && (candidateRadialHeightPx + candidateCurvaturePenaltyPx) <= (availableRadialPx + overflowTolerancePx)
                ;
              if (fits) {
                bestFitFontSize = candidateFontSize;
                bestTextWidthPx = candidateMetrics.width;
                bestRadialHeightPx = candidateRadialHeightPx;
                bestCurvaturePenaltyPx = candidateCurvaturePenaltyPx;
                low = candidateFontSize;
              } else {
                high = candidateFontSize;
              }
            }
            if (!(bestFitFontSize >= scaledMinFontSize)) {
              pushTaxonomyCandidateDebug({
                rank,
                label: block.label,
                accepted: false,
                reason: "text-overflow",
                arcLengthPx: bestLabelCandidate.arcLengthPx,
                fontSize: fitFontSize,
                textWidth: 0,
                availableArcPx,
                radialHeightPx: 0,
                curvaturePenaltyPx: 0,
                availableRadialPx,
              });
              continue;
            }
            const finalFontSize = Math.max(3.5, Math.max(scaledMinFontSize, bestFitFontSize * 0.92) * taxonomyLabelSizeScale);
            ctx.font = `${finalFontSize}px ${labelFontFamilies.taxonomy}`;
            textMetrics = ctx.measureText(block.label);
            const ascent = textMetrics.actualBoundingBoxAscent || (finalFontSize * 0.72);
            const descent = textMetrics.actualBoundingBoxDescent || (finalFontSize * 0.28);
            const labelIntersectsViewport = centeredRotatedLabelIntersectsViewport(
              labelPoint.x,
              labelPoint.y,
              textMetrics.width,
              ascent + descent,
              rotationRadians,
              renderSize.width,
              renderSize.height,
              circularTaxonomyLabelViewportMarginPx,
            );
            if (!labelIntersectsViewport) {
              pushTaxonomyCandidateDebug({
                rank,
                label: block.label,
                accepted: false,
                reason: "offscreen",
                arcLengthPx: bestLabelCandidate.arcLengthPx,
                fontSize: finalFontSize,
                x: labelPoint.x,
                y: labelPoint.y,
              });
              continue;
            }
            const searchMatchRange = findSearchMatchRange(block.label, searchQuery);
            const searchHighlightColor = searchMatchRange
              ? (activeSearchTaxonomyKey === blockKey ? "#c2410c" : "#2563eb")
              : undefined;
            const labelRecord: ScreenLabel = {
              x: labelPoint.x,
              y: labelPoint.y,
              text: block.label,
              key: blockKey,
              rank,
              theta: wrapPositive(renderedTheta),
              alpha: 1,
              fontSize: finalFontSize,
              bandSizePx: ringWidthPx,
              rotation: rotationRadians,
              phylopicNormalX: Math.cos(renderedTheta),
              phylopicNormalY: Math.sin(renderedTheta),
              align: "center",
              color: rankIsLabelOnlyStrand ? "#111827" : taxonomyOverlayTextColor(block.color, taxonomyOverlayStyle),
              taxonomyDisplayMode: rankDisplayMode,
              searchHighlightColor,
              searchMatchRange,
              taxId: taxonomyTaxId,
              firstNode: primaryLabelSegment.firstNode,
              lastNode: primaryLabelSegment.lastNode,
              taxonomyTipCount: totalTipCount,
              taxonomyStartIndex: primaryLabelSegment.startIndex,
              taxonomyEndIndex: primaryLabelSegment.endIndex,
              // Circular taxonomy label anchors already sit on the ring midpoint and the draw pass uses
              // textBaseline="middle", so any extra baseline compensation here creates direction-dependent
              // radial drift once the label is rotated around the circle.
              offsetY: 0,
              clipArc: {
                innerRadiusPx: ringInnerPx,
                outerRadiusPx: ringInnerPx + ringWidthPx,
                startTheta: bestLabelCandidate.visibleStart - rotationAngle,
                endTheta: bestLabelCandidate.visibleEnd - rotationAngle,
                // Screen-space ribbons already linearize the visible band; canvas arc clipping does not match
                // that geometry closely enough at deep zoom, so skip clipping there and rely on placement only.
                skipClip: useScreenSpaceRibbonGeometry,
              },
            };
            if (!isPreservedLabel && !canPlaceTaxonomyArcLabel(
              occupiedIntervalsForRank,
              wrapPositive(renderedTheta),
              lineRadiusPx,
              textMetrics.width,
              bestLabelCandidate.spanTheta,
            )) {
              pushTaxonomyCandidateDebug({
                rank,
                label: block.label,
                accepted: false,
                reason: "label-collision",
                arcLengthPx: bestLabelCandidate.arcLengthPx,
                fontSize: finalFontSize,
              });
              continue;
            }
            placedLabels.push(labelRecord);
            for (const interval of splitWrappedAngularInterval(
              wrapPositive(renderedTheta) - ((textMetrics.width / Math.max(lineRadiusPx, 1e-6)) * 0.5) - Math.max(0, bestLabelCandidate.spanTheta * 0.06),
              wrapPositive(renderedTheta) + ((textMetrics.width / Math.max(lineRadiusPx, 1e-6)) * 0.5) + Math.max(0, bestLabelCandidate.spanTheta * 0.06),
            )) {
              occupiedIntervalsForRank.push(interval);
            }
            placedKeys.push(blockKey);
            pushTaxonomyCandidateDebug({
              rank,
              label: block.label,
              accepted: true,
              arcLengthPx: bestLabelCandidate.arcLengthPx,
              fontSize: finalFontSize,
              fitFontSize: bestFitFontSize,
              textWidth: bestTextWidthPx,
              availableArcPx,
              radialHeightPx: bestRadialHeightPx,
              curvaturePenaltyPx: bestCurvaturePenaltyPx,
              availableRadialPx,
            });
          }
          ringCursorOuterPx += metrics.ringGapPx;
        }
        const allTaxonomyLabels = placedLabels;
        circularGenusLabels = allTaxonomyLabels;
        circularGenusArcs = connectorArcs;
        renderDebug.circular = {
          branchRenderMode: circularBranchRenderMode,
          visibleCircleFraction,
          cueVisible: tipLabelCueVisible,
          microVisible: microTipLabelsVisible,
          tipVisible: tipLabelsVisible,
          tipBandFontSize,
          tipBandWidthPx: globalTipLabelSpacePx,
          tipBandAnchorRadiusPx: tipBandAnchorRadius * camera.scale,
          visibleTipLabelCount: circularVisibleTipLabels.length,
          genusGapPx: null,
          genusLineRadiusPx: circularOverlayLineRadiusPx(connectorArcs[0]),
          visibleLeafRanges: visibleLeafRanges.map((range) => [range.startIndex, range.endIndex]),
          taxonomyVisibleRanks: visibleRanks,
          taxonomyBandWidthsPx: metrics.ringWidthsPx,
          taxonomyArcCount: connectorArcs.length,
          taxonomyPlacedLabelCount: allTaxonomyLabels.length,
          taxonomyBlockCounts: Object.fromEntries(
            TAXONOMY_RANKS.map((rank) => [rank, renderedTaxonomyBlocks[rank]?.length ?? 0]),
          ),
          taxonomyOverlayAlpha: CIRCULAR_TAXONOMY_OVERLAY_ALPHA,
          taxonomyTipBandOuterRadiusPx: tipBandOuterRadiusPx,
          taxonomyFirstRingInnerRadiusPx: circularOverlayInnerRadiusPx(connectorArcs[0]),
          ...(includeDetailedTaxonomyDebug
            ? {
              taxonomyArcKeys: arcKeys,
              taxonomyArcDebug: connectorArcs.map((arc, index) => ({
                key: arcKeys[index] ?? null,
                mode: arc.mode,
                startTheta: arc.mode === "divider" ? arc.theta : arc.startTheta,
                endTheta: arc.mode === "divider" ? arc.theta : arc.endTheta,
                lineWidthPx: circularOverlayLineWidthPx(arc),
                lineRadiusPx: circularOverlayLineRadiusPx(arc),
                innerRadiusPx: circularOverlayInnerRadiusPx(arc),
                outerRadiusPx: circularOverlayOuterRadiusPx(arc),
                screenSampleX: "screenPolygonPoints" in arc && arc.screenPolygonPoints && arc.screenPolygonPoints.length > 0
                  ? arc.screenPolygonPoints.reduce((total: number, point: { x: number; y: number }) => total + point.x, 0) / arc.screenPolygonPoints.length
                  : null,
                screenSampleY: "screenPolygonPoints" in arc && arc.screenPolygonPoints && arc.screenPolygonPoints.length > 0
                  ? arc.screenPolygonPoints.reduce((total: number, point: { x: number; y: number }) => total + point.y, 0) / arc.screenPolygonPoints.length
                  : null,
                spanTheta: arc.mode === "divider" ? 0 : arc.endTheta - arc.startTheta,
                spanPx: arc.mode === "divider" ? 0 : (arc.endTheta - arc.startTheta) * (circularOverlayLineRadiusPx(arc) ?? 0),
              })),
              taxonomyLabelKeys: placedKeys,
              taxonomyPlacedLabels: allTaxonomyLabels.map((label) => ({
                key: label.key ?? null,
                rank: label.rank ?? null,
                theta: label.theta ?? null,
                text: label.text,
                x: label.x,
                y: label.y,
                fontSize: label.fontSize ?? 0,
                offsetY: label.offsetY ?? 0,
                rotation: label.rotation ?? 0,
                color: label.color ?? null,
                searchHighlightColor: label.searchHighlightColor ?? null,
                clipArc: label.clipArc ?? null,
              })),
              taxonomyCandidateDebug,
            }
            : {}),
        };
        genusLabelHistoryRef.current = {
          tree,
          viewMode,
          order,
          zoom: camera.scale,
          visibleCenters: [],
          peakZoom: camera.scale,
          peakVisibleCenters: [],
        };
        taxonomyLabelHistoryRef.current = {
          tree,
          viewMode,
          order,
          zoom: camera.scale,
          visibleKeys: placedKeys,
          labelThetas: mergeTaxonomyLabelThetas(allTaxonomyLabels),
          peakZoom: previousTaxonomyState && previousTaxonomyState.tree === tree && previousTaxonomyState.viewMode === viewMode && previousTaxonomyState.order === order
            ? Math.max(previousTaxonomyState.peakZoom, camera.scale)
            : camera.scale,
          peakVisibleKeys: previousTaxonomyState && previousTaxonomyState.tree === tree && previousTaxonomyState.viewMode === viewMode && previousTaxonomyState.order === order && camera.scale > previousTaxonomyState.zoom + 1e-6
            ? Array.from(new Set([...previousTaxonomyState.peakVisibleKeys, ...placedKeys]))
            : placedKeys,
        };
        if (circularTaxonomyOverlayLayoutSignature) {
          circularTaxonomyOverlayLayoutCacheRef.current = {
            tree,
            order,
            signature: circularTaxonomyOverlayLayoutSignature,
            centerX: centerPoint.x,
            centerY: centerPoint.y,
            baseFontSize,
            arcs: connectorArcs,
            labels: allTaxonomyLabels,
            arcKeys,
            placedKeys,
            taxonomyCandidateDebug,
            taxonomyTipBandOuterRadiusPx: tipBandOuterRadiusPx,
            taxonomyFirstRingInnerRadiusPx: circularOverlayInnerRadiusPx(connectorArcs[0]),
          };
        }
        }
      } else if (!taxonomyEnabled && showGenusLabels) {
        const priorityBlocks = cache.genusBlocksPriority[order];
        const positionalBlocks = cache.genusBlocks[order];
        const previousGenusState = genusLabelHistoryRef.current;
        const preservedCenters = previousGenusState
          && previousGenusState.tree === tree
          && previousGenusState.viewMode === viewMode
          && previousGenusState.order === order
          && camera.scale > previousGenusState.zoom + 1e-6
          ? previousGenusState.peakVisibleCenters
          : [];
        const blockByCenter = new Map<number, GenusBlock>();
        for (let index = 0; index < priorityBlocks.length; index += 1) {
          blockByCenter.set(priorityBlocks[index].centerNode, priorityBlocks[index]);
        }
        const preservedBlocks = preservedCenters
          .map((centerNode) => blockByCenter.get(centerNode))
          .filter((block): block is GenusBlock => block !== undefined);
        const genusOrderByCenter = new Map<number, number>();
        for (let index = 0; index < positionalBlocks.length; index += 1) {
          genusOrderByCenter.set(positionalBlocks[index].centerNode, index);
        }
        const baseFontSize = scaleLabelFontSize("genus", Math.max(10, Math.min(18, Math.max(angularSpacingPx * 0.92, 10))));
        const tipLabelPressure = clamp01((angularSpacingPx - 4) / 4);
        const lineGapPx = Math.max(12, tipBandFontSize * 1.9);
        ctx.font = `${baseFontSize}px ${labelFontFamilies.genus}`;
        ctx.fillStyle = GENUS_COLOR;
        ctx.strokeStyle = GENUS_COLOR;
        ctx.lineWidth = 1.1;
        ctx.textBaseline = "middle";
        const maxGenusLabels = Math.max(
          18,
          Math.ceil((Math.PI * Math.min(renderSize.width, renderSize.height)) / 34),
        );
        const placedLabels: ScreenLabel[] = [];
        const connectorArcs: Array<
          { mode: "stroke"; lineRadiusPx: number; lineWidthPx: number; startTheta: number; endTheta: number; color: string }
        > = [];
        const placedCenters = new Set<number>();
        const tryPlaceBlock = (block: GenusBlock): void => {
          if (hiddenNodes[block.centerNode]) {
            return;
          }
          if (placedCenters.has(block.centerNode)) {
            return;
          }
          const startTheta = polarThetaFor(layout.center, block.firstNode);
          const endTheta = polarThetaFor(layout.center, block.lastNode);
          let renderStartTheta = startTheta;
          let renderEndTheta = endTheta;
          if (renderEndTheta < renderStartTheta) {
            renderEndTheta += Math.PI * 2;
          }
          const angularSpan = renderEndTheta - renderStartTheta;
          const midTheta = renderStartTheta + (angularSpan * 0.5);
          const lineRadius = tipBandAnchorRadius + ((globalTipLabelSpacePx + lineGapPx) / camera.scale);
          const preliminaryArcLengthPx = lineRadius * camera.scale * angularSpan;
          const fontGrowth = 0.018 - (0.007 * tipLabelPressure);
          const maxFontSize = 22 + (2 * tipLabelPressure);
          const fontSize = Math.max(baseFontSize, Math.min(maxFontSize, baseFontSize + (preliminaryArcLengthPx * fontGrowth)));
          const labelRadius = lineRadius + ((fontSize + 14) / camera.scale);
          const lineRadiusPx = lineRadius * camera.scale;
          const genusOrderIndex = genusOrderByCenter.get(block.centerNode) ?? 0;
          const isActiveGenus = block.centerNode === activeSearchGenusCenterNode;
          const matchRange = findSearchMatchRange(block.label, searchQuery);
          const arcColor = isActiveGenus ? "#c2410c" : GENUS_CONNECTOR_COLORS[genusOrderIndex % GENUS_CONNECTOR_COLORS.length];
          const arcVisible = arcIntersectsViewport(
            centerPoint.x,
            centerPoint.y,
            lineRadiusPx,
            renderStartTheta + rotationAngle,
            renderEndTheta + rotationAngle,
            renderSize.width,
            renderSize.height,
          );
          const pushArc = (): void => {
            connectorArcs.push({
              mode: "stroke",
              lineRadiusPx,
              lineWidthPx: 1.1,
              startTheta: renderStartTheta,
              endTheta: renderEndTheta,
              color: arcColor,
            });
            pushScenePath(() => svgArcPath(centerPoint.x, centerPoint.y, lineRadiusPx, renderStartTheta + rotationAngle, renderEndTheta + rotationAngle), arcColor, 1.1, undefined, CIRCULAR_TAXONOMY_OVERLAY_ALPHA);
          };
          if (arcVisible) {
            pushArc();
          }
          if (placedLabels.length >= maxGenusLabels) {
            if (arcVisible) {
              placedCenters.add(block.centerNode);
            }
            return;
          }
          const labelPoint = worldToScreenCircular(
            camera,
            Math.cos(midTheta) * labelRadius,
            Math.sin(midTheta) * labelRadius,
          );
          if (
            labelPoint.x < -160 || labelPoint.x > renderSize.width + 160 ||
            labelPoint.y < -160 || labelPoint.y > renderSize.height + 160
          ) {
            if (arcVisible) {
              placedCenters.add(block.centerNode);
            }
            return;
          }
          const deg = (midTheta + rotationAngle) * 180 / Math.PI;
          const onRightSide = Math.cos(midTheta + rotationAngle) >= 0;
          const rotation = normalizeRotation(onRightSide ? deg : deg + 180);
          if (!canPlaceLinearLabel(
            placedLabels,
            labelPoint.x,
            labelPoint.y,
            fontSize * 0.9,
            fontSize * 3.5,
          )) {
            if (arcVisible) {
              placedCenters.add(block.centerNode);
            }
            return;
          }
          placedCenters.add(block.centerNode);
              placedLabels.push({
                x: labelPoint.x,
                y: labelPoint.y,
                text: block.label,
                alpha: 1,
                fontSize,
                rotation: rotation * Math.PI / 180,
                align: onRightSide ? "left" : "right",
                color: matchRange ? (isActiveGenus ? "#c2410c" : "#2563eb") : undefined,
                offsetY: figureStyles.genus.offsetPx,
              });
        };
        for (let index = 0; index < preservedBlocks.length; index += 1) {
          tryPlaceBlock(preservedBlocks[index]);
          if (placedLabels.length >= maxGenusLabels) {
            break;
          }
        }
        for (let index = 0; index < priorityBlocks.length; index += 1) {
          tryPlaceBlock(priorityBlocks[index]);
          if (placedLabels.length >= maxGenusLabels) {
            break;
          }
        }
        if (placedLabels.length < maxGenusLabels) {
          for (let index = 0; index < positionalBlocks.length; index += 1) {
            tryPlaceBlock(positionalBlocks[index]);
            if (placedLabels.length >= maxGenusLabels) {
              break;
            }
          }
        }
        circularGenusLabels = placedLabels;
        circularGenusArcs = connectorArcs;
        circularGenusBaseFontSize = baseFontSize;
        renderDebug.circular = {
          branchRenderMode: circularBranchRenderMode,
          cueVisible: tipLabelCueVisible,
          microVisible: microTipLabelsVisible,
          tipVisible: tipLabelsVisible,
          tipBandFontSize,
          tipBandWidthPx: globalTipLabelSpacePx,
          tipBandAnchorRadiusPx: tipBandAnchorRadius * camera.scale,
          visibleTipLabelCount: circularVisibleTipLabels.length,
          genusGapPx: lineGapPx,
          genusLineRadiusPx: connectorArcs[0]?.lineRadiusPx ?? null,
          visibleLeafRanges: visibleLeafRanges.map((range) => [range.startIndex, range.endIndex]),
        };
        genusLabelHistoryRef.current = {
          tree,
          viewMode,
          order,
          zoom: camera.scale,
          visibleCenters: [...placedCenters],
          peakZoom: previousGenusState
            && previousGenusState.tree === tree
            && previousGenusState.viewMode === viewMode
            && previousGenusState.order === order
            && camera.scale < previousGenusState.peakZoom
            ? previousGenusState.peakZoom
            : camera.scale,
          peakVisibleCenters: previousGenusState
            && previousGenusState.tree === tree
            && previousGenusState.viewMode === viewMode
            && previousGenusState.order === order
            && camera.scale < previousGenusState.peakZoom
            ? previousGenusState.peakVisibleCenters
            : [...placedCenters],
        };
      } else {
        renderDebug.circular = {
          branchRenderMode: circularBranchRenderMode,
          cueVisible: tipLabelCueVisible,
          microVisible: microTipLabelsVisible,
          tipVisible: tipLabelsVisible,
          tipBandFontSize,
          tipBandWidthPx: globalTipLabelSpacePx,
          tipBandAnchorRadiusPx: tipBandAnchorRadius * camera.scale,
          visibleTipLabelCount: circularVisibleTipLabels.length,
          genusGapPx: null,
          genusLineRadiusPx: null,
          visibleLeafRanges: visibleLeafRanges.map((range) => [range.startIndex, range.endIndex]),
        };
        genusLabelHistoryRef.current = {
          tree,
          viewMode,
          order,
          zoom: camera.scale,
          visibleCenters: [],
          peakZoom: camera.scale,
          peakVisibleCenters: [],
        };
      }
      if (circularGenusArcs.length > 0) {
        for (let index = 0; index < circularGenusArcs.length; index += 1) {
          const arc = circularGenusArcs[index];
          if (!isOverrideRender && arc.mode !== "divider" && arc.taxonomy && taxonomyArcHitsRef.current.length < MAX_TAXONOMY_ARC_HITBOXES) {
            const innerRadiusPx = circularOverlayInnerRadiusPx(arc);
            const outerRadiusPx = circularOverlayOuterRadiusPx(arc);
            if (innerRadiusPx !== null && outerRadiusPx !== null) {
              const hitPaddingPx = arc.mode === "stroke" ? 6 : 2;
              const screenPolygonPoints = "screenPolygonPoints" in arc ? arc.screenPolygonPoints : undefined;
              taxonomyArcHitsRef.current.push({
                ...arc.taxonomy,
                startTheta: arc.startTheta + rotationAngle,
                endTheta: arc.endTheta + rotationAngle,
                innerRadiusPx: Math.max(0, innerRadiusPx - hitPaddingPx),
                outerRadiusPx: outerRadiusPx + hitPaddingPx,
                screenPolygonPoints,
                screenPolygonBounds: screenPolygonPoints && screenPolygonPoints.length >= 3
                  ? polygonBounds(screenPolygonPoints)
                  : undefined,
              });
            }
          }
          ctx.globalAlpha = CIRCULAR_TAXONOMY_OVERLAY_ALPHA;
          if (arc.mode === "ribbon") {
            if (arc.screenPolygonPoints && arc.screenPolygonPoints.length >= 3) {
              ctx.beginPath();
              ctx.moveTo(arc.screenPolygonPoints[0].x, arc.screenPolygonPoints[0].y);
              for (let pointIndex = 1; pointIndex < arc.screenPolygonPoints.length; pointIndex += 1) {
                ctx.lineTo(arc.screenPolygonPoints[pointIndex].x, arc.screenPolygonPoints[pointIndex].y);
              }
              ctx.closePath();
            } else {
              traceCircularRibbonPath(
                ctx,
                centerPoint.x,
                centerPoint.y,
                arc.innerRadiusPx,
                arc.outerRadiusPx,
                arc.startTheta + rotationAngle,
                arc.endTheta + rotationAngle,
              );
            }
            ctx.fillStyle = arc.color;
            ctx.fill();
          } else if (arc.mode === "band") {
            if (arc.screenPolygonPoints && arc.screenPolygonPoints.length >= 3) {
              ctx.beginPath();
              ctx.moveTo(arc.screenPolygonPoints[0].x, arc.screenPolygonPoints[0].y);
              for (let pointIndex = 1; pointIndex < arc.screenPolygonPoints.length; pointIndex += 1) {
                ctx.lineTo(arc.screenPolygonPoints[pointIndex].x, arc.screenPolygonPoints[pointIndex].y);
              }
              ctx.closePath();
            } else {
              traceCircularRibbonPath(
                ctx,
                centerPoint.x,
                centerPoint.y,
                arc.innerRadiusPx,
                arc.outerRadiusPx,
                arc.startTheta + rotationAngle,
                arc.endTheta + rotationAngle,
              );
            }
            ctx.fillStyle = arc.color;
            ctx.fill();
          } else if (arc.mode === "divider") {
            const theta = arc.theta + rotationAngle;
            ctx.lineWidth = arc.lineWidthPx;
            ctx.beginPath();
            ctx.moveTo(
              centerPoint.x + (Math.cos(theta) * arc.innerRadiusPx),
              centerPoint.y + (Math.sin(theta) * arc.innerRadiusPx),
            );
            ctx.lineTo(
              centerPoint.x + (Math.cos(theta) * arc.outerRadiusPx),
              centerPoint.y + (Math.sin(theta) * arc.outerRadiusPx),
            );
            ctx.strokeStyle = arc.color;
            ctx.stroke();
          } else {
            ctx.lineWidth = arc.lineWidthPx;
            ctx.beginPath();
            ctx.arc(centerPoint.x, centerPoint.y, arc.lineRadiusPx, arc.startTheta + rotationAngle, arc.endTheta + rotationAngle, false);
            ctx.strokeStyle = arc.color;
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }
      if (tipLabelsVisible) {
        const fontSize = tipFontSize;
        ctx.font = fontSpec("tip", fontSize);
        ctx.textBaseline = "middle";
        const maxVisibleLabels = 4200;
        if (circularVisibleTipLabels.length <= maxVisibleLabels) {
          for (let index = 0; index < circularVisibleTipLabels.length; index += 1) {
            const label = circularVisibleTipLabels[index];
            const { node, theta, x, y } = label;
            const fittedFontSize = Math.max(
              4,
              Math.min(fontSize, fontSize * Math.min(1, globalTipLabelSpacePx / Math.max(1e-6, label.width))),
            );
            const deg = (theta + rotationAngle) * 180 / Math.PI;
            const onRightSide = Math.cos(theta + rotationAngle) >= 0;
            const rotation = normalizeRotation(onRightSide ? deg : deg + 180);
            const highlightColor = node === activeSearchNode
              ? "#c2410c"
              : searchMatchSet.has(node)
                ? "#2563eb"
                : null;
            ctx.font = fontSpec("tip", fittedFontSize);
            ctx.save();
            ctx.translate(x + (Math.cos(theta + rotationAngle) * figureStyles.tip.offsetPx), y + (Math.sin(theta + rotationAngle) * figureStyles.tip.offsetPx));
            ctx.rotate(rotation * Math.PI / 180);
            ctx.textAlign = onRightSide ? "left" : "right";
            drawHighlightedText(
              ctx,
              label.text,
              0,
              0,
              onRightSide ? "left" : "right",
              "#111827",
              highlightColor,
              highlightColor ? findSearchMatchRange(label.text, searchQuery) : null,
            );
            ctx.restore();
            pushSceneText(
              label.text,
              x + (Math.cos(theta + rotationAngle) * figureStyles.tip.offsetPx),
              y + (Math.sin(theta + rotationAngle) * figureStyles.tip.offsetPx),
              highlightColor ?? "#111827",
              fittedFontSize,
              labelFontFamilies.tip,
              onRightSide ? "start" : "end",
              rotation * Math.PI / 180,
              labelFontStyles.tip,
            );
            labelHitsRef.current.push({
              node,
              kind: "rotated",
              source: "label",
              labelKind: "tip",
              text: label.text,
              x,
              y,
              width: Math.min(globalTipLabelSpacePx, ctx.measureText(label.text).width),
              height: fittedFontSize * 1.15,
              rotation: rotation * Math.PI / 180,
              align: onRightSide ? "left" : "right",
            });
          }
        }
      } else if (microTipLabelsVisible) {
        const fontSize = microTipFontSize;
        ctx.font = fontSpec("tip", fontSize);
        ctx.textBaseline = "middle";
        const maxVisibleLabels = 4200;
        if (circularVisibleTipLabels.length <= maxVisibleLabels) {
          ctx.fillStyle = "rgba(15,23,42,0.6)";
          for (let index = 0; index < circularVisibleTipLabels.length; index += 1) {
            const label = circularVisibleTipLabels[index];
            const fittedFontSize = Math.max(
              4,
              Math.min(fontSize, fontSize * Math.min(1, globalTipLabelSpacePx / Math.max(1e-6, label.width))),
            );
            const deg = (label.theta + rotationAngle) * 180 / Math.PI;
            const onRightSide = Math.cos(label.theta + rotationAngle) >= 0;
            const rotation = normalizeRotation(onRightSide ? deg : deg + 180);
            ctx.font = fontSpec("tip", fittedFontSize);
            ctx.save();
            ctx.translate(label.x + (Math.cos(label.theta + rotationAngle) * figureStyles.tip.offsetPx), label.y + (Math.sin(label.theta + rotationAngle) * figureStyles.tip.offsetPx));
            ctx.rotate(rotation * Math.PI / 180);
            ctx.textAlign = onRightSide ? "left" : "right";
            ctx.fillText(label.text, 0, 0);
            ctx.restore();
            pushSceneText(
              label.text,
              label.x + (Math.cos(label.theta + rotationAngle) * figureStyles.tip.offsetPx),
              label.y + (Math.sin(label.theta + rotationAngle) * figureStyles.tip.offsetPx),
              "rgba(15,23,42,0.6)",
              fittedFontSize,
              labelFontFamilies.tip,
              onRightSide ? "start" : "end",
              rotation * Math.PI / 180,
              labelFontStyles.tip,
            );
          }
        }
      } else if (tipLabelCueVisible && circularVisibleTipLabels.length <= 9000) {
        ctx.strokeStyle = "rgba(15,23,42,0.42)";
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        for (let index = 0; index < circularVisibleTipLabels.length; index += 1) {
          const label = circularVisibleTipLabels[index];
          const theta = label.theta + rotationAngle;
          const cueLength = Math.max(3.5, Math.min(7, angularSpacingPx * 0.9));
          ctx.moveTo(label.x, label.y);
          ctx.lineTo(label.x + (Math.cos(theta) * cueLength), label.y + (Math.sin(theta) * cueLength));
          pushSceneLine(label.x, label.y, label.x + (Math.cos(theta) * cueLength), label.y + (Math.sin(theta) * cueLength), "rgba(15,23,42,0.42)", 0.9);
        }
        ctx.stroke();
      }
      if (showInternalNodeLabels || showBootstrapLabels) {
        const labels: ScreenLabel[] = [];
        for (let node = 0; node < tree.nodeCount; node += 1) {
          if (hiddenNodes[node] || tree.buffers.firstChild[node] < 0) {
            continue;
          }
          const rawLabel = (tree.names[node] ?? "").trim();
          if (!rawLabel) {
            continue;
          }
          const isBootstrap = isNumericInternalLabel(rawLabel);
          if ((isBootstrap && !showBootstrapLabels) || (!isBootstrap && !showInternalNodeLabels)) {
            continue;
          }
          const displayLabel = isBootstrap
            ? formatLabelDecimals(Number(rawLabel), figureStyles.bootstrap.decimalPlaces, () => rawLabel)
            : rawLabel;
          const labelClass: LabelStyleClass = isBootstrap ? "bootstrap" : "internalNode";
          const fontSize = scaleLabelFontSize(labelClass, pointLabelBaseFontSize(isBootstrap, angularSpacingPx));
          const theta = polarThetaFor(layout.center, node);
          const renderedTheta = theta + rotationAngle;
          const radius = axisDepth(tree.buffers.depth[node]) + (14 / camera.scale);
          const point = polarToCartesian(radius, theta);
          const screen = worldToScreenCircular(camera, point.x, point.y);
          const offsetPoint = applyCircularPointLabelOffset(
            screen.x,
            screen.y,
            theta,
            rotationAngle,
            figureStyles[labelClass].offsetXPx,
            figureStyles[labelClass].offsetYPx,
          );
          const labelX = offsetPoint.x;
          const labelY = offsetPoint.y;
          if (labelX < -40 || labelX > renderSize.width + 40 || labelY < -40 || labelY > renderSize.height + 40) {
            continue;
          }
          const parent = tree.buffers.parent[node];
          const subtreeSpanPx = Math.max(0, layout.max[node] - layout.min[node]) * angularSpacingPx;
          const branchSpanPx = parent >= 0
            ? Math.max(0, tree.buffers.depth[node] - tree.buffers.depth[parent]) * camera.scale
            : 0;
          const labelWidth = estimateLabelWidth(fontSize, displayLabel.length);
          if (!pointLabelHasScreenRoom(subtreeSpanPx, branchSpanPx, fontSize, labelWidth)) {
            continue;
          }
          if (!canPlaceLinearLabel(labels, labelX, labelY, fontSize * 1.8, Math.max(labelWidth, fontSize * 4.8))) {
            continue;
          }
          const onRightSide = Math.cos(renderedTheta) >= 0;
          const rotation = polarPointLabelRotation(
            renderedTheta,
            onRightSide,
            isBootstrap ? figureStyles.bootstrap.polarOrientation ?? "tangential" : "tangential",
          );
          labels.push({
            x: labelX,
            y: labelY,
            text: displayLabel,
            alpha: 0.9,
            fontSize,
            rotation,
            align: onRightSide ? "left" : "right",
            color: isBootstrap ? "#475569" : "#1f2937",
          });
        }
        for (let index = 0; index < labels.length; index += 1) {
          const label = labels[index];
          const labelClass: LabelStyleClass = isNumericInternalLabel(label.text) ? "bootstrap" : "internalNode";
          ctx.font = `${label.fontSize ?? 10}px ${labelFontFamilies[labelClass]}`;
          ctx.fillStyle = label.color ?? "#1f2937";
          ctx.globalAlpha = label.alpha;
          ctx.save();
          ctx.translate(label.x, label.y);
          ctx.rotate(label.rotation ?? 0);
          ctx.textAlign = label.align ?? "left";
          ctx.fillText(label.text, 0, 0);
          ctx.restore();
          pushSceneText(label.text, label.x, label.y, label.color ?? "#1f2937", label.fontSize ?? 10, labelFontFamilies[labelClass], label.align === "right" ? "end" : "start", label.rotation ?? 0);
        }
        ctx.globalAlpha = 1;
      }
      if (visibleCollapsedNodes.length > 0) {
        ctx.lineWidth = 1.1;
        for (let index = 0; index < visibleCollapsedNodes.length; index += 1) {
          ctx.fillStyle = "#cbd5e1";
          ctx.strokeStyle = "#64748b";
          const node = visibleCollapsedNodes[index];
          const collapseMode = collapsedNodeModes.get(node) ?? "preserve-width";
          const taxonomyGroup = collapsedTaxonomyGroupByNode.get(node) ?? null;
          const taxonomyHitbox = taxonomyGroup
            ? {
                labelKind: "taxonomy" as const,
                text: taxonomyGroup.label,
                taxonomyRank: taxonomyGroup.rank,
                taxonomyTaxId: taxonomyGroup.taxId,
                taxonomyFirstNode: taxonomyGroup.firstNode,
                taxonomyLastNode: taxonomyGroup.lastNode,
                taxonomyTipCount: taxonomyGroup.descendantTipCount,
                taxonomyCollapseNode: node,
              }
            : {};
          const parent = tree.buffers.parent[node];
          const apexTheta = polarThetaFor(layout.center, node);
          const startTheta = polarThetaFor(layout.min, node);
          const endTheta = polarThetaFor(layout.max, node);
          const apex = worldToScreenCircular(
            camera,
            Math.cos(apexTheta) * axisDepth(tree.buffers.depth[node]),
            Math.sin(apexTheta) * axisDepth(tree.buffers.depth[node]),
          );
          const subtreeTipDepth = measureSubtreeMaxDepth(tree, node);
          const baseStart = worldToScreenCircular(
            camera,
            Math.cos(startTheta) * subtreeTipDepth,
            Math.sin(startTheta) * subtreeTipDepth,
          );
          const baseEnd = worldToScreenCircular(
            camera,
            Math.cos(endTheta) * subtreeTipDepth,
            Math.sin(endTheta) * subtreeTipDepth,
          );
          ctx.beginPath();
          ctx.moveTo(apex.x, apex.y);
          ctx.lineTo(baseStart.x, baseStart.y);
          ctx.lineTo(baseEnd.x, baseEnd.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          const hitMinX = Math.min(baseStart.x, baseEnd.x, apex.x);
          const hitMaxX = Math.max(baseStart.x, baseEnd.x, apex.x);
          const hitMinY = Math.min(baseStart.y, baseEnd.y, apex.y);
          const hitMaxY = Math.max(baseStart.y, baseEnd.y, apex.y);
          if (!isOverrideRender) {
            collapsedTriangleHitsRef.current.push({
              node,
              points: [apex, baseStart, baseEnd],
            });
          }
          labelHitsRef.current.push({
            node,
            kind: "rect",
            source: "collapse",
            collapsePart: "triangle",
            ...taxonomyHitbox,
            x: hitMinX,
            y: hitMinY,
            width: hitMaxX - hitMinX,
            height: hitMaxY - hitMinY,
          });
          if (collapseMode === "minimize" && taxonomyGroup) {
            const fontSize = scaleLabelFontSize("taxonomy", 14);
            ctx.font = fontSpec("taxonomy", fontSize);
            const labelWidth = ctx.measureText(taxonomyGroup.label).width;
            const renderedTheta = apexTheta + rotationAngle;
            const firstRenderedTaxonomyArc = circularGenusArcs.find((arc) => arc.mode !== "divider");
            const labelRadiusPx = circularOverlayInnerRadiusPx(firstRenderedTaxonomyArc)
              ?? circularFirstTaxonomyRingInnerRadiusPx
              ?? (subtreeTipDepth * camera.scale);
            const labelX = centerPoint.x + (Math.cos(renderedTheta) * labelRadiusPx);
            const labelY = centerPoint.y + (Math.sin(renderedTheta) * labelRadiusPx);
            const onRightSide = Math.cos(renderedTheta) >= 0;
            const labelRotation = onRightSide ? renderedTheta : renderedTheta + Math.PI;
            const labelAlign: CanvasTextAlign = onRightSide ? "left" : "right";
            ctx.fillStyle = "#1f2937";
            ctx.textAlign = labelAlign;
            ctx.textBaseline = "middle";
            ctx.save();
            ctx.translate(labelX, labelY);
            ctx.rotate(labelRotation);
            ctx.fillText(taxonomyGroup.label, 0, 0);
            ctx.restore();
            pushSceneText(
              taxonomyGroup.label,
              labelX,
              labelY,
              "#1f2937",
              fontSize,
              labelFontFamilies.taxonomy,
              onRightSide ? "start" : "end",
              labelRotation,
            );
            labelHitsRef.current.push({
              node,
              kind: "rotated",
              source: "collapse",
              collapsePart: "label",
              ...taxonomyHitbox,
              x: labelX,
              y: labelY,
              width: labelWidth,
              height: fontSize * 1.3,
              rotation: labelRotation,
              align: labelAlign,
            });
          }
          if (parent >= 0) {
            const edgeTheta = polarThetaFor(layout.center, node);
            const edgeStart = worldToScreenCircular(
              camera,
              Math.cos(edgeTheta) * axisDepth(tree.buffers.depth[parent]),
              Math.sin(edgeTheta) * axisDepth(tree.buffers.depth[parent]),
            );
            const edgeMinX = Math.min(edgeStart.x, apex.x) - 8;
            const edgeMaxX = Math.max(edgeStart.x, apex.x) + 8;
            const edgeMinY = Math.min(edgeStart.y, apex.y) - 8;
            const edgeMaxY = Math.max(edgeStart.y, apex.y) + 8;
            labelHitsRef.current.push({
              node,
              kind: "rect",
              source: "collapse-edge",
              x: edgeMinX,
              y: edgeMinY,
              width: Math.max(16, edgeMaxX - edgeMinX),
              height: Math.max(16, edgeMaxY - edgeMinY),
            });
          }
        }
      }
      for (let index = 0; index < circularGenusLabels.length; index += 1) {
        const label = circularGenusLabels[index];
        ctx.font = `${label.fontSize ?? circularGenusBaseFontSize}px ${label.rank ? labelFontFamilies.taxonomy : labelFontFamilies.genus}`;
        ctx.textBaseline = "middle";
        const labelMetrics = ctx.measureText(label.text);
        ctx.save();
        if (label.clipArc && !label.clipArc.skipClip) {
          const clipStart = label.clipArc.startTheta + rotationAngle;
          const clipEnd = label.clipArc.endTheta + rotationAngle;
          ctx.beginPath();
          ctx.arc(centerPoint.x, centerPoint.y, label.clipArc.outerRadiusPx, clipStart, clipEnd, false);
          ctx.arc(centerPoint.x, centerPoint.y, label.clipArc.innerRadiusPx, clipEnd, clipStart, true);
          ctx.closePath();
          ctx.clip();
        }
        const curvedRadiusPx = label.clipArc
          ? (label.clipArc.innerRadiusPx + label.clipArc.outerRadiusPx) * 0.5
          : 0;
        const useCurvedText = Boolean(
          label.rank
          && label.clipArc
          && curvedTextNeeded(
            labelMetrics.width,
            label.fontSize ?? circularGenusBaseFontSize,
            curvedRadiusPx,
          ),
        );
        const shouldMaskTaxonomyStrand = Boolean(label.rank && (taxonomyOverlayStyle === "strands" || label.taxonomyDisplayMode === "label-only"));
        if (useCurvedText) {
          if (shouldMaskTaxonomyStrand) {
            const labelFontSize = label.fontSize ?? circularGenusBaseFontSize;
            const labelTheta = label.theta ?? Math.atan2(label.y - centerPoint.y, label.x - centerPoint.x);
            const maskHalfTheta = Math.min(
              Math.PI,
              ((labelMetrics.width * 0.5) + Math.max(4, labelFontSize * 0.45)) / Math.max(curvedRadiusPx, 1),
            );
            ctx.save();
            ctx.strokeStyle = "#fbfcfe";
            ctx.lineWidth = Math.max(6, labelFontSize * 1.85);
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.arc(centerPoint.x, centerPoint.y, curvedRadiusPx, labelTheta - maskHalfTheta, labelTheta + maskHalfTheta, false);
            ctx.stroke();
            ctx.restore();
            pushScenePath(
              () => svgArcPath(centerPoint.x, centerPoint.y, curvedRadiusPx, labelTheta - maskHalfTheta, labelTheta + maskHalfTheta),
              "#fbfcfe",
              Math.max(6, labelFontSize * 1.85),
              undefined,
              1,
            );
          }
          ctx.textAlign = "center";
          drawCircularCurvedText(
            ctx,
            label.text,
            centerPoint.x,
            centerPoint.y,
            curvedRadiusPx,
            label.theta ?? Math.atan2(label.y - centerPoint.y, label.x - centerPoint.x),
            label.color ?? GENUS_COLOR,
            label.searchHighlightColor ?? null,
            label.searchMatchRange ?? null,
          );
        } else {
          if (shouldMaskTaxonomyStrand) {
            const labelFontSize = label.fontSize ?? circularGenusBaseFontSize;
            const maskRadiusPx = label.clipArc
              ? (label.clipArc.innerRadiusPx + label.clipArc.outerRadiusPx) * 0.5
              : 0;
            if (maskRadiusPx > 0) {
              const labelTheta = label.theta ?? Math.atan2(label.y - centerPoint.y, label.x - centerPoint.x);
              const maskHalfTheta = Math.min(
                Math.PI,
                ((labelMetrics.width * 0.5) + Math.max(2, labelFontSize * 0.18)) / Math.max(maskRadiusPx, 1),
              );
              const maskLineWidth = Math.min(
                Math.max(2.5, labelFontSize * 0.52),
                Math.max(2.5, (label.clipArc?.outerRadiusPx ?? maskRadiusPx) - (label.clipArc?.innerRadiusPx ?? maskRadiusPx)),
              );
              ctx.save();
              ctx.strokeStyle = "#fbfcfe";
              ctx.lineWidth = maskLineWidth;
              ctx.lineCap = "round";
              ctx.beginPath();
              ctx.arc(centerPoint.x, centerPoint.y, maskRadiusPx, labelTheta - maskHalfTheta, labelTheta + maskHalfTheta, false);
              ctx.stroke();
              ctx.restore();
              pushScenePath(
                () => svgArcPath(centerPoint.x, centerPoint.y, maskRadiusPx, labelTheta - maskHalfTheta, labelTheta + maskHalfTheta),
                "#fbfcfe",
                maskLineWidth,
                undefined,
                1,
              );
            }
          }
          ctx.translate(label.x, label.y);
          ctx.rotate(label.rotation ?? 0);
          ctx.textAlign = label.align ?? "left";
          drawHighlightedText(
            ctx,
            label.text,
            0,
            label.offsetY ?? 0,
            label.align ?? "left",
            label.color ?? GENUS_COLOR,
            label.searchHighlightColor ?? null,
            label.searchMatchRange ?? null,
          );
        }
        ctx.restore();
        pushSceneText(
          label.text,
          label.x,
          label.y + (label.offsetY ?? 0),
          label.searchHighlightColor ?? label.color ?? GENUS_COLOR,
          label.fontSize ?? circularGenusBaseFontSize,
          label.rank ? labelFontFamilies.taxonomy : labelFontFamilies.genus,
          label.align === "right" ? "end" : label.align === "center" ? "middle" : "start",
          label.rotation ?? 0,
        );
        if (label.rank) {
          drawPhyloPicForTaxonomyLabel(label, labelMetrics.width, label.fontSize ?? circularGenusBaseFontSize);
        }
        if (label.rank) {
          labelHitsRef.current.push({
            node: label.firstNode ?? 0,
            kind: "rect",
            source: "label",
            labelKind: "taxonomy",
            text: label.text,
            taxonomyRank: label.rank,
            taxonomyTaxId: label.taxId ?? null,
            taxonomyFirstNode: label.firstNode,
            taxonomyLastNode: label.lastNode,
            taxonomyTipCount: label.taxonomyTipCount,
            taxonomyStartIndex: label.taxonomyStartIndex,
            taxonomyEndIndex: label.taxonomyEndIndex,
            x: label.x - (labelMetrics.width * 0.5),
            y: label.y - Math.max(10, (label.fontSize ?? circularGenusBaseFontSize) * 0.7),
            width: Math.max(20, labelMetrics.width),
            height: Math.max(20, (label.fontSize ?? circularGenusBaseFontSize) * 1.4),
          });
        }
      }
      timing.taxonomyOverlayMs += performance.now() - circularTaxonomyOverlayStartTime;

      if (showNodeHeightLabels) {
        const fontSize = scaleLabelFontSize("nodeHeight", pointLabelBaseFontSize(false, angularSpacingPx));
        const labels: ScreenLabel[] = [];
        ctx.font = `${fontSize}px ${labelFontFamilies.nodeHeight}`;
        ctx.fillStyle = "#64748b";
        ctx.textBaseline = "middle";
        for (let node = 0; node < tree.nodeCount; node += 1) {
          if (tree.buffers.firstChild[node] < 0) {
            continue;
          }
          const parent = tree.buffers.parent[node];
          const theta = polarThetaFor(layout.center, node);
          const radius = Math.max(0, axisDepth(tree.buffers.depth[node]) + ((showBootstrapLabels ? -8 : 10) / camera.scale));
          const point = polarToCartesian(radius, theta);
          const screen = worldToScreenCircular(camera, point.x, point.y);
          const subtreeSpanPx = Math.max(0, (layout.max[node] - layout.min[node])) * angularSpacingPx;
          const branchSpanPx = parent >= 0
            ? Math.max(0, (tree.buffers.depth[node] - tree.buffers.depth[parent]) * camera.scale)
            : 0;
          const text = formatLabelDecimals(
            nodeHeightValue(tree, node),
            figureStyles.nodeHeight.decimalPlaces,
            () => formatAgeNumber(nodeHeightValue(tree, node)),
          );
          const labelWidth = ctx.measureText(text).width;
          if (!pointLabelHasScreenRoom(subtreeSpanPx, branchSpanPx, fontSize, labelWidth)) {
            continue;
          }
          const offsetPoint = applyCircularPointLabelOffset(
            screen.x,
            screen.y,
            theta,
            rotationAngle,
            figureStyles.nodeHeight.offsetXPx,
            figureStyles.nodeHeight.offsetYPx - 5,
          );
          const labelX = offsetPoint.x;
          const labelY = offsetPoint.y;
          if (
            labelX < -40 || labelX > renderSize.width + 40 ||
            labelY < -40 || labelY > renderSize.height + 40
          ) {
            continue;
          }
          if (!canPlaceLinearLabel(labels, labelX, labelY, fontSize * 2.1, Math.max(labelWidth, fontSize * 5.5))) {
            continue;
          }
          const renderedTheta = theta + rotationAngle;
          const onRightSide = Math.cos(renderedTheta) >= 0;
          labels.push({
            x: labelX,
            y: labelY,
            text,
            alpha: 0.76,
            fontSize,
            rotation: polarPointLabelRotation(
              renderedTheta,
              onRightSide,
              figureStyles.nodeHeight.polarOrientation ?? "tangential",
            ),
            align: onRightSide ? "left" : "right",
          });
        }
        for (let index = 0; index < labels.length; index += 1) {
          const label = labels[index];
          ctx.globalAlpha = label.alpha;
          ctx.save();
          ctx.translate(label.x, label.y);
          ctx.rotate(label.rotation ?? 0);
          ctx.textAlign = label.align ?? "left";
          ctx.fillText(label.text, 0, 0);
          ctx.restore();
          pushSceneText(label.text, label.x, label.y, "#64748b", label.fontSize ?? fontSize, labelFontFamilies.nodeHeight, label.align === "right" ? "end" : "start", label.rotation ?? 0);
        }
        ctx.globalAlpha = 1;
      }

      if (metadataPieNodes.length > 0 && metadataPies && camera.scale > 4.5 && renderedMetadataPieSizePx > 0) {
        const maxVisibleMetadataPies = 1000;
        const visiblePies: Array<{
          pie: NonNullable<(typeof metadataPies)[number]>;
          x: number;
          y: number;
        }> = [];
        const orderedPieNodes = metadataPieNodesByOrder[order];
        for (let index = 0; index < orderedPieNodes.length; index += 1) {
          const node = orderedPieNodes[index];
          if (hiddenNodes[node]) {
            continue;
          }
          const pie = metadataPies[node];
          if (!pie) {
            continue;
          }
          const theta = polarThetaFor(layout.center, node);
          const screen = metadataCircularPieScreenPosition(tree, node, theta, camera, renderedMetadataPieSizePx);
          if (screen.x < -30 || screen.x > renderSize.width + 30 || screen.y < -30 || screen.y > renderSize.height + 30) {
            continue;
          }
          visiblePies.push({
            pie,
            x: screen.x,
            y: screen.y,
          });
        }
        const sampledPies = evenlySampleSortedItems(visiblePies, maxVisibleMetadataPies);
        for (let index = 0; index < sampledPies.length; index += 1) {
          const pie = sampledPies[index];
          drawMetadataPie(ctx, pie.pie, pie.x, pie.y, renderedMetadataPieSizePx);
          pushMetadataPieScenePaths(pushScenePath, pie.pie, pie.x, pie.y, renderedMetadataPieSizePx);
        }
      }

      if (metadataMarkerNodes.length > 0 && metadataMarkers && renderedMetadataMarkerSizePx > 0) {
        const maxVisibleMetadataMarkers = 1600;
        const visibleMarkers: Array<{
          marker: NonNullable<(typeof metadataMarkers)[number]>;
          x: number;
          y: number;
        }> = [];
        ctx.lineWidth = 1.1;
        const orderedMarkerNodes = metadataMarkerNodesByOrder[order];
        for (let index = 0; index < orderedMarkerNodes.length; index += 1) {
          const node = orderedMarkerNodes[index];
          if (hiddenNodes[node]) {
            continue;
          }
          const marker = metadataMarkers[node];
          if (!marker) {
            continue;
          }
          const theta = polarThetaFor(layout.center, node);
          const screen = metadataCircularMarkerScreenPosition(tree, node, theta, camera, renderedMetadataMarkerSizePx);
          if (screen.x < -20 || screen.x > renderSize.width + 20 || screen.y < -20 || screen.y > renderSize.height + 20) {
            continue;
          }
          visibleMarkers.push({
            marker,
            x: screen.x,
            y: screen.y,
          });
        }
        const sampledMarkers = evenlySampleSortedItems(visibleMarkers, maxVisibleMetadataMarkers);
        for (let index = 0; index < sampledMarkers.length; index += 1) {
          const marker = sampledMarkers[index];
          ctx.fillStyle = marker.marker.color;
          ctx.strokeStyle = "rgba(255,255,255,0.92)";
          drawMetadataMarker(ctx, marker.marker.shape, marker.x, marker.y, renderedMetadataMarkerSizePx);
          ctx.fill();
          ctx.stroke();
          pushScenePath(metadataMarkerPath(marker.marker.shape, marker.x, marker.y, renderedMetadataMarkerSizePx), "rgba(255,255,255,0.92)", 1.1, marker.marker.color, 1);
        }
      }

      if (metadataLabelNodes.length > 0 && metadataLabels && camera.scale > 5.5) {
        const fontSize = scaleLabelFontSize("internalNode", Math.max(8, Math.min(11.5, camera.scale * 0.038)));
        const labels: ScreenLabel[] = [];
        ctx.font = `${fontSize}px ${labelFontFamilies.internalNode}`;
        ctx.textBaseline = "middle";
        const maxVisibleMetadataLabels = Math.max(1, metadataLabelMaxCount);
        for (let index = 0; index < metadataLabelNodes.length; index += 1) {
          if (labels.length >= maxVisibleMetadataLabels) {
            break;
          }
          const node = metadataLabelNodes[index];
          if (hiddenNodes[node]) {
            continue;
          }
          const labelText = metadataLabels[node];
          if (!labelText) {
            continue;
          }
          const theta = polarThetaFor(layout.center, node);
          const radius = axisDepth(tree.buffers.depth[node]) + (12 / camera.scale);
          const point = polarToCartesian(radius, theta);
          const screen = worldToScreenCircular(camera, point.x, point.y);
          const labelX = screen.x + figureStyles.internalNode.offsetXPx + metadataLabelOffsetXPx;
          const labelY = screen.y - 10 + figureStyles.internalNode.offsetYPx + metadataLabelOffsetYPx;
          if (labelX < -40 || labelX > renderSize.width + 40 || labelY < -40 || labelY > renderSize.height + 40) {
            continue;
          }
          if (!canPlaceLinearLabel(
            labels,
            labelX,
            labelY,
            (fontSize * 1.8) + metadataLabelMinSpacingPx,
            estimateLabelWidth(fontSize, labelText.length) + metadataLabelMinSpacingPx,
          )) {
            continue;
          }
          const renderedTheta = theta + rotationAngle;
          const onRightSide = Math.cos(renderedTheta) >= 0;
          const rotation = normalizeRotation((renderedTheta * 180 / Math.PI) + (onRightSide ? 90 : 270)) * Math.PI / 180;
          labels.push({
            x: labelX,
            y: labelY,
            text: labelText,
            alpha: 0.9,
            fontSize,
            rotation,
            align: onRightSide ? "left" : "right",
            color: effectiveBranchColors?.[node] ?? metadataBranchColorOverlay.colors[node] ?? "#1f2937",
          });
        }
        for (let index = 0; index < labels.length; index += 1) {
          const label = labels[index];
          ctx.globalAlpha = label.alpha;
          ctx.fillStyle = label.color ?? "#1f2937";
          ctx.save();
          ctx.translate(label.x, label.y);
          ctx.rotate(label.rotation ?? 0);
          ctx.textAlign = label.align ?? "left";
          ctx.fillText(label.text, 0, 0);
          ctx.restore();
          pushSceneText(
            label.text,
            label.x,
            label.y,
            label.color ?? "#1f2937",
            label.fontSize ?? fontSize,
            labelFontFamilies.internalNode,
            label.align === "right" ? "end" : "start",
            label.rotation ?? 0,
          );
        }
        ctx.globalAlpha = 1;
      }

      let circularErrorBarCount = 0;
      if (showNodeErrorBars && tree.nodeIntervalCount > 0 && camera.scale > 10) {
        const placements: ScreenLabel[] = [];
        const halfCap = Math.max(0, errorBarCapSizePx * 0.5);
        const halfThickness = Math.max(0.25, errorBarThicknessPx * 0.5);
        for (let node = 0; node < tree.nodeCount; node += 1) {
          if (tree.buffers.firstChild[node] < 0) {
            continue;
          }
          const lower = tree.nodeIntervalLower[node];
          const upper = tree.nodeIntervalUpper[node];
          if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
            continue;
          }
          const theta = polarThetaFor(layout.center, node);
          const startWorld = polarToCartesian(axisDepth(lower), theta);
          const endWorld = polarToCartesian(axisDepth(upper), theta);
          const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
          const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
          const midX = (start.x + end.x) * 0.5;
          const midY = (start.y + end.y) * 0.5;
          if (
            midX < -40 || midX > renderSize.width + 40 ||
            midY < -40 || midY > renderSize.height + 40
          ) {
            continue;
          }
          if (!canPlaceLinearLabel(placements, midX, midY, 12, 18)) {
            continue;
          }
          placements.push({ x: midX, y: midY, text: "", alpha: 1 });
          const tangentX = -Math.sin(theta + rotationAngle);
          const tangentY = Math.cos(theta + rotationAngle);
          ctx.globalAlpha = errorBarOpacity;
          if (errorBarStyle === "rectangle") {
            const startA = { x: start.x - (tangentX * halfThickness), y: start.y - (tangentY * halfThickness) };
            const startB = { x: start.x + (tangentX * halfThickness), y: start.y + (tangentY * halfThickness) };
            const endB = { x: end.x + (tangentX * halfThickness), y: end.y + (tangentY * halfThickness) };
            const endA = { x: end.x - (tangentX * halfThickness), y: end.y - (tangentY * halfThickness) };
            ctx.fillStyle = errorBarColor;
            ctx.beginPath();
            ctx.moveTo(startA.x, startA.y);
            ctx.lineTo(startB.x, startB.y);
            ctx.lineTo(endB.x, endB.y);
            ctx.lineTo(endA.x, endA.y);
            ctx.closePath();
            ctx.fill();
            pushScenePath(
              `M ${startA.x} ${startA.y} L ${startB.x} ${startB.y} L ${endB.x} ${endB.y} L ${endA.x} ${endA.y} Z`,
              undefined,
              undefined,
              errorBarColor,
              errorBarOpacity,
            );
          } else {
            ctx.strokeStyle = errorBarColor;
            ctx.lineWidth = errorBarThicknessPx;
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            if (halfCap > 0) {
              ctx.moveTo(start.x - (tangentX * halfCap), start.y - (tangentY * halfCap));
              ctx.lineTo(start.x + (tangentX * halfCap), start.y + (tangentY * halfCap));
              ctx.moveTo(end.x - (tangentX * halfCap), end.y - (tangentY * halfCap));
              ctx.lineTo(end.x + (tangentX * halfCap), end.y + (tangentY * halfCap));
            }
            ctx.stroke();
            pushSceneLine(start.x, start.y, end.x, end.y, errorBarColor, errorBarThicknessPx, errorBarOpacity);
            if (halfCap > 0) {
              pushSceneLine(start.x - (tangentX * halfCap), start.y - (tangentY * halfCap), start.x + (tangentX * halfCap), start.y + (tangentY * halfCap), errorBarColor, errorBarThicknessPx, errorBarOpacity);
              pushSceneLine(end.x - (tangentX * halfCap), end.y - (tangentY * halfCap), end.x + (tangentX * halfCap), end.y + (tangentY * halfCap), errorBarColor, errorBarThicknessPx, errorBarOpacity);
            }
          }
          if (errorBarShowNodeDot) {
            const nodeWorld = polarToCartesian(axisDepth(tree.buffers.depth[node]), theta);
            const nodeScreen = worldToScreenCircular(camera, nodeWorld.x, nodeWorld.y);
            const radius = Math.max(2, Math.min(5, errorBarThicknessPx * 0.65));
            ctx.globalAlpha = Math.min(1, errorBarOpacity + 0.3);
            ctx.fillStyle = errorBarColor;
            ctx.beginPath();
            ctx.arc(nodeScreen.x, nodeScreen.y, radius, 0, Math.PI * 2);
            ctx.fill();
            pushScenePath(
              `M ${nodeScreen.x - radius} ${nodeScreen.y} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`,
              undefined,
              undefined,
              errorBarColor,
              Math.min(1, errorBarOpacity + 0.3),
            );
          }
          circularErrorBarCount += 1;
        }
        ctx.globalAlpha = 1;
      }
      if (!renderDebug.circular || typeof renderDebug.circular !== "object") {
        renderDebug.circular = {};
      }
      (renderDebug.circular as Record<string, unknown>).errorBarCount = circularErrorBarCount;
      (renderDebug.circular as Record<string, unknown>).centerScaleAngleDegrees = circularCenterScaleAngleDegrees;
      (renderDebug.circular as Record<string, unknown>).showCentralScaleLabels = showCentralTimeLabels;
      (renderDebug.circular as Record<string, unknown>).centerScaleTickCount = displayedCircularCenterScaleBoundaries.length;
      (renderDebug.circular as Record<string, unknown>).showCenterRadialScaleBar = showCentralTimeLabels && showCircularCenterRadialScaleBar;
      (renderDebug.circular as Record<string, unknown>).renderedColoredStemCount = circularRenderedColoredStemCount;
      (renderDebug.circular as Record<string, unknown>).renderedColoredConnectorCount = circularRenderedColoredConnectorCount;
      (renderDebug.circular as Record<string, unknown>).collapsedMinimizedAngularSpans = visibleCollapsedNodes
        .filter((node) => collapsedNodeModes.get(node) === "minimize")
        .map((node) => ({
          node,
          span: Math.abs(
            polarThetaFor(layout.max, node)
            - polarThetaFor(layout.min, node)
          ),
        }));

      if (showScaleBars) {
        ctx.fillStyle = "#6b7280";
        const scaleFontSize = scaleLabelFontSize("scale", 11);
        ctx.font = fontSpec("scale", scaleFontSize);
        ctx.textBaseline = "middle";
        if (showCentralTimeLabels) {
          const centerScaleBarTheta = showCircularCenterRadialScaleBar
            ? centerScaleTheta + ((2.5 * Math.PI) / 180)
            : centerScaleTheta;
          const centerScaleBarTangentX = -Math.sin(centerScaleBarTheta + rotationAngle);
          const centerScaleBarTangentY = Math.cos(centerScaleBarTheta + rotationAngle);
          const centerScaleLabelOffsetPx = showCircularCenterRadialScaleBar
            ? Math.max((scaleFontSize * 0.72) + 3, scaleFontSize)
            : 0;
          const rotatedLabelDegrees = (centerScaleBarTheta + rotationAngle) * 180 / Math.PI;
          const rotatedLabelOnRightSide = Math.cos(centerScaleBarTheta + rotationAngle) >= 0;
          const rotatedLabelRadians = normalizeRotation(rotatedLabelOnRightSide ? rotatedLabelDegrees : rotatedLabelDegrees + 180) * Math.PI / 180;
          let centerScaleLabelRotation = showCircularCenterRadialScaleBar ? rotatedLabelRadians : 0;
          if (polarInnerRadius > 1e-9 && displayedCircularCenterScaleBoundaries.length > 1) {
            const sortedTickPositions = displayedCircularCenterScaleBoundaries
              .map((boundary) => circularRadiusForBoundary(boundary.value) * camera.scale)
              .sort((left, right) => left - right);
            let minimumTickSpacingPx = Number.POSITIVE_INFINITY;
            for (let index = 1; index < sortedTickPositions.length; index += 1) {
              minimumTickSpacingPx = Math.min(
                minimumTickSpacingPx,
                sortedTickPositions[index] - sortedTickPositions[index - 1],
              );
            }
            const maximumLabelWidthPx = displayedCircularCenterScaleBoundaries.reduce(
              (maximum, boundary) => Math.max(maximum, ctx.measureText(scaleLabelText(boundary.value)).width),
              0,
            );
            const screenAxisAngle = centerScaleTheta + rotationAngle;
            const tangentLabelRotation = normalizeRotation(
              ((screenAxisAngle * 180) / Math.PI) + 90,
            ) * Math.PI / 180;
            const projectedLabelExtent = (labelRotation: number): number => {
              const relativeAngle = labelRotation - screenAxisAngle;
              return (Math.abs(Math.cos(relativeAngle)) * maximumLabelWidthPx)
                + (Math.abs(Math.sin(relativeAngle)) * scaleFontSize * 1.15);
            };
            const availableSpacingPx = Math.max(1, minimumTickSpacingPx - 3);
            if (projectedLabelExtent(centerScaleLabelRotation) > availableSpacingPx) {
              for (let step = 1; step <= 20; step += 1) {
                const progress = step / 20;
                const candidate = centerScaleLabelRotation
                  + ((tangentLabelRotation - centerScaleLabelRotation) * progress);
                centerScaleLabelRotation = candidate;
                if (projectedLabelExtent(candidate) <= availableSpacingPx) {
                  break;
                }
              }
            }
          }
          const rotateCenterScaleLabels = Math.abs(centerScaleLabelRotation) > 1e-6;
          ctx.textAlign = rotateCenterScaleLabels || showCircularCenterRadialScaleBar
            ? "center"
            : Math.cos(centerScaleTheta + rotationAngle) >= 0 ? "left" : "right";
          for (let index = 0; index < displayedCircularCenterScaleBoundaries.length; index += 1) {
            const boundary = displayedCircularCenterScaleBoundaries[index];
            const radius = circularRadiusForBoundary(boundary.value) + (showCircularCenterRadialScaleBar ? 0 : (10 / camera.scale));
            const point = polarToCartesian(radius, showCircularCenterRadialScaleBar ? centerScaleBarTheta : centerScaleTheta);
            const screen = worldToScreenCircular(camera, point.x, point.y);
            const labelX = showCircularCenterRadialScaleBar
              ? screen.x - (centerScaleBarTangentX * centerScaleLabelOffsetPx)
              : screen.x;
            const labelY = showCircularCenterRadialScaleBar
              ? screen.y - (centerScaleBarTangentY * centerScaleLabelOffsetPx)
              : screen.y;
            ctx.globalAlpha = 0.35 + (0.65 * boundary.alpha);
            if (rotateCenterScaleLabels || showCircularCenterRadialScaleBar) {
              ctx.save();
              ctx.translate(labelX, labelY);
              ctx.rotate(centerScaleLabelRotation);
              ctx.fillText(scaleLabelText(boundary.value), 0, 0);
              ctx.restore();
            } else {
              ctx.fillText(scaleLabelText(boundary.value), labelX, labelY);
            }
            pushSceneText(
              scaleLabelText(boundary.value),
              labelX,
              labelY,
              "#6b7280",
              scaleFontSize,
              labelFontFamilies.scale,
              rotateCenterScaleLabels || showCircularCenterRadialScaleBar ? "middle" : Math.cos(centerScaleTheta + rotationAngle) >= 0 ? "start" : "end",
              rotateCenterScaleLabels || showCircularCenterRadialScaleBar ? centerScaleLabelRotation : undefined,
              labelFontStyles.scale,
            );
          }
          if (showCircularCenterRadialScaleBar) {
            const startWorld = polarToCartesian(polarInnerRadius, centerScaleBarTheta);
            const startPoint = worldToScreenCircular(camera, startWorld.x, startWorld.y);
            const endWorld = polarToCartesian(
              tree.isUltrametric ? circularRadiusForBoundary(0) : circularRadiusForBoundary(stripeExtent),
              centerScaleBarTheta,
            );
            const endPoint = worldToScreenCircular(camera, endWorld.x, endWorld.y);
            ctx.globalAlpha = 0.82;
            ctx.strokeStyle = "#6b7280";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(startPoint.x, startPoint.y);
            ctx.lineTo(endPoint.x, endPoint.y);
            ctx.stroke();
            pushSceneLine(startPoint.x, startPoint.y, endPoint.x, endPoint.y, "#6b7280", 1, 0.82);
            ctx.beginPath();
            for (let index = 0; index < displayedCircularCenterScaleBoundaries.length; index += 1) {
              const boundary = displayedCircularCenterScaleBoundaries[index];
              const radius = circularRadiusForBoundary(boundary.value);
              const tickWorld = polarToCartesian(radius, centerScaleBarTheta);
              const tickScreen = worldToScreenCircular(camera, tickWorld.x, tickWorld.y);
              const halfTick = (4 + (3 * boundary.alpha)) * 0.5;
              ctx.moveTo(
                tickScreen.x - (centerScaleBarTangentX * halfTick),
                tickScreen.y - (centerScaleBarTangentY * halfTick),
              );
              ctx.lineTo(
                tickScreen.x + (centerScaleBarTangentX * halfTick),
                tickScreen.y + (centerScaleBarTangentY * halfTick),
              );
              pushSceneLine(
                tickScreen.x - (centerScaleBarTangentX * halfTick),
                tickScreen.y - (centerScaleBarTangentY * halfTick),
                tickScreen.x + (centerScaleBarTangentX * halfTick),
                tickScreen.y + (centerScaleBarTangentY * halfTick),
                "#6b7280",
                1,
                0.35 + (0.65 * boundary.alpha),
              );
            }
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        } else if (circularScaleBar) {
          ctx.fillStyle = "rgba(251,252,254,0.97)";
          if (circularScaleBar.kind === "bottom") {
            ctx.fillRect(0, Math.max(0, circularScaleBar.axisPosition - 12), renderSize.width, renderSize.height);
            pushSceneRect(0, Math.max(0, circularScaleBar.axisPosition - 12), renderSize.width, renderSize.height, "rgba(251,252,254,0.97)");
          } else {
            ctx.fillRect(0, 0, circularScaleBar.axisPosition + 16, renderSize.height);
            pushSceneRect(0, 0, circularScaleBar.axisPosition + 16, renderSize.height, "rgba(251,252,254,0.97)");
          }

          ctx.strokeStyle = "#6b7280";
          ctx.fillStyle = "#6b7280";
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (circularScaleBar.kind === "bottom") {
            ctx.moveTo(24, circularScaleBar.axisPosition);
            ctx.lineTo(renderSize.width - 24, circularScaleBar.axisPosition);
            pushSceneLine(24, circularScaleBar.axisPosition, renderSize.width - 24, circularScaleBar.axisPosition, "#6b7280", 1);
            for (let index = 0; index < circularScaleBar.ticks.length; index += 1) {
              const tick = circularScaleBar.ticks[index];
              ctx.globalAlpha = 0.35 + (0.65 * tick.boundary.alpha);
              ctx.moveTo(tick.position, circularScaleBar.axisPosition);
              ctx.lineTo(tick.position, circularScaleBar.axisPosition + (4 + (3 * tick.boundary.alpha)));
              pushSceneLine(tick.position, circularScaleBar.axisPosition, tick.position, circularScaleBar.axisPosition + (4 + (3 * tick.boundary.alpha)), "#6b7280", 1, 0.35 + (0.65 * tick.boundary.alpha));
            }
            ctx.globalAlpha = 1;
            ctx.stroke();
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            for (let index = 0; index < circularScaleBar.ticks.length; index += 1) {
              const tick = circularScaleBar.ticks[index];
              ctx.globalAlpha = 0.35 + (0.65 * tick.boundary.alpha);
              ctx.fillText(scaleLabelText(tick.boundary.value), tick.position, circularScaleBar.axisPosition + 8);
              pushSceneText(
                scaleLabelText(tick.boundary.value),
                tick.position,
                circularScaleBar.axisPosition + 8,
                "#6b7280",
                scaleFontSize,
                labelFontFamilies.scale,
                "middle",
                undefined,
                labelFontStyles.scale,
              );
            }
            ctx.globalAlpha = 1;
          } else {
            ctx.moveTo(circularScaleBar.axisPosition, 24);
            ctx.lineTo(circularScaleBar.axisPosition, renderSize.height - 24);
            pushSceneLine(circularScaleBar.axisPosition, 24, circularScaleBar.axisPosition, renderSize.height - 24, "#6b7280", 1);
            for (let index = 0; index < circularScaleBar.ticks.length; index += 1) {
              const tick = circularScaleBar.ticks[index];
              ctx.globalAlpha = 0.35 + (0.65 * tick.boundary.alpha);
              ctx.moveTo(circularScaleBar.axisPosition, tick.position);
              ctx.lineTo(circularScaleBar.axisPosition - (4 + (3 * tick.boundary.alpha)), tick.position);
              pushSceneLine(circularScaleBar.axisPosition, tick.position, circularScaleBar.axisPosition - (4 + (3 * tick.boundary.alpha)), tick.position, "#6b7280", 1, 0.35 + (0.65 * tick.boundary.alpha));
            }
            ctx.globalAlpha = 1;
            ctx.stroke();
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            for (let index = 0; index < circularScaleBar.ticks.length; index += 1) {
              const tick = circularScaleBar.ticks[index];
              ctx.save();
              ctx.globalAlpha = 0.35 + (0.65 * tick.boundary.alpha);
              ctx.translate(circularScaleBar.axisPosition - 8, tick.position);
              ctx.rotate(-Math.PI / 2);
              ctx.fillText(scaleLabelText(tick.boundary.value), 0, 0);
              ctx.restore();
              pushSceneText(
                scaleLabelText(tick.boundary.value),
                circularScaleBar.axisPosition - 8,
                tick.position,
                "#6b7280",
                scaleFontSize,
                labelFontFamilies.scale,
                "middle",
                -Math.PI / 2,
                labelFontStyles.scale,
              );
            }
          }
        }
      }
    }
    flushPhyloPicImages();
    if (!isOverrideRender) {
      rotationPreviewRef.current = null;
    }
    const collapsedTriangleDrawCapture = typeof window !== "undefined"
      ? window.__BIG_TREE_VIEWER_COLLAPSE_DRAW_CAPTURE__
      : undefined;
    if (!isOverrideRender && collapsedTriangleDrawCapture) {
      const triangle = labelHitsRef.current.find((candidate) => (
        candidate.node === collapsedTriangleDrawCapture.node
        && candidate.source === "collapse"
      ));
      if (triangle) {
        const minimumY = triangle.y;
        const maximumY = triangle.y + triangle.height;
        const neighborY = camera.kind === "rect" && collapsedView
          ? camera.translateY
            + (collapsedView.layout.center[collapsedTriangleDrawCapture.neighborNode] * camera.scaleY)
          : null;
        collapsedTriangleDrawCapture.samples.push({
          centerY: (minimumY + maximumY) * 0.5,
          height: maximumY - minimumY,
          neighborY,
        });
      }
    }
    renderDebugRef.current = renderDebug;
    drawHoverHighlightOverlay();
    timing.totalMs = performance.now() - drawStartTime;
    renderDebug.timing = timing;
    const drawEndTime = performance.now();
    const benchmark = panBenchmarkRef.current;
    const frameQueueWaitMs = benchmark?.scheduledFrameAtMs === null || benchmark?.scheduledFrameAtMs === undefined
      ? null
      : Math.max(0, drawStartTime - benchmark.scheduledFrameAtMs);
    if (benchmark) {
      benchmark.samples.push({
        timestampMs: drawEndTime,
        frameDeltaMs: benchmark.lastFrameAtMs === null ? null : drawEndTime - benchmark.lastFrameAtMs,
        inputLatencyMs: benchmark.lastInputAtMs === null ? null : drawEndTime - benchmark.lastInputAtMs,
        frameQueueWaitMs,
        drawTotalMs: timing.totalMs,
        branchBaseMs: timing.branchBaseMs,
        taxonomyOverlayMs: timing.taxonomyOverlayMs,
        renderDpr: Number(renderDebug.renderDpr ?? 1),
        branchRenderMode: camera.kind === "rect"
          ? (
            typeof (renderDebug.rect as { branchRenderMode?: unknown } | undefined)?.branchRenderMode === "string"
              ? (renderDebug.rect as { branchRenderMode: string }).branchRenderMode
              : null
          )
          : (
            typeof (renderDebug.circular as { branchRenderMode?: unknown } | undefined)?.branchRenderMode === "string"
              ? (renderDebug.circular as { branchRenderMode: string }).branchRenderMode
              : null
          ),
        cameraKind: camera.kind,
      });
      benchmark.lastFrameAtMs = drawEndTime;
      benchmark.lastInputAtMs = null;
      benchmark.scheduledFrameAtMs = null;
    }
    if (typeof window !== "undefined") {
      window.__BIG_TREE_VIEWER_RENDER_DEBUG__ = renderDebug;
    }
  }, [
    activeSearchGenusCenterNode,
    activeSearchNode,
    activeSearchTaxonomyKey,
    alignTipLabels,
    automaticTaxonomyRanks,
    axisDepth,
    branchThicknessScale,
    cache,
    collapsedNodeModes,
    collapsedTaxonomyGroupByNode,
    collapsedView,
    collapsedNodes,
    effectiveTimeAxisScale,
    drawHoverHighlightOverlay,
    fitCamera,
    figureStyles,
    getCircularTaxonomyBitmapCache,
    getCircularTaxonomyPaths,
    getCircularBasePath,
    getEffectiveBranchColors,
    getRectBasePaths,
    fontSpec,
    labelFontFamilies,
    labelFontStyles,
    manualBranchColorOverlay,
    manualBranchColorVersion,
    metadataBranchColorOverlay,
    metadataBranchColorCacheable,
    metadataBranchColorVersion,
    metadataLabelMaxCount,
    metadataLabelMinSpacingPx,
    metadataLabelNodes,
    metadataLabelOffsetXPx,
    metadataLabelOffsetYPx,
    metadataLabels,
    metadataMarkerNodes,
    metadataMarkerNodesByOrder,
    metadataMarkerSizePx,
    metadataMarkers,
    metadataPieNodes,
    metadataPieNodesByOrder,
    metadataPieSizePx,
    metadataPies,
    metadataPieVersion,
    metadataTipTableBarWidthPx,
    metadataTipTableCellStyle,
    metadataTipTableCellWidthPx,
    metadataTipTableData,
    metadataTipTableMode,
    metadataTipTablePalette,
    order,
    phylopicEnabled,
    phylopicImageLoadVersion,
    phylopicOffsetXPx,
    phylopicOffsetYPx,
    phylopicPlacement,
    phylopicSilhouettes,
    phylopicSizeScale,
    configuredRadialSpanDegrees,
    effectiveRadialCenterOpeningRatio,
    polarAngleSpan,
    polarAngleStart,
    polarInnerRadius,
    polarLeafDivisor,
    polarOuterRadius,
    polarThetaFor,
    reservedTipLabelCharacters,
    searchQuery,
    searchMatches,
    searchMatchSet,
    errorBarCapSizePx,
    errorBarColor,
    errorBarOpacity,
    errorBarShowNodeDot,
    errorBarStyle,
    errorBarThicknessPx,
    circularCenterScaleAngleDegrees,
    extendRectScaleToTick,
    scaleLabelFontSize,
    scaleTickInterval,
    showBootstrapLabels,
    showCircularCenterRadialScaleBar,
    showTipLabels,
    showGenusLabels,
    showIntermediateScaleTicks,
    showInternalNodeLabels,
    showNodeErrorBars,
    showNodeHeightLabels,
    showScaleBars,
    showScaleZeroTick,
    showTimeStripes,
    size.height,
    size.width,
    spiralVisibleTaxonomyRanksForScale,
    spiralMetricsForScale,
    spiralTurns,
    taxonomyBandThicknessScale,
    taxonomyGapControl,
    timeStripeLineWeight,
    timeStripeStyle,
    displayTipLabelForView,
    taxonomyActiveRanks,
    taxonomyBlocks,
    taxonomyOverlayBlocks,
    taxonomyBranchColoringEnabled,
    taxonomyColorJitter,
    taxonomyColorJitterRank,
    taxonomyColorPalette,
    taxonomyColorRootRank,
    taxonomyColorRanks,
    taxonomyCustomPaletteSignature,
    taxonomyColors,
    taxonomyConsensus,
    taxonomyEnabled,
    taxonomyOverlayStyle,
    taxonomyTipRanksByNode,
    timeAxisExtent,
    effectiveTimeAxisLogBase,
    tree,
    useAutomaticTaxonomyRankVisibility,
    viewMode,
    withSupplementalTaxonomyRanks,
  ]);

  const zoomAtKeyboardAnchor = useCallback((zoom: number): void => {
    hoverRef.current = null;
    updateHoverTooltip(null);
    onHoverChange(null);
    if (!cameraRef.current) {
      fitCamera();
    }
    const pointer = lastCanvasPointerRef.current;
    const anchor = pointer
      && pointer.x >= 0
      && pointer.x <= size.width
      && pointer.y >= 0
      && pointer.y <= size.height
      ? pointer
      : { x: size.width * 0.5, y: size.height * 0.5 };
    zoomAtPoint(anchor.x, anchor.y, zoom);
    draw();
  }, [draw, fitCamera, onHoverChange, size.height, size.width, updateHoverTooltip, zoomAtPoint]);

  const buildCurrentSvgString = useCallback((): string | null => {
    if (!tree || !cache) {
      return null;
    }
    exportCaptureRef.current = {
      width: size.width,
      height: size.height,
      background: "#fbfcfe",
      elements: [],
    };
    draw();
    const scene = exportCaptureRef.current;
    exportCaptureRef.current = null;
    return scene ? buildSvgString(scene) : null;
  }, [cache, draw, size.height, size.width, tree]);

  const cameraForRenderSize = useCallback((camera: CameraState, targetSize: { width: number; height: number }): CameraState => {
    if (camera.kind === "rect") {
      const safeScaleX = Math.max(camera.scaleX, 1e-9);
      const safeScaleY = Math.max(camera.scaleY, 1e-9);
      const centerWorldX = ((size.width * 0.5) - camera.translateX) / safeScaleX;
      const centerWorldY = ((size.height * 0.5) - camera.translateY) / safeScaleY;
      const nextScaleX = camera.scaleX * (targetSize.width / Math.max(1, size.width));
      const nextScaleY = camera.scaleY * (targetSize.height / Math.max(1, size.height));
      return {
        ...camera,
        scaleX: nextScaleX,
        scaleY: nextScaleY,
        translateX: (targetSize.width * 0.5) - (centerWorldX * nextScaleX),
        translateY: (targetSize.height * 0.5) - (centerWorldY * nextScaleY),
      };
    }
    const safeScale = Math.max(camera.scale, 1e-9);
    const savedDx = ((size.width * 0.5) - camera.translateX) / safeScale;
    const savedDy = ((size.height * 0.5) - camera.translateY) / safeScale;
    const centerWorld = {
      x: (savedDx * camera.rotationCos) + (savedDy * camera.rotationSin),
      y: (-savedDx * camera.rotationSin) + (savedDy * camera.rotationCos),
    };
    const nextCamera = {
      ...camera,
      scale: camera.scale * (
        Math.min(targetSize.width, targetSize.height)
        / Math.max(1, Math.min(size.width, size.height))
      ),
    };
    setCircularCameraRotation(nextCamera, camera.rotation);
    const rotatedCenter = rotateCircularWorldPoint(nextCamera, centerWorld.x, centerWorld.y);
    nextCamera.translateX = (targetSize.width * 0.5) - (rotatedCenter.x * nextCamera.scale);
    nextCamera.translateY = (targetSize.height * 0.5) - (rotatedCenter.y * nextCamera.scale);
    return nextCamera;
  }, [size.height, size.width]);

  const downloadBlob = useCallback((blob: Blob, filename: string): void => {
    if (typeof window === "undefined") {
      return;
    }
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
  }, []);

  const blobToDataUrl = useCallback(async (blob: Blob): Promise<string> => (
    await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Unable to read exported image."));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    })
  ), []);

  const buildCurrentPngBlob = useCallback(async (
    targetPixelSize: { width: number; height: number },
    viewportCssSize?: { width?: number; height?: number },
  ): Promise<{ blob: Blob; width: number; height: number } | null> => {
    const sourceCamera = cameraRef.current;
    if (!sourceCamera || typeof window === "undefined") {
      return null;
    }
    const safeTargetPixelSize = {
      width: Math.max(320, Math.min(10000, Math.floor(Number.isFinite(targetPixelSize.width) ? targetPixelSize.width : size.width))),
      height: Math.max(320, Math.min(10000, Math.floor(Number.isFinite(targetPixelSize.height) ? targetPixelSize.height : size.height))),
    };
    const hasViewportOverride = typeof viewportCssSize?.width === "number"
      && Number.isFinite(viewportCssSize.width)
      && typeof viewportCssSize.height === "number"
      && Number.isFinite(viewportCssSize.height);
    const safeViewportCssSize = hasViewportOverride
      ? {
          width: Math.max(1, Math.min(10000, Math.floor(viewportCssSize.width as number))),
          height: Math.max(1, Math.min(10000, Math.floor(viewportCssSize.height as number))),
        }
      : null;
    const exportScale = safeViewportCssSize
      ? Math.max(
          1,
          Math.min(
            safeTargetPixelSize.width / Math.max(1, safeViewportCssSize.width),
            safeTargetPixelSize.height / Math.max(1, safeViewportCssSize.height),
          ),
        )
      : Math.max(
          1,
          Math.min(
            safeTargetPixelSize.width / Math.max(1, size.width),
            safeTargetPixelSize.height / Math.max(1, size.height),
          ),
        );
    const renderSize = safeViewportCssSize ?? {
      width: safeTargetPixelSize.width / exportScale,
      height: safeTargetPixelSize.height / exportScale,
    };
    const exportCanvas = document.createElement("canvas");
    renderCanvasOverrideRef.current = exportCanvas;
    renderSizeOverrideRef.current = renderSize;
    renderDprOverrideRef.current = exportScale;
    renderCameraOverrideRef.current = cameraForRenderSize(sourceCamera, renderSize);
    try {
      draw();
    } finally {
      renderCanvasOverrideRef.current = null;
      renderSizeOverrideRef.current = null;
      renderDprOverrideRef.current = null;
      renderCameraOverrideRef.current = null;
      draw();
    }
    const blob = await new Promise<Blob | null>((resolve) => {
      exportCanvas.toBlob(resolve, "image/png");
    });
    return blob ? { blob, width: exportCanvas.width, height: exportCanvas.height } : null;
  }, [cameraForRenderSize, draw, size.height, size.width]);

  useLayoutEffect(() => {
    latestDrawRef.current = draw;
  }, [draw]);

  const scheduleDraw = useCallback(() => {
    const benchmark = panBenchmarkRef.current;
    if (frameRequestRef.current !== null) {
      if (benchmark) {
        benchmark.coalescedScheduleCount += 1;
      }
      return;
    }
    if (benchmark) {
      benchmark.scheduledFrameAtMs = performance.now();
      benchmark.scheduledFrameCount += 1;
    }
    frameRequestRef.current = window.requestAnimationFrame(() => {
      frameRequestRef.current = null;
      latestDrawRef.current();
    });
  }, []);

  useLayoutEffect(() => {
    if (!tree || !collapsedView || collapsedNodes.size === 0) {
      pendingCollapsedRectZoomAnchorRef.current = null;
      return;
    }
    if (frameRequestRef.current !== null) {
      window.cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    }
    const pendingAnchor = pendingCollapsedRectZoomAnchorRef.current;
    const camera = cameraRef.current;
    if (pendingAnchor && camera?.kind === "rect") {
      camera.translateY = pendingAnchor.screenY
        - (collapsedView.layout.center[pendingAnchor.node] * camera.scaleY);
      clampRectCamera(camera, tree, size.width, size.height, rectClampPadding(camera));
    }
    pendingCollapsedRectZoomAnchorRef.current = null;
    draw();
  }, [collapsedNodes.size, collapsedView, draw, rectClampPadding, size.height, size.width, tree]);

  const renderRotationPreview = useCallback((nextRotation: number): boolean => {
    if (
      !tree
      || viewMode === "rectangular"
      || renderCanvasOverrideRef.current !== null
      || exportCaptureRef.current !== null
    ) {
      return false;
    }
    const canvas = canvasRef.current;
    const camera = cameraRef.current;
    const backingStore = canvasBackingStoreRef.current;
    if (!canvas || !camera || camera.kind !== "circular" || !backingStore) {
      return false;
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx || canvas.width <= 0 || canvas.height <= 0) {
      return false;
    }
    let preview = rotationPreviewRef.current;
    const previewStale = !preview
      || preview.tree !== tree
      || preview.order !== order
      || preview.viewMode !== viewMode
      || preview.backingWidth !== canvas.width
      || preview.backingHeight !== canvas.height
      || Math.abs(preview.dpr - backingStore.dpr) > 1e-6
      || Math.abs(preview.scale - camera.scale) > 1e-6
      || Math.abs(preview.translateX - camera.translateX) > 0.5
      || Math.abs(preview.translateY - camera.translateY) > 0.5;
    if (previewStale) {
      if (typeof document === "undefined") {
        return false;
      }
      const previewCanvas = document.createElement("canvas");
      previewCanvas.width = canvas.width;
      previewCanvas.height = canvas.height;
      const previewCtx = previewCanvas.getContext("2d");
      if (!previewCtx) {
        return false;
      }
      previewCtx.drawImage(canvas, 0, 0);
      preview = {
        canvas: previewCanvas,
        rotation: camera.rotation,
        translateX: camera.translateX,
        translateY: camera.translateY,
        scale: camera.scale,
        dpr: backingStore.dpr,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        viewMode,
        tree,
        order,
      };
      rotationPreviewRef.current = preview;
    }
    const activePreview = preview;
    if (!activePreview) {
      return false;
    }
    const delta = normalizeRotation(((nextRotation - activePreview.rotation) * 180) / Math.PI) * Math.PI / 180;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(activePreview.translateX * activePreview.dpr, activePreview.translateY * activePreview.dpr);
    ctx.rotate(delta);
    ctx.translate(-activePreview.translateX * activePreview.dpr, -activePreview.translateY * activePreview.dpr);
    ctx.drawImage(activePreview.canvas, 0, 0);
    ctx.restore();
    return true;
  }, [order, tree, viewMode]);

  const startPanBenchmark = useCallback((label = "manual") => {
    const previous = panBenchmarkRef.current;
    if (previous?.observer) {
      previous.observer.disconnect();
    }
    const benchmark = {
      label,
      startedAtMs: performance.now(),
      lastFrameAtMs: null,
      lastInputAtMs: null,
      scheduledFrameAtMs: null,
      scheduledFrameCount: 0,
      coalescedScheduleCount: 0,
      inputTimesMs: [] as number[],
      samples: [] as PanBenchmarkSample[],
      longTasksMs: [] as number[],
      observer: null as PerformanceObserver | null,
    };
    if (
      typeof PerformanceObserver !== "undefined"
      && Array.isArray(PerformanceObserver.supportedEntryTypes)
      && PerformanceObserver.supportedEntryTypes.includes("longtask")
    ) {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          benchmark.longTasksMs.push(entry.duration);
        });
      });
      observer.observe({ entryTypes: ["longtask"] });
      benchmark.observer = observer;
    }
    panBenchmarkRef.current = benchmark;
    return {
      label,
      startedAtMs: benchmark.startedAtMs,
    };
  }, []);

  const stopPanBenchmark = useCallback(() => {
    const benchmark = panBenchmarkRef.current;
    if (!benchmark) {
      return null;
    }
    benchmark.observer?.disconnect();
    const summary = summarizePanBenchmark(
      benchmark.label,
      benchmark.startedAtMs,
      performance.now(),
      benchmark.samples,
      benchmark.longTasksMs,
      benchmark.inputTimesMs,
      benchmark.scheduledFrameCount,
      benchmark.coalescedScheduleCount,
    );
    panBenchmarkRef.current = null;
    return summary;
  }, []);

  const markPanBenchmarkInput = useCallback(() => {
    if (!panBenchmarkRef.current) {
      return;
    }
    const now = performance.now();
    panBenchmarkRef.current.lastInputAtMs = now;
    panBenchmarkRef.current.inputTimesMs.push(now);
  }, []);

  useLayoutEffect(() => {
    if (!tree || !cache) {
      return;
    }
    const previousViewMode = previousViewModeRef.current;
    previousViewModeRef.current = viewMode;
    const previousSize = previousSizeRef.current;
    previousSizeRef.current = size;
    const previousTree = previousTreeRef.current;
    previousTreeRef.current = tree;
    const previousFitRequest = previousFitRequestRef.current;
    previousFitRequestRef.current = fitRequest;
    const currentCamera = cameraRef.current;
    const sizeChanged = previousSize.width !== size.width || previousSize.height !== size.height;
    const treeChanged = previousTree !== tree;
    const fitRequested = previousFitRequest !== fitRequest;
    if (currentCamera && sizeChanged && previousViewMode === viewMode) {
      if (currentCamera.kind === "rect") {
        clampRectCamera(currentCamera, tree, size.width, size.height, rectClampPadding(currentCamera));
      } else {
        finalizeCircularCamera(currentCamera);
      }
      draw();
      return;
    }
    if (!currentCamera || treeChanged || fitRequested) {
      fitCamera();
      return;
    }
    if (currentCamera && previousViewMode !== viewMode) {
      cameraRef.current = convertCameraForViewMode(currentCamera, previousViewMode);
      draw();
      return;
    }
    draw();
  }, [cache, convertCameraForViewMode, fitCamera, fitRequest, size, tree, viewMode]);

  useLayoutEffect(() => {
    if (!tree || handledSessionRestoreRequestRef.current === sessionRestoreRequest) {
      return;
    }
    handledSessionRestoreRequestRef.current = sessionRestoreRequest;
    if (!sessionRestoreState) {
      onSessionRestoreComplete?.();
      return;
    }
    const isValidNode = (node: number): boolean => Number.isInteger(node) && node >= 0 && node < tree.nodeCount;
    const restoredCollapsedModes = new Map<number, CollapsedNodeMode>();
    for (const [node, mode] of sessionRestoreState.collapsedNodeModes ?? []) {
      if (isValidNode(node) && tree.buffers.firstChild[node] >= 0) {
        restoredCollapsedModes.set(
          node,
          mode === "preserve-width" && viewMode !== "rectangular" ? "minimize" : mode,
        );
      }
    }
    for (const node of sessionRestoreState.collapsedNodes) {
      if (isValidNode(node) && tree.buffers.firstChild[node] >= 0 && !restoredCollapsedModes.has(node)) {
        restoredCollapsedModes.set(
          node,
          viewMode === "rectangular" ? "preserve-width" : "minimize",
        );
      }
    }
    setCollapsedNodeModes(restoredCollapsedModes);
    setManualBranchColorAssignments(new Map(
      sessionRestoreState.manualBranchColors.filter(([node, color]) => isValidNode(node) && typeof color === "string" && color.trim() !== ""),
    ));
    setManualSubtreeColorAssignments(new Map(
      sessionRestoreState.manualSubtreeColors.filter(([node, color]) => isValidNode(node) && typeof color === "string" && color.trim() !== ""),
    ));
    setTaxonomyRootColorAssignments(new Map(
      (sessionRestoreState.taxonomyRootColors ?? []).filter(([label, color]) => (
        typeof label === "string"
        && label.trim() !== ""
        && typeof color === "string"
        && color.trim() !== ""
      )),
    ));
    const camera = sessionRestoreState.camera;
    if (camera?.kind === "rect" && viewMode === "rectangular") {
      const nextCamera = restoreRectSessionCamera(camera, sessionRestoreState);
      if (!nextCamera) {
        draw();
        onSessionRestoreComplete?.();
        return;
      }
      clampRectCamera(nextCamera, tree, size.width, size.height, rectClampPadding(nextCamera));
      cameraRef.current = nextCamera;
      draw();
      onSessionRestoreComplete?.();
      return;
    }
    if (camera?.kind === "circular" && viewMode !== "rectangular") {
      const nextCamera = restoreCircularSessionCamera(camera, sessionRestoreState);
      if (!nextCamera) {
        draw();
        onSessionRestoreComplete?.();
        return;
      }
      cameraRef.current = nextCamera;
      finalizeCircularCamera(nextCamera);
      draw();
      onSessionRestoreComplete?.();
      return;
    }
    draw();
    onSessionRestoreComplete?.();
  }, [
    clampRectCamera,
    draw,
    finalizeCircularCamera,
    onSessionRestoreComplete,
    rectClampPadding,
    restoreCircularSessionCamera,
    restoreRectSessionCamera,
    sessionRestoreRequest,
    sessionRestoreState,
    size.height,
    size.width,
    tree,
    viewMode,
  ]);

  useLayoutEffect(() => {
    if (
      !tree
      || (viewMode !== "circular" && viewMode !== "fan")
      || !taxonomyEnabled
      || !taxonomyBlocks
      || !pendingCircularTaxonomyRefitRef.current
    ) {
      return;
    }
    pendingCircularTaxonomyRefitRef.current = false;
    fitCamera();
    draw();
  }, [draw, fitCamera, taxonomyBlocks, taxonomyEnabled, tree, viewMode]);

  const focusNodeTarget = useCallback((targetNode: number, focusTargetKind: "genus" | "tip" | "node") => {
    if (!tree) {
      return;
    }
    let camera = cameraRef.current;
    if (!camera || camera.kind !== (viewMode === "rectangular" ? "rect" : "circular")) {
      fitCamera();
      camera = cameraRef.current;
    }
    if (!camera) {
      return;
    }
    const layout = collapsedView?.layout ?? tree.layouts[order];
    if (camera.kind === "rect") {
      const fit = fitRectCamera(size.width, size.height, tree);
      const minTipScaleY = 10.5;
      const minGenusScaleY = 4.8;
      camera.scaleX = Math.max(camera.scaleX, fit.scaleX * (focusTargetKind === "tip" ? 2.6 : 1.9));
      camera.scaleY = Math.max(
        camera.scaleY,
        focusTargetKind === "tip"
          ? minTipScaleY
          : focusTargetKind === "genus"
            ? Math.max(minGenusScaleY, fit.scaleY * 4.8)
            : Math.max(7.2, fit.scaleY * 7.2),
      );
      const worldX = tree.buffers.depth[targetNode];
      const worldY = layout.center[targetNode];
      camera.translateX = (size.width * 0.44) - (worldX * camera.scaleX);
      camera.translateY = (size.height * 0.5) - (worldY * camera.scaleY);
      clampRectCamera(camera, tree, size.width, size.height, rectClampPadding(camera));
    } else {
      const fit = fitPolarCamera(viewMode) ?? fitCircularCamera(size.width, size.height, tree, circularRotation);
      const maxRadius = Math.max(polarOuterRadius, tree.branchLengthMinPositive);
      const tipScaleThreshold = (7.6 * polarLeafDivisor) / Math.max(1e-9, maxRadius * polarAngleSpan);
      const genusScaleThreshold = (3.4 * polarLeafDivisor) / Math.max(1e-9, maxRadius * polarAngleSpan);
      camera.scale = Math.max(
        camera.scale,
        focusTargetKind === "tip"
          ? Math.max(tipScaleThreshold, fit.scale * 4.6)
          : focusTargetKind === "genus"
            ? Math.max(genusScaleThreshold, fit.scale * 1.9)
            : Math.max(fit.scale * 2.7, genusScaleThreshold),
      );
      const theta = polarThetaFor(layout.center, targetNode);
      const point = polarToCartesian(axisDepth(tree.buffers.depth[targetNode]), theta);
      const screen = worldToScreenCircular(camera, point.x, point.y);
      camera.translateX += (size.width * 0.5) - screen.x;
      camera.translateY += (size.height * 0.5) - screen.y;
      finalizeCircularCamera(camera);
    }
    draw();
  }, [
    collapsedView,
    circularRotation,
    draw,
    finalizeCircularCamera,
    fitCamera,
    fitPolarCamera,
    order,
    polarAngleSpan,
    polarThetaFor,
    rectClampPadding,
    size.height,
    size.width,
    tree,
    viewMode,
  ]);

  const zoomToSubtreeTarget = useCallback((targetNode: number) => {
    if (!tree) {
      return;
    }
    if (tree.buffers.firstChild[targetNode] < 0 || tree.buffers.leafCount[targetNode] <= 2) {
      focusNodeTarget(targetNode, "tip");
      return;
    }
    if (viewMode === "circular" || viewMode === "fan") {
      pendingRectSubtreeZoomTargetRef.current = targetNode;
      onViewModeChange?.("rectangular");
      return;
    }
    let camera = cameraRef.current;
    if (!camera || camera.kind !== (viewMode === "rectangular" ? "rect" : "circular")) {
      fitCamera();
      camera = cameraRef.current;
    }
    if (!camera) {
      return;
    }
    const layout = collapsedView?.layout ?? tree.layouts[order];
    const subtreeMaxDepth = measureSubtreeMaxDepth(tree, targetNode);
    if (camera.kind === "rect") {
      const padLeft = 52;
      const padTop = 38;
      const padBottom = 52;
      const minX = tree.buffers.depth[targetNode];
      const maxX = subtreeMaxDepth;
      const minY = layout.min[targetNode];
      const maxY = layout.max[targetNode];
      const usableHeight = Math.max(1, size.height - padTop - padBottom);
      let padRight = 48;
      for (let iteration = 0; iteration < 2; iteration += 1) {
        const usableWidth = Math.max(1, size.width - padLeft - padRight);
        const scaleX = usableWidth / Math.max(maxX - minX, tree.branchLengthMinPositive);
        const scaleY = usableHeight / Math.max(maxY - minY, 1);
        padRight = Math.max(48, rectClampPadding({
          kind: "rect",
          scaleX,
          scaleY,
          translateX: 0,
          translateY: 0,
        }).right ?? 0);
      }
      const usableWidth = Math.max(1, size.width - padLeft - padRight);
      camera.scaleX = usableWidth / Math.max(maxX - minX, tree.branchLengthMinPositive);
      camera.scaleY = usableHeight / Math.max(maxY - minY, 1);
      camera.translateX = padLeft - (minX * camera.scaleX);
      camera.translateY = padTop - (minY * camera.scaleY);
    } else {
      const fit = fitPolarCamera(viewMode) ?? fitCircularCamera(size.width, size.height, tree, circularRotation);
      const startTheta = polarThetaFor(layout.min, targetNode);
      let endTheta = polarThetaFor(layout.max, targetNode);
      if (endTheta < startTheta) {
        endTheta += Math.PI * 2;
      }
      const midTheta = startTheta + ((endTheta - startTheta) * 0.5);
      const angularSpan = Math.max(
        polarAngleSpan / Math.max(1, tree.leafCount),
        endTheta - startTheta,
      );
      const desiredArcPx = Math.min(size.width, size.height) * 0.72;
      const desiredScale = desiredArcPx / Math.max(subtreeMaxDepth * angularSpan, tree.branchLengthMinPositive);
      camera.scale = Math.max(fit.scale * 1.2, desiredScale);
      const radius = (tree.buffers.depth[targetNode] + subtreeMaxDepth) * 0.5;
      const point = polarToCartesian(radius, midTheta);
      const screen = worldToScreenCircular(camera, point.x, point.y);
      camera.translateX += (size.width * 0.5) - screen.x;
      camera.translateY += (size.height * 0.5) - screen.y;
    }
    draw();
  }, [
    circularRotation,
    draw,
    fitCamera,
    fitPolarCamera,
    focusNodeTarget,
    order,
    size.height,
    size.width,
    tree,
    onViewModeChange,
    polarAngleSpan,
    polarThetaFor,
    viewMode,
  ]);

  useLayoutEffect(() => {
    if (viewMode !== "rectangular") {
      return;
    }
    const targetNode = pendingRectSubtreeZoomTargetRef.current;
    if (targetNode === null) {
      return;
    }
    pendingRectSubtreeZoomTargetRef.current = null;
    zoomToSubtreeTarget(targetNode);
  }, [viewMode, zoomToSubtreeTarget]);

  useLayoutEffect(() => {
    const camera = cameraRef.current;
    if (rotationPreviewCommitTimerRef.current !== null) {
      window.clearTimeout(rotationPreviewCommitTimerRef.current);
      rotationPreviewCommitTimerRef.current = null;
    }
    if (!camera || camera.kind !== "circular") {
      rotationPreviewRef.current = null;
      return;
    }
    setCircularCameraRotation(camera, circularRotation);
    const previewRendered = renderRotationPreview(circularRotation);
    if (!previewRendered) {
      rotationPreviewRef.current = null;
      draw();
      return;
    }
    rotationPreviewCommitTimerRef.current = window.setTimeout(() => {
      rotationPreviewCommitTimerRef.current = null;
      rotationPreviewRef.current = null;
      draw();
    }, ROTATION_PREVIEW_SETTLE_DELAY_MS);
  }, [circularRotation, draw, renderRotationPreview]);

  useLayoutEffect(() => {
    if (!tree || focusNodeRequest === 0 || handledFocusRequestRef.current === focusNodeRequest) {
      return;
    }
    const targetNode = activeSearchTaxonomyNode ?? activeSearchGenusCenterNode ?? activeSearchNode;
    if (targetNode === null) {
      return;
    }
    handledFocusRequestRef.current = focusNodeRequest;
    if (activeSearchTaxonomyNode !== null) {
      zoomToSubtreeTarget(targetNode);
      return;
    }
    const focusTargetKind = activeSearchGenusCenterNode !== null
      ? "genus"
      : tree.buffers.firstChild[targetNode] < 0
        ? "tip"
        : "node";
    focusNodeTarget(targetNode, focusTargetKind);
  }, [
    activeSearchTaxonomyNode,
    activeSearchGenusCenterNode,
    activeSearchNode,
    focusNodeRequest,
    focusNodeTarget,
    order,
    tree,
    zoomToSubtreeTarget,
  ]);

  useLayoutEffect(() => {
    draw();
  }, [draw, fitRequest]);

  useEffect(() => {
    if (!tree || typeof window === "undefined") {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableEventTarget(event.target)) {
        return;
      }
      if (event.key === "+" || event.code === "NumpadAdd") {
        event.preventDefault();
        zoomAtKeyboardAnchor(1.2);
        return;
      }
      if (event.key === "-" || event.code === "NumpadSubtract") {
        event.preventDefault();
        zoomAtKeyboardAnchor(1 / 1.2);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [tree, zoomAtKeyboardAnchor]);

  useEffect(() => {
    if (exportSvgRequest === 0 || handledExportRequestRef.current === exportSvgRequest) {
      return;
    }
    handledExportRequestRef.current = exportSvgRequest;
    const canvas = canvasRef.current;
    if (!canvas || typeof window === "undefined") {
      return;
    }
    const svg = buildCurrentSvgString();
    if (!svg) {
      return;
    }
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    downloadBlob(blob, exportSvgFilename || `big-tree-view-${viewMode}.svg`);
  }, [buildCurrentSvgString, downloadBlob, exportSvgFilename, exportSvgRequest, viewMode]);

  useEffect(() => {
    if (exportPngRequest === 0 || handledPngExportRequestRef.current === exportPngRequest) {
      return;
    }
    handledPngExportRequestRef.current = exportPngRequest;
    void buildCurrentPngBlob({ width: exportPngWidth, height: exportPngHeight }).then((result) => {
      if (result) {
        downloadBlob(result.blob, exportPngFilename || `big-tree-view-${viewMode}.png`);
      }
    });
  }, [buildCurrentPngBlob, downloadBlob, exportPngFilename, exportPngHeight, exportPngRequest, exportPngWidth, viewMode]);

  useEffect(() => {
    const request = automationExportRequest;
    if (!request || request.id === 0 || handledAutomationExportRequestRef.current === request.id) {
      return;
    }
    handledAutomationExportRequestRef.current = request.id;
    const filename = request.filename || `big-tree-view-${viewMode}.${request.format}`;
    void (async () => {
      try {
        if (request.format === "svg") {
          const svg = buildCurrentSvgString();
          if (!svg) {
            throw new Error("Unable to build SVG export.");
          }
          const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
          if (request.delivery === "download") {
            downloadBlob(blob, filename);
          }
          onAutomationExportComplete?.({
            id: request.id,
            format: request.format,
            delivery: request.delivery,
            filename,
            mimeType: "image/svg+xml;charset=utf-8",
            ok: true,
            text: svg,
            width: size.width,
            height: size.height,
          });
          return;
        }
        const result = await buildCurrentPngBlob({
          width: request.width ?? exportPngWidth,
          height: request.height ?? exportPngHeight,
        }, {
          width: request.viewportWidth,
          height: request.viewportHeight,
        });
        if (!result) {
          throw new Error("Unable to build PNG export.");
        }
        if (request.delivery === "download") {
          downloadBlob(result.blob, filename);
        }
        onAutomationExportComplete?.({
          id: request.id,
          format: request.format,
          delivery: request.delivery,
          filename,
          mimeType: "image/png",
          ok: true,
          dataUrl: await blobToDataUrl(result.blob),
          width: result.width,
          height: result.height,
        });
      } catch (error) {
        onAutomationExportComplete?.({
          id: request.id,
          format: request.format,
          delivery: request.delivery,
          filename,
          mimeType: request.format === "svg" ? "image/svg+xml;charset=utf-8" : "image/png",
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [
    automationExportRequest,
    blobToDataUrl,
    buildCurrentPngBlob,
    buildCurrentSvgString,
    downloadBlob,
    exportPngHeight,
    exportPngWidth,
    onAutomationExportComplete,
    size.height,
    size.width,
    viewMode,
  ]);

  useEffect(() => () => {
    if (frameRequestRef.current !== null) {
      window.cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    }
    if (rotationPreviewCommitTimerRef.current !== null) {
      window.clearTimeout(rotationPreviewCommitTimerRef.current);
      rotationPreviewCommitTimerRef.current = null;
    }
    rotationPreviewRef.current = null;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tree || !cache) {
      return undefined;
    }
    const wheelElement = wrapperRef.current ?? canvas;
    const layout = collapsedView?.layout ?? tree.layouts[order];
    const children = cache.orderedChildren[order];
    const visibleTerminalNodes = collapsedView?.visibleTerminalNodes ?? cache.orderedLeaves[order];
    const rectHitIndex = collapsedSpatialCache?.rectIndex ?? cache.rectIndices[order];
    const circularHitIndex = collapsedSpatialCache?.circularIndex ?? cache.circularIndices[order];
    const findLabelHitboxAt = (localX: number, localY: number): LabelHitbox | null => {
      const collapsedTriangle = collapsedTriangleHitsRef.current.find((triangle) => (
        pointInCollapsedTriangleHitArea(localX, localY, triangle.points)
      ));
      if (collapsedTriangle) {
        const triangleHitbox = labelHitsRef.current.find((hitbox) => (
          hitbox.node === collapsedTriangle.node
          && hitbox.source === "collapse"
          && hitbox.labelKind === "taxonomy"
        )) ?? labelHitsRef.current.find((hitbox) => (
          hitbox.node === collapsedTriangle.node
          && hitbox.source === "collapse"
        ));
        if (triangleHitbox) {
          return triangleHitbox;
        }
      }
      let fallback: LabelHitbox | null = null;
      for (let index = labelHitsRef.current.length - 1; index >= 0; index -= 1) {
        const hitbox = labelHitsRef.current[index];
        if (hitbox.source === "collapse" && hitbox.collapsePart === "triangle") {
          continue;
        }
        if (!pointInLabelHitbox(localX, localY, hitbox)) {
          continue;
        }
        if (hitbox.labelKind === "taxonomy") {
          return hitbox;
        }
        fallback ??= hitbox;
      }
      return fallback;
    };
    const findPhyloPicHitboxAt = (localX: number, localY: number): PhyloPicHitbox | null => {
      for (let index = phylopicHitsRef.current.length - 1; index >= 0; index -= 1) {
        const hitbox = phylopicHitsRef.current[index];
        if (
          localX >= hitbox.x
          && localX <= hitbox.x + hitbox.width
          && localY >= hitbox.y
          && localY <= hitbox.y + hitbox.height
        ) {
          return hitbox;
        }
      }
      return null;
    };
    const findTaxonomyArcHitboxAt = (localX: number, localY: number): TaxonomyArcHitbox | null => {
      const camera = cameraRef.current;
      if (!camera) {
        return null;
      }
      for (let index = taxonomyArcHitsRef.current.length - 1; index >= 0; index -= 1) {
        const hitbox = taxonomyArcHitsRef.current[index];
        if (!hitbox.screenPolygonPoints || hitbox.screenPolygonPoints.length < 3) {
          continue;
        }
        const bounds = hitbox.screenPolygonBounds ?? polygonBounds(hitbox.screenPolygonPoints);
        if (
          localX >= bounds.left
          && localX <= bounds.right
          && localY >= bounds.top
          && localY <= bounds.bottom
          && pointInPolygon(localX, localY, hitbox.screenPolygonPoints)
        ) {
          return hitbox;
        }
      }
      const polygonTolerancePx = 2;
      for (let index = taxonomyArcHitsRef.current.length - 1; index >= 0; index -= 1) {
        const hitbox = taxonomyArcHitsRef.current[index];
        if (!hitbox.screenPolygonPoints || hitbox.screenPolygonPoints.length < 3) {
          continue;
        }
        const bounds = hitbox.screenPolygonBounds ?? polygonBounds(hitbox.screenPolygonPoints);
        if (
          localX >= bounds.left - polygonTolerancePx
          && localX <= bounds.right + polygonTolerancePx
          && localY >= bounds.top - polygonTolerancePx
          && localY <= bounds.bottom + polygonTolerancePx
          && pointInPolygonHitArea(localX, localY, hitbox.screenPolygonPoints, polygonTolerancePx)
        ) {
          return hitbox;
        }
      }
      if (camera.kind !== "circular") {
        return null;
      }
      const radius = Math.hypot(localX - camera.translateX, localY - camera.translateY);
      const theta = wrapPositive(Math.atan2(localY - camera.translateY, localX - camera.translateX));
      for (let index = taxonomyArcHitsRef.current.length - 1; index >= 0; index -= 1) {
        const hitbox = taxonomyArcHitsRef.current[index];
        if (hitbox.screenPolygonPoints && hitbox.screenPolygonPoints.length >= 3) {
          continue;
        }
        if (
          radius >= hitbox.innerRadiusPx
          && radius <= hitbox.outerRadiusPx
          && wrappedAngleWithinInterval(theta, hitbox.startTheta, hitbox.endTheta)
        ) {
          return hitbox;
        }
      }
      return null;
    };
    const taxonomyHoverInfoFromArcHitbox = (hitbox: TaxonomyArcHitbox, localX: number, localY: number): CanvasHoverInfo => {
      const mrcaNode = resolveTaxonomySegmentNode(
        hitbox.rank,
        hitbox.label,
        hitbox.taxId,
        hitbox.firstNode,
        hitbox.lastNode,
        hitbox.startIndex,
        hitbox.endIndex,
      ) ?? lowestCommonAncestor(tree, hitbox.firstNode, hitbox.lastNode);
      const parent = tree.buffers.parent[mrcaNode];
      const mrcaAge = tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[mrcaNode]) : null;
      return {
        node: mrcaNode,
        branchLength: tree.buffers.branchLength[mrcaNode],
        parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
        parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
        childAge: mrcaAge,
        descendantTipCount: tree.buffers.leafCount[mrcaNode],
        name: hitbox.label,
        screenX: localX,
        screenY: localY,
        targetKind: "label",
        kind: "taxonomy",
        taxonomyRank: hitbox.rank,
        mrcaAge,
      };
    };

    const hitTestAt = (localX: number, localY: number): CanvasHoverInfo | null => {
      const camera = cameraRef.current;
      if (!camera) {
        return null;
      }
      const branchHoverEnabled = isBranchHoverEnabled(camera);
      const skipSpatialBranchHitTesting = tree.leafCount > HUGE_TREE_TIP_LIMIT;
      const tipDepth = tree.isUltrametric ? tree.rootAge : tree.maxDepth;
      let hover: CanvasHoverInfo | null = null;
      const buildHoverInfo = (
        node: number,
        targetKind: "label" | "stem" | "connector",
        screenX: number,
        screenY: number,
        hoveredSegment?: CanvasHoverInfo["hoveredSegment"],
        ownerNode?: number,
      ): CanvasHoverInfo => {
        const parent = tree.buffers.parent[node];
        const collapsedTaxonomySummary = collapsedTipTaxonomySummaryByNode.get(node) ?? null;
        return {
          node,
          branchLength: tree.buffers.branchLength[node],
          parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
          parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
          childAge: tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[node]) : null,
          name: displayNodeNameForView(node),
          descendantTipCount: descendantTipCountForView(node),
          screenX,
          screenY,
          targetKind,
          hoveredSegment,
          ownerNode,
          collapsedTaxonomyRank: collapsedTaxonomySummary?.rank ?? null,
          collapsedTaxonomyDescendantTipCount: collapsedTaxonomySummary?.descendantTipCount ?? null,
          collapsedTaxonomyMrcaAge: collapsedTaxonomySummary?.mrcaAge ?? null,
        };
      };

      const phylopicHitbox = findPhyloPicHitboxAt(localX, localY);
      if (
        phylopicHitbox
        && typeof phylopicHitbox.firstNode === "number"
        && typeof phylopicHitbox.lastNode === "number"
      ) {
        const mrcaNode = lowestCommonAncestor(tree, phylopicHitbox.firstNode, phylopicHitbox.lastNode);
        const parent = tree.buffers.parent[mrcaNode];
        const mrcaAge = tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[mrcaNode]) : null;
        return {
          node: mrcaNode,
          branchLength: tree.buffers.branchLength[mrcaNode],
          parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
          parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
          childAge: mrcaAge,
          descendantTipCount: phylopicHitbox.taxonomyTipCount ?? tree.buffers.leafCount[mrcaNode],
          name: phylopicHitbox.taxonLabel,
          screenX: localX,
          screenY: localY,
          targetKind: "label",
          kind: "taxonomy",
          taxonomyRank: phylopicHitbox.rank,
          mrcaAge,
        };
      }

      const labelHitbox = findLabelHitboxAt(localX, localY);
      if (labelHitbox) {
        const hitbox = labelHitbox;
        if (
          hitbox.labelKind === "taxonomy"
          && hitbox.text
          && hitbox.taxonomyRank
          && typeof hitbox.taxonomyFirstNode === "number"
          && typeof hitbox.taxonomyLastNode === "number"
        ) {
          const mrcaNode = hitbox.taxonomyCollapseNode ?? resolveTaxonomySegmentNode(
            hitbox.taxonomyRank as TaxonomyRank,
            hitbox.text,
            hitbox.taxonomyTaxId ?? null,
            hitbox.taxonomyFirstNode,
            hitbox.taxonomyLastNode,
            hitbox.taxonomyStartIndex,
            hitbox.taxonomyEndIndex,
          ) ?? lowestCommonAncestor(tree, hitbox.taxonomyFirstNode, hitbox.taxonomyLastNode);
          const parent = tree.buffers.parent[mrcaNode];
          const mrcaAge = tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[mrcaNode]) : null;
          hover = {
            node: mrcaNode,
            branchLength: tree.buffers.branchLength[mrcaNode],
            parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
            parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
            childAge: mrcaAge,
            descendantTipCount: tree.buffers.leafCount[mrcaNode],
            name: hitbox.text,
            screenX: localX,
            screenY: localY,
            targetKind: "label",
            kind: "taxonomy",
            taxonomyRank: hitbox.taxonomyRank,
            mrcaAge,
          };
        } else {
          hover = buildHoverInfo(hitbox.node, "label", localX, localY);
        }
      }

      if (hover) {
        return hover;
      }
      const taxonomyArcHitbox = findTaxonomyArcHitboxAt(localX, localY);
      if (taxonomyArcHitbox) {
        return taxonomyHoverInfoFromArcHitbox(taxonomyArcHitbox, localX, localY);
      }
      if (viewMode === "spiral") {
        if (camera.kind !== "circular") {
          return null;
        }
        const visibleRankCount = spiralVisibleTaxonomyRanksForScale(camera.scale).length;
        const metrics = spiralMetricsForScale(visibleRankCount, camera.scale);
        const world = screenToWorldCircular(camera, localX, localY);
        const hoverTheta = closestSpiralThetaForPoint(world.x, world.y, metrics);
        const targetCenter = spiralArcFractionForTheta(hoverTheta, metrics) * Math.max(1, tree.leafCount - 1);
        const orderedLeaves = visibleTerminalNodes;
        const insertionIndex = lowerBoundLeaves(orderedLeaves, layout.center, targetCenter);
        const thresholdSq = 36;
        let bestDistance = Number.POSITIVE_INFINITY;
        const testedConnectors = new Set<string>();
        const screenPointForNodeDepth = (node: number, depth: number): { x: number; y: number } => {
          const theta = spiralThetaForY(layout.center[node], tree.leafCount, metrics);
          const point = spiralPointAt(theta, spiralAgeForDepth(tree, depth, metrics), metrics);
          return worldToScreenCircular(camera, point.x, point.y);
        };
        const distanceToSpiralConnector = (ownerNode: number, childNode: number): number => {
          const ownerTheta = spiralThetaForY(layout.center[ownerNode], tree.leafCount, metrics);
          const childTheta = spiralThetaForY(layout.center[childNode], tree.leafCount, metrics);
          const startTheta = Math.min(ownerTheta, childTheta);
          const endTheta = Math.max(ownerTheta, childTheta);
          const spanPx = Math.abs(spiralArcLengthBetween(
            startTheta - metrics.startTheta,
            endTheta - metrics.startTheta,
            metrics.innerRadius + spiralOffsetForAge(spiralAgeForDepth(tree, tree.buffers.depth[ownerNode], metrics), metrics),
            metrics.pitchPerRadian,
          )) * camera.scale;
          const sampleCount = Math.max(2, Math.min(28, Math.ceil(spanPx / 18)));
          let previous = spiralToScreenPoint(startTheta, ownerNode);
          let best = Number.POSITIVE_INFINITY;
          for (let sample = 1; sample <= sampleCount; sample += 1) {
            const theta = startTheta + (((endTheta - startTheta) * sample) / sampleCount);
            const current = spiralToScreenPoint(theta, ownerNode);
            best = Math.min(best, distanceToSegmentSquared(localX, localY, previous.x, previous.y, current.x, current.y));
            previous = current;
          }
          return best;
        };
        const spiralToScreenPoint = (theta: number, ownerNode: number): { x: number; y: number } => {
          const point = spiralPointAt(theta, spiralAgeForDepth(tree, tree.buffers.depth[ownerNode], metrics), metrics);
          return worldToScreenCircular(camera, point.x, point.y);
        };
        for (let offset = -4; offset <= 4; offset += 1) {
          const candidateIndex = insertionIndex + offset;
          if (candidateIndex < 0 || candidateIndex >= orderedLeaves.length) {
            continue;
          }
          let node = orderedLeaves[candidateIndex];
          let depthGuard = 0;
          while (node >= 0 && depthGuard < 256) {
            depthGuard += 1;
            if (hiddenNodesRef.current?.[node]) {
              break;
            }
            const parent = tree.buffers.parent[node];
            if (parent < 0) {
              break;
            }
            const stemStart = screenPointForNodeDepth(node, tree.buffers.depth[parent]);
            const stemEnd = screenPointForNodeDepth(node, tree.buffers.depth[node]);
            const stemDistance = distanceToSegmentSquared(localX, localY, stemStart.x, stemStart.y, stemEnd.x, stemEnd.y);
            if (stemDistance < bestDistance && stemDistance <= thresholdSq) {
              bestDistance = stemDistance;
              hover = buildHoverInfo(node, "stem", localX, localY);
            }
            if (!collapsedNodes.has(parent)) {
              const connectorKey = `${parent}:${node}`;
              if (!testedConnectors.has(connectorKey)) {
                testedConnectors.add(connectorKey);
                const connectorDistance = distanceToSpiralConnector(parent, node);
                if (connectorDistance < bestDistance && connectorDistance <= thresholdSq) {
                  bestDistance = connectorDistance;
                  hover = buildHoverInfo(node, "connector", localX, localY, undefined, parent);
                }
              }
            }
            node = parent;
          }
        }
        return hover;
      }

      if (camera.kind === "rect" && !branchHoverEnabled) {
        const world = screenToWorldRect(camera, localX, localY);
        const orderedLeaves = visibleTerminalNodes;
        const insertionIndex = lowerBoundLeaves(orderedLeaves, layout.center, world.y);
        let bestDistance = Number.POSITIVE_INFINITY;
        const threshold = 16;
        for (let offset = -1; offset <= 1; offset += 1) {
          const candidateIndex = insertionIndex + offset;
          if (candidateIndex < 0 || candidateIndex >= orderedLeaves.length) {
            continue;
          }
          const node = orderedLeaves[candidateIndex];
          if (hiddenNodesRef.current?.[node] || (tree.buffers.firstChild[node] >= 0 && !collapsedNodes.has(node))) {
            continue;
          }
          const parent = tree.buffers.parent[node];
          if (parent < 0) {
            continue;
          }
          const y = layout.center[node];
          const start = worldToScreenRect(camera, tree.buffers.depth[parent], y);
          const end = worldToScreenRect(camera, tree.buffers.depth[node], y);
          const distance = distanceToSegmentSquared(localX, localY, start.x, start.y, end.x, end.y);
          if (distance < bestDistance && distance <= threshold) {
            bestDistance = distance;
            hover = buildHoverInfo(node, "stem", localX, localY);
          }
        }
        if (hover) {
          return hover;
        }

        const tipScreenX = camera.translateX + (tipDepth * camera.scaleX);
        if (!skipSpatialBranchHitTesting && localX <= tipScreenX - threshold) {
          const candidates = rectHitIndex.queryPoint(world.x, world.y, 1, 1);
          bestDistance = Number.POSITIVE_INFINITY;
          for (let index = 0; index < candidates.length; index += 1) {
            const segment = candidates[index];
            if (hiddenNodesRef.current?.[segment.node] || (segment.kind === "connector" && collapsedNodes.has(segment.node))) {
              continue;
            }
            if (segment.kind === "stem" && tree.buffers.firstChild[segment.node] < 0) {
              continue;
            }
            const start = worldToScreenRect(camera, segment.x1, segment.y1);
            const end = worldToScreenRect(camera, segment.x2, segment.y2);
            const visibleSpanPx = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
            if (visibleSpanPx < 1) {
              continue;
            }
            const minScreenX = Math.min(start.x, end.x) - threshold;
            const maxScreenX = Math.max(start.x, end.x) + threshold;
            const minScreenY = Math.min(start.y, end.y) - threshold;
            const maxScreenY = Math.max(start.y, end.y) + threshold;
            if (localX < minScreenX || localX > maxScreenX || localY < minScreenY || localY > maxScreenY) {
              continue;
            }
            const distance = distanceToSegmentSquared(localX, localY, start.x, start.y, end.x, end.y);
            if (distance < bestDistance) {
              bestDistance = distance;
              if (distance <= threshold) {
                if (segment.kind === "connector") {
                  const ownerNode = segment.node;
                  const childNode = pickRectConnectorChild(children[ownerNode], layout.center, layout.center[ownerNode], world.y);
                  if (childNode !== null) {
                    hover = buildHoverInfo(childNode, "connector", localX, localY, segment, ownerNode);
                  }
                } else {
                  hover = buildHoverInfo(segment.node, "stem", localX, localY);
                }
              }
            }
          }
          if (hover) {
            return hover;
          }
        }
      }

      if (camera.kind === "circular" && !branchHoverEnabled) {
        const world = screenToWorldCircular(camera, localX, localY);
        let hoverTheta = wrapPositive(Math.atan2(world.y, world.x));
        if (isPartialRadial && hoverTheta < polarAngleStart) {
          hoverTheta += Math.PI * 2;
        }
        const orderedLeaves = visibleTerminalNodes;
        const targetCenter = ((hoverTheta - polarAngleStart) / polarAngleSpan)
          * polarLeafDivisor;
        const insertionIndex = lowerBoundLeaves(orderedLeaves, layout.center, targetCenter);
        let bestDistance = Number.POSITIVE_INFINITY;
        const threshold = 16;
        for (let offset = -1; offset <= 1; offset += 1) {
          const candidateIndex = isPartialRadial
            ? Math.max(0, Math.min(orderedLeaves.length - 1, insertionIndex + offset))
            : (insertionIndex + offset + orderedLeaves.length) % orderedLeaves.length;
          const node = orderedLeaves[candidateIndex];
          if (hiddenNodesRef.current?.[node] || (tree.buffers.firstChild[node] >= 0 && !collapsedNodes.has(node))) {
            continue;
          }
          const parent = tree.buffers.parent[node];
          if (parent < 0) {
            continue;
          }
          const theta = polarThetaFor(layout.center, node);
          const startWorld = polarToCartesian(axisDepth(tree.buffers.depth[parent]), theta);
          const endWorld = polarToCartesian(axisDepth(tree.buffers.depth[node]), theta);
          const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
          const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
          const distance = distanceToSegmentSquared(localX, localY, start.x, start.y, end.x, end.y);
          if (distance < bestDistance && distance <= threshold) {
            bestDistance = distance;
            hover = buildHoverInfo(node, "stem", localX, localY);
          }
        }
        if (hover) {
          return hover;
        }

        const tipRadiusPx = tipDepth * camera.scale;
        const pointerRadiusPx = Math.hypot(localX - camera.translateX, localY - camera.translateY);
        if (!skipSpatialBranchHitTesting && pointerRadiusPx <= tipRadiusPx - threshold) {
          const radius = 6 / camera.scale;
          const candidates = circularHitIndex.query(world.x, world.y, radius, radius);
          bestDistance = Number.POSITIVE_INFINITY;
          for (let index = 0; index < candidates.length; index += 1) {
            const segment = candidates[index];
            if (hiddenNodesRef.current?.[segment.node] || (segment.kind === "connector" && collapsedNodes.has(segment.node))) {
              continue;
            }
            if (segment.kind === "stem" && tree.buffers.firstChild[segment.node] < 0) {
              continue;
            }
            const start = worldToScreenCircular(camera, segment.x1, segment.y1);
            const end = worldToScreenCircular(camera, segment.x2, segment.y2);
            const visibleSpanPx = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
            if (visibleSpanPx < 1) {
              continue;
            }
            const distance = distanceToSegmentSquared(localX, localY, start.x, start.y, end.x, end.y);
            if (distance < bestDistance && distance <= threshold) {
              bestDistance = distance;
              if (segment.kind === "connector") {
                const ownerNode = segment.node;
                const ownerTheta = polarThetaFor(layout.center, ownerNode);
                const arcStart = polarThetaFor(layout.min, ownerNode);
                const arcEnd = polarThetaFor(layout.max, ownerNode);
                const arcLength = Math.max(0, arcEnd - arcStart);
                const childNode = pickCircularConnectorChild(
                  children[ownerNode],
                  layout.center,
                  hoverTheta,
                  ownerTheta,
                  tree.leafCount,
                  arcStart,
                  arcLength,
                  polarAngleStart,
                  polarAngleSpan,
                );
                if (childNode !== null) {
                  hover = buildHoverInfo(childNode, "connector", localX, localY, segment, ownerNode);
                }
              } else {
                hover = buildHoverInfo(segment.node, "stem", localX, localY);
              }
            }
          }
          if (hover) {
            return hover;
          }
        }
      }

      if (camera.kind === "rect" && branchHoverEnabled) {
        const world = screenToWorldRect(camera, localX, localY);
        const candidates = rectHitIndex.queryPoint(world.x, world.y, 1, 1);
        let bestDistance = Number.POSITIVE_INFINITY;
        const threshold = 16;
        for (let index = 0; index < candidates.length; index += 1) {
          const segment = candidates[index];
          if (hiddenNodesRef.current?.[segment.node] || (segment.kind === "connector" && collapsedNodes.has(segment.node))) {
            continue;
          }
          const start = worldToScreenRect(camera, segment.x1, segment.y1);
          const end = worldToScreenRect(camera, segment.x2, segment.y2);
          const minScreenX = Math.min(start.x, end.x) - threshold;
          const maxScreenX = Math.max(start.x, end.x) + threshold;
          const minScreenY = Math.min(start.y, end.y) - threshold;
          const maxScreenY = Math.max(start.y, end.y) + threshold;
          if (localX < minScreenX || localX > maxScreenX || localY < minScreenY || localY > maxScreenY) {
            continue;
          }
          const distance = distanceToSegmentSquared(localX, localY, start.x, start.y, end.x, end.y);
          if (distance < bestDistance) {
            bestDistance = distance;
            if (distance <= threshold) {
              if (segment.kind === "connector") {
                const ownerNode = segment.node;
                const childNode = pickRectConnectorChild(children[ownerNode], layout.center, layout.center[ownerNode], world.y);
                if (childNode !== null) {
                  hover = buildHoverInfo(childNode, "connector", localX, localY, segment, ownerNode);
                }
              } else {
                hover = buildHoverInfo(segment.node, "stem", localX, localY);
              }
            }
          }
        }
      } else if (camera.kind === "circular" && branchHoverEnabled) {
        const world = screenToWorldCircular(camera, localX, localY);
        const radius = 6 / camera.scale;
        const candidates = circularHitIndex.query(world.x, world.y, radius, radius);
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < candidates.length; index += 1) {
          const segment = candidates[index];
          if (hiddenNodesRef.current?.[segment.node] || (segment.kind === "connector" && collapsedNodes.has(segment.node))) {
            continue;
          }
          const start = worldToScreenCircular(camera, segment.x1, segment.y1);
          const end = worldToScreenCircular(camera, segment.x2, segment.y2);
          const distance = distanceToSegmentSquared(localX, localY, start.x, start.y, end.x, end.y);
          if (distance < bestDistance && distance <= 16) {
            bestDistance = distance;
            if (segment.kind === "connector") {
              const ownerNode = segment.node;
              const ownerTheta = polarThetaFor(layout.center, ownerNode);
              const arcStart = polarThetaFor(layout.min, ownerNode);
              const arcEnd = polarThetaFor(layout.max, ownerNode);
              const arcLength = Math.max(0, arcEnd - arcStart);
              const hoverTheta = wrapPositive(Math.atan2(world.y, world.x));
              const childNode = pickCircularConnectorChild(
                children[ownerNode],
                layout.center,
                hoverTheta,
                ownerTheta,
                tree.leafCount,
                arcStart,
                arcLength,
                polarAngleStart,
                polarAngleSpan,
              );
              if (childNode !== null) {
                hover = buildHoverInfo(childNode, "connector", localX, localY, segment, ownerNode);
              }
            } else {
              hover = buildHoverInfo(segment.node, "stem", localX, localY);
            }
          }
        }
      }
      return hover;
    };
    hoverProbeRef.current = hitTestAt;

    const updateHover = (event: PointerEvent): void => {
      const camera = cameraRef.current;
      if (!camera) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const hover = hitTestAt(localX, localY);
      const prev = hoverRef.current;
      const identityChanged = (
        prev?.node !== hover?.node ||
        prev?.targetKind !== hover?.targetKind ||
        prev?.ownerNode !== hover?.ownerNode ||
        prev?.kind !== hover?.kind ||
        prev?.taxonomyRank !== hover?.taxonomyRank
      );
      const collapsedHoverMoved = Boolean(
        !identityChanged
        && hover
        && prev
        && collapsedNodes.has(hover.node)
        && (hover.screenX !== prev.screenX || hover.screenY !== prev.screenY),
      );
      hoverRef.current = hover;
      if (identityChanged) {
        updateHoverTooltip(hover);
        onHoverChange(hover);
      }
      if (identityChanged || collapsedHoverMoved) {
        drawHoverHighlightOverlay();
      }
    };

    const clearHoverState = (): void => {
      hoverRef.current = null;
      updateHoverTooltip(null);
      onHoverChange(null);
      drawHoverHighlightOverlay();
    };

    const handlePointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) {
        return;
      }
      if (event.pointerType === "touch") {
        event.preventDefault();
      }
      setContextMenu(null);
      clearLongPress();
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      lastCanvasPointerRef.current = { x: localX, y: localY };
      if (distanceStartNodeRef.current !== null) {
        clearDistanceMeasurement();
        return;
      }
      for (let index = labelHitsRef.current.length - 1; index >= 0; index -= 1) {
        const hitbox = labelHitsRef.current[index];
        if (hitbox.source !== "collapse") {
          continue;
        }
        if (hitbox.collapsePart === "triangle") {
          const triangle = collapsedTriangleHitsRef.current.find((candidate) => (
            candidate.node === hitbox.node
          ));
          if (!triangle || !pointInCollapsedTriangleHitArea(localX, localY, triangle.points)) {
            continue;
          }
        } else if (!pointInLabelHitbox(localX, localY, hitbox)) {
          continue;
        }
        toggleCollapsedNode(hitbox.node);
        return;
      }
      activePointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
      if (activePointersRef.current.size === 1) {
        clearHoverState();
        pointerDownRef.current = true;
        lastPointerRef.current = { x: event.clientX, y: event.clientY };
        pinchGestureRef.current = null;
        if (event.pointerType === "touch") {
          longPressRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
          };
          longPressTimerRef.current = window.setTimeout(() => {
            if (longPressRef.current?.pointerId !== event.pointerId) {
              return;
            }
            clearLongPress();
            pointerDownRef.current = false;
            lastPointerRef.current = null;
            activePointersRef.current.delete(event.pointerId);
            if (canvas.hasPointerCapture(event.pointerId)) {
              canvas.releasePointerCapture(event.pointerId);
            }
            showContextMenuAt(localX, localY);
          }, 550);
        }
      } else if (activePointersRef.current.size === 2) {
        const points = [...activePointersRef.current.values()];
        const dx = points[1].clientX - points[0].clientX;
        const dy = points[1].clientY - points[0].clientY;
        pinchGestureRef.current = {
          distance: Math.max(1, Math.hypot(dx, dy)),
          centerX: (points[0].clientX + points[1].clientX) * 0.5,
          centerY: (points[0].clientY + points[1].clientY) * 0.5,
        };
        clearLongPress();
        pointerDownRef.current = false;
        lastPointerRef.current = null;
      }
      canvas.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      lastCanvasPointerRef.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      const camera = cameraRef.current;
      if (!camera) {
        return;
      }
      if (activePointersRef.current.has(event.pointerId)) {
        activePointersRef.current.set(event.pointerId, {
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }
      if (longPressRef.current?.pointerId === event.pointerId) {
        const dx = event.clientX - longPressRef.current.startX;
        const dy = event.clientY - longPressRef.current.startY;
        if (Math.hypot(dx, dy) > 10) {
          clearLongPress();
        }
      }
      if (activePointersRef.current.size >= 2) {
        clearLongPress();
        const points = [...activePointersRef.current.values()].slice(0, 2);
        const dx = points[1].clientX - points[0].clientX;
        const dy = points[1].clientY - points[0].clientY;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const centerClientX = (points[0].clientX + points[1].clientX) * 0.5;
        const centerClientY = (points[0].clientY + points[1].clientY) * 0.5;
        const localX = centerClientX - rect.left;
        const localY = centerClientY - rect.top;
        const previous = pinchGestureRef.current;
        if (previous) {
          markPanBenchmarkInput();
          const zoom = distance / previous.distance;
          clearHoverState();
          zoomAtPoint(localX, localY, zoom);
          camera.translateX += centerClientX - previous.centerX;
          camera.translateY += centerClientY - previous.centerY;
          if (camera.kind === "rect") {
            clampRectCamera(camera, tree, size.width, size.height, rectClampPadding(camera));
          } else {
            finalizeCircularCamera(camera);
          }
          scheduleDraw();
        }
        pinchGestureRef.current = {
          distance,
          centerX: centerClientX,
          centerY: centerClientY,
        };
        return;
      }
      if (pointerDownRef.current && lastPointerRef.current) {
        markPanBenchmarkInput();
        const dx = event.clientX - lastPointerRef.current.x;
        const dy = event.clientY - lastPointerRef.current.y;
        lastPointerRef.current = { x: event.clientX, y: event.clientY };
        clearHoverState();
        if (camera.kind === "rect") {
          camera.translateX += dx;
          camera.translateY += dy;
          clampRectCamera(camera, tree, size.width, size.height, rectClampPadding(camera));
        } else {
          camera.translateX += dx;
          camera.translateY += dy;
          finalizeCircularCamera(camera);
        }
        scheduleDraw();
        return;
      }
      const distanceStartNode = distanceStartNodeRef.current;
      if (distanceStartNode !== null) {
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        const target = hitTestAt(localX, localY);
        hoverRef.current = null;
        if (!target) {
          distanceMeasurementRef.current = null;
          updateDistanceTooltip(null);
          drawHoverHighlightOverlay();
          return;
        }
        updateDistanceMeasurementTarget(target.node, localX, localY);
        return;
      }
      updateHover(event);
    };

    const handlePointerUp = (event: PointerEvent): void => {
      clearLongPress();
      activePointersRef.current.delete(event.pointerId);
      if (activePointersRef.current.size === 0) {
        pointerDownRef.current = false;
        lastPointerRef.current = null;
        pinchGestureRef.current = null;
        scheduleDraw();
      } else if (activePointersRef.current.size === 1) {
        const remaining = [...activePointersRef.current.values()][0];
        pointerDownRef.current = true;
        lastPointerRef.current = { x: remaining.clientX, y: remaining.clientY };
        pinchGestureRef.current = null;
      }
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };

    const handlePointerCancel = (event: PointerEvent): void => {
      clearLongPress();
      activePointersRef.current.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      if (activePointersRef.current.size === 0) {
        pointerDownRef.current = false;
        lastPointerRef.current = null;
        pinchGestureRef.current = null;
      }
    };

    const handlePointerLeave = (): void => {
      clearLongPress();
      activePointersRef.current.clear();
      pinchGestureRef.current = null;
      pointerDownRef.current = false;
      lastPointerRef.current = null;
      lastCanvasPointerRef.current = null;
      if (distanceStartNodeRef.current !== null) {
        distanceMeasurementRef.current = null;
        updateDistanceTooltip(null);
      }
      clearHoverState();
    };

    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      setContextMenu(null);
      const camera = cameraRef.current;
      if (!camera) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      lastCanvasPointerRef.current = { x: localX, y: localY };
      markPanBenchmarkInput();
      clearHoverState();
        if (isHorizontalWheelPanEvent(event)) {
          if (camera.kind === "rect") {
            camera.translateX -= event.deltaX;
            camera.translateY -= event.deltaY;
          clampRectCamera(camera, tree, size.width, size.height, rectClampPadding(camera));
        } else {
          camera.translateX -= event.deltaX;
          camera.translateY -= event.deltaY;
          finalizeCircularCamera(camera);
        }
          scheduleDraw();
          return;
        }
        if (tree.leafCount > HUGE_TREE_TIP_LIMIT && frameRequestRef.current !== null) {
          return;
        }
        const deltaY = normalizedWheelZoomDelta(event, size.height);
      const zoom = Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);
      zoomAtPoint(localX, localY, zoom);
      scheduleDraw();
    };
    const handleWheelEvent = handleWheel as EventListener;

    const clearLongPress = (): void => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      longPressRef.current = null;
    };

    const showContextMenuAt = (localX: number, localY: number): void => {
      window.getSelection()?.removeAllRanges();
      setContextMenuColorMode(null);
      setContextMenuCollapseMenuOpen(false);
      const phylopicHitbox = findPhyloPicHitboxAt(localX, localY);
      if (phylopicHitbox) {
        const descendantTipCount = tree
          && typeof phylopicHitbox.firstNode === "number"
          && typeof phylopicHitbox.lastNode === "number"
          ? tree.buffers.leafCount[lowestCommonAncestor(tree, phylopicHitbox.firstNode, phylopicHitbox.lastNode)]
          : phylopicHitbox.taxonomyTipCount ?? 0;
        hoverRef.current = null;
        updateHoverTooltip(null);
        drawHoverHighlightOverlay();
        onHoverChange(null);
        setContextMenu({
          kind: "phylopic",
          x: Math.min(size.width - 260, localX + 14),
          y: Math.min(size.height - 170, localY + 14),
          name: phylopicHitbox.taxonLabel,
          rank: phylopicHitbox.rank,
          firstNode: phylopicHitbox.firstNode,
          lastNode: phylopicHitbox.lastNode,
          descendantTipCount,
          taxId: phylopicHitbox.taxId,
          silhouette: phylopicHitbox.silhouette,
        });
        scheduleDraw();
        return;
      }
      const labelHitbox = findLabelHitboxAt(localX, localY);
      if (
        labelHitbox?.labelKind === "taxonomy"
        && labelHitbox.text
        && labelHitbox.taxonomyRank
        && typeof labelHitbox.taxonomyFirstNode === "number"
        && typeof labelHitbox.taxonomyLastNode === "number"
      ) {
        const collapseNode = labelHitbox.taxonomyCollapseNode ?? resolveTaxonomySegmentNode(
          labelHitbox.taxonomyRank as TaxonomyRank,
          labelHitbox.text,
          labelHitbox.taxonomyTaxId ?? null,
          labelHitbox.taxonomyFirstNode,
          labelHitbox.taxonomyLastNode,
          labelHitbox.taxonomyStartIndex,
          labelHitbox.taxonomyEndIndex,
        );
        hoverRef.current = null;
        updateHoverTooltip(null);
        drawHoverHighlightOverlay();
        onHoverChange(null);
        setContextMenu({
          kind: "taxonomy",
          x: Math.min(size.width - 260, localX + 14),
          y: Math.min(size.height - 210, localY + 14),
          name: labelHitbox.text,
          rank: labelHitbox.taxonomyRank as TaxonomyRank,
          firstNode: labelHitbox.taxonomyFirstNode,
          lastNode: labelHitbox.taxonomyLastNode,
          descendantTipCount: collapseNode === null
            ? labelHitbox.taxonomyTipCount ?? 0
            : tree.buffers.leafCount[collapseNode],
          taxId: labelHitbox.taxonomyTaxId ?? null,
          startIndex: labelHitbox.taxonomyStartIndex,
          endIndex: labelHitbox.taxonomyEndIndex,
          collapseNode: collapseNode ?? undefined,
        });
        scheduleDraw();
        return;
      }
      const taxonomyArcHitbox = findTaxonomyArcHitboxAt(localX, localY);
      if (taxonomyArcHitbox) {
        const collapseNode = resolveTaxonomySegmentNode(
          taxonomyArcHitbox.rank,
          taxonomyArcHitbox.label,
          taxonomyArcHitbox.taxId,
          taxonomyArcHitbox.firstNode,
          taxonomyArcHitbox.lastNode,
          taxonomyArcHitbox.startIndex,
          taxonomyArcHitbox.endIndex,
        );
        hoverRef.current = null;
        updateHoverTooltip(null);
        drawHoverHighlightOverlay();
        onHoverChange(null);
        setContextMenu({
          kind: "taxonomy",
          x: Math.min(size.width - 260, localX + 14),
          y: Math.min(size.height - 210, localY + 14),
          name: taxonomyArcHitbox.label,
          rank: taxonomyArcHitbox.rank,
          firstNode: taxonomyArcHitbox.firstNode,
          lastNode: taxonomyArcHitbox.lastNode,
          descendantTipCount: collapseNode === null
            ? taxonomyArcHitbox.taxonomyTipCount
            : tree.buffers.leafCount[collapseNode],
          taxId: taxonomyArcHitbox.taxId,
          startIndex: taxonomyArcHitbox.startIndex,
          endIndex: taxonomyArcHitbox.endIndex,
          collapseNode: collapseNode ?? undefined,
        });
        scheduleDraw();
        return;
      }
      const hover = hitTestAt(localX, localY);
      if (!hover) {
        setContextMenu(null);
        return;
      }
      hoverRef.current = hover;
      updateHoverTooltip(null);
      onHoverChange(null);
      drawHoverHighlightOverlay();
      setContextMenu({
        kind: "node",
        x: Math.min(size.width - 220, localX + 14),
        y: Math.min(size.height - 180, localY + 14),
        node: hover.node,
        name: hover.name,
        descendantTipCount: hover.descendantTipCount,
      });
      scheduleDraw();
    };

    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      if (distanceStartNodeRef.current !== null) {
        clearDistanceMeasurement();
      }
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      showContextMenuAt(localX, localY);
    };

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerCancel);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    wheelElement.addEventListener("wheel", handleWheelEvent, { passive: false });
    canvas.addEventListener("contextmenu", handleContextMenu);
    const handleTouchMove = (event: TouchEvent): void => {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    };
    const handleGestureStart = (event: Event): void => {
      event.preventDefault();
      const gestureEvent = event as Event & { scale?: number };
      macGestureScaleRef.current = Math.max(0.01, Number(gestureEvent.scale ?? 1));
    };
    const handleGestureChange = (event: Event): void => {
      event.preventDefault();
      const camera = cameraRef.current;
      if (!camera) {
        return;
      }
      const gestureEvent = event as Event & {
        scale?: number;
        clientX?: number;
        clientY?: number;
      };
      const currentScale = Math.max(0.01, Number(gestureEvent.scale ?? 1));
      const previousScale = macGestureScaleRef.current ?? 1;
      macGestureScaleRef.current = currentScale;
      if (!(previousScale > 0)) {
        return;
      }
      const rawZoom = currentScale / previousScale;
      const zoom = rawZoom >= 1
        ? Math.pow(rawZoom, MAC_GESTURE_ZOOM_EXPONENT)
        : 1 / Math.pow(1 / rawZoom, MAC_GESTURE_ZOOM_EXPONENT);
      if (!Number.isFinite(zoom) || Math.abs(zoom - 1) < 1e-4) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const clientX = Number.isFinite(gestureEvent.clientX)
        ? Number(gestureEvent.clientX)
        : rect.left + (rect.width * 0.5);
      const clientY = Number.isFinite(gestureEvent.clientY)
        ? Number(gestureEvent.clientY)
        : rect.top + (rect.height * 0.5);
      markPanBenchmarkInput();
      clearHoverState();
      zoomAtPoint(clientX - rect.left, clientY - rect.top, zoom);
      scheduleDraw();
    };
    const handleGestureEnd = (event: Event): void => {
      event.preventDefault();
      macGestureScaleRef.current = null;
    };
    canvas.addEventListener("touchmove", handleTouchMove, { passive: false });
    canvas.addEventListener("gesturestart", handleGestureStart);
    canvas.addEventListener("gesturechange", handleGestureChange);
    canvas.addEventListener("gestureend", handleGestureEnd);

    return () => {
      hoverProbeRef.current = null;
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerCancel);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      wheelElement.removeEventListener("wheel", handleWheelEvent);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      canvas.removeEventListener("touchmove", handleTouchMove);
      canvas.removeEventListener("gesturestart", handleGestureStart);
      canvas.removeEventListener("gesturechange", handleGestureChange);
      canvas.removeEventListener("gestureend", handleGestureEnd);
    };
  }, [
    cache,
    collapsedTipTaxonomySummaryByNode,
    circularClampExtraRadiusPx,
    collapsedNodes,
    collapsedSpatialCache,
    collapsedView,
    clearDistanceMeasurement,
    descendantTipCountForView,
    draw,
    displayNodeNameForView,
    effectiveTimeAxisLogBase,
    isBranchHoverEnabled,
    markPanBenchmarkInput,
    onHoverChange,
    order,
    rectClampPadding,
    resolveTaxonomySegmentNode,
    scheduleDraw,
    size.height,
    size.width,
    spiralMetricsForScale,
    spiralVisibleTaxonomyRanksForScale,
    toggleCollapsedNode,
    tree,
    updateDistanceTooltip,
    updateDistanceMeasurementTarget,
    updateHoverTooltip,
    viewMode,
    zoomAtPoint,
  ]);

  const handleContextZoomToSubtree = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "node") {
      return;
    }
    zoomToSubtreeTarget(contextMenu.node);
    setContextMenu(null);
  }, [contextMenu, zoomToSubtreeTarget]);

  const openSubtreeInNewTab = useCallback(async (node: number) => {
    if (typeof window === "undefined" || !tree) {
      return;
    }
    const exportTree = sharedSubtreeSourceTree ?? tree;
    const exportTaxonomyMap = sharedSubtreeSourceTaxonomyMap ?? taxonomyMap;
    const exportNode = sharedSubtreeSourceNodeByViewNode?.[node] ?? node;
    const key = `big-tree-viewer:subtree:${crypto.randomUUID()}`;
    const payload = buildSharedSubtreeStoragePayload(exportTree, exportNode, exportTaxonomyMap, taxonomyEnabled, {
      viewMode,
      order,
      zoomAxisMode,
      circularRotationDegrees: circularRotation,
      radialAngularSpanDegrees: configuredRadialSpanDegrees,
      radialCenterOpeningRatio: effectiveRadialCenterOpeningRatio,
      spiralTurns,
      showTimeStripes,
      timeAxisScale,
      timeAxisLogBase,
      timeStripeStyle,
      timeStripeLineWeight,
      showScaleBars,
      scaleTickInterval,
      showIntermediateScaleTicks,
      extendRectScaleToTick,
      showScaleZeroTick,
      useAutoCircularCenterScaleAngle,
      circularCenterScaleAngleDegrees,
      showCircularCenterRadialScaleBar,
      showTipLabels,
      alignTipLabels,
      showGenusLabels,
      showInternalNodeLabels,
      showBootstrapLabels,
      showNodeHeightLabels,
      showNodeErrorBars,
      errorBarStyle,
      errorBarColor,
      errorBarOpacity,
      errorBarShowNodeDot,
      errorBarThicknessPx,
      errorBarCapSizePx,
      figureStyles,
      taxonomyEnabled,
      taxonomyOverlayStyle,
      taxonomyBranchColoringEnabled,
      useAutomaticTaxonomyRankVisibility,
      taxonomyRankVisibility,
      taxonomyRankDisplayModes,
      taxonomyCollapseRank,
      taxonomyColorJitter,
      taxonomyColorPalette,
      taxonomyCustomPaletteInput: taxonomyCustomPaletteColors.join("\n"),
      taxonomyColorRootRank,
      taxonomyColorJitterRank,
      branchThicknessScale,
    }, { hideDownloadNewick });
    try {
      await putSharedSubtreePayload(key, payload);
    } catch {
      try {
        window.localStorage.setItem(key, JSON.stringify(payload));
      } catch {
        // Fall back to Newick-only sharing only if both IndexedDB and localStorage payload storage fail.
        window.localStorage.setItem(key, payload.newick);
      }
    }
    const url = new URL(window.location.href);
    url.searchParams.set("subtree", key);
    window.open(url.toString(), "_blank", "noopener");
  }, [
    branchThicknessScale,
    circularCenterScaleAngleDegrees,
    circularRotation,
    errorBarColor,
    errorBarCapSizePx,
    errorBarOpacity,
    errorBarShowNodeDot,
    errorBarStyle,
    errorBarThicknessPx,
    extendRectScaleToTick,
    figureStyles,
    hideDownloadNewick,
    order,
    configuredRadialSpanDegrees,
    effectiveRadialCenterOpeningRatio,
    scaleTickInterval,
    showBootstrapLabels,
    showCircularCenterRadialScaleBar,
    showTipLabels,
    alignTipLabels,
    showGenusLabels,
    showIntermediateScaleTicks,
    showInternalNodeLabels,
    showNodeErrorBars,
    showNodeHeightLabels,
    showScaleBars,
    showScaleZeroTick,
    showTimeStripes,
    taxonomyBranchColoringEnabled,
    taxonomyCollapseRank,
    taxonomyColorRanks,
    taxonomyColorJitter,
    taxonomyColorPalette,
    taxonomyColorRootRank,
    taxonomyColorJitterRank,
    taxonomyColorRanks,
    taxonomyColors,
    taxonomyRankDisplayModes,
    taxonomyCustomPaletteColors,
    timeAxisScale,
    timeAxisLogBase,
    taxonomyEnabled,
    taxonomyMap,
    taxonomyRankVisibility,
    sharedSubtreeSourceNodeByViewNode,
    sharedSubtreeSourceTaxonomyMap,
    sharedSubtreeSourceTree,
    spiralTurns,
    timeStripeLineWeight,
    timeStripeStyle,
    tree,
    useAutoCircularCenterScaleAngle,
    useAutomaticTaxonomyRankVisibility,
    viewMode,
    zoomAxisMode,
  ]);

  const handleContextOpenSubtreeInNewTab = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "node") {
      return;
    }
    void openSubtreeInNewTab(contextMenu.node);
    setContextMenu(null);
  }, [contextMenu, openSubtreeInNewTab]);

  const contextMenuCollapseTarget = useMemo(() => {
    if (!contextMenu || !tree) {
      return null;
    }
    let node: number | null = null;
    if (contextMenu.kind === "taxonomy") {
      if (typeof contextMenu.collapseNode === "number") {
        node = contextMenu.collapseNode;
      } else {
        node = resolveTaxonomySegmentNode(
          contextMenu.rank,
          contextMenu.name,
          contextMenu.taxId,
          contextMenu.firstNode,
          contextMenu.lastNode,
          contextMenu.startIndex,
          contextMenu.endIndex,
        );
      }
    } else if (contextMenu.kind === "node") {
      node = contextMenu.node;
    }
    return node !== null && tree.buffers.firstChild[node] >= 0 ? node : null;
  }, [contextMenu, resolveTaxonomySegmentNode, tree]);

  const handleContextViewSubtreeStatistics = useCallback(() => {
    if (!contextMenu || contextMenuCollapseTarget === null || !onSubtreeStatisticsRequest) {
      return;
    }
    onSubtreeStatisticsRequest({
      node: contextMenuCollapseTarget,
      name: contextMenu.name,
    });
    setContextMenu(null);
  }, [contextMenu, contextMenuCollapseTarget, onSubtreeStatisticsRequest]);

  const handleContextMeasureDistance = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "node" || !tree) {
      return;
    }
    beginDistanceMeasurement(contextMenu.node, contextMenu.x, contextMenu.y);
    setContextMenu(null);
  }, [beginDistanceMeasurement, contextMenu, tree]);

  const handleContextCollapse = useCallback((mode: CollapsedNodeMode | null) => {
    if (contextMenuCollapseTarget === null) {
      return;
    }
    setCollapsedNodeMode(contextMenuCollapseTarget, mode);
    setContextMenu(null);
  }, [contextMenuCollapseTarget, setCollapsedNodeMode]);

  const copyTextToClipboard = useCallback(async (text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    if (typeof document === "undefined") {
      return;
    }
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "true");
    input.style.position = "absolute";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    document.body.removeChild(input);
  }, []);

  const handleContextCopyTipName = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "node" || contextMenu.descendantTipCount !== 1) {
      return;
    }
    void copyTextToClipboard(contextMenu.name);
    setContextMenu(null);
  }, [contextMenu, copyTextToClipboard]);

  const handleContextReroot = useCallback((mode: "branch" | "child" | "parent") => {
    if (!contextMenu || contextMenu.kind !== "node" || !onRerootRequest) {
      return;
    }
    onRerootRequest(contextMenu.node, mode);
    setContextMenu(null);
  }, [contextMenu, onRerootRequest]);

  const handleContextCopyTaxonomyName = useCallback(() => {
    if (!contextMenu || (contextMenu.kind !== "taxonomy" && contextMenu.kind !== "phylopic")) {
      return;
    }
    void copyTextToClipboard(contextMenu.name);
    setContextMenu(null);
  }, [contextMenu, copyTextToClipboard]);

  const handleContextZoomToTaxonomySubtree = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "taxonomy" || !tree) {
      return;
    }
    const mrcaNode = lowestCommonAncestor(tree, contextMenu.firstNode, contextMenu.lastNode);
    zoomToSubtreeTarget(mrcaNode);
    setContextMenu(null);
  }, [contextMenu, tree, zoomToSubtreeTarget]);

  const handleContextOpenTaxonomySubtreeInNewTab = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "taxonomy" || !tree) {
      return;
    }
    const mrcaNode = lowestCommonAncestor(tree, contextMenu.firstNode, contextMenu.lastNode);
    void openSubtreeInNewTab(mrcaNode);
    setContextMenu(null);
  }, [contextMenu, openSubtreeInNewTab, tree]);

  const handleContextOpenTaxonomySource = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "taxonomy" || typeof window === "undefined") {
      return;
    }
    if (taxonomyMap?.source === "catalogue-of-life") {
      window.open(
        `https://www.catalogueoflife.org/data/search?q=${encodeURIComponent(contextMenu.name)}`,
        "_blank",
        "noopener,noreferrer",
      );
      setContextMenu(null);
      return;
    }
    if (!contextMenu.taxId) {
      return;
    }
    window.open(`https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id=${contextMenu.taxId}`, "_blank", "noopener,noreferrer");
    setContextMenu(null);
  }, [contextMenu, taxonomyMap?.source]);

  const handleContextTryAnotherPhyloPic = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "phylopic" || !onPhyloPicTryAnotherSilhouette) {
      return;
    }
    onPhyloPicTryAnotherSilhouette(contextMenu.silhouette);
    setContextMenu(null);
  }, [contextMenu, onPhyloPicTryAnotherSilhouette]);

  const handleContextRemovePhyloPic = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "phylopic" || !onPhyloPicRemoveSilhouette) {
      return;
    }
    onPhyloPicRemoveSilhouette(contextMenu.silhouette);
    setContextMenu(null);
  }, [contextMenu, onPhyloPicRemoveSilhouette]);

  const setTaxonomyRootColor = useCallback((label: string, color: string) => {
    setTaxonomyRootColorAssignments((current) => {
      const next = new Map(current);
      next.set(label, color);
      return next;
    });
  }, []);

  const clearTaxonomyRootColor = useCallback((label: string) => {
    setTaxonomyRootColorAssignments((current) => {
      if (!current.has(label)) {
        return current;
      }
      const next = new Map(current);
      next.delete(label);
      return next;
    });
  }, []);

  const setManualBranchColor = useCallback((node: number, color: string) => {
    if (!tree || tree.buffers.parent[node] < 0) {
      return;
    }
    setManualBranchColorAssignments((current) => {
      const next = new Map(current);
      next.set(node, color);
      return next;
    });
  }, [tree]);

  const clearManualBranchColor = useCallback((node: number) => {
    setManualBranchColorAssignments((current) => {
      if (!current.has(node)) {
        return current;
      }
      const next = new Map(current);
      next.delete(node);
      return next;
    });
  }, []);

  const setManualSubtreeColor = useCallback((node: number, color: string) => {
    if (!tree) {
      return;
    }
    setManualSubtreeColorAssignments((current) => {
      const next = new Map(current);
      next.set(node, color);
      return next;
    });
  }, [tree]);

  const clearManualSubtreeColor = useCallback((node: number) => {
    setManualSubtreeColorAssignments((current) => {
      if (!current.has(node)) {
        return current;
      }
      const next = new Map(current);
      next.delete(node);
      return next;
    });
  }, []);

  const handleContextSetBranchColor = useCallback((color: string) => {
    if (!contextMenu || contextMenu.kind !== "node") {
      return;
    }
    setManualBranchColor(contextMenu.node, color);
    setContextMenu(null);
  }, [contextMenu, setManualBranchColor]);

  const handleContextClearBranchColor = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "node") {
      return;
    }
    clearManualBranchColor(contextMenu.node);
    setContextMenu(null);
  }, [clearManualBranchColor, contextMenu]);

  const handleContextSetSubtreeColor = useCallback((color: string) => {
    if (!contextMenu || contextMenu.kind !== "node") {
      return;
    }
    setManualSubtreeColor(contextMenu.node, color);
    setContextMenu(null);
  }, [contextMenu, setManualSubtreeColor]);

  const handleContextClearSubtreeColor = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "node") {
      return;
    }
    clearManualSubtreeColor(contextMenu.node);
    setContextMenu(null);
  }, [clearManualSubtreeColor, contextMenu]);

  const handleContextSetTaxonomyRootColor = useCallback((color: string) => {
    if (!contextMenu || contextMenu.kind !== "taxonomy" || contextMenu.rank !== taxonomyOutermostRank) {
      return;
    }
    setTaxonomyRootColor(contextMenu.name, color);
    setContextMenu(null);
  }, [contextMenu, setTaxonomyRootColor, taxonomyOutermostRank]);

  const handleContextClearTaxonomyRootColor = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "taxonomy" || contextMenu.rank !== taxonomyOutermostRank) {
      return;
    }
    clearTaxonomyRootColor(contextMenu.name);
    setContextMenu(null);
  }, [clearTaxonomyRootColor, contextMenu, taxonomyOutermostRank]);

  const applyContextColor = useCallback((scope: "branch" | "subtree" | "taxonomy-root", color: string): void => {
    const normalized = normalizeColorInput(color);
    if (!normalized) {
      return;
    }
    if (scope === "branch") {
      handleContextSetBranchColor(normalized);
      return;
    }
    if (scope === "subtree") {
      handleContextSetSubtreeColor(normalized);
      return;
    }
    handleContextSetTaxonomyRootColor(normalized);
  }, [handleContextSetBranchColor, handleContextSetSubtreeColor, handleContextSetTaxonomyRootColor]);

  const renderColorSwatches = (
    scope: "branch" | "subtree" | "taxonomy-root",
    selectedColor: string | null,
    disabled: boolean,
  ) => (
    <div className="tree-context-menu-color-controls">
      <div className="tree-context-menu-swatch-grid">
        {MANUAL_BRANCH_SWATCHES.map((swatch) => (
          <button
            key={`${scope}:${swatch.color}`}
            type="button"
            className={`tree-context-menu-swatch${selectedColor === swatch.color ? " active" : ""}`}
            style={{ backgroundColor: swatch.color }}
            aria-label={`Set ${scope} color ${swatch.label}`}
            title={swatch.label}
            disabled={disabled}
            onClick={() => {
              setContextMenuCustomColor(swatch.color);
              applyContextColor(scope, swatch.color);
            }}
          />
        ))}
      </div>
      <label
        className="tree-context-menu-custom-color tree-context-menu-color-picker-shell"
        title={`Choose a custom ${scope.replace("taxonomy-root", "top-level group")} color.`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span>Custom color</span>
        <input
          type="color"
          value={normalizeColorInput(contextMenuCustomColor) ?? normalizeColorInput(selectedColor ?? "#2563eb") ?? "#2563eb"}
          disabled={disabled}
          aria-label={`Choose custom ${scope} color`}
          onFocus={() => {
            nativeColorPickerActiveRef.current = true;
          }}
          onBlur={() => {
            nativeColorPickerActiveRef.current = false;
          }}
          onPointerDown={(event) => {
            nativeColorPickerActiveRef.current = true;
            event.stopPropagation();
          }}
          onChange={(event) => {
            setContextMenuCustomColor(event.target.value);
            applyContextColor(scope, event.target.value);
          }}
        />
        <input
          type="text"
          value={contextMenuCustomColor}
          disabled={disabled}
          aria-label={`Custom ${scope} color hex`}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => setContextMenuCustomColor(event.target.value)}
          onBlur={() => {
            const normalized = normalizeColorInput(contextMenuCustomColor);
            if (normalized) {
              setContextMenuCustomColor(normalized);
              applyContextColor(scope, normalized);
            }
          }}
        />
      </label>
    </div>
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.__BIG_TREE_VIEWER_CANVAS_TEST__ = {
      getCamera: () => {
        const camera = cameraRef.current;
        return camera ? { ...camera } : null;
      },
      getRenderDebug: () => renderDebugRef.current,
      getOrderedLeavesForTest: () => cache ? [...cache.orderedLeaves[order]] : [],
      getCurrentBranchColors: () => {
        if (!tree) {
          return null;
        }
        const colorRanks = taxonomyEnabled && taxonomyBranchColoringEnabled && taxonomyColors !== null && taxonomyColorRanks.length > 0
          ? taxonomyColorRanks
          : [];
        return getEffectiveBranchColors(order, colorRanks) ?? new Array<string>(tree.nodeCount).fill(BRANCH_COLOR);
      },
      setManualBranchColor: (node: number, color: string) => {
        setManualBranchColor(node, color);
      },
      clearManualBranchColor: (node: number) => {
        clearManualBranchColor(node);
      },
      setManualSubtreeColor: (node: number, color: string) => {
        setManualSubtreeColor(node, color);
      },
      clearManualSubtreeColor: (node: number) => {
        clearManualSubtreeColor(node);
      },
      setTaxonomyRootColor: (label: string, color: string) => {
        setTaxonomyRootColor(label, color);
      },
      getTaxonomyRootColors: () => Array.from(taxonomyRootColorAssignments),
      setCollapsedNodeMode: (node: number, mode: CollapsedNodeMode | null) => {
        setCollapsedNodeMode(node, mode);
      },
      getCollapsedNodeModes: () => Array.from(collapsedNodeModes),
      getBranchScreenSegmentForTest: (node: number) => {
        const camera = cameraRef.current;
        if (!camera || !cache || viewMode === "spiral") {
          return null;
        }
        const segments = camera.kind === "rect"
          ? collapsedSpatialCache?.rectSegments ?? cache.rectSegments[order]
          : collapsedSpatialCache?.circularSegments ?? cache.circularSegments[order];
        const segment = segments.find((candidate) => candidate.node === node && candidate.kind === "stem");
        if (!segment) {
          return null;
        }
        const start = camera.kind === "rect"
          ? worldToScreenRect(camera, segment.x1, segment.y1)
          : worldToScreenCircular(camera, segment.x1, segment.y1);
        const end = camera.kind === "rect"
          ? worldToScreenRect(camera, segment.x2, segment.y2)
          : worldToScreenCircular(camera, segment.x2, segment.y2);
        return {
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
        };
      },
      buildCurrentSvgForTest: () => buildCurrentSvgString(),
      startPanBenchmark,
      stopPanBenchmark,
      fitView: () => {
        fitCamera();
        draw();
      },
      setRectCamera: (partial: Record<string, unknown>) => {
        const camera = cameraRef.current;
        if (!tree || !camera || camera.kind !== "rect") {
          return;
        }
        if (typeof partial.scaleX === "number") {
          camera.scaleX = partial.scaleX;
        }
        if (typeof partial.scaleY === "number") {
          camera.scaleY = partial.scaleY;
        }
        if (typeof partial.translateX === "number") {
          camera.translateX = partial.translateX;
        }
        if (typeof partial.translateY === "number") {
          camera.translateY = partial.translateY;
        }
        clampRectCamera(camera, tree, size.width, size.height, rectClampPadding(camera));
        if (collapsedNodeModes.size > 0) {
          setCollapsedLayoutRevision((current) => current + 1);
        }
        draw();
      },
      setCircularCamera: (partial: Record<string, unknown>) => {
        const camera = cameraRef.current;
        if (!tree || !camera || camera.kind !== "circular") {
          return;
        }
        if (typeof partial.scale === "number") {
          camera.scale = partial.scale;
        }
        if (typeof partial.translateX === "number") {
          camera.translateX = partial.translateX;
        }
        if (typeof partial.translateY === "number") {
          camera.translateY = partial.translateY;
        }
        finalizeCircularCamera(camera);
        if (collapsedNodeModes.size > 0) {
          setCollapsedLayoutRevision((current) => current + 1);
        }
        draw();
      },
      getLeafIndexMap: () => {
        if (!cache) {
          return null;
        }
        const result: Record<number, number> = {};
        const leaves = cache.orderedLeaves[order];
        for (let index = 0; index < leaves.length; index += 1) {
          result[leaves[index]] = index;
        }
        return result;
      },
      getCollapsedTriangleHitboxes: () => collapsedTriangleHitsRef.current.map((triangle) => ({
        node: triangle.node,
        points: triangle.points.map((point) => ({ ...point })),
      })),
      startCollapsedTriangleDrawCapture: (node: number, neighborNode: number) => {
        window.__BIG_TREE_VIEWER_COLLAPSE_DRAW_CAPTURE__ = { node, neighborNode, samples: [] };
      },
      stopCollapsedTriangleDrawCapture: () => {
        const samples = window.__BIG_TREE_VIEWER_COLLAPSE_DRAW_CAPTURE__?.samples.map(
          (sample) => ({ ...sample }),
        ) ?? [];
        delete window.__BIG_TREE_VIEWER_COLLAPSE_DRAW_CAPTURE__;
        return samples;
      },
      isTerminalRectConnectorForTest: (node: number) => (
        tree ? isTerminalRectConnector(tree, node) : false
      ),
      getLabelHitboxes: () => labelHitsRef.current.map((hitbox) => ({ ...hitbox })),
      getTaxonomyArcHitboxes: () => taxonomyArcHitsRef.current.map((hitbox) => ({
        ...hitbox,
        screenPolygonPoints: hitbox.screenPolygonPoints?.map((point) => ({ ...point })),
      })),
      getPhyloPicHitboxes: () => phylopicHitsRef.current.map((hitbox) => ({
        ...hitbox,
        silhouette: { ...hitbox.silhouette },
      })),
      probeHoverForTest: (localX: number, localY: number) => {
        const hover = hoverProbeRef.current?.(localX, localY) ?? null;
        return hover ? { ...hover } : null;
      },
      startDistanceMeasurementForTest: (node: number, screenX = 100, screenY = 100) => {
        beginDistanceMeasurement(node, screenX, screenY);
      },
      updateDistanceMeasurementForTest: (node: number, screenX = 120, screenY = 120) => {
        updateDistanceMeasurementTarget(node, screenX, screenY);
      },
      getDistanceMeasurementForTest: () => (
        distanceMeasurementRef.current ? { ...distanceMeasurementRef.current } : null
      ),
      clearDistanceMeasurementForTest: clearDistanceMeasurement,
      buildSharedSubtreePayloadForTest: (node: number) => {
        if (!tree) {
          return null;
        }
        const exportTree = sharedSubtreeSourceTree ?? tree;
        const exportTaxonomyMap = sharedSubtreeSourceTaxonomyMap ?? taxonomyMap;
        const exportNode = sharedSubtreeSourceNodeByViewNode?.[node] ?? node;
        return buildSharedSubtreeStoragePayload(exportTree, exportNode, exportTaxonomyMap, taxonomyEnabled, {
          viewMode,
          order,
          zoomAxisMode,
          circularRotationDegrees: circularRotation,
          radialAngularSpanDegrees: configuredRadialSpanDegrees,
          radialCenterOpeningRatio: effectiveRadialCenterOpeningRatio,
          spiralTurns,
          showTimeStripes,
          timeAxisScale,
          timeAxisLogBase,
          timeStripeStyle,
          timeStripeLineWeight,
          showScaleBars,
          scaleTickInterval,
          showIntermediateScaleTicks,
          extendRectScaleToTick,
          showScaleZeroTick,
          useAutoCircularCenterScaleAngle,
          circularCenterScaleAngleDegrees,
          showCircularCenterRadialScaleBar,
          showTipLabels,
          alignTipLabels,
          showGenusLabels,
          showInternalNodeLabels,
          showBootstrapLabels,
          showNodeHeightLabels,
          showNodeErrorBars,
          errorBarStyle,
          errorBarColor,
          errorBarOpacity,
          errorBarShowNodeDot,
          errorBarThicknessPx,
          errorBarCapSizePx,
          figureStyles,
          taxonomyEnabled,
          taxonomyOverlayStyle,
          taxonomyBranchColoringEnabled,
          useAutomaticTaxonomyRankVisibility,
          taxonomyRankVisibility,
          taxonomyRankDisplayModes,
          taxonomyCollapseRank,
          taxonomyColorJitter,
          taxonomyColorPalette,
          taxonomyCustomPaletteInput: taxonomyCustomPaletteColors.join("\n"),
          taxonomyColorRootRank,
          taxonomyColorJitterRank,
          branchThicknessScale,
        }, { hideDownloadNewick });
      },
      zoomToSubtreeTarget,
    };
    return () => {
      delete window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    };
  }, [
    draw,
    beginDistanceMeasurement,
    cache,
    clearManualBranchColor,
    clearManualSubtreeColor,
    clearDistanceMeasurement,
    collapsedNodeModes,
    collapsedSpatialCache,
    buildCurrentSvgString,
    fitCamera,
    getEffectiveBranchColors,
    order,
    branchThicknessScale,
    circularCenterScaleAngleDegrees,
    circularRotation,
    errorBarColor,
    errorBarCapSizePx,
    errorBarOpacity,
    errorBarShowNodeDot,
    errorBarStyle,
    errorBarThicknessPx,
    extendRectScaleToTick,
    figureStyles,
    hideDownloadNewick,
    configuredRadialSpanDegrees,
    effectiveRadialCenterOpeningRatio,
    rectClampPadding,
    scaleTickInterval,
    showBootstrapLabels,
    showCircularCenterRadialScaleBar,
    showTipLabels,
    alignTipLabels,
    showGenusLabels,
    showIntermediateScaleTicks,
    showInternalNodeLabels,
    showNodeErrorBars,
    showNodeHeightLabels,
    showScaleBars,
    showScaleZeroTick,
    showTimeStripes,
    size.height,
    size.width,
    startPanBenchmark,
    stopPanBenchmark,
    setManualBranchColor,
    setManualSubtreeColor,
    setTaxonomyRootColor,
    setCollapsedNodeMode,
    taxonomyBranchColoringEnabled,
    taxonomyCollapseRank,
    taxonomyColorJitter,
    taxonomyColorPalette,
    taxonomyColorRootRank,
    taxonomyColorJitterRank,
    taxonomyRankDisplayModes,
    taxonomyRootColorAssignments,
    taxonomyCustomPaletteColors,
    timeAxisScale,
    timeAxisLogBase,
    taxonomyEnabled,
    taxonomyMap,
    taxonomyRankVisibility,
    tree,
    timeStripeLineWeight,
    timeStripeStyle,
    sharedSubtreeSourceNodeByViewNode,
    sharedSubtreeSourceTaxonomyMap,
    sharedSubtreeSourceTree,
    spiralTurns,
    useAutoCircularCenterScaleAngle,
    useAutomaticTaxonomyRankVisibility,
    viewMode,
    zoomAxisMode,
    zoomToSubtreeTarget,
    updateDistanceMeasurementTarget,
  ]);

  useEffect(() => {
    if (!tutorialBranchMenuDemoActive) {
      if (contextMenu?.tutorialDemo) {
        setContextMenu(null);
        setContextMenuColorMode(null);
        hoverRef.current = null;
        updateHoverTooltip(null);
        drawHoverHighlightOverlay();
        onHoverChange(null);
      }
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;

    const findVisibleBranchHover = (): CanvasHoverInfo | null => {
      const camera = cameraRef.current;
      if (!tree || !cache || !camera || size.width <= 0 || size.height <= 0) {
        return null;
      }
      const segments = camera.kind === "rect"
        ? collapsedSpatialCache?.rectSegments ?? cache.rectSegments[order]
        : viewMode === "circular" || viewMode === "fan"
          ? collapsedSpatialCache?.circularSegments ?? cache.circularSegments[order]
          : [];
      const centerX = size.width * 0.5;
      const centerY = size.height * 0.5;
      const candidates: Array<{ node: number; x: number; y: number; distance: number }> = [];
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment.kind !== "stem" || tree.buffers.parent[segment.node] < 0) {
          continue;
        }
        const start = camera.kind === "rect"
          ? worldToScreenRect(camera, segment.x1, segment.y1)
          : worldToScreenCircular(camera, segment.x1, segment.y1);
        const end = camera.kind === "rect"
          ? worldToScreenRect(camera, segment.x2, segment.y2)
          : worldToScreenCircular(camera, segment.x2, segment.y2);
        const x = (start.x + end.x) * 0.5;
        const y = (start.y + end.y) * 0.5;
        const length = Math.hypot(end.x - start.x, end.y - start.y);
        if (
          length < 18
          || x < 24
          || y < 24
          || x > size.width - 24
          || y > size.height - 24
        ) {
          continue;
        }
        candidates.push({
          node: segment.node,
          x,
          y,
          distance: Math.hypot(x - centerX, y - centerY),
        });
      }
      candidates.sort((left, right) => left.distance - right.distance);
      const preferred = candidates.find((candidate) => tree.buffers.firstChild[candidate.node] >= 0) ?? candidates[0];
      if (!preferred) {
        return null;
      }
      const parent = tree.buffers.parent[preferred.node];
      const collapsedTaxonomySummary = collapsedTipTaxonomySummaryByNode.get(preferred.node) ?? null;
      return {
        node: preferred.node,
        branchLength: tree.buffers.branchLength[preferred.node],
        parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
        parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
        childAge: tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[preferred.node]) : null,
        name: displayNodeNameForView(preferred.node),
        descendantTipCount: descendantTipCountForView(preferred.node),
        screenX: preferred.x,
        screenY: preferred.y,
        targetKind: "stem",
        collapsedTaxonomyRank: collapsedTaxonomySummary?.rank ?? null,
        collapsedTaxonomyDescendantTipCount: collapsedTaxonomySummary?.descendantTipCount ?? null,
        collapsedTaxonomyMrcaAge: collapsedTaxonomySummary?.mrcaAge ?? null,
        kind: "node",
      };
    };

    const openDemoMenu = (attempt = 0): void => {
      if (cancelled) {
        return;
      }
      const hover = findVisibleBranchHover();
      if (!hover) {
        if (attempt < 12) {
          retryTimer = window.setTimeout(() => openDemoMenu(attempt + 1), 120);
        }
        return;
      }
      hoverRef.current = hover;
      updateHoverTooltip(hover);
      onHoverChange(hover);
      drawHoverHighlightOverlay();
      setContextMenuColorMode(null);
      setContextMenuRootMenuOpen(false);
      setContextMenu({
        kind: "node",
        x: Math.max(12, Math.min(size.width - 240, hover.screenX + 18)),
        y: Math.max(12, Math.min(size.height - 270, hover.screenY + 18)),
        node: hover.node,
        name: hover.name,
        descendantTipCount: hover.descendantTipCount,
        tutorialDemo: true,
      });
      scheduleDraw();
    };

    openDemoMenu();

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [
    contextMenu?.tutorialDemo,
    cache,
    collapsedSpatialCache,
    collapsedTipTaxonomySummaryByNode,
    descendantTipCountForView,
    displayNodeNameForView,
    drawHoverHighlightOverlay,
    onHoverChange,
    order,
    scheduleDraw,
    size.height,
    size.width,
    tutorialBranchMenuDemoActive,
    tree,
    updateHoverTooltip,
    viewMode,
  ]);

  return (
    <div
      className="tree-canvas-shell"
      ref={wrapperRef}
      onPointerDown={(event) => {
        if (nativeColorPickerActiveRef.current) {
          return;
        }
        const target = event.target as HTMLElement | null;
        if (target?.closest(".tree-context-menu") || target?.closest(".tree-context-menu-color-picker-shell")) {
          return;
        }
        setContextMenu(null);
        setContextMenuColorMode(null);
      }}
    >
      <canvas ref={canvasRef} className="tree-canvas" data-testid="tree-canvas" />
      <canvas ref={hoverCanvasRef} className="tree-canvas-overlay" aria-hidden="true" />
      <div ref={hoverTooltipRef} className="hover-tooltip" hidden>
        <div ref={hoverTooltipLabelRef} className="hover-tooltip-label" />
        <div ref={hoverTooltipBodyRef} />
      </div>
      <div ref={distanceTooltipRef} className="distance-measurement-tooltip" hidden>
        <div className="hover-tooltip-label">Measuring path</div>
        <div ref={distanceTooltipNodesRef} />
        <div ref={distanceTooltipValueRef} className="distance-measurement-value" />
        <div ref={distanceTooltipMrcaRef} />
      </div>
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className={`tree-context-menu${contextMenu.tutorialDemo ? " tree-context-menu-tutorial-demo" : ""}`}
          data-tour={contextMenu.tutorialDemo ? "branch-menu-demo" : undefined}
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {contextMenu.tutorialDemo ? <div className="tree-context-menu-tutorial-cue">Right click to open this menu</div> : null}
          <div className="tree-context-menu-title">{contextMenu.name}</div>
          {contextMenu.kind === "node" ? (
            <>
              <div className="tree-context-menu-meta">
                Descendant tips: {contextMenu.descendantTipCount.toLocaleString()}
              </div>
              {tree && tree.buffers.firstChild[contextMenu.node] >= 0 ? (
                <button
                  type="button"
                  className="tree-context-menu-item"
                  title="Fit the selected subtree in the viewport."
                  onClick={handleContextZoomToSubtree}
                >
                  Zoom To Subtree
                </button>
              ) : null}
              <button
                type="button"
                className="tree-context-menu-item"
                title="Open the selected subtree in a separate Big Tree Viewer tab."
                onClick={handleContextOpenSubtreeInNewTab}
              >
                Open Subtree In New Tab
              </button>
              {contextMenuCollapseTarget !== null ? (
                <button
                  type="button"
                  className="tree-context-menu-item"
                  title="Show statistics calculated for the selected subtree."
                  onClick={handleContextViewSubtreeStatistics}
                >
                  View Subtree Statistics
                </button>
              ) : null}
              {contextMenu.descendantTipCount === 1 ? (
                <button
                  type="button"
                  className="tree-context-menu-item"
                  title="Copy this tip label to the clipboard."
                  onClick={handleContextCopyTipName}
                >
                  Copy Tip Name
                </button>
              ) : null}
              {contextMenuCollapseTarget !== null ? (
                collapsedNodes.has(contextMenuCollapseTarget) ? (
                  <button
                    type="button"
                    className="tree-context-menu-item"
                    title="Restore the branches and tips hidden by this collapsed subtree."
                    onClick={() => handleContextCollapse(null)}
                  >
                    Expand Subtree
                  </button>
                ) : (
                  <div className="tree-context-menu-section">
                    <button
                      type="button"
                      className="tree-context-menu-item"
                      title="Choose how to replace this subtree with a collapsed triangle."
                      onClick={() => setContextMenuCollapseMenuOpen((current) => !current)}
                    >
                      Collapse Subtree
                    </button>
                    {contextMenuCollapseMenuOpen ? (
                      <div className="tree-context-menu-swatch-panel">
                        <div title={viewMode === "rectangular" ? undefined : "Only available in rectangular mode."}>
                          <button
                            type="button"
                            className="tree-context-menu-item"
                            disabled={viewMode !== "rectangular"}
                            title={viewMode === "rectangular" ? "Collapse the subtree while preserving its current vertical span." : "Only available in rectangular mode."}
                            onClick={() => handleContextCollapse("preserve-width")}
                          >
                            Preserve Width
                          </button>
                        </div>
                        <button
                          type="button"
                          className="tree-context-menu-item"
                          title="Collapse the subtree to a compact triangle."
                          onClick={() => handleContextCollapse("minimize")}
                        >
                          Minimize
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              ) : null}
              <div className="tree-context-menu-section">
                <button
                  type="button"
                  className="tree-context-menu-item"
                  disabled={!tree || tree.buffers.parent[contextMenu.node] < 0}
                  title={!tree || tree.buffers.parent[contextMenu.node] < 0
                    ? "The root has no incoming branch to color."
                    : "Assign a color to only the selected branch."}
                  onClick={() => setContextMenuColorMode((current) => current === "branch" ? null : "branch")}
                >
                  Color Branch
                </button>
                {contextMenuColorMode === "branch" ? (
                  <div className="tree-context-menu-swatch-panel">
                    {renderColorSwatches(
                      "branch",
                      manualBranchColorAssignments.get(contextMenu.node) ?? null,
                      !tree || tree.buffers.parent[contextMenu.node] < 0,
                    )}
                    <button
                      type="button"
                      className="tree-context-menu-clear"
                      disabled={!manualBranchColorAssignments.has(contextMenu.node)}
                      title="Remove the manual color from this branch."
                      onClick={handleContextClearBranchColor}
                    >
                      Clear Branch Color
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="tree-context-menu-section">
                <button
                  type="button"
                  className="tree-context-menu-item"
                  title="Assign one color to every branch in the selected subtree."
                  onClick={() => setContextMenuColorMode((current) => current === "subtree" ? null : "subtree")}
                >
                  Color Subtree
                </button>
                {contextMenuColorMode === "subtree" ? (
                  <div className="tree-context-menu-swatch-panel">
                    {renderColorSwatches(
                      "subtree",
                      manualSubtreeColorAssignments.get(contextMenu.node) ?? null,
                      false,
                    )}
                    <button
                      type="button"
                      className="tree-context-menu-clear"
                      disabled={!manualSubtreeColorAssignments.has(contextMenu.node)}
                      title="Remove the manual color from this subtree."
                      onClick={handleContextClearSubtreeColor}
                    >
                      Clear Subtree Color
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="tree-context-menu-item"
                title="Measure the branch-length path from this node to another node."
                onClick={handleContextMeasureDistance}
              >
                Measure Distance
              </button>
              <div className="tree-context-menu-section">
                <button
                  type="button"
                  className="tree-context-menu-item"
                  disabled={!tree || tree.buffers.parent[contextMenu.node] < 0}
                  title={!tree || tree.buffers.parent[contextMenu.node] < 0
                    ? "The tree is already rooted at this node."
                    : "Choose how to reroot the tree relative to this branch and node."}
                  onClick={() => setContextMenuRootMenuOpen((current) => !current)}
                >
                  Root
                </button>
                {contextMenuRootMenuOpen ? (
                  <div className="tree-context-menu-swatch-panel">
                    <button
                      type="button"
                      className="tree-context-menu-item"
                      disabled={!tree || tree.buffers.parent[contextMenu.node] < 0}
                      title="Place the root at the midpoint of the selected branch."
                      onClick={() => handleContextReroot("branch")}
                    >
                      Root On Branch
                    </button>
                    <button
                      type="button"
                      className="tree-context-menu-item"
                      disabled={!tree || tree.buffers.parent[contextMenu.node] < 0}
                      title="Place the root at the selected node."
                      onClick={() => handleContextReroot("child")}
                    >
                      Root On Child
                    </button>
                    <button
                      type="button"
                      className="tree-context-menu-item"
                      disabled={!tree || tree.buffers.parent[contextMenu.node] < 0}
                      title="Place the root at the parent node of the selected branch."
                      onClick={() => handleContextReroot("parent")}
                    >
                      Root On Parent
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : contextMenu.kind === "taxonomy" ? (
            <>
              <div className="tree-context-menu-meta">
                Rank: {contextMenu.rank} · Tips: {contextMenu.descendantTipCount.toLocaleString()}
              </div>
              <button
                type="button"
                className="tree-context-menu-item"
                title="Fit the subtree spanning this visible taxonomic group in the viewport."
                onClick={handleContextZoomToTaxonomySubtree}
              >
                Zoom To Group MRCA
              </button>
              <button
                type="button"
                className="tree-context-menu-item"
                title="Open the subtree spanning this visible taxonomic group in a separate Big Tree Viewer tab."
                onClick={handleContextOpenTaxonomySubtreeInNewTab}
              >
                Open Group Subtree In New Tab
              </button>
              {contextMenuCollapseTarget !== null ? (
                <button
                  type="button"
                  className="tree-context-menu-item"
                  title="Show statistics calculated for this taxonomic subtree."
                  onClick={handleContextViewSubtreeStatistics}
                >
                  View Subtree Statistics
                </button>
              ) : null}
              <button
                type="button"
                className="tree-context-menu-item"
                title="Copy this taxonomic group name to the clipboard."
                onClick={handleContextCopyTaxonomyName}
              >
                Copy Name
              </button>
              <button
                type="button"
                className="tree-context-menu-item"
                onClick={handleContextOpenTaxonomySource}
                disabled={taxonomyMap?.source !== "catalogue-of-life" && !contextMenu.taxId}
                title={taxonomyMap?.source === "catalogue-of-life"
                  ? "Search for this taxon in the Catalogue of Life."
                  : contextMenu.taxId
                    ? "Open this taxon in the NCBI Taxonomy Browser."
                    : "No NCBI taxonomy identifier is available for this group."}
              >
                {taxonomyMap?.source === "catalogue-of-life"
                  ? "Open In Catalogue of Life"
                  : "Open In NCBI Taxonomy"}
              </button>
              {contextMenuCollapseTarget !== null ? (
                collapsedNodes.has(contextMenuCollapseTarget) ? (
                  <button
                    type="button"
                    className="tree-context-menu-item"
                    title="Restore the branches and tips hidden by this collapsed group."
                    onClick={() => handleContextCollapse(null)}
                  >
                    Expand Group
                  </button>
                ) : (
                  <div className="tree-context-menu-section">
                    <button
                      type="button"
                      className="tree-context-menu-item"
                      title="Choose how to replace this taxonomic subtree with a collapsed triangle."
                      onClick={() => setContextMenuCollapseMenuOpen((current) => !current)}
                    >
                      Collapse Group
                    </button>
                    {contextMenuCollapseMenuOpen ? (
                      <div className="tree-context-menu-swatch-panel">
                        <div title={viewMode === "rectangular" ? undefined : "Only available in rectangular mode."}>
                          <button
                            type="button"
                            className="tree-context-menu-item"
                            disabled={viewMode !== "rectangular"}
                            title={viewMode === "rectangular" ? "Collapse the group while preserving its current vertical span." : "Only available in rectangular mode."}
                            onClick={() => handleContextCollapse("preserve-width")}
                          >
                            Preserve Width
                          </button>
                        </div>
                        <button
                          type="button"
                          className="tree-context-menu-item"
                          title="Collapse the group to a compact triangle."
                          onClick={() => handleContextCollapse("minimize")}
                        >
                          Minimize
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              ) : null}
              {contextMenu.rank === taxonomyOutermostRank ? (
                <div className="tree-context-menu-section">
                  <button
                    type="button"
                    className="tree-context-menu-item"
                    title="Override the palette color for this top-level taxonomic group."
                    onClick={() => setContextMenuColorMode((current) => current === "taxonomy-root" ? null : "taxonomy-root")}
                  >
                    Color Top-Level Group
                  </button>
                  {contextMenuColorMode === "taxonomy-root" ? (
                    <div className="tree-context-menu-swatch-panel">
                      {renderColorSwatches(
                        "taxonomy-root",
                        taxonomyRootColorAssignments.get(contextMenu.name) ?? null,
                        false,
                      )}
                      <button
                        type="button"
                        className="tree-context-menu-clear"
                        disabled={!taxonomyRootColorAssignments.has(contextMenu.name)}
                        title="Remove the manual color from this top-level group."
                        onClick={handleContextClearTaxonomyRootColor}
                      >
                        Clear Group Color
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="tree-context-menu-meta">
                Silhouette · {contextMenu.rank} · Tips: {contextMenu.descendantTipCount.toLocaleString()}
              </div>
              <button
                type="button"
                className="tree-context-menu-item"
                onClick={handleContextTryAnotherPhyloPic}
                disabled={!onPhyloPicTryAnotherSilhouette}
                title="Replace this silhouette with another available PhyloPic image."
              >
                Try Another Silhouette
              </button>
              <button
                type="button"
                className="tree-context-menu-item"
                onClick={handleContextRemovePhyloPic}
                disabled={!onPhyloPicRemoveSilhouette}
                title="Remove this silhouette from the tree."
              >
                Remove Silhouette
              </button>
              <button
                type="button"
                className="tree-context-menu-item"
                title="Copy this taxonomic group name to the clipboard."
                onClick={handleContextCopyTaxonomyName}
              >
                Copy Name
              </button>
              <button
                type="button"
                className="tree-context-menu-item"
                onClick={() => {
                  if (contextMenu.taxId && typeof window !== "undefined") {
                    window.open(`https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id=${contextMenu.taxId}`, "_blank", "noopener,noreferrer");
                  }
                  setContextMenu(null);
                }}
                disabled={!contextMenu.taxId}
                title={contextMenu.taxId
                  ? "Open this taxon in the NCBI Taxonomy Browser."
                  : "No NCBI taxonomy identifier is available for this silhouette."}
              >
                Open In NCBI Taxonomy
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
