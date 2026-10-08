import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { lifecycleGuard, hasCanvasOwners } from '../server/lifecycle.js';
import { desktopOwner, processAlive } from '../shared/process-owner.js';
import { acquireServiceLock } from '../server/service-lock.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test('service lock protects a live owner and recovers a crashed owner without touching data', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-lock-'));
  const release = acquireServiceLock(data); assert(release);
  assert.equal(acquireServiceLock(data), undefined);
  release();
  const dir = path.join(data, 'service-lock'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'owner-2147483647.json'), '{}');
  const recovered = acquireServiceLock(data); assert(recovered); recovered();
});
async function until(fn: () => boolean | Promise<boolean>, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(200); }
  throw new Error('Lifecycle condition timed out');
}

test('idle shutdown waits for every owner and work, and query failures retain service', async () => {
  let time = 0, owner = true, busy = false, stopped = 0, broken = false;
  const tick = lifecycleGuard({ now: () => time, graceMs: 100, owners: async () => { if (broken) throw Error(); return owner; }, busy: () => busy, stop: () => stopped++ });
  await tick(); owner = false; busy = true; time = 300; await tick(); assert.equal(stopped, 0);
  busy = false; time = 350; await tick(); assert.equal(stopped, 0);
  broken = true; time = 500; await tick(); broken = false; time = 550; await tick(); assert.equal(stopped, 0);
  owner = true; time = 1000; await tick(); owner = false; time = 1099; await tick(); assert.equal(stopped, 0);
  time = 1100; await tick(); await tick(); assert.equal(stopped, 1);
  let manualStopped = false;
  await lifecycleGuard({ owners: async () => false, busy: () => false, graceMs: 0, stop: () => { manualStopped = true; } })();
  assert.equal(manualStopped, false, 'manual npm start is not silently stopped');
});

test('desktop ownership follows ancestors only and stale bridge leases are removed', async () => {
  const rows = [{ pid: 1, parent: 0, name: 'ChatGPT.exe', started: 'one' }, { pid: 2, parent: 1, name: 'codex.exe', started: 'two' }, { pid: 3, parent: 2, name: 'node.exe', started: 'three' }, { pid: 4, parent: 0, name: 'Codex.exe', started: 'other' }];
  assert.deepEqual(desktopOwner(rows, 3), { pid: 1, started: 'one' });
  assert.equal(desktopOwner(rows, 90), undefined);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-owners-'));
  const dir = path.join(data, 'service-owners'); fs.mkdirSync(dir);
  const first = path.join(dir, 'first.json'), second = path.join(dir, 'second.json');
  fs.writeFileSync(first, JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(second, JSON.stringify({ pid: 2147483647 }));
  assert.equal(await hasCanvasOwners(data), true); assert(!fs.existsSync(second));
  fs.unlinkSync(first); assert.equal(await hasCanvasOwners(data), false);
});

test('two MCP connections auto-start one service, retain it until last exit and restart with same history/token/port', { timeout: 75000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-lifecycle-'));
  const root = path.resolve('.');
  const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  const docDir = path.join(data, 'documents', 'history-fixture'); fs.mkdirSync(docDir, { recursive: true });
  const docFile = path.join(docDir, 'document.json'); fs.writeFileSync(docFile, '{"preserve":"existing canvas history"}');
  const bytes = fs.readFileSync(docFile);
  const connect = async () => {
    const client = new Client({ name: 'lifecycle-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', path.join(root, 'bridge/mcp.ts')], cwd: root, env: { ...process.env, LAYER_CANVAS_ROOT: root, LAYER_CANVAS_DATA: data, LAYER_CANVAS_PORT: String(port), LAYER_CANVAS_HOST_TRACKING: '0' }, stderr: 'pipe' });
    transport.stderr?.on('data', () => {}); await client.connect(transport); return client;
  };
  const healthy = async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; } };
  const clients: Client[] = [];
  let pid: number | undefined;
  try {
    clients.push(...await Promise.all([connect(), connect()]));
    await until(healthy);
    const original = JSON.parse(fs.readFileSync(path.join(data, 'service.json'), 'utf8')); pid = original.pid;
    assert(pid); assert.equal(original.port, port);
    await clients[0].close(); await pause(1000); assert(await healthy());
    await clients[1].close(); await until(() => !processAlive(pid!));
    assert.deepEqual(fs.readFileSync(docFile), bytes);
    assert.equal((fs.readFileSync(path.join(data, 'service.log'), 'utf8').match(/listening on/g) || []).length, 1);
    clients.push(await connect()); await until(healthy);
    const restarted = JSON.parse(fs.readFileSync(path.join(data, 'service.json'), 'utf8')); pid = restarted.pid;
    assert.equal(restarted.port, original.port); assert.equal(restarted.token, original.token);
    assert.notEqual(restarted.pid, original.pid); assert.deepEqual(fs.readFileSync(docFile), bytes);
  } finally {
    for (const client of clients) await client.close();
    if (pid && processAlive(pid)) process.kill(pid);
  }
});
