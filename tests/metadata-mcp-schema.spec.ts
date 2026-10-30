import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { toolDefinitions } = require("../desktop/automation-tools.cjs");
const schema = z.object(toolDefinitions.update_tree.shape);

test("desktop MCP accepts chronological colors and partial rank assignments", () => {
  const input = { sessionId: "example", metadata: {
    colorMode: "date", keyColumn: "id", tipLabelColumn: "name", collapseColumn: "country",
    taxIdColumn: "taxid", rankColumns: { family: "family", genus: "genus" },
  } };
  expect(schema.parse(input)).toEqual(input);
});

test("desktop MCP rejects unsupported rank names and date modes", () => {
  expect(schema.safeParse({ sessionId: "example", metadata: { rankColumns: { nonsense: "column" } } }).success).toBe(false);
  expect(schema.safeParse({ sessionId: "example", metadata: { colorMode: "guess-date" } }).success).toBe(false);
});

test("all desktop editing tools expose automatic taxonomy and metadata ribbon imports", () => {
  const metadata = { autoRankColumns: true, cladeRibbons: { labelColumn: "country", mode: "tips", widthPx: 40, labelSizePx: 18 } };
  for (const name of ["open_tree", "update_tree", "render_tree"]) {
    const options = z.object(toolDefinitions[name].shape).shape.metadata;
    expect(options.parse(metadata)).toEqual(metadata);
    expect(options.safeParse({ cladeRibbons: { labelColumn: "country", mode: "guess" } }).success).toBe(false);
    expect(options.safeParse({ cladeRibbons: { labelColumn: "country", mode: "tips", widthPx: 500 } }).success).toBe(false);
  }
});
