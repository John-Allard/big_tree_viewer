import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  fontFamilyCss,
  fontStyleCss,
  TAXONOMY_LABEL_SIZE_SCALE_MAX,
  TAXONOMY_LABEL_SIZE_SCALE_MIN,
  type LabelStyleClass,
} from "../lib/figureStyles";
import { putSharedSubtreePayload } from "../lib/taxonomyCache";
import type { SharedSubtreeStoragePayload, SharedSubtreeTaxonomyEntry, SharedSubtreeVisualPayload } from "../lib/sharedSubtreePayload";
import { distanceToSegmentSquared } from "../lib/spatialIndex";
import { buildTaxonomyBlocksForOrderedLeaves, colorForTaxonomy, type TaxonomyColorByRank } from "../lib/taxonomyBlocks";
import { TAXONOMY_RANKS, type TaxonomyBlock, type TaxonomyBlocksByOrder, type TaxonomyMapPayload, type TaxonomyRank } from "../types/taxonomy";
import { buildCache } from "./treeCanvasCache";
import {
  clampCircularCamera,
  clampRectCamera,
  fitCircularCamera,
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
  GenusBlock,
  LabelHitbox,
  RectCamera,
  ScreenLabel,
  TreeCanvasProps,
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
import type { LayoutOrder, TreeModel, ViewMode } from "../types/tree";

const SOLID_SCALE_TICK_ALPHA_THRESHOLD = 0.6;
const DASHED_STRIPE_DASH_ARRAY = "6 6";
const ERROR_BAR_COLOR = "#64748b";

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
): SharedSubtreeStoragePayload {
  const payload: SharedSubtreeStoragePayload = {
    version: 2,
    newick: serializeSubtreeToNewick(tree, rootNode),
    visual,
  };
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
    });
  }
  if (tipEntries.length === 0) {
    return payload;
  }
  payload.taxonomy = {
    version: taxonomyMap.version,
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
  "superkingdom",
];
const TAXONOMY_LAYER_THRESHOLDS: Record<TaxonomyRank, number> = {
  superkingdom: 0,
  phylum: 0,
  class: 0.03,
  order: 0.018,
  family: 0.04,
  genus: 0.35,
};

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
  sizePx: number,
): { x: number; y: number } {
  const isLeaf = tree.buffers.firstChild[node] < 0;
  const tipDepth = tree.isUltrametric ? tree.rootAge : tree.maxDepth;
  const xDepth = isLeaf ? tipDepth : tree.buffers.depth[node];
  const screen = worldToScreenRect(camera, xDepth, centerY);
  const outwardOffsetPx = isLeaf ? Math.max(1, sizePx * 0.25) : 0;
  return {
    x: Math.round(screen.x + outwardOffsetPx),
    y: Math.round(screen.y),
  };
}

function metadataCircularMarkerScreenPosition(
  tree: TreeModel,
  node: number,
  theta: number,
  camera: CircularCamera,
  sizePx: number,
): { x: number; y: number } {
  const isLeaf = tree.buffers.firstChild[node] < 0;
  const tipRadius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
  const worldRadius = isLeaf
    ? tipRadius + (Math.max(1, sizePx * 0.25) / Math.max(camera.scale, 0.001))
    : tree.buffers.depth[node];
  const point = polarToCartesian(worldRadius, theta);
  const screen = worldToScreenCircular(camera, point.x, point.y);
  return {
    x: Math.round(screen.x),
    y: Math.round(screen.y),
  };
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

function taxonomyVisibleRanksForZoom(zoom: number, activeRanks: TaxonomyRank[]): TaxonomyRank[] {
  const outermostRank = activeRanks[activeRanks.length - 1] ?? null;
  const visible = activeRanks.filter((rank) => rank === outermostRank || zoom >= TAXONOMY_LAYER_THRESHOLDS[rank]);
  if (zoom < 0.035 && visible.length > 1) {
    return visible.slice(-1);
  }
  if (zoom < 0.12 && visible.length > 2) {
    return visible.slice(-2);
  }
  return visible;
}

function buildTaxonomyColorMap(
  taxonomyMap: TaxonomyMapPayload,
  topLevelOverrides: Map<string, string>,
  jitterScale: number,
): TaxonomyColorByRank {
  const activeRanks = sortTaxonomyRanksForDisplay([...taxonomyMap.activeRanks]);
  if (activeRanks.length === 0) {
    return {};
  }
  const firstSeen = new Map<TaxonomyRank, Map<string, number>>();
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
      const map = firstSeen.get(rank);
      if (map && !map.has(label)) {
        map.set(label, tipIndex);
      }
    }
  }

  const colorsByRank: TaxonomyColorByRank = {};
  const outerRank = activeRanks[activeRanks.length - 1];
  const outerEntries = [...(firstSeen.get(outerRank)?.entries() ?? [])].sort((left, right) => left[1] - right[1]);
  const outerColors: Record<string, string> = {};
  const phi = 0.618033988749895;
  for (let index = 0; index < outerEntries.length; index += 1) {
    const label = outerEntries[index][0];
    const override = topLevelOverrides.get(label) ?? null;
    if (override) {
      outerColors[label] = override;
      continue;
    }
    const hue = (index * phi * 360) % 360;
    outerColors[label] = hslColor(hue, 70, 64);
  }
  colorsByRank[outerRank] = outerColors;

  for (let rankIndex = activeRanks.length - 2; rankIndex >= 0; rankIndex -= 1) {
    const childRank = activeRanks[rankIndex];
    const childSeen = firstSeen.get(childRank) ?? new Map<string, number>();
    const parentAssignments = new Map<string, { parentRank: TaxonomyRank; parentLabel: string; firstSeen: number }>();
    for (let tipIndex = 0; tipIndex < taxonomyMap.tipRanks.length; tipIndex += 1) {
      const tip = taxonomyMap.tipRanks[tipIndex];
      const childLabel = tip.ranks[childRank];
      if (!childLabel) {
        continue;
      }
      for (let parentRankIndex = rankIndex + 1; parentRankIndex < activeRanks.length; parentRankIndex += 1) {
        const parentRank = activeRanks[parentRankIndex];
        const parentLabel = tip.ranks[parentRank];
        if (!parentLabel) {
          continue;
        }
        if (!parentAssignments.has(childLabel)) {
          parentAssignments.set(childLabel, { parentRank, parentLabel, firstSeen: tipIndex });
        }
        break;
      }
    }

    const grouped = new Map<string, Array<{ childLabel: string; firstSeen: number }>>();
    parentAssignments.forEach((assignment, childLabel) => {
      const key = `${assignment.parentRank}:${assignment.parentLabel}`;
      const group = grouped.get(key) ?? [];
      group.push({ childLabel, firstSeen: assignment.firstSeen });
      grouped.set(key, group);
    });

    const childColors: Record<string, string> = {};
    grouped.forEach((children, key) => {
      const [parentRankText, ...parentParts] = key.split(":");
      const parentRank = parentRankText as TaxonomyRank;
      const parentLabel = parentParts.join(":");
      const parentColor = colorsByRank[parentRank]?.[parentLabel] ?? hslColor(0, 0, 55);
      const parsed = parseHslColor(parentColor) ?? { h: 0, s: 0, l: 55 };
      children.sort((left, right) => left.firstSeen - right.firstSeen);
      const half = Math.max(1, Math.floor((children.length - 1) / 2));
      const hueStep = half > 0 ? (18 * jitterScale) / half : 0;
      const positions: number[] = [0];
      for (let value = 1; positions.length < children.length; value += 1) {
        positions.push(value);
        if (positions.length < children.length) {
          positions.push(-value);
        }
      }
      for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
        const position = positions[childIndex] ?? 0;
        const hue = parsed.h + (position * hueStep);
        const lightnessDelta = position > 0 ? 4 * jitterScale : position < 0 ? -4 * jitterScale : 0;
        const lightness = parsed.l + lightnessDelta;
        childColors[children[childIndex].childLabel] = hslColor(hue, parsed.s, Math.max(42, Math.min(76, lightness)));
      }
    });

    [...childSeen.keys()].forEach((childLabel, index) => {
      if (!childColors[childLabel]) {
        const hue = ((outerEntries.length + index) * phi * 360) % 360;
        childColors[childLabel] = hslColor(hue, 65, 62);
      }
    });
    colorsByRank[childRank] = childColors;
  }

  return colorsByRank;
}

function buildTaxonomyTaxIdLookup(
  taxonomyMap: TaxonomyMapPayload | null,
): Map<TaxonomyRank, Map<string, number>> {
  const lookup = new Map<TaxonomyRank, Map<string, number>>();
  for (let index = 0; index < TAXONOMY_RANKS.length; index += 1) {
    lookup.set(TAXONOMY_RANKS[index], new Map());
  }
  if (!taxonomyMap) {
    return lookup;
  }
  for (let tipIndex = 0; tipIndex < taxonomyMap.tipRanks.length; tipIndex += 1) {
    const tip = taxonomyMap.tipRanks[tipIndex];
    for (let rankIndex = 0; rankIndex < TAXONOMY_RANKS.length; rankIndex += 1) {
      const rank = TAXONOMY_RANKS[rankIndex];
      const label = tip.ranks[rank];
      const taxId = tip.taxIds?.[rank];
      if (!label || !taxId) {
        continue;
      }
      const byRank = lookup.get(rank);
      if (byRank && !byRank.has(label)) {
        byRank.set(label, taxId);
      }
    }
  }
  return lookup;
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

function taxonomyTextColor(fill: string): string {
  const parsed = parseHslColor(fill);
  if (!parsed) {
    return "#0f172a";
  }
  return parsed.l >= 64 ? "#0f172a" : "#f8fafc";
}

function taxonomyRingMetricsPx(rankCount: number, baseFontSize: number, bandThicknessScale = 1): {
  ringWidthsPx: number[];
  ringGapPx: number;
  labelGapPx: number;
} {
  const ringBaseWidthPx = Math.max(16, Math.min(72, baseFontSize * 3.24 * bandThicknessScale));
  const outerRingWidthPx = ringBaseWidthPx * 1.82;
  const ringGapPx = Math.max(6, baseFontSize * 0.42);
  const labelGapPx = Math.max(14, baseFontSize * 1.05);
  const ringWidthsPx = Array.from({ length: rankCount }, (_, index) => (
    index === rankCount - 1 ? outerRingWidthPx : ringBaseWidthPx
  ));
  return { ringWidthsPx, ringGapPx, labelGapPx };
}

function buildCircularRibbonPoints(
  centerX: number,
  centerY: number,
  innerRadiusPx: number,
  outerRadiusPx: number,
  startTheta: number,
  endTheta: number,
): Array<{ x: number; y: number }> {
  const avgRadiusPx = (innerRadiusPx + outerRadiusPx) * 0.5;
  const arcSpanPx = Math.max(0, (endTheta - startTheta) * avgRadiusPx);
  const maxSagittaPx = 0.75;
  const curvatureAngleStep = outerRadiusPx > maxSagittaPx
    ? Math.max(1e-5, 2 * Math.acos(Math.max(-1, Math.min(1, 1 - (maxSagittaPx / outerRadiusPx)))))
    : Math.PI * 0.25;
  const sampleCount = Math.max(
    2,
    Math.min(
      256,
      Math.max(
        Math.ceil(arcSpanPx / 18),
        Math.ceil((endTheta - startTheta) / curvatureAngleStep),
      ),
    ),
  );
  const points: Array<{ x: number; y: number }> = [];
  for (let index = 0; index <= sampleCount; index += 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / sampleCount);
    points.push({
      x: centerX + (Math.cos(theta) * outerRadiusPx),
      y: centerY + (Math.sin(theta) * outerRadiusPx),
    });
  }
  for (let index = sampleCount; index >= 0; index -= 1) {
    const theta = startTheta + (((endTheta - startTheta) * index) / sampleCount);
    points.push({
      x: centerX + (Math.cos(theta) * innerRadiusPx),
      y: centerY + (Math.sin(theta) * innerRadiusPx),
    });
  }
  return points;
}

