import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { serviceIdentity } from '../shared/service-identity.js';

test('experiment CLI invalidates stale success on pending/failure, preserving call evidence and task boundaries', { timeout: 20000 }, async () => {
  const root = process.cwd();
  const data = path.join(os.tmpdir(), 'layer-canvas-experiments', crypto.randomUUID());
  const taskId = 'experiment-receipt-test-' + crypto.randomUUID();
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(data, file), 'utf8'));
  const run = (command: string, task = taskId) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/reconstruction-experiment.ts', command, '--data', data], {
      cwd: root, env: { ...process.env, CODEX_THREAD_ID: task }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
  };
  let rejectJobs = false;
  let receivedJobs: (() => void) | undefined;
  let releaseJobs: (() => void) | undefined;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') {
      res.end(JSON.stringify({ name: 'layer-canvas', instanceId: serviceIdentity(root, data) }));
    } else if (req.url?.startsWith('/api/document?')) {
      res.end(JSON.stringify({ id: 'fixture-document', taskId }));
    } else if (req.url?.startsWith('/api/jobs?')) {
      if (rejectJobs) {
        releaseJobs = () => { res.statusCode = 500; res.end(JSON.stringify({ error: 'deliberate receipt test failure' })); };
        receivedJobs?.();
      } else res.end('[]');
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const initialized = await run('init');
    assert.equal(initialized.code, 0, initialized.output);
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    fs.writeFileSync(path.join(data, 'service.json'), JSON.stringify({ port: address.port, token: 'fixture-token', bridgeToken: 'fixture-bridge-token' }));
    const success = await run('status');
    assert.equal(success.code, 0, success.output);
    assert.equal(read('last-status.json').document.taskId, taskId);
    const callsDir = path.join(data, 'experiment-calls');
    const originalCalls = fs.readdirSync(callsDir).map(file => ({ file, bytes: fs.readFileSync(path.join(callsDir, file)) }));
    rejectJobs = true;
    const arrived = new Promise<void>(resolve => { receivedJobs = resolve; });
    const failing = run('status');
    await arrived;
    try {
      assert.equal(read('last-status.json').status, 'pending');
      const pendingBytes = fs.readFileSync(path.join(data, 'last-status.json'));
      const overlapping = await run('status');
      assert.equal(overlapping.code, 1);
      assert.match(overlapping.output, /已有执行锁/);
      assert.deepEqual(fs.readFileSync(path.join(data, 'last-status.json')), pendingBytes);
    }
    finally { releaseJobs!(); releaseJobs = undefined; }
    const failed = await failing;
    assert.equal(failed.code, 1);
    const receipt = read('last-status.json');
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.taskId, taskId);
    assert.match(receipt.error, /deliberate receipt test failure/);
    assert.equal(JSON.parse(fs.readFileSync(receipt.record, 'utf8')).status, 'failed');
    assert.equal(fs.existsSync(path.join(data, 'last-status.lock.json')), false);
    for (const original of originalCalls) assert.deepEqual(fs.readFileSync(path.join(callsDir, original.file)), original.bytes);
    const failedBytes = fs.readFileSync(path.join(data, 'last-status.json'));
    const crossed = await run('status', 'other-fixture-task');
    assert.equal(crossed.code, 1);
    assert.match(crossed.output, /实验标记不匹配/);
    assert.deepEqual(fs.readFileSync(path.join(data, 'last-status.json')), failedBytes);
    const unknown = await run('unsupported');
    assert.equal(unknown.code, 1);
    assert.deepEqual(fs.readFileSync(path.join(data, 'last-status.json')), failedBytes);
    assert.equal(fs.existsSync(path.join(data, 'last-unsupported.json')), false);
    rejectJobs = false;
    const recovered = await run('status');
    assert.equal(recovered.code, 0, recovered.output);
    assert.equal(read('last-status.json').document.taskId, taskId);
    assert.equal(JSON.parse(fs.readFileSync(receipt.record, 'utf8')).status, 'failed');
  } finally {
    releaseJobs?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
