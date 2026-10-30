import type { TreeModel } from "../types/tree";
import { buildMetadataCollapseGroups } from "./metadataCollapse";

export interface CustomCladeRibbon {
  id: string;
  node: number;
  label: string;
  color: string;
  placement: "inside" | "outside";
  enabled: boolean;
  widthPx?: number;
  /** Legacy field name: 12 means 100% of the automatically fitted label size. */
  labelSizePx?: number;
}

export function normalizeCustomCladeRibbons(value: unknown, nodeCount?: number): CustomCladeRibbon[] {
  if (!Array.isArray(value)) return [];
  const result: CustomCladeRibbon[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { id, node, label, color, placement, enabled } = item;
    if (typeof id !== "string" || !id.trim() || id !== id.trim() || /[\x00-\x1f\x7f]/.test(id) || ids.has(id)) continue;
    if (!Number.isSafeInteger(node) || node < 0 || (nodeCount !== undefined && !(node < nodeCount))) continue;
    const cleanColor = color === undefined ? "#2b8cbe" : color;
    if (typeof label !== "string" || typeof cleanColor !== "string" || !/^#[0-9a-f]{6}$/i.test(cleanColor)) continue;
    const cleanLabel = label.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 256);
    ids.add(id);
    result.push({ id, node, label: cleanLabel, color: cleanColor, placement: placement === "inside" ? "inside" : "outside", enabled: typeof enabled === "boolean" ? enabled : true,
      ...(Number.isFinite(item.widthPx) ? { widthPx: Math.max(4, Math.min(120, item.widthPx)) } : {}),
      ...(Number.isFinite(item.labelSizePx) ? { labelSizePx: Math.max(5, Math.min(48, item.labelSizePx)) } : {}),
    });
    if (result.length === 200) break;
  }
  return result;
}

