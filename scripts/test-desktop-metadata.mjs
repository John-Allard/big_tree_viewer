import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve('.');
const dir = await mkdtemp(path.join(os.tmpdir(), 'btv-metadata-mcp-'));
const packaged = Boolean(process.argv[2]);
const executable = packaged ? path.resolve(process.argv[2]) : path.join(root, 'node_modules/electron/dist/electron');
const resources = packaged
  ? process.platform === 'darwin' ? path.resolve(path.dirname(executable), '..', 'Resources') : path.join(path.dirname(executable), 'resources')
  : root;
const helper = path.join(resources, ...(packaged ? ['app.asar'] : []), 'desktop', 'mcp-helper.cjs');
const transport = new StdioClientTransport({ command: executable, args: [helper, '--helper-version=2'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_DISABLE_SANDBOX: '1',
    BTV_APP_EXECUTABLE: executable, BTV_HANDOFF_USER_DATA_DIR: path.join(dir, 'profile'),
    BTV_SHARED_USER_DATA_DIR: path.join(dir, 'cache'),
    ...(packaged ? {} : { BTV_APP_MAIN: path.join(root, 'desktop/main.cjs') }) }, stderr: 'pipe' });
transport.stderr?.on('data', bytes => process.stderr.write(bytes));
const client = new Client({ name: 'btv-metadata-test', version: '1.0.0' });
const metadata = {
  text: 'id,display,country,date,family,genus\ns1,Sample One,France,2022-01-01,Alpha,One\ns2,Sample Two,France,2022-02-01,Alpha,One\ns3,Sample Three,Canada,2023-01-01,Beta,Two\ns4,Sample Four,Canada,2023-02-01,Beta,Two\n',
  keyColumn: 'id', tipLabelColumn: 'display', enabled: true, valueColumn: 'date', colorMode: 'date',
  rankColumns: { family: 'family', genus: 'genus' },
};
const ribbon = { id: 'study', node: 1, label: 'Study clade', color: '#159b83', placement: 'outside', enabled: true };
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent || JSON.parse(result.content[0].text);
}
try {
  await client.connect(transport);
  const opened = await call('open_tree', { newick: '((s1:1,s2:1)PairA:1,(s3:1,s4:1)PairB:1)Root;',
    layout: 'rectangular', metadata, settings: {
      showGenusLabels: false, customCladeRibbons: [ribbon], metadataLegendEnabled: true,
      metadataTipTableEnabled: true, metadataTipTableMode: 'heatmap',
      metadataTipTableColumns: [{ column: 'date', label: 'Collection date', valueType: 'date' }],
      figureStyles: { scale: { calendarAxis: true, calendarRootYear: 2020, showTimeGuideLabels: true } },
    } });
  const sessionId = opened.sessionId;
  assert.equal(opened.metadata.error, null);
  assert.equal(opened.metadata.rowCount, 4);
  assert.equal(opened.metadata.coloredNodes, 4);
  assert.equal(opened.metadata.tipTableMatchedTips, 4);
  assert.equal(opened.metadata.enabledCladeRibbonCount, 1);
  assert.equal(opened.taxonomy.mappedTips, 4);
  assert.equal(opened.settings.metadataColorMode, 'date');
  assert.equal(opened.settings.tipLabelMetadataColumn, 'display');
  assert.deepEqual(opened.settings.customCladeRibbons, [ribbon]);
  const svgPath = path.join(dir, 'metadata.svg');
  await call('export_tree', { sessionId, outputPath: svgPath });
  const svg = await readFile(svgPath, 'utf8');
  assert.match(svg, /Sample One/);
  assert.match(svg, /Study clade/);
  assert.match(svg, /#159b83/i);
  const collapsed = await call('update_tree', { sessionId, metadata: { collapseColumn: 'country' } });
  assert.equal(collapsed.settings.metadataCollapseColumn, 'country');
  assert.equal(collapsed.metadata.collapseGroupCount, 2);
  const collapsedSvgPath = path.join(dir, 'collapsed.svg');
  await call('export_tree', { sessionId, outputPath: collapsedSvgPath });
  const collapsedSvg = await readFile(collapsedSvgPath, 'utf8');
  assert.match(collapsedSvg, /France/);
  assert.match(collapsedSvg, /Canada/);
  assert.doesNotMatch(collapsedSvg, /Sample One/);
  const sessionPath = path.join(dir, 'metadata.btvsession');
  await call('export_tree', { sessionId, outputPath: sessionPath });
  const saved = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.equal(saved.taxonomy.map.mappingOrigin, 'metadata-ranks');
  assert.equal(saved.settings.metadataTipTableColumns[0].valueType, 'date');
  assert.equal(saved.settings.figureStyles.scale.calendarRootYear, 2020);
  const reopened = await call('open_tree', { treePath: sessionPath });
  assert.equal(reopened.settings.metadataCollapseColumn, 'country');
  assert.deepEqual(reopened.settings.customCladeRibbons, [ribbon]);
  await call('close_tree', { sessionId: reopened.sessionId });
  const reset = await call('update_tree', { sessionId, metadata: { collapseColumn: '', tipLabelColumn: '' },
    layout: 'fan', settings: { customCladeRibbons: [], scaleTickIntervalInput: '0.25',
      figureStyles: { scale: { showPartialRadialScaleBar: false } } } });
  assert.equal(reset.settings.metadataCollapseColumn, '');
  assert.equal(reset.metadata.collapseGroupCount, 0);
  assert.equal(reset.settings.tipLabelMetadataColumn, '');
  assert.deepEqual(reset.settings.customCladeRibbons, []);
  assert.equal(reset.settings.figureStyles.scale.showPartialRadialScaleBar, false);
  assert.equal(reset.settings.scaleTickIntervalInput, '0.25');
  const info = await call('inspect_tree', { sessionId });
  assert.equal(info.taxonomy.mappedTips, 4);
  await call('close_tree', { sessionId });
  console.log('Desktop MCP metadata/scales: date colors, display names, custom taxonomy, clade ribbons, tables, collapse, session roundtrip, and reset passed.');
} finally {
  await client.close();
  await rm(dir, { recursive: true, force: true });
}
