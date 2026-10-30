import type { TreeModel } from "../types/tree";
import type { CustomCladeRibbon } from "./customCladeRibbons";

export const EMPTY_CLADE_RIBBONS: CustomCladeRibbon[] = [];
const EMPTY_LAYOUT = {
  ranges: [] as Array<CustomCladeRibbon & { start: number; end: number; lane: number }>,
  inside: 0,
  outside: 0,
};

export function resolveCladeRibbons(
  ribbons: readonly CustomCladeRibbon[],
  source: TreeModel,
  leaves: readonly number[] | Int32Array | Uint32Array,
  sourceNodeByViewNode?: ArrayLike<number> | null,
) {
  if (!ribbons.some((ribbon) => ribbon.enabled)) {
    return EMPTY_LAYOUT;
  }
  const starts = new Int32Array(source.nodeCount).fill(leaves.length);
  const ends = new Int32Array(source.nodeCount);
  const levels = new Int32Array(source.nodeCount);
  for (let index = 0; index < leaves.length; index++) {
    const node = sourceNodeByViewNode?.[leaves[index]] ?? leaves[index];
    starts[node] = Math.min(starts[node], index);
    ends[node] = index + 1;
  }
  // Aggregate visible descendant intervals once, rather than scan all tips per ribbon.
  const stack: Array<[number, boolean]> = [[source.root, false]];
  while (stack.length) {
    const [node, exiting] = stack.pop()!;
    if (exiting) {
      for (let child = source.buffers.firstChild[node]; child >= 0; child = source.buffers.nextSibling[child]) {
        starts[node] = Math.min(starts[node], starts[child]);
        ends[node] = Math.max(ends[node], ends[child]);
      }
      continue;
    }
    stack.push([node, true]);
    for (let child = source.buffers.firstChild[node]; child >= 0; child = source.buffers.nextSibling[child]) {
      levels[child] = levels[node] + 1;
      stack.push([child, false]);
    }
  }
  const ranges = ribbons.filter((ribbon) => ribbon.enabled && ribbon.node < source.nodeCount).flatMap((ribbon) => {
    const start = starts[ribbon.node];
    const end = ends[ribbon.node];
    return end > start ? [{ ...ribbon, start, end, lane: 0 }] : [];
  });
  ranges.sort((a, b) => a.start - b.start || b.end - a.end || levels[a.node] - levels[b.node] || a.id.localeCompare(b.id));
  const overlaps = (a: typeof ranges[number], b: typeof ranges[number]) => (
    a.placement === b.placement && a.start < b.end && b.start < a.end
  );
  const metadataLevels = new Int32Array(ranges.length);
  const metadata = ranges.map(range => range.id.startsWith("metadata-ribbon:"));
  // Determine metadata-only nesting first: manual annotations must not split
  // peers from one metadata level into independent tracks.
  for (let outer = ranges.length - 1; outer >= 0; outer--) {
    if (!metadata[outer]) continue;
    for (let inner = outer + 1; inner < ranges.length; inner++) {
      if (metadata[inner] && overlaps(ranges[outer], ranges[inner])) {
        metadataLevels[outer] = Math.max(metadataLevels[outer], metadataLevels[inner] + 1);
      }
    }
  }
  const groupIds = new Map<string, number>();
  const groups = ranges.map((range, i) => {
    const key = `${range.placement}:${metadata[i] ? `metadata:${metadataLevels[i]}` : `manual:${range.id}`}`;
    if (!groupIds.has(key)) groupIds.set(key, groupIds.size);
    return groupIds.get(key)!;
  });
  const successors = Array.from({ length: groupIds.size }, () => new Set<number>());
  const incoming = new Int32Array(groupIds.size);
  // Sorted intervals put ancestors first, including source-hierarchy ties for
  // clipped subtrees. Each descendant level must be inside its ancestor level.
  for (let outer = 0; outer < ranges.length; outer++) {
    for (let inner = outer + 1; inner < ranges.length; inner++) {
      if (!overlaps(ranges[outer], ranges[inner])) continue;
      const from = groups[inner], to = groups[outer];
      if (from !== to && !successors[from].has(to)) {
        successors[from].add(to);
        incoming[to]++;
      }
    }
  }
  const groupLanes = new Int32Array(groupIds.size);
  const ready = Array.from(incoming.keys()).filter(group => incoming[group] === 0);
  for (let i = 0; i < ready.length; i++) {
    for (const outer of successors[ready[i]]) {
      groupLanes[outer] = Math.max(groupLanes[outer], groupLanes[ready[i]] + 1);
      if (--incoming[outer] === 0) ready.push(outer);
    }
  }
  const counts = { inside: 0, outside: 0 };
  ranges.forEach((range, i) => {
    range.lane = groupLanes[groups[i]];
    counts[range.placement] = Math.max(counts[range.placement], range.lane + 1);
  });
  return { ranges, ...counts };
}
