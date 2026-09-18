import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readPsd, writePsdBuffer } from 'ag-psd';
import { combineSvg, parseSvg, cleanSvg } from '../server/svg.js';
import type { Layer } from '../server/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.LAYER_CANVAS_DATA = path.join(root, 'test-output', `bridge-review-${crypto.randomUUID()}`);
const serverModule = import('../server/index.js');

const baseLayer = (extra: Partial<Layer>): Layer => ({ id: 'layer-a', name: '标题', url: '/not-read', x: 0, y: 0, width: 128, height: 128, visible: true, opacity: 1, opinion: '', disposition: 'keep', kind: 'vector', ...extra });

test('SVG layer combination updates quoted and whitespace fragment URLs after ID namespacing', () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs><clipPath id="cut"><rect width="5" height="5"/></clipPath></defs><rect width="10" height="10" clip-path="url( &quot;#cut&quot; )"/></svg>';
  const result = combineSvg(10, 10, [baseLayer({ width: 10, height: 10 })], () => input);
  const doc = parseSvg(result);
  const target = Array.from(doc.getElementsByTagName('rect')).find(node => node.hasAttribute('clip-path'))!;
  const ref = target.getAttribute('clip-path')!;
  assert.match(ref, /#v0_cut/);
  assert(!ref.includes('#cut'));
});

test('SVG rejects external stylesheet processing instructions', () => {
  assert.throws(() => cleanSvg('<?xml-stylesheet href="https://example.invalid/paint.css" type="text/css"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'), /不允许|stylesheet|声明/);
});

test('editable SVG text retains multiline layout and declared outline/shadow', () => {
  const layer = baseLayer({ kind: 'text', text: { value: '第一行\n第二行', fontFamily: 'Arial', fontSize: 16, color: '#223344', x: 4, y: 20 }, psdStyle: { stroke: { color: '#ff0000', size: 2 }, shadow: { color: '#000000', blur: 2, offsetX: 3, offsetY: 4, opacity: .5 } } });
  const result = combineSvg(128, 128, [layer], () => '');
  const doc = parseSvg(result);
  assert(doc.getElementsByTagName('tspan').length >= 2, '每行应有明确基线位置');
  assert.match(result, /stroke="#ff0000"/);
  assert.match(result, /feDropShadow|feGaussianBlur/);
});

test('native PSD return preserves matching layer IDs, opinions and annotation bindings', async () => {
  await withApi(async api => {
    const fixture = await psdFixture();
    let doc = await api('/api/document?taskId=review_metadata_task');
    doc = await api(`/api/document/${doc.id}/import-path`, 'POST', { taskId: doc.taskId, path: fixture });
    const image = doc.images[0]; const layer = image.layers[0];
    layer.opinion = '保留描边，只把文字下移';
    image.annotations.push({ id: 'annotation_test', layerId: layer.id, type: 'arrow', points: [2, 3, 4, 5], text: '这一层', color: '#ff0000' });
    doc = await api(`/api/document/${doc.id}`, 'PUT', { document: doc, expectedRevision: doc.revision });
    const job = await api(`/api/document/${doc.id}/jobs`, 'POST', { type: 'photoshop', imageId: image.id });
    const applied = await api(`/api/jobs/${job.id}/apply`, 'POST', { taskId: doc.taskId, baseVersion: job.version, artifactPath: fixture });
    const returned = applied.document.images.find((i:any)=>i.id===applied.job.result.imageId);
    assert.notEqual(returned.id,image.id);assert.equal(returned.parentId,image.id);
    assert.equal(returned.layers[0].id, layer.id);
    assert.equal(returned.layers[0].opinion, layer.opinion);
    assert(returned.annotations.every((a: any) => a.layerId === null || returned.layers.some((l: any) => l.id === a.layerId)));
  });
});

