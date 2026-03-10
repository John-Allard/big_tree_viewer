import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { distanceToSegmentSquared } from "../lib/spatialIndex";
import { TAXONOMY_RANKS, type TaxonomyBlocksByOrder, type TaxonomyMapPayload, type TaxonomyRank } from "../types/taxonomy";
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
  circularTimeLabelTheta,
  clamp01,
  displayLabelText,
  displayNodeName,
  estimateLabelWidth,
  formatAgeNumber,
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

const GENUS_CONNECTOR_COLORS = ["#111111", "#7a7a7a"] as const;
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
  genus: 0.18,
};

type TaxonomyColorByRank = Partial<Record<TaxonomyRank, Record<string, string>>>;

function hslColor(hue: number, saturation: number, lightness: number): string {
  const normalizedHue = ((hue % 360) + 360) % 360;
  return `hsl(${normalizedHue.toFixed(2)}deg ${saturation.toFixed(1)}% ${lightness.toFixed(1)}%)`;
}

function parseHslColor(fill: string): { h: number; s: number; l: number } | null {
  const match = /hsl\(([-\d.]+)deg\s+([-\d.]+)%\s+([-\d.]+)%\)/i.exec(fill);
  if (!match) {
    return null;
  }
  return {
    h: Number.parseFloat(match[1]),
    s: Number.parseFloat(match[2]),
    l: Number.parseFloat(match[3]),
  };
}

function colorForTaxonomy(rank: TaxonomyRank, label: string, colorsByRank: TaxonomyColorByRank | null): string {
  const mapped = colorsByRank?.[rank]?.[label];
  if (mapped) {
    return mapped;
  }
  let hash = 0;
  const key = `${rank}:${label}`;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  const saturation = rank === "genus" ? 58 : 52;
  const lightness = rank === "superkingdom" ? 72 : rank === "phylum" ? 66 : 60;
  return hslColor(hue, saturation, lightness);
}

function sortTaxonomyRanksForDisplay(activeRanks: TaxonomyRank[]): TaxonomyRank[] {
  return [...activeRanks].sort(
    (left, right) => TAXONOMY_DISPLAY_ORDER.indexOf(left) - TAXONOMY_DISPLAY_ORDER.indexOf(right),
  );
}

function taxonomyVisibleRanksForZoom(zoom: number, activeRanks: TaxonomyRank[]): TaxonomyRank[] {
  return activeRanks.filter((rank) => zoom >= TAXONOMY_LAYER_THRESHOLDS[rank]);
}

