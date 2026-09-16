import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const launcher = process.argv[2];
if (!launcher) throw new Error("Usage: npm run test:desktop:mcp-packaged -- <launcher-path>");
const treePath = path.resolve("tests/fixtures/agent-skill-tree.nwk");
const expectedTools = ["close_tree", "export_tree", "handoff_tree", "inspect_tree", "open_tree", "render_tree", "update_tree"];
const temporaryPrefix = "big-tree-viewer-mcp-";
const beforeDirectories = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith(temporaryPrefix)));

async function connect(name) {
  const transport = new StdioClientTransport({ command: path.resolve(launcher), stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", data => { stderr += data.toString(); });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), expectedTools);
  return { client, transport, stderr: () => stderr };
}

function payload(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent || JSON.parse(result.content[0].text);
}

const first = await connect("btv-packaged-first");
const second = await connect("btv-packaged-second");

try {
  const [firstOpen, secondOpen] = await Promise.all([
    first.client.callTool({ name: "open_tree", arguments: { treePath, layout: "circular" } }),
    second.client.callTool({ name: "open_tree", arguments: { newick: "((A:1,B:1):1,C:2);", layout: "rectangular" } }),
  ]);
  const firstTree = payload(firstOpen);
  const secondTree = payload(secondOpen);
  assert.equal(firstTree.tips, 16);
  assert.equal(firstTree.windowVisible, true);
  assert.equal(secondTree.tips, 3);
  assert.equal(secondTree.windowVisible, true);
  const inspected = payload(await first.client.callTool({ name: "inspect_tree", arguments: { sessionId: firstTree.sessionId } }));
  assert.equal(inspected.tips, 16);
  await Promise.all([
    first.client.callTool({ name: "close_tree", arguments: { sessionId: firstTree.sessionId } }),
    second.client.callTool({ name: "close_tree", arguments: { sessionId: secondTree.sessionId } }),
  ]);
} finally {
  await Promise.allSettled([first.client.close(), second.client.close()]);
}

assert.equal(first.stderr(), "");
assert.equal(second.stderr(), "");
await new Promise(resolve => setTimeout(resolve, 750));
const leakedDirectories = (await fs.readdir(os.tmpdir()))
  .filter(name => name.startsWith(temporaryPrefix) && !beforeDirectories.has(name));
assert.deepEqual(leakedDirectories, [], `Temporary MCP profiles were not removed: ${leakedDirectories.join(", ")}`);
console.log("Packaged MCP launcher exposed seven tools and supported two concurrent visible sessions.");
