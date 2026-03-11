/// <reference types="vite/client" />

import type { TaxonomyMapPayload } from "./types/taxonomy";

declare global {
  interface Window {
    __BIG_TREE_VIEWER_APP_TEST__?: {
      getState: () => Record<string, unknown>;
      setViewMode: (mode: "rectangular" | "circular") => void;
      setOrder: (order: "input" | "desc" | "asc") => void;
      setShowGenusLabels: (visible: boolean) => void;
      setTaxonomyEnabled: (visible: boolean) => void;
      setCircularRotationDegreesForTest: (degrees: number) => void;
      setTaxonomyMapForTest: (payload: TaxonomyMapPayload | null) => void;
      runRealTaxonomyMappingForTest: () => Promise<void>;
      getTaxonomyMapForTest: () => TaxonomyMapPayload | null;
      setMockTaxonomy: () => void;
      cacheMockTaxonomy: () => Promise<void>;
      clearTaxonomy: () => void;
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
    };
  }
}

export {};
