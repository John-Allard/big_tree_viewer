import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import TreeCanvas from "./components/TreeCanvas";
import { computeGenusBlocks, computeOrderedLeaves } from "./components/treeCanvasCache";
import type { WorkerResponse } from "./types/messages";
import type { WorkerTreePayload } from "./types/tree";
import type { LayoutOrder, LoadState, TreeModel, ViewMode, ZoomAxisMode } from "./types/tree";

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (Math.abs(value) >= 1000 || Math.abs(value) < 0.001) {
    return value.toExponential(3);
  }
  return value.toFixed(4).replace(/\.?0+$/, "");
}

function normalizeSearchQuery(value: string): string {
  return value.toLowerCase();
}

function normalizeSearchTarget(value: string): string {
  return value.trim().replaceAll("_", " ").toLowerCase();
}

function canonicalSearchKey(value: string): string {
  return normalizeSearchTarget(value).replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesSearchQuery(target: string, query: string): boolean {
  const normalizedTarget = target.toLowerCase();
  const normalizedQuery = normalizeSearchQuery(query);
  const trimmedQuery = normalizedQuery.trim();
  if (!trimmedQuery) {
    return false;
  }
  const hasTrailingSeparator = /[_ ]$/.test(normalizedQuery);
  const tokens = trimmedQuery.split(/[_ ]+/).filter(Boolean).map(escapeRegExp);
  if (tokens.length === 0) {
    return false;
  }
  const body = tokens.join("[_ ]+");
  const pattern = hasTrailingSeparator ? `${body}(?:[_ ]+|$)` : body;
  return new RegExp(pattern, "i").test(normalizedTarget);
}

function isNumericInternalLabel(value: string): boolean {
  return /^[+-]?\d+(?:\.\d+)?$/.test(value.trim());
}

function useSessionDisclosure(key: string, defaultOpen: boolean): [boolean, (value: boolean) => void] {
  const storageKey = `big-tree-viewer:${key}:open`;
  const [isOpen, setIsOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return defaultOpen;
    }
    const stored = window.sessionStorage.getItem(storageKey);
    if (stored === null) {
      return defaultOpen;
    }
    return stored === "true";
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.sessionStorage.setItem(storageKey, isOpen ? "true" : "false");
  }, [isOpen, storageKey]);

  return [isOpen, setIsOpen];
}

function PanelSection({
  title,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="panel-section">
      <button
        type="button"
        className="section-toggle"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span className={`section-toggle-mark${isOpen ? " open" : ""}`}>▸</span>
        <span>{title}</span>
      </button>
      {isOpen ? <div className="section-body">{children}</div> : null}
    </section>
  );
}

interface SearchResult {
  kind: "node" | "genus";
  node: number;
  displayName: string;
}

function buildTreeModel(payload: WorkerTreePayload): TreeModel {
  let minPositive = Number.POSITIVE_INFINITY;
  for (let node = 0; node < payload.nodeCount; node += 1) {
    const length = payload.buffers.branchLength[node];
    if (length > 0 && length < minPositive) {
      minPositive = length;
    }
  }
  return {
    ...payload,
    branchLengthMinPositive: Number.isFinite(minPositive) ? minPositive : 1,
  };
}