const RIBBON_COLORS = ["#2b8cbe", "#d95f0e", "#31a354", "#756bb1", "#de2d26", "#b58b00"];
const metadataKey = (text: string) => text.trim().replace(/^['"]+|['"]+$/g, "").replaceAll("_", " ").replace(/\s+/g, " ").toLowerCase();

/** Materialize ribbons once, without keeping a large metadata-derived overlay live. */
export function buildMetadataCladeRibbons(tree: TreeModel, rows: ReadonlyArray<Readonly<Record<string, string>>>,
  keyColumn: string, labelColumn: string, mode: "nodes" | "tips"): CustomCladeRibbon[] {
  if (!keyColumn || !labelColumn) return [];
  let groups: Array<{ node: number; label: string }>;
  if (mode === "tips") {
    groups = buildMetadataCollapseGroups(tree, rows, keyColumn, labelColumn);
  } else {
    const labels = new Map<string, string>();
    for (const row of rows) {
      const key = metadataKey(row[keyColumn] ?? "");
      const label = (row[labelColumn] ?? "").trim();
      if (!key) continue;
      if (labels.has(key) && labels.get(key) !== label) throw new Error(`Conflicting ribbon labels for metadata key "${key}".`);
      labels.set(key, label);
    }
    const nodes = new Map<string, number>();
    const ambiguous = new Set<string>();
    for (let node = 0; node < tree.nodeCount; node++) {
      if (tree.buffers.firstChild[node] < 0) continue;
      const key = metadataKey(tree.names[node] ?? "");
      if (!key) continue;
      if (nodes.has(key)) ambiguous.add(key);
      nodes.set(key, node);
    }
    groups = [];
    for (const [key, label] of labels) {
      if (!label || !nodes.has(key)) continue;
      if (ambiguous.has(key)) throw new Error(`Internal node name "${key}" is not unique.`);
      groups.push({ node: nodes.get(key)!, label });
    }
  }
  if (groups.length > 200) throw new Error(`This mapping produces ${groups.length} ribbons; the limit is 200. Choose a coarser grouping.`);
  const colors = new Map<string, string>();
  return normalizeCustomCladeRibbons(groups.map(({ node, label }) => {
    if (!colors.has(label)) colors.set(label, RIBBON_COLORS[colors.size % RIBBON_COLORS.length]);
    return { id: `metadata-ribbon:${mode}:${node}`, node, label, color: colors.get(label)!, placement: "outside", enabled: true };
  }), tree.nodeCount);
}

function preorder(tree: TreeModel, root: number): number[] {
  const order: number[] = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    order.push(node);
    const children: number[] = [];
    for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) children.push(child);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return order;
}

export function remapCladeRibbonsForSubtree(tree: TreeModel, rootNode: number, ribbons: readonly CustomCladeRibbon[]): CustomCladeRibbon[] {
  if (!Number.isInteger(rootNode) || rootNode < 0 || rootNode >= tree.nodeCount) return [];
  const mapping = new Map(preorder(tree, rootNode).map((node, index) => [node, index]));
  const ancestors = new Set<number>();
  for (let node = tree.buffers.parent[rootNode]; node >= 0; node = tree.buffers.parent[node]) ancestors.add(node);
  return normalizeCustomCladeRibbons(ribbons, tree.nodeCount).flatMap(ribbon => {
    const node = mapping.get(ribbon.node) ?? (ancestors.has(ribbon.node) ? 0 : undefined);
    return node === undefined ? [] : [{ ...ribbon, node }];
  });
}

function hashName(name: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function indexClades(tree: TreeModel, ambiguous: Set<string>) {
  const order = tree.nodeCount ? preorder(tree, tree.root) : [];
  const counts = new Uint32Array(tree.nodeCount);
  const first = new Uint32Array(tree.nodeCount);
  const second = new Uint32Array(tree.nodeCount);
  const blocked = new Uint8Array(tree.nodeCount);
  const keys = new Array<string>(tree.nodeCount);
  const byKey = new Map<string, number[]>();
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    if (tree.buffers.firstChild[node] < 0) {
      const name = tree.names[node] ?? "";
      counts[node] = 1;
      first[node] = hashName(name, 2166136261);
      second[node] = hashName(name, 3335557771);
      blocked[node] = !name || ambiguous.has(name) ? 1 : 0;
    } else {
      for (let child = tree.buffers.firstChild[node]; child >= 0; child = tree.buffers.nextSibling[child]) {
        counts[node] += counts[child];
        first[node] += first[child];
        second[node] += second[child];
        blocked[node] |= blocked[child];
      }
    }
    const key = `${counts[node]}:${first[node]}:${second[node]}`;
    keys[node] = key;
    if (!blocked[node]) {
      const bucket = byKey.get(key);
      if (bucket) bucket.push(node);
      else byKey.set(key, [node]);
    }
  }
  return { keys, byKey, blocked };
}

function tipNames(tree: TreeModel, root: number): string[] {
  return preorder(tree, root).filter(node => tree.buffers.firstChild[node] < 0).map(node => tree.names[node] ?? "").sort();
}

/** Match rooted clades, not bipartitions: a reversed edge is not the same clade. */
export function remapCladeRibbonsForTree(previousTree: TreeModel, nextTree: TreeModel, ribbons: readonly CustomCladeRibbon[]): CustomCladeRibbon[] {
  const normalized = normalizeCustomCladeRibbons(ribbons, previousTree.nodeCount);
  if (!normalized.length) return [];
  const ambiguous = new Set<string>();
  for (const tree of [previousTree, nextTree]) {
    const seen = new Set<string>();
    for (let node = 0; node < tree.nodeCount; node++) {
      if (tree.buffers.firstChild[node] >= 0) continue;
      const name = tree.names[node] ?? "";
      if (seen.has(name)) ambiguous.add(name);
      seen.add(name);
    }
  }
  const previous = indexClades(previousTree, ambiguous);
  const next = indexClades(nextTree, ambiguous);
  const matches = new Map<number, number | null>();
  return normalized.flatMap(ribbon => {
    if (!matches.has(ribbon.node)) {
      const key = previous.keys[ribbon.node];
      const candidates = next.byKey.get(key);
      let match: number | null = null;
      // Unary ancestors have the same clade; postorder chooses its deepest node.
      if (!previous.blocked[ribbon.node] && candidates?.length) {
        const before = tipNames(previousTree, ribbon.node);
        const after = tipNames(nextTree, candidates[0]);
        if (before.length === after.length && before.every((name, i) => name === after[i])) match = candidates[0];
      }
      matches.set(ribbon.node, match);
    }
    const node = matches.get(ribbon.node);
    return node == null ? [] : [{ ...ribbon, node }];
  });
}
