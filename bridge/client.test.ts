import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { CanvasClient, validateTask } from './client.js';
import { buildHandoffPrompt } from './handoff.js';

test('task binding rejects invented formats and another active conversation', () => {
  assert.throws(() => validateTask('abc', ''), /真实/);
  assert.throws(() => validateTask('task_other', 'task_current'), /当前/);
  assert.equal(validateTask('task_current', 'task_current'), 'task_current');
});

test('API bridge transmits private token, limits queue to current task, and retains taskId on mutations', async () => {
  const calls: { url: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['x-canvas-token'], 'public-token-123456');
    assert.equal(req.headers['x-canvas-bridge'], 'private-token-12345');
    let body = ''; for await (const piece of req) body += piece;
    calls.push({ url: req.url!, body: body ? JSON.parse(body) : undefined });
    const result = req.url === '/api/dispatch/wait' ? {taskId:'task_current', available:!calls.at(-1)?.body.excludeJobIds.includes('job_plan'), jobs:calls.at(-1)?.body.excludeJobIds.includes('job_plan')?[]:[{id:'job_plan',taskId:'task_current',status:'waiting_codex',type:'plan'}]} : req.url?.startsWith('/api/jobs?') ? [
      { id: 'job_plan', taskId: 'task_current', documentId: 'doc1', status: 'waiting_codex', type: 'plan' },
      { id: 'job_vector', taskId: 'task_current', documentId: 'doc1', status: 'queued', type: 'vectorize' },
    ] : { ok: true };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = 'task_current';
  try {
    const address = server.address(); assert(address && typeof address === 'object');
    const client = new CanvasClient(async () => ({ port: address.port, token: 'public-token-123456', bridgeToken: 'private-token-12345' }));
    const available = await client.wait('task_current', 0) as any;
    assert.deepEqual(available.jobs.map((job: any) => job.id), ['job_plan']);
    const excluded = await client.wait('task_current', 0, ['job_plan']) as any;
    assert.equal(excluded.available, false);
    await client.mutateJob('task_current', 'job_plan', 'claim');
    assert.deepEqual(calls.at(-1)?.body, { taskId: 'task_current' });
    await assert.rejects(() => client.mutateJob('task_current', 'job_not_mine', 'apply'), /不属于/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous;
    await close(server);
  }
});

test('documents from another task fail closed', async () => {
  const client = new CanvasClient();
  client.request = async <T>() => ({ taskId: 'wrong_task' }) as T;
  const previous = process.env.CODEX_THREAD_ID; delete process.env.CODEX_THREAD_ID;
  try { await assert.rejects(() => client.document('task_current'), /其他任务/); }
  finally { if (previous !== undefined) process.env.CODEX_THREAD_ID = previous; }
});

test('handoff distinguishes editable PSD from true native AI, requires preserved layers and actual verification', () => {
  const ps = buildHandoffPrompt('photoshop'); const ai = buildHandoffPrompt('illustrator');
  assert.match(ps, /真实分层 PSD/); assert.match(ps, /keep/); assert.match(ps, /重新打开实际输出/);
  assert.match(ai, /不得把 SVG\/PDF 改扩展名/); assert.match(ai, /另存纯矢量 SVG/);
});

async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
