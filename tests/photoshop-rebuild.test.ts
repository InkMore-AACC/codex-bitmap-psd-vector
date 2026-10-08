import { persistedLegacyJob } from './legacy-reconstruction.js';
import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { writePsdBuffer } from 'ag-psd';
import { planningLayer } from '../shared/planning.js';
import {
  photoshopSettingsSchema,
  photoshopMaterialTarget,
  isPhotoshopFullBackground,
} from '../shared/photoshop.js';
import { retainNativeAssets } from '../web/reconcile.js';
process.env.LAYER_CANVAS_DATA = path.resolve('test-output/ps-rebuild-' + crypto.randomUUID());
const { app, TOKEN, BRIDGE_TOKEN, adobe } = await import('../server/index.js');
const store = await import('../server/store.js');
const ps = await import('../server/photoshop-rebuild.js');
const native = await import('../server/photoshop-native.js');
const { renderImage, exportPsd } = await import('../server/media.js');
app.locals.codexSender = async () => ({ delivered: true });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
after(() => {
  server.closeAllConnections();
  server.close();
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

test('native progress reads actual visible glyph groups and rejects hidden, pixel or wrong text substitutes', () => {
  const layer = { layerId: 'native', name: '参数文字', route: 'native', editable: 'native-text',
    frame: { x: 0, y: 0, width: 100, height: 60 }, textTargets: [{ layerName: 'value', text: 'Air 1.0003' }] };
  const plan: any = { canvas: { width: 100, height: 60 }, layers: [layer], relations: [] };
  const glyph: any = { name: 'value', left: 5, top: 5, right: 85, bottom: 18,
    imageData: { width: 80, height: 13, data: new Uint8ClampedArray(80 * 13 * 4).fill(255) },
    text: { text: 'Air 1.0003', style: { font: { name: 'ArialMT' }, fontSize: 12 } } };
  const bytes = (children: any[]) => writePsdBuffer({ width: 100, height: 60, children }, { generateThumbnail: false });
  assert.equal(native.nativeProgressLayers(bytes([{ name: 'LC_native', children: [glyph] }]), plan, plan.canvas)[0].layerId, 'native');
  assert.equal(native.nativeProgressLayers(bytes([{ name: 'LC_native', children: [] }]), plan, plan.canvas).length, 0);
  assert.equal(native.nativeProgressLayers(bytes([{ name: 'LC_native', hidden: true, children: [glyph] }]), plan, plan.canvas).length, 0);
  assert.equal(native.nativeProgressLayers(bytes([{ name: 'LC_native', children: [{ ...glyph, hidden: true }] }]), plan, plan.canvas).length, 0);
  assert.equal(native.nativeProgressLayers(bytes([{ name: 'LC_native', children: [{ ...glyph, opacity: 0 }] }]), plan, plan.canvas).length, 0);
  assert.throws(() => native.nativeProgressLayers(bytes([{ name: 'LC_native', children: [{ ...glyph, text: undefined }] }]), plan, plan.canvas), /像素\/占位/);
  assert.throws(() => native.nativeProgressLayers(bytes([{ name: 'LC_native', children: [{ ...glyph, text: { ...glyph.text, text: 'Air 0.0000' } }] }]), plan, plan.canvas), /匹配文字/);
  assert.throws(() => native.nativeProgressLayers(bytes([{ name: 'LC_native', children: [glyph] }, { name: 'LC_native', children: [glyph] }]), plan, plan.canvas), /分组重复/);
  assert.throws(() => native.nativeProgressLayers(bytes([{ name: 'LC_native', children: [glyph] }]), plan, { width: 101, height: 60 }), /画幅/);
});
test('PS full opaque background bleeds uniformly; foreground and partial opaque assets do not', () => {
  const frame = { x: 0, y: 0, width: 1024, height: 1536 };
  assert.equal(isPhotoshopFullBackground({ surface: 'opaque', frame }, frame), true);
  assert.equal(isPhotoshopFullBackground({ surface: 'transparent', frame }, frame), false);
  assert.equal(
    isPhotoshopFullBackground({ surface: 'opaque', frame: { ...frame, x: 1 } }, frame),
    false,
  );
  const ordinary = photoshopMaterialTarget({ width: 1000, height: 1500 }, frame);
  assert.deepEqual(ordinary, { ...frame, bleedScale: 1 });
  const opaque = photoshopMaterialTarget({ width: 1000, height: 1500 }, frame, true);
  assert.equal(opaque.x, -1);
  assert.equal(opaque.y, -1.5);
  assert.equal(opaque.width / opaque.height, frame.width / frame.height);
});
const headers = {
  'Content-Type': 'application/json',
  'X-Canvas-Token': TOKEN,
  'X-Canvas-Bridge': BRIDGE_TOKEN,
};
async function api(route: string, body?: unknown, method = body ? 'POST' : 'GET', expected = 200) {
  const r = await fetch(base + route, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const value: any = await r.json();
  assert.equal(r.status, expected, JSON.stringify(value));
  await persistedLegacyJob(route, value);
  return value;
}
async function fixture() {
  const d = store.getByTask('ps_test_' + crypto.randomUUID());
  const url = store.writeAsset(
    d.id,
    await sharp({ create: { width: 80, height: 60, channels: 4, background: '#193d42' } })
      .png()
      .toBuffer(),
    '.png',
  );
  d.images.push({
    id: 'source',
    name: '测试',
    width: 80,
    height: 60,
    x: 0,
    y: 0,
    source: url,
    url,
    status: 'preview',
    version: 1,
    opinion: '原样重建',
    annotations: [],
    layers: [
      planningLayer('bg', '背景', { x: 0, y: 0, width: 80, height: 60 }, 'background', '补全'),
      planningLayer(
        'text',
        '标题',
        { x: 5, y: 10, width: 60, height: 20 },
        'foreground',
        '保持字形',
      ),
    ],
  });
  store.save(d);
  const queued = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: 'source', type: 'photoshop' },
    'POST',
    202,
  );
  await api(`/api/jobs/${queued.id}/claim`, { taskId: d.taskId });
  return store.getJob(queued.id);
}
function plan(j: any) {
  return {
    layers: j.snapshot.layers.map((l: any) => ({
      layerId: l.id,
      name: l.name,
      frame: l.frame,
      route: l.id === 'bg' ? 'generate' : 'native',
      content: l.id === 'bg' ? 'background' : 'text',
      surface: l.id === 'bg' ? 'opaque' : 'transparent',
      rationale: '按参考重建',
      includes: l.name,
      excludes: '其他元素',
      compositing: '普通；内容各自归属，不重复叠加',
      editable: l.id === 'bg' ? 'pixels' : 'native-text',
      dependencies: [],
      textTargets:
        l.id === 'text'
          ? [{ layerName: l.name, text: 'Test', box: { x: 5, y: 10, width: 60, height: 20 } }]
          : [],
    })),
  };
}
function psd(p: any, placeholder = false) {
  const data = new Uint8ClampedArray((placeholder ? 1 : 80) * (placeholder ? 1 : 60) * 4);
  data.fill(255);
  const imageData = { width: placeholder ? 1 : 80, height: placeholder ? 1 : 60, data };
  return writePsdBuffer({
    width: 80,
    height: 60,
    children: p.layers.map((l: any) => ({
      name: 'LC_' + l.layerId,
      children: [
        {
          name: l.name,
          imageData,
          ...(l.content === 'text'
            ? {
                text: {
                  text: 'Test',
                  transform: [1, 0, 0, 1, 5, 25] as [
                    number,
                    number,
                    number,
                    number,
                    number,
                    number,
                  ],
                  style: { font: { name: 'ArialMT' }, fontSize: 16 },
                },
              }
            : {}),
        },
      ],
    })),
  });
}
test('PS automatic super resolution skips small budget normalization but retains meaningful enlargement', () => {
  assert.equal(ps.needsPhotoshopUpscale(1.024, true), false);
  assert.equal(ps.needsPhotoshopUpscale(1.15, true), false);
  assert.equal(ps.needsPhotoshopUpscale(1.16, true), true);
  assert.equal(ps.needsPhotoshopUpscale(2, false), false);
  assert.equal(ps.needsPhotoshopUpscale(2, true, true), false);
});
test('PS explicit force can run reviewed small-scale SR without changing automatic threshold', async () => {
  const j = await fixture();
  j.reconstructionWorkflowVersion = 4;
  await ps.photoshopAction(j, { action: 'plan', plan: plan(j) }, {} as any);
  const file = path.join(ps.photoshopFolder(j), 'small-budget.png');
  await sharp({ create: { width: 80, height: 60, channels: 4, background: '#345678' } })
    .png()
    .toFile(file);
  await ps.beginPhotoshopMaterial(j, {
    action: 'material',
    layerId: 'bg',
    path: file,
    provenance: 'generated',
    observation: 'isolated fixture',
    allowAspectFit: false,
    evidence: {
      generation: {
        tool: 'image_gen',
        outputPath: file,
        referencePaths: [store.assetPath(j.documentId, j.snapshot.source)],
        prompt: 'test fixture only',
      },
    },
  });
  await ps.processPhotoshopMaterial(j, 'bg', new AbortController().signal, async () => {
    throw Error('automatic SR should not run');
  });
  const s = ps.photoshopState(j),
    m = s.materials.bg;
  assert.equal(m.needsUpscale, false);
  const checked = path.join(ps.photoshopFolder(j), 'checked.psd');
  fs.writeFileSync(checked, 'isolated review evidence');
  m.upscaleEvidence = {
    workingHash: native.fileHash(m.workingPath!),
    psdPath: checked,
    psdHash: native.fileHash(checked),
  };
  store.atomic(path.join(ps.photoshopFolder(j), 'photoshop-rebuild.json'), s);
  await assert.rejects(
    ps.photoshopAction(j, { action: 'upscale-material', layerId: 'bg' }, {} as any),
    /force:true/,
  );
  await ps.photoshopAction(
    j,
    { action: 'upscale-material', layerId: 'bg', force: true },
    {} as any,
  );
  let calls = 0;
  await ps.processPhotoshopMaterial(j, 'bg', new AbortController().signal, async (args) => {
    calls++;
    const file = path.join(args[args.indexOf('--output') + 1], 'upscaled.png');
    fs.writeFileSync(file, await sharp({ create: { width: 160, height: 120, channels: 4, background: '#345678' } })
      .png()
      .toBuffer());
    return { path: file };
  });
  assert.equal(calls, 1);
  assert(ps.photoshopState(j).materials.bg.upscaledPath);
});
test('PS packet freezes settings, supplies clean crops and denies completion without real plan/review', async () => {
  const j = await fixture(),
    packet = await api(`/api/jobs/${j.id}/packet?taskId=${j.taskId}`);
  assert.equal(packet.photoshop.settings.generationPixelBudget, 1500000);
  assert.equal(packet.frameContract.layers[0].generation.pixelBudget, 1500000);
  assert.equal(packet.localReferences.length, 2);
  assert(!packet.layers.some((l: any) => l.path));
  assert.match(packet.referencePolicy, /允许/);
  await api(
    `/api/jobs/${j.id}/apply`,
    { taskId: j.taskId, baseVersion: j.version, artifactPath: 'not-real.psd' },
    'POST',
    500,
  );
  assert.equal(store.load(j.documentId).images.length, 1);
});
test('PS plan validates coverage, bounds, cycles, extraction and preserves state on identical replay', async () => {
  const j = await fixture(),
    p = plan(j);
  assert.throws(
    () => ps.validatePhotoshopPlan({ ...j, layerIds: ['text'] }, p),
    /不在本次修改范围/,
  );
  assert.throws(() => ps.validatePhotoshopPlan(j, { layers: p.layers.slice(0, 1) }), /覆盖/);
  const bad = structuredClone(p);
  bad.layers[1].frame.width++;
  assert.throws(() => ps.validatePhotoshopPlan(j, bad), /画幅/);
  const cycle = structuredClone(p);
  cycle.layers[0].dependencies = ['text'];
  cycle.layers[1].dependencies = ['bg'];
  assert.throws(() => ps.validatePhotoshopPlan(j, cycle), /成环/);
  const extract = structuredClone(p);
  extract.layers[0].route = 'extract';
  assert.throws(
    () =>
      ps.validatePhotoshopPlan(
        { ...j, photoshop: { ...photoshopSettingsSchema.parse({}), allowExtraction: false } },
        extract,
      ),
    /不允许/,
  );
  await ps.photoshopAction(j, { action: 'plan', plan: p }, {} as any);
  const state = ps.photoshopState(j);
  state.compositeReview = 'cached';
  store.atomic(path.join(ps.photoshopFolder(j), 'photoshop-rebuild.json'), state);
  await ps.photoshopAction(j, { action: 'plan', plan: p }, {} as any);
  assert.equal(ps.photoshopState(j).compositeReview, 'cached');
});
test('native PSD structure rejects whole-image base, placeholders, hidden content and false editability', async () => {
  const j = await fixture(),
    p = ps.validatePhotoshopPlan(j, plan(j));
  assert.doesNotThrow(() => native.validateNativeStructure(psd(p), p, j.snapshot));
  assert.throws(() => native.validateNativeStructure(psd(p, true), p, j.snapshot), /占位/);
  const bytes = writePsdBuffer({ width: 80, height: 60, children: [{ name: 'Whole original' }] });
  assert.throws(() => native.validateNativeStructure(bytes, p, j.snapshot), /未映射/);
  const wrong = structuredClone(p);
  wrong.layers[0].editable = 'native-text';
  assert.throws(() => native.validateNativeStructure(psd(p), wrong, j.snapshot), /原生文字/);
  const raw = psd(p);
  const { readPsd } = await import('ag-psd');
  const parsed = readPsd(raw, { useImageData: true });
  parsed.children![0].children![0].hidden = true;
  assert.throws(
    () => native.validateNativeStructure(writePsdBuffer(parsed), p, j.snapshot),
    /占位/,
  );
});
test('material upscale checks actual dimensions, restores alpha and retains fallback without modifying canvas', async () => {
  const j = await fixture();
  const p = plan(j);
  p.layers[0].content = 'light';
  p.layers[0].surface = 'transparent';
  await ps.photoshopAction(j, { action: 'plan', plan: p }, {} as any);
  const file = path.join(ps.photoshopFolder(j), 'generated.png');
  await sharp({
    create: { width: 40, height: 30, channels: 4, background: { r: 10, g: 30, b: 80, alpha: 0.4 } },
  })
    .png()
    .toFile(file);
  await ps.beginPhotoshopMaterial(j, {
    action: 'material',
    layerId: 'bg',
    path: file,
    provenance: 'generated',
    observation: '测试素材几何正确',
    allowAspectFit: false,
    evidence: {
      generation: {
        tool: 'image_gen',
        outputPath: file,
        referencePaths: [store.assetPath(j.documentId, j.snapshot.source)],
        prompt: '隔离测试夹具，不代表实际生图',
      },
    },
  });
  let calls = 0;
  await ps.processPhotoshopMaterial(j, 'bg', new AbortController().signal, async (args) => {
    calls++;
    const folder = args[args.indexOf('--output') + 1],
      out = path.join(folder, 'upscaled.png');
    fs.writeFileSync(out, await sharp({ create: { width: 80, height: 60, channels: 4, background: '#ff0000' } })
      .png()
      .toBuffer());
    return { path: out };
  });
  const material = ps.photoshopState(j).materials.bg;
  assert.equal(calls, 1);
  assert.equal(material.status, 'ready');
  assert(material.upscaledPath);
  assert.equal(material.placement?.scale, 1);
  const stats = await sharp(fs.readFileSync(material.path)).ensureAlpha().stats();
  assert.equal(stats.channels[3].max, 102);
  assert.equal(store.load(j.documentId).images.length, 1);
  await ps.beginPhotoshopMaterial(j, {
    action: 'material',
    layerId: 'bg',
    path: file,
    provenance: 'generated',
    observation: '第二次测试',
    allowAspectFit: false,
    evidence: {
      generation: {
        tool: 'image_gen',
        outputPath: file,
        referencePaths: [store.assetPath(j.documentId, j.snapshot.source)],
        prompt: '隔离测试夹具，不代表实际生图',
      },
    },
  });
  await ps.processPhotoshopMaterial(j, 'bg', new AbortController().signal, async () => {
    throw new Error('GPU unavailable');
  });
  const fallback = ps.photoshopState(j).materials.bg;
  assert.equal(fallback.path, fallback.workingPath);
  assert.match(fallback.warning!, /GPU unavailable/);
});
test('reviewed native completion retains PSD bytes, annotations and creates red follow-up flags; tampering rejected', async () => {
  const j = await fixture();
  await ps.photoshopAction(j, { action: 'plan', plan: plan(j) }, {} as any);
  const p = ps.photoshopState(j).plan!,
    folder = ps.photoshopFolder(j),
    file = path.join(folder, 'result.psd'),
    preview = path.join(folder, 'preview.png');
  fs.writeFileSync(file, psd(p));
  await sharp({ create: { width: 80, height: 60, channels: 4, background: '#eeaa77' } })
    .png()
    .toFile(preview);
  const state = ps.photoshopState(j);
  state.inspection = {
    psdPath: file,
    previewPath: preview,
    thumbnails: { bg: preview, text: preview },
    hash: native.fileHash(file),
  };
  state.reviews = {
    bg: { status: 'accepted', attempts: [{ method: '检查', observation: '符合' }], issues: [] },
    text: {
      status: 'needs-revision',
      attempts: [
        { method: '字体匹配', observation: '字形仍有差异' },
        { method: '变形', observation: '选取较好版本' },
      ],
      issues: [{ message: '标题字形仍有差异' }],
    },
  };
  state.compositeReview = '测试记录（并非真实PS视觉验收）';
  state.checks = Object.fromEntries(
    p.layers.map((l) => [
      l.layerId,
      { isolation: '测试', occlusion: '测试', appearance: '测试', text: '测试' },
    ]),
  );
  state.quality = { isolation: {}, texts: {}, hashes: { [preview]: native.fileHash(preview) } };
  store.atomic(path.join(folder, 'photoshop-rebuild.json'), state);
  const { image, review } = await ps.completePhotoshop(j, file);
  assert.equal(review.pending, 1);
  assert.equal(image.layers[0].disposition, 'keep');
  assert.equal(image.layers[1].disposition, 'rebuild');
  assert.equal(image.annotations[0].color, '#ff3b30');
  assert.deepEqual(await renderImage(j.documentId, image), fs.readFileSync(preview));
  assert.deepEqual(await exportPsd(j.documentId, image), fs.readFileSync(file));
  fs.appendFileSync(file, 'changed');
  await assert.rejects(() => ps.completePhotoshop(j, file), /未经修改/);
});

test('native undo retains authoritative file pointers while keeping user visibility intent', () => {
  const old: any = {
    images: [
      {
        id: 'a',
        nativePsd: { version: 1, compositeUrl: 'old', mappings: [] },
        source: 'source',
        url: 'old',
        psdSource: 'old.psd',
        artifactUrl: 'old.psd',
        layers: [{ id: 'l', visible: true }],
      },
    ],
  };
  const latest: any = structuredClone(old);
  Object.assign(latest.images[0], { url: 'new', psdSource: 'new.psd', artifactUrl: 'new.psd' });
  latest.images[0].nativePsd.compositeUrl = 'new';
  latest.images[0].layers[0].visible = false;
  const undo = retainNativeAssets(old, latest);
  assert.equal(undo.images[0].layers[0].visible, true);
  assert.equal(undo.images[0].psdSource, 'new.psd');
  assert.equal(undo.images[0].nativePsd?.compositeUrl, 'new');
});

test('v2 rejects opaque foreground crops, missing generation receipts and copied clean references', async () => {
  const j = await fixture();
  const p = plan(j);
  p.layers[1].content = 'bitmap';
  p.layers[1].route = 'generate';
  p.layers[1].editable = 'pixels';
  p.layers[1].textTargets = [];
  await ps.photoshopAction(j, { action: 'plan', plan: p }, {} as any);
  const file = path.join(ps.photoshopFolder(j), 'crop.png');
  const source = store.assetPath(j.documentId, j.snapshot.source);
  await sharp(fs.readFileSync(source))
    .extract({ left: 5, top: 10, width: 60, height: 20 })
    .png()
    .toFile(file);
  const input: any = {
    action: 'material',
    layerId: 'text',
    path: file,
    provenance: 'generated',
    observation: '应被拒绝的矩形裁片',
    allowAspectFit: false,
    evidence: {},
  };
  await assert.rejects(() => ps.beginPhotoshopMaterial(j, input), /须记录/);
  input.evidence = {
    generation: {
      tool: 'image_gen',
      outputPath: file,
      referencePaths: [source],
      prompt: '测试声明不能使裁片变为合格素材',
    },
  };
  await assert.rejects(() => ps.beginPhotoshopMaterial(j, input), /没有透明区域/);
  const bgFile = path.join(ps.photoshopFolder(j), 'copied-bg.png');
  fs.copyFileSync(source, bgFile);
  input.layerId = 'bg';
  input.path = bgFile;
  input.evidence.generation.outputPath = bgFile;
  await assert.rejects(() => ps.beginPhotoshopMaterial(j, input), /参考裁片/);
  assert.equal(Object.keys(ps.photoshopState(j).materials).length, 0);
  assert.equal(store.load(j.documentId).images.length, 1);
});

test('accurate extraction remains available with real alpha; preview and other-task generation references forbidden', async () => {
  const j = await fixture(),
    p = plan(j);
  p.layers[1].content = 'bitmap';
  p.layers[1].route = 'extract';
  p.layers[1].editable = 'pixels';
  p.layers[1].textTargets = [];
  await ps.photoshopAction(j, { action: 'plan', plan: p }, {} as any);
  const file = path.join(ps.photoshopFolder(j), 'object.png');
  await sharp({
    create: { width: 60, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 30, height: 10, channels: 4, background: '#eeeeee' },
        })
          .png()
          .toBuffer(),
        left: 15,
        top: 5,
      },
    ])
    .png()
    .toFile(file);
  const input: any = {
    action: 'material',
    layerId: 'text',
    path: file,
    provenance: 'extracted',
    observation: '具有真实透明边缘的隔离夹具',
    allowAspectFit: false,
    evidence: { extraction: { method: '物体选区与软alpha', occlusion: '该夹具无隐藏区域' } },
  };
  await ps.beginPhotoshopMaterial(j, input);
  await ps.processPhotoshopMaterial(j, 'text', new AbortController().signal, async () => {
    throw Error('不应超分');
  });
  assert.equal(ps.photoshopState(j).materials.text.status, 'ready');
  assert(ps.photoshopState(j).materials.text.isolation!.transparent > 0);
  assert.equal(ps.photoshopState(j).materials.text.receipt!.toolHistoryVerified, false);
  p.layers[1].route = 'generate';
  await ps.photoshopAction(j, { action: 'plan', plan: p }, {} as any);
  input.provenance = 'generated';
  input.evidence = {
    generation: {
      tool: 'image_gen',
      outputPath: file,
      referencePaths: [file],
      prompt: '错误：使用了非允许参考',
    },
  };
  await assert.rejects(() => ps.beginPhotoshopMaterial(j, input), /不在本任务允许/);
});

