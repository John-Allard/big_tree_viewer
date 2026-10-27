import { expect, test } from "@playwright/test";
import { resolveCladeRibbons } from "../src/lib/cladeRibbons";
import { parseTreePayload } from "../src/lib/treeParser";
import type { TreeModel } from "../src/types/tree";
import type { CustomCladeRibbon } from "../src/lib/customCladeRibbons";

const tree = parseTreePayload("(((A,B)AB,C)ABC,(D,E)DE)Root;").payload as TreeModel;
const make = (name: string, placement: "inside" | "outside" = "outside"): CustomCladeRibbon => ({
  id: name, node: tree.names.indexOf(name), label: name, color: "#2b8cbe", placement, enabled: true,
});

test("adjacent clades share a lane while nested clades stay separate", () => {
  const result = resolveCladeRibbons([make("ABC"), make("AB"), make("DE")], tree, tree.leafNodes);
  expect(result.outside).toBe(2);
  expect(result.inside).toBe(0);
  expect(result.ranges.map(range => [range.id, range.start, range.end, range.lane])).toEqual([
    ["ABC", 0, 3, 0], ["AB", 0, 2, 1], ["DE", 3, 5, 0],
  ]);
});

test("inside and outside lanes are independent and disabled ribbons reserve no space", () => {
  const result = resolveCladeRibbons([make("ABC", "inside"), make("AB"), { ...make("DE"), enabled: false }], tree, tree.leafNodes);
  expect(result.inside).toBe(1);
  expect(result.outside).toBe(1);
  expect(result.ranges.map(range => range.id)).toEqual(["ABC", "AB"]);
  const untouchedTree = new Proxy(tree, { get() { throw new Error("Empty ribbons must not traverse the tree"); } });
  expect(resolveCladeRibbons([], untouchedTree, [])).toEqual({ ranges: [], inside: 0, outside: 0 });
});

test("reordered and taxonomy-collapsed leaves resolve against original source nodes", () => {
  const result = resolveCladeRibbons([make("ABC"), make("DE")], tree, [...tree.leafNodes].reverse());
  expect(result.ranges.map(range => [range.id, range.start, range.end])).toEqual([["DE", 0, 2], ["ABC", 2, 5]]);
  const collapsed = resolveCladeRibbons([make("ABC"), make("AB"), make("DE")], tree, [0, 1],
    Int32Array.from([tree.names.indexOf("ABC"), tree.names.indexOf("DE")]));
  expect(collapsed.ranges.map(range => [range.id, range.start, range.end])).toEqual([["ABC", 0, 1], ["DE", 1, 2]]);
});
