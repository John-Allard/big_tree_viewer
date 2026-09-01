import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { buildTaxonomyBlocksForOrderedLeaves, colorForTaxonomy, type TaxonomyColorByRank } from "../lib/taxonomyBlocks";
import { fontFamilyCss, type FigureStyleSettings } from "../lib/figureStyles";
import { buildComparisonLayout, normalizeComparisonTipName } from "../lib/treeComparison";
import { deriveDefaultVisibleTaxonomyRanks } from "../lib/taxonomyActiveRanks";
import { isAutomaticTaxonomyRank, TAXONOMY_RANKS, type TaxonomyMapPayload, type TaxonomyRank } from "../types/taxonomy";
import type { LayoutOrder, TreeModel, ZoomAxisMode } from "../types/tree";
import type { TaxonomyRankDisplayMode } from "./treeCanvasTypes";
import { buildTaxonomyColorMap, taxonomyVisibleRanksForZoom } from "./TreeCanvas";

interface TreeComparisonCanvasProps {
  primaryTree: TreeModel;
  comparisonTree: TreeModel;
  order: LayoutOrder;
  primaryLabel: string;
  comparisonLabel: string;
  incompatiblePrimaryNodes: Set<number>;
  showIncompatibleSplits: boolean;
  connectorSensitivity: number;
  centerWidthScale: number;
  zoomAxisMode: ZoomAxisMode;
  showTipLabels: boolean;
  branchThicknessScale: number;
  figureStyles: FigureStyleSettings;
  taxonomyEnabled: boolean;
  taxonomyBranchColoringEnabled: boolean;
  taxonomyMap: TaxonomyMapPayload | null;
  taxonomyColors: TaxonomyColorByRank | null;
  taxonomyColorJitter: number;
  taxonomyColorPalette: Parameters<typeof buildTaxonomyColorMap>[3];
  taxonomyCustomPaletteColors: string[];
  taxonomyColorRootRank: TaxonomyRank | "auto";
  taxonomyColorJitterRank: TaxonomyRank;
  taxonomyRankDisplayModes: Partial<Record<TaxonomyRank, TaxonomyRankDisplayMode>>;
  taxonomyRankVisibility: Partial<Record<TaxonomyRank, boolean>>;
  useAutomaticTaxonomyRankVisibility: boolean;
  fitRequest: number;
  searchResults: ComparisonSearchResult[];
  searchZoomLocked: boolean;
  searchFocusRequest: number;
  cameraRestoreRequest: number;
  cameraRestoreState: TreeComparisonCameraState | null;
  onCameraChange: (camera: TreeComparisonCameraState) => void;
  onManualCameraInteraction: () => void;
}

export interface ComparisonSearchResult {
  kind: "node" | "genus" | "taxonomy";
  node: number;
  displayName: string;
  tipNodes?: number[];
}

export interface TreeComparisonCameraState {
  zoom: number;
  zoomX: number;
  panX: number;
  panY: number;
}

const TOP_MARGIN = 24;
const BOTTOM_MARGIN = 24;

function comparisonCenterWidth(viewportWidth: number, scale: number): number {
  const minimum = viewportWidth * 0.1;
  const maximum = Math.max(minimum, Math.min(viewportWidth * 0.4, viewportWidth - 96));
  return Math.max(minimum, Math.min(maximum, viewportWidth * 0.4 * Math.max(0.25, Math.min(1, scale))));
}

interface ComparisonTaxonomyHoverHitbox {
  xStart: number;
  xEnd: number;
  yStart: number;
  yEnd: number;
  rank: TaxonomyRank;
  label: string;
  firstNode: number;
  lastNode: number;
  descendantTipCount: number;
}

interface ComparisonHoverGeometry {
  primaryX: (node: number) => number;
  primaryY: (node: number) => number;
  primaryTreeStartX: number;
  primaryTreeEndX: number;
  taxonomyHitboxes: ComparisonTaxonomyHoverHitbox[];
}

interface ComparisonHoverInfo {
  node: number;
  name: string;
  branchLength: number;
  parentAge: number | null;
  childAge: number | null;
  descendantTipCount: number;
  screenX: number;
  screenY: number;
  kind: "node" | "taxonomy";
  taxonomyRank?: TaxonomyRank;
  mrcaAge?: number | null;
}

function pointToSegmentDistance(
  pointX: number,
  pointY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = (deltaX * deltaX) + (deltaY * deltaY);
  if (lengthSquared <= 1e-12) {
    return Math.hypot(pointX - startX, pointY - startY);
  }
  const projection = Math.max(0, Math.min(1,
    (((pointX - startX) * deltaX) + ((pointY - startY) * deltaY)) / lengthSquared,
  ));
  return Math.hypot(
    pointX - (startX + (projection * deltaX)),
    pointY - (startY + (projection * deltaY)),
  );
}

type TaxonomyTip = TaxonomyMapPayload["tipRanks"][number];

