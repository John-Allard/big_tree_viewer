import type { TreeModel } from "../types/tree";
import type { CircularCamera, RectCamera } from "./treeCanvasTypes";

interface RectClampPadding {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export function setCircularCameraRotation(camera: CircularCamera, rotation: number): void {
  camera.rotation = rotation;
  camera.rotationCos = Math.cos(rotation);
  camera.rotationSin = Math.sin(rotation);
}

export function rotateCircularWorldPoint(
  camera: CircularCamera,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: (x * camera.rotationCos) - (y * camera.rotationSin),
    y: (x * camera.rotationSin) + (y * camera.rotationCos),
  };
}

export function lineIntersectsRect(
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

export function fitRectCamera(width: number, height: number, tree: TreeModel): RectCamera {
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

export function fitCircularCamera(width: number, height: number, tree: TreeModel, rotation = 0): CircularCamera {
  const radius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
  const scale = (Math.min(width, height) * 0.44) / radius;
  const camera: CircularCamera = {
    kind: "circular",
    scale,
    translateX: width * 0.5,
    translateY: height * 0.5,
    rotation,
    rotationCos: 1,
    rotationSin: 0,
  };
  setCircularCameraRotation(camera, rotation);
  return camera;
}

function fanUnitBounds(rotation: number): { minX: number; maxX: number; minY: number; maxY: number } {
  const start = Math.PI + rotation;
  const end = (Math.PI * 2) + rotation;
  const angles = [start, end];
  const firstQuarter = Math.ceil(start / (Math.PI * 0.5));
  const lastQuarter = Math.floor(end / (Math.PI * 0.5));
  for (let quarter = firstQuarter; quarter <= lastQuarter; quarter += 1) {
    angles.push(quarter * Math.PI * 0.5);
  }
  const xs = [0, ...angles.map((angle) => Math.cos(angle))];
  const ys = [0, ...angles.map((angle) => Math.sin(angle))];
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function radialBounds(
  startTheta: number,
  angleSpan: number,
  innerRadius: number,
  outerRadius: number,
  rotation: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const start = startTheta + rotation;
  const end = start + angleSpan;
  const angles = [start, end];
  const firstQuarter = Math.ceil(start / (Math.PI * 0.5));
  const lastQuarter = Math.floor(end / (Math.PI * 0.5));
  for (let quarter = firstQuarter; quarter <= lastQuarter; quarter += 1) {
    angles.push(quarter * Math.PI * 0.5);
  }
  const radii = innerRadius > 0 ? [innerRadius, outerRadius] : [0, outerRadius];
  const xs = radii.flatMap((radius) => angles.map((angle) => radius * Math.cos(angle)));
  const ys = radii.flatMap((radius) => angles.map((angle) => radius * Math.sin(angle)));
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

export function fitRadialCamera(
  width: number,
  height: number,
  tree: TreeModel,
  startTheta: number,
  angleSpan: number,
  innerRadius: number,
  outerRadius: number,
  rotation = 0,
  extraRadiusPx = 0,
): CircularCamera {
  const boundedOuterRadius = Math.max(outerRadius, innerRadius + tree.branchLengthMinPositive);
  const bounds = radialBounds(startTheta, angleSpan, innerRadius, boundedOuterRadius, rotation);
  const padding = 28 + Math.max(0, extraRadiusPx);
  const usableWidth = Math.max(1, width - (padding * 2));
  const usableHeight = Math.max(1, height - (padding * 2));
  const scale = Math.min(
    usableWidth / Math.max(1e-9, bounds.maxX - bounds.minX),
    usableHeight / Math.max(1e-9, bounds.maxY - bounds.minY),
  );
  const camera: CircularCamera = {
    kind: "circular",
    scale,
    translateX: (width * 0.5) - (((bounds.minX + bounds.maxX) * 0.5) * scale),
    translateY: (height * 0.5) - (((bounds.minY + bounds.maxY) * 0.5) * scale),
    rotation,
    rotationCos: 1,
    rotationSin: 0,
  };
  setCircularCameraRotation(camera, rotation);
  return camera;
}

export function fitFanCamera(
  width: number,
  height: number,
  tree: TreeModel,
  rotation = 0,
  extraRadiusPx = 0,
): CircularCamera {
  const radius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
  const bounds = fanUnitBounds(rotation);
  const padding = 28 + Math.max(0, extraRadiusPx);
  const usableWidth = Math.max(1, width - (padding * 2));
  const usableHeight = Math.max(1, height - (padding * 2));
  const scale = Math.min(
    usableWidth / Math.max(1e-9, radius * (bounds.maxX - bounds.minX)),
    usableHeight / Math.max(1e-9, radius * (bounds.maxY - bounds.minY)),
  );
  const camera: CircularCamera = {
    kind: "circular",
    scale,
    translateX: (width * 0.5) - (((bounds.minX + bounds.maxX) * 0.5) * radius * scale),
    translateY: (height * 0.5) - (((bounds.minY + bounds.maxY) * 0.5) * radius * scale),
    rotation,
    rotationCos: 1,
    rotationSin: 0,
  };
  setCircularCameraRotation(camera, rotation);
  return camera;
}

export function worldToScreenRect(camera: RectCamera, x: number, y: number): { x: number; y: number } {
  return {
    x: camera.translateX + (x * camera.scaleX),
    y: camera.translateY + (y * camera.scaleY),
  };
}

export function screenToWorldRect(camera: RectCamera, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - camera.translateX) / camera.scaleX,
    y: (y - camera.translateY) / camera.scaleY,
  };
}

export function worldToScreenCircular(camera: CircularCamera, x: number, y: number): { x: number; y: number } {
  const rotated = rotateCircularWorldPoint(camera, x, y);
  return {
    x: camera.translateX + (rotated.x * camera.scale),
    y: camera.translateY + (rotated.y * camera.scale),
  };
}

export function screenToWorldCircular(camera: CircularCamera, x: number, y: number): { x: number; y: number } {
  const dx = (x - camera.translateX) / camera.scale;
  const dy = (y - camera.translateY) / camera.scale;
  return {
    x: (dx * camera.rotationCos) + (dy * camera.rotationSin),
    y: (-dx * camera.rotationSin) + (dy * camera.rotationCos),
  };
}

export function clampRectCamera(
  camera: RectCamera,
  tree: TreeModel,
  width: number,
  height: number,
  padding: RectClampPadding = {},
): void {
  const visibleMargin = 48;
  const leftPadding = padding.left ?? 0;
  const rightPadding = padding.right ?? 0;
  const topPadding = padding.top ?? 0;
  const bottomPadding = padding.bottom ?? 0;
  const spanX = (tree.maxDepth * camera.scaleX) + leftPadding + rightPadding;
  const spanY = Math.max(1, tree.leafCount - 1) * camera.scaleY + topPadding + bottomPadding;
  const minTranslateX = visibleMargin - spanX + leftPadding;
  const maxTranslateX = width - visibleMargin + leftPadding;
  const minTranslateY = visibleMargin - spanY + topPadding;
  const maxTranslateY = height - visibleMargin + topPadding;
  camera.translateX = Math.min(maxTranslateX, Math.max(minTranslateX, camera.translateX));
  camera.translateY = Math.min(maxTranslateY, Math.max(minTranslateY, camera.translateY));
}

export function clampCircularCamera(
  camera: CircularCamera,
  tree: TreeModel,
  width: number,
  height: number,
  extraRadiusPx = 0,
  treeRadiusWorld = Math.max(tree.maxDepth, tree.branchLengthMinPositive),
): void {
  const visibleMargin = 56;
  const minimumTreeMargin = 8;
  const treeRadiusPx = Math.max(treeRadiusWorld, tree.branchLengthMinPositive) * camera.scale;
  const radiusPx = treeRadiusPx + extraRadiusPx;
  const minTranslateX = visibleMargin - radiusPx;
  const maxTranslateX = width - visibleMargin + radiusPx;
  const minTranslateY = visibleMargin - radiusPx;
  const maxTranslateY = height - visibleMargin + radiusPx;
  camera.translateX = Math.min(maxTranslateX, Math.max(minTranslateX, camera.translateX));
  camera.translateY = Math.min(maxTranslateY, Math.max(minTranslateY, camera.translateY));

  const closestViewportX = Math.min(width, Math.max(0, camera.translateX));
  const closestViewportY = Math.min(height, Math.max(0, camera.translateY));
  const offsetX = camera.translateX - closestViewportX;
  const offsetY = camera.translateY - closestViewportY;
  const distanceFromViewport = Math.hypot(offsetX, offsetY);
  const maxDistanceFromViewport = Math.max(0, Math.min(
    radiusPx - visibleMargin,
    treeRadiusPx - minimumTreeMargin,
  ));
  if (distanceFromViewport > maxDistanceFromViewport && distanceFromViewport > 0) {
    const correctionScale = maxDistanceFromViewport / distanceFromViewport;
    camera.translateX = closestViewportX + (offsetX * correctionScale);
    camera.translateY = closestViewportY + (offsetY * correctionScale);
  }
}

export function clampRadialCamera(
  camera: CircularCamera,
  width: number,
  height: number,
  startTheta: number,
  angleSpan: number,
  innerRadius: number,
  outerRadius: number,
  extraRadiusPx = 0,
): void {
  const visibleMargin = Math.max(8, 56 - Math.max(0, extraRadiusPx));
  const boundedOuterRadius = Math.max(outerRadius, innerRadius);
  const bounds = radialBounds(
    startTheta,
    Math.max(0, Math.min(Math.PI * 2, angleSpan)),
    Math.max(0, innerRadius),
    boundedOuterRadius,
    camera.rotation,
  );
  const minTranslateX = visibleMargin - (bounds.maxX * camera.scale);
  const maxTranslateX = width - visibleMargin - (bounds.minX * camera.scale);
  const minTranslateY = visibleMargin - (bounds.maxY * camera.scale);
  const maxTranslateY = height - visibleMargin - (bounds.minY * camera.scale);
  camera.translateX = Math.min(maxTranslateX, Math.max(minTranslateX, camera.translateX));
  camera.translateY = Math.min(maxTranslateY, Math.max(minTranslateY, camera.translateY));

  const span = Math.max(0, Math.min(Math.PI * 2, angleSpan));
  const normalizedAngleDelta = (angle: number): number => {
    const fullTurn = Math.PI * 2;
    return ((angle - startTheta) % fullTurn + fullTurn) % fullTurn;
  };
  const screenPointInsideSector = (screenX: number, screenY: number): boolean => {
    const world = screenToWorldCircular(camera, screenX, screenY);
    const radius = Math.hypot(world.x, world.y);
    return radius >= innerRadius
      && radius <= boundedOuterRadius
      && (span >= (Math.PI * 2) - 1e-9 || normalizedAngleDelta(Math.atan2(world.y, world.x)) <= span);
  };
  const viewportProbePoints = [
    [width * 0.5, height * 0.5],
    [visibleMargin, visibleMargin],
    [width - visibleMargin, visibleMargin],
    [visibleMargin, height - visibleMargin],
    [width - visibleMargin, height - visibleMargin],
  ];
  if (viewportProbePoints.some(([x, y]) => screenPointInsideSector(x, y))) {
    return;
  }

  const boundaryPoints: Array<{ x: number; y: number }> = [];
  const arcSteps = Math.max(1, Math.ceil(span / (Math.PI / 90)));
  for (let step = 0; step <= arcSteps; step += 1) {
    const theta = startTheta + ((span * step) / arcSteps);
    boundaryPoints.push(worldToScreenCircular(
      camera,
      Math.cos(theta) * boundedOuterRadius,
      Math.sin(theta) * boundedOuterRadius,
    ));
    if (innerRadius > 0) {
      boundaryPoints.push(worldToScreenCircular(
        camera,
        Math.cos(theta) * innerRadius,
        Math.sin(theta) * innerRadius,
      ));
    }
  }
  if (innerRadius <= 0) {
    boundaryPoints.push(worldToScreenCircular(camera, 0, 0));
  }
  const edgeSteps = 16;
  for (let step = 0; step <= edgeSteps; step += 1) {
    const radius = innerRadius + (((boundedOuterRadius - innerRadius) * step) / edgeSteps);
    for (const theta of [startTheta, startTheta + span]) {
      boundaryPoints.push(worldToScreenCircular(
        camera,
        Math.cos(theta) * radius,
        Math.sin(theta) * radius,
      ));
    }
  }

  let closest: { dx: number; dy: number; distanceSquared: number } | null = null;
  for (const point of boundaryPoints) {
    const targetX = Math.min(width - visibleMargin, Math.max(visibleMargin, point.x));
    const targetY = Math.min(height - visibleMargin, Math.max(visibleMargin, point.y));
    const dx = targetX - point.x;
    const dy = targetY - point.y;
    const distanceSquared = (dx * dx) + (dy * dy);
    if (distanceSquared <= 1e-9) {
      return;
    }
    if (!closest || distanceSquared < closest.distanceSquared) {
      closest = { dx, dy, distanceSquared };
    }
  }
  if (closest) {
    camera.translateX += closest.dx;
    camera.translateY += closest.dy;
  }
}