function buildTaxonomyColorMap(taxonomyMap: TaxonomyMapPayload): TaxonomyColorByRank {
  const activeRanks = sortTaxonomyRanksForDisplay(
    taxonomyMap.activeRanks.length > 0 ? taxonomyMap.activeRanks : [...TAXONOMY_RANKS].slice(-4),
  );
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
    const hue = (index * phi * 360) % 360;
    outerColors[outerEntries[index][0]] = hslColor(hue, 70, 64);
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
      const hueStep = half > 0 ? 18 / half : 0;
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
        const lightness = parsed.l + (position > 0 ? 4 : position < 0 ? -4 : 0);
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

function taxonomyTextColor(fill: string): string {
  const parsed = parseHslColor(fill);
  if (!parsed) {
    return "#0f172a";
  }
  return parsed.l >= 64 ? "#0f172a" : "#f8fafc";
}

function taxonomyRingMetricsPx(rankCount: number, baseFontSize: number): {
  ringWidthsPx: number[];
  ringGapPx: number;
  labelGapPx: number;
} {
  const ringBaseWidthPx = Math.max(12, Math.min(28, baseFontSize * 1.6));
  const outerRingWidthPx = ringBaseWidthPx * 1.45;
  const ringGapPx = Math.max(4, baseFontSize * 0.32);
  const labelGapPx = Math.max(12, baseFontSize * 1.0);
  const ringWidthsPx = Array.from({ length: rankCount }, (_, index) => (
    index === rankCount - 1 ? outerRingWidthPx : ringBaseWidthPx
  ));
  return { ringWidthsPx, ringGapPx, labelGapPx };
}

function visibleLeafRangeCount(ranges: Array<{ startIndex: number; endIndex: number }>): number {
  let total = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    total += Math.max(0, ranges[index].endIndex - ranges[index].startIndex);
  }
  return total;
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

function taxonomyBranchColor(
  node: number,
  parent: number,
  activeRanks: TaxonomyRank[],
  consensusByRank: TaxonomyConsensusByRank | null,
  colorsByRank: TaxonomyColorByRank | null,
): string | null {
  if (!consensusByRank || !colorsByRank) {
    return null;
  }
  for (let index = activeRanks.length - 1; index >= 0; index -= 1) {
    const rank = activeRanks[index];
    const values = consensusByRank[rank];
    if (!values) {
      continue;
    }
    const nodeLabel = values[node];
    if (!nodeLabel || values[parent] !== nodeLabel) {
      continue;
    }
    const color = colorsByRank[rank]?.[nodeLabel];
    if (color) {
      return color;
    }
  }
  return null;
}

type RenderTaxonomyBlock = {
  rank: TaxonomyRank;
  label: string;
  firstNode: number;
  lastNode: number;
  centerNode: number;
  color: string;
};

function buildTaxonomyBlocks(
  cache: ReturnType<typeof buildCache>,
  order: LayoutOrder,
  taxonomyMap: TaxonomyMapPayload,
  colorsByRank: TaxonomyColorByRank | null,
): Record<TaxonomyRank, RenderTaxonomyBlock[]> {
  const labelByNode = new Map<number, Partial<Record<TaxonomyRank, string>>>();
  for (let index = 0; index < taxonomyMap.tipRanks.length; index += 1) {
    labelByNode.set(taxonomyMap.tipRanks[index].node, taxonomyMap.tipRanks[index].ranks);
  }
  const orderedLeaves = cache.orderedLeaves[order];
  const blocks = TAXONOMY_RANKS.reduce<Record<TaxonomyRank, RenderTaxonomyBlock[]>>((accumulator, rank) => {
    accumulator[rank] = [];
    return accumulator;
  }, {} as Record<TaxonomyRank, RenderTaxonomyBlock[]>);
  for (let rankIndex = 0; rankIndex < TAXONOMY_RANKS.length; rankIndex += 1) {
    const rank = TAXONOMY_RANKS[rankIndex];
    let start = 0;
    while (start < orderedLeaves.length) {
      const firstNode = orderedLeaves[start];
      const firstLabel = labelByNode.get(firstNode)?.[rank];
      if (!firstLabel) {
        start += 1;
        continue;
      }
      let end = start + 1;
      while (end < orderedLeaves.length && labelByNode.get(orderedLeaves[end])?.[rank] === firstLabel) {
        end += 1;
      }
      if ((end - start) >= 2) {
        const centerIndex = Math.floor((start + end - 1) * 0.5);
        blocks[rank].push({
          rank,
          label: firstLabel,
          firstNode,
          lastNode: orderedLeaves[end - 1],
          centerNode: orderedLeaves[centerIndex],
          color: colorForTaxonomy(rank, firstLabel, colorsByRank),
        });
      }
      start = end;
    }
  }
  return blocks;
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
  showScaleBars,
  showGenusLabels,
  taxonomyEnabled,
  taxonomyMap,
  showNodeHeightLabels,
  searchQuery,
  searchMatches,
  activeSearchNode,
  activeSearchGenusCenterNode,
  focusNodeRequest,
  fitRequest,
  exportSvgRequest,
  onHoverChange,
}: TreeCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraRef = useRef<CameraState | null>(null);
  const previousViewModeRef = useRef<ViewMode>(viewMode);
  const frameRequestRef = useRef<number | null>(null);
  const hoverRef = useRef<CanvasHoverInfo | null>(null);
  const labelHitsRef = useRef<LabelHitbox[]>([]);
  const renderDebugRef = useRef<Record<string, unknown> | null>(null);
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
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const previousSizeRef = useRef(size);
  const [overlayHover, setOverlayHover] = useState<HoverInfo | null>(null);
  const [collapsedNodes, setCollapsedNodes] = useState<Set<number>>(() => new Set());
  const hiddenNodesRef = useRef<Uint8Array | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: number;
    name: string;
    descendantTipCount: number;
  } | null>(null);

  const cache = useMemo(() => (tree ? buildCache(tree) : null), [tree]);
  const taxonomyColors = useMemo(() => (
    taxonomyMap ? buildTaxonomyColorMap(taxonomyMap) : null
  ), [taxonomyMap]);
  const taxonomyActiveRanks = useMemo<TaxonomyRank[]>(
    () => sortTaxonomyRanksForDisplay(taxonomyMap?.activeRanks.length ? [...taxonomyMap.activeRanks] : [...TAXONOMY_RANKS]),
    [taxonomyMap],
  );
  const taxonomyBlocks = useMemo<TaxonomyBlocksByOrder | null>(() => {
    if (!cache || !taxonomyMap) {
      return null;
    }
    return {
      input: buildTaxonomyBlocks(cache, "input", taxonomyMap, taxonomyColors),
      desc: buildTaxonomyBlocks(cache, "desc", taxonomyMap, taxonomyColors),
      asc: buildTaxonomyBlocks(cache, "asc", taxonomyMap, taxonomyColors),
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
  const searchMatchSet = useMemo(() => new Set(searchMatches), [searchMatches]);
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

  const rectClampPadding = useCallback((camera: RectCamera) => {
    const microTipFontSize = Math.max(4.2, Math.min(6.25, camera.scaleY * 0.34));
    const tipFontSize = Math.max(6.5, Math.min(22, camera.scaleY * 0.58));
    const readableBandProgress = smoothstep01((camera.scaleY - 2.7) / Math.max(1e-6, 4.2 - 2.7));
    const tipBandFontSize = camera.scaleY <= 2.7
      ? 0
      : microTipFontSize + ((tipFontSize - microTipFontSize) * readableBandProgress);
    const genusFontSize = Math.max(10, Math.min(18, camera.scaleY * 0.42));
    const microBandWidthPx = estimateLabelWidth(Math.max(microTipFontSize, 4.2), reservedTipLabelCharacters);
    const readableBandWidthPx = estimateLabelWidth(Math.max(tipFontSize, 6.5), reservedTipLabelCharacters);
    const tipBandWidthPx = interpolateTipBandWidthPx(camera.scaleY, 1.55, 2.7, 4.2, microBandWidthPx, readableBandWidthPx);
    if (taxonomyEnabled && taxonomyBlocks) {
      const visibleRanks = taxonomyVisibleRanksForZoom(camera.scaleY, taxonomyActiveRanks);
      return {
        right: tipBandWidthPx + 34 + (visibleRanks.length * 16) + 96,
      };
    }
    const labelFontSize = Math.max(4.5, Math.min(22, Math.max(genusFontSize, tipBandFontSize)));
    const genusLabelWidthPx = estimateLabelWidth(labelFontSize, maxGenusLabelCharacters);
    return {
      right: Math.max(genusLabelWidthPx, tipBandWidthPx) + 140,
    };
  }, [maxGenusLabelCharacters, reservedTipLabelCharacters, taxonomyActiveRanks, taxonomyBlocks, taxonomyEnabled]);

  const circularClampExtraRadiusPx = useCallback((camera: CircularCamera) => {
    const maxRadius = Math.max(tree?.maxDepth ?? 0, tree?.branchLengthMinPositive ?? 1);
    const angularSpacingPx = camera.scale * maxRadius * (Math.PI * 2 / Math.max(1, tree?.leafCount ?? 1));
    const microTipFontSize = Math.max(4.2, Math.min(6.1, angularSpacingPx * 0.3));
    const tipFontSize = Math.max(6.5, Math.min(20, angularSpacingPx * 0.74));
    const readableBandProgress = smoothstep01((angularSpacingPx - 2.9) / Math.max(1e-6, 4.5 - 2.9));
    const tipBandFontSize = angularSpacingPx <= 2.9
      ? 0
      : microTipFontSize + ((tipFontSize - microTipFontSize) * readableBandProgress);
    const genusFontSize = Math.max(10, Math.min(18, Math.max(angularSpacingPx * 0.92, 10)));
    const microBandWidthPx = estimateLabelWidth(Math.max(microTipFontSize, 4.2), reservedTipLabelCharacters);
    const readableBandWidthPx = estimateLabelWidth(Math.max(tipFontSize, 6.5), reservedTipLabelCharacters);
    const tipBandWidthPx = interpolateTipBandWidthPx(angularSpacingPx, 1.6, 2.9, 4.5, microBandWidthPx, readableBandWidthPx);
    if (taxonomyEnabled && taxonomyBlocks) {
      const visibleRanks = taxonomyVisibleRanksForZoom(angularSpacingPx, taxonomyActiveRanks);
      const baseFontSize = Math.max(9, Math.min(14, Math.max(angularSpacingPx * 0.48, 9)));
      const metrics = taxonomyRingMetricsPx(visibleRanks.length, baseFontSize);
      const taxonomyWidthPx = metrics.ringWidthsPx.reduce((total, width) => total + width, 0)
        + (Math.max(0, visibleRanks.length - 1) * metrics.ringGapPx)
        + metrics.labelGapPx
        + 26;
      return tipBandWidthPx + taxonomyWidthPx;
    }
    const labelFontSize = Math.max(4.5, Math.min(20, Math.max(genusFontSize, tipBandFontSize)));
    const genusLabelWidthPx = estimateLabelWidth(labelFontSize, maxGenusLabelCharacters);
    return Math.max(genusLabelWidthPx, tipBandWidthPx) + 120;
  }, [maxGenusLabelCharacters, reservedTipLabelCharacters, taxonomyActiveRanks, taxonomyBlocks, taxonomyEnabled, tree]);

  const fitCamera = useCallback(() => {
    if (!tree) {
      return;
    }
    let nextCamera = viewMode === "rectangular"
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
      clampCircularCamera(nextCamera, tree, size.width, size.height, circularClampExtraRadiusPx(nextCamera));
    }
    cameraRef.current = nextCamera;
  }, [circularClampExtraRadiusPx, circularRotation, rectClampPadding, size.height, size.width, taxonomyBlocks, taxonomyEnabled, tree, viewMode]);

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
      clampCircularCamera(nextCamera, tree, size.width, size.height, circularClampExtraRadiusPx(nextCamera));
      return nextCamera;
    }

    return fromCamera;
  }, [circularRotation, size.height, size.width, tree, viewMode]);

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
    const renderDebug: Record<string, unknown> = {
      viewMode,
      order,
      width: size.width,
      height: size.height,
    };
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
      const axisBarHeight = tree.isUltrametric && showScaleBars ? 44 : 0;
      const treeDrawBottom = size.height - axisBarHeight;
      const stripeExtent = tree.isUltrametric ? tree.rootAge : tree.maxDepth;
      const stripeLevels = buildStripeLevels(Math.max(1e-9, maxX - minX), camera.scaleX);
      const stripeBoundaries = buildStripeBoundaries(stripeExtent, stripeLevels);
      const tipLabelCueVisible = camera.scaleY > 1.45;
      const microTipLabelsVisible = camera.scaleY > 2.7;
      const tipLabelsVisible = camera.scaleY > 4.2;

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
      const useDenseRectLOD = camera.scaleY < 1.25;
      const rectConnectorKeys = useDenseRectLOD ? new Set<string>() : null;
      const rectStemKeys = useDenseRectLOD ? new Set<string>() : null;
      const visibleRectSegments = collapsedNodes.size === 0
        ? cache.rectIndices[order].query(
          (minX + maxX) * 0.5,
          (minY + maxY) * 0.5,
          Math.max(1e-6, (maxX - minX) * 0.5),
          Math.max(1e-6, (maxY - minY) * 0.5),
        )
        : null;
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
        }
      }
      ctx.stroke();

      if (taxonomyEnabled && taxonomyConsensus && taxonomyColors) {
        const colorPaths = new Map<string, Array<[number, number, number, number]>>();
        const pushColoredSegment = (color: string | null, x1: number, y1: number, x2: number, y2: number): void => {
          if (!color) {
            return;
          }
          const segments = colorPaths.get(color) ?? [];
          segments.push([x1, y1, x2, y2]);
          colorPaths.set(color, segments);
        };
        const connectorOwners = new Set<number>();
        if (visibleRectSegments) {
          for (let index = 0; index < visibleRectSegments.length; index += 1) {
            const segment = visibleRectSegments[index];
            if (segment.kind === "connector") {
              connectorOwners.add(segment.node);
              continue;
            }
            const parent = tree.buffers.parent[segment.node];
            if (parent < 0) {
              continue;
            }
            const color = taxonomyBranchColor(segment.node, parent, taxonomyActiveRanks, taxonomyConsensus, taxonomyColors);
            if (!color) {
              continue;
            }
            const start = worldToScreenRect(camera, segment.x1, segment.y1);
            const end = worldToScreenRect(camera, segment.x2, segment.y2);
            pushColoredSegment(color, start.x, start.y, end.x, end.y);
          }
        } else {
          for (let node = 0; node < tree.nodeCount; node += 1) {
            if (hiddenNodes[node]) {
              continue;
            }
            const parent = tree.buffers.parent[node];
            if (parent < 0) {
              if (!collapsedNodes.has(node) && children[node].length >= 2) {
                connectorOwners.add(node);
              }
              continue;
            }
            const color = taxonomyBranchColor(node, parent, taxonomyActiveRanks, taxonomyConsensus, taxonomyColors);
            if (!color) {
              continue;
            }
            const y = layout.center[node];
            if (!lineIntersectsRect(tree.buffers.depth[parent], y, tree.buffers.depth[node], y, minX, minY, maxX, maxY)) {
              continue;
            }
            const start = worldToScreenRect(camera, tree.buffers.depth[parent], y);
            const end = worldToScreenRect(camera, tree.buffers.depth[node], y);
            pushColoredSegment(color, start.x, start.y, end.x, end.y);
          }
          for (let node = 0; node < tree.nodeCount; node += 1) {
            if (!hiddenNodes[node] && !collapsedNodes.has(node) && children[node].length >= 2) {
              connectorOwners.add(node);
            }
          }
        }
        connectorOwners.forEach((ownerNode) => {
          if (hiddenNodes[ownerNode] || collapsedNodes.has(ownerNode)) {
            return;
          }
          const ownerY = layout.center[ownerNode];
          const ownerX = tree.buffers.depth[ownerNode];
          const orderedChildren = children[ownerNode];
          for (let childIndex = 0; childIndex < orderedChildren.length; childIndex += 1) {
            const child = orderedChildren[childIndex];
            if (hiddenNodes[child]) {
              continue;
            }
            const color = taxonomyBranchColor(child, ownerNode, taxonomyActiveRanks, taxonomyConsensus, taxonomyColors);
            if (!color) {
              continue;
            }
            const childY = layout.center[child];
            if (!lineIntersectsRect(ownerX, ownerY, ownerX, childY, minX, minY, maxX, maxY)) {
              continue;
            }
            const start = worldToScreenRect(camera, ownerX, ownerY);
            const end = worldToScreenRect(camera, ownerX, childY);
            pushColoredSegment(color, start.x, start.y, end.x, end.y);
          }
        });
        colorPaths.forEach((segments, color) => {
          ctx.beginPath();
          for (let index = 0; index < segments.length; index += 1) {
            const [x1, y1, x2, y2] = segments[index];
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.15;
          ctx.globalAlpha = 0.95;
          ctx.stroke();
        });
        ctx.globalAlpha = 1;
      }

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
      const tipFontSize = Math.max(6.5, Math.min(22, camera.scaleY * 0.58));
      const microTipFontSize = Math.max(4.2, Math.min(6.25, camera.scaleY * 0.34));
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
      const measuredLabels: Array<{ node: number; text: string; x: number; y: number; width: number }> = [];
      const needTipEnvelope = tipLabelCueVisible || camera.scaleY > 2.35;
      if (needTipEnvelope) {
        ctx.font = `${tipFontSize}px ${LABEL_FONT}`;
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        const orderedLeaves = cache.orderedLeaves[order];
        const startLeafIndex = lowerBoundLeaves(orderedLeaves, layout.center, minY - 2);
        const endLeafIndex = lowerBoundLeaves(orderedLeaves, layout.center, maxY + 2.000001);
        for (let index = startLeafIndex; index < endLeafIndex; index += 1) {
          const node = orderedLeaves[index];
          if (hiddenNodes[node]) {
            continue;
          }
          const y = layout.center[node];
          const text = displayLabelText(tree.names[node] || "", `tip-${node}`);
          const screen = worldToScreenRect(camera, tree.buffers.depth[node], y);
          const x = screen.x + 8;
          const width = ctx.measureText(text).width;
          measuredLabels.push({ node, text, x, y: screen.y, width });
        }
      }
      const maxVisibleLabels = 5200;
      if (microTipLabelsVisible && measuredLabels.length <= maxVisibleLabels) {
        visibleTipLabels = measuredLabels.map(({ node, text, x, y, width }) => ({ node, text, x, y, width }));
      }

      const genusGapPx = Math.max(12, tipBandFontSize * 1.9);
      if (taxonomyEnabled && taxonomyBlocks) {
        const visibleRanks = taxonomyVisibleRanksForZoom(camera.scaleY, taxonomyActiveRanks);
        const columnBaseX = tipSideX + globalTipLabelSpacePx + 18;
        const columnWidth = 13;
        const columnGap = 5;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        for (let rankIndex = 0; rankIndex < visibleRanks.length; rankIndex += 1) {
          const rank = visibleRanks[rankIndex];
          const blocks = taxonomyBlocks[order][rank];
          const columnX = columnBaseX + (rankIndex * (columnWidth + columnGap));
          for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
            const block = blocks[blockIndex];
            if (hiddenNodes[block.centerNode]) {
              continue;
            }
            const y1 = layout.center[block.firstNode];
            const y2 = layout.center[block.lastNode];
            if (y2 < minY - 2 || y1 > maxY + 2) {
              continue;
            }
            const screenStart = worldToScreenRect(camera, tree.buffers.depth[block.firstNode], y1);
            const screenEnd = worldToScreenRect(camera, tree.buffers.depth[block.lastNode], y2);
            const top = Math.min(screenStart.y, screenEnd.y);
            const bottom = Math.max(screenStart.y, screenEnd.y);
            ctx.fillStyle = block.color;
            ctx.fillRect(columnX, top, columnWidth, Math.max(2, bottom - top));
            const spanPx = bottom - top;
            if (spanPx >= 18) {
              const fontSize = Math.max(9, Math.min(12, 9 + (spanPx * 0.025)));
              ctx.font = `${fontSize}px ${LABEL_FONT}`;
              ctx.fillStyle = taxonomyTextColor(block.color);
              ctx.fillText(block.label, columnX + columnWidth + 5, (top + bottom) * 0.5);
            }
          }
        }
        renderDebug.rect = {
          cueVisible: tipLabelCueVisible,
          microVisible: microTipLabelsVisible,
          tipVisible: tipLabelsVisible,
          tipBandFontSize,
          tipBandWidthPx: globalTipLabelSpacePx,
          tipSideX,
          genusGapPx: null,
          genusBandX: columnBaseX,
          genusBandOffsetPx: columnBaseX - tipSideX,
          connectorXs: [],
          taxonomyVisibleRanks: visibleRanks,
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
      } else if (showGenusLabels) {
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
        const baseFontSize = Math.max(10, Math.min(16, camera.scaleY * 0.38));
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
            x + 7,
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
            x: x + 7,
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
          }
          ctx.globalAlpha = 1;
        }
        for (let index = 0; index < placedLabels.length; index += 1) {
          const label = placedLabels[index];
          ctx.font = `${label.fontSize ?? baseFontSize}px ${LABEL_FONT}`;
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
        }
        ctx.globalAlpha = 1;
        renderDebug.rect = {
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
      } else {
        renderDebug.rect = {
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
      }

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
          ctx.font = `${fittedFontSize}px ${LABEL_FONT}`;
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
            labelHitsRef.current.push({
              node: label.node,
              kind: "rect",
              source: "label",
              x: label.x,
              y: label.y - (fittedFontSize * 0.55),
              width: Math.min(globalTipLabelSpacePx, ctx.measureText(label.text).width),
              height: fittedFontSize * 1.1,
            });
          } else {
            ctx.fillStyle = "rgba(15,23,42,0.6)";
            ctx.fillText(label.text, label.x, label.y);
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
        }
        ctx.stroke();
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
      const layout = collapsedView?.layout ?? tree.layouts[order];
      const children = cache.orderedChildren[order];
      const orderedLeaves = cache.orderedLeaves[order];
      const rotationAngle = camera.rotation;
      const maxRadius = Math.max(tree.maxDepth, tree.branchLengthMinPositive);
      const angularSpacingPx = camera.scale * maxRadius * (Math.PI * 2 / Math.max(1, tree.leafCount));
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
      const showCentralTimeLabels = tree.isUltrametric && showScaleBars && visibleCircleFraction >= 0.58;
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

      ctx.strokeStyle = BRANCH_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const useDenseCircularLOD = angularSpacingPx < 1.1;
      const circularConnectorKeys = useDenseCircularLOD ? new Set<string>() : null;
      const circularStemKeys = useDenseCircularLOD ? new Set<string>() : null;
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
      const visibleCircularSegments = collapsedNodes.size === 0
        ? cache.circularIndices[order].query(
          (circularMinX + circularMaxX) * 0.5,
          (circularMinY + circularMaxY) * 0.5,
          Math.max(1e-6, (circularMaxX - circularMinX) * 0.5) + circularWorldOverscan,
          Math.max(1e-6, (circularMaxY - circularMinY) * 0.5) + circularWorldOverscan,
        )
        : null;
      if (visibleCircularSegments) {
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
          } else {
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
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
        }
      }
      ctx.stroke();

      if (taxonomyEnabled && taxonomyConsensus && taxonomyColors) {
        const colorStemPaths = new Map<string, Array<[number, number, number, number]>>();
        const colorArcPaths = new Map<string, Array<{ radiusPx: number; start: number; end: number }>>();
        const pushStem = (color: string | null, x1: number, y1: number, x2: number, y2: number): void => {
          if (!color) {
            return;
          }
          const segments = colorStemPaths.get(color) ?? [];
          segments.push([x1, y1, x2, y2]);
          colorStemPaths.set(color, segments);
        };
        const pushArc = (color: string | null, radiusPx: number, start: number, end: number): void => {
          if (!color || radiusPx < 0.25 || end <= start) {
            return;
          }
          const arcs = colorArcPaths.get(color) ?? [];
          arcs.push({ radiusPx, start, end });
          colorArcPaths.set(color, arcs);
        };
        const connectorOwners = new Set<number>();
        if (visibleCircularSegments) {
          for (let index = 0; index < visibleCircularSegments.length; index += 1) {
            const segment = visibleCircularSegments[index];
            if (segment.kind === "connector") {
              connectorOwners.add(segment.node);
              continue;
            }
            const parent = tree.buffers.parent[segment.node];
            if (parent < 0) {
              continue;
            }
            const color = taxonomyBranchColor(segment.node, parent, taxonomyActiveRanks, taxonomyConsensus, taxonomyColors);
            if (!color) {
              continue;
            }
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
                connectorOwners.add(node);
              }
              continue;
            }
            const color = taxonomyBranchColor(node, parent, taxonomyActiveRanks, taxonomyConsensus, taxonomyColors);
            if (!color) {
              continue;
            }
            const theta = thetaFor(layout.center, node, tree.leafCount);
            const startWorld = polarToCartesian(tree.buffers.depth[parent], theta);
            const endWorld = polarToCartesian(tree.buffers.depth[node], theta);
            const start = worldToScreenCircular(camera, startWorld.x, startWorld.y);
            const end = worldToScreenCircular(camera, endWorld.x, endWorld.y);
            if (lineIntersectsRect(start.x, start.y, end.x, end.y, 0, 0, size.width, size.height)) {
              pushStem(color, start.x, start.y, end.x, end.y);
            }
          }
          for (let node = 0; node < tree.nodeCount; node += 1) {
            if (!hiddenNodes[node] && !collapsedNodes.has(node) && children[node].length >= 2) {
              connectorOwners.add(node);
            }
          }
        }
        connectorOwners.forEach((ownerNode) => {
          if (hiddenNodes[ownerNode] || collapsedNodes.has(ownerNode)) {
            return;
          }
          const ownerTheta = thetaFor(layout.center, ownerNode, tree.leafCount);
          const ownerArcStart = thetaFor(layout.min, ownerNode, tree.leafCount);
          const ownerArcEnd = thetaFor(layout.max, ownerNode, tree.leafCount);
          const ownerArcLength = Math.max(0, ownerArcEnd - ownerArcStart);
          const radiusPx = tree.buffers.depth[ownerNode] * camera.scale;
          const orderedChildren = children[ownerNode];
          for (let childIndex = 0; childIndex < orderedChildren.length; childIndex += 1) {
            const child = orderedChildren[childIndex];
            if (hiddenNodes[child]) {
              continue;
            }
            const color = taxonomyBranchColor(child, ownerNode, taxonomyActiveRanks, taxonomyConsensus, taxonomyColors);
            if (!color) {
              continue;
            }
            const childTheta = thetaFor(layout.center, child, tree.leafCount);
            const arcSpan = arcSubspanWithinSpan(ownerTheta, childTheta, ownerArcStart, ownerArcLength);
            if (!arcSpan) {
              continue;
            }
            pushArc(color, radiusPx, arcSpan.start + rotationAngle, arcSpan.end + rotationAngle);
          }
        });
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
          ctx.lineWidth = 1.2;
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
          ctx.lineWidth = 1.2;
          ctx.globalAlpha = 0.95;
          ctx.stroke();
        });
        ctx.globalAlpha = 1;
      }

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
      const tipFontSize = Math.max(6.5, Math.min(20, angularSpacingPx * 0.74));
      const microTipFontSize = Math.max(4.2, Math.min(6.1, angularSpacingPx * 0.3));
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
      const visibleLeafOverscan = Math.max(12, Math.min(1600, Math.ceil((circularTipVisibilityMargin + 120) / Math.max(0.5, angularSpacingPx))));
      const leafVisibilityRadiusPx = Math.max(maxRadius * camera.scale, tipBandAnchorRadius * camera.scale * 0.82);
      const visibleAngleSpans = computeVisibleCircularAngleSpans(
        centerPoint.x,
        centerPoint.y,
        leafVisibilityRadiusPx,
        size.width,
        size.height,
        circularTipVisibilityMargin + 80,
      );
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
      let circularVisibleTipLabels: Array<{ node: number; theta: number; x: number; y: number; text: string; width: number }> = [];
      let maxVisibleTipLabelWidth = 0;
      if (tipLabelCueVisible) {
        ctx.font = `${tipFontSize}px ${LABEL_FONT}`;
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
        | { mode: "band"; innerRadiusPx: number; outerRadiusPx: number; startTheta: number; endTheta: number; color: string }
      > = [];
      let circularGenusBaseFontSize = 0;
      if (taxonomyEnabled && taxonomyBlocks) {
        let visibleRanks = taxonomyVisibleRanksForZoom(angularSpacingPx, taxonomyActiveRanks);
        const visibleLeafCount = visibleLeafRangeCount(visibleLeafRanges);
        if (visibleLeafCount > 0 && visibleLeafCount < Math.max(1, tree.leafCount - 16)) {
          while (visibleRanks.length > 1) {
            const candidateRank = visibleRanks[visibleRanks.length - 1];
            let sharedLabel: string | null = null;
            let mixed = false;
            for (let rangeIndex = 0; rangeIndex < visibleLeafRanges.length && !mixed; rangeIndex += 1) {
              const range = visibleLeafRanges[rangeIndex];
              for (let leafIndex = range.startIndex; leafIndex < range.endIndex; leafIndex += 1) {
                const node = orderedLeaves[leafIndex];
                const label = taxonomyTipRanksByNode.get(node)?.[candidateRank] ?? null;
                if (!label) {
                  mixed = true;
                  break;
                }
                if (sharedLabel === null) {
                  sharedLabel = label;
                } else if (sharedLabel !== label) {
                  mixed = true;
                  break;
                }
              }
            }
            if (!mixed && sharedLabel) {
              visibleRanks = visibleRanks.slice(0, -1);
              continue;
            }
            break;
          }
        }
        const baseFontSize = Math.max(8.5, Math.min(18, 8.5 + (angularSpacingPx * 0.45)));
        circularGenusBaseFontSize = baseFontSize;
        const metrics = taxonomyRingMetricsPx(visibleRanks.length, baseFontSize);
        const tipBandOuterRadiusPx = (maxRadius * camera.scale) + globalTipLabelSpacePx;
        let ringCursorOuterPx = tipBandOuterRadiusPx + 18;
        const placedLabels: ScreenLabel[] = [];
        const connectorArcs: Array<
          { mode: "band"; innerRadiusPx: number; outerRadiusPx: number; startTheta: number; endTheta: number; color: string }
        > = [];
        for (let rankIndex = 0; rankIndex < visibleRanks.length; rankIndex += 1) {
          const rank = visibleRanks[rankIndex];
          const blocks = taxonomyBlocks[order][rank];
          const ringWidthPx = metrics.ringWidthsPx[rankIndex];
          const ringInnerPx = ringCursorOuterPx;
          ringCursorOuterPx += ringWidthPx;
          const ringOuterPx = ringCursorOuterPx;
          const lineRadiusPx = ringInnerPx + (ringWidthPx * 0.5);
          const lineRadius = lineRadiusPx / camera.scale;
          for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
            const block = blocks[blockIndex];
            if (hiddenNodes[block.centerNode]) {
              continue;
            }
            const startTheta = thetaFor(layout.center, block.firstNode, tree.leafCount);
            const endTheta = thetaFor(layout.center, block.lastNode, tree.leafCount);
            let renderStartTheta = startTheta;
            let renderEndTheta = endTheta;
            if (renderEndTheta < renderStartTheta) {
              renderEndTheta += Math.PI * 2;
            }
            connectorArcs.push({
              mode: "band",
              innerRadiusPx: ringInnerPx,
              outerRadiusPx: ringOuterPx,
              startTheta: renderStartTheta,
              endTheta: renderEndTheta,
              color: block.color,
            });
            const arcLengthPx = (renderEndTheta - renderStartTheta) * lineRadiusPx;
            if (arcLengthPx < 36) {
              continue;
            }
            const midTheta = renderStartTheta + ((renderEndTheta - renderStartTheta) * 0.5);
            const labelRadius = lineRadius;
            const fontSize = Math.max(baseFontSize, Math.min(22, baseFontSize + Math.min(8, arcLengthPx * 0.012)));
            const labelPoint = worldToScreenCircular(
              camera,
              Math.cos(midTheta) * labelRadius,
              Math.sin(midTheta) * labelRadius,
            );
            if (
              labelPoint.x < -120 || labelPoint.x > size.width + 120 ||
              labelPoint.y < -120 || labelPoint.y > size.height + 120
            ) {
              continue;
            }
            const tangentDegrees = ((midTheta + rotationAngle) * 180 / Math.PI) + 90;
            const onRightSide = Math.cos(midTheta + rotationAngle) >= 0;
            const rotation = normalizeRotation(onRightSide ? tangentDegrees : tangentDegrees + 180);
            if (!canPlaceLinearLabel(placedLabels, labelPoint.x, labelPoint.y, Math.max(ringWidthPx * 0.9, fontSize * 1.1), fontSize * 6.2)) {
              continue;
            }
            placedLabels.push({
              x: labelPoint.x,
              y: labelPoint.y,
              text: block.label,
              alpha: 1,
              fontSize,
              rotation: rotation * Math.PI / 180,
              align: "center",
              color: taxonomyTextColor(block.color),
            });
          }
          ringCursorOuterPx += metrics.ringGapPx;
        }
        circularGenusLabels = placedLabels;
        circularGenusArcs = connectorArcs;
        renderDebug.circular = {
          cueVisible: tipLabelCueVisible,
          microVisible: microTipLabelsVisible,
          tipVisible: tipLabelsVisible,
          tipBandFontSize,
          tipBandWidthPx: globalTipLabelSpacePx,
          tipBandAnchorRadiusPx: tipBandAnchorRadius * camera.scale,
          visibleTipLabelCount: circularVisibleTipLabels.length,
          genusGapPx: null,
          genusLineRadiusPx: connectorArcs[0]
            ? (connectorArcs[0].innerRadiusPx + connectorArcs[0].outerRadiusPx) * 0.5
            : null,
          visibleLeafRanges: visibleLeafRanges.map((range) => [range.startIndex, range.endIndex]),
          taxonomyVisibleRanks: visibleRanks,
          taxonomyTipBandOuterRadiusPx: tipBandOuterRadiusPx,
          taxonomyFirstRingInnerRadiusPx: connectorArcs.length > 0
            ? connectorArcs[0].innerRadiusPx
            : null,
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
      } else if (showGenusLabels) {
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
        const baseFontSize = Math.max(10, Math.min(18, Math.max(angularSpacingPx * 0.92, 10)));
        const tipLabelPressure = clamp01((angularSpacingPx - 4) / 4);
        const lineGapPx = Math.max(12, tipBandFontSize * 1.9);
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
          ctx.globalAlpha = 0.76;
          if (arc.mode === "band") {
            ctx.beginPath();
            ctx.arc(centerPoint.x, centerPoint.y, arc.outerRadiusPx, arc.startTheta + rotationAngle, arc.endTheta + rotationAngle, false);
            ctx.arc(centerPoint.x, centerPoint.y, arc.innerRadiusPx, arc.endTheta + rotationAngle, arc.startTheta + rotationAngle, true);
            ctx.closePath();
            ctx.fillStyle = arc.color;
            ctx.fill();
          } else {
            ctx.lineWidth = arc.lineWidthPx;
            ctx.beginPath();
            ctx.moveTo(
              centerPoint.x + Math.cos(arc.startTheta + rotationAngle) * arc.lineRadiusPx,
              centerPoint.y + Math.sin(arc.startTheta + rotationAngle) * arc.lineRadiusPx,
            );
            ctx.arc(centerPoint.x, centerPoint.y, arc.lineRadiusPx, arc.startTheta + rotationAngle, arc.endTheta + rotationAngle, false);
            ctx.strokeStyle = arc.color;
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }
      if (tipLabelsVisible) {
        const fontSize = tipFontSize;
        ctx.font = `${fontSize}px ${LABEL_FONT}`;
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
            ctx.font = `${fittedFontSize}px ${LABEL_FONT}`;
            ctx.save();
            ctx.translate(x, y);
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
            labelHitsRef.current.push({
              node,
              kind: "rotated",
              source: "label",
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
        ctx.font = `${fontSize}px ${LABEL_FONT}`;
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
            ctx.font = `${fittedFontSize}px ${LABEL_FONT}`;
            ctx.save();
            ctx.translate(label.x, label.y);
            ctx.rotate(rotation * Math.PI / 180);
            ctx.textAlign = onRightSide ? "left" : "right";
            ctx.fillText(label.text, 0, 0);
            ctx.restore();
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
        }
        ctx.stroke();
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
        ctx.font = `${label.fontSize ?? circularGenusBaseFontSize}px ${LABEL_FONT}`;
        ctx.save();
        ctx.translate(label.x, label.y);
        ctx.rotate(label.rotation ?? 0);
        ctx.textAlign = label.align ?? "left";
        drawHighlightedText(
          ctx,
          label.text,
          0,
          0,
          label.align ?? "left",
          GENUS_COLOR,
          label.color ?? null,
          findSearchMatchRange(label.text, searchQuery),
        );
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
          const deg = (theta + rotationAngle) * 180 / Math.PI;
          const onRightSide = Math.cos(theta + rotationAngle) >= 0;
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
          ctx.textAlign = Math.cos(labelTheta + rotationAngle) >= 0 ? "left" : "right";
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
    renderDebugRef.current = renderDebug;
    if (typeof window !== "undefined") {
      window.__BIG_TREE_VIEWER_RENDER_DEBUG__ = renderDebug;
    }
  }, [
    activeSearchGenusCenterNode,
    activeSearchNode,
    cache,
    collapsedView,
    collapsedNodes,
    fitCamera,
    order,
    reservedTipLabelCharacters,
    searchQuery,
    searchMatches,
    searchMatchSet,
    showGenusLabels,
    showNodeHeightLabels,
    showScaleBars,
    showTimeStripes,
    size.height,
    size.width,
    taxonomyActiveRanks,
    taxonomyBlocks,
    taxonomyColors,
    taxonomyConsensus,
    taxonomyEnabled,
    taxonomyTipRanksByNode,
    tree,
    viewMode,
  ]);

  const scheduleDraw = useCallback(() => {
    if (frameRequestRef.current !== null) {
      return;
    }
    frameRequestRef.current = window.requestAnimationFrame(() => {
      frameRequestRef.current = null;
      draw();
    });
  }, [draw]);

  useLayoutEffect(() => {
    if (!tree || !cache) {
      return;
    }
    const previousViewMode = previousViewModeRef.current;
    previousViewModeRef.current = viewMode;
    const previousSize = previousSizeRef.current;
    previousSizeRef.current = size;
    const currentCamera = cameraRef.current;
    const sizeChanged = previousSize.width !== size.width || previousSize.height !== size.height;
    if (currentCamera && sizeChanged && previousViewMode === viewMode) {
      if (currentCamera.kind === "rect") {
        clampRectCamera(currentCamera, tree, size.width, size.height, rectClampPadding(currentCamera));
      } else {
        clampCircularCamera(currentCamera, tree, size.width, size.height, circularClampExtraRadiusPx(currentCamera));
      }
      draw();
      return;
    }
    if (currentCamera && previousViewMode !== viewMode) {
      cameraRef.current = convertCameraForViewMode(currentCamera);
      draw();
      return;
    }
    fitCamera();
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
      clampCircularCamera(camera, tree, size.width, size.height, circularClampExtraRadiusPx(camera));
    }
    draw();
  }, [
    collapsedView,
    circularClampExtraRadiusPx,
    circularRotation,
    draw,
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
      const padding = rectClampPadding(camera);
      const padRight = Math.max(48, padding.right ?? 0);
      const padBottom = 52;
      const usableWidth = Math.max(1, size.width - padLeft - padRight);
      const usableHeight = Math.max(1, size.height - padTop - padBottom);
      const minX = tree.buffers.depth[targetNode];
      const maxX = subtreeMaxDepth;
      const minY = layout.min[targetNode];
      const maxY = layout.max[targetNode];
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
    viewMode,
  ]);

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
    const targetNode = activeSearchGenusCenterNode ?? activeSearchNode;
    if (targetNode === null) {
      return;
    }
    handledFocusRequestRef.current = focusNodeRequest;
    const focusTargetKind = activeSearchGenusCenterNode !== null
      ? "genus"
      : tree.buffers.firstChild[targetNode] < 0
        ? "tip"
        : "node";
    focusNodeTarget(targetNode, focusTargetKind);
  }, [
    activeSearchGenusCenterNode,
    activeSearchNode,
    focusNodeRequest,
    focusNodeTarget,
    order,
    tree,
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
    const width = size.width;
    const height = size.height;
    const pngDataUrl = canvas.toDataURL("image/png");
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<desc>Big Tree Viewer current-view export. This SVG intentionally embeds the rendered viewport as an image to keep large-tree exports tractable.</desc>`,
      `<rect width="100%" height="100%" fill="#ffffff"/>`,
      `<image href="${pngDataUrl}" width="${width}" height="${height}" preserveAspectRatio="none"/>`,
      "</svg>",
    ].join("");
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `big-tree-view-${viewMode}.svg`;
    link.click();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
  }, [exportSvgRequest, size.height, size.width, viewMode]);

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

      for (let index = labelHitsRef.current.length - 1; index >= 0; index -= 1) {
        const hitbox = labelHitsRef.current[index];
        if (!pointInLabelHitbox(localX, localY, hitbox)) {
          continue;
        }
        hover = buildHoverInfo(hitbox.node, "label", localX, localY);
        break;
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
        clampCircularCamera(camera, tree, size.width, size.height, circularClampExtraRadiusPx(camera));
      }
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
          const zoom = distance / previous.distance;
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
        const dx = event.clientX - lastPointerRef.current.x;
        const dy = event.clientY - lastPointerRef.current.y;
        lastPointerRef.current = { x: event.clientX, y: event.clientY };
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
      hoverRef.current = null;
      setOverlayHover(null);
      onHoverChange(null);
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
      const hover = hitTestAt(localX, localY);
      if (!hover) {
        setContextMenu(null);
        return;
      }
      hoverRef.current = hover;
      setOverlayHover(hover);
      onHoverChange(hover);
      setContextMenu({
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
  }, [cache, collapsedNodes, collapsedView, draw, onHoverChange, order, scheduleDraw, size.height, size.width, toggleCollapsedNode, tree, zoomAxisMode]);

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
        clampCircularCamera(camera, tree, size.width, size.height, circularClampExtraRadiusPx(camera));
        draw();
      },
    };
    return () => {
      delete window.__BIG_TREE_VIEWER_CANVAS_TEST__;
    };
  }, [circularClampExtraRadiusPx, draw, fitCamera, rectClampPadding, size.height, size.width, tree]);

  const handleContextZoomToSubtree = useCallback(() => {
    if (!contextMenu) {
      return;
    }
    zoomToSubtreeTarget(contextMenu.node);
    setContextMenu(null);
  }, [contextMenu, zoomToSubtreeTarget]);

  const handleContextZoomToParentSubtree = useCallback(() => {
    if (!contextMenu || !tree) {
      return;
    }
    const parent = tree.buffers.parent[contextMenu.node];
    if (parent < 0) {
      return;
    }
    zoomToSubtreeTarget(parent);
    setContextMenu(null);
  }, [contextMenu, tree, zoomToSubtreeTarget]);

  const handleContextOpenSubtreeInNewTab = useCallback(() => {
    if (!contextMenu || typeof window === "undefined" || !tree) {
      return;
    }
    const key = `big-tree-viewer:subtree:${crypto.randomUUID()}`;
    const newick = serializeSubtreeToNewick(tree, contextMenu.node);
    window.localStorage.setItem(key, newick);
    const url = new URL(window.location.href);
    url.searchParams.set("subtree", key);
    window.open(url.toString(), "_blank", "noopener");
    setContextMenu(null);
  }, [contextMenu, tree]);

  const handleContextToggleCollapse = useCallback(() => {
    if (!contextMenu || !tree || tree.buffers.firstChild[contextMenu.node] < 0) {
      return;
    }
    toggleCollapsedNode(contextMenu.node);
    setContextMenu(null);
  }, [contextMenu, toggleCollapsedNode, tree]);

  return (
    <div
      className="tree-canvas-shell"
      ref={wrapperRef}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest(".tree-context-menu")) {
          return;
        }
        setContextMenu(null);
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
          <button type="button" className="tree-context-menu-item" onClick={handleContextOpenSubtreeInNewTab}>
            Open Subtree In New Tab
          </button>
          {tree && tree.buffers.firstChild[contextMenu.node] >= 0 ? (
            <button type="button" className="tree-context-menu-item" onClick={handleContextToggleCollapse}>
              {collapsedNodes.has(contextMenu.node) ? "Expand Subtree" : "Collapse Subtree"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
