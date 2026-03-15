import type { IndexedSegment } from "../lib/spatialIndex";
import type { LayoutOrder, TreeModel } from "../types/tree";
import type {
  CircularScaleBar,
  CircularScaleTick,
  LabelHitbox,
  ScreenLabel,
  StripeBoundary,
  StripeLevel,
} from "./treeCanvasTypes";

export function normalizeRotation(degrees: number): number {
  let value = ((degrees + 180) % 360) - 180;
  if (value > 90) {
    value -= 180;
  } else if (value < -90) {
    value += 180;
  }
  return value;
}

export function polarToCartesian(radius: number, theta: number): { x: number; y: number } {
  return {
    x: radius * Math.cos(theta),
    y: radius * Math.sin(theta),
  };
}

export function niceTickStep(range: number): number {
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

export function formatAgeNumber(value: number): string {
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

export function formatScaleNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (Math.abs(value) < 1e-12) {
    return "0";
  }
  const abs = Math.abs(value);
  if (abs >= 100) {
    return value.toFixed(0);
  }
  if (abs >= 10) {
    return value.toFixed(1).replace(/\.0$/, "");
  }
  if (abs >= 1) {
    return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  const decimals = Math.min(6, Math.max(3, Math.ceil(-Math.log10(abs)) + 1));
  return value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

export function nodeHeightValue(tree: TreeModel, node: number): number {
  if (tree.isUltrametric) {
    return Math.max(0, tree.rootAge - tree.buffers.depth[node]);
  }
  return tree.buffers.depth[node];
}

export function canPlaceLinearLabel(
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

export function pointInLabelHitbox(x: number, y: number, hitbox: LabelHitbox): boolean {
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

export function buildStripeLevels(visibleSpan: number, pixelsPerUnit: number, baseStep?: number | null): StripeLevel[] {
  const levels: StripeLevel[] = [];
  const coarseStep = baseStep && Number.isFinite(baseStep) && baseStep > 0 ? baseStep : niceTickStep(visibleSpan);
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

export function buildStripeBoundaries(extent: number, levels: StripeLevel[]): StripeBoundary[] {
  if (!Number.isFinite(extent) || extent <= 0 || levels.length === 0) {
    return [];
  }
  const byValue = new Map<string, StripeBoundary>();
  const maxBoundariesPerLevel = 20000;
  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    const level = levels[levelIndex];
    if (!Number.isFinite(level.step) || level.step <= 0) {
      continue;
    }
    const alpha = levelIndex === 0 ? 1 : level.alpha;
    if (alpha <= 0) {
      continue;
    }
    const count = Math.ceil(extent / level.step);
    if (count > maxBoundariesPerLevel) {
      continue;
    }
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

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function chooseClosestToMidpoint(candidates: number[], midpoint: number): number | null {
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

export function buildCircularScaleBar(
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

export function displayLabelText(raw: string, fallback: string): string {
  const trimmed = raw.trim().replace(/^['"]+|['"]+$/g, "").replaceAll("_", " ");
  return trimmed || fallback;
}

function quoteNewickName(raw: string): string {
  const trimmed = raw.trim().replace(/^['"]+|['"]+$/g, "");
  if (!trimmed) {
    return "";
  }
  if (!/[,\s:;()'"]/.test(trimmed)) {
    return trimmed;
  }
  return `'${trimmed.replace(/'/g, "''")}'`;
}

function formatBranchLength(length: number): string {
  if (!Number.isFinite(length)) {
    return "0";
  }
  return Number(length.toPrecision(12)).toString();
}

export function serializeSubtreeToNewick(tree: TreeModel, node: number): string {
  const serializeNode = (current: number, includeLength: boolean): string => {
    const children: number[] = [];
    let child = tree.buffers.firstChild[current];
    while (child >= 0) {
      children.push(child);
      child = tree.buffers.nextSibling[child];
    }
    const rawName = (tree.names[current] || "").trim().replace(/^['"]+|['"]+$/g, "");
    const safeName = quoteNewickName(rawName);
    const label = /^[+-]?\d+(?:\.\d+)?$/.test(rawName) ? "" : safeName;
    const branch = includeLength ? `:${formatBranchLength(tree.buffers.branchLength[current])}` : "";
    if (children.length === 0) {
      return `${label}${branch}`;
    }
    const body = children.map((descendant) => serializeNode(descendant, true)).join(",");
    return `(${body})${label}${branch}`;
  };
  return `${serializeNode(node, false)};`;
}

export function displayNodeName(tree: TreeModel, node: number): string {
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

export function extractGenusToken(name: string): string | null {
  const match = name.trim().replace(/^['"]+|['"]+$/g, "").match(/^([^_ ]+)[_ ]+/);
  if (!match) {
    return null;
  }
  const token = match[1].trim();
  return token.length >= 2 ? token : null;
}

export function thetaFor(center: Float64Array, node: number, leafCount: number): number {
  if (leafCount <= 0) {
    return 0;
  }
  return (center[node] / leafCount) * (Math.PI * 2);
}

export function wrapPositive(angle: number): number {
  const tau = Math.PI * 2;
  const wrapped = angle % tau;
  return wrapped < 0 ? wrapped + tau : wrapped;
}

export function arcAnglesWithinSpan(
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

export function angleOffsetWithinSpan(angle: number, arcStart: number, arcLength: number): number | null {
  const offset = wrapPositive(angle - arcStart);
  const tolerance = 1e-6;
  if (offset <= arcLength + tolerance) {
    return Math.min(offset, arcLength);
  }
  return null;
}

export function arcSubspanWithinSpan(
  angleA: number,
  angleB: number,
  arcStart: number,
  arcLength: number,
): { start: number; end: number; length: number } | null {
  const offsetA = angleOffsetWithinSpan(angleA, arcStart, arcLength);
  const offsetB = angleOffsetWithinSpan(angleB, arcStart, arcLength);
  if (offsetA === null || offsetB === null) {
    return null;
  }
  const start = Math.min(offsetA, offsetB);
  const end = Math.max(offsetA, offsetB);
  return {
    start: arcStart + start,
    end: arcStart + end,
    length: end - start,
  };
}

export function pickRectConnectorChild(
  children: number[],
  center: Float64Array,
  parentCenterY: number,
  hoverY: number,
): number | null {
  let bestChild: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const hoverDirection = Math.sign(hoverY - parentCenterY);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const childCenterY = center[child];
    const childDirection = Math.sign(childCenterY - parentCenterY);
    if (hoverDirection !== 0 && childDirection !== 0 && childDirection !== hoverDirection) {
      continue;
    }
    const distance = Math.abs(childCenterY - hoverY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestChild = child;
    }
  }
  if (bestChild !== null) {
    return bestChild;
  }
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const distance = Math.abs(center[child] - hoverY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestChild = child;
    }
  }
  return bestChild;
}

export function pickCircularConnectorChild(
  children: number[],
  center: Float64Array,
  hoverTheta: number,
  ownerTheta: number,
  leafCount: number,
  arcStart: number,
  arcLength: number,
): number | null {
  const ownerOffset = angleOffsetWithinSpan(ownerTheta, arcStart, arcLength);
  const hoverOffset = angleOffsetWithinSpan(hoverTheta, arcStart, arcLength);
  if (ownerOffset === null || hoverOffset === null) {
    return null;
  }
  let bestChild: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const childTheta = thetaFor(center, child, leafCount);
    const childOffset = angleOffsetWithinSpan(childTheta, arcStart, arcLength);
    if (childOffset === null) {
      continue;
    }
    const childDirection = Math.sign(childOffset - ownerOffset);
    const hoverDirection = Math.sign(hoverOffset - ownerOffset);
    if (hoverDirection !== 0 && childDirection !== 0 && childDirection !== hoverDirection) {
      continue;
    }
    const distance = Math.abs(childOffset - hoverOffset);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestChild = child;
    }
  }
  if (bestChild !== null) {
    return bestChild;
  }
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const childOffset = angleOffsetWithinSpan(thetaFor(center, child, leafCount), arcStart, arcLength);
    if (childOffset === null) {
      continue;
    }
    const distance = Math.abs(childOffset - hoverOffset);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestChild = child;
    }
  }
  return bestChild;
}

export function appendCircularArcSegments(
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

export function estimateLabelWidth(fontSize: number, maxCharacters: number): number {
  if (maxCharacters <= 0) {
    return 0;
  }
  return Math.max(fontSize * 1.6, maxCharacters * fontSize * 0.61);
}

export function circularTimeLabelTheta(order: LayoutOrder): number {
  const offset = Math.PI / 36;
  if (order === "asc") {
    return -offset;
  }
  return offset;
}
