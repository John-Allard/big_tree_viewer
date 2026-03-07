import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { UniformGridIndex, distanceToSegmentSquared, type IndexedSegment } from "../lib/spatialIndex";
import type { HoverInfo, LayoutOrder, TreeModel, ViewMode, ZoomAxisMode } from "../types/tree";

interface TreeCanvasProps {
  tree: TreeModel | null;
  order: LayoutOrder;
  viewMode: ViewMode;
  zoomAxisMode: ZoomAxisMode;
  showTimeStripes: boolean;
  showScaleBars: boolean;
  showGenusLabels: boolean;
  showNodeHeightLabels: boolean;
  fitRequest: number;
  onHoverChange: (hover: HoverInfo | null) => void;
}

interface RectCamera {
  kind: "rect";
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
}

interface CircularCamera {
  kind: "circular";
  scale: number;
  translateX: number;
  translateY: number;
}

type CameraState = RectCamera | CircularCamera;

interface RenderCache {
  orderedChildren: Record<LayoutOrder, number[][]>;
  orderedLeaves: Record<LayoutOrder, number[]>;
  genusBlocks: Record<LayoutOrder, GenusBlock[]>;
  genusBlocksPriority: Record<LayoutOrder, GenusBlock[]>;
  rectSegments: Record<LayoutOrder, IndexedSegment[]>;
  rectIndices: Record<LayoutOrder, UniformGridIndex>;
  circularSegments: Record<LayoutOrder, IndexedSegment[]>;
  circularIndices: Record<LayoutOrder, UniformGridIndex>;
}

interface GenusBlock {
  label: string;
  firstNode: number;
  lastNode: number;
  centerNode: number;
  maxDepth: number;
  memberCount: number;
}

interface ScreenLabel {
  x: number;
  y: number;
  text: string;
  alpha: number;
  fontSize?: number;
  rotation?: number;
  align?: CanvasTextAlign;
}

interface LabelHitbox {
  node: number;
  kind: "rect" | "rotated";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  align?: CanvasTextAlign;
}

interface StripeLevel {
  step: number;
  alpha: number;
}

interface StripeBoundary {
  value: number;
  alpha: number;
}

interface CircularScaleTick {
  boundary: StripeBoundary;
  position: number;
}

interface CircularScaleBar {
  kind: "bottom" | "left";
  axisPosition: number;
  ticks: CircularScaleTick[];
}

type HoverTargetKind = "stem" | "connector" | "label";
type CanvasHoverInfo = HoverInfo & { targetKind: HoverTargetKind };

const LABEL_FONT = `"IBM Plex Sans", "Segoe UI", sans-serif`;
const BRANCH_COLOR = "#0f172a";
const HOVER_COLOR = "#c2410c";
const GENUS_COLOR = "#475569";

function normalizeRotation(degrees: number): number {
  let value = ((degrees + 180) % 360) - 180;
  if (value > 90) {
    value -= 180;
  } else if (value < -90) {
    value += 180;
  }
  return value;
}

function polarToCartesian(radius: number, theta: number): { x: number; y: number } {
  return {
    x: radius * Math.cos(theta),
    y: radius * Math.sin(theta),
  };
}

function niceTickStep(range: number): number {
  if (!Number.isFinite(range) || range <= 0) {
    return 1;
  }
  const rough = range / 6;
  const exponent = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / exponent;
  const options = [1, 2, 2.5, 5, 10];
  const best = options.find((option) => fraction <= option) ?? 10;
  return best * exponent;
}

function formatAgeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (Math.abs(value - Math.round(value)) < 1e-6) {
    return `${Math.round(value)}`;
  }
  if (Math.abs((value * 2) - Math.round(value * 2)) < 1e-6) {
    return value.toFixed(1);
  }
  if (value >= 100) {
    return value.toFixed(0);
  }
  return value.toFixed(1);
}

function nodeHeightValue(tree: TreeModel, node: number): number {
  if (tree.isUltrametric) {
    return Math.max(0, tree.rootAge - tree.buffers.depth[node]);
  }
  return tree.buffers.depth[node];
}

function canPlaceLinearLabel(
  labels: ScreenLabel[],
  x: number,
  y: number,
  minGapY: number,
  minGapX: number,
): boolean {
  for (let index = 0; index < labels.length; index += 1) {
    const placed = labels[index];
    if (Math.abs(placed.y - y) < minGapY && Math.abs(placed.x - x) < minGapX) {
      return false;
    }
  }
  return true;
}

function pointInLabelHitbox(x: number, y: number, hitbox: LabelHitbox): boolean {
  if (hitbox.kind === "rect") {
    return x >= hitbox.x && x <= hitbox.x + hitbox.width && y >= hitbox.y && y <= hitbox.y + hitbox.height;
  }
  const rotation = hitbox.rotation ?? 0;
  const dx = x - hitbox.x;
  const dy = y - hitbox.y;
  const localX = (dx * Math.cos(-rotation)) - (dy * Math.sin(-rotation));
  const localY = (dx * Math.sin(-rotation)) + (dy * Math.cos(-rotation));
  const left = hitbox.align === "right" ? -hitbox.width : 0;
  return localX >= left && localX <= left + hitbox.width && localY >= (-hitbox.height * 0.5) && localY <= (hitbox.height * 0.5);
}

function buildStripeLevels(visibleSpan: number, pixelsPerUnit: number): StripeLevel[] {
  const levels: StripeLevel[] = [];
  const coarseStep = niceTickStep(visibleSpan);
  if (!Number.isFinite(coarseStep) || coarseStep <= 0) {
    return levels;
  }
  levels.push({ step: coarseStep, alpha: 1 });
  let parentStep = coarseStep;
  let parentPx = coarseStep * pixelsPerUnit;
  for (let depth = 0; depth < 3; depth += 1) {
    const alpha = clamp01((parentPx - 155) / 125);
    const nextStep = parentStep * 0.5;
    const nextPx = nextStep * pixelsPerUnit;
    if (alpha <= 0 || nextPx < 20) {
      break;
    }
    levels.push({ step: nextStep, alpha });
    parentStep = nextStep;
    parentPx = nextPx;
  }
  return levels;
}

function buildStripeBoundaries(extent: number, levels: StripeLevel[]): StripeBoundary[] {
  if (!Number.isFinite(extent) || extent <= 0 || levels.length === 0) {
    return [];
  }
  const byValue = new Map<string, StripeBoundary>();
  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    const level = levels[levelIndex];
    if (!Number.isFinite(level.step) || level.step <= 0) {
      continue;
    }
    const alpha = levelIndex === 0 ? 1 : level.alpha * 0.82;
    if (alpha <= 0) {
      continue;
    }
    const count = Math.floor(extent / level.step);
    for (let index = 1; index < count; index += 1) {
      const value = Number((index * level.step).toPrecision(12));
      if (!(value > 0) || !(value < extent)) {
        continue;
      }
      const key = value.toPrecision(12);
      const existing = byValue.get(key);
      if (!existing || alpha > existing.alpha) {
        byValue.set(key, { value, alpha });
      }
    }
  }
  return [...byValue.values()].sort((left, right) => left.value - right.value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function chooseClosestToMidpoint(candidates: number[], midpoint: number): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < candidates.length; index += 1) {
    const distance = Math.abs(candidates[index] - midpoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidates[index];
    }
  }
  return best;
}

