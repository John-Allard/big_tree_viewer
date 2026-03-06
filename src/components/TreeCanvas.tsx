import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UniformGridIndex, distanceToSegmentSquared, type IndexedSegment } from "../lib/spatialIndex";
import type { HoverInfo, LayoutOrder, TreeModel, ViewMode, ZoomAxisMode } from "../types/tree";

interface TreeCanvasProps {
  tree: TreeModel | null;
  order: LayoutOrder;
  viewMode: ViewMode;
  zoomAxisMode: ZoomAxisMode;
  showTimeStripes: boolean;
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
  rectSegments: Record<LayoutOrder, IndexedSegment[]>;
  rectIndices: Record<LayoutOrder, UniformGridIndex>;
  circularSegments: Record<LayoutOrder, IndexedSegment[]>;
  circularIndices: Record<LayoutOrder, UniformGridIndex>;
}

const LABEL_FONT = `"IBM Plex Sans", "Segoe UI", sans-serif`;
const BRANCH_COLOR = "#0f172a";
const HOVER_COLOR = "#c2410c";

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

function roundToNice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const bases = [1, 2, 2.5, 5, 10];
  let best = bases[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < bases.length; index += 1) {
    const distance = Math.abs(fraction - bases[index]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = bases[index];
    }
  }
  return best * exponent;
}