function measureNormalizedLabelMetrics(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontFamily = LABEL_FONT,
): { widthAtOnePx: number; heightAtOnePx: number } {
  const sampleFontSize = 100;
  ctx.font = `${sampleFontSize}px ${fontFamily}`;
  const metrics = ctx.measureText(text);
  const ascent = metrics.actualBoundingBoxAscent || (sampleFontSize * 0.72);
  const descent = metrics.actualBoundingBoxDescent || (sampleFontSize * 0.28);
  return {
    widthAtOnePx: Math.max(metrics.width / sampleFontSize, 1e-6),
    heightAtOnePx: Math.max((ascent + descent) / sampleFontSize, 1e-6),
  };
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

function isScreenPointVisible(x: number, y: number, width: number, height: number, margin = 12): boolean {
  return x >= -margin && x <= (width + margin) && y >= -margin && y <= (height + margin);
}

function bestVisibleTaxonomyLabelSpan(
  segmentStart: number,
  segmentEnd: number,
  visibleSpans: Array<{ start: number; end: number }>,
): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (let index = 0; index < visibleSpans.length; index += 1) {
    const intersections = intersectWrappedAngularIntervals(segmentStart, segmentEnd, visibleSpans[index].start, visibleSpans[index].end);
    for (let intersectionIndex = 0; intersectionIndex < intersections.length; intersectionIndex += 1) {
      const candidate = intersections[intersectionIndex];
      if (!best || (candidate.end - candidate.start) > (best.end - best.start)) {
        best = candidate;
      }
    }
  }
  return best;
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
          roots.push({ rootNode, color: block.color || colorForTaxonomy(rank, block.label, colorsByRank) });
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

function buildCircularTaxonomyPaths(
  tree: TreeModel,
  layout: TreeModel["layouts"][LayoutOrder],
  orderedChildren: number[][],
  branchColors: string[],
): Map<string, Path2D> {
  const paths = new Map<string, Path2D>();
  const getPath = (color: string): Path2D => {
    const existing = paths.get(color);
    if (existing) {
      return existing;
    }
    const created = new Path2D();
    paths.set(color, created);
    return created;
  };

  for (let node = 0; node < tree.nodeCount; node += 1) {
    const parent = tree.buffers.parent[node];
    if (parent < 0) {
      continue;
    }
    const color = branchColors[node] ?? BRANCH_COLOR;
    const theta = thetaFor(layout.center, node, tree.leafCount);
    const startWorld = polarToCartesian(tree.buffers.depth[parent], theta);
    const endWorld = polarToCartesian(tree.buffers.depth[node], theta);
    const path = getPath(color);
    path.moveTo(startWorld.x, startWorld.y);
    path.lineTo(endWorld.x, endWorld.y);
  }

  for (let ownerNode = 0; ownerNode < tree.nodeCount; ownerNode += 1) {
    const ordered = orderedChildren[ownerNode];
    if (ordered.length < 2) {
      continue;
    }
    const ownerTheta = thetaFor(layout.center, ownerNode, tree.leafCount);
    const ownerArcStart = thetaFor(layout.min, ownerNode, tree.leafCount);
    const ownerArcEnd = thetaFor(layout.max, ownerNode, tree.leafCount);
    const ownerArcLength = Math.max(0, ownerArcEnd - ownerArcStart);
    const radius = tree.buffers.depth[ownerNode];
    if (radius <= 0) {
      continue;
    }
    for (let childIndex = 0; childIndex < ordered.length; childIndex += 1) {
      const child = ordered[childIndex];
      const color = branchColors[child] ?? BRANCH_COLOR;
      const childTheta = thetaFor(layout.center, child, tree.leafCount);
      const arcSpan = arcSubspanWithinSpan(ownerTheta, childTheta, ownerArcStart, ownerArcLength);
      if (!arcSpan) {
        continue;
      }
      const path = getPath(color);
      path.moveTo(Math.cos(arcSpan.start) * radius, Math.sin(arcSpan.start) * radius);
      path.arc(0, 0, radius, arcSpan.start, arcSpan.end, false);
    }
  }

  return paths;
}

function buildCircularBranchPath(
  tree: TreeModel,
  layout: TreeModel["layouts"][LayoutOrder],
  orderedChildren: number[][],
): Path2D {
  const path = new Path2D();
  for (let node = 0; node < tree.nodeCount; node += 1) {
    const parent = tree.buffers.parent[node];
    if (parent >= 0) {
      const theta = thetaFor(layout.center, node, tree.leafCount);
      const startWorld = polarToCartesian(tree.buffers.depth[parent], theta);
      const endWorld = polarToCartesian(tree.buffers.depth[node], theta);
      path.moveTo(startWorld.x, startWorld.y);
      path.lineTo(endWorld.x, endWorld.y);
    }
    const ordered = orderedChildren[node];
    if (ordered.length < 2) {
      continue;
    }
    const radius = tree.buffers.depth[node];
    if (!(radius > 0)) {
      continue;
    }
    const startTheta = thetaFor(layout.center, ordered[0], tree.leafCount);
    const endTheta = thetaFor(layout.center, ordered[ordered.length - 1], tree.leafCount);
    const arcStart = thetaFor(layout.min, node, tree.leafCount);
    const arcEnd = thetaFor(layout.max, node, tree.leafCount);
    const arcLength = Math.max(0, arcEnd - arcStart);
    const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
    path.moveTo(Math.cos(arcAngles.start) * radius, Math.sin(arcAngles.start) * radius);
    path.arc(0, 0, radius, arcAngles.start, arcAngles.end, false);
  }
  return path;
}

function buildRectBranchPaths(
  tree: TreeModel,
  layout: TreeModel["layouts"][LayoutOrder],
  orderedChildren: number[][],
): { stems: Path2D; connectors: Path2D } {
  const stems = new Path2D();
  const connectors = new Path2D();
  for (let node = 0; node < tree.nodeCount; node += 1) {
    const parent = tree.buffers.parent[node];
    if (parent >= 0) {
      const y = layout.center[node];
      stems.moveTo(tree.buffers.depth[parent], y);
      stems.lineTo(tree.buffers.depth[node], y);
    }
    const ordered = orderedChildren[node];
    if (ordered.length < 2) {
      continue;
    }
    const x = tree.buffers.depth[node];
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
      path.stems.moveTo(tree.buffers.depth[parent], y);
      path.stems.lineTo(tree.buffers.depth[node], y);
    }
    const ordered = orderedChildren[node];
    if (ordered.length < 2) {
      continue;
    }
    const x = tree.buffers.depth[node];
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
  signature: string;
  canvas: HTMLCanvasElement;
  rotation: number;
  sourceOffsetX: number;
  sourceOffsetY: number;
  viewportWidth: number;
  viewportHeight: number;
};

type RectBranchPathCache = {
  stems: Path2D;
  connectors: Path2D;
};

type RectTaxonomyPathCache = Map<string, RectBranchPathCache>;

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

function thetaSpanForLeafRange(leafCount: number, startIndex: number, endIndex: number): { startTheta: number; endTheta: number } {
  const turns = Math.PI * 2;
  const safeLeafCount = Math.max(1, leafCount);
  const startTheta = (((startIndex - 0.5) / safeLeafCount) * turns);
  let endTheta = (((endIndex - 0.5) / safeLeafCount) * turns);
  if (endTheta <= startTheta) {
    endTheta += turns;
  }
  return { startTheta, endTheta };
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

function smoothstep01(value: number): number {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - (2 * clamped));
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

function circularSpansToLeafRanges(
  spans: Array<{ start: number; end: number }>,
  rotationAngle: number,
  orderedLeaves: number[],
  center: Float64Array,
  leafCount: number,
  overscanLeaves: number,
): Array<{ startIndex: number; endIndex: number }> {
  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  const tau = Math.PI * 2;
  const pushRange = (thetaStart: number, thetaEnd: number): void => {
    const startCenter = (thetaStart / tau) * leafCount;
    const endCenter = (thetaEnd / tau) * leafCount;
    const startIndex = Math.max(0, lowerBoundLeaves(orderedLeaves, center, startCenter) - overscanLeaves);
    const endIndex = Math.min(orderedLeaves.length, lowerBoundLeaves(orderedLeaves, center, endCenter) + 1 + overscanLeaves);
    if (endIndex > startIndex) {
      ranges.push({ startIndex, endIndex });
    }
  };
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

export default function TreeCanvas({
  tree,
  order,
  viewMode,
  zoomAxisMode,
  circularRotation,
  showTimeStripes,
  timeStripeStyle,
  timeStripeLineWeight,
  showScaleBars,
  scaleTickInterval,
  showIntermediateScaleTicks,
  extendRectScaleToTick,
  showScaleZeroTick,
  circularCenterScaleAngleDegrees,
  useAutoCircularCenterScaleAngle,
  showCircularCenterRadialScaleBar,
  showGenusLabels,
  taxonomyEnabled,
  taxonomyBranchColoringEnabled,
  taxonomyColorJitter,
  useAutomaticTaxonomyRankVisibility,
  taxonomyRankVisibility,
  taxonomyMap,
  metadataBranchColors,
  metadataBranchColorVersion,
  metadataLabels,
  metadataLabelVersion,
  metadataMarkers,
  metadataMarkerVersion,
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
  visualResetRequest,
  onHoverChange,
  onRerootRequest,
  onViewModeChange,
}: TreeCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<CameraState | null>(null);
  const previousViewModeRef = useRef<ViewMode>(viewMode);
  const frameRequestRef = useRef<number | null>(null);
  const exportCaptureRef = useRef<SvgScene | null>(null);
  const pendingRectSubtreeZoomTargetRef = useRef<number | null>(null);
  const hoverRef = useRef<CanvasHoverInfo | null>(null);
  const labelHitsRef = useRef<LabelHitbox[]>([]);
  const renderDebugRef = useRef<Record<string, unknown> | null>(null);
  const taxonomyBranchColorsCacheRef = useRef<Map<string, string[]>>(new Map());
  const effectiveBranchColorsCacheRef = useRef<Map<string, string[]>>(new Map());
  const circularTaxonomyPathCacheRef = useRef<Map<string, Map<string, Path2D>>>(new Map());
  const rectTaxonomyPathCacheRef = useRef<Map<string, RectTaxonomyPathCache>>(new Map());
  const circularBasePathCacheRef = useRef<Map<LayoutOrder, Path2D>>(new Map());
  const rectBasePathCacheRef = useRef<Map<LayoutOrder, RectBranchPathCache>>(new Map());
  const circularTaxonomyBitmapCacheRef = useRef<CircularTaxonomyBitmapCache | null>(null);
  const canvasBackingStoreRef = useRef<{ width: number; height: number; dpr: number } | null>(null);
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
  const activePointersRef = useRef(new Map<number, { clientX: number; clientY: number }>());
  const pinchGestureRef = useRef<{ distance: number; centerX: number; centerY: number } | null>(null);
  const pointerDownRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
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
    peakZoom: number;
    peakVisibleKeys: string[];
  } | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const previousSizeRef = useRef(size);
  const previousTreeRef = useRef<TreeModel | null>(tree);
  const previousFitRequestRef = useRef(fitRequest);
  const [overlayHover, setOverlayHover] = useState<HoverInfo | null>(null);
  const [collapsedNodes, setCollapsedNodes] = useState<Set<number>>(() => new Set());
  const [manualBranchColorAssignments, setManualBranchColorAssignments] = useState<Map<number, string>>(() => new Map());
  const [manualSubtreeColorAssignments, setManualSubtreeColorAssignments] = useState<Map<number, string>>(() => new Map());
  const [taxonomyRootColorAssignments, setTaxonomyRootColorAssignments] = useState<Map<string, string>>(() => new Map());
  const [contextMenuColorMode, setContextMenuColorMode] = useState<"branch" | "subtree" | "taxonomy-root" | null>(null);
  const [contextMenuRootMenuOpen, setContextMenuRootMenuOpen] = useState(false);
  const [contextMenuCustomColor, setContextMenuCustomColor] = useState("#2563eb");
  const nativeColorPickerActiveRef = useRef(false);
  const hiddenNodesRef = useRef<Uint8Array | null>(null);
  const [contextMenu, setContextMenu] = useState<(
    {
      kind: "node";
      x: number;
      y: number;
      node: number;
      name: string;
      descendantTipCount: number;
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
    }
  ) | null>(null);

  const cache = useMemo(() => (tree ? buildCache(tree) : null), [tree]);
  useEffect(() => {
    setCollapsedNodes(new Set());
    setManualBranchColorAssignments(new Map());
    setManualSubtreeColorAssignments(new Map());
    setTaxonomyRootColorAssignments(new Map());
    setContextMenu(null);
    setContextMenuColorMode(null);
    setContextMenuRootMenuOpen(false);
  }, [tree]);
  useEffect(() => {
    setTaxonomyRootColorAssignments(new Map());
    setContextMenuColorMode(null);
    setContextMenuRootMenuOpen(false);
  }, [taxonomyMap, visualResetRequest]);
  useEffect(() => {
    if (!contextMenu) {
      setContextMenuColorMode(null);
      setContextMenuRootMenuOpen(false);
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
  const taxonomyActiveRanks = useMemo<TaxonomyRank[]>(
    () => sortTaxonomyRanksForDisplay(
      (taxonomyMap ? [...taxonomyMap.activeRanks] : [...TAXONOMY_RANKS]).filter(
        (rank) => taxonomyRankVisibility[rank] !== false,
      ),
    ),
    [taxonomyMap, taxonomyRankVisibility],
  );
  const taxonomyOutermostRank = taxonomyActiveRanks[taxonomyActiveRanks.length - 1] ?? null;
  const taxonomyColors = useMemo(() => (
    taxonomyMap
      ? buildTaxonomyColorMap(
        taxonomyMap,
        taxonomyRootColorAssignments,
        Math.max(0, Math.min(4, taxonomyColorJitter)),
      )
      : null
  ), [taxonomyColorJitter, taxonomyMap, taxonomyRootColorAssignments]);
  const taxonomyTaxIdsByRank = useMemo(() => buildTaxonomyTaxIdLookup(taxonomyMap), [taxonomyMap]);
  const taxonomyBlocks = useMemo<TaxonomyBlocksByOrder | null>(() => {
    if (!cache || !taxonomyMap) {
      return null;
    }
    return {
      input: buildTaxonomyBlocksForOrderedLeaves(cache.orderedLeaves.input, taxonomyMap, taxonomyColors),
      desc: buildTaxonomyBlocksForOrderedLeaves(cache.orderedLeaves.desc, taxonomyMap, taxonomyColors),
      asc: buildTaxonomyBlocksForOrderedLeaves(cache.orderedLeaves.asc, taxonomyMap, taxonomyColors),
    };
  }, [cache, taxonomyColors, taxonomyMap]);
  const taxonomyConsensus = useMemo(
    () => (tree && taxonomyMap ? buildTaxonomyConsensusByRank(tree, taxonomyMap, taxonomyActiveRanks) : null),
    [taxonomyActiveRanks, taxonomyMap, tree],
  );
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
  useLayoutEffect(() => {
    taxonomyBranchColorsCacheRef.current.clear();
    effectiveBranchColorsCacheRef.current.clear();
    circularTaxonomyPathCacheRef.current.clear();
    rectTaxonomyPathCacheRef.current.clear();
    circularBasePathCacheRef.current.clear();
    rectBasePathCacheRef.current.clear();
    circularTaxonomyBitmapCacheRef.current = null;
  }, [branchThicknessScale, manualBranchColorVersion, metadataBranchColorVersion, metadataLabelVersion, metadataMarkerVersion, taxonomyActiveRanks, taxonomyColors, taxonomyConsensus, tree]);
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
  const taxonomyBandThicknessScale = Math.max(0.65, Math.min(1.8, figureStyles.taxonomy.bandThicknessScale ?? 1));
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

  const collapsedView = useMemo(() => {
    if (!tree || !cache) {
      return null;
    }
    const baseLayout = tree.layouts[order];
    const hiddenNodes = new Uint8Array(tree.nodeCount);
    const visibleCollapsedNodes: number[] = [];
    if (collapsedNodes.size > 0) {
      collapsedNodes.forEach((node) => {
        if (hiddenNodes[node]) {
          return;
        }
        visibleCollapsedNodes.push(node);
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
      });
    }
    if (visibleCollapsedNodes.length === 0) {
      return {
        hiddenNodes,
        visibleCollapsedNodes,
        layout: baseLayout,
      };
    }
    const center = new Float64Array(baseLayout.center);
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
        center[node] = (baseLayout.min[node] + baseLayout.max[node]) * 0.5;
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
    return {
      hiddenNodes,
      visibleCollapsedNodes,
      layout: {
        center,
        min: baseLayout.min,
        max: baseLayout.max,
      },
    };
  }, [cache, collapsedNodes, order, tree]);

  useEffect(() => {
    hiddenNodesRef.current = collapsedView?.hiddenNodes ?? null;
  }, [collapsedView]);

  const circularClampExtraRadiusPx = useCallback((camera: CircularCamera) => {
    const maxRadius = Math.max(tree?.maxDepth ?? 0, tree?.branchLengthMinPositive ?? 1);
    const angularSpacingPx = camera.scale * maxRadius * (Math.PI * 2 / Math.max(1, tree?.leafCount ?? 1));
    const microTipFontSize = scaleLabelFontSize("tip", Math.max(4.2, Math.min(6.1, angularSpacingPx * 0.3)));
    const tipFontSize = scaleLabelFontSize("tip", Math.max(6.5, Math.min(20, angularSpacingPx * 0.74)));
    const readableBandProgress = smoothstep01((angularSpacingPx - 2.9) / Math.max(1e-6, 4.5 - 2.9));
    const tipBandFontSize = angularSpacingPx <= 2.9
      ? 0
      : microTipFontSize + ((tipFontSize - microTipFontSize) * readableBandProgress);
    const genusFontSize = scaleLabelFontSize("genus", Math.max(10, Math.min(18, Math.max(angularSpacingPx * 0.92, 10))));
    const microBandWidthPx = estimateLabelWidth(Math.max(microTipFontSize, 4.2), reservedTipLabelCharacters);
    const readableBandWidthPx = estimateLabelWidth(Math.max(tipFontSize, 6.5), reservedTipLabelCharacters);
    const tipBandWidthPx = interpolateTipBandWidthPx(angularSpacingPx, 1.6, 2.9, 4.5, microBandWidthPx, readableBandWidthPx);
    if (taxonomyEnabled && taxonomyBlocks) {
      const visibleRanks = useAutomaticTaxonomyRankVisibility
        ? taxonomyVisibleRanksForZoom(angularSpacingPx, taxonomyActiveRanks)
        : taxonomyActiveRanks;
      const taxonomyMetricBaseSize = Math.max(9, Math.min(14, Math.max(angularSpacingPx * 0.48, 9)));
      const metrics = taxonomyRingMetricsPx(visibleRanks.length, taxonomyMetricBaseSize, taxonomyBandThicknessScale);
      const taxonomyWidthPx = metrics.ringWidthsPx.reduce((total, width) => total + width, 0)
        + (Math.max(0, visibleRanks.length - 1) * metrics.ringGapPx)
        + metrics.labelGapPx
        + 26
        + Math.max(0, figureStyles.tip.offsetPx);
      return tipBandWidthPx + taxonomyWidthPx;
    }
    const labelFontSize = Math.max(4.5, Math.min(20, Math.max(genusFontSize, tipBandFontSize)));
    const genusLabelWidthPx = estimateLabelWidth(labelFontSize, maxGenusLabelCharacters);
    return Math.max(genusLabelWidthPx, tipBandWidthPx) + 120 + Math.max(0, figureStyles.tip.offsetPx, figureStyles.genus.offsetPx);
  }, [figureStyles.genus.offsetPx, figureStyles.tip.offsetPx, maxGenusLabelCharacters, reservedTipLabelCharacters, scaleLabelFontSize, taxonomyActiveRanks, taxonomyBandThicknessScale, taxonomyBlocks, taxonomyEnabled, tree]);

  const finalizeCircularCamera = useCallback((camera: CircularCamera) => {
    if (!tree) {
      return;
    }
    clampCircularCamera(camera, tree, size.width, size.height, circularClampExtraRadiusPx(camera));
    clampCircularCamera(camera, tree, size.width, size.height, circularClampExtraRadiusPx(camera));
  }, [circularClampExtraRadiusPx, size.height, size.width, tree]);

  const rectTaxonomyZoom = useCallback((scaleY: number): number => {
    if (!tree || !(scaleY > 0)) {
      return scaleY;
    }
    const fitRect = fitRectCamera(size.width, size.height, tree);
    const fitRectScaleY = Math.max(fitRect.scaleY, 1e-6);
    let fitCircular = fitCircularCamera(size.width, size.height, tree, circularRotation);
    if (taxonomyEnabled && taxonomyBlocks) {
      const radius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
      for (let iteration = 0; iteration < 2; iteration += 1) {
        const extra = circularClampExtraRadiusPx(fitCircular);
        const availableRadiusPx = Math.max(120, (Math.min(size.width, size.height) * 0.44) - extra);
        fitCircular.scale = availableRadiusPx / radius;
      }
      finalizeCircularCamera(fitCircular);
    }
    const maxRadius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
    const fitCircularSpacing = fitCircular.scale * maxRadius * (Math.PI * 2 / Math.max(1, tree.leafCount));
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
    finalizeCircularCamera,
    size.height,
    size.width,
    taxonomyBlocks,
    taxonomyEnabled,
    tree,
  ]);

  const rectVisibleTaxonomyRanksForScaleY = useCallback((scaleY: number): TaxonomyRank[] => {
    if (!useAutomaticTaxonomyRankVisibility) {
      return taxonomyActiveRanks;
    }
    const effectiveZoom = rectTaxonomyZoom(scaleY);
    const visibleRanks = taxonomyVisibleRanksForZoom(effectiveZoom, taxonomyActiveRanks);
    const hasClass = visibleRanks.includes("class");
    const hasOrder = visibleRanks.includes("order");
    if (!hasClass || hasOrder || effectiveZoom < TAXONOMY_LAYER_THRESHOLDS.order) {
      return visibleRanks;
    }
    return taxonomyActiveRanks.filter((rank) => visibleRanks.includes(rank) || rank === "order");
  }, [rectTaxonomyZoom, taxonomyActiveRanks, useAutomaticTaxonomyRankVisibility]);

  const rectClampPadding = useCallback((camera: RectCamera) => {
    const microTipFontSize = scaleLabelFontSize("tip", Math.max(4.2, Math.min(6.25, camera.scaleY * 0.34)));
    const tipFontSize = scaleLabelFontSize("tip", Math.max(6.5, Math.min(22, camera.scaleY * 0.58)));
    const readableBandProgress = smoothstep01((camera.scaleY - 2.7) / Math.max(1e-6, 4.2 - 2.7));
    const tipBandFontSize = camera.scaleY <= 2.7
      ? 0
      : microTipFontSize + ((tipFontSize - microTipFontSize) * readableBandProgress);
    const genusFontSize = scaleLabelFontSize("genus", Math.max(10, Math.min(18, camera.scaleY * 0.42)));
    const microBandWidthPx = estimateLabelWidth(Math.max(microTipFontSize, 4.2), reservedTipLabelCharacters);
    const readableBandWidthPx = estimateLabelWidth(Math.max(tipFontSize, 6.5), reservedTipLabelCharacters);
    const tipBandWidthPx = interpolateTipBandWidthPx(camera.scaleY, 1.55, 2.7, 4.2, microBandWidthPx, readableBandWidthPx);
    if (taxonomyEnabled && taxonomyBlocks) {
      const visibleRanks = rectVisibleTaxonomyRanksForScaleY(camera.scaleY);
      const taxonomyMetricBaseSize = Math.max(8.5, Math.min(18, 8.5 + (camera.scaleY * 0.45)));
      const metrics = taxonomyRingMetricsPx(visibleRanks.length, taxonomyMetricBaseSize, taxonomyBandThicknessScale);
      const taxonomyWidthPx = metrics.ringWidthsPx.reduce((total, width) => total + width, 0)
        + (Math.max(0, visibleRanks.length - 1) * metrics.ringGapPx)
        + 40
        + Math.max(0, figureStyles.tip.offsetPx);
      return {
        right: tipBandWidthPx + taxonomyWidthPx + 60,
      };
    }
    const labelFontSize = Math.max(4.5, Math.min(22, Math.max(genusFontSize, tipBandFontSize)));
    const genusLabelWidthPx = estimateLabelWidth(labelFontSize, maxGenusLabelCharacters);
    return {
      right: Math.max(genusLabelWidthPx, tipBandWidthPx) + 140 + Math.max(0, figureStyles.tip.offsetPx, figureStyles.genus.offsetPx),
    };
  }, [figureStyles.genus.offsetPx, figureStyles.tip.offsetPx, maxGenusLabelCharacters, rectVisibleTaxonomyRanksForScaleY, reservedTipLabelCharacters, scaleLabelFontSize, taxonomyBandThicknessScale, taxonomyBlocks, taxonomyEnabled]);

  const fitCameraForMode = useCallback((mode: ViewMode): CameraState | null => {
    if (!tree) {
      return null;
    }
    let nextCamera = mode === "rectangular"
      ? fitRectCamera(size.width, size.height, tree)
      : fitCircularCamera(size.width, size.height, tree, circularRotation);
    if (nextCamera.kind === "rect") {
      const padding = rectClampPadding(nextCamera);
      const usableWidth = Math.max(1, size.width - 32 - (padding.right ?? 0));
      nextCamera.scaleX = Math.min(nextCamera.scaleX, usableWidth / Math.max(tree.maxDepth, tree.branchLengthMinPositive));
      nextCamera.translateX = 32;
      nextCamera.translateY = 24;
      clampRectCamera(nextCamera, tree, size.width, size.height, padding);
    } else if (taxonomyEnabled && taxonomyBlocks) {
      const radius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
      for (let iteration = 0; iteration < 2; iteration += 1) {
        const extra = circularClampExtraRadiusPx(nextCamera);
        const availableRadiusPx = Math.max(120, (Math.min(size.width, size.height) * 0.44) - extra);
        nextCamera.scale = availableRadiusPx / radius;
      }
      finalizeCircularCamera(nextCamera);
    }
    return nextCamera;
  }, [circularClampExtraRadiusPx, circularRotation, finalizeCircularCamera, rectClampPadding, size.height, size.width, taxonomyBlocks, taxonomyEnabled, tree]);

  const cameraApproximatelyMatchesFit = useCallback((camera: CameraState): boolean => {
    const fit = fitCameraForMode(camera.kind === "rect" ? "rectangular" : "circular");
    if (!fit || fit.kind !== camera.kind) {
      return false;
    }
    if (camera.kind === "rect" && fit.kind === "rect") {
      return (
        Math.abs(camera.scaleX - fit.scaleX) <= (fit.scaleX * 0.03)
        && Math.abs(camera.scaleY - fit.scaleY) <= (fit.scaleY * 0.03)
        && Math.abs(camera.translateX - fit.translateX) <= 4
        && Math.abs(camera.translateY - fit.translateY) <= 4
      );
    }
    if (camera.kind === "circular" && fit.kind === "circular") {
      return (
        Math.abs(camera.scale - fit.scale) <= (fit.scale * 0.03)
        && Math.abs(camera.translateX - fit.translateX) <= 4
        && Math.abs(camera.translateY - fit.translateY) <= 4
        && Math.abs(camera.rotation - fit.rotation) <= 1e-6
      );
    }
    return false;
  }, [fitCameraForMode]);

  const fitCamera = useCallback(() => {
    const nextCamera = fitCameraForMode(viewMode);
    if (nextCamera) {
      cameraRef.current = nextCamera;
    }
  }, [fitCameraForMode, viewMode]);

  const getTaxonomyBranchColors = useCallback((orderKey: LayoutOrder, visibleRanks: TaxonomyRank[]): string[] | null => {
    if (!tree || !taxonomyConsensus || !taxonomyBlocks || visibleRanks.length === 0) {
      return null;
    }
    const key = `${orderKey}:${visibleRanks.join("|")}`;
    const cached = taxonomyBranchColorsCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    const built = buildTaxonomyBranchColorArray(tree, taxonomyConsensus, taxonomyBlocks[orderKey], taxonomyColors, visibleRanks);
    taxonomyBranchColorsCacheRef.current.set(key, built);
    return built;
  }, [taxonomyBlocks, taxonomyColors, taxonomyConsensus, tree]);

  const getEffectiveBranchColors = useCallback((orderKey: LayoutOrder, visibleRanks: TaxonomyRank[]): string[] | null => {
    if (!tree) {
      return null;
    }
    const key = `${orderKey}:${taxonomyBranchColoringEnabled ? visibleRanks.join("|") : ""}:${metadataBranchColorVersion}:${manualBranchColorVersion}`;
    const cached = effectiveBranchColorsCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    const baseColors = taxonomyBranchColoringEnabled && visibleRanks.length > 0
      ? getTaxonomyBranchColors(orderKey, visibleRanks)
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
  }, [getTaxonomyBranchColors, manualBranchColorOverlay, manualBranchColorVersion, metadataBranchColorOverlay, metadataBranchColorVersion, taxonomyBranchColoringEnabled, tree]);

  const getCircularTaxonomyPaths = useCallback((
    orderKey: LayoutOrder,
    layout: TreeModel["layouts"][LayoutOrder],
    cacheKey: string,
    branchColors: string[] | null,
  ): Map<string, Path2D> | null => {
    if (!tree || !cache || !branchColors || !cacheKey) {
      return null;
    }
    const key = `${orderKey}:${cacheKey}`;
    const cached = circularTaxonomyPathCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    const built = buildCircularTaxonomyPaths(tree, layout, cache.orderedChildren[orderKey], branchColors);
    circularTaxonomyPathCacheRef.current.set(key, built);
    return built;
  }, [cache, tree]);

  const getCircularBasePath = useCallback((
    orderKey: LayoutOrder,
    layout: TreeModel["layouts"][LayoutOrder],
  ): Path2D | null => {
    if (!tree || !cache) {
      return null;
    }
    const cached = circularBasePathCacheRef.current.get(orderKey);
    if (cached) {
      return cached;
    }
    const built = buildCircularBranchPath(tree, layout, cache.orderedChildren[orderKey]);
    circularBasePathCacheRef.current.set(orderKey, built);
    return built;
  }, [cache, tree]);

  const getRectTaxonomyPaths = useCallback((
    orderKey: LayoutOrder,
    layout: TreeModel["layouts"][LayoutOrder],
    cacheKey: string,
    branchColors: string[] | null,
  ): RectTaxonomyPathCache | null => {
    if (!tree || !cache || !branchColors || !cacheKey) {
      return null;
    }
    const key = `${orderKey}:${cacheKey}`;
    const cached = rectTaxonomyPathCacheRef.current.get(key);
    if (cached) {
      return cached;
    }
    const built = buildRectTaxonomyPaths(tree, layout, cache.orderedChildren[orderKey], branchColors);
    rectTaxonomyPathCacheRef.current.set(key, built);
    return built;
  }, [cache, tree]);

  const getRectBasePaths = useCallback((
    orderKey: LayoutOrder,
    layout: TreeModel["layouts"][LayoutOrder],
  ): RectBranchPathCache | null => {
    if (!tree || !cache) {
      return null;
    }
    const cached = rectBasePathCacheRef.current.get(orderKey);
    if (cached) {
      return cached;
    }
    const built = buildRectBranchPaths(tree, layout, cache.orderedChildren[orderKey]);
    rectBasePathCacheRef.current.set(orderKey, built);
    return built;
  }, [cache, tree]);

  const getCircularTaxonomyBitmapCache = useCallback((
    orderKey: LayoutOrder,
    branchColorKey: string,
    paths: Map<string, Path2D>,
    camera: CircularCamera,
  ): CircularTaxonomyBitmapCache | null => {
    if (typeof document === "undefined" || !tree) {
      return null;
    }
    const signature = [
      orderKey,
      branchColorKey,
      branchStrokeScale.toFixed(3),
      size.width,
      size.height,
      camera.scale.toFixed(6),
      camera.rotation.toFixed(6),
    ].join(":");
    const cached = circularTaxonomyBitmapCacheRef.current;
    if (cached?.signature === signature && Math.abs(cached.rotation - camera.rotation) <= 1e-6) {
      return cached;
    }
    // This cache only stores branch strokes, so label padding should not inflate the offscreen bitmap.
    const maxRadiusPx = (Math.max(tree.maxDepth, tree.branchLengthMinPositive) * camera.scale) + 8;
    const visibleMargin = 56;
    const minTranslateX = visibleMargin - maxRadiusPx;
    const maxTranslateX = size.width - visibleMargin + maxRadiusPx;
    const minTranslateY = visibleMargin - maxRadiusPx;
    const maxTranslateY = size.height - visibleMargin + maxRadiusPx;
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
    ctx.scale(camera.scale, camera.scale);
    ctx.rotate(camera.rotation);
    ctx.lineCap = "butt";
    paths.forEach((path, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = (1.2 * branchStrokeScale) / Math.max(camera.scale, 1e-6);
      ctx.globalAlpha = 0.95;
      ctx.stroke(path);
    });
    ctx.globalAlpha = 1;
    const built = {
      signature,
      canvas,
      rotation: camera.rotation,
      sourceOffsetX: maxTranslateX,
      sourceOffsetY: maxTranslateY,
      viewportWidth: size.width,
      viewportHeight: size.height,
    };
    circularTaxonomyBitmapCacheRef.current = built;
    return built;
  }, [branchStrokeScale, size.height, size.width, tree]);

  const toggleCollapsedNode = useCallback((node: number) => {
    if (!tree || tree.buffers.firstChild[node] < 0) {
      return;
    }
    setCollapsedNodes((current) => {
      const next = new Set(current);
      if (next.has(node)) {
        next.delete(node);
      } else {
        next.add(node);
      }
      return next;
    });
  }, [tree]);

  const convertCameraForViewMode = useCallback((fromCamera: CameraState): CameraState => {
    if (!tree) {
      return fromCamera;
    }
    if (cameraApproximatelyMatchesFit(fromCamera)) {
      return fitCameraForMode(viewMode) ?? fromCamera;
    }
    const centerScreenX = size.width * 0.5;
    const centerScreenY = size.height * 0.5;

    if (fromCamera.kind === "circular" && viewMode === "rectangular") {
      const world = screenToWorldCircular(fromCamera, centerScreenX, centerScreenY);
      const radius = Math.sqrt((world.x * world.x) + (world.y * world.y));
      const theta = wrapPositive(Math.atan2(world.y, world.x));
      const targetX = radius;
      const targetY = (theta / (Math.PI * 2)) * tree.leafCount;
      const nextCamera = fitRectCamera(size.width, size.height, tree);
      nextCamera.scaleX = Math.max(nextCamera.scaleX * 0.55, fromCamera.scale);
      const pixelsPerLeaf = Math.max(
        nextCamera.scaleY * 0.55,
        Math.max(radius, tree.branchLengthMinPositive) * fromCamera.scale * ((Math.PI * 2) / Math.max(1, tree.leafCount)),
      );
      nextCamera.scaleY = pixelsPerLeaf;
      nextCamera.translateX = centerScreenX - (targetX * nextCamera.scaleX);
      nextCamera.translateY = centerScreenY - (targetY * nextCamera.scaleY);
      clampRectCamera(nextCamera, tree, size.width, size.height, rectClampPadding(nextCamera));
      return nextCamera;
    }

    if (fromCamera.kind === "rect" && viewMode === "circular") {
      const world = screenToWorldRect(fromCamera, centerScreenX, centerScreenY);
      const theta = ((world.y / Math.max(1, tree.leafCount)) * Math.PI * 2);
      const point = polarToCartesian(world.x, theta);
      const nextCamera = fitCircularCamera(size.width, size.height, tree, circularRotation);
      const angularScale = world.x > tree.branchLengthMinPositive
        ? (fromCamera.scaleY * Math.max(1, tree.leafCount)) / (Math.PI * 2 * world.x)
        : 0;
      nextCamera.scale = Math.max(nextCamera.scale * 0.55, fromCamera.scaleX, angularScale);
      const rotatedPoint = rotateCircularWorldPoint(nextCamera, point.x, point.y);
      nextCamera.translateX = centerScreenX - (rotatedPoint.x * nextCamera.scale);
      nextCamera.translateY = centerScreenY - (rotatedPoint.y * nextCamera.scale);
      finalizeCircularCamera(nextCamera);
      return nextCamera;
    }

    return fromCamera;
  }, [cameraApproximatelyMatchesFit, circularRotation, finalizeCircularCamera, fitCameraForMode, size.height, size.width, tree, viewMode]);

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

    const baseDpr = window.devicePixelRatio || 1;
    const dpr = baseDpr;
    const backingWidth = Math.max(1, Math.floor(size.width * dpr));
    const backingHeight = Math.max(1, Math.floor(size.height * dpr));
    const previousBackingStore = canvasBackingStoreRef.current;
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
      canvasBackingStoreRef.current = {
        width: backingWidth,
        height: backingHeight,
        dpr,
      };
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const scaleLabelText = (value: number): string => (
      tree.isUltrametric ? `${formatAgeNumber(value)} mya` : formatScaleNumber(value)
    );
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.fillStyle = "#fbfcfe";
    ctx.fillRect(0, 0, size.width, size.height);
    const exportCapture = exportCaptureRef.current !== null;
    if (exportCapture) {
      exportCaptureRef.current = {
        width: size.width,
        height: size.height,
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
    const pushScenePath = (d: string, stroke?: string, strokeWidth?: number, fill?: string, opacity?: number, dashArray?: string): void => {
      if (!exportCaptureRef.current || !d) {
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
    labelHitsRef.current = [];
    const renderDebug: Record<string, unknown> = {
      viewMode,
      order,
      width: size.width,
      height: size.height,
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
    hiddenNodesRef.current = hiddenNodes;
    if (viewMode === "rectangular" && camera.kind === "rect") {
      const layout = collapsedView?.layout ?? tree.layouts[order];
      const children = cache.orderedChildren[order];
      const worldMin = screenToWorldRect(camera, 0, 0);
      const worldMax = screenToWorldRect(camera, size.width, size.height);
      const minX = Math.min(worldMin.x, worldMax.x);
      const maxX = Math.max(worldMin.x, worldMax.x);
      const minY = Math.min(worldMin.y, worldMax.y);
      const maxY = Math.max(worldMin.y, worldMax.y);
      const rectWorldOverscanX = Math.max(tree.branchLengthMinPositive * 2, 48 / Math.max(camera.scaleX, 1e-6));
      const rectWorldOverscanY = Math.max(2, 48 / Math.max(camera.scaleY, 1e-6));
      const axisBarHeight = showScaleBars ? 44 : 0;
      const treeDrawBottom = size.height - axisBarHeight;
      const stripeExtent = tree.isUltrametric ? tree.rootAge : tree.maxDepth;
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
      const tipLabelCueVisible = camera.scaleY > 1.45;
      const microTipLabelsVisible = camera.scaleY > 2.7;
      const tipLabelsVisible = camera.scaleY > 4.2;
      const visibleTaxonomyRanks = taxonomyEnabled && taxonomyConsensus
        ? rectVisibleTaxonomyRanksForScaleY(camera.scaleY)
        : [];
      const taxonomyBranchRenderingVisible = taxonomyBranchColoringEnabled && visibleTaxonomyRanks.length > 0 && taxonomyColors !== null;
      const coloredBranchKey = taxonomyBranchRenderingVisible
        ? `taxonomy:${visibleTaxonomyRanks.join("|")}:${metadataBranchColorVersion}:${manualBranchColorVersion}`
        : metadataBranchColorOverlay.hasAny || manualBranchColorOverlay.hasAny
          ? `manual:${metadataBranchColorVersion}:${manualBranchColorVersion}`
          : "";
      const effectiveBranchColors = coloredBranchKey ? getEffectiveBranchColors(order, visibleTaxonomyRanks) : null;
      const useColoredBranchRendering = effectiveBranchColors !== null;
      const fitLikeRect = fitCameraForMode("rectangular");
      const nearRectFit = fitLikeRect?.kind === "rect"
        ? camera.scaleY <= (fitLikeRect.scaleY * 3.2)
        : false;
      const useCachedRectTaxonomyPaths = !exportCapture && useColoredBranchRendering && collapsedNodes.size === 0 && nearRectFit;
      const cachedRectTaxonomyPaths = useCachedRectTaxonomyPaths
        ? getRectTaxonomyPaths(order, layout, coloredBranchKey, effectiveBranchColors)
        : null;
      const useCachedRectBasePath = !exportCapture && !useColoredBranchRendering && collapsedNodes.size === 0 && nearRectFit;
      const cachedRectBasePaths = useCachedRectBasePath
        ? getRectBasePaths(order, layout)
        : null;

      if (showTimeStripes) {
        if (timeStripeStyle === "dashed") {
          ctx.save();
          ctx.setLineDash([6, 6]);
          for (let index = 0; index < stripeBoundaries.length; index += 1) {
            const boundary = stripeBoundaries[index];
            const x = tree.isUltrametric
              ? worldToScreenRect(camera, tree.rootAge - boundary.value, 0).x
              : worldToScreenRect(camera, boundary.value, 0).x;
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
          const drawBands = (step: number, alpha: number) => {
            if (!Number.isFinite(step) || step <= 0 || alpha <= 0) {
              return;
            }
            for (let start = 0, index = 0; start < rectStripeExtent; start += step, index += 1) {
              const next = Math.min(rectStripeExtent, start + step);
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
              pushSceneRect(left, 0, right - left, treeDrawBottom, ctx.fillStyle, 1);
            }
          };
          for (let index = 0; index < stripeLevels.length; index += 1) {
            drawBands(stripeLevels[index].step, index === 0 ? 1 : stripeLevels[index].alpha * 0.82);
          }
        }
      }

      const useDenseRectLOD = !exportCapture && camera.scaleY < 1.25;
      const rectConnectorKeys = useDenseRectLOD ? new Set<string>() : null;
      const rectStemKeys = useDenseRectLOD ? new Set<string>() : null;
      const visibleRectSegments = collapsedNodes.size === 0
        ? cache.rectIndices[order].query(
          (minX + maxX) * 0.5,
          (minY + maxY) * 0.5,
          Math.max(1e-6, (maxX - minX) * 0.5) + rectWorldOverscanX,
          Math.max(1e-6, (maxY - minY) * 0.5) + rectWorldOverscanY,
        )
        : null;
      const rectBranchRenderMode = cachedRectTaxonomyPaths
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
      if (cachedRectTaxonomyPaths) {
        ctx.save();
        ctx.translate(camera.translateX, camera.translateY);
        ctx.scale(camera.scaleX, camera.scaleY);
        ctx.lineCap = "butt";
        cachedRectTaxonomyPaths.forEach((paths, color) => {
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.95;
          ctx.lineWidth = (1.2 * branchStrokeScale) / Math.max(camera.scaleX, 1e-6);
          ctx.stroke(paths.connectors);
          ctx.lineWidth = (1.2 * branchStrokeScale) / Math.max(camera.scaleY, 1e-6);
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
        ctx.lineWidth = branchStrokeScale / Math.max(camera.scaleX, 1e-6);
        ctx.stroke(cachedRectBasePaths.connectors);
        ctx.lineWidth = branchStrokeScale / Math.max(camera.scaleY, 1e-6);
        ctx.stroke(cachedRectBasePaths.stems);
        ctx.restore();
      } else if (!useColoredBranchRendering) {
        ctx.strokeStyle = BRANCH_COLOR;
        ctx.lineWidth = branchStrokeScale;
        ctx.beginPath();
        if (visibleRectSegments) {
          for (let index = 0; index < visibleRectSegments.length; index += 1) {
            const segment = visibleRectSegments[index];
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
            pushSceneLine(start.x, start.y, end.x, end.y, BRANCH_COLOR, branchStrokeScale);
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
            pushSceneLine(start.x, start.y, end.x, end.y, BRANCH_COLOR, branchStrokeScale);
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
            pushSceneLine(start.x, start.y, end.x, end.y, BRANCH_COLOR, branchStrokeScale);
          }
        }
        ctx.stroke();
      } else {
        const colorPaths = new Map<string, Array<[number, number, number, number]>>();
        const pushColoredSegment = (color: string, x1: number, y1: number, x2: number, y2: number): void => {
          const segments = colorPaths.get(color) ?? [];
          segments.push([x1, y1, x2, y2]);
          colorPaths.set(color, segments);
          pushSceneLine(x1, y1, x2, y2, color, branchStrokeScale);
        };
        if (visibleRectSegments) {
          for (let index = 0; index < visibleRectSegments.length; index += 1) {
            const segment = visibleRectSegments[index];
            if (segment.kind === "connector") {
              const ownerNode = segment.node;
              const x = tree.buffers.depth[ownerNode];
              forEachRectConnectorChildSpan(layout, children, ownerNode, (childNode, startY, endY) => {
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
          for (let node = 0; node < tree.nodeCount; node += 1) {
            if (hiddenNodes[node] || collapsedNodes.has(node)) {
              continue;
            }
            if (children[node].length < 2) {
              continue;
            }
            const x = tree.buffers.depth[node];
            forEachRectConnectorChildSpan(layout, children, node, (childNode, startY, endY) => {
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
            const color = effectiveBranchColors?.[node] ?? BRANCH_COLOR;
            pushColoredSegment(color, start.x, start.y, end.x, end.y);
          }
        }
        colorPaths.forEach((segments, color) => {
          ctx.beginPath();
          for (let index = 0; index < segments.length; index += 1) {
            const [x1, y1, x2, y2] = segments[index];
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = branchStrokeScale;
          ctx.globalAlpha = 1;
          ctx.stroke();
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

      if (hoverRef.current) {
        const hover = hoverRef.current;
        const parent = tree.buffers.parent[hover.node];
        if (parent >= 0) {
          ctx.strokeStyle = HOVER_COLOR;
          ctx.lineWidth = 2;
          ctx.beginPath();
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
        }
      }

      let visibleTipLabels: Array<{ node: number; text: string; x: number; y: number; width: number }> = [];
      const tipFontSize = scaleLabelFontSize("tip", Math.max(6.5, Math.min(22, camera.scaleY * 0.58)));
      const microTipFontSize = scaleLabelFontSize("tip", Math.max(4.2, Math.min(6.25, camera.scaleY * 0.34)));
      const readableBandProgress = smoothstep01((camera.scaleY - 2.7) / Math.max(1e-6, 4.2 - 2.7));
      const tipBandFontSize = camera.scaleY <= 2.7
        ? 0
        : microTipFontSize + ((tipFontSize - microTipFontSize) * readableBandProgress);
      const microBandWidthPx = estimateLabelWidth(Math.max(microTipFontSize, 4.2), reservedTipLabelCharacters);
      const readableBandWidthPx = estimateLabelWidth(Math.max(tipFontSize, 6.5), reservedTipLabelCharacters);
      const globalTipLabelSpacePx = interpolateTipBandWidthPx(
        camera.scaleY,
        1.55,
        2.7,
        4.2,
        microBandWidthPx,
        readableBandWidthPx,
      );
      const tipSideDepth = tree.isUltrametric ? tree.rootAge : tree.maxDepth;
      const tipSideX = worldToScreenRect(camera, tipSideDepth, 0).x + 8;
      const orderedLeaves = cache.orderedLeaves[order];
      const startLeafIndex = lowerBoundLeaves(orderedLeaves, layout.center, minY - 2);
      const endLeafIndex = lowerBoundLeaves(orderedLeaves, layout.center, maxY + 2.000001);
      const visibleLeafRanges = [{ startIndex: startLeafIndex, endIndex: endLeafIndex }];
      const measuredLabels: Array<{ node: number; text: string; x: number; y: number; width: number }> = [];
      const needTipEnvelope = tipLabelCueVisible || camera.scaleY > 2.35;
      if (needTipEnvelope) {
        ctx.font = fontSpec("tip", tipFontSize);
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        for (let index = startLeafIndex; index < endLeafIndex; index += 1) {
          const node = orderedLeaves[index];
          if (hiddenNodes[node]) {
            continue;
          }
          const y = layout.center[node];
          const text = displayLabelText(tree.names[node] || "", `tip-${node}`);
          const screen = worldToScreenRect(camera, tree.buffers.depth[node], y);
          const x = screen.x + 8 + figureStyles.tip.offsetPx;
          const width = ctx.measureText(text).width;
          measuredLabels.push({ node, text, x, y: screen.y, width });
        }
      }
      const maxVisibleLabels = 5200;
      if (microTipLabelsVisible && measuredLabels.length <= maxVisibleLabels) {
        visibleTipLabels = measuredLabels.map(({ node, text, x, y, width }) => ({ node, text, x, y, width }));
      }

      const genusGapPx = Math.max(12, tipBandFontSize * 1.9);
      const taxonomyOverlayStartTime = performance.now();
      if (taxonomyEnabled && taxonomyBlocks) {
        const visibleRanks = visibleTaxonomyRanks;
        const baseFontSize = Math.max(8.5, Math.min(18, 8.5 + (camera.scaleY * 0.45)));
        const taxonomyMetricBaseSize = Math.max(8.5, Math.min(18, 8.5 + (camera.scaleY * 0.45)));
        const metrics = taxonomyRingMetricsPx(visibleRanks.length, taxonomyMetricBaseSize, taxonomyBandThicknessScale);
        const bandXs: number[] = [];
        const bandWidthsPx: number[] = [];
        const placedLabels: ScreenLabel[] = [];
        const placedKeys: string[] = [];
        const renderedBlocksDebug: Array<{ rank: TaxonomyRank; label: string; topY: number; bottomY: number }> = [];
        let taxonomyConnectorSegmentCount = 0;
        let bandCursorX = tipSideX + globalTipLabelSpacePx + 18;
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
          const rankKeyPrefix = `${rank}:`;
          const blocksForRank = taxonomyBlocks[order][rank];
          const blockByKey = new Map<string, TaxonomyBlock>();
          for (let blockIndex = 0; blockIndex < blocksForRank.length; blockIndex += 1) {
            blockByKey.set(`${rank}:${blocksForRank[blockIndex].label}:${blocksForRank[blockIndex].centerNode}`, blocksForRank[blockIndex]);
          }
          const orderedBlocks: TaxonomyBlock[] = [];
          for (let preservedIndex = 0; preservedIndex < preservedKeys.length; preservedIndex += 1) {
            const key = preservedKeys[preservedIndex];
            if (!key.startsWith(rankKeyPrefix)) {
              continue;
            }
            const block = blockByKey.get(key);
            if (block) {
              orderedBlocks.push(block);
              blockByKey.delete(key);
            }
          }
          orderedBlocks.push(...blockByKey.values());
          orderedBlocks.sort((left, right) => {
            const leftTips = (left.segments ?? []).reduce((total, segment) => {
              const end = segment.endIndex >= segment.startIndex ? segment.endIndex : segment.endIndex + tree.leafCount;
              return total + Math.max(0, end - segment.startIndex);
            }, 0);
            const rightTips = (right.segments ?? []).reduce((total, segment) => {
              const end = segment.endIndex >= segment.startIndex ? segment.endIndex : segment.endIndex + tree.leafCount;
              return total + Math.max(0, end - segment.startIndex);
            }, 0);
            if (rightTips !== leftTips) {
              return rightTips - leftTips;
            }
            return (left.startIndex ?? 0) - (right.startIndex ?? 0);
          });
          const bandX = bandCursorX;
          const bandWidthPx = metrics.ringWidthsPx[rankIndex];
          bandXs.push(bandX);
          bandWidthsPx.push(bandWidthPx);
          bandCursorX += bandWidthPx;
          const labelsForRank: ScreenLabel[] = [];
          for (let blockIndex = 0; blockIndex < orderedBlocks.length; blockIndex += 1) {
            const block = orderedBlocks[blockIndex];
            if (hiddenNodes[block.centerNode]) {
              continue;
            }
            const blockKey = `${rank}:${block.label}`;
            const isPreservedLabel = preservedKeySet.has(blockKey);
            const blockSegments = block.segments && block.segments.length > 0
              ? block.segments
              : [{ firstNode: block.firstNode, lastNode: block.lastNode, startIndex: 0, endIndex: 0 }];
            if (!taxonomyBlockIntersectsVisibleLeafRanges(blockSegments, visibleLeafRanges, tree.leafCount)) {
              continue;
            }
            const totalTipCount = blockSegments.reduce((total, segment) => {
              const end = segment.endIndex >= segment.startIndex ? segment.endIndex : segment.endIndex + tree.leafCount;
              return total + Math.max(0, end - segment.startIndex);
            }, 0);
            for (let segmentIndex = 0; segmentIndex < blockSegments.length; segmentIndex += 1) {
              const segment = blockSegments[segmentIndex];
              const bounds = rectLeafRangeBounds(orderedLeaves, layout.center, segment.startIndex, segment.endIndex);
              if (!bounds) {
                continue;
              }
              const top = worldToScreenRect(camera, tree.buffers.depth[segment.firstNode], bounds.topY).y;
              const bottom = worldToScreenRect(camera, tree.buffers.depth[segment.lastNode], bounds.bottomY).y;
              if (bottom < -18 || top > size.height + 18) {
                continue;
              }
              const verticalInsetPx = Math.min(0.75, Math.max(0, (bottom - top - 1) * 0.5));
              ctx.fillStyle = block.color;
              ctx.fillRect(
                bandX,
                top + verticalInsetPx,
                bandWidthPx,
                Math.max(1, (bottom - top) - (verticalInsetPx * 2)),
              );
              pushSceneRect(
                bandX,
                top + verticalInsetPx,
                bandWidthPx,
                Math.max(1, (bottom - top) - (verticalInsetPx * 2)),
                block.color,
              );
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

            const labelSegment = {
              firstNode: orderedLeaves[block.labelStartIndex ?? block.startIndex ?? blockSegments[0].startIndex],
              lastNode: orderedLeaves[((block.labelEndIndex ?? block.endIndex ?? blockSegments[0].endIndex) - 1 + orderedLeaves.length) % orderedLeaves.length],
              startIndex: block.labelStartIndex ?? block.startIndex ?? blockSegments[0].startIndex,
              endIndex: block.labelEndIndex ?? block.endIndex ?? blockSegments[0].endIndex,
            };
            const taxonomyTaxId = taxonomyTaxIdsByRank.get(rank)?.get(block.label) ?? null;
            if (!taxonomyBlockIntersectsVisibleLeafRanges([labelSegment], visibleLeafRanges, tree.leafCount)) {
              continue;
            }
            if (totalTipCount <= 1) {
              continue;
            }
            const labelBounds = rectLeafRangeBounds(
              orderedLeaves,
              layout.center,
              labelSegment.startIndex,
              labelSegment.endIndex,
            );
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
            const fitFontSize = Math.min(30, Math.min(
              availableSpanPx / normalizedMetrics.widthAtOnePx,
              availableBandPx / normalizedMetrics.heightAtOnePx,
            ) * 0.94);
            if (!Number.isFinite(fitFontSize) || fitFontSize < minFontSize) {
              continue;
            }
            const visibleTop = Math.max(0, top);
            const visibleBottom = Math.min(size.height, bottom);
            const blockSpansViewport = top <= 0 && bottom >= size.height;
            const labelX = bandX + (bandWidthPx * 0.5);
            const labelY = blockSpansViewport
              ? size.height * 0.5
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
              size.width,
              size.height,
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
              size.width,
              size.height,
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
              rotation,
              align: "center",
              color: taxonomyTextColor(block.color),
              searchHighlightColor,
              searchMatchRange,
              taxId: taxonomyTaxId,
              firstNode: labelSegment.firstNode,
              lastNode: labelSegment.lastNode,
              taxonomyTipCount: totalTipCount,
              offsetY: 0,
            });
            placedKeys.push(blockKey);
          }
          placedLabels.push(...labelsForRank);
          bandCursorX += metrics.ringGapPx;
        }
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
          tipBandFontSize,
          tipBandWidthPx: globalTipLabelSpacePx,
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
            TAXONOMY_RANKS.map((rank) => [rank, taxonomyBlocks[order][rank]?.length ?? 0]),
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
        const genusBandX = tipSideX + globalTipLabelSpacePx + genusGapPx;
        ctx.fillStyle = GENUS_COLOR;
        ctx.strokeStyle = GENUS_COLOR;
        ctx.lineWidth = 1;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        const maxGenusLabels = Math.max(18, Math.ceil(size.height / 18));
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
          if (x < -80 || x > size.width + 160) {
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
          tipBandFontSize,
          tipBandWidthPx: globalTipLabelSpacePx,
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
          tipBandFontSize,
          tipBandWidthPx: globalTipLabelSpacePx,
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
        const renderTipFontSize = tipLabelsVisible ? tipFontSize : microTipFontSize;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        for (let index = 0; index < visibleTipLabels.length; index += 1) {
          const label = visibleTipLabels[index];
          const fittedFontSize = Math.max(
            4,
            Math.min(
              renderTipFontSize,
              renderTipFontSize * Math.min(1, globalTipLabelSpacePx / Math.max(1e-6, label.width)),
            ),
          );
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
              text: label.text,
              x: label.x,
              y: label.y - (fittedFontSize * 0.55),
              width: Math.min(globalTipLabelSpacePx, ctx.measureText(label.text).width),
              height: fittedFontSize * 1.1,
            });
          } else {
            ctx.fillStyle = "rgba(15,23,42,0.6)";
            ctx.fillText(label.text, label.x, label.y);
            pushSceneText(label.text, label.x, label.y, "rgba(15,23,42,0.6)", fittedFontSize, labelFontFamilies.tip, "start", undefined, labelFontStyles.tip);
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

      if ((showInternalNodeLabels || showBootstrapLabels) && camera.scaleX > 1.15) {
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
          const labelClass: LabelStyleClass = isBootstrap ? "bootstrap" : "internalNode";
          const baseFontSize = isBootstrap
            ? Math.max(7.5, Math.min(11, Math.min(camera.scaleY * 0.22, camera.scaleX * 0.18)))
            : Math.max(8.5, Math.min(13, Math.min(camera.scaleY * 0.26, camera.scaleX * 0.2)));
          const fontSize = scaleLabelFontSize(labelClass, baseFontSize);
          const screen = worldToScreenRect(camera, tree.buffers.depth[node], layout.center[node]);
          const x = screen.x + 8 + figureStyles[labelClass].offsetXPx;
          const y = screen.y + (isBootstrap ? 10 : -10) + figureStyles[labelClass].offsetYPx;
          if (x < -40 || x > size.width + 140 || y < -20 || y > size.height + 20) {
            continue;
          }
          if (!canPlaceLinearLabel(labels, x, y, fontSize * 1.3, estimateLabelWidth(fontSize, rawLabel.length))) {
            continue;
          }
          labels.push({ x, y, text: rawLabel, alpha: 0.92, fontSize, color: isBootstrap ? "#475569" : "#1f2937" });
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
        ctx.fillStyle = "#cbd5e1";
        ctx.strokeStyle = "#64748b";
        ctx.lineWidth = 1.1;
        for (let index = 0; index < visibleCollapsedNodes.length; index += 1) {
          const node = visibleCollapsedNodes[index];
          const parent = tree.buffers.parent[node];
          const apex = worldToScreenRect(camera, tree.buffers.depth[node], layout.center[node]);
          const subtreeTipDepth = measureSubtreeMaxDepth(tree, node);
          const baseTop = worldToScreenRect(camera, subtreeTipDepth, layout.min[node]);
          const baseBottom = worldToScreenRect(camera, subtreeTipDepth, layout.max[node]);
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
          labelHitsRef.current.push({
            node,
            kind: "rect",
            source: "collapse",
            x: hitMinX,
            y: hitMinY,
            width: hitMaxX - hitMinX,
            height: hitMaxY - hitMinY,
          });
          if (parent >= 0) {
            const edgeStart = worldToScreenRect(camera, tree.buffers.depth[parent], layout.center[node]);
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

      if (showNodeHeightLabels && camera.scaleX > 1.2) {
        const labels: ScreenLabel[] = [];
        const fontSize = scaleLabelFontSize("nodeHeight", Math.max(9, Math.min(13, Math.min(camera.scaleY * 0.34, camera.scaleX * 0.25))));
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
          if (camera.scaleY <= 3.2 && subtreeSpanPx < 10 && branchSpanPx < 14) {
            continue;
          }
          const screen = worldToScreenRect(camera, x, y);
          const labelX = screen.x + figureStyles.nodeHeight.offsetXPx;
          const labelY = screen.y - 5 + figureStyles.nodeHeight.offsetYPx;
          if (!canPlaceLinearLabel(labels, labelX, labelY, fontSize * 1.7, fontSize * 4.8)) {
            continue;
          }
          labels.push({
            x: labelX,
            y: labelY,
            text: formatAgeNumber(nodeHeightValue(tree, node)),
            alpha: 0.78,
          });
        }
        for (let index = 0; index < labels.length; index += 1) {
          const label = labels[index];
          ctx.globalAlpha = label.alpha;
          ctx.fillText(label.text, label.x, label.y);
          pushSceneText(label.text, label.x, label.y, "#64748b", fontSize, labelFontFamilies.nodeHeight, "middle");
        }
        ctx.globalAlpha = 1;
      }

      if (metadataMarkerNodes.length > 0 && metadataMarkers && camera.scaleX > 0.95) {
        const maxVisibleMetadataMarkers = 1800;
        let visibleMarkers = 0;
        ctx.lineWidth = 1.1;
        for (let index = 0; index < metadataMarkerNodes.length; index += 1) {
          if (visibleMarkers >= maxVisibleMetadataMarkers) {
            break;
          }
          const node = metadataMarkerNodes[index];
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
          const { x: markerX, y: markerY } = metadataRectMarkerScreenPosition(tree, node, y, camera, metadataMarkerSizePx);
          ctx.fillStyle = marker.color;
          ctx.strokeStyle = "rgba(255,255,255,0.92)";
          drawMetadataMarker(ctx, marker.shape, markerX, markerY, metadataMarkerSizePx);
          ctx.fill();
          ctx.stroke();
          pushScenePath(metadataMarkerPath(marker.shape, markerX, markerY, metadataMarkerSizePx), "rgba(255,255,255,0.92)", 1.1, marker.color, 1);
          visibleMarkers += 1;
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
        ctx.strokeStyle = ERROR_BAR_COLOR;
        ctx.lineWidth = errorBarThicknessPx;
        const halfCap = Math.max(0, errorBarCapSizePx * 0.5);
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
          ctx.globalAlpha = 0.82;
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
          pushSceneLine(start.x, start.y, end.x, end.y, ERROR_BAR_COLOR, errorBarThicknessPx, 0.82);
          if (halfCap > 0) {
            pushSceneLine(start.x, start.y - halfCap, start.x, start.y + halfCap, ERROR_BAR_COLOR, errorBarThicknessPx, 0.82);
            pushSceneLine(end.x, end.y - halfCap, end.x, end.y + halfCap, ERROR_BAR_COLOR, errorBarThicknessPx, 0.82);
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
        ctx.fillRect(0, size.height - axisBarHeight, size.width, axisBarHeight);
        const axisY = size.height - 28;
        ctx.strokeStyle = "#6b7280";
        ctx.fillStyle = "#6b7280";
        ctx.lineWidth = 1;
        const scaleFontSize = scaleLabelFontSize("scale", 11);
        ctx.font = fontSpec("scale", scaleFontSize);
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.beginPath();
        const axisStart = tree.isUltrametric
          ? worldToScreenRect(camera, stripeExtent - rectScaleExtent, 0).x
          : worldToScreenRect(camera, 0, 0).x;
        const axisEnd = tree.isUltrametric
          ? worldToScreenRect(camera, stripeExtent, 0).x
          : worldToScreenRect(camera, stripeExtent, 0).x;
        ctx.moveTo(axisStart, axisY);
        ctx.lineTo(axisEnd, axisY);
        pushSceneLine(axisStart, axisY, axisEnd, axisY, "#6b7280", 1);
        if (displayedRectScaleBoundaries.length > 0) {
          for (let index = 0; index < displayedRectScaleBoundaries.length; index += 1) {
            const boundary = displayedRectScaleBoundaries[index];
            const x = tree.isUltrametric
              ? worldToScreenRect(camera, stripeExtent - boundary.value, 0).x
              : worldToScreenRect(camera, boundary.value, 0).x;
            ctx.globalAlpha = 0.35 + (0.65 * boundary.alpha);
            ctx.moveTo(x, axisY);
            ctx.lineTo(x, axisY + (4 + (3 * boundary.alpha)));
            pushSceneLine(x, axisY, x, axisY + (4 + (3 * boundary.alpha)), "#6b7280", 1, 0.35 + (0.65 * boundary.alpha));
          }
          ctx.globalAlpha = 1;
          ctx.stroke();
          for (let index = 0; index < displayedRectScaleBoundaries.length; index += 1) {
            const boundary = displayedRectScaleBoundaries[index];
            const x = tree.isUltrametric
              ? worldToScreenRect(camera, stripeExtent - boundary.value, 0).x
              : worldToScreenRect(camera, boundary.value, 0).x;
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

    if (viewMode === "circular" && camera.kind === "circular") {
      const layout = collapsedView?.layout ?? tree.layouts[order];
      const children = cache.orderedChildren[order];
      const orderedLeaves = cache.orderedLeaves[order];
      const rotationAngle = camera.rotation;
      const maxRadius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
      const angularSpacingPx = camera.scale * maxRadius * (Math.PI * 2 / Math.max(1, tree.leafCount));
      const stripeExtent = tree.isUltrametric ? tree.rootAge : tree.maxDepth;
      const visibleRadius = Math.max(1e-9, Math.min(size.width, size.height) / (2 * camera.scale));
      const stripeLevels = buildStripeLevels(visibleRadius, camera.scale, scaleTickInterval);
      const stripeBoundaries = buildStripeBoundaries(stripeExtent, stripeLevels);
      const visibleScaleBoundaries = showIntermediateScaleTicks
        ? stripeBoundaries
        : stripeBoundaries.filter((boundary) => boundary.alpha >= SOLID_SCALE_TICK_ALPHA_THRESHOLD);
      const circularCenterScaleLevels = buildStripeLevels(
        visibleRadius,
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
        size.width - centerPoint.x,
        centerPoint.y,
        size.height - centerPoint.y,
      );
      const circularCachePrepStartTime = performance.now();
      let visibleTaxonomyRanks = taxonomyEnabled && taxonomyConsensus
        ? (useAutomaticTaxonomyRankVisibility
          ? taxonomyVisibleRanksForZoom(angularSpacingPx, taxonomyActiveRanks)
          : taxonomyActiveRanks)
        : [];
      const visibleCircleFraction = fullyVisibleRadiusPx / Math.max(1e-9, stripeExtent * camera.scale);
      const fitLikeCircular = fitCameraForMode("circular");
      const nearCircularFit = fitLikeCircular?.kind === "circular"
        ? camera.scale <= (fitLikeCircular.scale * 1.35)
        : false;
      const lockTaxonomyLabelsToClade = nearCircularFit || visibleCircleFraction >= 0.5;
      if (useAutomaticTaxonomyRankVisibility && visibleCircleFraction >= 0.88 && visibleTaxonomyRanks.length > 2) {
        visibleTaxonomyRanks = visibleTaxonomyRanks.slice(-2);
      }
      const taxonomyBranchRenderingVisible = taxonomyBranchColoringEnabled && visibleTaxonomyRanks.length > 0 && taxonomyColors !== null;
      const circularTaxonomyCacheStartTime = performance.now();
      const coloredBranchKey = taxonomyBranchRenderingVisible
        ? `taxonomy:${visibleTaxonomyRanks.join("|")}:${metadataBranchColorVersion}:${manualBranchColorVersion}`
        : metadataBranchColorOverlay.hasAny || manualBranchColorOverlay.hasAny
          ? `manual:${metadataBranchColorVersion}:${manualBranchColorVersion}`
          : "";
      const effectiveBranchColors = coloredBranchKey ? getEffectiveBranchColors(order, visibleTaxonomyRanks) : null;
      const useColoredBranchRendering = effectiveBranchColors !== null;
      const useCachedCircularTaxonomyPaths = !exportCapture && useColoredBranchRendering && collapsedNodes.size === 0 && angularSpacingPx < 0.8;
      const cachedCircularTaxonomyPaths = useCachedCircularTaxonomyPaths
        ? getCircularTaxonomyPaths(order, layout, coloredBranchKey, effectiveBranchColors)
        : null;
      const useCircularTaxonomyBitmapAtCurrentScale = fitLikeCircular?.kind === "circular"
        ? camera.scale <= (fitLikeCircular.scale * 1.05)
        : false;
      const useCachedCircularTaxonomyBitmap = !exportCapture && useCachedCircularTaxonomyPaths
        && cachedCircularTaxonomyPaths !== null
        && nearCircularFit
        && useCircularTaxonomyBitmapAtCurrentScale;
      const cachedCircularTaxonomyBitmap = useCachedCircularTaxonomyBitmap
        ? getCircularTaxonomyBitmapCache(order, coloredBranchKey, cachedCircularTaxonomyPaths, camera)
        : null;
      const useCachedCircularBasePath = !exportCapture && !useColoredBranchRendering && collapsedNodes.size === 0 && angularSpacingPx < 1.1;
      const cachedCircularBasePath = useCachedCircularBasePath
        ? getCircularBasePath(order, layout)
        : null;
      timing.circularTaxonomyCacheMs += performance.now() - circularTaxonomyCacheStartTime;
      const circularBranchRenderMode = cachedCircularTaxonomyBitmap
        ? "taxonomy-cached-bitmap"
        : useCachedCircularTaxonomyPaths
          ? "taxonomy-cached-paths"
        : cachedCircularBasePath
          ? "cached-path"
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
          size.width,
          size.height,
          displayedCircularScaleBoundaries,
          stripeExtent,
          camera.scale,
        )
        : null;
      timing.circularCachePrepMs += performance.now() - circularCachePrepStartTime;

      if (showTimeStripes) {
        const center = { x: camera.translateX, y: camera.translateY };
        if (timeStripeStyle === "dashed") {
          ctx.save();
          ctx.setLineDash([6, 6]);
          for (let index = 0; index < stripeBoundaries.length; index += 1) {
            const boundary = stripeBoundaries[index];
            const radiusPx = (tree.isUltrametric ? stripeExtent - boundary.value : boundary.value) * camera.scale;
            ctx.beginPath();
            ctx.strokeStyle = `rgba(148,163,184,${0.22 + (0.5 * boundary.alpha)})`;
            ctx.lineWidth = timeStripeLineWeight;
            ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
            ctx.stroke();
            pushScenePath(
              `M ${(center.x + radiusPx).toFixed(3)} ${center.y.toFixed(3)} A ${radiusPx.toFixed(3)} ${radiusPx.toFixed(3)} 0 1 1 ${(center.x - radiusPx).toFixed(3)} ${center.y.toFixed(3)} A ${radiusPx.toFixed(3)} ${radiusPx.toFixed(3)} 0 1 1 ${(center.x + radiusPx).toFixed(3)} ${center.y.toFixed(3)}`,
              "#94a3b8",
              timeStripeLineWeight,
              undefined,
              0.22 + (0.5 * boundary.alpha),
              DASHED_STRIPE_DASH_ARRAY,
            );
          }
          ctx.restore();
        } else {
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
              pushScenePath(
                `M ${(center.x + outer).toFixed(3)} ${center.y.toFixed(3)} A ${outer.toFixed(3)} ${outer.toFixed(3)} 0 1 1 ${(center.x - outer).toFixed(3)} ${center.y.toFixed(3)} A ${outer.toFixed(3)} ${outer.toFixed(3)} 0 1 1 ${(center.x + outer).toFixed(3)} ${center.y.toFixed(3)} M ${(center.x + inner).toFixed(3)} ${center.y.toFixed(3)} A ${inner.toFixed(3)} ${inner.toFixed(3)} 0 1 0 ${(center.x - inner).toFixed(3)} ${center.y.toFixed(3)} A ${inner.toFixed(3)} ${inner.toFixed(3)} 0 1 0 ${(center.x + inner).toFixed(3)} ${center.y.toFixed(3)} Z`,
                undefined,
                undefined,
                ctx.fillStyle,
                1,
              );
            }
          };
          for (let index = 0; index < stripeLevels.length; index += 1) {
            drawBands(stripeLevels[index].step, index === 0 ? 1 : stripeLevels[index].alpha * 0.82);
          }
        }
      }

      const circularVisibilityPrepStartTime = performance.now();
      const needsVisibleCircularSegments = !cachedCircularTaxonomyBitmap
        && !(useCachedCircularTaxonomyPaths && cachedCircularTaxonomyPaths)
        && !cachedCircularBasePath;
      const useDenseCircularLOD = !exportCapture && needsVisibleCircularSegments && angularSpacingPx < 1.1;
      const circularConnectorKeys = useDenseCircularLOD ? new Set<string>() : null;
      const circularStemKeys = useDenseCircularLOD ? new Set<string>() : null;
      let visibleCircularSegments: ReturnType<typeof cache.circularIndices[typeof order]["query"]> | null = null;
      if (needsVisibleCircularSegments && collapsedNodes.size === 0) {
        const cornerWorldPoints = [
          screenToWorldCircular(camera, 0, 0),
          screenToWorldCircular(camera, size.width, 0),
          screenToWorldCircular(camera, 0, size.height),
          screenToWorldCircular(camera, size.width, size.height),
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
      if (cachedCircularTaxonomyBitmap) {
        const sourceX = Math.max(
          0,
          Math.min(
            cachedCircularTaxonomyBitmap.canvas.width - cachedCircularTaxonomyBitmap.viewportWidth,
            cachedCircularTaxonomyBitmap.sourceOffsetX - camera.translateX,
          ),
        );
        const sourceY = Math.max(
          0,
          Math.min(
            cachedCircularTaxonomyBitmap.canvas.height - cachedCircularTaxonomyBitmap.viewportHeight,
            cachedCircularTaxonomyBitmap.sourceOffsetY - camera.translateY,
          ),
        );
        ctx.drawImage(
          cachedCircularTaxonomyBitmap.canvas,
          sourceX,
          sourceY,
          cachedCircularTaxonomyBitmap.viewportWidth,
          cachedCircularTaxonomyBitmap.viewportHeight,
          0,
          0,
          size.width,
          size.height,
        );
      } else if (useCachedCircularTaxonomyPaths && cachedCircularTaxonomyPaths) {
        ctx.save();
        ctx.translate(camera.translateX, camera.translateY);
        ctx.scale(camera.scale, camera.scale);
        ctx.rotate(rotationAngle);
        ctx.lineCap = "butt";
        cachedCircularTaxonomyPaths.forEach((path, color) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = (1.2 * branchStrokeScale) / Math.max(camera.scale, 1e-6);
          ctx.globalAlpha = 0.95;
          ctx.stroke(path);
        });
        ctx.globalAlpha = 1;
        ctx.restore();
      } else if (cachedCircularBasePath) {
        ctx.save();
        ctx.translate(camera.translateX, camera.translateY);
        ctx.scale(camera.scale, camera.scale);
        ctx.rotate(rotationAngle);
        ctx.strokeStyle = BRANCH_COLOR;
        ctx.lineWidth = branchStrokeScale / Math.max(camera.scale, 1e-6);
        ctx.lineCap = "butt";
        ctx.stroke(cachedCircularBasePath);
        ctx.restore();
      } else if (!useColoredBranchRendering) {
        ctx.strokeStyle = BRANCH_COLOR;
        ctx.lineWidth = branchStrokeScale;
        ctx.beginPath();
        if (visibleCircularSegments) {
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
              const radiusPx = tree.buffers.depth[node] * camera.scale;
              if (radiusPx < 0.25) {
                continue;
              }
              const startTheta = thetaFor(layout.center, ordered[0], tree.leafCount);
              const endTheta = thetaFor(layout.center, ordered[ordered.length - 1], tree.leafCount);
              const arcStart = thetaFor(layout.min, node, tree.leafCount);
              const arcEnd = thetaFor(layout.max, node, tree.leafCount);
              const arcLength = Math.max(0, arcEnd - arcStart);
              const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
              ctx.moveTo(
                centerPoint.x + Math.cos(arcAngles.start + rotationAngle) * radiusPx,
                centerPoint.y + Math.sin(arcAngles.start + rotationAngle) * radiusPx,
              );
              ctx.arc(centerPoint.x, centerPoint.y, radiusPx, arcAngles.start + rotationAngle, arcAngles.end + rotationAngle, false);
              pushScenePath(svgArcPath(centerPoint.x, centerPoint.y, radiusPx, arcAngles.start + rotationAngle, arcAngles.end + rotationAngle), BRANCH_COLOR, branchStrokeScale);
            } else {
              ctx.moveTo(start.x, start.y);
              ctx.lineTo(end.x, end.y);
              pushSceneLine(start.x, start.y, end.x, end.y, BRANCH_COLOR, branchStrokeScale);
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
            ctx.moveTo(startX, startY);
            ctx.arc(centerPoint.x, centerPoint.y, radiusPx, arcAngles.start + rotationAngle, arcAngles.end + rotationAngle, false);
            pushScenePath(svgArcPath(centerPoint.x, centerPoint.y, radiusPx, arcAngles.start + rotationAngle, arcAngles.end + rotationAngle), BRANCH_COLOR, branchStrokeScale);
          }
          for (let node = 0; node < tree.nodeCount; node += 1) {
            if (hiddenNodes[node]) {
              continue;
            }
            const parent = tree.buffers.parent[node];
            if (parent < 0) {
              continue;
            }
            const theta = thetaFor(layout.center, node, tree.leafCount);
            const startWorld = polarToCartesian(tree.buffers.depth[parent], theta);
            const endWorld = polarToCartesian(tree.buffers.depth[node], theta);
            const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
            const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
            if (!lineIntersectsRect(start.x, start.y, end.x, end.y, 0, 0, size.width, size.height)) {
              continue;
            }
            if (useDenseCircularLOD) {
              const key = quantizedSegmentKey(start.x, start.y, end.x, end.y);
              if (circularStemKeys?.has(key)) {
                continue;
              }
              circularStemKeys?.add(key);
            }
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            pushSceneLine(start.x, start.y, end.x, end.y, BRANCH_COLOR, branchStrokeScale);
          }
        }
        ctx.stroke();
      } else {
        const colorStemPaths = new Map<string, Array<[number, number, number, number]>>();
        const colorArcPaths = new Map<string, Array<{ radiusPx: number; start: number; end: number }>>();
        const pushStem = (color: string, x1: number, y1: number, x2: number, y2: number): void => {
          const segments = colorStemPaths.get(color) ?? [];
          segments.push([x1, y1, x2, y2]);
          colorStemPaths.set(color, segments);
          pushSceneLine(x1, y1, x2, y2, color, 1.2 * branchStrokeScale, 0.95);
        };
        const pushArc = (color: string, radiusPx: number, start: number, end: number): void => {
          if (radiusPx < 0.25 || end <= start) {
            return;
          }
          const arcs = colorArcPaths.get(color) ?? [];
          arcs.push({ radiusPx, start, end });
          colorArcPaths.set(color, arcs);
          pushScenePath(svgArcPath(centerPoint.x, centerPoint.y, radiusPx, start, end), color, 1.2 * branchStrokeScale, undefined, 0.95);
        };
        if (visibleCircularSegments) {
          const drawnConnectorNodes = new Set<number>();
          for (let index = 0; index < visibleCircularSegments.length; index += 1) {
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
              const radiusPx = tree.buffers.depth[node] * camera.scale;
              if (radiusPx < 0.25) {
                continue;
              }
              const ownerTheta = thetaFor(layout.center, node, tree.leafCount);
              const ownerArcStart = thetaFor(layout.min, node, tree.leafCount);
              const ownerArcEnd = thetaFor(layout.max, node, tree.leafCount);
              const ownerArcLength = Math.max(0, ownerArcEnd - ownerArcStart);
              for (let childIndex = 0; childIndex < ordered.length; childIndex += 1) {
                const child = ordered[childIndex];
                if (hiddenNodes[child]) {
                  continue;
                }
                const color = effectiveBranchColors?.[child] ?? BRANCH_COLOR;
                const childTheta = thetaFor(layout.center, child, tree.leafCount);
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
          for (let node = 0; node < tree.nodeCount; node += 1) {
            if (hiddenNodes[node]) {
              continue;
            }
            const parent = tree.buffers.parent[node];
            if (parent < 0) {
              if (!collapsedNodes.has(node) && children[node].length >= 2) {
                const startTheta = thetaFor(layout.center, children[node][0], tree.leafCount);
                const endTheta = thetaFor(layout.center, children[node][children[node].length - 1], tree.leafCount);
                const arcStart = thetaFor(layout.min, node, tree.leafCount);
                const arcEnd = thetaFor(layout.max, node, tree.leafCount);
                const arcLength = Math.max(0, arcEnd - arcStart);
                const arcAngles = arcAnglesWithinSpan(startTheta, endTheta, arcStart, arcLength);
                const radiusPx = tree.buffers.depth[node] * camera.scale;
                pushArc(BRANCH_COLOR, radiusPx, arcAngles.start + rotationAngle, arcAngles.end + rotationAngle);
              }
              continue;
            }
            const color = effectiveBranchColors?.[node] ?? BRANCH_COLOR;
            const theta = thetaFor(layout.center, node, tree.leafCount);
            const startWorld = polarToCartesian(tree.buffers.depth[parent], theta);
            const endWorld = polarToCartesian(tree.buffers.depth[node], theta);
            const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
            const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
            if (lineIntersectsRect(start.x, start.y, end.x, end.y, 0, 0, size.width, size.height)) {
              pushStem(color, start.x, start.y, end.x, end.y);
            }
          }
        }
        colorArcPaths.forEach((arcs, color) => {
          ctx.beginPath();
          for (let index = 0; index < arcs.length; index += 1) {
            const arc = arcs[index];
            ctx.moveTo(
              centerPoint.x + Math.cos(arc.start) * arc.radiusPx,
              centerPoint.y + Math.sin(arc.start) * arc.radiusPx,
            );
            ctx.arc(centerPoint.x, centerPoint.y, arc.radiusPx, arc.start, arc.end, false);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2 * branchStrokeScale;
          ctx.globalAlpha = 0.95;
          ctx.stroke();
        });
        colorStemPaths.forEach((segments, color) => {
          ctx.beginPath();
          for (let index = 0; index < segments.length; index += 1) {
            const [x1, y1, x2, y2] = segments[index];
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2 * branchStrokeScale;
          ctx.globalAlpha = 0.95;
          ctx.stroke();
        });
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
            const theta = thetaFor(layout.center, node, tree.leafCount);
            const x = tree.buffers.depth[node];
            if (parent >= 0) {
              const startWorld = polarToCartesian(tree.buffers.depth[parent], theta);
              const endWorld = polarToCartesian(x, theta);
              const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
              const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
              if (lineIntersectsRect(start.x, start.y, end.x, end.y, 0, 0, size.width, size.height)) {
                ctx.moveTo(start.x, start.y);
                ctx.lineTo(end.x, end.y);
              }
            }
            if (children[node].length >= 2) {
              const startTheta = thetaFor(layout.center, children[node][0], tree.leafCount);
              const endTheta = thetaFor(layout.center, children[node][children[node].length - 1], tree.leafCount);
              const arcStart = thetaFor(layout.min, node, tree.leafCount);
              const arcEnd = thetaFor(layout.max, node, tree.leafCount);
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
                point.x >= -24 && point.x <= size.width + 24 &&
                point.y >= -24 && point.y <= size.height + 24
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

      if (hoverRef.current) {
        const hover = hoverRef.current;
        const parent = tree.buffers.parent[hover.node];
        if (parent >= 0) {
          ctx.strokeStyle = HOVER_COLOR;
          ctx.lineWidth = 2;
          ctx.beginPath();
          const childTheta = thetaFor(layout.center, hover.node, tree.leafCount);
          if (hover.targetKind === "connector" && hover.ownerNode !== undefined) {
            const ownerTheta = thetaFor(layout.center, hover.ownerNode, tree.leafCount);
            const ownerArcStart = thetaFor(layout.min, hover.ownerNode, tree.leafCount);
            const ownerArcEnd = thetaFor(layout.max, hover.ownerNode, tree.leafCount);
            const ownerArcLength = Math.max(0, ownerArcEnd - ownerArcStart);
            const arcSpan = arcSubspanWithinSpan(ownerTheta, childTheta, ownerArcStart, ownerArcLength);
            const radiusPx = tree.buffers.depth[hover.ownerNode] * camera.scale;
            const connectorSpanPx = (arcSpan?.length ?? 0) * radiusPx;
            if (arcSpan && radiusPx >= 0.25 && connectorSpanPx >= 1) {
              ctx.moveTo(
                centerPoint.x + Math.cos(arcSpan.start + rotationAngle) * radiusPx,
                centerPoint.y + Math.sin(arcSpan.start + rotationAngle) * radiusPx,
              );
              ctx.arc(centerPoint.x, centerPoint.y, radiusPx, arcSpan.start + rotationAngle, arcSpan.end + rotationAngle, false);
            }
            const startWorld = polarToCartesian(tree.buffers.depth[hover.ownerNode], childTheta);
            const endWorld = polarToCartesian(tree.buffers.depth[hover.node], childTheta);
            const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
            const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
          } else {
            const parentTheta = thetaFor(layout.center, parent, tree.leafCount);
            if (Math.abs(childTheta - parentTheta) > 1e-6) {
              const arcStart = thetaFor(layout.min, parent, tree.leafCount);
              const arcEnd = thetaFor(layout.max, parent, tree.leafCount);
              const arcLength = Math.max(0, arcEnd - arcStart);
              const arcSpan = arcSubspanWithinSpan(parentTheta, childTheta, arcStart, arcLength);
              const radiusPx = tree.buffers.depth[parent] * camera.scale;
              const connectorSpanPx = (arcSpan?.length ?? 0) * radiusPx;
              if (arcSpan && radiusPx >= 0.25 && connectorSpanPx >= 1) {
                ctx.moveTo(
                  centerPoint.x + Math.cos(arcSpan.start + rotationAngle) * radiusPx,
                  centerPoint.y + Math.sin(arcSpan.start + rotationAngle) * radiusPx,
                );
                ctx.arc(centerPoint.x, centerPoint.y, radiusPx, arcSpan.start + rotationAngle, arcSpan.end + rotationAngle, false);
              }
            }
            const startWorld = polarToCartesian(tree.buffers.depth[parent], childTheta);
            const endWorld = polarToCartesian(tree.buffers.depth[hover.node], childTheta);
            const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
            const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
          }
          ctx.stroke();
        }
      }

      const tipLabelCueVisible = angularSpacingPx > 1.6;
      const microTipLabelsVisible = angularSpacingPx > 2.9;
      const tipLabelsVisible = angularSpacingPx > 4.5;
      const tipFontSize = scaleLabelFontSize("tip", Math.max(6.5, Math.min(20, angularSpacingPx * 0.74)));
      const microTipFontSize = scaleLabelFontSize("tip", Math.max(4.2, Math.min(6.1, angularSpacingPx * 0.3)));
      const readableBandProgress = smoothstep01((angularSpacingPx - 2.9) / Math.max(1e-6, 4.5 - 2.9));
      const tipBandFontSize = angularSpacingPx <= 2.9
        ? 0
        : microTipFontSize + ((tipFontSize - microTipFontSize) * readableBandProgress);
      const microBandWidthPx = estimateLabelWidth(Math.max(microTipFontSize, 4.2), reservedTipLabelCharacters);
      const readableBandWidthPx = estimateLabelWidth(Math.max(tipFontSize, 6.5), reservedTipLabelCharacters);
      const globalTipLabelSpacePx = interpolateTipBandWidthPx(
        angularSpacingPx,
        1.6,
        2.9,
        4.5,
        microBandWidthPx,
        readableBandWidthPx,
      );
      const tipLabelRadius = maxRadius + (20 / camera.scale);
      const cueTipLabelRadius = maxRadius + (8 / camera.scale);
      const tipBandAnchorRadius = microTipLabelsVisible || tipLabelsVisible ? tipLabelRadius : cueTipLabelRadius;
      const circularTipVisibilityMargin = 140;
      const needsVisibleLeafRanges = tipLabelCueVisible || (taxonomyEnabled && taxonomyBlocks !== null && !lockTaxonomyLabelsToClade);
      const visibleLeafOverscan = needsVisibleLeafRanges
        ? Math.max(12, Math.min(1600, Math.ceil((circularTipVisibilityMargin + 120) / Math.max(0.5, angularSpacingPx))))
        : 0;
      const leafVisibilityRadiusPx = needsVisibleLeafRanges
        ? Math.max(maxRadius * camera.scale, tipBandAnchorRadius * camera.scale * 0.82)
        : 0;
      const visibleAngleSpans = needsVisibleLeafRanges
        ? computeVisibleCircularAngleSpans(
          centerPoint.x,
          centerPoint.y,
          leafVisibilityRadiusPx,
          size.width,
          size.height,
          circularTipVisibilityMargin + 80,
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
        )
        : [];
      timing.circularVisibilityPrepMs += performance.now() - circularVisibilityPrepStartTime;
      let circularVisibleTipLabels: Array<{ node: number; theta: number; x: number; y: number; text: string; width: number }> = [];
      let maxVisibleTipLabelWidth = 0;
      if (tipLabelCueVisible) {
        ctx.font = fontSpec("tip", tipFontSize);
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        const labelAnchorRadius = microTipLabelsVisible ? tipLabelRadius : cueTipLabelRadius;
        for (let rangeIndex = 0; rangeIndex < visibleLeafRanges.length; rangeIndex += 1) {
          const range = visibleLeafRanges[rangeIndex];
          for (let index = range.startIndex; index < range.endIndex; index += 1) {
            const node = orderedLeaves[index];
            if (hiddenNodes[node]) {
              continue;
            }
            const theta = thetaFor(layout.center, node, tree.leafCount);
            const point = polarToCartesian(labelAnchorRadius, theta);
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
      }
      let circularGenusLabels: ScreenLabel[] = [];
      let circularGenusArcs: Array<
        | { mode: "stroke"; lineRadiusPx: number; lineWidthPx: number; startTheta: number; endTheta: number; color: string }
        | { mode: "ribbon"; lineRadiusPx: number; lineWidthPx: number; startTheta: number; endTheta: number; innerRadiusPx: number; outerRadiusPx: number; points: Array<{ x: number; y: number }>; color: string }
        | { mode: "band"; innerRadiusPx: number; outerRadiusPx: number; startTheta: number; endTheta: number; color: string }
      > = [];
      let circularGenusBaseFontSize = 0;
      const circularTaxonomyOverlayStartTime = performance.now();
      if (taxonomyEnabled && taxonomyBlocks) {
        const visibleRanks = visibleTaxonomyRanks;
        const baseFontSize = Math.max(8.5, Math.min(18, 8.5 + (angularSpacingPx * 0.45)));
        circularGenusBaseFontSize = baseFontSize;
        const taxonomyMetricBaseSize = Math.max(8.5, Math.min(18, 8.5 + (angularSpacingPx * 0.45)));
        const metrics = taxonomyRingMetricsPx(visibleRanks.length, taxonomyMetricBaseSize, taxonomyBandThicknessScale);
        const tipBandOuterRadiusPx = (maxRadius * camera.scale) + globalTipLabelSpacePx;
        const viewportCenterRenderedTheta = wrapPositive(Math.atan2((size.height * 0.5) - centerPoint.y, (size.width * 0.5) - centerPoint.x));
        let ringCursorOuterPx = tipBandOuterRadiusPx + 18;
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
        const preservedKeys = previousTaxonomyState
          && previousTaxonomyState.tree === tree
          && previousTaxonomyState.viewMode === "circular"
          && previousTaxonomyState.order === order
          && camera.scale > previousTaxonomyState.zoom + 1e-6
          ? previousTaxonomyState.peakVisibleKeys
          : [];
        const preservedKeySet = new Set(preservedKeys);
        const connectorArcs: Array<
          { mode: "ribbon"; lineRadiusPx: number; lineWidthPx: number; startTheta: number; endTheta: number; innerRadiusPx: number; outerRadiusPx: number; points: Array<{ x: number; y: number }>; color: string }
        > = [];
        for (let rankIndex = 0; rankIndex < visibleRanks.length; rankIndex += 1) {
          const rank = visibleRanks[rankIndex];
          const rankKeyPrefix = `${rank}:`;
          const blocksForRank: TaxonomyBlock[] = taxonomyBlocks[order][rank];
          const blockByKey = new Map<string, TaxonomyBlock>();
          for (let blockIndex = 0; blockIndex < blocksForRank.length; blockIndex += 1) {
            blockByKey.set(`${rank}:${blocksForRank[blockIndex].label}:${blocksForRank[blockIndex].centerNode}`, blocksForRank[blockIndex]);
          }
          const orderedBlocks: TaxonomyBlock[] = [];
          for (let preservedIndex = 0; preservedIndex < preservedKeys.length; preservedIndex += 1) {
            const key = preservedKeys[preservedIndex];
            if (!key.startsWith(rankKeyPrefix)) {
              continue;
            }
            const preservedBlock = blockByKey.get(key);
            if (preservedBlock) {
              orderedBlocks.push(preservedBlock);
              blockByKey.delete(key);
            }
          }
          orderedBlocks.push(...blockByKey.values());
          orderedBlocks.sort((left, right) => {
            const leftTips = (left.segments ?? []).reduce((total, segment) => {
              const end = segment.endIndex >= segment.startIndex ? segment.endIndex : segment.endIndex + tree.leafCount;
              return total + Math.max(0, end - segment.startIndex);
            }, 0);
            const rightTips = (right.segments ?? []).reduce((total, segment) => {
              const end = segment.endIndex >= segment.startIndex ? segment.endIndex : segment.endIndex + tree.leafCount;
              return total + Math.max(0, end - segment.startIndex);
            }, 0);
            if (rightTips !== leftTips) {
              return rightTips - leftTips;
            }
            return (left.startIndex ?? 0) - (right.startIndex ?? 0);
          });
          const ringWidthPx = metrics.ringWidthsPx[rankIndex];
          const ringInnerPx = ringCursorOuterPx;
          ringCursorOuterPx += ringWidthPx;
          const lineRadiusPx = ringInnerPx + (ringWidthPx * 0.5);
          const lineRadius = lineRadiusPx / camera.scale;
          const ringVisibleSpans = computeVisibleCircularAngleSpans(
            centerPoint.x,
            centerPoint.y,
            lineRadiusPx,
            size.width,
            size.height,
            120,
          );
          const occupiedIntervalsForRank: Array<{ start: number; end: number }> = [];
          for (let blockIndex = 0; blockIndex < orderedBlocks.length; blockIndex += 1) {
            const block = orderedBlocks[blockIndex];
            if (hiddenNodes[block.centerNode]) {
              continue;
            }
            const blockKey = `${rank}:${block.label}`;
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
            const totalTipCount = blockSegments.reduce((total, segment) => {
              const start = segment.startIndex;
              const end = segment.endIndex >= start ? segment.endIndex : segment.endIndex + tree.leafCount;
              return total + Math.max(0, end - start);
            }, 0);
            for (let segmentIndex = 0; segmentIndex < blockSegments.length; segmentIndex += 1) {
              const segment = blockSegments[segmentIndex];
              const { startTheta, endTheta } = thetaSpanForLeafRange(tree.leafCount, segment.startIndex, segment.endIndex);
              const renderedWrappedStart = wrapPositive(startTheta + rotationAngle);
              const renderedWrappedEnd = wrapPositive(endTheta + rotationAngle);
              const visibleSpan = bestVisibleTaxonomyLabelSpan(renderedWrappedStart, renderedWrappedEnd, ringVisibleSpans);
              const candidateStart = visibleSpan?.start ?? renderedWrappedStart;
              const candidateEnd = visibleSpan?.end ?? renderedWrappedEnd;
              const candidateArcLengthPx = ((candidateEnd >= candidateStart ? candidateEnd - candidateStart : (candidateEnd + (Math.PI * 2)) - candidateStart)) * lineRadiusPx;
              if (candidateArcLengthPx >= 0.8) {
                const angularGapPx = candidateArcLengthPx < 8
                  ? 0
                  : Math.max(0.2, Math.min(2.2, Math.min(candidateArcLengthPx * 0.04, ringWidthPx * 0.08)));
                const gapTheta = Math.min(
                  ((angularGapPx / Math.max(lineRadiusPx, 1e-6)) * 0.5),
                  Math.max(0, (endTheta - startTheta) * 0.26),
                );
                const insetStartTheta = startTheta + gapTheta;
                const insetEndTheta = endTheta - gapTheta;
                if (insetEndTheta <= insetStartTheta) {
                  continue;
                }
                const lineWidthPx = ringWidthPx * 0.92;
                const drawStartTheta = insetStartTheta + rotationAngle;
                const drawEndTheta = insetEndTheta + rotationAngle;
                const innerRadiusPx = lineRadiusPx - (lineWidthPx * 0.5);
                const outerRadiusPx = lineRadiusPx + (lineWidthPx * 0.5);
                if (includeDetailedTaxonomyDebug) {
                  arcKeys.push(`${rank}:${block.label}:${segment.startIndex}:${segment.endIndex}`);
                }
                connectorArcs.push({
                  mode: "ribbon",
                  lineRadiusPx,
                  lineWidthPx,
                  startTheta: insetStartTheta,
                  endTheta: insetEndTheta,
                  innerRadiusPx,
                  outerRadiusPx,
                  points: buildCircularRibbonPoints(
                    centerPoint.x,
                    centerPoint.y,
                    innerRadiusPx,
                    outerRadiusPx,
                    drawStartTheta,
                    drawEndTheta,
                  ),
                  color: block.color,
                });
                pushScenePath(
                  svgPolygonPath(buildCircularRibbonPoints(
                    centerPoint.x,
                    centerPoint.y,
                    innerRadiusPx,
                    outerRadiusPx,
                    drawStartTheta,
                    drawEndTheta,
                  )),
                  undefined,
                  undefined,
                  block.color,
                  CIRCULAR_TAXONOMY_OVERLAY_ALPHA,
                );
              }
            }
            let bestLabelCandidate: {
              theta: number;
              visibleStart: number;
              visibleEnd: number;
              arcLengthPx: number;
              spanTheta: number;
            } | null = null;
            const primaryLabelSegment = {
              firstNode: orderedLeaves[block.labelStartIndex ?? block.startIndex ?? blockSegments[0].startIndex],
              lastNode: orderedLeaves[((block.labelEndIndex ?? block.endIndex ?? blockSegments[0].endIndex) - 1 + orderedLeaves.length) % orderedLeaves.length],
              startIndex: block.labelStartIndex ?? block.startIndex ?? blockSegments[0].startIndex,
              endIndex: block.labelEndIndex ?? block.endIndex ?? blockSegments[0].endIndex,
            };
            const taxonomyTaxId = taxonomyTaxIdsByRank.get(rank)?.get(block.label) ?? null;
            const labelSegments = [primaryLabelSegment];
            for (let segmentIndex = 0; segmentIndex < labelSegments.length; segmentIndex += 1) {
              const segment = labelSegments[segmentIndex];
              const { startTheta, endTheta } = thetaSpanForLeafRange(tree.leafCount, segment.startIndex, segment.endIndex);
              let renderStartTheta = startTheta;
              let renderEndTheta = endTheta;
              if (renderEndTheta < renderStartTheta) {
                renderEndTheta += Math.PI * 2;
              }
              const renderedWrappedStart = wrapPositive(renderStartTheta + rotationAngle);
              const renderedWrappedEnd = wrapPositive(renderEndTheta + rotationAngle);
              const visibleSpans = lockTaxonomyLabelsToClade
                ? []
                : visibleTaxonomyLabelSpans(renderedWrappedStart, renderedWrappedEnd, ringVisibleSpans);
              const fallbackViewportSpan = !lockTaxonomyLabelsToClade && blockSegments.length === 1
                && wrappedAngleWithinInterval(viewportCenterRenderedTheta, renderedWrappedStart, renderedWrappedEnd)
                ? ringVisibleSpans.reduce<{ start: number; end: number } | null>((best, span) => {
                  if (!best || (span.end - span.start) > (best.end - best.start)) {
                    return span;
                  }
                  return best;
                }, null)
                : null;
              const totalRenderedSpan = renderEndTheta - renderStartTheta;
              const totalMidTheta = renderStartTheta + (totalRenderedSpan * 0.5);
              const fullLabelPoint = worldToScreenCircular(
                camera,
                Math.cos(totalMidTheta) * lineRadius,
                Math.sin(totalMidTheta) * lineRadius,
              );
              const fullMidVisible = isScreenPointVisible(fullLabelPoint.x, fullLabelPoint.y, size.width, size.height, 24);
              if (fullMidVisible) {
                const candidateArcLengthPx = totalRenderedSpan * lineRadiusPx;
                if (!bestLabelCandidate || candidateArcLengthPx > bestLabelCandidate.arcLengthPx) {
                  bestLabelCandidate = {
                    theta: totalMidTheta,
                    visibleStart: renderedWrappedStart,
                    visibleEnd: renderedWrappedEnd >= renderedWrappedStart ? renderedWrappedEnd : renderedWrappedEnd + (Math.PI * 2),
                    arcLengthPx: candidateArcLengthPx,
                    spanTheta: totalRenderedSpan,
                  };
                }
              } else {
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
                  if (!isScreenPointVisible(candidatePoint.x, candidatePoint.y, size.width, size.height, 24)) {
                    continue;
                  }
                  const candidateArcLengthPx = candidateSpan * lineRadiusPx;
                  if (!bestLabelCandidate || candidateArcLengthPx > bestLabelCandidate.arcLengthPx) {
                    bestLabelCandidate = {
                      theta: renderedMidTheta - rotationAngle,
                      visibleStart: candidateStart,
                      visibleEnd: candidateEnd >= candidateStart ? candidateEnd : candidateEnd + (Math.PI * 2),
                      arcLengthPx: candidateArcLengthPx,
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
            if (totalTipCount <= 1) {
              pushTaxonomyCandidateDebug({
                rank,
                label: block.label,
                accepted: false,
                reason: "single-tip-block",
                arcLengthPx: bestLabelCandidate.arcLengthPx,
              });
              continue;
            }
            const minFontSize = rank === "genus"
              ? (isPreservedLabel ? 4.5 : 5.2)
              : rank === "family"
                ? (isPreservedLabel ? 5.5 : 6.2)
                : (isPreservedLabel ? 6 : 7.5);
            const paddingFraction = 0.12;
            const normalizedMetrics = measureNormalizedLabelMetrics(ctx, block.label, labelFontFamilies.taxonomy);
            let textMetrics = ctx.measureText(block.label);
            const widthAtOnePx = normalizedMetrics.widthAtOnePx;
            const heightAtOnePx = normalizedMetrics.heightAtOnePx;
            const availableArcPx = Math.max(0, bestLabelCandidate.arcLengthPx * (1 - paddingFraction));
            const availableRadialPx = Math.max(0, ringWidthPx * (1 - paddingFraction));
            const curvatureCoeff = (widthAtOnePx * widthAtOnePx) / Math.max(8 * lineRadiusPx, 1e-6);
            const radialFontLimit = curvatureCoeff > 1e-9
              ? Math.max(0, (-heightAtOnePx + Math.sqrt(Math.max(
                0,
                (heightAtOnePx * heightAtOnePx) + (4 * curvatureCoeff * availableRadialPx),
              ))) / (2 * curvatureCoeff))
              : (availableRadialPx / heightAtOnePx);
            const fitFontSize = Math.min(30, Math.min(
              availableArcPx / widthAtOnePx,
              radialFontLimit,
            ) * 0.94);
            if (!Number.isFinite(fitFontSize) || fitFontSize < minFontSize) {
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
            const labelPointVisible = isScreenPointVisible(labelPoint.x, labelPoint.y, size.width, size.height, 18);
            if (!labelPointVisible) {
              pushTaxonomyCandidateDebug({
                rank,
                label: block.label,
                accepted: false,
                reason: "offscreen",
                arcLengthPx: bestLabelCandidate.arcLengthPx,
                fontSize: fitFontSize,
                x: labelPoint.x,
                y: labelPoint.y,
              });
              continue;
            }
            const rotationRadians = rotation * Math.PI / 180;
            let low = minFontSize;
            let high = Math.min(30, fitFontSize);
            let bestFitFontSize = minFontSize;
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
              const viewportScale = viewportScaleForCenteredRotatedLabel(
                labelPoint.x,
                labelPoint.y,
                candidateMetrics.width,
                candidateRadialHeightPx,
                rotationRadians,
                size.width,
                size.height,
                2,
              );
              const fits = candidateMetrics.width <= (availableArcPx + 0.5)
                && (candidateRadialHeightPx + candidateCurvaturePenaltyPx) <= (availableRadialPx + overflowTolerancePx)
                && viewportScale >= 0.999;
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
            if (!(bestFitFontSize >= minFontSize)) {
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
            const finalFontSize = Math.max(3.5, Math.max(minFontSize, bestFitFontSize * 0.92) * taxonomyLabelSizeScale);
            ctx.font = `${finalFontSize}px ${labelFontFamilies.taxonomy}`;
            textMetrics = ctx.measureText(block.label);
            const ascent = textMetrics.actualBoundingBoxAscent || (finalFontSize * 0.72);
            const descent = textMetrics.actualBoundingBoxDescent || (finalFontSize * 0.28);
            const radialTextOffsetPx = ((ascent - descent) * 0.5)
              + ((Math.sin(bestLabelCandidate.theta) >= 0 ? -1 : 1) * Math.max(0.5, ringWidthPx * 0.04));
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
              rotation: rotationRadians,
              align: "center",
              color: taxonomyTextColor(block.color),
              searchHighlightColor,
              searchMatchRange,
              taxId: taxonomyTaxId,
              firstNode: primaryLabelSegment.firstNode,
              lastNode: primaryLabelSegment.lastNode,
              taxonomyTipCount: totalTipCount,
              offsetY: radialTextOffsetPx,
              clipArc: {
                innerRadiusPx: ringInnerPx,
                outerRadiusPx: ringInnerPx + ringWidthPx,
                startTheta: bestLabelCandidate.visibleStart - rotationAngle,
                endTheta: bestLabelCandidate.visibleEnd - rotationAngle,
                // Extremely narrow wedges at huge radii become numerically unstable in canvas clip().
                // In that regime the text is visually near-linear anyway, so keep the in-arc placement
                // but skip clipping to avoid the label being erased entirely.
                skipClip: bestLabelCandidate.spanTheta < 0.0012,
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
          genusLineRadiusPx: connectorArcs[0]?.lineRadiusPx ?? null,
          visibleLeafRanges: visibleLeafRanges.map((range) => [range.startIndex, range.endIndex]),
          taxonomyVisibleRanks: visibleRanks,
          taxonomyArcCount: connectorArcs.length,
          taxonomyPlacedLabelCount: allTaxonomyLabels.length,
          taxonomyBlockCounts: Object.fromEntries(
            TAXONOMY_RANKS.map((rank) => [rank, taxonomyBlocks[order][rank]?.length ?? 0]),
          ),
          taxonomyOverlayAlpha: CIRCULAR_TAXONOMY_OVERLAY_ALPHA,
          taxonomyTipBandOuterRadiusPx: tipBandOuterRadiusPx,
          taxonomyFirstRingInnerRadiusPx: connectorArcs.length > 0
            ? connectorArcs[0].lineRadiusPx - (connectorArcs[0].lineWidthPx * 0.5)
            : null,
          ...(includeDetailedTaxonomyDebug
            ? {
              taxonomyArcKeys: arcKeys,
              taxonomyArcDebug: connectorArcs.map((arc, index) => ({
                key: arcKeys[index] ?? null,
                mode: arc.mode,
                startTheta: arc.startTheta,
                endTheta: arc.endTheta,
                lineWidthPx: arc.lineWidthPx,
                lineRadiusPx: arc.lineRadiusPx,
                innerRadiusPx: arc.innerRadiusPx,
                outerRadiusPx: arc.outerRadiusPx,
                spanTheta: arc.endTheta - arc.startTheta,
                spanPx: (arc.endTheta - arc.startTheta) * arc.lineRadiusPx,
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
          viewMode: "circular",
          order,
          zoom: camera.scale,
          visibleCenters: [],
          peakZoom: camera.scale,
          peakVisibleCenters: [],
        };
        taxonomyLabelHistoryRef.current = {
          tree,
          viewMode: "circular",
          order,
          zoom: camera.scale,
          visibleKeys: placedKeys,
          peakZoom: previousTaxonomyState && previousTaxonomyState.tree === tree && previousTaxonomyState.viewMode === "circular" && previousTaxonomyState.order === order
            ? Math.max(previousTaxonomyState.peakZoom, camera.scale)
            : camera.scale,
          peakVisibleKeys: previousTaxonomyState && previousTaxonomyState.tree === tree && previousTaxonomyState.viewMode === "circular" && previousTaxonomyState.order === order && camera.scale > previousTaxonomyState.zoom + 1e-6
            ? Array.from(new Set([...previousTaxonomyState.peakVisibleKeys, ...placedKeys]))
            : placedKeys,
        };
      } else if (!taxonomyEnabled && showGenusLabels) {
        const priorityBlocks = cache.genusBlocksPriority[order];
        const positionalBlocks = cache.genusBlocks[order];
        const previousGenusState = genusLabelHistoryRef.current;
        const preservedCenters = previousGenusState
          && previousGenusState.tree === tree
          && previousGenusState.viewMode === "circular"
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
          Math.ceil((Math.PI * Math.min(size.width, size.height)) / 34),
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
          const startTheta = thetaFor(layout.center, block.firstNode, tree.leafCount);
          const endTheta = thetaFor(layout.center, block.lastNode, tree.leafCount);
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
            size.width,
            size.height,
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
            pushScenePath(svgArcPath(centerPoint.x, centerPoint.y, lineRadiusPx, renderStartTheta + rotationAngle, renderEndTheta + rotationAngle), arcColor, 1.1, undefined, CIRCULAR_TAXONOMY_OVERLAY_ALPHA);
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
            labelPoint.x < -160 || labelPoint.x > size.width + 160 ||
            labelPoint.y < -160 || labelPoint.y > size.height + 160
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
          viewMode: "circular",
          order,
          zoom: camera.scale,
          visibleCenters: [...placedCenters],
          peakZoom: previousGenusState
            && previousGenusState.tree === tree
            && previousGenusState.viewMode === "circular"
            && previousGenusState.order === order
            && camera.scale < previousGenusState.peakZoom
            ? previousGenusState.peakZoom
            : camera.scale,
          peakVisibleCenters: previousGenusState
            && previousGenusState.tree === tree
            && previousGenusState.viewMode === "circular"
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
          viewMode: "circular",
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
          ctx.globalAlpha = CIRCULAR_TAXONOMY_OVERLAY_ALPHA;
          if (arc.mode === "ribbon") {
            ctx.beginPath();
            ctx.moveTo(arc.points[0].x, arc.points[0].y);
            for (let pointIndex = 1; pointIndex < arc.points.length; pointIndex += 1) {
              ctx.lineTo(arc.points[pointIndex].x, arc.points[pointIndex].y);
            }
            ctx.closePath();
            ctx.fillStyle = arc.color;
            ctx.fill();
          } else if (arc.mode === "band") {
            ctx.beginPath();
            ctx.arc(centerPoint.x, centerPoint.y, arc.outerRadiusPx, arc.startTheta + rotationAngle, arc.endTheta + rotationAngle, false);
            ctx.arc(centerPoint.x, centerPoint.y, arc.innerRadiusPx, arc.endTheta + rotationAngle, arc.startTheta + rotationAngle, true);
            ctx.closePath();
            ctx.fillStyle = arc.color;
            ctx.fill();
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
      if ((showInternalNodeLabels || showBootstrapLabels) && camera.scale > 6) {
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
          const labelClass: LabelStyleClass = isBootstrap ? "bootstrap" : "internalNode";
          const fontSize = scaleLabelFontSize(
            labelClass,
            isBootstrap ? Math.max(7, Math.min(10, camera.scale * 0.035)) : Math.max(8, Math.min(12, camera.scale * 0.04)),
          );
          const theta = thetaFor(layout.center, node, tree.leafCount);
          const renderedTheta = theta + rotationAngle;
          const radius = tree.buffers.depth[node] + (14 / camera.scale);
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
          if (labelX < -40 || labelX > size.width + 40 || labelY < -40 || labelY > size.height + 40) {
            continue;
          }
          if (!canPlaceLinearLabel(labels, labelX, labelY, fontSize * 1.8, fontSize * 4.8)) {
            continue;
          }
          const onRightSide = Math.cos(renderedTheta) >= 0;
          const rotation = normalizeRotation((renderedTheta * 180 / Math.PI) + (onRightSide ? 90 : 270)) * Math.PI / 180;
          labels.push({
            x: labelX,
            y: labelY,
            text: rawLabel,
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
        ctx.fillStyle = "#cbd5e1";
        ctx.strokeStyle = "#64748b";
        ctx.lineWidth = 1.1;
        for (let index = 0; index < visibleCollapsedNodes.length; index += 1) {
          const node = visibleCollapsedNodes[index];
          const parent = tree.buffers.parent[node];
          const apexTheta = thetaFor(layout.center, node, tree.leafCount);
          const startTheta = thetaFor(layout.min, node, tree.leafCount);
          const endTheta = thetaFor(layout.max, node, tree.leafCount);
          const apex = worldToScreenCircular(
            camera,
            Math.cos(apexTheta) * tree.buffers.depth[node],
            Math.sin(apexTheta) * tree.buffers.depth[node],
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
          labelHitsRef.current.push({
            node,
            kind: "rect",
            source: "collapse",
            x: hitMinX,
            y: hitMinY,
            width: hitMaxX - hitMinX,
            height: hitMaxY - hitMinY,
          });
          if (parent >= 0) {
            const edgeTheta = thetaFor(layout.center, node, tree.leafCount);
            const edgeStart = worldToScreenCircular(
              camera,
              Math.cos(edgeTheta) * tree.buffers.depth[parent],
              Math.sin(edgeTheta) * tree.buffers.depth[parent],
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
            x: label.x - (labelMetrics.width * 0.5),
            y: label.y - Math.max(10, (label.fontSize ?? circularGenusBaseFontSize) * 0.7),
            width: Math.max(20, labelMetrics.width),
            height: Math.max(20, (label.fontSize ?? circularGenusBaseFontSize) * 1.4),
          });
        }
      }
      timing.taxonomyOverlayMs += performance.now() - circularTaxonomyOverlayStartTime;

      if (showNodeHeightLabels && camera.scale > 4.5) {
        const fontSize = scaleLabelFontSize("nodeHeight", Math.max(8, Math.min(12, camera.scale * 0.045)));
        const labels: ScreenLabel[] = [];
        ctx.font = `${fontSize}px ${labelFontFamilies.nodeHeight}`;
        ctx.fillStyle = "#64748b";
        ctx.textBaseline = "middle";
        for (let node = 0; node < tree.nodeCount; node += 1) {
          if (tree.buffers.firstChild[node] < 0) {
            continue;
          }
          const parent = tree.buffers.parent[node];
          const theta = thetaFor(layout.center, node, tree.leafCount);
          const radius = tree.buffers.depth[node] + (10 / camera.scale);
          const point = polarToCartesian(radius, theta);
          const screen = worldToScreenCircular(camera, point.x, point.y);
          const subtreeSpanPx = Math.max(0, (layout.max[node] - layout.min[node])) * angularSpacingPx;
          const branchSpanPx = parent >= 0
            ? Math.max(0, (tree.buffers.depth[node] - tree.buffers.depth[parent]) * camera.scale)
            : 0;
          if (camera.scale <= 7 && subtreeSpanPx < 10 && branchSpanPx < 14) {
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
            labelX < -40 || labelX > size.width + 40 ||
            labelY < -40 || labelY > size.height + 40
          ) {
            continue;
          }
          if (!canPlaceLinearLabel(labels, labelX, labelY, fontSize * 2.1, fontSize * 5.5)) {
            continue;
          }
          const deg = (theta + rotationAngle) * 180 / Math.PI;
          const onRightSide = Math.cos(theta + rotationAngle) >= 0;
          labels.push({
            x: labelX,
            y: labelY,
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
          pushSceneText(label.text, label.x, label.y, "#64748b", fontSize, labelFontFamilies.nodeHeight, label.align === "right" ? "end" : "start", label.rotation ?? 0);
        }
        ctx.globalAlpha = 1;
      }

      if (metadataMarkerNodes.length > 0 && metadataMarkers && camera.scale > 4.5) {
        const maxVisibleMetadataMarkers = 1600;
        let visibleMarkers = 0;
        ctx.lineWidth = 1.1;
        for (let index = 0; index < metadataMarkerNodes.length; index += 1) {
          if (visibleMarkers >= maxVisibleMetadataMarkers) {
            break;
          }
          const node = metadataMarkerNodes[index];
          if (hiddenNodes[node]) {
            continue;
          }
          const marker = metadataMarkers[node];
          if (!marker) {
            continue;
          }
          const theta = thetaFor(layout.center, node, tree.leafCount);
          const screen = metadataCircularMarkerScreenPosition(tree, node, theta, camera, metadataMarkerSizePx);
          if (screen.x < -20 || screen.x > size.width + 20 || screen.y < -20 || screen.y > size.height + 20) {
            continue;
          }
          const markerX = screen.x;
          const markerY = screen.y;
          ctx.fillStyle = marker.color;
          ctx.strokeStyle = "rgba(255,255,255,0.92)";
          drawMetadataMarker(ctx, marker.shape, markerX, markerY, metadataMarkerSizePx);
          ctx.fill();
          ctx.stroke();
          pushScenePath(metadataMarkerPath(marker.shape, markerX, markerY, metadataMarkerSizePx), "rgba(255,255,255,0.92)", 1.1, marker.color, 1);
          visibleMarkers += 1;
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
          const theta = thetaFor(layout.center, node, tree.leafCount);
          const radius = tree.buffers.depth[node] + (12 / camera.scale);
          const point = polarToCartesian(radius, theta);
          const screen = worldToScreenCircular(camera, point.x, point.y);
          const labelX = screen.x + figureStyles.internalNode.offsetXPx + metadataLabelOffsetXPx;
          const labelY = screen.y - 10 + figureStyles.internalNode.offsetYPx + metadataLabelOffsetYPx;
          if (labelX < -40 || labelX > size.width + 40 || labelY < -40 || labelY > size.height + 40) {
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
        ctx.strokeStyle = ERROR_BAR_COLOR;
        ctx.lineWidth = errorBarThicknessPx;
        for (let node = 0; node < tree.nodeCount; node += 1) {
          if (tree.buffers.firstChild[node] < 0) {
            continue;
          }
          const lower = tree.nodeIntervalLower[node];
          const upper = tree.nodeIntervalUpper[node];
          if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
            continue;
          }
          const theta = thetaFor(layout.center, node, tree.leafCount);
          const startWorld = polarToCartesian(lower, theta);
          const endWorld = polarToCartesian(upper, theta);
          const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
          const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
          const midX = (start.x + end.x) * 0.5;
          const midY = (start.y + end.y) * 0.5;
          if (
            midX < -40 || midX > size.width + 40 ||
            midY < -40 || midY > size.height + 40
          ) {
            continue;
          }
          if (!canPlaceLinearLabel(placements, midX, midY, 12, 18)) {
            continue;
          }
          placements.push({ x: midX, y: midY, text: "", alpha: 1 });
          const tangentX = -Math.sin(theta + rotationAngle);
          const tangentY = Math.cos(theta + rotationAngle);
          ctx.globalAlpha = 0.82;
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
          pushSceneLine(start.x, start.y, end.x, end.y, ERROR_BAR_COLOR, errorBarThicknessPx, 0.82);
          if (halfCap > 0) {
            pushSceneLine(start.x - (tangentX * halfCap), start.y - (tangentY * halfCap), start.x + (tangentX * halfCap), start.y + (tangentY * halfCap), ERROR_BAR_COLOR, errorBarThicknessPx, 0.82);
            pushSceneLine(end.x - (tangentX * halfCap), end.y - (tangentY * halfCap), end.x + (tangentX * halfCap), end.y + (tangentY * halfCap), ERROR_BAR_COLOR, errorBarThicknessPx, 0.82);
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
          ctx.textAlign = showCircularCenterRadialScaleBar
            ? "center"
            : Math.cos(centerScaleTheta + rotationAngle) >= 0 ? "left" : "right";
          for (let index = 0; index < displayedCircularCenterScaleBoundaries.length; index += 1) {
            const boundary = displayedCircularCenterScaleBoundaries[index];
            const radius = tree.isUltrametric
              ? Math.max(0, stripeExtent - boundary.value) + (showCircularCenterRadialScaleBar ? 0 : (10 / camera.scale))
              : Math.max(0, boundary.value) + (showCircularCenterRadialScaleBar ? 0 : (10 / camera.scale));
            const point = polarToCartesian(radius, showCircularCenterRadialScaleBar ? centerScaleBarTheta : centerScaleTheta);
            const screen = worldToScreenCircular(camera, point.x, point.y);
            const labelX = showCircularCenterRadialScaleBar
              ? screen.x - (centerScaleBarTangentX * centerScaleLabelOffsetPx)
              : screen.x;
            const labelY = showCircularCenterRadialScaleBar
              ? screen.y - (centerScaleBarTangentY * centerScaleLabelOffsetPx)
              : screen.y;
            ctx.globalAlpha = 0.35 + (0.65 * boundary.alpha);
            if (showCircularCenterRadialScaleBar) {
              ctx.save();
              ctx.translate(labelX, labelY);
              ctx.rotate(rotatedLabelRadians);
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
              showCircularCenterRadialScaleBar ? "middle" : Math.cos(centerScaleTheta + rotationAngle) >= 0 ? "start" : "end",
              showCircularCenterRadialScaleBar ? rotatedLabelRadians : undefined,
              labelFontStyles.scale,
            );
          }
          if (showCircularCenterRadialScaleBar) {
            const startPoint = worldToScreenCircular(camera, 0, 0);
            const endWorld = polarToCartesian(stripeExtent, centerScaleBarTheta);
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
              const radius = tree.isUltrametric ? Math.max(0, stripeExtent - boundary.value) : Math.max(0, boundary.value);
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
            ctx.fillRect(0, Math.max(0, circularScaleBar.axisPosition - 12), size.width, size.height);
            pushSceneRect(0, Math.max(0, circularScaleBar.axisPosition - 12), size.width, size.height, "rgba(251,252,254,0.97)");
          } else {
            ctx.fillRect(0, 0, circularScaleBar.axisPosition + 16, size.height);
            pushSceneRect(0, 0, circularScaleBar.axisPosition + 16, size.height, "rgba(251,252,254,0.97)");
          }

          ctx.strokeStyle = "#6b7280";
          ctx.fillStyle = "#6b7280";
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (circularScaleBar.kind === "bottom") {
            ctx.moveTo(24, circularScaleBar.axisPosition);
            ctx.lineTo(size.width - 24, circularScaleBar.axisPosition);
            pushSceneLine(24, circularScaleBar.axisPosition, size.width - 24, circularScaleBar.axisPosition, "#6b7280", 1);
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
            ctx.lineTo(circularScaleBar.axisPosition, size.height - 24);
            pushSceneLine(circularScaleBar.axisPosition, 24, circularScaleBar.axisPosition, size.height - 24, "#6b7280", 1);
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
    renderDebugRef.current = renderDebug;
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
        branchRenderMode: typeof (renderDebug.circular as { branchRenderMode?: unknown } | undefined)?.branchRenderMode === "string"
          ? (renderDebug.circular as { branchRenderMode: string }).branchRenderMode
          : null,
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
    branchThicknessScale,
    cache,
    collapsedView,
    collapsedNodes,
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
    metadataBranchColorVersion,
    metadataLabelMaxCount,
    metadataLabelMinSpacingPx,
    metadataLabelNodes,
    metadataLabelOffsetXPx,
    metadataLabelOffsetYPx,
    metadataLabels,
    metadataMarkerNodes,
    metadataMarkerSizePx,
    metadataMarkers,
    order,
    reservedTipLabelCharacters,
    searchQuery,
    searchMatches,
    searchMatchSet,
    errorBarCapSizePx,
    errorBarThicknessPx,
    circularCenterScaleAngleDegrees,
    extendRectScaleToTick,
    scaleLabelFontSize,
    scaleTickInterval,
    showBootstrapLabels,
    showCircularCenterRadialScaleBar,
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
    timeStripeLineWeight,
    timeStripeStyle,
    taxonomyActiveRanks,
    taxonomyBlocks,
    taxonomyBranchColoringEnabled,
    taxonomyColors,
    taxonomyConsensus,
    taxonomyEnabled,
    taxonomyTipRanksByNode,
    tree,
    viewMode,
  ]);

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
      draw();
    });
  }, [draw]);

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
      cameraRef.current = convertCameraForViewMode(currentCamera);
      draw();
      return;
    }
    draw();
  }, [cache, convertCameraForViewMode, fitCamera, fitRequest, size, tree, viewMode]);

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
      const fit = fitCircularCamera(size.width, size.height, tree, circularRotation);
      const maxRadius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
      const tipScaleThreshold = (7.6 * Math.max(1, tree.leafCount)) / Math.max(1e-9, maxRadius * Math.PI * 2);
      const genusScaleThreshold = (3.4 * Math.max(1, tree.leafCount)) / Math.max(1e-9, maxRadius * Math.PI * 2);
      camera.scale = Math.max(
        camera.scale,
        focusTargetKind === "tip"
          ? Math.max(tipScaleThreshold, fit.scale * 4.6)
          : focusTargetKind === "genus"
            ? Math.max(genusScaleThreshold, fit.scale * 1.9)
            : Math.max(fit.scale * 2.7, genusScaleThreshold),
      );
      const theta = thetaFor(layout.center, targetNode, tree.leafCount);
      const point = polarToCartesian(tree.buffers.depth[targetNode], theta);
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
    order,
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
    if (viewMode === "circular") {
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
      const fit = fitCircularCamera(size.width, size.height, tree, circularRotation);
      const startTheta = thetaFor(layout.min, targetNode, tree.leafCount);
      let endTheta = thetaFor(layout.max, targetNode, tree.leafCount);
      if (endTheta < startTheta) {
        endTheta += Math.PI * 2;
      }
      const midTheta = startTheta + ((endTheta - startTheta) * 0.5);
      const angularSpan = Math.max((Math.PI * 2) / Math.max(1, tree.leafCount), endTheta - startTheta);
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
    focusNodeTarget,
    order,
    size.height,
    size.width,
    tree,
    onViewModeChange,
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
    if (!camera || camera.kind !== "circular") {
      return;
    }
    setCircularCameraRotation(camera, circularRotation);
    draw();
  }, [circularRotation, draw]);

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
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `big-tree-view-${viewMode}.svg`;
    link.click();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
  }, [buildCurrentSvgString, exportSvgRequest, viewMode]);

  useEffect(() => () => {
    if (frameRequestRef.current !== null) {
      window.cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tree || !cache) {
      return undefined;
    }
    const layout = collapsedView?.layout ?? tree.layouts[order];
    const children = cache.orderedChildren[order];
    const findLabelHitboxAt = (localX: number, localY: number): LabelHitbox | null => {
      for (let index = labelHitsRef.current.length - 1; index >= 0; index -= 1) {
        const hitbox = labelHitsRef.current[index];
        if (pointInLabelHitbox(localX, localY, hitbox)) {
          return hitbox;
        }
      }
      return null;
    };

    const hitTestAt = (localX: number, localY: number): CanvasHoverInfo | null => {
      const camera = cameraRef.current;
      if (!camera) {
        return null;
      }
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
        return {
          node,
          branchLength: tree.buffers.branchLength[node],
          parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
          parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
          childAge: tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[node]) : null,
          name: displayNodeName(tree, node),
          descendantTipCount: tree.buffers.leafCount[node],
          screenX,
          screenY,
          targetKind,
          hoveredSegment,
          ownerNode,
        };
      };

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
          const mrcaNode = lowestCommonAncestor(tree, hitbox.taxonomyFirstNode, hitbox.taxonomyLastNode);
          const parent = tree.buffers.parent[mrcaNode];
          const mrcaAge = tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[mrcaNode]) : null;
          hover = {
            node: mrcaNode,
            branchLength: tree.buffers.branchLength[mrcaNode],
            parentDepth: parent >= 0 ? tree.buffers.depth[parent] : 0,
            parentAge: parent >= 0 && tree.isUltrametric ? Math.max(0, tree.rootAge - tree.buffers.depth[parent]) : null,
            childAge: mrcaAge,
            descendantTipCount: hitbox.taxonomyTipCount ?? tree.buffers.leafCount[mrcaNode],
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

      if (camera.kind === "rect") {
        const world = screenToWorldRect(camera, localX, localY);
        const candidates = cache.rectIndices[order].queryPoint(world.x, world.y, 1, 1);
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
      } else {
        const world = screenToWorldCircular(camera, localX, localY);
        const radius = 6 / camera.scale;
        const candidates = cache.circularIndices[order].query(world.x, world.y, radius, radius);
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
              const ownerTheta = thetaFor(layout.center, ownerNode, tree.leafCount);
              const arcStart = thetaFor(layout.min, ownerNode, tree.leafCount);
              const arcEnd = thetaFor(layout.max, ownerNode, tree.leafCount);
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

    const updateHover = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const hover = hitTestAt(localX, localY);
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
        scheduleDraw();
      }
    };

    const zoomAtPoint = (localX: number, localY: number, zoom: number): void => {
      const camera = cameraRef.current;
      if (!camera) {
        return;
      }
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
        clampRectCamera(camera, tree, size.width, size.height, rectClampPadding(camera));
      } else {
        const world = screenToWorldCircular(camera, localX, localY);
        const fit = fitCircularCamera(size.width, size.height, tree, camera.rotation);
        const minScale = fit.scale * 0.55;
        camera.scale = Math.max(minScale, camera.scale * zoom);
        const rotated = rotateCircularWorldPoint(camera, world.x, world.y);
        camera.translateX = localX - (rotated.x * camera.scale);
        camera.translateY = localY - (rotated.y * camera.scale);
        finalizeCircularCamera(camera);
      }
    };

    const clearHoverState = (): void => {
      hoverRef.current = null;
      setOverlayHover(null);
      onHoverChange(null);
    };

    const handlePointerDown = (event: PointerEvent): void => {
      setContextMenu(null);
      clearLongPress();
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      for (let index = labelHitsRef.current.length - 1; index >= 0; index -= 1) {
        const hitbox = labelHitsRef.current[index];
        if (hitbox.source !== "collapse" || !pointInLabelHitbox(localX, localY, hitbox)) {
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
        const rect = canvas.getBoundingClientRect();
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
            clampCircularCamera(camera, tree, size.width, size.height, circularClampExtraRadiusPx(camera));
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
          clampCircularCamera(camera, tree, size.width, size.height, circularClampExtraRadiusPx(camera));
        }
        scheduleDraw();
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
      canvas.releasePointerCapture(event.pointerId);
    };

    const handlePointerLeave = (): void => {
      clearLongPress();
      activePointersRef.current.clear();
      pinchGestureRef.current = null;
      pointerDownRef.current = false;
      lastPointerRef.current = null;
      clearHoverState();
      scheduleDraw();
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
      const zoom = Math.exp(-event.deltaY * 0.0015);
      markPanBenchmarkInput();
      clearHoverState();
      zoomAtPoint(localX, localY, zoom);
      scheduleDraw();
    };

    const clearLongPress = (): void => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      longPressRef.current = null;
    };

    const showContextMenuAt = (localX: number, localY: number): void => {
      setContextMenuColorMode(null);
      const labelHitbox = findLabelHitboxAt(localX, localY);
      if (
        labelHitbox?.labelKind === "taxonomy"
        && labelHitbox.text
        && labelHitbox.taxonomyRank
        && typeof labelHitbox.taxonomyFirstNode === "number"
        && typeof labelHitbox.taxonomyLastNode === "number"
      ) {
        hoverRef.current = null;
        setOverlayHover(null);
        onHoverChange(null);
        setContextMenu({
          kind: "taxonomy",
          x: Math.min(size.width - 260, localX + 14),
          y: Math.min(size.height - 210, localY + 14),
          name: labelHitbox.text,
          rank: labelHitbox.taxonomyRank as TaxonomyRank,
          firstNode: labelHitbox.taxonomyFirstNode,
          lastNode: labelHitbox.taxonomyLastNode,
          descendantTipCount: labelHitbox.taxonomyTipCount ?? 0,
          taxId: labelHitbox.taxonomyTaxId ?? null,
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
      setOverlayHover(hover);
      onHoverChange(hover);
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
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      showContextMenuAt(localX, localY);
    };

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("contextmenu", handleContextMenu);
    const handleTouchMove = (event: TouchEvent): void => {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    };
    const preventGestureDefault = (event: Event): void => {
      event.preventDefault();
    };
    canvas.addEventListener("touchmove", handleTouchMove, { passive: false });
    canvas.addEventListener("gesturestart", preventGestureDefault);
    canvas.addEventListener("gesturechange", preventGestureDefault);

    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      canvas.removeEventListener("touchmove", handleTouchMove);
      canvas.removeEventListener("gesturestart", preventGestureDefault);
      canvas.removeEventListener("gesturechange", preventGestureDefault);
    };
  }, [
    cache,
    circularClampExtraRadiusPx,
    collapsedNodes,
    collapsedView,
    draw,
    markPanBenchmarkInput,
    onHoverChange,
    order,
    rectClampPadding,
    scheduleDraw,
    size.height,
    size.width,
    toggleCollapsedNode,
    tree,
    zoomAxisMode,
  ]);

  const handleContextZoomToSubtree = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "node") {
      return;
    }
    zoomToSubtreeTarget(contextMenu.node);
    setContextMenu(null);
  }, [contextMenu, zoomToSubtreeTarget]);

  const handleContextZoomToParentSubtree = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "node" || !tree) {
      return;
    }
    const parent = tree.buffers.parent[contextMenu.node];
    if (parent < 0) {
      return;
    }
    zoomToSubtreeTarget(parent);
    setContextMenu(null);
  }, [contextMenu, tree, zoomToSubtreeTarget]);

  const openSubtreeInNewTab = useCallback(async (node: number) => {
    if (typeof window === "undefined" || !tree) {
      return;
    }
    const key = `big-tree-viewer:subtree:${crypto.randomUUID()}`;
    const payload = buildSharedSubtreeStoragePayload(tree, node, taxonomyMap, taxonomyEnabled, {
      viewMode,
      order,
      zoomAxisMode,
      circularRotationDegrees: circularRotation,
      showTimeStripes,
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
      showGenusLabels,
      showInternalNodeLabels,
      showBootstrapLabels,
      showNodeHeightLabels,
      showNodeErrorBars,
      errorBarThicknessPx,
      errorBarCapSizePx,
      figureStyles,
      taxonomyEnabled,
      taxonomyBranchColoringEnabled,
      taxonomyColorJitter,
      branchThicknessScale,
    });
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
    errorBarCapSizePx,
    errorBarThicknessPx,
    extendRectScaleToTick,
    figureStyles,
    order,
    scaleTickInterval,
    showBootstrapLabels,
    showCircularCenterRadialScaleBar,
    showGenusLabels,
    showIntermediateScaleTicks,
    showInternalNodeLabels,
    showNodeErrorBars,
    showNodeHeightLabels,
    showScaleBars,
    showScaleZeroTick,
    showTimeStripes,
    taxonomyBranchColoringEnabled,
    taxonomyColorJitter,
    taxonomyEnabled,
    taxonomyMap,
    timeStripeLineWeight,
    timeStripeStyle,
    tree,
    useAutoCircularCenterScaleAngle,
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

  const handleContextToggleCollapse = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "node" || !tree || tree.buffers.firstChild[contextMenu.node] < 0) {
      return;
    }
    toggleCollapsedNode(contextMenu.node);
    setContextMenu(null);
  }, [contextMenu, toggleCollapsedNode, tree]);

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
    if (!contextMenu || contextMenu.kind !== "taxonomy") {
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

  const handleContextOpenTaxonomyInNcbi = useCallback(() => {
    if (!contextMenu || contextMenu.kind !== "taxonomy" || !contextMenu.taxId || typeof window === "undefined") {
      return;
    }
    window.open(`https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id=${contextMenu.taxId}`, "_blank", "noopener,noreferrer");
    setContextMenu(null);
  }, [contextMenu]);

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
      getCurrentBranchColors: () => {
        if (!tree) {
          return null;
        }
        const debug = renderDebugRef.current;
        const visibleRanks = (
          viewMode === "circular"
            ? (debug?.circular as { taxonomyVisibleRanks?: TaxonomyRank[] } | undefined)?.taxonomyVisibleRanks
            : (debug?.rect as { taxonomyVisibleRanks?: TaxonomyRank[] } | undefined)?.taxonomyVisibleRanks
        ) ?? [];
        return getEffectiveBranchColors(order, visibleRanks) ?? new Array<string>(tree.nodeCount).fill(BRANCH_COLOR);
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
      getLabelHitboxes: () => labelHitsRef.current.map((hitbox) => ({ ...hitbox })),
      buildSharedSubtreePayloadForTest: (node: number) => {
        if (!tree) {
          return null;
        }
        return buildSharedSubtreeStoragePayload(tree, node, taxonomyMap, taxonomyEnabled, {
          viewMode,
          order,
          zoomAxisMode,
          circularRotationDegrees: circularRotation,
          showTimeStripes,
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
          showGenusLabels,
          showInternalNodeLabels,
          showBootstrapLabels,
          showNodeHeightLabels,
          showNodeErrorBars,
          errorBarThicknessPx,
          errorBarCapSizePx,
          figureStyles,
          taxonomyEnabled,
          taxonomyBranchColoringEnabled,
          taxonomyColorJitter,
          branchThicknessScale,
        });
      },
      zoomToSubtreeTarget,
    };
    return () => {
      delete window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    };
  }, [
    draw,
    clearManualBranchColor,
    clearManualSubtreeColor,
    buildCurrentSvgString,
    fitCamera,
    getEffectiveBranchColors,
    order,
    branchThicknessScale,
    circularCenterScaleAngleDegrees,
    circularRotation,
    errorBarCapSizePx,
    errorBarThicknessPx,
    extendRectScaleToTick,
    figureStyles,
    rectClampPadding,
    scaleTickInterval,
    showBootstrapLabels,
    showCircularCenterRadialScaleBar,
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
    taxonomyBranchColoringEnabled,
    taxonomyColorJitter,
    taxonomyEnabled,
    taxonomyMap,
    tree,
    timeStripeLineWeight,
    timeStripeStyle,
    useAutoCircularCenterScaleAngle,
    viewMode,
    zoomAxisMode,
    zoomToSubtreeTarget,
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
      {overlayHover ? (
        <div
          className="hover-tooltip"
          style={{
            left: Math.min(size.width - 220, overlayHover.screenX + 16),
            top: Math.min(size.height - 90, overlayHover.screenY + 16),
          }}
        >
          <div className="hover-tooltip-label">{overlayHover.name}</div>
          {overlayHover.kind === "taxonomy" ? (
            <>
              <div>Rank: {overlayHover.taxonomyRank ?? "n/a"}</div>
              <div>Descendant tips: {overlayHover.descendantTipCount.toLocaleString()}</div>
              <div>
                MRCA age: {overlayHover.mrcaAge === null || overlayHover.mrcaAge === undefined ? "n/a" : overlayHover.mrcaAge.toPrecision(5)}
              </div>
            </>
          ) : (
            <>
              {tree && tree.buffers.firstChild[overlayHover.node] >= 0 ? (
                <div>Descendant tips: {overlayHover.descendantTipCount.toLocaleString()}</div>
              ) : null}
              <div>Branch: {overlayHover.branchLength.toPrecision(5)}</div>
              <div>
                Parent age: {overlayHover.parentAge === null ? "n/a" : overlayHover.parentAge.toPrecision(5)}
              </div>
              <div>
                Child age: {overlayHover.childAge === null ? "n/a" : overlayHover.childAge.toPrecision(5)}
              </div>
            </>
          )}
        </div>
      ) : null}
      {contextMenu ? (
        <div
          className="tree-context-menu"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="tree-context-menu-title">{contextMenu.name}</div>
          {contextMenu.kind === "node" ? (
            <>
              <div className="tree-context-menu-meta">
                Descendant tips: {contextMenu.descendantTipCount.toLocaleString()}
              </div>
              <button type="button" className="tree-context-menu-item" onClick={handleContextZoomToSubtree}>
                Zoom To Subtree
              </button>
              {tree && tree.buffers.parent[contextMenu.node] >= 0 ? (
                <button type="button" className="tree-context-menu-item" onClick={handleContextZoomToParentSubtree}>
                  Zoom To Parent Subtree
                </button>
              ) : null}
              {contextMenu.descendantTipCount === 1 ? (
                <button type="button" className="tree-context-menu-item" onClick={handleContextCopyTipName}>
                  Copy Tip Name
                </button>
              ) : null}
              <div className="tree-context-menu-section">
                <button
                  type="button"
                  className="tree-context-menu-item"
                  disabled={!tree || tree.buffers.parent[contextMenu.node] < 0}
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
                      onClick={() => handleContextReroot("branch")}
                    >
                      Root On Branch
                    </button>
                    <button
                      type="button"
                      className="tree-context-menu-item"
                      disabled={!tree || tree.buffers.parent[contextMenu.node] < 0}
                      onClick={() => handleContextReroot("child")}
                    >
                      Root On Child
                    </button>
                    <button
                      type="button"
                      className="tree-context-menu-item"
                      disabled={!tree || tree.buffers.parent[contextMenu.node] < 0}
                      onClick={() => handleContextReroot("parent")}
                    >
                      Root On Parent
                    </button>
                  </div>
                ) : null}
              </div>
              <button type="button" className="tree-context-menu-item" onClick={handleContextOpenSubtreeInNewTab}>
                Open Subtree In New Tab
              </button>
              {tree && tree.buffers.firstChild[contextMenu.node] >= 0 ? (
                <button type="button" className="tree-context-menu-item" onClick={handleContextToggleCollapse}>
                  {collapsedNodes.has(contextMenu.node) ? "Expand Subtree" : "Collapse Subtree"}
                </button>
              ) : null}
              <div className="tree-context-menu-section">
                <button
                  type="button"
                  className="tree-context-menu-item"
                  disabled={!tree || tree.buffers.parent[contextMenu.node] < 0}
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
                      onClick={handleContextClearSubtreeColor}
                    >
                      Clear Subtree Color
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="tree-context-menu-meta">
                Rank: {contextMenu.rank} · Tips: {contextMenu.descendantTipCount.toLocaleString()}
              </div>
              <button type="button" className="tree-context-menu-item" onClick={handleContextZoomToTaxonomySubtree}>
                Zoom To Group MRCA
              </button>
              <button type="button" className="tree-context-menu-item" onClick={handleContextOpenTaxonomySubtreeInNewTab}>
                Open Group Subtree In New Tab
              </button>
              <button type="button" className="tree-context-menu-item" onClick={handleContextCopyTaxonomyName}>
                Copy Name
              </button>
              <button
                type="button"
                className="tree-context-menu-item"
                onClick={handleContextOpenTaxonomyInNcbi}
                disabled={!contextMenu.taxId}
              >
                Open In NCBI Taxonomy
              </button>
              {contextMenu.rank === taxonomyOutermostRank ? (
                <div className="tree-context-menu-section">
                  <button
                    type="button"
                    className="tree-context-menu-item"
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
                        onClick={handleContextClearTaxonomyRootColor}
                      >
                        Clear Group Color
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