function buildCircularScaleBar(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  boundaries: StripeBoundary[],
  rootAge: number,
  scale: number,
): CircularScaleBar | null {
  const margin = 28;
  const bottomY = height - margin;
  const leftX = margin;
  const bottomTicks: CircularScaleTick[] = [];
  const leftTicks: CircularScaleTick[] = [];

  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    const radiusPx = Math.max(0, rootAge - boundary.value) * scale;

    const bottomDy = Math.abs(bottomY - centerY);
    if (radiusPx > bottomDy) {
      const delta = Math.sqrt(Math.max(0, (radiusPx * radiusPx) - (bottomDy * bottomDy)));
      const candidates = [centerX - delta, centerX + delta].filter(
        (candidate) => candidate >= margin && candidate <= width - margin,
      );
      const x = chooseClosestToMidpoint(candidates, width * 0.5);
      if (x !== null) {
        bottomTicks.push({ boundary, position: x });
      }
    }

    const leftDx = Math.abs(leftX - centerX);
    if (radiusPx > leftDx) {
      const delta = Math.sqrt(Math.max(0, (radiusPx * radiusPx) - (leftDx * leftDx)));
      const candidates = [centerY - delta, centerY + delta].filter(
        (candidate) => candidate >= margin && candidate <= height - margin,
      );
      const y = chooseClosestToMidpoint(candidates, height * 0.5);
      if (y !== null) {
        leftTicks.push({ boundary, position: y });
      }
    }
  }

  if (bottomTicks.length === 0 && leftTicks.length === 0) {
    return null;
  }
  if (bottomTicks.length >= leftTicks.length) {
    return { kind: "bottom", axisPosition: bottomY, ticks: bottomTicks };
  }
  return { kind: "left", axisPosition: leftX, ticks: leftTicks };
}

function displayLabelText(raw: string, fallback: string): string {
  const trimmed = raw.trim().replaceAll("_", " ");
  return trimmed || fallback;
}

function displayNodeName(tree: TreeModel, node: number): string {
  const raw = (tree.names[node] || "").trim();
  const isLeaf = tree.buffers.firstChild[node] < 0;
  if (isLeaf) {
    return displayLabelText(raw, `tip-${node}`);
  }
  if (!raw) {
    return "Internal node";
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
    return "Internal node";
  }
  return displayLabelText(raw, "Internal node");
}

function extractGenusToken(name: string): string | null {
  const match = name.trim().match(/^([^_ ]+)[_ ]+/);
  if (!match) {
    return null;
  }
  const token = match[1].trim();
  return token.length >= 2 ? token : null;
}

function computeOrderedLeaves(tree: TreeModel, order: LayoutOrder): number[] {
  return [...tree.leafNodes].sort((left, right) => tree.layouts[order].center[left] - tree.layouts[order].center[right]);
}

function computeGenusBlocks(tree: TreeModel, orderedLeaves: number[]): GenusBlock[] {
  const blocks: GenusBlock[] = [];
  let index = 0;
  while (index < orderedLeaves.length) {
    const node = orderedLeaves[index];
    const token = extractGenusToken(tree.names[node] || "");
    if (!token) {
      index += 1;
      continue;
    }
    let end = index + 1;
    let maxDepth = tree.buffers.depth[node];
    while (end < orderedLeaves.length) {
      const nextNode = orderedLeaves[end];
      const nextToken = extractGenusToken(tree.names[nextNode] || "");
      if (nextToken !== token) {
        break;
      }
      maxDepth = Math.max(maxDepth, tree.buffers.depth[nextNode]);
      end += 1;
    }
    if ((end - index) >= 2) {
      const centerIndex = Math.floor((index + end - 1) * 0.5);
      blocks.push({
        label: token,
        firstNode: orderedLeaves[index],
        lastNode: orderedLeaves[end - 1],
        centerNode: orderedLeaves[centerIndex],
        maxDepth,
        memberCount: end - index,
      });
    }
    index = end;
  }
  return blocks;
}

function prioritizeGenusBlocks(tree: TreeModel, order: LayoutOrder, blocks: GenusBlock[]): GenusBlock[] {
  return [...blocks].sort((left, right) => (
    right.memberCount - left.memberCount
    || tree.layouts[order].center[left.centerNode] - tree.layouts[order].center[right.centerNode]
  ));
}

function computeOrderedChildren(tree: TreeModel, order: LayoutOrder): number[][] {
  const childrenByNode = new Array<number[]>(tree.nodeCount);
  for (let node = 0; node < tree.nodeCount; node += 1) {
    const children: number[] = [];
    let child = tree.buffers.firstChild[node];
    while (child >= 0) {
      children.push(child);
      child = tree.buffers.nextSibling[child];
    }
    if (children.length <= 1 || order === "input") {
      childrenByNode[node] = children;
      continue;
    }
    const originalOrder = new Map<number, number>();
    for (let index = 0; index < children.length; index += 1) {
      originalOrder.set(children[index], index);
    }
    const direction = order === "desc" ? -1 : 1;
    childrenByNode[node] = [...children].sort((left, right) => {
      const diff = tree.buffers.leafCount[left] - tree.buffers.leafCount[right];
      if (diff !== 0) {
        return diff * direction;
      }
      return (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0);
    });
  }
  return childrenByNode;
}

function thetaFor(center: Float64Array, node: number, leafCount: number): number {
  if (leafCount <= 0) {
    return 0;
  }
  return (center[node] / leafCount) * (Math.PI * 2);
}

function wrapPositive(angle: number): number {
  const tau = Math.PI * 2;
  const wrapped = angle % tau;
  return wrapped < 0 ? wrapped + tau : wrapped;
}

function arcAnglesWithinSpan(
  startAngle: number,
  endAngle: number,
  arcStart: number,
  arcLength: number,
): { start: number; end: number } {
  if (arcLength <= 0) {
    return { start: startAngle, end: endAngle };
  }
  const tau = Math.PI * 2;
  const startOffset = wrapPositive(startAngle - arcStart);
  const endOffset = wrapPositive(endAngle - arcStart);
  if (startOffset <= arcLength && endOffset <= arcLength) {
    return {
      start: arcStart + startOffset,
      end: arcStart + endOffset,
    };
  }
  let delta = ((endAngle - startAngle + Math.PI) % tau) - Math.PI;
  if (delta < -Math.PI) {
    delta += tau;
  }
  return {
    start: startAngle,
    end: startAngle + delta,
  };
}

function appendCircularArcSegments(
  segments: IndexedSegment[],
  node: number,
  radius: number,
  startTheta: number,
  endTheta: number,
): void {
  if (!(radius > 0)) {
    return;
  }
  const span = Math.abs(endTheta - startTheta);
  const segmentCount = Math.max(1, Math.min(48, Math.ceil(span / (Math.PI / 32))));
  let previous = polarToCartesian(radius, startTheta);
  for (let index = 1; index <= segmentCount; index += 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / segmentCount);
    const next = polarToCartesian(radius, theta);
    segments.push({
      node,
      kind: "connector",
      x1: previous.x,
      y1: previous.y,
      x2: next.x,
      y2: next.y,
    });
    previous = next;
  }
}

