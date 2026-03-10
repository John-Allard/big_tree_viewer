/// <reference types="vite/client" />

declare global {
  interface Window {
    __BIG_TREE_VIEWER_APP_TEST__?: {
      getState: () => Record<string, unknown>;
      setViewMode: (mode: "rectangular" | "circular") => void;
      setOrder: (order: "input" | "desc" | "asc") => void;
      setShowGenusLabels: (visible: boolean) => void;
      setTaxonomyEnabled: (visible: boolean) => void;
      setMockTaxonomy: () => void;
      clearTaxonomy: () => void;
      requestFit: () => void;
    };
    __BIG_TREE_VIEWER_RENDER_DEBUG__?: Record<string, unknown> | null;
    __BIG_TREE_VIEWER_CANVAS_TEST__?: {
      getCamera: () => Record<string, unknown> | null;
      getRenderDebug: () => Record<string, unknown> | null;
      fitView: () => void;
      setRectCamera: (partial: Record<string, unknown>) => void;
      setCircularCamera: (partial: Record<string, unknown>) => void;
    };
  }
}

export {};