function nodeColorsFromTaxonomy(
  tree: TreeModel,
  tipTaxonomy: Map<number, TaxonomyTip>,
  taxonomyColors: TaxonomyColorByRank | null,
): Array<string | null> {
  const colors: Array<string | null> = Array.from({ length: tree.nodeCount }, () => null);
  const representative: Array<TaxonomyTip | null> = Array.from({ length: tree.nodeCount }, () => null);
  const consensusRankIndex = new Int8Array(tree.nodeCount);
  consensusRankIndex.fill(-1);
  const stack: Array<{ node: number; visited: boolean }> = [{ node: tree.root, visited: false }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (!item.visited) {
      stack.push({ node: item.node, visited: true });
      for (let child = tree.buffers.firstChild[item.node]; child >= 0; child = tree.buffers.nextSibling[child]) {
        stack.push({ node: child, visited: false });
      }
      continue;
    }
    if (tree.buffers.firstChild[item.node] < 0) {
      const tip = tipTaxonomy.get(item.node) ?? null;
      representative[item.node] = tip;
      if (tip) {
        for (let rankIndex = TAXONOMY_RANKS.length - 1; rankIndex >= 0; rankIndex -= 1) {
          const rank = TAXONOMY_RANKS[rankIndex];
          const label = tip.ranks[rank];
          if (label) {
            consensusRankIndex[item.node] = rankIndex;
            colors[item.node] = colorForTaxonomy(rank, label, taxonomyColors, tip.taxIds?.[rank] ?? null);
            break;
          }
        }
      }
      continue;
    }
    let currentRepresentative: TaxonomyTip | null = null;
    let currentRankIndex = -1;
    for (let child = tree.buffers.firstChild[item.node]; child >= 0; child = tree.buffers.nextSibling[child]) {
      const childRepresentative = representative[child];
      if (!childRepresentative) {
        continue;
      }
      if (!currentRepresentative) {
        currentRepresentative = childRepresentative;
        currentRankIndex = consensusRankIndex[child];
        continue;
      }
      currentRankIndex = Math.min(currentRankIndex, consensusRankIndex[child]);
      while (currentRankIndex >= 0) {
        const rank = TAXONOMY_RANKS[currentRankIndex];
        const leftLabel = currentRepresentative.ranks[rank];
        const rightLabel = childRepresentative.ranks[rank];
        const leftTaxId = currentRepresentative.taxIds?.[rank] ?? null;
        const rightTaxId = childRepresentative.taxIds?.[rank] ?? null;
        if (leftLabel && rightLabel && leftLabel === rightLabel && leftTaxId === rightTaxId) {
          break;
        }
        currentRankIndex -= 1;
      }
    }
    representative[item.node] = currentRepresentative;
    consensusRankIndex[item.node] = currentRankIndex;
    if (currentRepresentative && currentRankIndex >= 0) {
      const rank = TAXONOMY_RANKS[currentRankIndex];
      const label = currentRepresentative.ranks[rank];
      if (label) {
        colors[item.node] = colorForTaxonomy(
          rank,
          label,
          taxonomyColors,
          currentRepresentative.taxIds?.[rank] ?? null,
        );
      }
    }
  }
  return colors;
}

function discordanceStrength(discordance: number, sensitivity: number): number {
  return Math.min(1, Math.max(0, (discordance * sensitivity) / 0.28));
}

function discordanceColor(discordance: number, opacityScale: number, sensitivity: number): string {
  const strength = discordanceStrength(discordance, sensitivity);
  const red = Math.round(100 + ((239 - 100) * strength));
  const green = Math.round(116 + ((68 - 116) * strength));
  const blue = Math.round(139 + ((68 - 139) * strength));
  const alpha = (0.035 + (0.58 * (strength ** 0.8))) * opacityScale;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function lowestCommonAncestor(tree: TreeModel, nodes: number[]): number | null {
  if (nodes.length === 0) {
    return null;
  }
  let ancestor = nodes[0];
  for (let index = 1; index < nodes.length; index += 1) {
    const ancestors = new Set<number>();
    for (let node = ancestor; node >= 0; node = tree.buffers.parent[node]) {
      ancestors.add(node);
    }
    let node = nodes[index];
    while (node >= 0 && !ancestors.has(node)) {
      node = tree.buffers.parent[node];
    }
    ancestor = node >= 0 ? node : tree.root;
  }
  return ancestor;
}

function pathNodesForTips(tree: TreeModel, tips: number[]): Set<number> {
  const result = new Set<number>();
  const ancestor = lowestCommonAncestor(tree, tips);
  if (ancestor === null) {
    return result;
  }
  result.add(ancestor);
  for (const tip of tips) {
    for (let node = tip; node >= 0; node = tree.buffers.parent[node]) {
      result.add(node);
      if (node === ancestor) {
        break;
      }
    }
  }
  return result;
}

function descendantTips(tree: TreeModel, root: number): number[] {
  const tips: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const firstChild = tree.buffers.firstChild[node];
    if (firstChild < 0) {
      tips.push(node);
      continue;
    }
    for (let child = firstChild; child >= 0; child = tree.buffers.nextSibling[child]) {
      stack.push(child);
    }
  }
  return tips;
}