function buildCache(tree: TreeModel): RenderCache {
  const orderedChildren = {
    input: computeOrderedChildren(tree, "input"),
    desc: computeOrderedChildren(tree, "desc"),
    asc: computeOrderedChildren(tree, "asc"),
  } satisfies Record<LayoutOrder, number[][]>;
  const orderedLeaves = {
    input: computeOrderedLeaves(tree, "input"),
    desc: computeOrderedLeaves(tree, "desc"),
    asc: computeOrderedLeaves(tree, "asc"),
  } satisfies Record<LayoutOrder, number[]>;
  const genusBlocks = {
    input: computeGenusBlocks(tree, orderedLeaves.input),
    desc: computeGenusBlocks(tree, orderedLeaves.desc),
    asc: computeGenusBlocks(tree, orderedLeaves.asc),
  } satisfies Record<LayoutOrder, GenusBlock[]>;
  const genusBlocksPriority = {
    input: prioritizeGenusBlocks(tree, "input", genusBlocks.input),
    desc: prioritizeGenusBlocks(tree, "desc", genusBlocks.desc),
    asc: prioritizeGenusBlocks(tree, "asc", genusBlocks.asc),
  } satisfies Record<LayoutOrder, GenusBlock[]>;

  const rectSegments = {
    input: [] as IndexedSegment[],
    desc: [] as IndexedSegment[],
    asc: [] as IndexedSegment[],
  };
  const circularSegments = {
    input: [] as IndexedSegment[],
    desc: [] as IndexedSegment[],
    asc: [] as IndexedSegment[],
  };

  const boundsRect = {
    minX: 0,
    minY: 0,
    maxX: Math.max(tree.maxDepth, 1),
    maxY: Math.max(tree.leafCount - 1, 1),
  };
  const radius = Math.max(tree.maxDepth, 1);
  const boundsCircular = {
    minX: -radius,
    minY: -radius,
    maxX: radius,
    maxY: radius,
  };

  for (const order of ["input", "desc", "asc"] as const) {
    const center = tree.layouts[order].center;
    const layout = tree.layouts[order];
    const children = orderedChildren[order];
    const rect = rectSegments[order];
    const radial = circularSegments[order];
    for (let node = 0; node < tree.nodeCount; node += 1) {
      const parent = tree.buffers.parent[node];
      if (parent < 0) {
        if (children[node].length >= 2) {
          const startTheta = thetaFor(center, children[node][0], tree.leafCount);
          const endTheta = thetaFor(center, children[node][children[node].length - 1], tree.leafCount);
          const arcStart = thetaFor(layout.min, node, tree.leafCount);
          const arcEnd = thetaFor(layout.max, node, tree.leafCount);
          const arcLength = Math.max(0, arcEnd - arcStart);
          const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
          appendCircularArcSegments(radial, node, tree.buffers.depth[node], arcAngles.start, arcAngles.end);
        }
        continue;
      }
      const y = center[node];
      rect.push({
        node,
        kind: "stem",
        x1: tree.buffers.depth[parent],
        y1: y,
        x2: tree.buffers.depth[node],
        y2: y,
      });
      if (children[node].length >= 2) {
        rect.push({
          node,
          kind: "connector",
          x1: tree.buffers.depth[node],
          y1: center[children[node][0]],
          x2: tree.buffers.depth[node],
          y2: center[children[node][children[node].length - 1]],
        });
      }

      const theta = thetaFor(center, node, tree.leafCount);
      const start = polarToCartesian(tree.buffers.depth[parent], theta);
      const end = polarToCartesian(tree.buffers.depth[node], theta);
      radial.push({
        node,
        kind: "stem",
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
      });
      if (children[node].length >= 2) {
        const startTheta = thetaFor(center, children[node][0], tree.leafCount);
        const endTheta = thetaFor(center, children[node][children[node].length - 1], tree.leafCount);
        const arcStart = thetaFor(layout.min, node, tree.leafCount);
        const arcEnd = thetaFor(layout.max, node, tree.leafCount);
        const arcLength = Math.max(0, arcEnd - arcStart);
        const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
        appendCircularArcSegments(radial, node, tree.buffers.depth[node], arcAngles.start, arcAngles.end);
      }
    }
  }

  return {
    orderedChildren,
    orderedLeaves,
    genusBlocks,
    genusBlocksPriority,
    rectSegments,
    rectIndices: {
      input: new UniformGridIndex(rectSegments.input, boundsRect),
      desc: new UniformGridIndex(rectSegments.desc, boundsRect),
      asc: new UniformGridIndex(rectSegments.asc, boundsRect),
    },
    circularSegments,
    circularIndices: {
      input: new UniformGridIndex(circularSegments.input, boundsCircular),
      desc: new UniformGridIndex(circularSegments.desc, boundsCircular),
      asc: new UniformGridIndex(circularSegments.asc, boundsCircular),
    },
  };
}

function lineIntersectsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const segMinX = Math.min(x1, x2);
  const segMaxX = Math.max(x1, x2);
  const segMinY = Math.min(y1, y2);
  const segMaxY = Math.max(y1, y2);
  return segMaxX >= minX && segMinX <= maxX && segMaxY >= minY && segMinY <= maxY;
}

function fitRectCamera(width: number, height: number, tree: TreeModel): RectCamera {
  const padLeft = 32;
  const padTop = 24;
  const padRight = 240;
  const padBottom = 58;
  const usableWidth = Math.max(1, width - padLeft - padRight);
  const usableHeight = Math.max(1, height - padTop - padBottom);
  return {
    kind: "rect",
    scaleX: usableWidth / Math.max(tree.maxDepth, tree.branchLengthMinPositive),
    scaleY: usableHeight / Math.max(1, tree.leafCount - 1),
    translateX: padLeft,
    translateY: padTop,
  };
}

function fitCircularCamera(width: number, height: number, tree: TreeModel): CircularCamera {
  const radius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
  const scale = (Math.min(width, height) * 0.44) / radius;
  return {
    kind: "circular",
    scale,
    translateX: width * 0.5,
    translateY: height * 0.5,
  };
}

function worldToScreenRect(camera: RectCamera, x: number, y: number): { x: number; y: number } {
  return {
    x: camera.translateX + (x * camera.scaleX),
    y: camera.translateY + (y * camera.scaleY),
  };
}

function screenToWorldRect(camera: RectCamera, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - camera.translateX) / camera.scaleX,
    y: (y - camera.translateY) / camera.scaleY,
  };
}

function worldToScreenCircular(camera: CircularCamera, x: number, y: number): { x: number; y: number } {
  return {
    x: camera.translateX + (x * camera.scale),
    y: camera.translateY + (y * camera.scale),
  };
}

function screenToWorldCircular(camera: CircularCamera, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - camera.translateX) / camera.scale,
    y: (y - camera.translateY) / camera.scale,
  };
}

function clampRectCamera(camera: RectCamera, tree: TreeModel, width: number, height: number): void {
  const visibleMargin = 48;
  const spanX = tree.maxDepth * camera.scaleX;
  const spanY = Math.max(1, tree.leafCount - 1) * camera.scaleY;
  const minTranslateX = visibleMargin - spanX;
  const maxTranslateX = width - visibleMargin;
  const minTranslateY = visibleMargin - spanY;
  const maxTranslateY = height - visibleMargin;
  camera.translateX = Math.min(maxTranslateX, Math.max(minTranslateX, camera.translateX));
  camera.translateY = Math.min(maxTranslateY, Math.max(minTranslateY, camera.translateY));
}

function clampCircularCamera(camera: CircularCamera, tree: TreeModel, width: number, height: number): void {
  const visibleMargin = 56;
  const radiusPx = Math.max(tree.maxDepth, tree.branchLengthMinPositive) * camera.scale;
  const minTranslateX = visibleMargin - radiusPx;
  const maxTranslateX = width - visibleMargin + radiusPx;
  const minTranslateY = visibleMargin - radiusPx;
  const maxTranslateY = height - visibleMargin + radiusPx;
  camera.translateX = Math.min(maxTranslateX, Math.max(minTranslateX, camera.translateX));
  camera.translateY = Math.min(maxTranslateY, Math.max(minTranslateY, camera.translateY));
}

function estimateLabelWidth(fontSize: number, maxCharacters: number): number {
  if (maxCharacters <= 0) {
    return 0;
  }
  return Math.max(fontSize * 1.6, maxCharacters * fontSize * 0.61);
}

function circularTimeLabelTheta(order: LayoutOrder): number {
  const offset = Math.PI / 36;
  return order === "desc" ? -offset : offset;
}

