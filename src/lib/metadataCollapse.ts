import type { TreeModel } from "../types/tree";

export interface MetadataCollapseGroup {
  node: number;
  label: string;
  tipCount: number;
}

function normalizeKey(value: string): string {
  return value.trim().replace(/^['"]+|['"]+$/g, "").replaceAll("_", " ").replace(/\s+/g, " ").toLowerCase();
}

/**
 * Finds maximal internal clades with at least two tips sharing one nonempty value.
 * Keys follow metadata overlay normalization; category values are trimmed but
 * otherwise exact. Conflicting duplicate keys (including blank/nonblank values)
 * are unusable, regardless of row order. Internal-node metadata is not inherited.
 * Accepts a valid tree model or payload without changing its topology or buffers.
 * Runs iteratively in O(nodes + rows) time and space, excluding string lengths.
 */
export function buildMetadataCollapseGroups(
  tree: Pick<TreeModel, "root" | "nodeCount" | "names" | "buffers">,
  rows: ReadonlyArray<Readonly<Record<string, string>>>,
  keyColumn: string,
  valueColumn: string,
): MetadataCollapseGroup[] {
  if (!keyColumn || !valueColumn || tree.nodeCount === 0) {
    return [];
  }

  const valueByKey = new Map<string, string | null>();
  for (const row of rows) {
    const key = normalizeKey(row[keyColumn] ?? "");
    if (!key) {
      continue;
    }
    const value = (row[valueColumn] ?? "").trim();
    if (valueByKey.has(key) && valueByKey.get(key) !== value) {
      valueByKey.set(key, null);
    } else if (!valueByKey.has(key)) {
      valueByKey.set(key, value);
    }
  }

  const { firstChild, nextSibling, parent } = tree.buffers;
  // Build a parent-before-child order rather than relying on node numbering,
  // which can change after rerooting. Its reverse is a valid bottom-up order.
  const order = new Int32Array(tree.nodeCount);
  order[0] = tree.root;
  let length = 1;
  for (let index = 0; index < length; index += 1) {
    for (let child = firstChild[order[index]]; child >= 0; child = nextSibling[child]) {
      order[length++] = child;
    }
  }

  const labels = new Array<string | null>(tree.nodeCount).fill(null);
  const tipCounts = new Int32Array(tree.nodeCount);
  for (let index = length - 1; index >= 0; index -= 1) {
    const node = order[index];
    const first = firstChild[node];
    if (first < 0) {
      labels[node] = valueByKey.get(normalizeKey(tree.names[node] ?? "")) || null;
      tipCounts[node] = 1;
      continue;
    }
    let label = labels[first];
    for (let child = first; child >= 0; child = nextSibling[child]) {
      tipCounts[node] += tipCounts[child];
      if (labels[child] !== label) {
        label = null;
      }
    }
    labels[node] = label;
  }

  const groups: MetadataCollapseGroup[] = [];
  for (let index = 0; index < length; index += 1) {
    const node = order[index];
    const label = labels[node];
    if (
      label !== null
      && firstChild[node] >= 0
      && tipCounts[node] >= 2
      && (node === tree.root || labels[parent[node]] === null)
    ) {
      groups.push({ node, label, tipCount: tipCounts[node] });
    }
  }
  return groups;
}
