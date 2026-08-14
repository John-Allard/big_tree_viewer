import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { buildTaxonomyBlocksForOrderedLeaves, colorForTaxonomy, type TaxonomyColorByRank } from "../lib/taxonomyBlocks";
import { fontFamilyCss, type FigureStyleSettings } from "../lib/figureStyles";
import { buildComparisonLayout, normalizeComparisonTipName } from "../lib/treeComparison";
import { TAXONOMY_RANKS, type TaxonomyMapPayload, type TaxonomyRank } from "../types/taxonomy";
import type { LayoutOrder, TreeModel } from "../types/tree";
import type { TaxonomyRankDisplayMode } from "./treeCanvasTypes";
import { buildTaxonomyColorMap } from "./TreeCanvas";

interface TreeComparisonCanvasProps {
  primaryTree: TreeModel;
  comparisonTree: TreeModel;
  order: LayoutOrder;
  primaryLabel: string;
  comparisonLabel: string;
  showTipLabels: boolean;
  branchThicknessScale: number;
  figureStyles: FigureStyleSettings;
  taxonomyEnabled: boolean;
  taxonomyMap: TaxonomyMapPayload | null;
  taxonomyColorJitter: number;
  taxonomyColorPalette: Parameters<typeof buildTaxonomyColorMap>[3];
  taxonomyCustomPaletteColors: string[];
  taxonomyColorRootRank: TaxonomyRank | "auto";
  taxonomyColorJitterRank: TaxonomyRank;
  taxonomyRankDisplayModes: Partial<Record<TaxonomyRank, TaxonomyRankDisplayMode>>;
  taxonomyRankVisibility: Partial<Record<TaxonomyRank, boolean>>;
  useAutomaticTaxonomyRankVisibility: boolean;
  fitRequest: number;
}

interface Camera {
  zoom: number;
  panY: number;
}

const TOP_MARGIN = 24;
const BOTTOM_MARGIN = 24;

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

function discordanceColor(discordance: number): string {
  if (discordance < 0.015) {
    return "rgba(100, 116, 139, 0.22)";
  }
  const strength = Math.min(1, (discordance - 0.015) / 0.28);
  const hue = 215 - (215 * strength);
  return `hsla(${hue}deg 78% ${48 + (strength * 4)}% / ${0.32 + (strength * 0.58)})`;
}

