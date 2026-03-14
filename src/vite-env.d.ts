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
      setShowTaxonomyRankLegendForTest: (visible: boolean) => void;
      setTaxonomyColorJitterForTest: (value: number) => void;
      setBranchThicknessScaleForTest: (value: number) => void;
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
      setFigureStyleForTest: (
        labelClass: "tip" | "genus" | "taxonomy" | "internalNode" | "bootstrap" | "nodeHeight" | "scale",
        field: "fontFamily" | "sizeScale" | "offsetPx" | "offsetXPx" | "offsetYPx" | "bandThicknessScale",
        value: string | number,
      ) => void;
      runRealTaxonomyMappingForTest: () => Promise<void>;
      getTaxonomyMapForTest: () => TaxonomyMapPayload | null;
      setMockTaxonomy: () => void;
      cacheMockTaxonomy: () => Promise<void>;
      clearTaxonomy: () => void;
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