test('rendered isolation inspects inside the layer frame, not transparent full-canvas margins', async () => {
  const q = await import('../server/photoshop-quality.js');
  const j = await fixture();
  fs.mkdirSync(ps.photoshopFolder(j), { recursive: true });
  const p = ps.validatePhotoshopPlan(j, plan(j));
  const foreground = p.layers[1];
  const source = store.assetPath(j.documentId, j.snapshot.source);
  const cropped = await sharp(fs.readFileSync(source))
    .extract({ left: 5, top: 10, width: 60, height: 20 })
    .png()
    .toBuffer();
  const thumb = path.join(ps.photoshopFolder(j), 'rectangle-on-transparent.png');
  await sharp({
    create: { width: 80, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: cropped, left: 5, top: 10 }])
    .png()
    .toFile(thumb);
  await assert.rejects(
    () =>
      q.inspectRenderedIsolation(
        j,
        { canvas: p.canvas, layers: [foreground], relations: [] },
        { text: thumb },
        ps.photoshopFolder(j),
      ),
    /没有透明区域/,
  );
  const bgMetrics = await q.alphaMetrics(
    await sharp({
      create: { width: 80, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer(),
  );
  assert.throws(() => q.requireIsolatedSurface(p.layers[0], bgMetrics), /透明空洞/);
});

test('mixed editability cannot be supplied by hidden generic text; visible text target names and contents required', async () => {
  const j = await fixture(),
    p = ps.validatePhotoshopPlan(j, plan(j));
  const { readPsd } = await import('ag-psd');
  const parsed = readPsd(psd(p), { useImageData: true });
  const group = parsed.children![1];
  const text = group.children![0];
  text.hidden = true;
  group.children!.push({
    name: '像素裁片',
    imageData: { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4).fill(255) },
  });
  p.layers[1].editable = 'mixed';
  assert.throws(
    () => native.validateNativeStructure(writePsdBuffer(parsed), p, j.snapshot),
    /隐藏参考/,
  );
  text.hidden = false;
  text.name = '其他文字';
  assert.throws(
    () => native.validateNativeStructure(writePsdBuffer(parsed), p, j.snapshot),
    /匹配文字/,
  );
});

test('pixel text fallback requires actual task-local attempt evidence and native text fit is measured', async () => {
  const j = await fixture(),
    p = plan(j);
  p.layers[1].route = 'generate';
  p.layers[1].editable = 'pixels';
  p.layers[1].textTargets = [];
  fs.mkdirSync(ps.photoshopFolder(j), { recursive: true });
  assert.throws(() => ps.validatePhotoshopPlan(j, p), /原生尝试/);
  const evidence = path.join(ps.photoshopFolder(j), 'native-attempt.png');
  await sharp({ create: { width: 60, height: 20, channels: 4, background: '#ffffff' } })
    .png()
    .toFile(evidence);
  const fallback: any = p;
  fallback.layers[1].nativeFallback = {
    reason: '本机字体无法匹配该艺术字',
    attempts: [
      { method: '字体与变形拟合', observation: '已查看实际渲染，字形不同', evidencePath: evidence },
    ],
  };
  assert.doesNotThrow(() => ps.validatePhotoshopPlan(j, fallback));
  const original = ps.validatePhotoshopPlan(j, plan(j));
  const { readPsd } = await import('ag-psd');
  assert(
    native.nativeTextReport(
      readPsd(psd(original), {
        skipLayerImageData: true,
        skipCompositeImageData: true,
        skipThumbnail: true,
      }),
      original,
    ).text[0].severeGeometry,
  );
});

test('preserve route cannot claim newly rebuilt text and fit-text cannot bypass the route', async () => {
  const j = await fixture();
  j.snapshot.status = 'layered';
  j.snapshot.layers.forEach((l) => {
    l.preview = undefined;
    l.kind = 'raster';
  });
  j.reconstructionWorkflowVersion = 4;
  const p: any = plan(j);
  p.layers.forEach((l: any) => {
    l.route = 'preserve';
    l.editable = 'pixels';
    l.textTargets = [];
  });
  assert.doesNotThrow(() => ps.validatePhotoshopPlan(j, p));
  p.layers[1].editable = 'native-text';
  assert.throws(() => ps.validatePhotoshopPlan(j, p), /preserve只保留/);
  p.layers[1].editable = 'pixels';
  await ps.photoshopAction(j, { action: 'plan', plan: p }, {} as any);
  await assert.rejects(
    ps.photoshopAction(
      j,
      {
        action: 'fit-text',
        artifactPath: 'unused.psd',
        layerId: 'text',
        layerName: '标题',
        targetBox: p.layers[1].frame,
      },
      {} as any,
    ),
    /preserve层不能/,
  );
});

test('pixel fallback accepts source-based impossibility assessment without making knowingly wrong text first', async () => {
  const j = await fixture(),
    p: any = plan(j);
  p.layers[1].route = 'generate';
  p.layers[1].editable = 'pixels';
  p.layers[1].textTargets = [];
  p.layers[1].nativeFallback = { reason: '手绘笔触与局部材质无法用本机字体准确匹配', attempts: [] };
  assert.throws(() => ps.validatePhotoshopPlan(j, p), /assessment/);
  p.layers[1].nativeFallback.assessment = {
    referencePath: store.assetPath(j.documentId, j.snapshot.source),
    limitation: '该字形的独立手绘笔触和材质变形无法从现有字体及标准文字效果重建。',
  };
  assert.doesNotThrow(() => ps.validatePhotoshopPlan(j, p));
});

test('preserve compares actual isolated PS pixels with frozen placement and tolerates harmless alpha RGB', async () => {
  const { verifyPreservedLayers } = await import('../server/photoshop-quality.js');
  const j = await fixture();
  j.snapshot.status = 'layered';
  const bytes = await sharp({
    create: { width: 20, height: 12, channels: 4, background: '#e03928' },
  })
    .png()
    .toBuffer();
  const url = store.writeAsset(j.documentId, bytes, '.png');
  const layer = {
    ...j.snapshot.layers[0],
    kind: 'raster' as const,
    preview: undefined,
    url,
    x: 10,
    y: 15,
    width: 20,
    height: 12,
    opacity: 1,
  };
  j.snapshot.layers = [layer];
  const p: any = {
    canvas: { width: 80, height: 60 },
    layers: [{ layerId: layer.id, name: layer.name, route: 'preserve' }],
  };
  const folder = ps.photoshopFolder(j);
  fs.mkdirSync(folder, { recursive: true });
  const rendered = path.join(folder, 'preserved.png');
  const background = {
    create: {
      width: 80,
      height: 60,
      channels: 4 as const,
      background: { r: 240, g: 200, b: 180, alpha: 0 },
    },
  };
  await sharp(background)
    .composite([{ input: bytes, left: 10, top: 15 }])
    .png()
    .toFile(rendered);
  await assert.doesNotReject(verifyPreservedLayers(j, p, { [layer.id]: rendered }));
  await sharp(background)
    .composite([{ input: bytes, left: 20, top: 15 }])
    .png()
    .toFile(rendered);
  await assert.rejects(verifyPreservedLayers(j, p, { [layer.id]: rendered }), /声明preserve但/);
  // Native thumbnails already include opacity; comparing them must not multiply opacity twice.
  const baked = await sharp({
    create: {
      width: 20,
      height: 12,
      channels: 4,
      background: { r: 224, g: 57, b: 40, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  j.snapshot.layers[0].url = store.writeAsset(j.documentId, baked, '.png');
  j.snapshot.layers[0].opacity = 0.5;
  j.snapshot.nativePsd = { version: 1, compositeUrl: j.snapshot.url, mappings: [] };
  await sharp(background)
    .composite([{ input: baked, left: 10, top: 15 }])
    .png()
    .toFile(rendered);
  await assert.doesNotReject(verifyPreservedLayers(j, p, { [layer.id]: rendered }));
  // Target-canvas enlargement keeps the frozen source-space placement, not the design crop origin.
  p.canvas = { width: 160, height: 120 };
  const enlarged = await sharp(fs.readFileSync(rendered)).resize(160, 120).png().toBuffer();
  fs.writeFileSync(rendered, enlarged);
  await assert.doesNotReject(verifyPreservedLayers(j, p, { [layer.id]: rendered }));
});

test('review cannot accept severe native placement errors or reuse changed rendered evidence', async () => {
  const j = await fixture();
  await ps.photoshopAction(j, { action: 'plan', plan: plan(j) }, {} as any);
  const state = ps.photoshopState(j);
  const file = path.join(ps.photoshopFolder(j), 'result.psd'),
    png = path.join(ps.photoshopFolder(j), 'real-preview.png');
  fs.writeFileSync(file, psd(state.plan));
  await sharp({ create: { width: 80, height: 60, channels: 4, background: '#eeeeee' } })
    .png()
    .toFile(png);
  state.inspection = {
    psdPath: file,
    previewPath: png,
    thumbnails: { bg: png, text: png },
    hash: native.fileHash(file),
  };
  state.quality = {
    isolation: {},
    texts: {
      text: [
        {
          layerName: '标题',
          bounds: [512, 20, 700, 60],
          target: [5, 10, 65, 30],
          severeGeometry: true,
          rotation: 0,
          shear: 0,
          effects: [],
          appearanceMismatch: [],
        },
      ],
    },
    hashes: { [png]: native.fileHash(png) },
  };
  store.atomic(path.join(ps.photoshopFolder(j), 'photoshop-rebuild.json'), state);
  const input: any = {
    action: 'review',
    layerId: 'text',
    review: {
      status: 'accepted',
      attempts: [{ method: '对照', observation: '错误地声称成功' }],
      issues: [],
    },
    checks: {
      isolation: '查看独立层',
      occlusion: '查看背景',
      appearance: '查看合成',
      text: '实际文字错位',
    },
  };
  await assert.rejects(() => ps.photoshopAction(j, input, {} as any), /明显几何错位/);
  input.review = {
    status: 'needs-revision',
    attempts: [
      { method: '字号匹配', observation: '仍错位' },
      { method: '变形拟合', observation: '选较好版本继续' },
    ],
    issues: [{ message: '需继续匹配标题' }],
  };
  await ps.photoshopAction(j, input, {} as any);
  assert.equal(ps.photoshopState(j).reviews.text.status, 'needs-revision');
  fs.appendFileSync(png, 'changed');
  await assert.rejects(() => ps.photoshopAction(j, input, {} as any), /文件已变化/);
});

test('hybrid must have generation evidence and bitmap cannot select native as a crop escape hatch', async () => {
  const j = await fixture(),
    p = plan(j);
  p.layers[1].content = 'bitmap';
  p.layers[1].editable = 'native-shape';
  p.layers[1].textTargets = [];
  assert.throws(() => ps.validatePhotoshopPlan(j, p), /位图物体默认生成/);
  p.layers[1].route = 'hybrid';
  p.layers[1].editable = 'pixels';
  await ps.photoshopAction(j, { action: 'plan', plan: p }, {} as any);
  const file = store.assetPath(j.documentId, j.snapshot.source);
  await assert.rejects(
    () =>
      ps.beginPhotoshopMaterial(j, {
        action: 'material',
        layerId: 'text',
        path: file,
        provenance: 'preserved',
        observation: '不得绕过生成',
        evidence: {},
        allowAspectFit: false,
      }),
    /来源与计划路线不一致/,
  );
});

for (const baseKind of ['generated', 'extracted', 'alphaChecks'] as const)
  test(`HTTP ${baseKind} material repair derives full RGBA, uses existing placement/inspect, and invalidates changed lineage`, async (t) => {
    const j = await fixture();
    j.reconstructionVersion = 3;
    j.reconstructionWorkflowVersion = 4;
    j.photoshop = { ...j.photoshop, autoUpscale: false } as any;
    store.saveJob(j);
    const p: any = plan(j);
    p.layers[0].elements = ['背景纹理'];
    Object.assign(p.layers[1], {
      route: baseKind === 'extracted' ? 'hybrid' : 'generate',
      content: 'bitmap',
      surface: 'transparent',
      editable: 'pixels',
      textTargets: [],
      elements: ['发丝'],
      anchors: [
        { name: 'left', point: [15, 20], observation: 'fixture冻结左定位点' },
        { name: 'right', point: [45, 20], observation: 'fixture冻结右定位点' },
      ],
    });
    if (baseKind === 'alphaChecks') p.layers[1].alphaChecks = [
      { name: '可见环境孔隙', kind: 'clear', box: [30, 18, 6, 4], maxAlpha: 8, minPassingFraction: 1 },
      { name: '非空薄纱', kind: 'transmissive', box: [26, 18, 3, 4], minAlpha: 8,
        maxAlpha: 220, minBackgroundResponse: 35, minPassingFraction: 1 },
    ];
    await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan', plan: p });
    const folder = ps.photoshopFolder(j);
    let testedPSAlphaPrepare = false;
    async function ready(id: string) {
      for (let k = 0; k < 100; k++) {
        const m = ps.photoshopState(j).materials[id];
        if (m.status === 'ready') return m;
        assert.equal(m.status, 'processing', m.error);
        await new Promise((r) => setTimeout(r, 5));
      }
      throw Error('Material did not become ready');
    }
    async function generation(id: string, file: string) {
      const request = await api(`/api/jobs/${j.id}/generation`, {
        taskId: j.taskId,
        action: 'prepare',
        sourceLayerIds: [id],
        purpose: '测试登记透明真实文件',
        elements: p.layers.find((l: any) => l.layerId === id).elements,
        referenceObservation: '测试fixture，不调用收费服务',
      });
      if (baseKind === 'alphaChecks' && id === 'text') {
        assert.deepEqual(request.alphaChecks, p.layers[1].alphaChecks);
        assert.deepEqual(request.alphaCheckRegions.map((c: any) => c.box), [[30, 18, 6, 4], [26, 18, 3, 4]]);
        const line = request.prompt.split('\n').find((row: string) => row.startsWith('以下box已由当前图片'));
        const shown = JSON.parse(line.match(/：(\[.*\])$/)![1]);
        assert.deepEqual(shown.map((c: any) => c.box), request.alphaCheckRegions.map((c: any) => c.generationBox));
        assert(shown.every((c: any) => !('canvasBox' in c) && !('generationBox' in c)));
        assert.notDeepEqual(shown[0].box, request.alphaChecks[0].box);
        if (!testedPSAlphaPrepare) {
          const frozen = ps.photoshopState(j), changed = structuredClone(frozen);
          const check = changed.plan!.layers[1].alphaChecks![0];
          assert.notEqual(check.kind, 'occupied');
          if (check.kind !== 'occupied') check.maxAlpha = 9;
          store.atomic(path.join(folder, 'photoshop-rebuild.json'), changed);
          const rejected = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId,
            action: 'register', requestId: request.id, path: file, prompt: request.prompt,
            referencePaths: request.referencePaths }, 'POST', 500);
          assert.match(rejected.error, /区域alpha约束与冻结准备记录不一致/);
          store.atomic(path.join(folder, 'photoshop-rebuild.json'), frozen);
          testedPSAlphaPrepare = true;
        }
      }
      const output = await api(`/api/jobs/${j.id}/generation`, {
        taskId: j.taskId,
        action: 'register',
        requestId: request.id,
        path: file,
        prompt: request.prompt,
        referencePaths: request.referencePaths,
      });
      return {
        output,
        input: {
          taskId: j.taskId,
          action: 'material',
          layerId: id,
          path: output.originalPath,
          provenance: 'generated',
          generationId: output.id,
          observation: '测试fixture的可见软alpha',
          evidence: {
            generation: {
              tool: 'image_gen',
              outputPath: output.originalPath,
              prompt: request.prompt,
              referencePaths: request.referencePaths,
            },
          },
        },
      };
    }
    const bgFile = path.join(folder, 'fixture-background.png');
    await sharp({ create: { width: 80, height: 60, channels: 4, background: '#102030' } })
      .png()
      .toFile(bgFile);
    const bg = await generation('bg', bgFile);
    await api(`/api/jobs/${j.id}/ps-rebuild`, bg.input);
    await ready('bg');
    const oldPixels = Buffer.alloc(60 * 20 * 4),
      patchPixels = Buffer.alloc(60 * 20 * 4);
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 60; x++) {
        const k = (y * 60 + x) * 4;
        oldPixels[k] = 80;
        oldPixels[k + 1] = 50;
        oldPixels[k + 2] = 30;
        patchPixels[k] = 30;
        patchPixels[k + 1] = 20;
        patchPixels[k + 2] = 10;
        if (x > 9 && x < 49 && y > 3 && y < 16) {
          oldPixels[k + 3] = baseKind === 'alphaChecks' ? 252 : 200;
          patchPixels[k + 3] = x >= 25 && x <= 30 && y >= 8 && y <= 12 ? 0 : 100;
        }
      }
    const oldFile = path.join(folder, 'fixture-hair-base.png'),
      patchFile = path.join(folder, 'fixture-hair-patch.png');
    await sharp(oldPixels, { raw: { width: 60, height: 20, channels: 4 } })
      .png()
      .toFile(oldFile);
    await sharp(patchPixels, { raw: { width: 60, height: 20, channels: 4 } })
      .png()
      .toFile(patchFile);
    const old: any =
      baseKind !== 'extracted'
        ? await generation('text', oldFile)
        : {
            output: {},
            input: {
              taskId: j.taskId,
              action: 'material',
              layerId: 'text',
              path: oldFile,
              provenance: 'extracted',
              placementFrame: p.layers[1].frame,
              observation: 'fixture真实透明提取，不调用Adobe或收费生成',
              evidence: {
                extraction: {
                  method: '真实物体软alpha选区，保留完整carrier',
                  occlusion: '隐藏发丝由随后登记的生成补片替换',
                  sourcePath: store.assetPath(j.documentId, j.snapshot.source),
                },
              },
            },
          };
    if (baseKind === 'extracted') {
      const before = ps.photoshopState(j);
      for (const denied of [
        { ...old.input, generationId: bg.output.id },
        {
          ...old.input,
          evidence: { extraction: { ...old.input.evidence.extraction, sourcePath: oldFile } },
        },
        { ...old.input, placementFrame: { ...p.layers[1].frame, width: 0 } },
      ])
        await api(`/api/jobs/${j.id}/ps-rebuild`, denied, 'POST', 400);
      assert.deepEqual(ps.photoshopState(j), before);
      j.reconstructionVersion = undefined;
      store.saveJob(j);
      await api(`/api/jobs/${j.id}/ps-rebuild`, old.input, 'POST', 400);
      j.reconstructionVersion = 3;
      store.saveJob(j);
      j.reconstructionWorkflowVersion = undefined;
      store.saveJob(j);
      await api(`/api/jobs/${j.id}/ps-rebuild`, old.input, 'POST', 400);
      j.reconstructionWorkflowVersion = 4;
      store.saveJob(j);
      j.photoshop!.allowExtraction = false;
      store.saveJob(j);
      await api(`/api/jobs/${j.id}/ps-rebuild`, old.input, 'POST', 400);
      j.photoshop!.allowExtraction = true;
      store.saveJob(j);
      const generatePlan = structuredClone(p);
      generatePlan.layers[1].route = 'generate';
      await api(`/api/jobs/${j.id}/ps-rebuild`, {
        taskId: j.taskId,
        action: 'plan',
        plan: generatePlan,
      });
      await api(`/api/jobs/${j.id}/ps-rebuild`, old.input, 'POST', 400);
      for (const surface of ['opaque', 'screen']) {
        const otherPlan = structuredClone(p);
        otherPlan.layers[1].surface = surface;
        otherPlan.layers[1].content = surface === 'opaque' ? 'background' : 'light';
        await api(`/api/jobs/${j.id}/ps-rebuild`, {
          taskId: j.taskId,
          action: 'plan',
          plan: otherPlan,
        });
        await api(`/api/jobs/${j.id}/ps-rebuild`, old.input, 'POST', 400);
      }
      await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan', plan: p });
      const other = await fixture();
      fs.mkdirSync(ps.photoshopFolder(other), { recursive: true });
      const outside = path.join(ps.photoshopFolder(other), 'other-extracted.png');
      fs.copyFileSync(oldFile, outside);
      await api(`/api/jobs/${j.id}/ps-rebuild`, { ...old.input, path: outside }, 'POST', 400);
      await api(
        `/api/jobs/${j.id}/ps-rebuild`,
        { ...old.input, path: store.assetPath(j.documentId, j.snapshot.source) },
        'POST',
        400,
      );
      const previewBytes = await sharp(fs.readFileSync(oldFile)).png().toBuffer();
      const oldLayerUrl = j.snapshot.layers[1].url;
      j.snapshot.layers[1].url = store.writeAsset(j.documentId, previewBytes, '.png');
      store.saveJob(j);
      await api(`/api/jobs/${j.id}/ps-rebuild`, old.input, 'POST', 400);
      j.snapshot.layers[1].url = oldLayerUrl;
      store.saveJob(j);
      const largePath = path.join(folder, 'extracted-full-carrier-1600x1000.png');
      await sharp(fs.readFileSync(oldFile))
        .resize(1600, 1000, { fit: 'fill' })
        .png()
        .toFile(largePath);
      await api(`/api/jobs/${j.id}/ps-rebuild`, {
        ...old.input,
        path: largePath,
        placementFrame: { x: 0, y: 0, width: 80, height: 50 },
      });
      const large = await ready('text');
      assert.deepEqual(large.originalSize, { width: 1600, height: 1000 });
      assert(large.workingSize!.width * large.workingSize!.height <= 1_500_000);
      assert(Math.abs(large.workingSize!.width / large.workingSize!.height - 1.6) < 0.002);
      const fullAlpha = await sharp(fs.readFileSync(large.workingPath!))
        .ensureAlpha()
        .extractChannel('alpha')
        .raw()
        .toBuffer();
      assert.equal(fullAlpha[0], 0);
      assert.equal(fullAlpha.at(-1), 0);
      const stored = ps.photoshopState(j),
        badBudget = structuredClone(stored);
      badBudget.materials.text.workingSize = { width: 1600, height: 1000 };
      Object.assign(badBudget.materials.text.extraction!.working, { width: 1600, height: 1000 });
      store.atomic(path.join(folder, 'photoshop-rebuild.json'), badBudget);
      await api(
        `/api/jobs/${j.id}/ps-rebuild`,
        { taskId: j.taskId, action: 'place-material', layerId: 'text', artifactPath: 'unused' },
        'POST',
        400,
      );
      store.atomic(path.join(folder, 'photoshop-rebuild.json'), stored);
    }
    await api(`/api/jobs/${j.id}/ps-rebuild`, old.input);
    const oldMaterial = await ready('text'),
      baseHash = native.fileHash(oldMaterial.workingPath!);
    const baselineState = ps.photoshopState(j);
    if (baseKind === 'extracted') {
      assert.equal(oldMaterial.generationId, undefined);
      assert.equal(oldMaterial.extraction!.kind, 'extracted');
      assert.equal(oldMaterial.receipt!.toolHistoryVerified, false);
    }
    const targetFrame = (entry: any, m: any, size: any) =>
      photoshopMaterialTarget(
        size,
        m.placementFrame || entry.frame,
        isPhotoshopFullBackground(entry, ps.photoshopState(j).plan!.canvas!),
      );
    async function fixturePsd(output: string, materialProperties: Record<string, unknown> = {}) {
      const s = ps.photoshopState(j),
        links: any[] = [],
        children: any[] = [];
      for (const entry of s.plan!.layers) {
        const m = s.materials[entry.layerId],
          bytes = fs.readFileSync(m.workingPath!),
          decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const t = targetFrame(entry, m, decoded.info),
          id = crypto.randomUUID();
        links.push({ id, name: entry.layerId + '.png', data: bytes });
        children.push({
          name: 'LC_' + entry.layerId,
          children: [
            {
              name: 'LC_MATERIAL',
              ...(entry.layerId === 'text' ? materialProperties : {}),
              left: Math.round(t.x),
              top: Math.round(t.y),
              imageData: {
                width: decoded.info.width,
                height: decoded.info.height,
                data: new Uint8ClampedArray(decoded.data),
              },
              placedLayer: {
                id,
                type: 'raster',
                width: decoded.info.width,
                height: decoded.info.height,
                transform: [
                  t.x,
                  t.y,
                  t.x + t.width,
                  t.y,
                  t.x + t.width,
                  t.y + t.height,
                  t.x,
                  t.y + t.height,
                ],
              },
            },
            {
              name: 'user-owned-effect',
              hidden: true,
              left: 0,
              top: 0,
              imageData: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
            },
          ],
        });
      }
      fs.writeFileSync(
        output,
        writePsdBuffer({ width: 80, height: 60, children, linkedFiles: links } as any),
      );
    }
    const baseArtifact = path.join(folder, 'fixture-baseline.psd');
    await fixturePsd(baseArtifact);
    const mask = Buffer.alloc(60 * 20 * 4);
    for (let y = 6; y <= 14; y++)
      for (let x = 20; x <= 35; x++) mask.fill(255, (y * 60 + x) * 4, (y * 60 + x) * 4 + 4);
    const maskFile = path.join(folder, 'fixture-replacement-mask.png');
    await sharp(mask, { raw: { width: 60, height: 20, channels: 4 } })
      .png()
      .toFile(maskFile);
    const patch = await generation('text', patchFile),
      originalPatchHash = native.fileHash(patch.output.originalPath);
    const repairInput = {
      ...patch.input,
      repair: {
        maskPath: maskFile,
        expectedBaseWorkingHash: baseHash,
        baseArtifactPath: baseArtifact,
      },
    };
    if (baseKind === 'extracted')
      await api(
        `/api/jobs/${j.id}/ps-rebuild`,
        { ...repairInput, generationId: undefined },
        'POST',
        500,
      );
    await api(
      `/api/jobs/${j.id}/ps-rebuild`,
      {
        ...repairInput,
        repair: { ...repairInput.repair, expectedBaseWorkingHash: '0'.repeat(64) },
      },
      'POST',
      400,
    );
    assert.equal(ps.photoshopState(j).materials.text.workingPath, oldMaterial.workingPath);
    const wrongMask = path.join(folder, 'wrong-size-mask.png');
    await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ffffff' } })
      .png()
      .toFile(wrongMask);
    await api(
      `/api/jobs/${j.id}/ps-rebuild`,
      { ...repairInput, repair: { ...repairInput.repair, maskPath: wrongMask } },
      'POST',
      400,
    );
    const effectArtifact = path.join(folder, 'fixture-material-with-user-effect.psd');
    await fixturePsd(effectArtifact, {
      effects: {
        solidFill: [
          { enabled: true, color: { r: 255, g: 0, b: 0 }, opacity: 1, blendMode: 'normal' },
        ],
      },
    });
    const effectHash = native.fileHash(effectArtifact);
    await api(
      `/api/jobs/${j.id}/ps-rebuild`,
      {
        ...repairInput,
        repair: { ...repairInput.repair, baseArtifactPath: effectArtifact },
      },
      'POST',
      400,
    );
    assert.equal(native.fileHash(effectArtifact), effectHash);
    assert.equal(ps.photoshopState(j).materials.text.workingPath, oldMaterial.workingPath);
    await api(`/api/jobs/${j.id}/ps-rebuild`, repairInput);
    const repaired = await ready('text'),
      out = await sharp(fs.readFileSync(repaired.workingPath!)).ensureAlpha().raw().toBuffer();
    const source = await sharp(fs.readFileSync(oldMaterial.workingPath!))
      .ensureAlpha()
      .raw()
      .toBuffer();
    assert.deepEqual(repaired.workingSize, { width: 60, height: 20 });
    assert(repaired.repair!.stats.alphaDecreasedPixels > 0);
    if (baseKind === 'extracted') {
      assert.equal(repaired.repair!.base.sourceKind, 'extracted');
      assert.equal(repaired.repair!.base.generation, undefined);
      assert.deepEqual(repaired.repair!.base.extraction, oldMaterial.extraction);
      assert.equal(repaired.generationId, patch.output.id);
    }
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 60; x++) {
        const k = (y * 60 + x) * 4;
        if (x < 20 || x > 35 || y < 6 || y > 14)
          assert.deepEqual(out.subarray(k, k + 4), source.subarray(k, k + 4));
      }
    assert.equal(out[(10 * 60 + 27) * 4 + 3], 0);
    assert.equal(native.fileHash(patch.output.originalPath), originalPatchHash);
    assert.notEqual(repaired.workingPath, patch.output.workingPath);
    const originalExecute = adobe.executeScript;
    let placementCalls = 0,
      renderCalls = 0;
    let renderPause: { start: () => void; release: Promise<void>; paths?: string[] } | undefined;
    // This harness mocks only the external PS process; all production HTTP,
    // registration, derivation, source checks and placed-file checks run normally.
    adobe.executeScript = async (_app, script, _scope, outputs) => {
      if (fs.readFileSync(script, 'utf8').includes("executeAction(c('Plc '),a,DialogModes.NO)")) {
        placementCalls++;
        await fixturePsd(outputs[0]);
        const t = targetFrame(
          ps.photoshopState(j).plan!.layers[1],
          ps.photoshopState(j).materials.text,
          { width: 60, height: 20 },
        );
        fs.writeFileSync(
          outputs[1],
          JSON.stringify({
            transform: [
              t.x,
              t.y,
              t.x + t.width,
              t.y,
              t.x + t.width,
              t.y + t.height,
              t.x,
              t.y + t.height,
            ],
          }),
        );
      } else {
        renderCalls++;
        const s = ps.photoshopState(j),
          thumbs: Buffer[] = [];
        for (const entry of s.plan!.layers) {
          const bytes = fs.readFileSync(s.materials[entry.layerId].workingPath!);
          thumbs.push(
            await sharp({ create: { width: 80, height: 60, channels: 4, background: '#00000000' } })
              .composite([{ input: bytes, left: entry.frame.x, top: entry.frame.y }])
              .png()
              .toBuffer(),
          );
        }
        fs.writeFileSync(
          outputs[0],
          await sharp(thumbs[0])
            .composite([{ input: thumbs[1] }])
            .png()
            .toBuffer(),
        );
        fs.writeFileSync(outputs[1], JSON.stringify({ bg: [], text: [] }));
        const mappings = JSON.parse(fs.readFileSync(script, 'utf8').match(/var m=(.*?), t=/)![1]);
        const count = mappings.length;
        for (let n = 0; n < count; n++) {
          const thumb = thumbs[mappings[n].layerId === 'bg' ? 0 : 1];
          fs.writeFileSync(outputs[2 + n], thumb);
          fs.writeFileSync(
            outputs[2 + count + n * 2],
            await sharp(thumb).flatten({ background: '#eeeeee' }).png().toBuffer(),
          );
          fs.writeFileSync(
            outputs[3 + count + n * 2],
            await sharp(thumb).flatten({ background: '#202020' }).png().toBuffer(),
          );
        }
        if (renderPause) {
          renderPause.paths = [...outputs];
          renderPause.start();
          await renderPause.release;
        }
      }
      return {
        execution: { fixture: true },
        artifacts: outputs.map((output) => ({ path: output, bytes: fs.statSync(output).size })),
        verified: false,
        note: '测试只模拟外部Adobe执行；实际HTTP与派生校验正常运行',
      };
    };
    try {
      const reviewInput = (id: string, status: 'accepted' | 'needs-revision' = 'accepted') => {
        const s = ps.photoshopState(j), entry = s.plan!.layers.find(l => l.layerId === id)!;
        return { taskId: j.taskId, action: 'review', layerId: id,
          review: { status, attempts: [{ method: '实际fixture PNG区域回读', observation: '隔离测试，不声明真实Adobe视觉验收' }],
            issues: status === 'needs-revision' ? [{ message: '薄纱近不透明且孔隙填实', box: [26, 18, 10, 4] }] : [] },
          checks: { isolation: '实际透明组PNG', occlusion: '实际fixture分组', appearance: '仅合成协议夹具',
            comparisonHash: s.quality?.comparisons?.[id]?.hash,
            elements: entry.elements.map(name => ({ name, status: 'matched', observation: `夹具逐项：${name}` })),
            referenceComparison: { geometry: '隔离夹具的实际位置在冻结画幅内', appearance: '隔离夹具的颜色及薄纱alpha单独检查' } } };
      };
      await t.test('HTTP progress exports all ready groups and probes without declaring unconfigured alpha or accepting pending materials', async () => {
        const before = ps.photoshopState(j);
        const progress = await api(`/api/jobs/${j.id}/ps-rebuild`, {
          taskId: j.taskId, action: 'inspect-progress', artifactPath: baseArtifact,
        });
        assert.equal(progress.previewOnly, true);
        assert.deepEqual(Object.keys(progress.thumbnails), ['bg', 'text']);
        assert.deepEqual(Object.keys(progress.probes), ['bg', 'text']);
        assert.deepEqual(Object.keys(progress.alphaDiagnostics || {}),
          baseKind === 'alphaChecks' ? ['text'] : []);
        assert.deepEqual(ps.photoshopState(j), before);
        const pending = structuredClone(before);
        pending.materials.text.status = 'processing';
        store.atomic(path.join(folder, 'photoshop-rebuild.json'), pending);
        try {
          const partial = await api(`/api/jobs/${j.id}/ps-rebuild`, {
            taskId: j.taskId, action: 'inspect-progress', artifactPath: baseArtifact,
          });
          assert.deepEqual(Object.keys(partial.thumbnails), ['bg']);
          assert.deepEqual(Object.keys(partial.probes), ['bg']);
          assert.equal(partial.alphaDiagnostics, undefined);
          assert.deepEqual(ps.photoshopState(j), pending);
        } finally {
          store.atomic(path.join(folder, 'photoshop-rebuild.json'), before);
        }
      });
      if (baseKind === 'alphaChecks') {
        await t.test('HTTP PS alpha progress is diagnostic only; failed actual regions block accepted and complete but allow needs-revision', async () => {
          store.atomic(path.join(folder, 'photoshop-rebuild.json'), baselineState);
          const inspectBefore = () => api(`/api/jobs/${j.id}/ps-rebuild`, {
            taskId: j.taskId, action: 'inspect', artifactPath: baseArtifact,
          });
          const result = await inspectBefore(), d = result.quality.alphaDiagnostics.text;
          assert.equal(d.passed, false);
          assert.equal(d.sampling.checks[1].alpha.min, 252);
          assert.equal(d.sampling.checks[1].backgroundResponse.min, 3);
          assert.deepEqual(d.sampling.checks[1].canvasBox, [26, 18, 3, 4]);
          assert.equal(d.sampling.checks[1].passingPixels, 0);
          const rejected = await api(`/api/jobs/${j.id}/ps-rebuild`, reviewInput('text'), 'POST', 400);
          assert.match(rejected.error, /PS区域alpha检查未通过/);
          await api(`/api/jobs/${j.id}/ps-rebuild`, reviewInput('text', 'needs-revision'));
          const oldState = ps.photoshopState(j);
          const progress = await api(`/api/jobs/${j.id}/ps-rebuild`, {
            taskId: j.taskId, action: 'inspect-progress', artifactPath: baseArtifact,
          });
          assert.equal(progress.previewOnly, true);
          assert.equal(progress.alphaDiagnostics.text.passed, false);
          assert.deepEqual(Object.keys(progress.thumbnails), ['bg', 'text']);
          assert.deepEqual(Object.keys(progress.probes), ['bg', 'text']);
          assert.deepEqual(Object.keys(progress.alphaDiagnostics), ['text']);
          assert.deepEqual(ps.photoshopState(j), oldState);
          const images = store.load(j.documentId).images.length;
          await assert.rejects(ps.completePhotoshop(j, oldState.inspection!.psdPath), /PS区域alpha检查未通过/);
          assert.equal(store.load(j.documentId).images.length, images);
          for (const missingOrOld of ['missing', 'old'] as const) {
            const changed = structuredClone(oldState);
            if (missingOrOld === 'missing') delete changed.quality!.alphaDiagnostics;
            else changed.quality!.alphaDiagnostics!.text.version = 0 as any;
            store.atomic(path.join(folder, 'photoshop-rebuild.json'), changed);
            await assert.rejects(ps.completePhotoshop(j, oldState.inspection!.psdPath), /PS区域alpha诊断/);
            store.atomic(path.join(folder, 'photoshop-rebuild.json'), changed);
            await api(`/api/jobs/${j.id}/ps-rebuild`, reviewInput('text'), 'POST', 400);
            assert.equal(ps.photoshopState(j).inspection, undefined);
            assert.deepEqual(ps.photoshopState(j).reviews, {});
            store.atomic(path.join(folder, 'photoshop-rebuild.json'), oldState);
          }
          const clean = store.assetPath(j.documentId, j.snapshot.source), bytes = fs.readFileSync(clean);
          fs.appendFileSync(clean, 'changed');
          try {
            await api(`/api/jobs/${j.id}/ps-rebuild`, reviewInput('text'), 'POST', 400);
            assert.equal(ps.photoshopState(j).quality, undefined);
          } finally { fs.writeFileSync(clean, bytes); }
          store.atomic(path.join(folder, 'photoshop-rebuild.json'), oldState);
          await api(`/api/jobs/${j.id}/ps-rebuild`, repairInput);
          await ready('text');
          assert.equal(ps.photoshopState(j).quality, undefined);
          assert.deepEqual(ps.photoshopState(j).reviews, {});
        });
      }
      const placed = await api(`/api/jobs/${j.id}/ps-rebuild`, {
        taskId: j.taskId,
        action: 'place-material',
        layerId: 'text',
        artifactPath: baseArtifact,
      });
      assert.equal(placementCalls, 1);
      const inspect = () =>
        api(`/api/jobs/${j.id}/ps-rebuild`, {
          taskId: j.taskId,
          action: 'inspect',
          artifactPath: placed.artifactPath,
        });
      await inspect();
      assert(renderCalls > 0);
      assert(ps.photoshopState(j).inspection);
      if (baseKind === 'alphaChecks') {
        await t.test('HTTP PS alpha repair requires new actual render and binds approved results through final completion CAS', async () => {
          const state = ps.photoshopState(j), diag = state.quality!.alphaDiagnostics!.text;
          assert.equal(diag.passed, true);
          assert.equal(diag.sampling.checks[0].alpha.max, 0);
          assert.equal(diag.sampling.checks[1].alpha.min, 100);
          const thumbBytes = fs.readFileSync(state.inspection!.thumbnails.text);
          fs.appendFileSync(state.inspection!.thumbnails.text, 'changed');
          await api(`/api/jobs/${j.id}/ps-rebuild`, reviewInput('text'), 'POST', 400);
          assert.equal(ps.photoshopState(j).quality, undefined);
          fs.writeFileSync(state.inspection!.thumbnails.text, thumbBytes);
          await inspect();
          await api(`/api/jobs/${j.id}/ps-rebuild`, reviewInput('text'));
          await api(`/api/jobs/${j.id}/ps-rebuild`, reviewInput('bg'));
          const approved = ps.photoshopState(j);
          await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'review-composite',
            observation: '真实隔离夹具已分别检查，不能当成真实海报视觉验收',
            comparisonHash: approved.quality!.comparisons!.composite.hash, relations: [] });
          const completed = ps.photoshopState(j);
          const pending = ps.completePhotoshop(j, completed.inspection!.psdPath);
          const newer = structuredClone(completed); newer.compositeReview = '完成期间出现新整图意见';
          store.atomic(path.join(folder, 'photoshop-rebuild.json'), newer);
          await assert.rejects(pending, /完成校验期间/);
          assert.deepEqual(ps.photoshopState(j), newer);
          store.atomic(path.join(folder, 'photoshop-rebuild.json'), completed);
          const output = await ps.completePhotoshop(j, completed.inspection!.psdPath);
          assert.equal(output.review.pending, 0);
          assert.equal(output.image.width, 80);
          assert.equal(output.image.nativePsd!.mappings.length, 2);
        });
        return;
      }
      if (baseKind === 'generated')
        await t.test(
          'legacy generated repair record without sourceKind remains verifiable',
          async () => {
            const legacy = ps.photoshopState(j);
            delete legacy.materials.text.repair!.base.sourceKind;
            store.atomic(path.join(folder, 'photoshop-rebuild.json'), legacy);
            await inspect();
            assert(ps.photoshopState(j).inspection);
          },
        );
      const tamperFiles = [
        maskFile,
        oldMaterial.workingPath!,
        patch.output.originalPath,
        repaired.repair!.patch.path,
        repaired.workingPath!,
        ...(baseKind === 'extracted'
          ? [oldFile, oldMaterial.originalPath, store.assetPath(j.documentId, j.snapshot.source)]
          : []),
      ];
      for (const file of tamperFiles) {
        const before = fs.readFileSync(file);
        fs.appendFileSync(file, 'tampered');
        await api(
          `/api/jobs/${j.id}/ps-rebuild`,
          { taskId: j.taskId, action: 'inspect', artifactPath: placed.artifactPath },
          'POST',
          400,
        );
        assert.equal(ps.photoshopState(j).inspection, undefined);
        fs.writeFileSync(file, before);
        await inspect();
      }
      const registryPath = path.join(folder, 'generation', 'registry.json'),
        registryBytes = fs.readFileSync(registryPath);
      for (const generationId of [old.output.id, patch.output.id].filter(Boolean)) {
        const registry = JSON.parse(registryBytes.toString());
        const record = registry.outputs.find((r: any) => r.id === generationId);
        record.placementFrame = {
          ...(record.placementFrame || p.layers[1].frame),
          x: (record.placementFrame || p.layers[1].frame).x + 1,
        };
        fs.writeFileSync(registryPath, JSON.stringify(registry));
        await api(
          `/api/jobs/${j.id}/ps-rebuild`,
          { taskId: j.taskId, action: 'inspect', artifactPath: placed.artifactPath },
          'POST',
          400,
        );
        assert.equal(ps.photoshopState(j).inspection, undefined);
        fs.writeFileSync(registryPath, registryBytes);
        await inspect();
      }
      // Same bytes under a different source registration are still changed lineage.
      const registry = JSON.parse(registryBytes.toString());
      const record = registry.outputs.find((r: any) => r.id === patch.output.id);
      const switchedSource = path.join(folder, 'fixture-switched-patch-original.png');
      fs.copyFileSync(record.originalPath, switchedSource);
      record.originalPath = switchedSource;
      fs.writeFileSync(registryPath, JSON.stringify(registry));
      await api(
        `/api/jobs/${j.id}/ps-rebuild`,
        { taskId: j.taskId, action: 'inspect', artifactPath: placed.artifactPath },
        'POST',
        400,
      );
      assert.equal(ps.photoshopState(j).inspection, undefined);
      fs.writeFileSync(registryPath, registryBytes);
      await inspect();
      assert.equal(native.fileHash(patch.output.originalPath), originalPatchHash);
      if (baseKind === 'extracted') {
        const before = ps.photoshopState(j),
          changed = structuredClone(before);
        changed.materials.text.repair!.base.extraction!.placementFrame.x += 1;
        store.atomic(path.join(folder, 'photoshop-rebuild.json'), changed);
        await api(
          `/api/jobs/${j.id}/ps-rebuild`,
          { taskId: j.taskId, action: 'inspect', artifactPath: placed.artifactPath },
          'POST',
          400,
        );
        assert.equal(ps.photoshopState(j).inspection, undefined);
        store.atomic(path.join(folder, 'photoshop-rebuild.json'), before);
        const chainInput = {
          ...repairInput,
          repair: {
            ...repairInput.repair,
            expectedBaseWorkingHash: native.fileHash(repaired.workingPath!),
            baseArtifactPath: placed.artifactPath,
          },
        };
        await api(`/api/jobs/${j.id}/ps-rebuild`, chainInput);
        const chained = await ready('text');
        assert.deepEqual(chained.repair!.base.prior!.base.extraction, oldMaterial.extraction);
        const sourcePath = oldMaterial.extraction!.source.path,
          bytes = fs.readFileSync(sourcePath);
        try {
          fs.appendFileSync(sourcePath, 'changed-clean-source');
          await api(
            `/api/jobs/${j.id}/ps-rebuild`,
            {
              taskId: j.taskId,
              action: 'place-material',
              artifactPath: placed.artifactPath,
              layerId: 'text',
            },
            'POST',
            400,
          );
          assert.deepEqual(ps.photoshopState(j).checks, {});
        } finally {
          fs.writeFileSync(sourcePath, bytes);
        }
      }
      await t.test(
        'HTTP inspect CAS preserves a newer ready material completed during Adobe rendering',
        async () => {
          let start!: () => void, release!: () => void;
          const started = new Promise<void>((done) => {
            start = done;
          });
          const waiting = new Promise<void>((done) => {
            release = done;
          });
          renderPause = { start, release: waiting };
          const pending = api(
            `/api/jobs/${j.id}/ps-rebuild`,
            {
              taskId: j.taskId,
              action: 'inspect',
              artifactPath: placed.artifactPath,
            },
            'POST',
            400,
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              started,
              pending.then(() => {
                throw Error('Inspect did not pause at the Adobe boundary');
              }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(Error('Inspect pause timed out')), 5000);
              }),
            ]);
            await api(`/api/jobs/${j.id}/ps-rebuild`, old.input);
            const newer = await ready('text');
            assert.notEqual(newer.workingPath, repaired.workingPath);
            const expectedState = ps.photoshopState(j);
            assert.equal(expectedState.inspection, undefined);
            release();
            const rejected = await pending;
            assert.match(rejected.error, /完整素材绑定已变更/);
            assert.deepEqual(ps.photoshopState(j), expectedState);
            assert(
              renderPause.paths?.every((file) => fs.existsSync(file) && fs.statSync(file).size > 0),
            );
          } finally {
            release();
            clearTimeout(timer);
            await pending.catch(() => {});
            renderPause = undefined;
          }
        },
      );
    } finally {
      adobe.executeScript = originalExecute;
    }

    async function duringDerivedRepair(
      context: TestContext,
      change: (baseline: typeof oldMaterial) => Promise<void>,
      message: RegExp,
    ) {
      await api(`/api/jobs/${j.id}/ps-rebuild`, old.input);
      const baseline = await ready('text');
      await fixturePsd(baseArtifact);
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        return { promise, resolve };
      };
      const started = deferred(),
        release = deferred();
      let held = false,
        record: any,
        derivedBytes: Buffer | undefined;
      const write = fs.writeFileSync;
      context.mock.method(fs, 'writeFileSync', (...args: any[]) => {
        const result = Reflect.apply(write, fs, args);
        if (
          typeof args[0] === 'string' &&
          args[0].startsWith(path.join(folder, 'materials') + path.sep) &&
          path.basename(args[0]) === 'repair-provenance.json'
        ) {
          record = JSON.parse(fs.readFileSync(args[0], 'utf8'));
          derivedBytes = fs.readFileSync(record.output.path);
        }
        return result;
      });
      const proto = Object.getPrototypeOf(
        sharp(Buffer.alloc(4), { raw: { width: 1, height: 1, channels: 4 } }),
      );
      const toBuffer = proto.toBuffer;
      // Pause the real post-derivation isolation read. Neither the derivation nor
      // HTTP/state/source validation is mocked, and a second request can finish.
      context.mock.method(proto, 'toBuffer', function (this: any, ...args: any[]) {
        const input = this.options?.input?.buffer;
        if (
          !held &&
          this.options?.formatOut === 'raw' &&
          derivedBytes &&
          Buffer.isBuffer(input) &&
          input.equals(derivedBytes)
        ) {
          held = true;
          started.resolve();
          return release.promise.then(() => Reflect.apply(toBuffer, this, args));
        }
        return Reflect.apply(toBuffer, this, args);
      });
      const pending = api(
        `/api/jobs/${j.id}/ps-rebuild`,
        {
          ...repairInput,
          repair: {
            ...repairInput.repair,
            expectedBaseWorkingHash: native.fileHash(baseline.workingPath!),
          },
        },
        'POST',
        400,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          started.promise,
          pending.then(() => {
            throw Error('Repair did not pause after deriving its files');
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('Repair pause timed out')), 5000);
          }),
        ]);
        await change(baseline);
        const expectedMaterial = ps.photoshopState(j).materials.text;
        assert.equal(expectedMaterial.status, 'ready');
        release.resolve();
        const rejected = await pending;
        assert.match(rejected.error, message);
        assert.deepEqual(ps.photoshopState(j).materials.text, expectedMaterial);
        assert.equal(native.fileHash(record.output.path), record.output.hash);
        assert(
          fs.existsSync(path.join(path.dirname(record.output.path), 'repair-provenance.json')),
        );
        assert.notEqual(ps.photoshopState(j).materials.text.workingPath, record.output.path);
      } finally {
        release.resolve();
        clearTimeout(timer);
        await pending.catch(() => {});
      }
    }

    await t.test(
      'HTTP repair CAS preserves a newer ready material even with the same base bytes',
      async (context) => {
        await duringDerivedRepair(
          context,
          async (baseline) => {
            await api(`/api/jobs/${j.id}/ps-rebuild`, old.input);
            const newer = await ready('text');
            assert.notEqual(newer.workingPath, baseline.workingPath);
            assert.equal(
              native.fileHash(newer.workingPath!),
              native.fileHash(baseline.workingPath!),
            );
          },
          /完整基底绑定已改变/,
        );
      },
    );

    for (const field of ['originalPath', 'workingPath'] as const) {
      await t.test(
        `HTTP repair rechecks the patch ${field} changed during derivation`,
        async (context) => {
          const source = patch.output[field],
            before = fs.readFileSync(source);
          try {
            await duringDerivedRepair(
              context,
              async () => {
                fs.appendFileSync(source, 'changed-during-derivation');
              },
              /修复推导期间来源或定位已改变/,
            );
          } finally {
            fs.writeFileSync(source, before);
          }
        },
      );
    }

    if (baseKind === 'extracted') {
      for (const sourceKind of ['raw-original', 'clean-source', 'placement'] as const)
        await t.test(
          `HTTP extracted repair rejects ${sourceKind} changed during derivation`,
          async (context) => {
            const source =
                sourceKind === 'raw-original'
                  ? oldFile
                  : store.assetPath(j.documentId, j.snapshot.source),
              before = fs.readFileSync(source);
            try {
              await duringDerivedRepair(
                context,
                async () => {
                  if (sourceKind === 'placement') {
                    const changed = ps.photoshopState(j);
                    changed.materials.text.placementFrame!.x += 1;
                    store.atomic(path.join(folder, 'photoshop-rebuild.json'), changed);
                  } else fs.appendFileSync(source, 'changed-during-derive');
                },
                sourceKind === 'placement' ? /完整基底绑定已改变/ : /修复推导期间来源或定位已改变/,
              );
              assert.deepEqual(ps.photoshopState(j).checks, {});
            } finally {
              fs.writeFileSync(source, before);
            }
          },
        );
    }

    for (const sourceKind of ['mask', 'artifact', 'base', 'patch'] as const) {
      await t.test(
        `HTTP repair rejects changed ${sourceKind} bytes after its computational snapshot`,
        async (context) => {
          await api(`/api/jobs/${j.id}/ps-rebuild`, old.input);
          const baseline = await ready('text');
          await fixturePsd(baseArtifact);
          const baselineState = ps.photoshopState(j).materials.text;
          const blackMask = await sharp({
            create: { width: 60, height: 20, channels: 4, background: '#000000' },
          })
            .png()
            .toBuffer();
          let source: string | undefined,
            before: Buffer | undefined,
            record: any,
            changed = false;
          const write = fs.writeFileSync;
          context.mock.method(fs, 'writeFileSync', (...args: any[]) => {
            const result = Reflect.apply(write, fs, args);
            const target = args[0];
            if (
              typeof target === 'string' &&
              target.startsWith(path.join(folder, 'materials') + path.sep)
            ) {
              if (path.basename(target) === 'repair-base.png' && !changed) {
                changed = true;
                source =
                  sourceKind === 'mask'
                    ? maskFile
                    : sourceKind === 'artifact'
                      ? baseArtifact
                      : sourceKind === 'base'
                        ? baseline.workingPath!
                        : path.join(path.dirname(target), 'working.png');
                before = fs.readFileSync(source);
                Reflect.apply(write, fs, [
                  source,
                  sourceKind === 'mask'
                    ? blackMask
                    : Buffer.concat([before, Buffer.from('changed-after-snapshot')]),
                ]);
              }
              if (path.basename(target) === 'repair-provenance.json')
                record = JSON.parse(fs.readFileSync(target, 'utf8'));
            }
            return result;
          });
          try {
            const rejected = await api(`/api/jobs/${j.id}/ps-rebuild`, repairInput, 'POST', 400);
            assert.match(rejected.error, /来源快照已在推导期间变化/);
            assert(changed && record);
            assert.deepEqual(ps.photoshopState(j).materials.text, baselineState);
            assert.equal(record.base.hash, record.base.source.hash);
            assert.equal(native.fileHash(record.base.path), record.base.hash);
            assert.equal(record.mask.hash, record.mask.source.hash);
            assert.equal(native.fileHash(record.mask.path), record.mask.hash);
            const bound =
              sourceKind === 'mask'
                ? record.mask.source
                : sourceKind === 'artifact'
                  ? record.artifact
                  : sourceKind === 'base'
                    ? record.base.source
                    : record.patch;
            assert.equal(bound.hash, crypto.createHash('sha256').update(before!).digest('hex'));
            assert.notEqual(native.fileHash(source!), bound.hash);
            assert.equal(native.fileHash(record.output.path), record.output.hash);
          } finally {
            if (source && before) Reflect.apply(write, fs, [source, before]);
          }
        },
      );
    }

    await t.test(
      'HTTP repair uses one base byte snapshot through a changed-then-restored source',
      async (context) => {
        await api(`/api/jobs/${j.id}/ps-rebuild`, old.input);
        const baseline = await ready('text');
        await fixturePsd(baseArtifact);
        const before = fs.readFileSync(baseline.workingPath!);
        const changedPixels = Buffer.from(oldPixels);
        for (let k = 0; k < changedPixels.length; k += 4) changedPixels[k] = 240;
        const changedBytes = await sharp(changedPixels, {
          raw: { width: 60, height: 20, channels: 4 },
        })
          .png()
          .toBuffer();
        const read = fs.readFileSync,
          write = fs.writeFileSync,
          copy = fs.copyFileSync;
        let sawArtifact = false,
          swapped = false,
          restored = false;
        context.mock.method(fs, 'readFileSync', (...args: any[]) => {
          const value = Reflect.apply(read, fs, args);
          if (args[0] === baseArtifact) sawArtifact = true;
          if (sawArtifact && args[0] === baseline.workingPath && !swapped) {
            swapped = true;
            Reflect.apply(write, fs, [baseline.workingPath!, changedBytes]);
          }
          return value;
        });
        const restoreOnCopy = (target: unknown) => {
          if (typeof target === 'string' && path.basename(target) === 'repair-base.png') {
            restored = true;
            Reflect.apply(write, fs, [baseline.workingPath!, before]);
          }
        };
        context.mock.method(fs, 'writeFileSync', (...args: any[]) => {
          const result = Reflect.apply(write, fs, args);
          restoreOnCopy(args[0]);
          return result;
        });
        context.mock.method(fs, 'copyFileSync', (...args: any[]) => {
          const result = Reflect.apply(copy, fs, args);
          restoreOnCopy(args[1]);
          return result;
        });
        try {
          await api(`/api/jobs/${j.id}/ps-rebuild`, repairInput);
          const result = await ready('text');
          assert(swapped && restored);
          assert.equal(
            native.fileHash(result.repair!.base.path),
            native.fileHash(baseline.workingPath!),
          );
          const output = await sharp(Reflect.apply(read, fs, [result.workingPath!]))
            .ensureAlpha()
            .raw()
            .toBuffer();
          const original = await sharp(before).ensureAlpha().raw().toBuffer();
          for (let y = 0; y < 20; y++)
            for (let x = 0; x < 60; x++) {
              if (x < 20 || x > 35 || y < 6 || y > 14) {
                const k = (y * 60 + x) * 4;
                assert.deepEqual(output.subarray(k, k + 4), original.subarray(k, k + 4));
              }
            }
        } finally {
          Reflect.apply(write, fs, [baseline.workingPath!, before]);
        }
      },
    );

    await t.test(
      'HTTP repair rejects a real align request completed during derivation',
      async (context) => {
        await duringDerivedRepair(
          context,
          async () => {
            const aligned = await api(`/api/jobs/${j.id}/generation`, {
              taskId: j.taskId,
              action: 'align',
              generationId: patch.output.id,
              anchorNames: ['left', 'right'],
              points: [
                { source: [9, 10], target: [10, 10] },
                { source: [39, 10], target: [40, 10] },
              ],
              observation: 'fixture按冻结参考点平移一像素，验证并发定位绑定',
            });
            assert.notEqual(aligned.workingPath, patch.output.workingPath);
            assert.notDeepEqual(aligned.placementFrame, patch.output.placementFrame);
          },
          /修复推导期间来源或定位已改变/,
        );
      },
    );
  });