test('PSD import reads actual text color and edited position survives PSD export', async () => {
  await withApi(async api => {
    const fixture = await psdFixture();
    let doc = await api('/api/document?taskId=review_text_task');
    doc = await api(`/api/document/${doc.id}/import-path`, 'POST', { taskId: doc.taskId, path: fixture });
    const image = doc.images[0]; const layer = image.layers[0];
    assert.equal(layer.text.color.toLowerCase(), '#cc3311');
    layer.text.x = 60; layer.text.y = 80; layer.text.value = 'Edited';
    doc = await api(`/api/document/${doc.id}`, 'PUT', { document: doc, expectedRevision: doc.revision });
    const { exportPsd } = await import('../server/media.js');
    const exported = readPsd(await exportPsd(doc.id, doc.images[0]), { useImageData: true });
    assert.equal(exported.children?.[0].text?.transform?.[4], 60);
    assert.equal(exported.children?.[0].text?.transform?.[5], 80);
    assert.equal(exported.children?.[0].text?.text, 'Edited');
  });
});

test('late image commit preserves concurrent other-image edits and rejects cancellation', async () => {
  await withApi(async api => {
    const fixture = await psdFixture();
    let doc = await api('/api/document?taskId=review_commit_task');
    doc = await api(`/api/document/${doc.id}/import-path`, 'POST', { taskId: doc.taskId, path: fixture });
    doc = await api(`/api/document/${doc.id}/import-path`, 'POST', { taskId: doc.taskId, path: fixture });
    const target = structuredClone(doc.images[0]);
    const job = await api(`/api/document/${doc.id}/jobs`, 'POST', { type: 'revise', imageId: target.id });
    doc.images[1].opinion = '并发编辑另一个图片';
    doc.images[0].x = 987;
    doc.layout.opinionsWidth = 450;
    doc = await api(`/api/document/${doc.id}`, 'PUT', { document: doc, expectedRevision: doc.revision });
    const { commitImage } = await import('../server/results.js');
    const { getJob } = await import('../server/store.js');
    const committed = commitImage(getJob(job.id), target);
    assert.equal(committed.images[1].opinion, '并发编辑另一个图片');
    assert.equal(committed.images[0].x, 987);
    assert.equal(committed.layout.opinionsWidth, 450);
    await api(`/api/jobs/${job.id}/cancel`, 'POST');
    assert.throws(() => commitImage(getJob(job.id), target), /取消/);
  });
});

test('PSD roundtrip preserves native group opacity and blend mode', async () => {
  await withApi(async api => {
    const fixture = await psdFixture(true);
    let doc = await api('/api/document?taskId=review_group_task');
    doc = await api(`/api/document/${doc.id}/import-path`, 'POST', { taskId: doc.taskId, path: fixture });
    const { exportPsd } = await import('../server/media.js');
    const roundtrip = readPsd(await exportPsd(doc.id, doc.images[0]), { useImageData: true });
    assert.equal(roundtrip.children?.[0].name, '原生图层组');
    assert(Math.abs((roundtrip.children?.[0].opacity ?? 1) - .5) < .01);
    assert.equal(roundtrip.children?.[0].blendMode, 'multiply');
  });
});

async function psdFixture(group = false) {
  await serverModule; // initializes native canvas for ag-psd
  const raw = new Uint8ClampedArray(128 * 128 * 4); raw.fill(255);
  const imageData = { width: 128, height: 128, data: raw };
  const leaf = { name: '标题', left: 0, top: 0, right: 128, bottom: 128, imageData, text: { text: 'Original', transform: [1, 0, 0, 1, 10, 20] as [number,number,number,number,number,number], style: { font: { name: 'Arial' }, fontSize: 16, fillColor: { r: 204, g: 51, b: 17 } } } };
  const bytes = writePsdBuffer({ width: 128, height: 128, imageData, children: group ? [{ name: '原生图层组', opacity: .5, blendMode: 'multiply', children: [leaf] }] : [leaf] });
  const fixture = path.join(process.env.LAYER_CANVAS_DATA!, `fixture-${crypto.randomUUID()}.psd`);
  await writeFile(fixture, bytes); return fixture;
}

async function withApi(fn: (api: (route: string, method?: string, body?: unknown) => Promise<any>) => Promise<void>) {
  const { app, TOKEN, BRIDGE_TOKEN } = await serverModule;
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const api = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method, headers: { 'X-Canvas-Token': TOKEN, 'X-Canvas-Bridge': BRIDGE_TOKEN, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  try { await fn(api); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
