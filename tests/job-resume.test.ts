import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { AddressInfo } from 'node:net';
import type { Job } from '../server/types.js';

process.env.LAYER_CANVAS_DATA = path.resolve('test-output/job-resume-' + Date.now());
const { app, TOKEN, BRIDGE_TOKEN } = await import('../server/index.js');
const store = await import('../server/store.js');
afterEach(() => { for (const job of store.jobs()) if (job.status === 'running') store.saveJob({ ...job, status: 'cancelled' }); });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const doc = store.getByTask('resume-test-task');
const sourceBytes = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#f08040' } }).png().toBuffer();
const { importImage } = await import('../server/media.js');
const image = await importImage(doc, sourceBytes, 'source.png');
doc.images.push(image);
store.save(doc);

function fixture(status: Job['status'] = 'failed', checkpoint = true, type: Job['type'] = 'layer') {
  const j: Job = { id: store.uid(), documentId: doc.id, taskId: doc.taskId, imageId: image.id, type, status, message: 'interrupted', createdAt: store.now(), version: image.version, mode: 3, engine: 'vectorizer', snapshot: structuredClone(image) };
  store.saveJob(j);
  const folder = path.join(store.dir(doc.id), 'jobs', j.id);
  if (checkpoint) {
    fs.mkdirSync(path.join(folder, 'generation'), { recursive: true });
    const file = path.join(folder, 'candidate.png');
    fs.writeFileSync(file, sourceBytes);
    store.atomic(path.join(folder, 'generation', 'registry.json'), { requests: [{ id: 'request-fixed' }], outputs: [{ id: 'generation-fixed', requestId: 'request-fixed', originalPath: file, workingPath: file }] });
  }
  return j;
}
function resume(j: Job, body: object = {}, internal = true) {
  return fetch(`${base}/api/jobs/${j.id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': TOKEN, ...(internal ? { 'X-Canvas-Bridge': BRIDGE_TOKEN } : {}) }, body: JSON.stringify({ taskId: doc.taskId, reason: '受控恢复检查点', ...body }) });
}

test('failed reconstruction resumes same job and leaves registry untouched', async () => {
  const j = fixture();
  const file = path.join(store.dir(doc.id), 'jobs', j.id, 'generation', 'registry.json');
  const bytes = fs.readFileSync(file);
  const result = await resume(j);
  assert.equal(result.status, 200);
  const value: any = await result.json();
  assert.equal(value.job.id, j.id);
  assert.equal(value.job.status, 'running');
  assert.equal(value.job.dispatch.state, 'received');
  assert.equal(value.checkpoints.registered, 1);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(store.load(doc.id).images.length, 1);
  const log = store.json<any[]>(path.join(store.dir(doc.id), 'jobs', j.id, 'resume-history.json'), []);
  assert.equal(log[0].from, 'failed');
  assert.equal((await resume(j)).status, 409);
});

test('cancelled tasks require explicit confirmation and reason; completed always rejected', async () => {
  const j = fixture('cancelled');
  assert.equal((await resume(j)).status, 409);
  assert.equal((await resume(j, { confirmCancelled: true, reason: ' ' })).status, 400);
  assert.equal((await resume(j, { confirmCancelled: 'true' })).status, 409);
  assert.equal((await resume(j, { confirmCancelled: true })).status, 200);
  assert.equal((await resume(fixture('completed'), { confirmCancelled: true })).status, 409);
});

test('resume requires bridge authorization, correct task and actual checkpoint files', async () => {
  const j = fixture();
  assert.equal((await resume(j, {}, false)).status, 403);
  assert.equal((await resume(j, { taskId: 'other-task' })).status, 403);
  assert.equal((await resume(fixture('failed', false))).status, 409);
  assert.equal((await resume(fixture('failed', true, 'plan'))).status, 409);
  fs.unlinkSync(path.join(store.dir(doc.id), 'jobs', j.id, 'candidate.png'));
  assert.equal((await resume(j)).status, 409);
});

test('stale source, removed source, cross-document and already committed jobs cannot resume', async () => {
  const j = fixture();
  let current = store.load(doc.id);
  current.images[0].version++;
  store.save(current);
  assert.equal((await resume(j)).status, 409);
  current.images[0].version = j.version;
  current.images.push({ ...structuredClone(image), id: store.uid(), sourceJobId: j.id });
  store.save(current);
  assert.equal((await resume(j)).status, 409);
  current.images = [];
  store.save(current);
  assert.equal((await resume(j)).status, 409);
  current.images = [structuredClone(image)];
  current.taskId = 'other-document-task';
  store.save(current);
  assert.equal((await resume(j)).status, 403);
  store.save(doc);
});

test('PS checkpoints and staged files resume without performing Adobe or model work', async () => {
  const ps = fixture('failed', false, 'photoshop');
  const folder = path.join(store.dir(doc.id), 'jobs', ps.id);
  store.atomic(path.join(folder, 'photoshop-rebuild.json'), { version: 2, materials: { layer: { path: store.assetPath(doc.id, image.source), status: 'ready' } }, reviews: {} });
  assert.equal((await resume(ps)).status, 200);
  const staged = fixture('failed', false, 'revise');
  store.atomic(path.join(store.dir(doc.id), 'jobs', staged.id, 'staged-layers.json'), [{ id: 'staged', url: image.source, kind: 'raster', preview: false }]);
  assert.equal((await resume(staged)).status, 409);
  store.saveJob({ ...store.getJob(ps.id), status: 'cancelled' });
  assert.equal((await resume(staged)).status, 200);
});