export default function TreeCanvas({
  tree,
  order,
  viewMode,
  zoomAxisMode,
  showTimeStripes,
  showScaleBars,
  showGenusLabels,
  showNodeHeightLabels,
  fitRequest,
  onHoverChange,
}: TreeCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<CameraState | null>(null);
  const hoverRef = useRef<CanvasHoverInfo | null>(null);
  const labelHitsRef = useRef<LabelHitbox[]>([]);
  const pointerDownRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const [overlayHover, setOverlayHover] = useState<HoverInfo | null>(null);

  const cache = useMemo(() => (tree ? buildCache(tree) : null), [tree]);
  const maxLeafLabelCharacters = useMemo(() => {
    if (!tree) {
      return 0;
    }
    let maxCharacters = 0;
    for (let index = 0; index < tree.leafNodes.length; index += 1) {
      const node = tree.leafNodes[index];
      const text = tree.names[node] || `tip-${node}`;
      if (text.length > maxCharacters) {
        maxCharacters = text.length;
      }
    }
    return maxCharacters;
  }, [tree]);

  const fitCamera = useCallback(() => {
    if (!tree) {
      return;
    }
    const nextCamera = viewMode === "rectangular"
      ? fitRectCamera(size.width, size.height, tree)
      : fitCircularCamera(size.width, size.height, tree);
    cameraRef.current = nextCamera;
  }, [size.height, size.width, tree, viewMode]);

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

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tree || !cache) {
      return;
    }
    if (!cameraRef.current || cameraRef.current.kind !== (viewMode === "rectangular" ? "rect" : "circular")) {
      fitCamera();
    }
    const camera = cameraRef.current;
    if (!camera) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(size.width * dpr));
    canvas.height = Math.max(1, Math.floor(size.height * dpr));
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.fillStyle = "#fbfcfe";
    ctx.fillRect(0, 0, size.width, size.height);
    labelHitsRef.current = [];

    if (viewMode === "rectangular" && camera.kind === "rect") {
      const layout = tree.layouts[order];
      const children = cache.orderedChildren[order];
      const worldMin = screenToWorldRect(camera, 0, 0);
      const worldMax = screenToWorldRect(camera, size.width, size.height);
      const minX = Math.min(worldMin.x, worldMax.x);
      const maxX = Math.max(worldMin.x, worldMax.x);
      const minY = Math.min(worldMin.y, worldMax.y);
      const maxY = Math.max(worldMin.y, worldMax.y);
      const axisBarHeight = tree.isUltrametric && showScaleBars ? 44 : 0;
      const treeDrawBottom = size.height - axisBarHeight;
      const stripeExtent = tree.isUltrametric ? tree.rootAge : tree.maxDepth;
      const stripeLevels = buildStripeLevels(Math.max(1e-9, maxX - minX), camera.scaleX);
      const stripeBoundaries = buildStripeBoundaries(stripeExtent, stripeLevels);
      const tipLabelsVisible = camera.scaleY > 6;

      if (showTimeStripes) {
        const drawBands = (step: number, alpha: number) => {
          if (!Number.isFinite(step) || step <= 0 || alpha <= 0) {
            return;
          }
          for (let start = 0, index = 0; start < stripeExtent; start += step, index += 1) {
            const next = Math.min(stripeExtent, start + step);
            const left = tree.isUltrametric
              ? worldToScreenRect(camera, tree.rootAge - next, 0).x
              : worldToScreenRect(camera, start, 0).x;
            const right = tree.isUltrametric
              ? worldToScreenRect(camera, tree.rootAge - start, 0).x
              : worldToScreenRect(camera, next, 0).x;
            ctx.fillStyle = index % 2 === 0
              ? `rgba(243,244,246,${0.95 * alpha})`
              : `rgba(255,255,255,${0.95 * alpha})`;
            ctx.fillRect(left, 0, right - left, treeDrawBottom);
          }
        };
        for (let index = 0; index < stripeLevels.length; index += 1) {
          drawBands(stripeLevels[index].step, index === 0 ? 1 : stripeLevels[index].alpha * 0.82);
        }
      }

      ctx.strokeStyle = BRANCH_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let node = 0; node < tree.nodeCount; node += 1) {
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
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
      }
      for (let node = 0; node < tree.nodeCount; node += 1) {
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
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
      }
      ctx.stroke();

      if (hoverRef.current) {
        const hover = hoverRef.current;
        const parent = tree.buffers.parent[hover.node];
        if (parent >= 0) {
          ctx.strokeStyle = HOVER_COLOR;
          ctx.lineWidth = 2;
          ctx.beginPath();
          if (hover.targetKind === "connector" && children[hover.node].length >= 2) {
            const connectorStart = worldToScreenRect(camera, tree.buffers.depth[hover.node], layout.center[children[hover.node][0]]);
            const connectorEnd = worldToScreenRect(
              camera,
              tree.buffers.depth[hover.node],
              layout.center[children[hover.node][children[hover.node].length - 1]],
            );
            ctx.moveTo(connectorStart.x, connectorStart.y);
            ctx.lineTo(connectorEnd.x, connectorEnd.y);
          } else {
            const parentY = layout.center[parent];
            const childY = layout.center[hover.node];
            if (Math.abs(childY - parentY) > 1e-6) {
              const connectorStart = worldToScreenRect(camera, tree.buffers.depth[parent], Math.min(parentY, childY));
              const connectorEnd = worldToScreenRect(camera, tree.buffers.depth[parent], Math.max(parentY, childY));
              ctx.moveTo(connectorStart.x, connectorStart.y);
              ctx.lineTo(connectorEnd.x, connectorEnd.y);
            }
          }
          const childY = layout.center[hover.node];
          const start = worldToScreenRect(camera, tree.buffers.depth[parent], childY);
          const end = worldToScreenRect(camera, tree.buffers.depth[hover.node], childY);
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        }
      }

      let visibleTipLabels: Array<{ node: number; text: string; x: number; y: number }> = [];
      let tipLabelRightEdge = Number.NEGATIVE_INFINITY;
      let tipLabelRightX = Number.NEGATIVE_INFINITY;
      const tipFontSize = Math.max(10, Math.min(22, camera.scaleY * 0.68));
      const measuredLabels: Array<{ node: number; text: string; x: number; y: number; width: number }> = [];
      const needTipEnvelope = tipLabelsVisible || camera.scaleY > 3.1;
      if (needTipEnvelope) {
        ctx.font = `${tipFontSize}px ${LABEL_FONT}`;
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        for (let index = 0; index < tree.leafNodes.length; index += 1) {
          const node = tree.leafNodes[index];
          const y = layout.center[node];
          if (y < minY - 2 || y > maxY + 2) {
            continue;
          }
          const text = displayLabelText(tree.names[node] || "", `tip-${node}`);
          const screen = worldToScreenRect(camera, tree.buffers.depth[node], y);
          const x = screen.x + 8;
          const width = ctx.measureText(text).width;
          measuredLabels.push({ node, text, x, y: screen.y, width });
          tipLabelRightX = Math.max(tipLabelRightX, x);
          tipLabelRightEdge = Math.max(tipLabelRightEdge, x + width);
        }
      }
      const maxVisibleLabels = 4500;
      if (tipLabelsVisible && measuredLabels.length <= maxVisibleLabels) {
        visibleTipLabels = measuredLabels.map(({ node, text, x, y }) => ({ node, text, x, y }));
      }

      if (showGenusLabels) {
        const priorityBlocks = cache.genusBlocksPriority[order];
        const positionalBlocks = cache.genusBlocks[order];
        const baseFontSize = Math.max(10, Math.min(16, camera.scaleY * 0.38));
        const stableTipLabelWidth = estimateLabelWidth(tipFontSize, maxLeafLabelCharacters);
        const stableTipEnvelopeRightEdge = Number.isFinite(tipLabelRightX)
          ? tipLabelRightX + stableTipLabelWidth
          : tipLabelRightEdge;
        const outboardMinX = Number.isFinite(stableTipEnvelopeRightEdge)
          ? stableTipEnvelopeRightEdge + 22
          : Number.NEGATIVE_INFINITY;
        const offsetPx = 10;
        const pullAway = clamp01((camera.scaleY - 2.4) / 4.6);
        ctx.fillStyle = GENUS_COLOR;
        ctx.strokeStyle = GENUS_COLOR;
        ctx.lineWidth = 1;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        const maxGenusLabels = Math.max(18, Math.ceil(size.height / 18));
        const placedLabels: ScreenLabel[] = [];
        const connectorBlocks: Array<{ x: number; y1: number; y2: number }> = [];
        const placedCenters = new Set<number>();
        const tryPlaceBlock = (block: GenusBlock): void => {
          if (placedLabels.length >= maxGenusLabels || placedCenters.has(block.centerNode)) {
            return;
          }
          const y1 = layout.center[block.firstNode];
          const y2 = layout.center[block.lastNode];
          if (y2 < minY - 2 || y1 > maxY + 2) {
            return;
          }
          const spanPx = Math.abs(y2 - y1) * camera.scaleY;
          const localX = worldToScreenRect(camera, block.maxDepth, 0).x + offsetPx;
          const outboardX = Number.isFinite(outboardMinX) ? Math.max(localX, outboardMinX) : localX;
          const x = localX + ((outboardX - localX) * pullAway);
          if (x < -80 || x > size.width + 160) {
            return;
          }
          const screenStart = worldToScreenRect(camera, block.maxDepth, y1);
          const screenEnd = worldToScreenRect(camera, block.maxDepth, y2);
          const labelY = (screenStart.y + screenEnd.y) * 0.5;
          const fontSize = Math.max(baseFontSize, Math.min(22, baseFontSize + (spanPx * 0.08)));
          if (!canPlaceLinearLabel(
            placedLabels,
            x + 7,
            labelY,
            fontSize * 0.9,
            Math.max(24, fontSize * 1.75),
          )) {
            return;
          }
          placedCenters.add(block.centerNode);
          placedLabels.push({
            x: x + 7,
            y: labelY,
            text: block.label,
            alpha: 1,
            fontSize,
          });
          connectorBlocks.push({
            x,
            y1: screenStart.y,
            y2: screenEnd.y,
          });
        };
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
          ctx.beginPath();
          for (let index = 0; index < connectorBlocks.length; index += 1) {
            const block = connectorBlocks[index];
            ctx.moveTo(block.x, block.y1);
            ctx.lineTo(block.x, block.y2);
          }
          ctx.globalAlpha = 0.82;
          ctx.globalAlpha = 1;
          ctx.stroke();
        }
        for (let index = 0; index < placedLabels.length; index += 1) {
          const label = placedLabels[index];
          ctx.font = `${label.fontSize ?? baseFontSize}px ${LABEL_FONT}`;
          ctx.fillText(label.text, label.x, label.y);
        }
        ctx.globalAlpha = 1;
      }

      if (visibleTipLabels.length > 0) {
        ctx.font = `${tipFontSize}px ${LABEL_FONT}`;
        ctx.fillStyle = "#111827";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (let index = 0; index < visibleTipLabels.length; index += 1) {
          const label = visibleTipLabels[index];
          ctx.fillText(label.text, label.x, label.y);
          const width = ctx.measureText(label.text).width;
          labelHitsRef.current.push({
            node: label.node,
            kind: "rect",
            x: label.x,
            y: label.y - (tipFontSize * 0.55),
            width,
            height: tipFontSize * 1.1,
          });
        }
      }

      if (showNodeHeightLabels && camera.scaleX > 1.2) {
        const labels: ScreenLabel[] = [];
        const fontSize = Math.max(9, Math.min(13, Math.min(camera.scaleY * 0.34, camera.scaleX * 0.25)));
        ctx.font = `${fontSize}px ${LABEL_FONT}`;
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
          if (camera.scaleY <= 3.2 && subtreeSpanPx < 10 && branchSpanPx < 14) {
            continue;
          }
          const screen = worldToScreenRect(camera, x, y);
          const labelY = screen.y - 5;
          if (!canPlaceLinearLabel(labels, screen.x, labelY, fontSize * 1.7, fontSize * 4.8)) {
            continue;
          }
          labels.push({
            x: screen.x,
            y: labelY,
            text: formatAgeNumber(nodeHeightValue(tree, node)),
            alpha: 0.78,
          });
        }
        for (let index = 0; index < labels.length; index += 1) {
          const label = labels[index];
          ctx.globalAlpha = label.alpha;
          ctx.fillText(label.text, label.x, label.y);
        }
        ctx.globalAlpha = 1;
      }

      if (tree.isUltrametric && showScaleBars) {
        ctx.fillStyle = "rgba(251,252,254,0.96)";
        ctx.fillRect(0, size.height - axisBarHeight, size.width, axisBarHeight);
        const axisY = size.height - 28;
        ctx.strokeStyle = "#6b7280";
        ctx.fillStyle = "#6b7280";
        ctx.lineWidth = 1;
        ctx.font = `11px ${LABEL_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.beginPath();
        const axisStart = worldToScreenRect(camera, 0, 0).x;
        const axisEnd = worldToScreenRect(camera, tree.rootAge, 0).x;
        ctx.moveTo(axisStart, axisY);
        ctx.lineTo(axisEnd, axisY);
        if (stripeBoundaries.length > 0) {
          for (let index = 0; index < stripeBoundaries.length; index += 1) {
            const boundary = stripeBoundaries[index];
            const x = worldToScreenRect(camera, tree.rootAge - boundary.value, 0).x;
            ctx.globalAlpha = 0.35 + (0.65 * boundary.alpha);
            ctx.moveTo(x, axisY);
            ctx.lineTo(x, axisY + (4 + (3 * boundary.alpha)));
          }
          ctx.globalAlpha = 1;
          ctx.stroke();
          for (let index = 0; index < stripeBoundaries.length; index += 1) {
            const boundary = stripeBoundaries[index];
            const x = worldToScreenRect(camera, tree.rootAge - boundary.value, 0).x;
            ctx.globalAlpha = 0.35 + (0.65 * boundary.alpha);
            ctx.fillText(`${formatAgeNumber(boundary.value)} mya`, x, axisY + 8);
          }
          ctx.globalAlpha = 1;
        }
      } else {
        ctx.stroke();
      }
    }

    if (viewMode === "circular" && camera.kind === "circular") {
      const layout = tree.layouts[order];
      const children = cache.orderedChildren[order];
      const maxRadius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
      const stripeExtent = tree.isUltrametric ? tree.rootAge : tree.maxDepth;
      const visibleRadius = Math.max(1e-9, Math.min(size.width, size.height) / (2 * camera.scale));
      const stripeLevels = buildStripeLevels(visibleRadius, camera.scale);
      const stripeBoundaries = buildStripeBoundaries(stripeExtent, stripeLevels);
      const centerPoint = worldToScreenCircular(camera, 0, 0);
      const fullyVisibleRadiusPx = Math.min(
        centerPoint.x,
        size.width - centerPoint.x,
        centerPoint.y,
        size.height - centerPoint.y,
      );
      const visibleCircleFraction = tree.isUltrametric
        ? fullyVisibleRadiusPx / Math.max(1e-9, tree.rootAge * camera.scale)
        : 0;
      const showCentralTimeLabels = tree.isUltrametric && showScaleBars && visibleCircleFraction >= 0.72;
      const circularScaleBar = tree.isUltrametric && showScaleBars && !showCentralTimeLabels
        ? buildCircularScaleBar(
          centerPoint.x,
          centerPoint.y,
          size.width,
          size.height,
          stripeBoundaries,
          tree.rootAge,
          camera.scale,
        )
        : null;

      if (showTimeStripes) {
        const center = { x: camera.translateX, y: camera.translateY };
        const drawBands = (step: number, alpha: number) => {
          if (!Number.isFinite(step) || step <= 0 || alpha <= 0) {
            return;
          }
          for (let start = 0, index = 0; start < stripeExtent; start += step, index += 1) {
            const next = Math.min(stripeExtent, start + step);
            const outer = (tree.isUltrametric ? tree.rootAge - start : next) * camera.scale;
            const inner = (tree.isUltrametric ? tree.rootAge - next : start) * camera.scale;
            ctx.beginPath();
            ctx.arc(center.x, center.y, outer, 0, Math.PI * 2);
            ctx.arc(center.x, center.y, inner, 0, Math.PI * 2, true);
            ctx.closePath();
            ctx.fillStyle = index % 2 === 0
              ? `rgba(243,244,246,${0.95 * alpha})`
              : `rgba(255,255,255,${0.95 * alpha})`;
            ctx.fill();
          }
        };
        for (let index = 0; index < stripeLevels.length; index += 1) {
          drawBands(stripeLevels[index].step, index === 0 ? 1 : stripeLevels[index].alpha * 0.82);
        }
      }

      const topLeft = screenToWorldCircular(camera, 0, 0);
      const bottomRight = screenToWorldCircular(camera, size.width, size.height);
      const minX = Math.min(topLeft.x, bottomRight.x);
      const maxX = Math.max(topLeft.x, bottomRight.x);
      const minY = Math.min(topLeft.y, bottomRight.y);
      const maxY = Math.max(topLeft.y, bottomRight.y);

      ctx.strokeStyle = BRANCH_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let node = 0; node < tree.nodeCount; node += 1) {
        const ordered = children[node];
        if (ordered.length < 2) {
          continue;
        }
        const radius = tree.buffers.depth[node];
        const startTheta = thetaFor(layout.center, ordered[0], tree.leafCount);
        const endTheta = thetaFor(layout.center, ordered[ordered.length - 1], tree.leafCount);
        const arcStart = thetaFor(layout.min, node, tree.leafCount);
        const arcEnd = thetaFor(layout.max, node, tree.leafCount);
        const arcLength = Math.max(0, arcEnd - arcStart);
        const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
        const radiusPx = radius * camera.scale;
        if (radiusPx < 0.25) {
          continue;
        }
        const centerPoint = worldToScreenCircular(camera, 0, 0);
        ctx.moveTo(
          centerPoint.x + Math.cos(arcAngles.start) * radiusPx,
          centerPoint.y + Math.sin(arcAngles.start) * radiusPx,
        );
        ctx.arc(centerPoint.x, centerPoint.y, radiusPx, arcAngles.start, arcAngles.end, false);
      }
      for (let node = 0; node < tree.nodeCount; node += 1) {
        const parent = tree.buffers.parent[node];
        if (parent < 0) {
          continue;
        }
        const theta = thetaFor(layout.center, node, tree.leafCount);
        const startWorld = polarToCartesian(tree.buffers.depth[parent], theta);
        const endWorld = polarToCartesian(tree.buffers.depth[node], theta);
        if (!lineIntersectsRect(startWorld.x, startWorld.y, endWorld.x, endWorld.y, minX, minY, maxX, maxY)) {
          continue;
        }
        const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
        const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
      }
      ctx.stroke();

      if (hoverRef.current) {
        const hover = hoverRef.current;
        const parent = tree.buffers.parent[hover.node];
        if (parent >= 0) {
          ctx.strokeStyle = HOVER_COLOR;
          ctx.lineWidth = 2;
          ctx.beginPath();
          const childTheta = thetaFor(layout.center, hover.node, tree.leafCount);
          if (hover.targetKind === "connector" && children[hover.node].length >= 2) {
            const startTheta = thetaFor(layout.center, children[hover.node][0], tree.leafCount);
            const endTheta = thetaFor(layout.center, children[hover.node][children[hover.node].length - 1], tree.leafCount);
            const arcStart = thetaFor(layout.min, hover.node, tree.leafCount);
            const arcEnd = thetaFor(layout.max, hover.node, tree.leafCount);
            const arcLength = Math.max(0, arcEnd - arcStart);
            const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
            const radiusPx = tree.buffers.depth[hover.node] * camera.scale;
            if (radiusPx >= 0.25) {
              ctx.moveTo(
                centerPoint.x + Math.cos(arcAngles.start) * radiusPx,
                centerPoint.y + Math.sin(arcAngles.start) * radiusPx,
              );
              ctx.arc(centerPoint.x, centerPoint.y, radiusPx, arcAngles.start, arcAngles.end, false);
            }
          } else {
            const parentTheta = thetaFor(layout.center, parent, tree.leafCount);
            if (Math.abs(childTheta - parentTheta) > 1e-6) {
              const arcStart = thetaFor(layout.min, parent, tree.leafCount);
              const arcEnd = thetaFor(layout.max, parent, tree.leafCount);
              const arcLength = Math.max(0, arcEnd - arcStart);
              const arcAngles = arcAnglesWithinSpan(parentTheta, childTheta, arcStart, arcLength);
              const radiusPx = tree.buffers.depth[parent] * camera.scale;
              if (radiusPx >= 0.25) {
                ctx.moveTo(
                  centerPoint.x + Math.cos(arcAngles.start) * radiusPx,
                  centerPoint.y + Math.sin(arcAngles.start) * radiusPx,
                );
                ctx.arc(centerPoint.x, centerPoint.y, radiusPx, arcAngles.start, arcAngles.end, false);
              }
            }
          }
          const startWorld = polarToCartesian(tree.buffers.depth[parent], childTheta);
          const endWorld = polarToCartesian(tree.buffers.depth[hover.node], childTheta);
          const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
          const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        }
      }

      const angularSpacingPx = camera.scale * maxRadius * (Math.PI * 2 / Math.max(1, tree.leafCount));
      const tipLabelsVisible = angularSpacingPx > 7;
      const tipFontSize = Math.max(9, Math.min(20, angularSpacingPx * 0.85));
      const tipLabelRadius = maxRadius + (20 / camera.scale);
      const circularTipVisibilityMargin = 140;
      let circularVisibleTipLabels: Array<{ node: number; theta: number; x: number; y: number; text: string; width: number }> = [];
      let maxVisibleTipLabelWidth = 0;
      if (tipLabelsVisible) {
        ctx.font = `${tipFontSize}px ${LABEL_FONT}`;
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        for (let index = 0; index < tree.leafNodes.length; index += 1) {
          const node = tree.leafNodes[index];
          const theta = thetaFor(layout.center, node, tree.leafCount);
          const point = polarToCartesian(tipLabelRadius, theta);
          const screen = worldToScreenCircular(camera, point.x, point.y);
          if (
            screen.x < -circularTipVisibilityMargin ||
            screen.x > size.width + circularTipVisibilityMargin ||
            screen.y < -circularTipVisibilityMargin ||
            screen.y > size.height + circularTipVisibilityMargin
          ) {
            continue;
          }
          const text = displayLabelText(tree.names[node] || "", `tip-${node}`);
          const width = ctx.measureText(text).width;
          circularVisibleTipLabels.push({ node, theta, x: screen.x, y: screen.y, text, width });
          maxVisibleTipLabelWidth = Math.max(maxVisibleTipLabelWidth, width);
        }
      }
      let circularGenusLabels: ScreenLabel[] = [];
      let circularGenusArcs: Array<{ lineRadiusPx: number; startTheta: number; endTheta: number }> = [];
      let circularGenusBaseFontSize = 0;
      if (showGenusLabels) {
        const priorityBlocks = cache.genusBlocksPriority[order];
        const positionalBlocks = cache.genusBlocks[order];
        const baseFontSize = Math.max(10, Math.min(18, Math.max(angularSpacingPx * 0.92, 10)));
        const arcOffsetWorld = 12 / camera.scale;
        const tipLabelPressure = clamp01((angularSpacingPx - 4) / 4);
        const pullAway = clamp01((angularSpacingPx - 2.8) / 4.4);
        const localLineRadius = arcOffsetWorld;
        const stableTipLabelWidth = estimateLabelWidth(tipFontSize, maxLeafLabelCharacters);
        const tipOuterRadius = tipLabelRadius + ((stableTipLabelWidth + (tipFontSize * 0.8) + 12) / camera.scale);
        const outboardLineRadius = tipOuterRadius + ((tipFontSize * 2.8 + 48) / camera.scale);
        const localLabelRadius = arcOffsetWorld + (8 / camera.scale);
        ctx.font = `${baseFontSize}px ${LABEL_FONT}`;
        ctx.fillStyle = GENUS_COLOR;
        ctx.strokeStyle = GENUS_COLOR;
        ctx.lineWidth = 1.1;
        ctx.textBaseline = "middle";
        const maxGenusLabels = Math.max(
          18,
          Math.ceil((Math.PI * Math.min(size.width, size.height)) / 34),
        );
        const placedLabels: ScreenLabel[] = [];
        const connectorArcs: Array<{ lineRadiusPx: number; startTheta: number; endTheta: number }> = [];
        const placedCenters = new Set<number>();
        const tryPlaceBlock = (block: GenusBlock): void => {
          if (placedLabels.length >= maxGenusLabels || placedCenters.has(block.centerNode)) {
            return;
          }
          const startTheta = thetaFor(layout.center, block.firstNode, tree.leafCount);
          const endTheta = thetaFor(layout.center, block.lastNode, tree.leafCount);
          const midTheta = thetaFor(layout.center, block.centerNode, tree.leafCount);
          let angularSpan = endTheta - startTheta;
          if (angularSpan < 0) {
            angularSpan += Math.PI * 2;
          }
          const localAbsLineRadius = block.maxDepth + localLineRadius;
          const localAbsLabelRadius = block.maxDepth + localLabelRadius;
          const preliminaryLineRadius = (localAbsLineRadius * (1 - pullAway)) + (outboardLineRadius * pullAway);
          const preliminaryArcLengthPx = preliminaryLineRadius * camera.scale * angularSpan;
          const fontGrowth = 0.018 - (0.007 * tipLabelPressure);
          const maxFontSize = 22 + (2 * tipLabelPressure);
          const fontSize = Math.max(baseFontSize, Math.min(maxFontSize, baseFontSize + (preliminaryArcLengthPx * fontGrowth)));
          const adjustedOutboardLineRadius = tipOuterRadius + ((tipFontSize + fontSize * 1.8 + 34) / camera.scale);
          const adjustedOutboardLabelRadius = adjustedOutboardLineRadius + ((fontSize * 2.2 + 24) / camera.scale);
          const lineRadius = (localAbsLineRadius * (1 - pullAway)) + (adjustedOutboardLineRadius * pullAway);
          const labelRadius = (localAbsLabelRadius * (1 - pullAway)) + (adjustedOutboardLabelRadius * pullAway);
          const lineRadiusPx = lineRadius * camera.scale;
          const labelPoint = worldToScreenCircular(
            camera,
            Math.cos(midTheta) * labelRadius,
            Math.sin(midTheta) * labelRadius,
          );
          if (
            labelPoint.x < -160 || labelPoint.x > size.width + 160 ||
            labelPoint.y < -160 || labelPoint.y > size.height + 160
          ) {
            return;
          }
          const deg = midTheta * 180 / Math.PI;
          const onRightSide = Math.cos(midTheta) >= 0;
          const rotation = normalizeRotation(onRightSide ? deg : deg + 180);
          if (!canPlaceLinearLabel(
            placedLabels,
            labelPoint.x,
            labelPoint.y,
            fontSize * 0.9,
            fontSize * 3.5,
          )) {
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
          });
          connectorArcs.push({
            lineRadiusPx,
            startTheta,
            endTheta,
          });
        };
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
      }
      if (circularGenusArcs.length > 0) {
        ctx.strokeStyle = GENUS_COLOR;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (let index = 0; index < circularGenusArcs.length; index += 1) {
          const arc = circularGenusArcs[index];
          ctx.moveTo(
            centerPoint.x + Math.cos(arc.startTheta) * arc.lineRadiusPx,
            centerPoint.y + Math.sin(arc.startTheta) * arc.lineRadiusPx,
          );
          ctx.arc(centerPoint.x, centerPoint.y, arc.lineRadiusPx, arc.startTheta, arc.endTheta, false);
        }
        ctx.globalAlpha = 0.76;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (tipLabelsVisible) {
        const fontSize = tipFontSize;
        ctx.font = `${fontSize}px ${LABEL_FONT}`;
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        const maxVisibleLabels = 3200;
        if (circularVisibleTipLabels.length <= maxVisibleLabels) {
          for (let index = 0; index < circularVisibleTipLabels.length; index += 1) {
            const label = circularVisibleTipLabels[index];
            const { node, theta, x, y } = label;
            const deg = theta * 180 / Math.PI;
            const onRightSide = Math.cos(theta) >= 0;
            const rotation = normalizeRotation(onRightSide ? deg : deg + 180);
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(rotation * Math.PI / 180);
            ctx.textAlign = onRightSide ? "left" : "right";
            ctx.fillText(label.text, 0, 0);
            ctx.restore();
            labelHitsRef.current.push({
              node,
              kind: "rotated",
              x,
              y,
              width: label.width,
              height: fontSize * 1.15,
              rotation: rotation * Math.PI / 180,
              align: onRightSide ? "left" : "right",
            });
          }
        }
      }
      for (let index = 0; index < circularGenusLabels.length; index += 1) {
        const label = circularGenusLabels[index];
        ctx.font = `${label.fontSize ?? circularGenusBaseFontSize}px ${LABEL_FONT}`;
        ctx.fillStyle = GENUS_COLOR;
        ctx.save();
        ctx.translate(label.x, label.y);
        ctx.rotate(label.rotation ?? 0);
        ctx.textAlign = label.align ?? "left";
        ctx.fillText(label.text, 0, 0);
        ctx.restore();
      }

      if (showNodeHeightLabels && camera.scale > 12) {
        const fontSize = Math.max(8, Math.min(12, camera.scale * 0.045));
        const labels: ScreenLabel[] = [];
        ctx.font = `${fontSize}px ${LABEL_FONT}`;
        ctx.fillStyle = "#64748b";
        ctx.textBaseline = "middle";
        for (let node = 0; node < tree.nodeCount; node += 1) {
          if (tree.buffers.firstChild[node] < 0) {
            continue;
          }
          const theta = thetaFor(layout.center, node, tree.leafCount);
          const radius = tree.buffers.depth[node] + (10 / camera.scale);
          const point = polarToCartesian(radius, theta);
          const screen = worldToScreenCircular(camera, point.x, point.y);
          if (
            screen.x < -40 || screen.x > size.width + 40 ||
            screen.y < -40 || screen.y > size.height + 40
          ) {
            continue;
          }
          if (!canPlaceLinearLabel(labels, screen.x, screen.y, fontSize * 2.1, fontSize * 5.5)) {
            continue;
          }
          const deg = theta * 180 / Math.PI;
          const onRightSide = Math.cos(theta) >= 0;
          labels.push({
            x: screen.x,
            y: screen.y,
            text: formatAgeNumber(nodeHeightValue(tree, node)),
            alpha: 0.76,
            rotation: normalizeRotation(onRightSide ? deg : deg + 180) * Math.PI / 180,
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
        }
        ctx.globalAlpha = 1;
      }

      if (tree.isUltrametric && showScaleBars) {
        ctx.fillStyle = "#6b7280";
        ctx.font = `11px ${LABEL_FONT}`;
        ctx.textBaseline = "middle";
        if (showCentralTimeLabels) {
          const labelTheta = circularTimeLabelTheta(order);
          ctx.textAlign = Math.cos(labelTheta) >= 0 ? "left" : "right";
          for (let index = 0; index < stripeBoundaries.length; index += 1) {
            const boundary = stripeBoundaries[index];
            const radius = Math.max(0, tree.rootAge - boundary.value) + (10 / camera.scale);
            const point = polarToCartesian(radius, labelTheta);
            const screen = worldToScreenCircular(camera, point.x, point.y);
            ctx.globalAlpha = 0.35 + (0.65 * boundary.alpha);
            ctx.fillText(`${formatAgeNumber(boundary.value)} mya`, screen.x, screen.y);
          }
          ctx.globalAlpha = 1;
        } else if (circularScaleBar) {
          ctx.fillStyle = "rgba(251,252,254,0.97)";
          if (circularScaleBar.kind === "bottom") {
            ctx.fillRect(0, Math.max(0, circularScaleBar.axisPosition - 12), size.width, size.height);
          } else {
            ctx.fillRect(0, 0, circularScaleBar.axisPosition + 16, size.height);
          }

          ctx.strokeStyle = "#6b7280";
          ctx.fillStyle = "#6b7280";
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (circularScaleBar.kind === "bottom") {
            ctx.moveTo(24, circularScaleBar.axisPosition);
            ctx.lineTo(size.width - 24, circularScaleBar.axisPosition);
            for (let index = 0; index < circularScaleBar.ticks.length; index += 1) {
              const tick = circularScaleBar.ticks[index];
              ctx.globalAlpha = 0.35 + (0.65 * tick.boundary.alpha);
              ctx.moveTo(tick.position, circularScaleBar.axisPosition);
              ctx.lineTo(tick.position, circularScaleBar.axisPosition + (4 + (3 * tick.boundary.alpha)));
            }
            ctx.globalAlpha = 1;
            ctx.stroke();
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            for (let index = 0; index < circularScaleBar.ticks.length; index += 1) {
              const tick = circularScaleBar.ticks[index];
              ctx.globalAlpha = 0.35 + (0.65 * tick.boundary.alpha);
              ctx.fillText(
                `${formatAgeNumber(tick.boundary.value)} mya`,
                tick.position,
                circularScaleBar.axisPosition + 8,
              );
            }
            ctx.globalAlpha = 1;
          } else {
            ctx.moveTo(circularScaleBar.axisPosition, 24);
            ctx.lineTo(circularScaleBar.axisPosition, size.height - 24);
            for (let index = 0; index < circularScaleBar.ticks.length; index += 1) {
              const tick = circularScaleBar.ticks[index];
              ctx.globalAlpha = 0.35 + (0.65 * tick.boundary.alpha);
              ctx.moveTo(circularScaleBar.axisPosition, tick.position);
              ctx.lineTo(circularScaleBar.axisPosition - (4 + (3 * tick.boundary.alpha)), tick.position);
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
              ctx.fillText(`${formatAgeNumber(tick.boundary.value)} mya`, 0, 0);
              ctx.restore();
            }
          }
        }
      }
    }
  }, [cache, fitCamera, maxLeafLabelCharacters, order, showGenusLabels, showNodeHeightLabels, showScaleBars, showTimeStripes, size.height, size.width, tree, viewMode]);

  useLayoutEffect(() => {
    if (!tree || !cache) {
      return;
    }
    fitCamera();
  }, [cache, fitCamera, fitRequest, tree, viewMode]);

  useLayoutEffect(() => {
    draw();
  }, [draw, fitRequest]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tree || !cache) {
      return undefined;
    }

    const updateHover = (event: PointerEvent): void => {
      const camera = cameraRef.current;
      if (!camera) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      let hover: CanvasHoverInfo | null = null;

      for (let index = labelHitsRef.current.length - 1; index >= 0; index -= 1) {
        const hitbox = labelHitsRef.current[index];
        if (!pointInLabelHitbox(localX, localY, hitbox)) {
          continue;
        }
        const node = hitbox.node;
        const parent = tree.buffers.parent[node];
        hover = {
          node,
          branchLength: tree.buffers.branchLength[node],
          parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
          parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
          childAge: tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[node]) : null,
          name: displayNodeName(tree, node),
          screenX: localX,
          screenY: localY,
          targetKind: "label",
        };
        break;
      }

      if (hover) {
        const prev = hoverRef.current;
        if (!prev || prev.node !== hover.node || prev.name !== hover.name || prev.targetKind !== hover.targetKind) {
          hoverRef.current = hover;
          setOverlayHover(hover);
          onHoverChange(hover);
          draw();
        } else if (prev.screenX !== hover.screenX || prev.screenY !== hover.screenY) {
          hoverRef.current = hover;
          setOverlayHover(hover);
        }
        return;
      }

      if (camera.kind === "rect") {
        const world = screenToWorldRect(camera, localX, localY);
        const radiusX = 6 / camera.scaleX;
        const radiusY = 6 / camera.scaleY;
        const candidates = cache.rectIndices[order].query(world.x, world.y, radiusX, radiusY);
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < candidates.length; index += 1) {
          const segment = candidates[index];
          const start = worldToScreenRect(camera, segment.x1, segment.y1);
          const end = worldToScreenRect(camera, segment.x2, segment.y2);
          const distance = distanceToSegmentSquared(localX, localY, start.x, start.y, end.x, end.y);
          if (distance < bestDistance) {
            bestDistance = distance;
            const threshold = 16;
            if (distance <= threshold) {
              const node = segment.node;
              const parent = tree.buffers.parent[node];
              hover = {
                node,
                branchLength: tree.buffers.branchLength[node],
                parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
                parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
                childAge: tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[node]) : null,
                name: displayNodeName(tree, node),
                screenX: localX,
                screenY: localY,
                targetKind: segment.kind,
              };
            }
          }
        }
      } else {
        const world = screenToWorldCircular(camera, localX, localY);
        const radius = 6 / camera.scale;
        const candidates = cache.circularIndices[order].query(world.x, world.y, radius, radius);
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < candidates.length; index += 1) {
          const segment = candidates[index];
          const start = worldToScreenCircular(camera, segment.x1, segment.y1);
          const end = worldToScreenCircular(camera, segment.x2, segment.y2);
          const distance = distanceToSegmentSquared(localX, localY, start.x, start.y, end.x, end.y);
          if (distance < bestDistance && distance <= 16) {
            bestDistance = distance;
            const node = segment.node;
            const parent = tree.buffers.parent[node];
            hover = {
              node,
              branchLength: tree.buffers.branchLength[node],
              parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
              parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
              childAge: tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[node]) : null,
              name: displayNodeName(tree, node),
              screenX: localX,
              screenY: localY,
              targetKind: segment.kind,
            };
          }
        }
      }

      const prev = hoverRef.current;
      if (
        prev?.node !== hover?.node ||
        prev?.targetKind !== hover?.targetKind ||
        prev?.screenX !== hover?.screenX ||
        prev?.screenY !== hover?.screenY
      ) {
        hoverRef.current = hover;
        setOverlayHover(hover);
        onHoverChange(hover);
        draw();
      }
    };

    const handlePointerDown = (event: PointerEvent): void => {
      pointerDownRef.current = true;
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent): void => {
      const camera = cameraRef.current;
      if (!camera) {
        return;
      }
      if (pointerDownRef.current && lastPointerRef.current) {
        const dx = event.clientX - lastPointerRef.current.x;
        const dy = event.clientY - lastPointerRef.current.y;
        lastPointerRef.current = { x: event.clientX, y: event.clientY };
        if (camera.kind === "rect") {
          camera.translateX += dx;
          camera.translateY += dy;
          clampRectCamera(camera, tree, size.width, size.height);
        } else {
          camera.translateX += dx;
          camera.translateY += dy;
          clampCircularCamera(camera, tree, size.width, size.height);
        }
        draw();
        return;
      }
      updateHover(event);
    };

    const handlePointerUp = (event: PointerEvent): void => {
      pointerDownRef.current = false;
      lastPointerRef.current = null;
      canvas.releasePointerCapture(event.pointerId);
    };

    const handlePointerLeave = (): void => {
      pointerDownRef.current = false;
      lastPointerRef.current = null;
      hoverRef.current = null;
      setOverlayHover(null);
      onHoverChange(null);
      draw();
    };

    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const camera = cameraRef.current;
      if (!camera) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const zoom = Math.exp(-event.deltaY * 0.0015);

      if (camera.kind === "rect") {
        const world = screenToWorldRect(camera, localX, localY);
        const fit = fitRectCamera(size.width, size.height, tree);
        const minScaleX = fit.scaleX * 0.55;
        const minScaleY = fit.scaleY * 0.55;
        if (zoomAxisMode !== "y") {
          camera.scaleX = Math.max(minScaleX, camera.scaleX * zoom);
          camera.translateX = localX - (world.x * camera.scaleX);
        }
        if (zoomAxisMode !== "x") {
          camera.scaleY = Math.max(minScaleY, camera.scaleY * zoom);
          camera.translateY = localY - (world.y * camera.scaleY);
        }
        clampRectCamera(camera, tree, size.width, size.height);
      } else {
        const world = screenToWorldCircular(camera, localX, localY);
        const fit = fitCircularCamera(size.width, size.height, tree);
        const minScale = fit.scale * 0.55;
        camera.scale = Math.max(minScale, camera.scale * zoom);
        camera.translateX = localX - (world.x * camera.scale);
        camera.translateY = localY - (world.y * camera.scale);
        clampCircularCamera(camera, tree, size.width, size.height);
      }
      draw();
    };

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, [cache, draw, onHoverChange, order, tree, zoomAxisMode]);

  return (
    <div className="tree-canvas-shell" ref={wrapperRef}>
      <canvas ref={canvasRef} className="tree-canvas" />
      {overlayHover ? (
        <div
          className="hover-tooltip"
          style={{
            left: Math.min(size.width - 220, overlayHover.screenX + 16),
            top: Math.min(size.height - 90, overlayHover.screenY + 16),
          }}
        >
          <div className="hover-tooltip-label">{overlayHover.name}</div>
          <div>Branch: {overlayHover.branchLength.toPrecision(5)}</div>
          <div>
            Parent age: {overlayHover.parentAge === null ? "n/a" : overlayHover.parentAge.toPrecision(5)}
          </div>
          <div>
            Child age: {overlayHover.childAge === null ? "n/a" : overlayHover.childAge.toPrecision(5)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
