import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import TreeCanvas from "./components/TreeCanvas";
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
  const [showTimeStripes, setShowTimeStripes] = useState(true);
  const [showScaleBars, setShowScaleBars] = useState(true);
  const [showGenusLabels, setShowGenusLabels] = useState(true);
  const [showNodeHeightLabels, setShowNodeHeightLabels] = useState(false);
  const [fitRequest, setFitRequest] = useState(0);
  const handleHoverChange = useCallback(() => {}, []);

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
      const response = await fetch("./example-tree.nwk");
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
  }, [tree, viewMode]);

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const text = await file.text();
    await parseText(text, file.name);
    event.target.value = "";
  };

  return (
    <div className="app-shell">
      <aside className="control-panel">
        <div className="panel-title-block">
          <h1>Big Tree Viewer</h1>
        </div>

        <section className="panel-section">
          <h2>Data</h2>
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
        </section>

        <section className="panel-section">
          <h2>View</h2>
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
        </section>

        <section className="panel-section">
          <h2>Visual Options</h2>
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
        </section>

        <section className="panel-section">
          {tree ? (
            <details className="stats-panel">
              <summary>Stats</summary>
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
            </details>
          ) : (
            <p className="empty-note">No tree loaded.</p>
          )}
        </section>
      </aside>

      <main className="viewer-panel">
        <TreeCanvas
          tree={tree}
          order={order}
          viewMode={viewMode}
          zoomAxisMode={viewMode === "circular" ? "both" : zoomAxisMode}
          showTimeStripes={showTimeStripes}
          showScaleBars={showScaleBars}
          showGenusLabels={showGenusLabels}
          showNodeHeightLabels={showNodeHeightLabels}
          fitRequest={fitRequest}
          onHoverChange={handleHoverChange}
        />
      </main>
    </div>
  );
}
