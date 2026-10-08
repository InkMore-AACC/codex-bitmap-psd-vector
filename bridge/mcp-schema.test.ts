import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexToolSchema, CodexStdioServerTransport } from './mcp-schema.js';

test('schema adapter preserves tuple size, bounds, property names and user data', () => {
  const source = { type: 'object', properties: {
    point: { type: 'array', items: [{ type: 'number' }, { type: 'number' }], minItems: 2, maxItems: 2 },
    box: { type: 'array', items: [{ type: 'number', minimum: -100 }, { type: 'number', exclusiveMinimum: 0 }], minItems: 2, maxItems: 2, description: 'box' },
    items: { type: 'string' },
  }, default: { items: [{ user: 'data' }] } };
  const snapshot = structuredClone(source);
  const result = codexToolSchema(source) as any;
  assert.deepEqual(result.properties.point, { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 });
  assert.deepEqual(result.properties.box.items, { anyOf: [{ type: 'number', minimum: -100 }, { type: 'number', exclusiveMinimum: 0 }] });
  assert.match(result.properties.box.description, /^box\nTuple positions/);
  assert.deepEqual(result.properties.items, { type: 'string' });
  assert.deepEqual(result.default, source.default);
  assert.deepEqual(source, snapshot);
  assert.throws(() => codexToolSchema({ type: 'array', items: [{ type: 'number' }] }), /fixed-length/);
});

test('stdio adapter changes only advertised tool schemas', async () => {
  const output = new PassThrough();
  let wire = '';
  output.on('data', chunk => { wire += chunk; });
  const transport = new CodexStdioServerTransport(new PassThrough(), output);
  const schema = { type: 'array', items: [{ type: 'number' }], minItems: 1, maxItems: 1 };
  await transport.send({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'probe', inputSchema: schema }] } });
  await transport.send({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(schema) }] } });
  const [listing, call] = wire.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(listing.result.tools[0].inputSchema.items, { type: 'number' });
  assert.equal(call.result.content[0].text, JSON.stringify(schema));
});

test('real MCP listing has no tuple items arrays and original Zod rejects invalid tuple calls', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const data = await mkdtemp(path.join(os.tmpdir(), 'canvas-schema-test-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', path.join(root, 'bridge/mcp.ts')], cwd: root, stderr: 'pipe',
    env: { ...process.env, LAYER_CANVAS_DATA: data, LAYER_CANVAS_PORT: '0', LAYER_CANVAS_HOST_TRACKING: '0' },
  });
  const client = new Client({ name: 'schema-test', version: '1' });
  try {
    await client.connect(transport);
    const listing = await client.listTools();
    assert.equal(listing.tools.length, 14);
    function inspect(value: any) {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'array') assert(!Array.isArray(value.items), 'host-facing items must be a schema');
      Object.values(value).forEach(inspect);
    }
    listing.tools.forEach(tool => inspect(tool.inputSchema));
    const plan = listing.tools.find(tool => tool.name === 'canvas_apply_plan')!;
    const box = (plan.inputSchema.properties?.layers as any).items.properties.box;
    assert.deepEqual(box.items, { type: 'number' });
    assert.equal(box.minItems, 4);
    assert.equal(box.maxItems, 4);
    // Missing task/job IDs intentionally prevent any live job lookup as well.
    const shortBox = await client.callTool({ name: 'canvas_apply_plan', arguments: {
      baseVersion: 1, layers: [{ name: 'test', box: [0, 0, 1] }],
    } });
    assert.equal(shortBox.isError, true);
    assert.match(JSON.stringify(shortBox), /at least 4 element/);
    const invalidWidth = await client.callTool({ name: 'canvas_complete_request', arguments: {
      baseVersion: 1, layers: [{ name: 'test', width: 1, height: 1, review: {
        status: 'needs-revision', attempts: [{ method: 'a', observation: 'a' }, { method: 'b', observation: 'b' }],
        issues: [{ message: 'test', box: [-5, -5, -1, 10] }],
      } }],
    } });
    assert.equal(invalidWidth.isError, true);
    assert.match(JSON.stringify(invalidWidth), /greater than 0/);
    assert.match(JSON.stringify(invalidWidth), /box/);
  } finally { await client.close(); }
});
