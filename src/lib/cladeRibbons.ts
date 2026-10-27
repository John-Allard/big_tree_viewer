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
  const starts = new Int32Array(source.nodeCount).fill(-1);
  const ends = new Int32Array(source.nodeCount);
  // DFS intervals make membership independent of the current display ordering.
  let clock = 0;
  const stack: Array<[number, boolean]> = [[source.root, false]];
  while (stack.length) {
    const [node, exiting] = stack.pop()!;
    if (exiting) { ends[node] = clock; continue; }
    starts[node] = clock++;
    stack.push([node, true]);
    for (let child = source.buffers.firstChild[node]; child >= 0; child = source.buffers.nextSibling[child]) {
      stack.push([child, false]);
    }
  }
  const ranges = ribbons.filter((ribbon) => ribbon.enabled && starts[ribbon.node] >= 0).flatMap((ribbon) => {
    let start = leaves.length;
    let end = 0;
    for (let index = 0; index < leaves.length; index++) {
      const node = sourceNodeByViewNode?.[leaves[index]] ?? leaves[index];
      if (starts[node] >= starts[ribbon.node] && starts[node] < ends[ribbon.node]) {
        start = Math.min(start, index);
        end = index + 1;
      }
    }
    return end > start ? [{ ...ribbon, start, end, lane: 0 }] : [];
  });
  const lanes = { inside: [] as number[], outside: [] as number[] };
  ranges.sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  for (const range of ranges) {
    const endsByLane = lanes[range.placement];
    let lane = endsByLane.findIndex((end) => end <= range.start);
    if (lane < 0) lane = endsByLane.length;
    endsByLane[lane] = range.end;
    range.lane = lane;
  }
  return { ranges, inside: lanes.inside.length, outside: lanes.outside.length };
}
