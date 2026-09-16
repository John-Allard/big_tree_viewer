import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron, expect } from 'playwright/test';
const root = path.resolve('.');
const dir = await mkdtemp(path.join(os.tmpdir(), 'btv-agent-test-'));
const executable = process.argv[2] || path.join(root, 'node_modules/electron/dist/electron');
const args = process.argv[2] ? ['--mcp', '--no-sandbox', '--disable-gpu'] : [path.join(root, 'desktop/main.cjs'), '--mcp', '--no-sandbox', '--disable-gpu'];
const transport = new StdioClientTransport({ command: executable, args,
  env: { ...process.env, BTV_AGENT_PROFILE: `test-${process.pid}`, ELECTRON_DISABLE_SANDBOX: '1', BTV_USER_DATA_DIR: path.join(dir, 'profile') }, stderr: 'pipe' });
transport.stderr?.on('data', data => process.stderr.write(data));
const client = new Client({ name: 'btv-integration-test', version: '1.0.0' });
let count = 0;
let gui;
async function call(name, args, error = false) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  if (error) { assert.equal(result.isError, true, JSON.stringify(result)); count++; return result; }
  assert.notEqual(result.isError, true, JSON.stringify(result)); count++;
  return result.structuredContent || JSON.parse(result.content[0].text);
}
try {
  await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 7);
  const opened = await call('open_tree', { treePath: path.join(root, 'tests/fixtures/agent-skill-tree.nwk'), layout: 'circular', settings: { showTipLabels: false } });
  assert.equal(opened.windowVisible, true); assert.equal(opened.tips, 16); assert.equal(opened.layout, 'circular'); assert.equal(opened.settings.showTipLabels, false);
  const sessionId = opened.sessionId;
  gui = await electron.launch({ executablePath: path.resolve(executable),
    args: process.argv[2] ? ['--no-sandbox','--disable-gpu'] : [path.join(root,'desktop/main.cjs'),'--no-sandbox','--disable-gpu'],
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', BTV_USER_DATA_DIR: path.join(dir, 'profile') } });
  const guiPage = await gui.firstWindow();
  await expect(guiPage.getByText('Drag a tree file here to load', { exact: true })).toBeVisible();
  const updated = await call('update_tree', { sessionId, layout: 'rectangular', settings: { showTipLabels: true, branchThicknessScale: 1.8 } });
  assert.equal(updated.layout, 'rectangular'); assert.equal(updated.settings.showTipLabels, true);
  const meta = await call('update_tree', { sessionId, metadataPath: path.join(root, 'tests/fixtures/agent-skill-metadata.csv'), metadata: { enabled: true, keyColumn: 'name', valueColumn: 'group', colorMode: 'categorical' } });
  assert.equal(meta.metadata.error, null);
  await call('update_tree', { sessionId, canvas: { camera: { kind: 'rect', scaleX: 2, scaleY: 2, translateX: 0, translateY: 0 }, viewportWidth: 1600, viewportHeight: 1000 } });
  const png = path.join(dir, 'tree.png');
  await call('export_tree', { sessionId, outputPath: png, width: 800, height: 600 });
  const bytes = await readFile(png); assert.equal(bytes.readUInt32BE(16), 800); assert.equal(bytes.readUInt32BE(20), 600); assert.ok(bytes.length > 1000);
  await call('export_tree', { sessionId, outputPath: png }, true);
  const saved = path.join(dir, 'saved.btvsession');
  await call('export_tree', { sessionId, outputPath: saved });
  const savedData = JSON.parse(await readFile(saved, 'utf8')); assert.equal(savedData.settings.branchThicknessScale, 1.8); assert.ok(Math.abs(savedData.canvas.camera.scaleX - 2 * savedData.canvas.viewportWidth / 1600) < 0.001); assert.ok(savedData.metadata.text.includes('alpha'));
  const reopened = await call('open_tree', { treePath: saved }); assert.equal(reopened.tips, 16); assert.equal(reopened.settings.showTipLabels, true);
  await call('update_tree', { sessionId, settings: { nonexistentSetting: true } }, true);
  await call('update_tree', { sessionId, layout: 'spiral' }, true);
  await call('open_tree', { treePath: 'relative.nwk' }, true);
  const nexus = path.join(dir, 'tree.nex'); await writeFile(nexus, '#NEXUS\nBEGIN TREES;\nTREE test = ((A:1,B:1):1,C:2);\nEND;');
  const rendered = await call('render_tree', { treePath: nexus, layout: 'circular', outputPath: path.join(dir, 'nexus.svg') });
  assert.equal(rendered.tree.tips, 3); assert.equal(rendered.sessionClosed, true); assert.match(await readFile(rendered.outputPath, 'utf8'), /<svg/);
  const extensionless = path.join(dir, 'RAxML_bestTree'); await writeFile(extensionless, '(A:1,B:1);');
  const plain = await call('render_tree', { treePath: extensionless, outputPath: path.join(dir, 'extensionless.svg') }); assert.equal(plain.tree.tips, 2);
  const info = await call('inspect_tree', { sessionId }); assert.equal(info.tips, 16);
  const handoff = await call('handoff_tree', { sessionId });
  assert.ok(handoff.outputPath.endsWith('.btvsession'));
  await expect(guiPage.getByRole('button', { name: 'Download Newick', exact: true })).toBeEnabled({ timeout: 15000 });
  await call('close_tree', { sessionId }); await call('inspect_tree', { sessionId }, true);
  await call('close_tree', { sessionId: reopened.sessionId });
  const large = await call('render_tree', { treePath: path.join(root, 'public/example_tree.btvsession'), layout: 'spiral',
    settings: { taxonomyEnabled: true, taxonomyRankVisibility: { class: true }, showTipLabels: false }, outputPath: path.join(dir, 'large.png'), width: 1200, height: 1200 });
  assert.equal(large.tree.tips, 50033); assert.ok(large.tree.taxonomy.mappedTips > 49000);
  assert.equal(large.tree.layout, 'spiral');
  await client.close();
  await expect(guiPage.getByRole('button', { name: 'Download Newick', exact: true })).toBeEnabled();
  console.log(`Passed ${count} desktop MCP operations: visible open, update, inspect, PNG/SVG export, session roundtrip, NEXUS, error handling, and close.`);
} finally { await client.close(); await gui?.close(); await rm(dir, { recursive: true, force: true }); }