export default function TreeComparisonCanvas(props: TreeComparisonCanvasProps) {
  const {
    primaryTree,
    comparisonTree,
    order,
    primaryLabel,
    comparisonLabel,
    showTipLabels,
    branchThicknessScale,
    figureStyles,
    taxonomyEnabled,
    taxonomyMap,
    taxonomyColorJitter,
    taxonomyColorPalette,
    taxonomyCustomPaletteColors,
    taxonomyColorRootRank,
    taxonomyColorJitterRank,
    taxonomyRankDisplayModes,
    taxonomyRankVisibility,
    useAutomaticTaxonomyRankVisibility,
    fitRequest,
  } = props;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [camera, setCamera] = useState<Camera>({ zoom: 1, panY: 0 });
  const dragRef = useRef<{ pointerId: number; startY: number; startPanY: number } | null>(null);

  const comparison = useMemo(
    () => buildComparisonLayout(primaryTree, comparisonTree, order),
    [comparisonTree, order, primaryTree],
  );
  const primaryLayout = primaryTree.layouts[order];
  const primaryDenominator = Math.max(1, comparison.primaryLeaves.length - 1);
  const comparisonDenominator = Math.max(1, comparison.comparisonLeaves.length - 1);
  const activeRanks = useMemo(() => {
    if (!taxonomyEnabled || !taxonomyMap) {
      return [] as TaxonomyRank[];
    }
    return [...taxonomyMap.activeRanks]
      .filter((rank) => useAutomaticTaxonomyRankVisibility
        || (taxonomyRankDisplayModes[rank] ?? (taxonomyRankVisibility[rank] === false ? "hidden" : "ribbon")) === "ribbon")
      .sort((left, right) => TAXONOMY_RANKS.indexOf(right) - TAXONOMY_RANKS.indexOf(left));
  }, [taxonomyEnabled, taxonomyMap, taxonomyRankDisplayModes, taxonomyRankVisibility, useAutomaticTaxonomyRankVisibility]);
  const taxonomyColors = useMemo<TaxonomyColorByRank | null>(() => taxonomyMap
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
  useEffect(() => setCamera({ zoom: 1, panY: 0 }), [comparisonTree, fitRequest, primaryTree]);

  const screenY = useCallback((position: number): number => {
    const usable = Math.max(1, size.height - TOP_MARGIN - BOTTOM_MARGIN);
    return (size.height / 2) + ((position - 0.5) * usable * camera.zoom) + camera.panY;
  }, [camera.panY, camera.zoom, size.height]);

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

    const ribbonWidth = Math.max(4, 7 * (figureStyles.taxonomy.bandThicknessScale ?? 1));
    const ribbonsWidth = activeRanks.length * ribbonWidth;
    const primaryLabelAnchorX = size.width * 0.43;
    const primaryTipX = primaryLabelAnchorX - ribbonsWidth;
    const comparisonTipX = size.width * 0.57;
    const primaryRootX = 24;
    const comparisonRootX = size.width - 24;
    const branchWidth = Math.max(0.45, branchThicknessScale);
    const primaryDepthSpan = Math.max(1e-12, primaryTree.maxDepth - primaryTree.buffers.depth[primaryTree.root]);
    const comparisonDepthSpan = Math.max(1e-12, comparisonTree.maxDepth - comparisonTree.buffers.depth[comparisonTree.root]);
    const primaryX = (node: number) => primaryRootX
      + ((primaryTree.buffers.depth[node] - primaryTree.buffers.depth[primaryTree.root]) / primaryDepthSpan) * (primaryTipX - primaryRootX);
    const comparisonX = (node: number) => comparisonRootX
      - ((comparisonTree.buffers.depth[node] - comparisonTree.buffers.depth[comparisonTree.root]) / comparisonDepthSpan) * (comparisonRootX - comparisonTipX);
    const primaryY = (node: number) => screenY(primaryLayout.center[node] / primaryDenominator);
    const secondaryY = (node: number) => screenY(comparison.comparisonCenter[node] / comparisonDenominator);
    const visible = (y: number) => y >= -8 && y <= size.height + 8;

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

    drawTree(primaryTree, primaryX, primaryY, primaryNodeColors);
    drawTree(comparisonTree, comparisonX, secondaryY, comparisonNodeColors);

    if (taxonomyBlocks) {
      activeRanks.forEach((rank, rankIndex) => {
        const x = primaryTipX + (rankIndex * ribbonWidth);
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
            context.fillRect(x, top, ribbonWidth - 1, Math.max(1, bottom - top));
            if (bottom - top > 46 && ribbonWidth >= 7) {
              context.save();
              context.translate(x + (ribbonWidth / 2), (top + bottom) / 2);
              context.rotate(Math.PI / 2);
              context.fillStyle = "#111827";
              context.font = `${Math.max(8, 10 * figureStyles.taxonomy.sizeScale)}px ${fontFamilyCss(figureStyles.taxonomy.fontFamily)}`;
              context.textAlign = "center";
              context.textBaseline = "middle";
              context.fillText(block.label, 0, 0, Math.max(1, bottom - top - 8));
              context.restore();
            }
          }
        }
      });
    }

    const maxLeafCount = Math.max(comparison.primaryLeaves.length, comparison.comparisonLeaves.length);
    const pixelsPerTip = ((size.height - TOP_MARGIN - BOTTOM_MARGIN) * camera.zoom) / Math.max(1, maxLeafCount - 1);
    const labelsVisible = showTipLabels && pixelsPerTip >= 9;
    const tipFontSize = Math.max(9, Math.min(15, 11 * figureStyles.tip.sizeScale));
    context.font = `${figureStyles.tip.italic ? "italic " : ""}${figureStyles.tip.bold ? "700 " : ""}${tipFontSize}px ${fontFamilyCss(figureStyles.tip.fontFamily)}`;
    context.textBaseline = "middle";

    for (const pair of comparison.commonPairs) {
      const leftY = screenY(pair.primaryPosition);
      const rightY = screenY(pair.comparisonPosition);
      if (!visible(leftY) && !visible(rightY) && (leftY < 0) === (rightY < 0)) {
        continue;
      }
      let startX = primaryLabelAnchorX + 3;
      let endX = comparisonTipX - 3;
      if (labelsVisible) {
        const labelWidth = Math.min(size.width * 0.12, context.measureText(pair.name).width);
        startX += labelWidth + 4;
        endX -= labelWidth + 4;
      }
      context.beginPath();
      context.moveTo(Math.min(startX, size.width / 2 - 3), leftY);
      context.lineTo(Math.max(endX, size.width / 2 + 3), rightY);
      context.strokeStyle = discordanceColor(pair.discordance);
      context.lineWidth = pair.discordance > 0.12 ? 1.35 : 0.8;
      context.stroke();
    }

    if (labelsVisible) {
      context.fillStyle = "#111827";
      comparison.primaryLeaves.forEach((node) => {
        const y = primaryY(node);
        if (visible(y)) {
          context.textAlign = "left";
          context.fillText((primaryTree.names[node] || "Unnamed tip").replaceAll("_", " "), primaryLabelAnchorX + 3, y, size.width * 0.12);
        }
      });
      comparison.comparisonLeaves.forEach((node) => {
        const y = secondaryY(node);
        if (visible(y)) {
          context.textAlign = "right";
          context.fillText((comparisonTree.names[node] || "Unnamed tip").replaceAll("_", " "), comparisonTipX - 3, y, size.width * 0.12);
        }
      });
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
    camera.zoom,
    comparison,
    comparisonDenominator,
    comparisonLabel,
    comparisonNodeColors,
    comparisonTree,
    figureStyles,
    primaryDenominator,
    primaryLabel,
    primaryLayout.center,
    primaryNodeColors,
    primaryTree,
    screenY,
    showTipLabels,
    size.height,
    size.width,
    taxonomyBlocks,
  ]);

  const clampPan = useCallback((zoom: number, panY: number) => {
    const usable = Math.max(1, size.height - TOP_MARGIN - BOTTOM_MARGIN);
    const maximum = Math.max(0, ((zoom - 1) * usable) / 2 + usable * 0.46);
    return Math.max(-maximum, Math.min(maximum, panY));
  }, [size.height]);
  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const cursorY = event.clientY - rect.top;
    setCamera((current) => {
      const nextZoom = Math.max(1, Math.min(2_000, current.zoom * Math.exp(-event.deltaY * 0.0015)));
      const center = size.height / 2;
      const nextPan = cursorY - center - ((cursorY - center - current.panY) * (nextZoom / current.zoom));
      return { zoom: nextZoom, panY: clampPan(nextZoom, nextPan) };
    });
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startPanY: camera.panY };
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    setCamera((current) => ({ ...current, panY: clampPan(current.zoom, drag.startPanY + event.clientY - drag.startY) }));
  };
  const stopDragging = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
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
      />
      <div className="tree-comparison-summary">
        {comparison.commonPairs.length.toLocaleString()} shared tips
        {comparison.primaryOnlyCount > 0 ? ` · ${comparison.primaryOnlyCount.toLocaleString()} only in left tree` : ""}
        {comparison.comparisonOnlyCount > 0 ? ` · ${comparison.comparisonOnlyCount.toLocaleString()} only in right tree` : ""}
      </div>
    </div>
  );
}