function chooseTimeTicks(rootAge: number, minMarkers = 4, maxMarkers = 6): number[] {
  if (!Number.isFinite(rootAge) || rootAge <= 0) {
    return [];
  }
  const candidates = new Set<number>();
  for (let n = minMarkers - 1; n <= maxMarkers + 1; n += 1) {
    if (n <= 0) {
      continue;
    }
    const base = roundToNice(rootAge / n);
    if (base > 0) {
      candidates.add(base);
      candidates.add(base * 0.5);
      candidates.add(base * 2);
    }
  }
  const target = (minMarkers + maxMarkers) / 2;
  let bestTicks: number[] = [];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const step of [...candidates].sort((left, right) => left - right)) {
    if (step <= 0) {
      continue;
    }
    const ticks: number[] = [];
    for (let tick = step; tick < rootAge; tick += step) {
      ticks.push(tick);
    }
    if (ticks.length === 0) {
      continue;
    }
    const countPenalty = ticks.length >= minMarkers && ticks.length <= maxMarkers ? 0 : 10 * Math.abs(ticks.length - target);
    const stepPenalty = Math.abs(step - (rootAge / target)) / Math.max(1e-9, rootAge / target);
    const score = countPenalty + Math.abs(ticks.length - target) + stepPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestTicks = ticks;
    }
  }
  return bestTicks;
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function displayNodeName(tree: TreeModel, node: number): string {
  const raw = (tree.names[node] || "").trim();
  const isLeaf = tree.buffers.firstChild[node] < 0;
  if (isLeaf) {
    return raw || `tip-${node}`;
  }
  if (!raw) {
    return "Internal node";
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
    return "Internal node";
  }
  return raw;
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

function buildCache(tree: TreeModel): RenderCache {
  const orderedChildren = {
    input: computeOrderedChildren(tree, "input"),
    desc: computeOrderedChildren(tree, "desc"),
    asc: computeOrderedChildren(tree, "asc"),
  } satisfies Record<LayoutOrder, number[][]>;

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
    const rect = rectSegments[order];
    const radial = circularSegments[order];
    for (let node = 0; node < tree.nodeCount; node += 1) {
      const parent = tree.buffers.parent[node];
      if (parent < 0) {
        continue;
      }
      const y = center[node];
      rect.push({
        node,
        x1: tree.buffers.depth[parent],
        y1: y,
        x2: tree.buffers.depth[node],
        y2: y,
      });

      const theta = thetaFor(center, node, tree.leafCount);
      const start = polarToCartesian(tree.buffers.depth[parent], theta);
      const end = polarToCartesian(tree.buffers.depth[node], theta);
      radial.push({
        node,
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
      });
    }
  }

  return {
    orderedChildren,
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

export default function TreeCanvas({
  tree,
  order,
  viewMode,
  zoomAxisMode,
  showTimeStripes,
  fitRequest,
  onHoverChange,
}: TreeCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<CameraState | null>(null);
  const hoverRef = useRef<HoverInfo | null>(null);
  const pointerDownRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const [overlayHover, setOverlayHover] = useState<HoverInfo | null>(null);

  const cache = useMemo(() => (tree ? buildCache(tree) : null), [tree]);

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

  useEffect(() => {
    fitCamera();
  }, [fitRequest, tree, viewMode]);

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

    if (viewMode === "rectangular" && camera.kind === "rect") {
      const layout = tree.layouts[order];
      const children = cache.orderedChildren[order];
      const worldMin = screenToWorldRect(camera, 0, 0);
      const worldMax = screenToWorldRect(camera, size.width, size.height);
      const minX = Math.min(worldMin.x, worldMax.x);
      const maxX = Math.max(worldMin.x, worldMax.x);
      const minY = Math.min(worldMin.y, worldMax.y);
      const maxY = Math.max(worldMin.y, worldMax.y);
      const axisBarHeight = tree.isUltrametric ? 44 : 0;
      const treeDrawBottom = size.height - axisBarHeight;

      if (showTimeStripes) {
        const stripeExtent = tree.isUltrametric ? tree.rootAge : tree.maxDepth;
        const visibleSpan = Math.max(1e-9, maxX - minX);
        const coarseStep = niceTickStep(visibleSpan);
        const fineStep = coarseStep * 0.5;
        const fineAlpha = clamp01(((coarseStep * camera.scaleX) - 110) / 90);
        const drawBands = (step: number, alpha: number) => {
          if (!Number.isFinite(step) || step <= 0 || alpha <= 0) {
            return;
          }
          for (let start = 0, index = 0; start < stripeExtent; start += step, index += 1) {
            const next = Math.min(stripeExtent, start + step);
            const left = worldToScreenRect(camera, start, 0).x;
            const right = worldToScreenRect(camera, next, 0).x;
            ctx.fillStyle = index % 2 === 0
              ? `rgba(243,244,246,${0.95 * alpha})`
              : `rgba(255,255,255,${0.95 * alpha})`;
            ctx.fillRect(left, 0, right - left, treeDrawBottom);
          }
        };
        drawBands(coarseStep, 1);
        drawBands(fineStep, fineAlpha * 0.82);
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
          const y = layout.center[hover.node];
          const start = worldToScreenRect(camera, tree.buffers.depth[parent], y);
          const end = worldToScreenRect(camera, tree.buffers.depth[hover.node], y);
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        }
      }

      if (camera.scaleY > 6) {
        const fontSize = Math.max(10, Math.min(22, camera.scaleY * 0.68));
        ctx.font = `${fontSize}px ${LABEL_FONT}`;
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        const visibleLabels: Array<{ node: number; x: number; y: number }> = [];
        for (let index = 0; index < tree.leafNodes.length; index += 1) {
          const node = tree.leafNodes[index];
          const y = layout.center[node];
          if (y < minY - 2 || y > maxY + 2) {
            continue;
          }
          const screen = worldToScreenRect(camera, tree.buffers.depth[node], y);
          visibleLabels.push({ node, x: screen.x + 8, y: screen.y });
        }
        const maxVisibleLabels = 4500;
        if (visibleLabels.length <= maxVisibleLabels) {
          for (let index = 0; index < visibleLabels.length; index += 1) {
            const label = visibleLabels[index];
            ctx.fillText(tree.names[label.node] || `tip-${label.node}`, label.x, label.y);
          }
        }
      }

      if (tree.isUltrametric) {
        ctx.fillStyle = "rgba(251,252,254,0.96)";
        ctx.fillRect(0, size.height - axisBarHeight, size.width, axisBarHeight);
        const ticks = chooseTimeTicks(tree.rootAge);
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
        for (let index = 0; index < ticks.length; index += 1) {
          const age = ticks[index];
          const x = worldToScreenRect(camera, tree.rootAge - age, 0).x;
          ctx.moveTo(x, axisY);
          ctx.lineTo(x, axisY + 6);
        }
        ctx.stroke();
        for (let index = 0; index < ticks.length; index += 1) {
          const age = ticks[index];
          const x = worldToScreenRect(camera, tree.rootAge - age, 0).x;
          ctx.fillText(`${formatAgeNumber(age)} mya`, x, axisY + 8);
        }
      }
    }

    if (viewMode === "circular" && camera.kind === "circular") {
      const layout = tree.layouts[order];
      const children = cache.orderedChildren[order];
      const maxRadius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);

      if (showTimeStripes) {
        const stripeStep = niceTickStep(tree.maxDepth);
        const center = { x: camera.translateX, y: camera.translateY };
        for (let start = 0, index = 0; start <= maxRadius + stripeStep; start += stripeStep, index += 1) {
          const radiusStart = start * camera.scale;
          const radiusEnd = (start + stripeStep) * camera.scale;
          ctx.beginPath();
          ctx.arc(center.x, center.y, radiusEnd, 0, Math.PI * 2);
          ctx.arc(center.x, center.y, radiusStart, 0, Math.PI * 2, true);
          ctx.closePath();
          ctx.fillStyle = index % 2 === 0 ? "#f3f4f6" : "#ffffff";
          ctx.fill();
        }
      }

      if (tree.isUltrametric) {
        const ticks = chooseTimeTicks(tree.rootAge);
        const center = { x: camera.translateX, y: camera.translateY };
        const labelTheta = (order === "desc" ? Math.PI : 0) + (Math.PI / 36);
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = "rgba(107,114,128,0.7)";
        ctx.lineWidth = 1;
        for (let index = 0; index < ticks.length; index += 1) {
          const age = ticks[index];
          const radius = Math.max(0, tree.rootAge - age) * camera.scale;
          if (radius < 2) {
            continue;
          }
          ctx.beginPath();
          ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();

        ctx.fillStyle = "#6b7280";
        ctx.font = `11px ${LABEL_FONT}`;
        ctx.textBaseline = "middle";
        ctx.textAlign = Math.cos(labelTheta) >= 0 ? "left" : "right";
        for (let index = 0; index < ticks.length; index += 1) {
          const age = ticks[index];
          const radius = Math.max(0, tree.rootAge - age) + (10 / camera.scale);
          const point = polarToCartesian(radius, labelTheta);
          const screen = worldToScreenCircular(camera, point.x, point.y);
          ctx.fillText(`${formatAgeNumber(age)} mya`, screen.x, screen.y);
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
          const theta = thetaFor(layout.center, hover.node, tree.leafCount);
          const startWorld = polarToCartesian(tree.buffers.depth[parent], theta);
          const endWorld = polarToCartesian(tree.buffers.depth[hover.node], theta);
          const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
          const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
          ctx.strokeStyle = HOVER_COLOR;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        }
      }

      const angularSpacingPx = camera.scale * maxRadius * (Math.PI * 2 / Math.max(1, tree.leafCount));
      if (angularSpacingPx > 7) {
        const fontSize = Math.max(9, Math.min(20, angularSpacingPx * 0.85));
        ctx.font = `${fontSize}px ${LABEL_FONT}`;
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        const labelRadius = maxRadius + (20 / camera.scale);
        const visibilityMargin = 140;
        const visibleLabels: Array<{ node: number; theta: number; x: number; y: number }> = [];
        for (let index = 0; index < tree.leafNodes.length; index += 1) {
          const node = tree.leafNodes[index];
          const theta = thetaFor(layout.center, node, tree.leafCount);
          const point = polarToCartesian(labelRadius, theta);
          const screen = worldToScreenCircular(camera, point.x, point.y);
          if (
            screen.x < -visibilityMargin ||
            screen.x > size.width + visibilityMargin ||
            screen.y < -visibilityMargin ||
            screen.y > size.height + visibilityMargin
          ) {
            continue;
          }
          visibleLabels.push({ node, theta, x: screen.x, y: screen.y });
        }

        const maxVisibleLabels = 3200;
        if (visibleLabels.length > maxVisibleLabels) {
          return;
        }

        for (let index = 0; index < visibleLabels.length; index += 1) {
          const label = visibleLabels[index];
          const { node, theta, x, y } = label;
          const deg = theta * 180 / Math.PI;
          const onRightSide = Math.cos(theta) >= 0;
          const rotation = normalizeRotation(onRightSide ? deg : deg + 180);
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(rotation * Math.PI / 180);
          ctx.textAlign = onRightSide ? "left" : "right";
          ctx.fillText(tree.names[node] || `tip-${node}`, 0, 0);
          ctx.restore();
        }
      }
    }
  }, [cache, fitCamera, order, showTimeStripes, size.height, size.width, tree, viewMode]);

  useEffect(() => {
    draw();
  }, [draw]);

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
      let hover: HoverInfo | null = null;

      if (camera.kind === "rect") {
        const world = screenToWorldRect(camera, localX, localY);
        const radiusX = 6 / camera.scaleX;
        const radiusY = 6 / camera.scaleY;
        const candidates = cache.rectIndices[order].query(world.x, world.y, radiusX, radiusY);
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < candidates.length; index += 1) {
          const segment = candidates[index];
          const distance = distanceToSegmentSquared(world.x, world.y, segment.x1, segment.y1, segment.x2, segment.y2);
          if (distance < bestDistance) {
            bestDistance = distance;
            const threshold = radiusX * radiusX + radiusY * radiusY;
            if (distance <= threshold) {
              const node = segment.node;
              const parent = tree.buffers.parent[node];
              hover = {
                node,
                branchLength: tree.buffers.branchLength[node],
                parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
                parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
                name: displayNodeName(tree, node),
                screenX: localX,
                screenY: localY,
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
          const distance = distanceToSegmentSquared(world.x, world.y, segment.x1, segment.y1, segment.x2, segment.y2);
          if (distance < bestDistance && distance <= radius * radius) {
            bestDistance = distance;
            const node = segment.node;
            const parent = tree.buffers.parent[node];
              hover = {
                node,
                branchLength: tree.buffers.branchLength[node],
                parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
                parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
                name: displayNodeName(tree, node),
                screenX: localX,
                screenY: localY,
              };
          }
        }
      }

      const prev = hoverRef.current;
      if (
        prev?.node !== hover?.node ||
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
        </div>
      ) : null}
    </div>
  );
}
