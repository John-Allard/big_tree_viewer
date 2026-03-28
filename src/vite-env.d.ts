/// <reference types="vite/client" />

import type { TaxonomyMapPayload } from "./types/taxonomy";

declare global {
  interface Window {
    __BIG_TREE_VIEWER_APP_TEST__?: {
      getState: () => Record<string, unknown>;
      setViewMode: (mode: "rectangular" | "circular") => void;
      setOrder: (order: "input" | "desc" | "asc") => void;
      setShowGenusLabels: (visible: boolean) => void;
      setShowInternalNodeLabels: (visible: boolean) => void;
      setShowBootstrapLabels: (visible: boolean) => void;
      setTaxonomyEnabled: (visible: boolean) => void;
      setTaxonomyBranchColoringEnabled: (enabled: boolean) => void;
      setTaxonomyRankVisibilityForTest: (
        rank: "superkingdom" | "phylum" | "class" | "order" | "family" | "genus",
        visible: boolean,
      ) => void;
      setTaxonomyRankVisibilityAutoForTest: (enabled: boolean) => void;
      setTaxonomyCollapseRankForTest: (rank: "species" | "superkingdom" | "phylum" | "class" | "order" | "family" | "genus") => void;
      setTaxonomyColorJitterForTest: (value: number) => void;
      setBranchThicknessScaleForTest: (value: number) => void;
      setShowIntermediateScaleTicks: (visible: boolean) => void;
      setExtendRectScaleToTick: (visible: boolean) => void;
      setShowScaleZeroTick: (visible: boolean) => void;
      setScaleTickIntervalInput: (value: string) => void;
      setCircularCenterScaleAngleDegrees: (value: number) => void;
      setUseAutoCircularCenterScaleAngle: (enabled: boolean) => void;
      setShowCircularCenterRadialScaleBar: (visible: boolean) => void;
      setTimeStripeStyle: (value: "bands" | "dashed") => void;
      setTimeStripeLineWeight: (value: number) => void;
      setShowNodeErrorBars: (visible: boolean) => void;
      setErrorBarThicknessPx: (value: number) => void;
      setErrorBarCapSizePx: (value: number) => void;
      setMetadataEnabled: (visible: boolean) => void;
      setSearchQuery: (query: string) => void;
      setCircularRotationDegreesForTest: (degrees: number) => void;
      setTaxonomyMapForTest: (payload: TaxonomyMapPayload | null) => void;
      importMetadataTextForTest: (text: string, label?: string) => void;
      clearMetadataForTest: () => void;
      setMetadataKeyColumn: (column: string) => void;
      setMetadataValueColumn: (column: string) => void;
      setMetadataColorMode: (mode: "categorical" | "continuous") => void;
      setMetadataApplyScope: (scope: "branch" | "subtree") => void;
      setMetadataReverseScale: (reverse: boolean) => void;
      setMetadataContinuousPalette: (palette: "blueOrange" | "viridis" | "redBlue" | "tealRose") => void;
      setMetadataContinuousTransform: (transform: "linear" | "sqrt" | "log") => void;
      setMetadataContinuousMinInput: (value: string) => void;
      setMetadataContinuousMaxInput: (value: string) => void;
      setMetadataLabelsEnabled: (visible: boolean) => void;
      setMetadataLabelColumn: (column: string) => void;
      setMetadataMarkersEnabled: (visible: boolean) => void;
      setMetadataMarkerColumn: (column: string) => void;
      setMetadataMarkerSizePx: (value: number) => void;
      setMetadataLabelMaxCount: (value: number) => void;
      setMetadataLabelMinSpacingPx: (value: number) => void;
      setMetadataLabelOffsetXPx: (value: number) => void;
      setMetadataLabelOffsetYPx: (value: number) => void;
      setFigureStyleForTest: (
        labelClass: "tip" | "genus" | "taxonomy" | "internalNode" | "bootstrap" | "nodeHeight" | "scale",
        field: "fontFamily" | "sizeScale" | "offsetPx" | "offsetXPx" | "offsetYPx" | "bandThicknessScale" | "bold" | "italic",
        value: string | number | boolean,
      ) => void;
      runRealTaxonomyMappingForTest: () => Promise<void>;
      downloadTaxonomyForTest: () => Promise<void>;
      runTaxonomyMappingForTest: () => Promise<void>;
      getTaxonomyMapForTest: () => TaxonomyMapPayload | null;
      setMockTaxonomy: () => void;
      cacheMockTaxonomy: () => Promise<void>;
      clearTaxonomy: () => void;
      rerootOnNodeForTest: (node: number, mode: "branch" | "child" | "parent") => void;
      requestSearchFocus: () => void;
      requestFit: () => void;
    };
    __BIG_TREE_VIEWER_RENDER_DEBUG__?: Record<string, unknown> | null;
    __BIG_TREE_VIEWER_APP_TEST_INTERNAL__?: {
      leafNodes: number[];
      names?: string[];
      parent?: number[];
      firstChild?: number[];
      nextSibling?: number[];
    };
    __BIG_TREE_VIEWER_CANVAS_TEST__?: {
      getCamera: () => Record<string, unknown> | null;
      getRenderDebug: () => Record<string, unknown> | null;
      getCurrentBranchColors: () => string[] | null;
      startPanBenchmark: (label?: string) => { label: string; startedAtMs: number };
      stopPanBenchmark: () => Record<string, unknown> | null;
      fitView: () => void;
      setRectCamera: (partial: Record<string, unknown>) => void;
      setCircularCamera: (partial: Record<string, unknown>) => void;
      getLeafIndexMap: () => Record<number, number> | null;
      getLabelHitboxes: () => Array<Record<string, unknown>>;
      probeHoverForTest: (localX: number, localY: number) => Record<string, unknown> | null;
      buildSharedSubtreePayloadForTest: (node: number) => Record<string, unknown> | null;
      zoomToSubtreeTarget: (node: number) => void;
      setManualBranchColor: (node: number, color: string) => void;
      clearManualBranchColor: (node: number) => void;
      setManualSubtreeColor: (node: number, color: string) => void;
      clearManualSubtreeColor: (node: number) => void;
      buildCurrentSvgForTest: () => string | null;
    };
  }
}

export {};