export default function App() {
  const workerRef = useRef<Worker | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const didAutoloadRef = useRef(false);
  const [tree, setTree] = useState<TreeModel | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({
    loading: false,
    message: "Load a Newick tree to begin.",
    error: null,
  });
  const [viewMode, setViewMode] = useState<ViewMode>("rectangular");
  const [order, setOrder] = useState<LayoutOrder>("input");
  const [zoomAxisMode, setZoomAxisMode] = useState<ZoomAxisMode>("both");
  const [circularRotationDegrees, setCircularRotationDegrees] = useState(0);
  const [showTimeStripes, setShowTimeStripes] = useState(true);
  const [showScaleBars, setShowScaleBars] = useState(true);
  const [showGenusLabels, setShowGenusLabels] = useState(true);
  const [showNodeHeightLabels, setShowNodeHeightLabels] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [fitRequest, setFitRequest] = useState(0);
  const [focusNodeRequest, setFocusNodeRequest] = useState(0);
  const [dataOpen, setDataOpen] = useSessionDisclosure("section-data", true);
  const [viewOpen, setViewOpen] = useSessionDisclosure("section-view", true);
  const [visualOpen, setVisualOpen] = useSessionDisclosure("section-visual", false);
  const [searchOpen, setSearchOpen] = useSessionDisclosure("section-search", false);
  const [statsOpen, setStatsOpen] = useSessionDisclosure("section-stats", false);
  const handleHoverChange = useCallback(() => {}, []);

  const searchResults = useMemo(() => {
    const query = normalizeSearchQuery(searchQuery);
    const queryKey = canonicalSearchKey(searchQuery);
    if (!tree || !searchQuery.trim()) {
      return [] as SearchResult[];
    }
    const exactGenusResults: SearchResult[] = [];
    const partialGenusResults: SearchResult[] = [];
    if (showGenusLabels) {
      const orderedLeaves = computeOrderedLeaves(tree, order);
      const genusBlocks = computeGenusBlocks(tree, orderedLeaves);
      for (let index = 0; index < genusBlocks.length; index += 1) {
        const block = genusBlocks[index];
        if (!matchesSearchQuery(block.label, query)) {
          continue;
        }
        const result = {
          kind: "genus",
          node: block.centerNode,
          displayName: block.label,
        } satisfies SearchResult;
        if (canonicalSearchKey(block.label) === queryKey) {
          exactGenusResults.push(result);
        } else {
          partialGenusResults.push(result);
        }
      }
    }

    const exactLeafMatches: number[] = [];
    const exactInternalMatches: number[] = [];
    const partialNodeMatches: number[] = [];
    for (let node = 0; node < tree.nodeCount; node += 1) {
      const rawName = (tree.names[node] || "").trim();
      if (!rawName) {
        continue;
      }
      const isInternal = tree.buffers.firstChild[node] >= 0;
      if (isInternal && isNumericInternalLabel(rawName)) {
        continue;
      }
      if (matchesSearchQuery(rawName, query)) {
        const isExact = canonicalSearchKey(rawName) === queryKey;
        if (isExact && !isInternal) {
          exactLeafMatches.push(node);
        } else if (isExact) {
          exactInternalMatches.push(node);
        } else {
          partialNodeMatches.push(node);
        }
      }
    }
    const sortNodes = (nodes: number[]): void => {
      nodes.sort((left, right) => (
        tree.layouts[order].center[left] - tree.layouts[order].center[right]
        || tree.buffers.depth[left] - tree.buffers.depth[right]
        || left - right
      ));
    };
    sortNodes(exactLeafMatches);
    sortNodes(exactInternalMatches);
    sortNodes(partialNodeMatches);
    const nodeResults = [...exactLeafMatches, ...exactInternalMatches, ...partialNodeMatches];
    const results = [...exactGenusResults, ...partialGenusResults];
    for (let index = 0; index < nodeResults.length; index += 1) {
      const node = nodeResults[index];
      results.push({
        kind: "node",
        node,
        displayName: normalizeSearchTarget(tree.names[node] || "").replaceAll("_", " ") || `node-${node}`,
      });
    }
    return results;
  }, [order, searchQuery, showGenusLabels, tree]);

  const searchMatches = useMemo(
    () => searchResults.filter((result) => result.kind === "node").map((result) => result.node),
    [searchResults],
  );

  const activeSearchResult = searchResults.length > 0
    ? searchResults[Math.min(activeSearchIndex, searchResults.length - 1)]
    : null;
  const activeSearchNode = activeSearchResult?.kind === "node" ? activeSearchResult.node : null;
  const activeSearchGenusCenterNode = activeSearchResult?.kind === "genus" ? activeSearchResult.node : null;

  useEffect(() => {
    if (searchResults.length === 0) {
      setActiveSearchIndex(0);
      return;
    }
    setActiveSearchIndex((current) => Math.min(current, searchResults.length - 1));
  }, [searchResults]);

  const handleWorkerMessage = useCallback((event: MessageEvent<WorkerResponse>): void => {
    const data = event.data;
    if (data.type === "parse-progress") {
      setLoadState((current) => ({
        ...current,
        loading: true,
        message: data.message,
      }));
      return;
    }
    if (data.type === "parse-error") {
      setLoadState({
        loading: false,
        message: "Failed to parse tree.",
        error: data.message,
      });
      return;
    }
    const nextTree = buildTreeModel(data.payload);
    setTree(nextTree);
    setLoadState({
      loading: false,
      message: "",
      error: null,
    });
    setFitRequest((value) => value + 1);
  }, []);

  const handleWorkerError = useCallback((event: ErrorEvent): void => {
    setLoadState({
      loading: false,
      message: "Tree worker failed.",
      error: event.message || "Unknown worker error.",
    });
  }, []);

  const handleWorkerMessageError = useCallback((): void => {
    setLoadState({
      loading: false,
      message: "Tree worker message transfer failed.",
      error: "The browser could not deserialize the parsed tree payload.",
    });
  }, []);

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) {
      return workerRef.current;
    }
    const worker = new Worker(new URL("./workers/treeWorker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", handleWorkerMessage);
    worker.addEventListener("error", handleWorkerError);
    worker.addEventListener("messageerror", handleWorkerMessageError);
    workerRef.current = worker;
    return worker;
  }, [handleWorkerError, handleWorkerMessage, handleWorkerMessageError]);

  useEffect(() => () => {
    const worker = workerRef.current;
    if (!worker) {
      return;
    }
    worker.terminate();
    workerRef.current = null;
  }, []);

  const parseText = useCallback(async (text: string, label: string): Promise<void> => {
    setLoadState({
      loading: true,
      message: `Starting worker for ${label}...`,
      error: null,
    });
    const worker = ensureWorker();
    setLoadState({
      loading: true,
      message: `Parsing ${label}...`,
      error: null,
    });
    worker.postMessage({
      type: "parse-tree",
      text,
    });
  }, [ensureWorker]);

  const loadExample = async (): Promise<void> => {
    setLoadState({
      loading: true,
      message: "Loading bundled example tree...",
      error: null,
    });
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}example-tree.nwk`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      await parseText(text, "example tree");
    } catch (error) {
      setLoadState({
        loading: false,
        message: "Unable to load bundled example tree.",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  useEffect(() => {
    if (didAutoloadRef.current) {
      return;
    }
    didAutoloadRef.current = true;
    void loadExample();
  }, []);

  useEffect(() => {
    if (!tree) {
      return;
    }
    setFitRequest((value) => value + 1);
  }, [tree]);

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const text = await file.text();
    await parseText(text, file.name);
    event.target.value = "";
  };

  const stepSearch = (direction: -1 | 1): void => {
    if (searchResults.length === 0) {
      return;
    }
    setActiveSearchIndex((current) => {
      const next = current + direction;
      if (next < 0) {
        return searchResults.length - 1;
      }
      if (next >= searchResults.length) {
        return 0;
      }
      return next;
    });
  };

  return (
    <div className="app-shell">
      <aside className="control-panel">
        <div className="panel-title-block">
          <h1>Big Tree Viewer</h1>
        </div>

        <PanelSection title="Data" isOpen={dataOpen} onToggle={() => setDataOpen(!dataOpen)}>
          <div className="button-row">
            <button type="button" onClick={() => void loadExample()} disabled={loadState.loading}>
              Load Example
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => fileInputRef.current?.click()}
            >
              Open Newick
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".nwk,.newick,.tree,.txt"
              hidden
              onChange={(event) => void onFileChange(event)}
            />
          </div>
          {loadState.loading && loadState.message ? <p className="status-line">{loadState.message}</p> : null}
          {loadState.error ? <p className="status-error">{loadState.error}</p> : null}
        </PanelSection>

        <PanelSection title="View" isOpen={viewOpen} onToggle={() => setViewOpen(!viewOpen)}>
          <div className="segmented">
            <button
              type="button"
              className={viewMode === "rectangular" ? "active" : ""}
              onClick={() => setViewMode("rectangular")}
            >
              Rectangular
            </button>
            <button
              type="button"
              className={viewMode === "circular" ? "active" : ""}
              onClick={() => setViewMode("circular")}
            >
              Circular
            </button>
          </div>
          <div className="segmented">
            <button type="button" className={order === "input" ? "active" : ""} onClick={() => setOrder("input")}>
              Input Order
            </button>
            <button type="button" className={order === "desc" ? "active" : ""} onClick={() => setOrder("desc")}>
              Largest First
            </button>
            <button type="button" className={order === "asc" ? "active" : ""} onClick={() => setOrder("asc")}>
              Smallest First
            </button>
          </div>
          <div className="segmented">
            <button
              type="button"
              className={zoomAxisMode === "both" ? "active" : ""}
              onClick={() => setZoomAxisMode("both")}
              disabled={viewMode === "circular"}
            >
              Zoom Both
            </button>
            <button
              type="button"
              className={zoomAxisMode === "x" ? "active" : ""}
              onClick={() => setZoomAxisMode("x")}
              disabled={viewMode === "circular"}
            >
              Pin Y
            </button>
            <button
              type="button"
              className={zoomAxisMode === "y" ? "active" : ""}
              onClick={() => setZoomAxisMode("y")}
              disabled={viewMode === "circular"}
            >
              Pin X
            </button>
          </div>
          <div className="button-row">
            <button type="button" className="secondary" onClick={() => setFitRequest((value) => value + 1)}>
              Fit View
            </button>
          </div>
          {viewMode === "circular" ? (
            <div className="rotation-controls">
              <label htmlFor="circular-rotation">Rotation</label>
              <input
                id="circular-rotation"
                type="range"
                min={-180}
                max={180}
                step={1}
                value={circularRotationDegrees}
                onChange={(event) => setCircularRotationDegrees(Number(event.target.value))}
              />
              <div className="button-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setCircularRotationDegrees((value) => Math.max(-180, value - 15))}
                >
                  Rotate Left
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setCircularRotationDegrees((value) => Math.min(180, value + 15))}
                >
                  Rotate Right
                </button>
                <button type="button" className="secondary" onClick={() => setCircularRotationDegrees(0)}>
                  Reset
                </button>
              </div>
            </div>
          ) : null}
        </PanelSection>

        <PanelSection title="Visual Options" isOpen={visualOpen} onToggle={() => setVisualOpen(!visualOpen)}>
          <div className="option-list">
            <label>
              <input
                type="checkbox"
                checked={showGenusLabels}
                onChange={(event) => setShowGenusLabels(event.target.checked)}
              />
              Show genus labels
            </label>
            <label>
              <input
                type="checkbox"
                checked={showNodeHeightLabels}
                onChange={(event) => setShowNodeHeightLabels(event.target.checked)}
              />
              Show node height labels
            </label>
            <label>
              <input
                type="checkbox"
                checked={showScaleBars}
                onChange={(event) => setShowScaleBars(event.target.checked)}
              />
              Show scale bars
            </label>
            <label>
              <input
                type="checkbox"
                checked={showTimeStripes}
                onChange={(event) => setShowTimeStripes(event.target.checked)}
              />
              Show time stripes
            </label>
          </div>
        </PanelSection>

        <PanelSection title="Search" isOpen={searchOpen} onToggle={() => setSearchOpen(!searchOpen)}>
          <div className="search-controls">
            <div className="search-input-wrap">
              <input
                type="search"
                value={searchQuery}
                placeholder="Search tip, node, or genus names"
                disabled={!tree}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && activeSearchResult !== null) {
                    event.preventDefault();
                    setFocusNodeRequest((value) => value + 1);
                  }
                }}
              />
              <button
                type="button"
                className="search-clear"
                aria-label="Clear search"
                disabled={!searchQuery}
                onClick={() => {
                  setSearchQuery("");
                  setActiveSearchIndex(0);
                }}
              >
                ×
              </button>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                disabled={searchResults.length === 0}
                onClick={() => stepSearch(-1)}
              >
                Previous
              </button>
              <button
                type="button"
                className="secondary"
                disabled={searchResults.length === 0}
                onClick={() => stepSearch(1)}
              >
                Next
              </button>
              <button
                type="button"
                className="secondary"
                disabled={activeSearchResult === null}
                onClick={() => setFocusNodeRequest((value) => value + 1)}
              >
                Focus
              </button>
            </div>
            {searchQuery.trim() ? (
              <>
                <p className="status-line">
                  {searchResults.length === 0
                  ? "No matches."
                  : `Showing ${activeSearchIndex + 1} of ${searchResults.length}`}
                </p>
                {activeSearchResult ? (
                  <p className="search-match-name">
                    {activeSearchResult.kind === "genus" ? "Genus: " : "Match: "}
                    {activeSearchResult.displayName}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </PanelSection>

        <PanelSection title="Stats" isOpen={statsOpen} onToggle={() => setStatsOpen(!statsOpen)}>
          {tree ? (
            <div>
              <dl className="stats-list">
                <dt>Tips</dt>
                <dd>{tree.leafCount.toLocaleString()}</dd>
                <dt>Nodes</dt>
                <dd>{tree.nodeCount.toLocaleString()}</dd>
                <dt>Tree depth</dt>
                <dd>{formatNumber(tree.maxDepth)}</dd>
                <dt>Root age</dt>
                <dd>{formatNumber(tree.rootAge)}</dd>
                <dt>Ultrametric</dt>
                <dd>{tree.isUltrametric ? "Yes" : "No"}</dd>
              </dl>
            </div>
          ) : (
            <p className="empty-note">No tree loaded.</p>
          )}
        </PanelSection>
      </aside>

      <main className="viewer-panel">
        <TreeCanvas
          tree={tree}
          order={order}
          viewMode={viewMode}
          zoomAxisMode={viewMode === "circular" ? "both" : zoomAxisMode}
          circularRotation={(circularRotationDegrees * Math.PI) / 180}
          showTimeStripes={showTimeStripes}
          showScaleBars={showScaleBars}
          showGenusLabels={showGenusLabels}
          showNodeHeightLabels={showNodeHeightLabels}
          searchQuery={searchQuery}
          searchMatches={searchMatches}
          activeSearchNode={activeSearchNode}
          activeSearchGenusCenterNode={activeSearchGenusCenterNode}
          focusNodeRequest={focusNodeRequest}
          fitRequest={fitRequest}
          onHoverChange={handleHoverChange}
        />
      </main>
    </div>
  );
}
