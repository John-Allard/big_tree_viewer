import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import TreeCanvas from "./components/TreeCanvas";
import { computeGenusBlocks, computeOrderedLeaves } from "./components/treeCanvasCache";
import { getCachedTaxonomyArchive, putCachedTaxonomyArchive } from "./lib/taxonomyCache";
import type { WorkerResponse } from "./types/messages";
import type { TaxonomyMapPayload } from "./types/taxonomy";
import type { WorkerTreePayload } from "./types/tree";
import type { LayoutOrder, LoadState, TreeModel, ViewMode, ZoomAxisMode } from "./types/tree";

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (Math.abs(value) < 0.001) {
    return value.toExponential(3);
  }
  if (Math.abs(value) >= 1000) {
    return value.toFixed(0);
  }
  return value.toFixed(4).replace(/\.?0+$/, "");
}

function normalizeSearchQuery(value: string): string {
  return value.toLowerCase();
}

function normalizeSearchTarget(value: string): string {
  return value.trim().replace(/^['"]+|['"]+$/g, "").replaceAll("_", " ").toLowerCase();
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

interface TaxonomyWorkerResponse {
  type: "taxonomy-progress" | "taxonomy-downloaded" | "taxonomy-mapped" | "taxonomy-error";
  message?: string;
  archive?: ArrayBuffer;
  payload?: TaxonomyMapPayload;
}

function taxonomyToken(name: string): string {
  return normalizeSearchTarget(name).split(/ +/).filter(Boolean)[0] ?? "unknown";
}

function prefixGroup(value: string, length: number, suffix: string): string {
  const base = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!base) {
    return `unknown-${suffix}`;
  }
  return `${base.slice(0, Math.max(1, Math.min(length, base.length)))}${suffix}`;
}

function buildMockTaxonomyMap(tree: TreeModel): TaxonomyMapPayload {
  return {
    mappedCount: tree.leafNodes.length,
    totalTips: tree.leafNodes.length,
    tipRanks: Array.from(tree.leafNodes, (node) => {
      const genus = taxonomyToken(tree.names[node] || "");
      return {
        node,
        ranks: {
          superkingdom: "cellular organisms",
          phylum: prefixGroup(genus, 1, "-phy"),
          class: prefixGroup(genus, 2, "-cls"),
          order: prefixGroup(genus, 3, "-ord"),
          family: prefixGroup(genus, 4, "-fam"),
          genus,
        },
      };
    }),
  };
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

function splitOutsideQuotes(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" || character === "\"") {
      if (quote === character) {
        quote = null;
      } else if (quote === null) {
        quote = character;
      }
      current += character;
      continue;
    }
    if (character === delimiter && quote === null) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function stripWrappingQuotes(value: string): string {
  return value.trim().replace(/^['"]+|['"]+$/g, "");
}

function applyNexusTranslate(newick: string, translate: Map<string, string>): string {
  if (translate.size === 0) {
    return newick;
  }
  let output = "";
  let token = "";
  let quote: "'" | "\"" | null = null;
  const flushToken = (): void => {
    if (!token) {
      return;
    }
    output += translate.get(token) ?? token;
    token = "";
  };
  for (let index = 0; index < newick.length; index += 1) {
    const character = newick[index];
    if (character === "'" || character === "\"") {
      flushToken();
      if (quote === character) {
        quote = null;
      } else if (quote === null) {
        quote = character;
      }
      output += character;
      continue;
    }
    if (quote !== null) {
      output += character;
      continue;
    }
    if (/[\s(),:;[\]]/.test(character)) {
      flushToken();
      output += character;
      continue;
    }
    token += character;
  }
  flushToken();
  return output;
}

function normalizeImportedTreeText(text: string): string {
  const trimmed = text.trim();
  if (!/^#?nexus/i.test(trimmed) && !/begin\s+trees\s*;/i.test(trimmed)) {
    return text;
  }
  const treeBlockMatch = /begin\s+trees\s*;([\s\S]*?)end\s*;/i.exec(trimmed);
  const treeBlock = treeBlockMatch?.[1] ?? trimmed;
  const translate = new Map<string, string>();
  const translateMatch = /translate\s+([\s\S]*?);/i.exec(treeBlock);
  if (translateMatch) {
    const entries = splitOutsideQuotes(translateMatch[1], ",");
    for (let index = 0; index < entries.length; index += 1) {
      const match = /^(\S+)\s+(.+)$/.exec(entries[index].trim());
      if (!match) {
        continue;
      }
      translate.set(match[1], stripWrappingQuotes(match[2]));
    }
  }
  const treeMatch = /tree\s+[^=]+=\s*(?:\[[^\]]*\]\s*)*([\s\S]*?;)/i.exec(treeBlock);
  if (!treeMatch) {
    return text;
  }
  return applyNexusTranslate(treeMatch[1].trim(), translate);
}

export default function App() {
  const workerRef = useRef<Worker | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const didAutoloadRef = useRef(false);
  const dragCounterRef = useRef(0);
  const pendingPasteHideRef = useRef(false);
  const [tree, setTree] = useState<TreeModel | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({
    loading: false,
    message: "Load a Newick tree to begin.",
    error: null,
  });
  const [viewMode, setViewMode] = useState<ViewMode>("rectangular");
  const [order, setOrder] = useState<LayoutOrder>("asc");
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
  const [taxonomyOpen, setTaxonomyOpen] = useSessionDisclosure("section-taxonomy", false);
  const [searchOpen, setSearchOpen] = useSessionDisclosure("section-search", false);
  const [statsOpen, setStatsOpen] = useSessionDisclosure("section-stats", false);
  const [sidebarVisible, setSidebarVisible] = useSessionDisclosure("sidebar-visible", true);
  const [pastedTreeText, setPastedTreeText] = useState("");
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [exportSvgRequest, setExportSvgRequest] = useState(0);
  const [taxonomyCached, setTaxonomyCached] = useState<boolean | null>(null);
  const [taxonomyLoading, setTaxonomyLoading] = useState(false);
  const [taxonomyStatus, setTaxonomyStatus] = useState("");
  const [taxonomyError, setTaxonomyError] = useState<string | null>(null);
  const [taxonomyEnabled, setTaxonomyEnabled] = useState(false);
  const [taxonomyMap, setTaxonomyMap] = useState<TaxonomyMapPayload | null>(null);
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
      pendingPasteHideRef.current = false;
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
    if (pendingPasteHideRef.current) {
      pendingPasteHideRef.current = false;
      setShowPasteInput(false);
      setPastedTreeText("");
    }
    setFitRequest((value) => value + 1);
  }, []);

  const handleWorkerError = useCallback((event: ErrorEvent): void => {
    pendingPasteHideRef.current = false;
    setLoadState({
      loading: false,
      message: "Tree worker failed.",
      error: event.message || "Unknown worker error.",
    });
  }, []);

  const handleWorkerMessageError = useCallback((): void => {
    pendingPasteHideRef.current = false;
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
    const normalizedText = normalizeImportedTreeText(text);
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
      text: normalizedText,
    });
  }, [ensureWorker]);

  const runTaxonomyWorker = useCallback((request: { type: "download-taxonomy" } | { type: "map-taxonomy"; archive: ArrayBuffer; tips: Array<{ node: number; name: string }> }): Promise<TaxonomyWorkerResponse> => {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./workers/taxonomyWorker.ts", import.meta.url), { type: "module" });
      const cleanup = (): void => {
        worker.terminate();
      };
      worker.addEventListener("message", (event: MessageEvent<TaxonomyWorkerResponse>) => {
        const data = event.data;
        if (data.type === "taxonomy-progress") {
          setTaxonomyStatus(data.message ?? "");
          return;
        }
        cleanup();
        resolve(data);
      });
      worker.addEventListener("error", (event) => {
        cleanup();
        reject(event.error ?? new Error(event.message || "Taxonomy worker failed."));
      });
      worker.postMessage(
        request,
        request.type === "map-taxonomy" ? [request.archive] : [],
      );
    });
  }, []);

  useEffect(() => {
    void (async () => {
      const cached = await getCachedTaxonomyArchive();
      setTaxonomyCached(cached !== null);
    })();
  }, []);

  const loadSubtreeFromUrl = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined") {
      return false;
    }
    const params = new URLSearchParams(window.location.search);
    const subtreeKey = params.get("subtree");
    if (!subtreeKey) {
      return false;
    }
    const text = window.localStorage.getItem(subtreeKey);
    if (!text) {
      setLoadState({
        loading: false,
        message: "Unable to load shared subtree.",
        error: "The requested subtree payload is not available in local storage.",
      });
      return true;
    }
    await parseText(text, "shared subtree");
    return true;
  }, [parseText]);

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
    void (async () => {
      const loadedSubtree = await loadSubtreeFromUrl();
      if (!loadedSubtree) {
        await loadExample();
      }
    })();
  }, [loadExample, loadSubtreeFromUrl]);

  useEffect(() => {
    if (!tree) {
      return;
    }
    setTaxonomyMap(null);
    setTaxonomyEnabled(false);
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

  const loadPastedTree = useCallback(async (): Promise<void> => {
    const text = pastedTreeText.trim();
    if (!text) {
      setLoadState({
        loading: false,
        message: "Paste a tree string first.",
        error: "No pasted tree text was provided.",
      });
      return;
    }
    pendingPasteHideRef.current = true;
    await parseText(text, "pasted tree");
  }, [parseText, pastedTreeText]);

  const handleDrop = useCallback(async (event: DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault();
    dragCounterRef.current = 0;
    setDragActive(false);
    const dataTransfer = "dataTransfer" in event ? event.dataTransfer : null;
    if (!dataTransfer) {
      return;
    }
    const file = dataTransfer.files?.[0];
    if (file) {
      const text = await file.text();
      await parseText(text, file.name);
      return;
    }
    const plainText = dataTransfer.getData("text/plain");
    if (plainText.trim()) {
      setPastedTreeText(plainText);
      await parseText(plainText, "dropped tree text");
    }
  }, [parseText]);

  const downloadTaxonomy = useCallback(async (): Promise<void> => {
    setTaxonomyLoading(true);
    setTaxonomyError(null);
    setTaxonomyStatus("Preparing taxonomy download...");
    try {
      const response = await runTaxonomyWorker({ type: "download-taxonomy" });
      if (response.type !== "taxonomy-downloaded" || !response.archive) {
        throw new Error(response.message || "Taxonomy download did not complete.");
      }
      await putCachedTaxonomyArchive(new Blob([response.archive], { type: "application/zip" }));
      setTaxonomyCached(true);
      setTaxonomyStatus("Taxonomy download cached locally.");
    } catch (error) {
      setTaxonomyError(error instanceof Error ? error.message : String(error));
    } finally {
      setTaxonomyLoading(false);
    }
  }, [runTaxonomyWorker]);

  const runTaxonomyMapping = useCallback(async (): Promise<void> => {
    if (!tree) {
      return;
    }
    setTaxonomyLoading(true);
    setTaxonomyError(null);
    setTaxonomyStatus("Loading taxonomy cache...");
    try {
      const archive = await getCachedTaxonomyArchive();
      if (!archive) {
        throw new Error("Taxonomy cache not found. Download the taxonomy first.");
      }
      const tips = Array.from(tree.leafNodes, (node) => ({
        node,
        name: tree.names[node] || "",
      }));
      const response = await runTaxonomyWorker({
        type: "map-taxonomy",
        archive: await archive.arrayBuffer(),
        tips,
      });
      if (response.type !== "taxonomy-mapped" || !response.payload) {
        throw new Error(response.message || "Taxonomy mapping did not complete.");
      }
      setTaxonomyMap(response.payload);
      setTaxonomyEnabled(true);
      setTaxonomyStatus(`Mapped taxonomy for ${response.payload.mappedCount.toLocaleString()} of ${response.payload.totalTips.toLocaleString()} tips.`);
    } catch (error) {
      setTaxonomyError(error instanceof Error ? error.message : String(error));
    } finally {
      setTaxonomyLoading(false);
    }
  }, [runTaxonomyWorker, tree]);

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.__BIG_TREE_VIEWER_APP_TEST__ = {
      getState: () => ({
        treeLoaded: tree !== null,
        loading: loadState.loading,
        loadError: loadState.error,
        viewMode,
        order,
        showGenusLabels,
        taxonomyEnabled,
        taxonomyMappedCount: taxonomyMap?.mappedCount ?? 0,
        maxDepth: tree?.maxDepth ?? null,
        rootAge: tree?.rootAge ?? null,
        isUltrametric: tree?.isUltrametric ?? false,
      }),
      setViewMode,
      setOrder,
      setShowGenusLabels,
      setTaxonomyEnabled,
      setMockTaxonomy: () => {
        if (!tree) {
          return;
        }
        setTaxonomyMap(buildMockTaxonomyMap(tree));
        setTaxonomyEnabled(true);
      },
      clearTaxonomy: () => {
        setTaxonomyMap(null);
        setTaxonomyEnabled(false);
      },
      requestFit: () => setFitRequest((value) => value + 1),
    };
    return () => {
      delete window.__BIG_TREE_VIEWER_APP_TEST__;
    };
  }, [loadState.error, loadState.loading, order, showGenusLabels, taxonomyEnabled, taxonomyMap, tree, viewMode]);

  return (
    <div
      className={`app-shell${sidebarVisible ? "" : " sidebar-hidden"}${dragActive ? " drag-active" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        dragCounterRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) {
          setDragActive(false);
        }
      }}
      onDrop={(event) => void handleDrop(event)}
    >
      {dragActive ? <div className="drag-overlay">Drop a tree file or Newick / NEXUS text to load it</div> : null}
      <button
        type="button"
        className="mobile-sidebar-toggle"
        onClick={() => setSidebarVisible(!sidebarVisible)}
      >
        {sidebarVisible ? "Hide Panel" : "Show Panel"}
      </button>
      <aside className="control-panel">
        <div className="panel-title-block">
          <h1>Big Tree Viewer</h1>
          <p>by John B Allard</p>
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
            <button
              type="button"
              className="secondary"
              onClick={() => setShowPasteInput((value) => !value)}
            >
              Paste Newick
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".nwk,.newick,.tree,.tre,.txt,.nex,.nexus"
              hidden
              onChange={(event) => void onFileChange(event)}
            />
          </div>
          {showPasteInput ? (
            <div className="paste-tree">
              <textarea
                value={pastedTreeText}
                onChange={(event) => setPastedTreeText(event.target.value)}
                placeholder="Paste a Newick or NEXUS tree string here"
                spellCheck={false}
              />
              <div className="button-row">
                <button type="button" className="secondary" onClick={() => void loadPastedTree()}>
                  Load Pasted Tree
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setPastedTreeText("");
                    setShowPasteInput(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              disabled={!tree}
              onClick={() => setExportSvgRequest((value) => value + 1)}
            >
              Export View SVG
            </button>
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
            <button type="button" className={order === "asc" ? "active" : ""} onClick={() => setOrder("asc")}>
              Smallest First
            </button>
            <button type="button" className={order === "desc" ? "active" : ""} onClick={() => setOrder("desc")}>
              Largest First
            </button>
            <button type="button" className={order === "input" ? "active" : ""} onClick={() => setOrder("input")}>
              Input Order
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
              Zoom X
            </button>
            <button
              type="button"
              className={zoomAxisMode === "y" ? "active" : ""}
              onClick={() => setZoomAxisMode("y")}
              disabled={viewMode === "circular"}
            >
              Zoom Y
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

        <PanelSection title="Taxonomy" isOpen={taxonomyOpen} onToggle={() => setTaxonomyOpen(!taxonomyOpen)}>
          <div className="search-controls">
            {taxonomyCached ? (
              <p className="status-line">Taxonomy cache found.</p>
            ) : (
              <div className="button-row">
                <button type="button" className="secondary" disabled={taxonomyLoading} onClick={() => void downloadTaxonomy()}>
                  Download Taxonomy
                </button>
              </div>
            )}
            {taxonomyCached ? (
              <div className="button-row">
                <button type="button" className="secondary" disabled={taxonomyLoading || !tree} onClick={() => void runTaxonomyMapping()}>
                  Run Taxonomy Mapping
                </button>
              </div>
            ) : null}
            {taxonomyMap ? (
              <label>
                <input
                  type="checkbox"
                  checked={taxonomyEnabled}
                  onChange={(event) => setTaxonomyEnabled(event.target.checked)}
                />
                Show taxonomy overlays
              </label>
            ) : null}
            {taxonomyStatus ? <p className="status-line">{taxonomyStatus}</p> : null}
            {taxonomyError ? <p className="status-error">{taxonomyError}</p> : null}
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
          taxonomyEnabled={taxonomyEnabled}
          taxonomyMap={taxonomyMap}
          showNodeHeightLabels={showNodeHeightLabels}
          searchQuery={searchQuery}
          searchMatches={searchMatches}
          activeSearchNode={activeSearchNode}
          activeSearchGenusCenterNode={activeSearchGenusCenterNode}
          focusNodeRequest={focusNodeRequest}
          fitRequest={fitRequest}
          exportSvgRequest={exportSvgRequest}
          onHoverChange={handleHoverChange}
        />
      </main>
    </div>
  );
}
