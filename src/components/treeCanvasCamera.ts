import type { TreeModel } from "../types/tree";
import type { CircularCamera, RectCamera } from "./treeCanvasTypes";

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

export function fitCircularCamera(width: number, height: number, tree: TreeModel): CircularCamera {
  const radius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
  const scale = (Math.min(width, height) * 0.44) / radius;
  return {
    kind: "circular",
    scale,
    translateX: width * 0.5,
    translateY: height * 0.5,
  };
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
  return {
    x: camera.translateX + (x * camera.scale),
    y: camera.translateY + (y * camera.scale),
  };
}

export function screenToWorldCircular(camera: CircularCamera, x: number, y: number): { x: number; y: number } {
  return {
    x: (x - camera.translateX) / camera.scale,
    y: (y - camera.translateY) / camera.scale,
  };
}

export function clampRectCamera(camera: RectCamera, tree: TreeModel, width: number, height: number): void {
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

export function clampCircularCamera(camera: CircularCamera, tree: TreeModel, width: number, height: number): void {
  const visibleMargin = 56;
  const radiusPx = Math.max(tree.maxDepth, tree.branchLengthMinPositive) * camera.scale;
  const minTranslateX = visibleMargin - radiusPx;
  const maxTranslateX = width - visibleMargin + radiusPx;
  const minTranslateY = visibleMargin - radiusPx;
  const maxTranslateY = height - visibleMargin + radiusPx;
  camera.translateX = Math.min(maxTranslateX, Math.max(minTranslateX, camera.translateX));
  camera.translateY = Math.min(maxTranslateY, Math.max(minTranslateY, camera.translateY));
}
