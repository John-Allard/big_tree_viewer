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