export default function TreeComparisonCanvas(props: TreeComparisonCanvasProps) {
  const {
    primaryTree,
    comparisonTree,
    order,
    primaryLabel,
    comparisonLabel,
    incompatiblePrimaryNodes,
    showIncompatibleSplits,
    connectorSensitivity,
    centerWidthScale,
    zoomAxisMode,
    showTipLabels,
    branchThicknessScale,
    figureStyles,
    taxonomyEnabled,
    taxonomyBranchColoringEnabled,
    taxonomyMap,
    taxonomyColors: suppliedTaxonomyColors,
    taxonomyColorJitter,
    taxonomyColorPalette,
    taxonomyCustomPaletteColors,
    taxonomyColorRootRank,
    taxonomyColorJitterRank,
    taxonomyRankDisplayModes,
    taxonomyRankVisibility,
    useAutomaticTaxonomyRankVisibility,
    fitRequest,
    searchResults,
    searchZoomLocked,
    searchFocusRequest,
    cameraRestoreRequest,
    cameraRestoreState,
    onCameraChange,
    onManualCameraInteraction,
  } = props;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderDebugRef = useRef<Record<string, unknown> | null>(null);
  const hoverGeometryRef = useRef<ComparisonHoverGeometry | null>(null);
  const hoverTooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverTooltipLabelRef = useRef<HTMLDivElement | null>(null);
  const hoverTooltipBodyRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [camera, setCamera] = useState<TreeComparisonCameraState>({ zoom: 1, zoomX: 1, panX: 0, panY: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);

  const comparison = useMemo(
    () => buildComparisonLayout(primaryTree, comparisonTree, order),
    [comparisonTree, order, primaryTree],
  );
  const primaryLayout = primaryTree.layouts[order];
  const primaryDenominator = Math.max(1, comparison.primaryLeaves.length - 1);
  const comparisonDenominator = Math.max(1, comparison.comparisonLeaves.length - 1);
  const defaultAutomaticRankSet = useMemo(() => new Set(
    taxonomyMap
      ? deriveDefaultVisibleTaxonomyRanks(
        taxonomyMap.tipRanks.map((tip) => tip.ranks),
        taxonomyMap.activeRanks,
      )
      : [],
  ), [taxonomyMap]);
  const availableRanks = useMemo(() => {
    if (!taxonomyEnabled || !taxonomyMap) {
      return [] as TaxonomyRank[];
    }
    return [...taxonomyMap.activeRanks]
      .filter((rank) => useAutomaticTaxonomyRankVisibility
        ? (isAutomaticTaxonomyRank(rank) && defaultAutomaticRankSet.has(rank))
          || (taxonomyRankDisplayModes.kingdom ?? "hidden") === "ribbon"
        : (taxonomyRankDisplayModes[rank] ?? (taxonomyRankVisibility[rank] === false ? "hidden" : "ribbon")) === "ribbon")
      .sort((left, right) => TAXONOMY_RANKS.indexOf(right) - TAXONOMY_RANKS.indexOf(left));
  }, [defaultAutomaticRankSet, taxonomyEnabled, taxonomyMap, taxonomyRankDisplayModes, taxonomyRankVisibility, useAutomaticTaxonomyRankVisibility]);
  const activeRanks = useMemo(() => {
    if (!useAutomaticTaxonomyRankVisibility || availableRanks.length === 0) {
      return availableRanks;
    }
    const fitRadiusPx = Math.min(size.width, size.height) * 0.44;
    const fitPolarTipSpacingPx = (fitRadiusPx * Math.PI * 2) / Math.max(1, comparison.primaryLeaves.length);
    return taxonomyVisibleRanksForZoom(fitPolarTipSpacingPx * camera.zoom, availableRanks);
  }, [availableRanks, camera.zoom, comparison.primaryLeaves.length, size.height, size.width, useAutomaticTaxonomyRankVisibility]);
  const fallbackTaxonomyColors = useMemo<TaxonomyColorByRank | null>(() => taxonomyMap
    ? buildTaxonomyColorMap(
      taxonomyMap,
      new Map(),
      taxonomyColorJitter,
      taxonomyColorPalette,
      taxonomyCustomPaletteColors,
      taxonomyColorRootRank,
      taxonomyColorJitterRank,
    )
    : null, [
    taxonomyColorJitter,
    taxonomyColorJitterRank,
    taxonomyColorPalette,
    taxonomyColorRootRank,
    taxonomyCustomPaletteColors,
    taxonomyMap,
  ]);
  const taxonomyColors = suppliedTaxonomyColors ?? fallbackTaxonomyColors;
  const taxonomyBlocks = useMemo(() => taxonomyMap
    ? buildTaxonomyBlocksForOrderedLeaves(comparison.primaryLeaves, taxonomyMap, taxonomyColors)
    : null, [comparison.primaryLeaves, taxonomyColors, taxonomyMap]);
  const primaryTipTaxonomy = useMemo(() => new Map(
    taxonomyMap?.tipRanks.map((tip) => [tip.node, tip] as const) ?? [],
  ), [taxonomyMap]);
  const primaryNodeColors = useMemo(
    () => nodeColorsFromTaxonomy(primaryTree, primaryTipTaxonomy, taxonomyColors),
    [primaryTipTaxonomy, primaryTree, taxonomyColors],
  );
  const comparisonNodeColors = useMemo(() => {
    const primaryTaxonomyByName = new Map<string, TaxonomyTip>();
    comparison.primaryLeaves.forEach((node) => {
      const tip = primaryTipTaxonomy.get(node);
      if (tip) {
        primaryTaxonomyByName.set(normalizeComparisonTipName(primaryTree.names[node] ?? ""), tip);
      }
    });
    const tipTaxonomy = new Map<number, TaxonomyTip>();
    comparison.comparisonLeaves.forEach((node) => {
      const tip = primaryTaxonomyByName.get(normalizeComparisonTipName(comparisonTree.names[node] ?? ""));
      if (tip) {
        tipTaxonomy.set(node, tip);
      }
    });
    return nodeColorsFromTaxonomy(comparisonTree, tipTaxonomy, taxonomyColors);
  }, [comparison.comparisonLeaves, comparison.primaryLeaves, comparisonTree, primaryTipTaxonomy, primaryTree.names, taxonomyColors]);
  const primaryLeafPosition = useMemo(() => new Map(
    comparison.primaryLeaves.map((node, index) => [node, index] as const),
  ), [comparison.primaryLeaves]);
  const comparisonLeafByName = useMemo(() => new Map(
    comparison.comparisonLeaves.map((node) => [normalizeComparisonTipName(comparisonTree.names[node] ?? ""), node] as const),
  ), [comparison.comparisonLeaves, comparisonTree.names]);
  const highlightedTips = useMemo(() => {
    const primaryTips = new Set<number>();
    searchResults.forEach((result) => {
      if (result.tipNodes?.length) {
        result.tipNodes.forEach((node) => primaryTips.add(node));
      } else if (primaryTree.buffers.firstChild[result.node] < 0) {
        primaryTips.add(result.node);
      } else {
        descendantTips(primaryTree, result.node).forEach((node) => primaryTips.add(node));
      }
    });
    const comparisonTips = new Set<number>();
    const names = new Set<string>();
    primaryTips.forEach((node) => {
      const name = normalizeComparisonTipName(primaryTree.names[node] ?? "");
      if (!name) {
        return;
      }
      names.add(name);
      const comparisonNode = comparisonLeafByName.get(name);
      if (comparisonNode !== undefined) {
        comparisonTips.add(comparisonNode);
      }
    });
    return {
      names,
      primary: primaryTips,
      comparison: comparisonTips,
      primaryPath: pathNodesForTips(primaryTree, [...primaryTips]),
      comparisonPath: pathNodesForTips(comparisonTree, [...comparisonTips]),
    };
  }, [comparisonLeafByName, comparisonTree, primaryTree, searchResults]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }
    const update = () => setSize({ width: Math.max(1, wrapper.clientWidth), height: Math.max(1, wrapper.clientHeight) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setCamera({ zoom: 1, zoomX: 1, panX: 0, panY: 0 }), [comparisonTree, primaryTree]);
  useEffect(() => setCamera({ zoom: 1, zoomX: 1, panX: 0, panY: 0 }), [fitRequest]);
  useEffect(() => {
    if (cameraRestoreRequest <= 0 || !cameraRestoreState) {
      return;
    }
    setCamera({
      zoom: Math.max(1, Math.min(2_000, cameraRestoreState.zoom)),
      zoomX: Math.max(1, Math.min(2_000, cameraRestoreState.zoomX ?? 1)),
      panX: Number.isFinite(cameraRestoreState.panX) ? cameraRestoreState.panX : 0,
      panY: Number.isFinite(cameraRestoreState.panY) ? cameraRestoreState.panY : 0,
    });
  }, [cameraRestoreRequest, cameraRestoreState]);
  useEffect(() => {
    onCameraChange(camera);
  }, [camera, onCameraChange]);

  const screenY = useCallback((position: number): number => {
    const usable = Math.max(1, size.height - TOP_MARGIN - BOTTOM_MARGIN);
    return (size.height / 2) + ((position - 0.5) * usable * camera.zoom) + camera.panY;
  }, [camera.panY, camera.zoom, size.height]);

  useEffect(() => {
    if (!searchZoomLocked || searchResults.length === 0 || highlightedTips.primary.size === 0) {
      return;
    }
    const positions = [...highlightedTips.primary]
      .map((node) => primaryLeafPosition.get(node))
      .filter((position): position is number => position !== undefined)
      .map((position) => position / primaryDenominator);
    if (positions.length === 0) {
      return;
    }
    const minimum = Math.min(...positions);
    const maximum = Math.max(...positions);
    const span = Math.max(1 / primaryDenominator, maximum - minimum);
    const zoom = Math.max(1, Math.min(2_000, 0.68 / span));
    const usable = Math.max(1, size.height - TOP_MARGIN - BOTTOM_MARGIN);
    const center = (minimum + maximum) / 2;
    const panY = -((center - 0.5) * usable * zoom);
    const maximumPan = Math.max(0, ((zoom - 1) * usable) / 2 + usable * 0.46);
    setCamera((current) => ({
      ...current,
      zoom,
      panY: Math.max(-maximumPan, Math.min(maximumPan, panY)),
    }));
  }, [highlightedTips.primary, primaryDenominator, primaryLeafPosition, searchFocusRequest, searchResults.length, searchZoomLocked, size.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);

    const ribbonWidth = Math.max(4, 9 * (figureStyles.taxonomy.bandThicknessScale ?? 1));
    const ribbonGap = Math.max(0.5, Math.min(2, ribbonWidth * 0.08));
    const rankWidths = activeRanks.map((_, index) => (
      figureStyles.taxonomy.thickenOutermostRibbon !== false && index === activeRanks.length - 1
        ? ribbonWidth * 1.45
        : ribbonWidth
    ));
    const rankOffsets: number[] = [];
    let ribbonsWidth = 0;
    rankWidths.forEach((width, index) => {
      rankOffsets.push(ribbonsWidth);
      ribbonsWidth += width + (index < rankWidths.length - 1 ? ribbonGap : 0);
    });
    const effectiveCenterWidthScale = Math.max(0.25, Math.min(1, centerWidthScale));
    const centerWidth = comparisonCenterWidth(size.width, effectiveCenterWidthScale);
    const fitPrimaryTipX = (size.width - centerWidth) / 2;
    const fitComparisonTipX = size.width - fitPrimaryTipX;
    const viewportCenterX = size.width / 2;
    const transformX = (x: number) => viewportCenterX + ((x - viewportCenterX) * camera.zoomX) + camera.panX;
    const unshiftedPrimaryTipX = transformX(fitPrimaryTipX);
    const unshiftedComparisonTipX = transformX(fitComparisonTipX);
    const primaryY = (node: number) => screenY(primaryLayout.center[node] / primaryDenominator);
    const secondaryY = (node: number) => screenY(comparison.comparisonCenter[node] / comparisonDenominator);
    const visible = (y: number) => y >= -8 && y <= size.height + 8;
    const maxLeafCount = Math.max(comparison.primaryLeaves.length, comparison.comparisonLeaves.length);
    const pixelsPerTip = ((size.height - TOP_MARGIN - BOTTOM_MARGIN) * camera.zoom) / Math.max(1, maxLeafCount - 1);
    const labelsVisible = showTipLabels && pixelsPerTip >= 9;
    const labelSpaceProgress = showTipLabels ? Math.max(0, Math.min(1, (pixelsPerTip - 7) / 2)) : 0;
    const tipFontSize = Math.max(9, Math.min(15, 11 * figureStyles.tip.sizeScale));
    context.font = `${figureStyles.tip.italic ? "italic " : ""}${figureStyles.tip.bold ? "700 " : ""}${tipFontSize}px ${fontFamilyCss(figureStyles.tip.fontFamily)}`;
    context.textBaseline = "middle";
    const maximumLabelWidth = (tree: TreeModel, leaves: number[], yForNode: (node: number) => number): number => {
      let maximum = 8;
      for (const node of leaves) {
        if (!visible(yForNode(node))) {
          continue;
        }
        maximum = Math.max(maximum, context.measureText(
          (tree.names[node] || "Unnamed tip").replaceAll("_", " "),
        ).width);
      }
      return figureStyles.tip.limitWidth
        ? Math.min(maximum, Math.max(40, figureStyles.tip.maxWidthPx ?? 240))
        : maximum;
    };
    const primaryLabelWidth = labelSpaceProgress > 0
      ? maximumLabelWidth(primaryTree, comparison.primaryLeaves, primaryY)
      : 0;
    const comparisonLabelWidth = labelSpaceProgress > 0
      ? maximumLabelWidth(comparisonTree, comparison.comparisonLeaves, secondaryY)
      : 0;
    const primaryTreeDisplacement = ribbonsWidth + ((primaryLabelWidth + 4) * labelSpaceProgress);
    const comparisonTreeDisplacement = (comparisonLabelWidth + 4) * labelSpaceProgress;
    const primaryTipX = unshiftedPrimaryTipX - primaryTreeDisplacement;
    const primaryRibbonEndX = primaryTipX + ribbonsWidth;
    const comparisonTipX = unshiftedComparisonTipX + comparisonTreeDisplacement;
    const connectorStartX = unshiftedPrimaryTipX + 3;
    const connectorEndX = unshiftedComparisonTipX - 3;
    const connectorCenterX = (connectorStartX + connectorEndX) / 2;
    const primaryLabelEndX = connectorStartX - 3;
    const primaryLabelStartX = primaryLabelEndX - primaryLabelWidth;
    const comparisonLabelStartX = connectorEndX + 3;
    const comparisonLabelEndX = comparisonLabelStartX + comparisonLabelWidth;
    const fitPrimaryRootX = 24;
    const fitComparisonRootX = size.width - 24;
    const primaryRootX = transformX(fitPrimaryRootX) - primaryTreeDisplacement;
    const comparisonRootX = transformX(fitComparisonRootX) + comparisonTreeDisplacement;
    const branchWidth = Math.max(0.45, branchThicknessScale);
    const primaryDepthSpan = Math.max(1e-12, primaryTree.maxDepth - primaryTree.buffers.depth[primaryTree.root]);
    const comparisonDepthSpan = Math.max(1e-12, comparisonTree.maxDepth - comparisonTree.buffers.depth[comparisonTree.root]);
    const fitPrimaryX = (node: number) => fitPrimaryRootX
      + ((primaryTree.buffers.depth[node] - primaryTree.buffers.depth[primaryTree.root]) / primaryDepthSpan) * (fitPrimaryTipX - fitPrimaryRootX);
    const fitComparisonX = (node: number) => fitComparisonRootX
      - ((comparisonTree.buffers.depth[node] - comparisonTree.buffers.depth[comparisonTree.root]) / comparisonDepthSpan) * (fitComparisonRootX - fitComparisonTipX);
    const primaryX = (node: number) => transformX(fitPrimaryX(node)) - primaryTreeDisplacement;
    const comparisonX = (node: number) => transformX(fitComparisonX(node)) + comparisonTreeDisplacement;

    const drawTree = (
      tree: TreeModel,
      xForNode: (node: number) => number,
      yForNode: (node: number) => number,
      colors: Array<string | null>,
    ) => {
      const paths = new Map<string, Path2D>();
      const pathFor = (color: string) => {
        let path = paths.get(color);
        if (!path) {
          path = new Path2D();
          paths.set(color, path);
        }
        return path;
      };
      for (let node = 0; node < tree.nodeCount; node += 1) {
        const parent = tree.buffers.parent[node];
        if (parent < 0) {
          continue;
        }
        const y = yForNode(node);
        const parentY = yForNode(parent);
        if (!visible(y) && !visible(parentY) && (y < 0) === (parentY < 0)) {
          continue;
        }
        const path = pathFor(colors[node] ?? "#4b5563");
        path.moveTo(xForNode(parent), parentY);
        path.lineTo(xForNode(parent), y);
        path.lineTo(xForNode(node), y);
      }
      paths.forEach((path, color) => {
        context.strokeStyle = color;
        context.lineWidth = branchWidth;
        context.stroke(path);
      });
    };

    drawTree(primaryTree, primaryX, primaryY, taxonomyBranchColoringEnabled ? primaryNodeColors : []);
    drawTree(comparisonTree, comparisonX, secondaryY, taxonomyBranchColoringEnabled ? comparisonNodeColors : []);

    let renderedIncompatibleSplitMarkerCount = 0;
    if (showIncompatibleSplits && incompatiblePrimaryNodes.size > 0) {
      context.save();
      context.strokeStyle = "rgba(220, 38, 38, 0.92)";
      context.lineWidth = 1.6;
      const markerRadius = 3.6;
      const candidates = [...incompatiblePrimaryNodes].flatMap((node) => {
        const parent = primaryTree.buffers.parent[node];
        if (parent < 0) return [];
        const y = primaryY(node);
        if (!visible(y)) return [];
        const x = (primaryX(parent) + primaryX(node)) / 2;
        if (x < 0 || x > size.width) return [];
        return [{ x, y }];
      });
      for (const { x, y } of candidates) {
        context.beginPath();
        context.moveTo(x - markerRadius, y - markerRadius);
        context.lineTo(x + markerRadius, y + markerRadius);
        context.moveTo(x + markerRadius, y - markerRadius);
        context.lineTo(x - markerRadius, y + markerRadius);
        context.stroke();
        renderedIncompatibleSplitMarkerCount += 1;
      }
      context.restore();
    }

    const taxonomyHoverHitboxes: ComparisonTaxonomyHoverHitbox[] = [];
    if (taxonomyBlocks) {
      activeRanks.forEach((rank, rankIndex) => {
        const rankWidth = rankWidths[rankIndex];
        const x = primaryTipX + rankOffsets[rankIndex];
        for (const block of taxonomyBlocks[rank]) {
          const segments = block.segments ?? [{
            firstNode: block.firstNode,
            lastNode: block.lastNode,
            startIndex: block.startIndex ?? 0,
            endIndex: block.endIndex ?? 0,
          }];
          context.fillStyle = block.color;
          for (const segment of segments) {
            const top = screenY((segment.startIndex - 0.5) / primaryDenominator);
            const bottom = screenY((segment.endIndex - 0.5) / primaryDenominator);
            if (bottom < 0 || top > size.height) {
              continue;
            }
            const height = Math.max(1, bottom - top);
            context.fillRect(x, top, rankWidth, height);
            taxonomyHoverHitboxes.push({
              xStart: x,
              xEnd: x + rankWidth,
              yStart: top,
              yEnd: bottom,
              rank,
              label: block.label,
              firstNode: segment.firstNode,
              lastNode: segment.lastNode,
              descendantTipCount: Math.max(1, segment.endIndex - segment.startIndex + 1),
            });
            if (height > 28 && rankWidth >= 5) {
              context.save();
              context.beginPath();
              context.rect(x, top, rankWidth, height);
              context.clip();
              context.translate(x + (rankWidth / 2), (top + bottom) / 2);
              context.rotate(Math.PI / 2);
              context.fillStyle = "#111827";
              const labelFontSize = Math.max(3, Math.min(
                32 * figureStyles.taxonomy.sizeScale,
                rankWidth - 2,
              ));
              context.font = `${labelFontSize}px ${fontFamilyCss(figureStyles.taxonomy.fontFamily)}`;
              context.textAlign = "center";
              context.textBaseline = "middle";
              context.fillText(block.label, 0, 0, Math.max(1, height - 8));
              context.restore();
            }
          }
        }
      });
    }

    hoverGeometryRef.current = {
      primaryX,
      primaryY,
      primaryTreeStartX: primaryRootX,
      primaryTreeEndX: primaryTipX,
      taxonomyHitboxes: taxonomyHoverHitboxes,
    };

    const connectorEndpointsVisible = connectorStartX + 6 < connectorEndX;
    context.font = `${figureStyles.tip.italic ? "italic " : ""}${figureStyles.tip.bold ? "700 " : ""}${tipFontSize}px ${fontFamilyCss(figureStyles.tip.fontFamily)}`;
    context.textBaseline = "middle";
    const firstPrimaryLeaf = comparison.primaryLeaves[0] ?? -1;
    const firstPrimaryLeafParent = firstPrimaryLeaf >= 0 ? primaryTree.buffers.parent[firstPrimaryLeaf] : -1;
    renderDebugRef.current = {
      labelsVisible,
      primaryRootX,
      primaryTipX,
      primaryRibbonEndX,
      primaryLabelStartX,
      primaryLabelEndX,
      connectorStartX,
      connectorEndX,
      connectorEndpointsVisible,
      comparisonLabelStartX,
      comparisonLabelEndX,
      comparisonTipX,
      comparisonRootX,
      connectorCenterX,
      activeRankCount: activeRanks.length,
      ribbonWidth,
      ribbonsWidth,
      maximumTaxonomyLabelFontSize: activeRanks.length > 0
        ? Math.max(...rankWidths.map((width) => Math.max(3, Math.min(32 * figureStyles.taxonomy.sizeScale, width - 2))))
        : 0,
      maximumTaxonomyLabelOverflow: activeRanks.length > 0
        ? Math.max(...rankWidths.map((width) => Math.max(3, Math.min(32 * figureStyles.taxonomy.sizeScale, width - 2)) - width))
        : 0,
      taxonomyColorsAvailable: taxonomyColors !== null,
      maximumDiscordance: comparison.commonPairs.reduce(
        (maximum, pair) => Math.max(maximum, pair.discordance),
        0,
      ),
      sharedTipCount: comparison.commonPairs.length,
      primaryOnlyCount: comparison.primaryOnlyCount,
      comparisonOnlyCount: comparison.comparisonOnlyCount,
      incompatibleSplitMarkerCount: renderedIncompatibleSplitMarkerCount,
      incompatibleSplitCandidateCount: showIncompatibleSplits ? incompatiblePrimaryNodes.size : 0,
      centerWidth,
      centerWidthScale: effectiveCenterWidthScale,
      connectorSensitivity,
      pixelsPerTip,
      labelSpaceProgress,
      primaryTreeDisplacement,
      comparisonTreeDisplacement,
      primaryBranchHoverPoint: firstPrimaryLeafParent >= 0 ? {
        x: (primaryX(firstPrimaryLeafParent) + primaryX(firstPrimaryLeaf)) / 2,
        y: primaryY(firstPrimaryLeaf),
      } : null,
      taxonomyHoverPoint: taxonomyHoverHitboxes.length > 0 ? {
        x: (taxonomyHoverHitboxes[0].xStart + taxonomyHoverHitboxes[0].xEnd) / 2,
        y: (
          Math.max(0, taxonomyHoverHitboxes[0].yStart)
          + Math.min(size.height, taxonomyHoverHitboxes[0].yEnd)
        ) / 2,
      } : null,
    };
    const orderedPairs = comparison.commonPairs
      .filter((pair) => {
        const leftY = screenY(pair.primaryPosition);
        const rightY = screenY(pair.comparisonPosition);
        return visible(leftY) || visible(rightY) || (leftY < 0) !== (rightY < 0);
      })
      .sort((left, right) => left.discordance - right.discordance);
    const connectorOpacityScale = Math.min(1, Math.sqrt(50 / Math.max(1, orderedPairs.length)));
    for (const pair of connectorEndpointsVisible ? orderedPairs : []) {
      const leftY = screenY(pair.primaryPosition);
      const rightY = screenY(pair.comparisonPosition);
      if (!visible(leftY) && !visible(rightY) && (leftY < 0) === (rightY < 0)) {
        continue;
      }
      context.beginPath();
      context.moveTo(connectorStartX, leftY);
      context.lineTo(connectorEndX, rightY);
      const strength = discordanceStrength(pair.discordance, connectorSensitivity);
      context.strokeStyle = discordanceColor(pair.discordance, connectorOpacityScale, connectorSensitivity);
      context.lineWidth = 0.7 + (strength * 0.8);
      context.stroke();
    }

    if (labelsVisible) {
      const drawLabel = (text: string, x: number, y: number, maxWidth: number, align: CanvasTextAlign, highlighted: boolean) => {
        context.save();
        context.beginPath();
        context.rect(align === "left" ? x : x - maxWidth, y - (tipFontSize * 0.65), maxWidth, tipFontSize * 1.3);
        context.clip();
        let fontSize = tipFontSize;
        const fontPrefix = `${figureStyles.tip.italic ? "italic " : ""}${highlighted || figureStyles.tip.bold ? "700 " : ""}`;
        context.font = `${fontPrefix}${fontSize}px ${fontFamilyCss(figureStyles.tip.fontFamily)}`;
        const measured = context.measureText(text).width;
        if (measured > maxWidth) {
          fontSize = Math.max(7, fontSize * (maxWidth / measured));
          context.font = `${fontPrefix}${fontSize}px ${fontFamilyCss(figureStyles.tip.fontFamily)}`;
        }
        context.fillStyle = highlighted ? "#1d4ed8" : "#111827";
        context.textAlign = align;
        context.fillText(text, x, y);
        context.restore();
      };
      comparison.primaryLeaves.forEach((node) => {
        const y = primaryY(node);
        if (visible(y)) {
          drawLabel(
            (primaryTree.names[node] || "Unnamed tip").replaceAll("_", " "),
            primaryLabelStartX,
            y,
            Math.max(1, primaryLabelEndX - primaryLabelStartX),
            "left",
            highlightedTips.primary.has(node),
          );
        }
      });
      comparison.comparisonLeaves.forEach((node) => {
        const y = secondaryY(node);
        if (visible(y)) {
          drawLabel(
            (comparisonTree.names[node] || "Unnamed tip").replaceAll("_", " "),
            comparisonLabelEndX,
            y,
            Math.max(1, comparisonLabelEndX - comparisonLabelStartX),
            "right",
            highlightedTips.comparison.has(node),
          );
        }
      });
    }

    const drawHighlightedPath = (
      tree: TreeModel,
      nodes: Set<number>,
      xForNode: (node: number) => number,
      yForNode: (node: number) => number,
    ) => {
      if (nodes.size === 0) {
        return;
      }
      context.beginPath();
      nodes.forEach((node) => {
        const parent = tree.buffers.parent[node];
        if (parent < 0 || !nodes.has(parent)) {
          return;
        }
        const y = yForNode(node);
        context.moveTo(xForNode(parent), yForNode(parent));
        context.lineTo(xForNode(parent), y);
        context.lineTo(xForNode(node), y);
      });
      context.strokeStyle = "rgba(29, 78, 216, 0.9)";
      context.lineWidth = Math.max(2, branchWidth * 1.8);
      context.stroke();
    };
    drawHighlightedPath(primaryTree, highlightedTips.primaryPath, primaryX, primaryY);
    drawHighlightedPath(comparisonTree, highlightedTips.comparisonPath, comparisonX, secondaryY);
    if (connectorEndpointsVisible && highlightedTips.names.size > 0) {
      for (const pair of comparison.commonPairs) {
        if (!highlightedTips.names.has(normalizeComparisonTipName(pair.name))) {
          continue;
        }
        context.beginPath();
        context.moveTo(connectorStartX, screenY(pair.primaryPosition));
        context.lineTo(connectorEndX, screenY(pair.comparisonPosition));
        context.strokeStyle = "rgba(29, 78, 216, 0.78)";
        context.lineWidth = 1.8;
        context.stroke();
      }
    }

    context.font = "600 12px Arial, sans-serif";
    context.fillStyle = "#334155";
    context.textBaseline = "top";
    context.textAlign = "left";
    context.fillText(primaryLabel, primaryRootX, 6);
    context.textAlign = "right";
    context.fillText(comparisonLabel, comparisonRootX, 6);
  }, [
    activeRanks,
    branchThicknessScale,
    camera.panX,
    camera.zoomX,
    camera.zoom,
    centerWidthScale,
    comparison,
    comparisonDenominator,
    comparisonLabel,
    comparisonNodeColors,
    comparisonTree,
    connectorSensitivity,
    figureStyles,
    highlightedTips,
    incompatiblePrimaryNodes,
    primaryDenominator,
    primaryLabel,
    primaryLayout.center,
    primaryNodeColors,
    primaryTree,
    screenY,
    showTipLabels,
    showIncompatibleSplits,
    size.height,
    size.width,
    taxonomyBlocks,
    taxonomyBranchColoringEnabled,
    taxonomyColors,
  ]);

  useEffect(() => {
    window.__BIG_TREE_VIEWER_COMPARISON_TEST__ = {
      getState: () => ({
        camera,
        highlightedPrimaryTips: highlightedTips.primary.size,
        highlightedComparisonTips: highlightedTips.comparison.size,
        highlightedNames: highlightedTips.names.size,
        ...renderDebugRef.current,
      }),
    };
    return () => {
      delete window.__BIG_TREE_VIEWER_COMPARISON_TEST__;
    };
  }, [camera, highlightedTips]);

  const clampPan = useCallback((zoom: number, panY: number) => {
    const usable = Math.max(1, size.height - TOP_MARGIN - BOTTOM_MARGIN);
    const maximum = Math.max(0, ((zoom - 1) * usable) / 2 + usable * 0.46);
    return Math.max(-maximum, Math.min(maximum, panY));
  }, [size.height]);
  const clampHorizontalPan = useCallback((zoomX: number, panX: number): number => {
    if (size.width <= 48) {
      return panX;
    }
    const viewportCenter = size.width / 2;
    const fitMargin = 24;
    const transformedLeftEdge = viewportCenter + ((24 - viewportCenter) * zoomX);
    const transformedRightEdge = viewportCenter + (((size.width - 24) - viewportCenter) * zoomX);
    const minimum = fitMargin - transformedRightEdge;
    const maximum = size.width - fitMargin - transformedLeftEdge;
    return Math.max(minimum, Math.min(maximum, panX));
  }, [size.width]);
  useEffect(() => {
    setCamera((current) => {
      const panX = clampHorizontalPan(current.zoomX, current.panX);
      return panX === current.panX ? current : { ...current, panX };
    });
  }, [clampHorizontalPan]);

  const updateHoverTooltip = useCallback((hover: ComparisonHoverInfo | null): void => {
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
      appendLine(`MRCA age: ${hover.mrcaAge === null || hover.mrcaAge === undefined ? "n/a" : hover.mrcaAge.toPrecision(5)}`);
    } else {
      if (primaryTree.buffers.firstChild[hover.node] >= 0) {
        appendLine(`Descendant tips: ${hover.descendantTipCount.toLocaleString()}`);
      }
      appendLine(`Branch length: ${hover.branchLength.toPrecision(5)}`);
      appendLine(`Parent age: ${hover.parentAge === null ? "n/a" : hover.parentAge.toPrecision(5)}`);
      appendLine(`Child age: ${hover.childAge === null ? "n/a" : hover.childAge.toPrecision(5)}`);
    }
    tooltip.style.left = `${Math.max(8, Math.min(size.width - 220, hover.screenX + 16))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(size.height - 90, hover.screenY + 16))}px`;
    tooltip.hidden = false;
  }, [primaryTree, size.height, size.width]);

  const hitTestPrimaryTree = useCallback((localX: number, localY: number): ComparisonHoverInfo | null => {
    const geometry = hoverGeometryRef.current;
    if (!geometry || localX < 0 || localX > size.width) {
      return null;
    }
    const taxonomyHitbox = geometry.taxonomyHitboxes.find((hitbox) => (
      localX >= hitbox.xStart
      && localX <= hitbox.xEnd
      && localY >= hitbox.yStart
      && localY <= hitbox.yEnd
    ));
    if (taxonomyHitbox) {
      const node = lowestCommonAncestor(primaryTree, [taxonomyHitbox.firstNode, taxonomyHitbox.lastNode])
        ?? taxonomyHitbox.firstNode;
      const mrcaAge = primaryTree.isUltrametric
        ? Math.max(0, primaryTree.rootAge - primaryTree.buffers.depth[node])
        : null;
      return {
        node,
        name: taxonomyHitbox.label,
        branchLength: primaryTree.buffers.branchLength[node],
        parentAge: null,
        childAge: mrcaAge,
        descendantTipCount: taxonomyHitbox.descendantTipCount,
        screenX: localX,
        screenY: localY,
        kind: "taxonomy",
        taxonomyRank: taxonomyHitbox.rank,
        mrcaAge,
      };
    }
    const primaryStartX = Math.min(geometry.primaryTreeStartX, geometry.primaryTreeEndX);
    const primaryEndX = Math.max(geometry.primaryTreeStartX, geometry.primaryTreeEndX);
    if (localX < primaryStartX - 6 || localX > primaryEndX + 6) {
      return null;
    }

    const usable = Math.max(1, size.height - TOP_MARGIN - BOTTOM_MARGIN);
    const normalizedPosition = 0.5 + ((localY - (size.height / 2) - camera.panY) / (usable * camera.zoom));
    const targetIndex = normalizedPosition * primaryDenominator;
    const nearbyNodes = new Set<number>();
    const nearestIndex = Math.round(targetIndex);
    for (let offset = -4; offset <= 4; offset += 1) {
      const leafIndex = Math.max(0, Math.min(comparison.primaryLeaves.length - 1, nearestIndex + offset));
      let node = comparison.primaryLeaves[leafIndex];
      while (node >= 0 && !nearbyNodes.has(node)) {
        nearbyNodes.add(node);
        node = primaryTree.buffers.parent[node];
      }
    }

    let bestNode = -1;
    let bestDistance = Math.max(5, branchThicknessScale + 3);
    for (const node of nearbyNodes) {
      const parent = primaryTree.buffers.parent[node];
      if (parent < 0) {
        continue;
      }
      const parentX = geometry.primaryX(parent);
      const parentY = geometry.primaryY(parent);
      const nodeX = geometry.primaryX(node);
      const nodeY = geometry.primaryY(node);
      const distance = Math.min(
        pointToSegmentDistance(localX, localY, parentX, parentY, parentX, nodeY),
        pointToSegmentDistance(localX, localY, parentX, nodeY, nodeX, nodeY),
      );
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestNode = node;
      }
    }
    if (bestNode < 0) {
      return null;
    }
    const parent = primaryTree.buffers.parent[bestNode];
    const nodeName = primaryTree.names[bestNode]?.trim();
    return {
      node: bestNode,
      name: nodeName ? nodeName.replaceAll("_", " ") : "Internal node",
      branchLength: primaryTree.buffers.branchLength[bestNode],
      parentAge: parent >= 0 && primaryTree.isUltrametric
        ? Math.max(0, primaryTree.rootAge - primaryTree.buffers.depth[parent])
        : null,
      childAge: primaryTree.isUltrametric
        ? Math.max(0, primaryTree.rootAge - primaryTree.buffers.depth[bestNode])
        : null,
      descendantTipCount: primaryTree.buffers.leafCount[bestNode],
      screenX: localX,
      screenY: localY,
      kind: "node",
    };
  }, [branchThicknessScale, camera.panY, camera.zoom, comparison.primaryLeaves, primaryDenominator, primaryTree, size.height, size.width]);

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    updateHoverTooltip(null);
    if (searchZoomLocked) {
      onManualCameraInteraction();
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    setCamera((current) => {
      const factor = Math.exp(-event.deltaY * 0.0015);
      const nextZoom = zoomAxisMode === "x"
        ? current.zoom
        : Math.max(1, Math.min(2_000, current.zoom * factor));
      const nextZoomX = zoomAxisMode === "y"
        ? current.zoomX
        : Math.max(1, Math.min(2_000, current.zoomX * factor));
      const center = size.height / 2;
      const nextPan = zoomAxisMode === "x"
        ? current.panY
        : cursorY - center - ((cursorY - center - current.panY) * (nextZoom / current.zoom));
      const centerX = size.width / 2;
      const nextPanX = zoomAxisMode === "y"
        ? current.panX
        : nextZoomX === 1 && current.zoomX > 1
          ? 0
        : cursorX - centerX - ((cursorX - centerX - current.panX) * (nextZoomX / current.zoomX));
      return {
        zoom: nextZoom,
        zoomX: nextZoomX,
        panX: clampHorizontalPan(nextZoomX, nextPanX),
        panY: clampPan(nextZoom, nextPan),
      };
    });
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    updateHoverTooltip(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: camera.panX,
      startPanY: camera.panY,
    };
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      const rect = event.currentTarget.getBoundingClientRect();
      updateHoverTooltip(hitTestPrimaryTree(event.clientX - rect.left, event.clientY - rect.top));
      return;
    }
    if (drag.pointerId !== event.pointerId) {
      return;
    }
    if (searchZoomLocked && (event.clientX !== drag.startX || event.clientY !== drag.startY)) {
      onManualCameraInteraction();
    }
    setCamera((current) => ({
      ...current,
      panX: clampHorizontalPan(current.zoomX, drag.startPanX + event.clientX - drag.startX),
      panY: clampPan(current.zoom, drag.startPanY + event.clientY - drag.startY),
    }));
  };
  const stopDragging = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const handlePointerLeave = () => {
    if (!dragRef.current) {
      updateHoverTooltip(null);
    }
  };

  return (
    <div ref={wrapperRef} className="tree-canvas-shell tree-comparison-shell">
      <canvas
        ref={canvasRef}
        aria-label="Tree comparison view"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onPointerLeave={handlePointerLeave}
      />
      <div ref={hoverTooltipRef} className="hover-tooltip" hidden>
        <div ref={hoverTooltipLabelRef} className="hover-tooltip-label" />
        <div ref={hoverTooltipBodyRef} />
      </div>
      <div className="tree-comparison-summary">
        {comparison.commonPairs.length.toLocaleString()} shared tips
        {comparison.primaryOnlyCount > 0 ? ` · ${comparison.primaryOnlyCount.toLocaleString()} only in left tree` : ""}
        {comparison.comparisonOnlyCount > 0 ? ` · ${comparison.comparisonOnlyCount.toLocaleString()} only in right tree` : ""}
      </div>
    </div>
  );
}
