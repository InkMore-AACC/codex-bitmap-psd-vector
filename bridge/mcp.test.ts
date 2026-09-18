import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

test('stdio MCP initializes and discovers task-bound canvas tools without starting a model', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', path.join(root, 'bridge', 'mcp.ts')], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'layer-canvas-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listing = await client.listTools();
    assert.equal(listing.tools.length, 11);
    for (const tool of listing.tools) assert(tool.inputSchema.required?.includes('taskId'));
    assert(listing.tools.some(tool => tool.name === 'canvas_apply_plan'));
    assert(listing.tools.some(tool => tool.name === 'canvas_web_vector'));
    const result = await client.callTool({ name: 'canvas_complete_request', arguments: { taskId: 'task_current', jobId: 'empty_job', baseVersion: 1 } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /必须提供实际/);
  } finally { await client.close(); }
});

test('configured plugin MCP starts outside the workspace with Windows-safe ESM import', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(await fs.readFile(path.join(root, 'plugins/layer-canvas/.mcp.json'), 'utf8')).mcpServers.layer_canvas;
  assert.match(config.args[1], /^file:\/\//);
  const transport = new StdioClientTransport({ ...config, env: { ...process.env, ...config.env }, cwd: os.tmpdir(), stderr: 'pipe' });
  const client = new Client({ name: 'installed-configuration-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 11);
  } finally { await client.close(); }
});
