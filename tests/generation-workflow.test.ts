import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { generationCarrier } from '../shared/generation-geometry.js';
process.env.LAYER_CANVAS_DATA = path.resolve('test-output/workflow-' + crypto.randomUUID());
const { app, TOKEN, BRIDGE_TOKEN } = await import('../server/index.js');
const store = await import('../server/store.js');
const { generationAction, generationState } = await import('../server/generation.js');
const nativeFontPath = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(p => fs.existsSync(p));
const { landmarkTransform, alignGeneration } = await import('../server/generation-alignment.js');
const { exportPsd, renderImage } = await import('../server/media.js');
const { readPsd } = await import('ag-psd');
app.locals.codexSender = async () => ({ delivered: true });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
after(() => {
  server.closeAllConnections();
  server.close();
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function api(route: string, body?: unknown, status = 200) {
  const r = await fetch(base + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Canvas-Token': TOKEN,
      'X-Canvas-Bridge': BRIDGE_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value: any = await r.json();
  assert.equal(r.status, status, JSON.stringify(value));
  return value;
}
async function file(w: number, h: number, alpha = false) {
  fs.mkdirSync(process.env.LAYER_CANVAS_DATA!, { recursive: true });
  const p = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  if (!alpha)
    await sharp({ create: { width: w, height: h, channels: 3, background: '#806030' } })
      .png()
      .toFile(p);
  else {
    const data = Buffer.alloc(w * h * 4);
    for (let y = Math.floor(h * 0.3); y < Math.floor(h * 0.7); y++)
      for (let x = Math.floor(w * 0.1); x < Math.floor(w * 0.9); x++)
        data.set([235, 70, 45, 255], (y * w + x) * 4);
    data.set([230, 60, 45, 1], ((h - 1) * w + w - 1) * 4);
    await sharp(data, { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toFile(p);
  }
  return p;
}
async function fixture(split = false, type = 'layer', opaqueBackground = false,
  size = { width: 300, height: 180 }, foregroundBox: [number, number, number, number] = [40, 30, 200, 40]) {
  let d = await api('/api/document?taskId=workflow_' + crypto.randomUUID());
  d = await api(`/api/document/${d.id}/import-path`, {
    taskId: d.taskId,
    path: await file(size.width, size.height),
  });
  const plan = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: d.images[0].id, type: 'plan', mode: 3 },
    202,
  );
  await api(`/api/jobs/${plan.id}/claim`, { taskId: d.taskId });
  const planned = await api(`/api/jobs/${plan.id}/plan`, {
    taskId: d.taskId,
    baseVersion: plan.version,
    layers: [
      opaqueBackground
        ? { name: '背景', box: [0, 0, size.width, size.height], role: 'background' }
        : { name: '标题', box: foregroundBox },
      ...(split ? [{ name: '底座', box: [40, 90, 150, 60] }] : []),
    ],
  });
  d = planned.document;
  const job = await api(`/api/document/${d.id}/jobs`, { imageId: d.images[0].id, type }, 202);
  await api(`/api/jobs/${job.id}/claim`, { taskId: d.taskId });
  const j = store.getJob(job.id);
  assert.equal(j.reconstructionWorkflowVersion, 4);
  const layout = {
    layers: j.snapshot.layers.map((l, i) => ({
      sourceLayerIds: [l.id],
      elements: [l.name],
      excludes: '其余层的物体、背景与文字',
      anchors: i
        ? []
        : [
            { name: 'left', point: [60, 50], observation: '左侧参考笔画中心' },
            { name: 'right', point: [220, 50], observation: '右侧参考笔画中心' },
          ],
    })),
    relations: split
      ? [
          {
            id: 'contact',
            layerIds: j.snapshot.layers.map((l) => l.id),
            kind: 'alignment',
            observation: '标题左边与底座左边对齐，二者间距固定',
          },
        ]
      : [],
  };
  return { d, j, layout };
}
async function prep(j: any, layout: any, i = 0) {
  return generationAction(j, {
    action: 'prepare',
    sourceLayerIds: layout.layers[i].sourceLayerIds,
    purpose: '完全保持原参考，只分离此层',
    elements: layout.layers[i].elements,
    referenceObservation: '标题位于上方，笔画红色，两端倾斜与原始参考一致',
  });
}
async function prepareAnchorFixture(type: 'layer' | 'photoshop', anchors?: any[], scale = 1,
  foregroundBox?: [number, number, number, number]) {
  const { j, layout } = await fixture(false, type, false, undefined, foregroundBox);
  if (type === 'layer') {
    if (anchors === undefined) delete (layout.layers[0] as any).anchors;
    else layout.layers[0].anchors = anchors;
    await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'layout',
      layout: { ...layout, width: j.snapshot.width * scale, height: j.snapshot.height * scale } });
  } else {
    const l = j.snapshot.layers[0];
    const f = l.frame!;
    await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan', plan: {
      canvas: { width: j.snapshot.width * scale, height: j.snapshot.height * scale },
      layers: [{ layerId: l.id, name: l.name,
        frame: { x: f.x * scale, y: f.y * scale,
          width: f.width * scale, height: f.height * scale },
        route: 'generate', content: 'bitmap', surface: 'transparent', rationale: '隔离定位点接口回归',
        includes: l.name, excludes: '背景与其他对象', compositing: 'normal', editable: 'pixels',
        elements: layout.layers[0].elements, ...(anchors === undefined ? {} : { anchors }) }],
    } });
  }
  return { j, layout };
}
async function reg(j: any, p: any, w = 900, h = 300) {
  return generationAction(j, {
    action: 'register',
    requestId: p.id,
    path: await file(w, h, true),
    prompt: p.prompt,
    referencePaths: p.referencePaths,
  });
}
test('prepare anchors HTTP keeps explicit pre-generation points when ordinary or PS frozen anchors are empty', async (t) => {
  for (const type of ['layer', 'photoshop'] as const) await t.test(type, async () => {
    const { j, layout } = await prepareAnchorFixture(type, []);
    const anchors = [
      { name: 'manual-left', point: [60, 50], observation: 'prepare前查看原图确认左端' },
      { name: 'manual-right', point: [220, 50], observation: 'prepare前查看原图确认右端' },
    ];
    const p = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'prepare',
      sourceLayerIds: layout.layers[0].sourceLayerIds, purpose: '生成前显式记录定位目标',
      elements: layout.layers[0].elements, referenceObservation: '原图两个端点位于框内', anchors });
    assert.deepEqual(p.anchors, anchors);
    assert.deepEqual(generationState(j).requests.find(request => request.id === p.id)?.anchors, anchors);
  });
});
test('prepare anchors HTTP handles omitted and empty defaults while keeping nonempty frozen points authoritative', async (t) => {
  const frozen = [
    { name: 'left', point: [60, 50], observation: '计划中冻结的左端' },
    { name: 'right', point: [220, 50], observation: '计划中冻结的右端' },
  ];
  const explicit = [{ name: 'manual', point: [100, 50], observation: '不同的prepare观察点' }];
  for (const type of ['layer', 'photoshop'] as const) {
    for (const c of [
      { name: 'omitted plan falls back', frozen: undefined, input: explicit, expected: explicit },
      { name: 'omitted input defaults empty', frozen: undefined, input: undefined, expected: [] },
      { name: 'explicit empty remains empty', frozen: [], input: [], expected: [] },
      { name: 'frozen beats conflicting input', frozen, input: explicit, expected: frozen },
      { name: 'frozen beats empty input', frozen, input: [], expected: frozen },
      { name: 'frozen beats omitted input', frozen, input: undefined, expected: frozen },
    ]) await t.test(`${type}: ${c.name}`, async () => {
      const { j, layout } = await prepareAnchorFixture(type, c.frozen);
      const ps = await import('../server/photoshop-rebuild.js');
      const binding = () => type === 'layer' ? generationState(j).layout : ps.photoshopState(j).plan;
      const before = structuredClone(binding());
      const p = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'prepare',
        sourceLayerIds: layout.layers[0].sourceLayerIds, purpose: '校验冻结和prepare定位点优先级',
        elements: layout.layers[0].elements, referenceObservation: '定位观察来自当前原图',
        ...(c.input === undefined ? {} : { anchors: c.input }) });
      assert.deepEqual(p.anchors, c.expected);
      assert.deepEqual(generationState(j).requests.find(request => request.id === p.id)?.anchors, c.expected);
      assert.deepEqual(binding(), before, 'prepare must not rewrite the frozen layout or PS plan');
    });
  }
});
test('prepare anchors HTTP validates final canvas coordinates and maps explicit points into the full carrier', async (t) => {
  for (const type of ['layer', 'photoshop'] as const) await t.test(type, async () => {
    const { j, layout } = await prepareAnchorFixture(type, [], 2);
    const body = { taskId: j.taskId, action: 'prepare', sourceLayerIds: layout.layers[0].sourceLayerIds,
      purpose: '在二倍输出画布记录人工定位点', elements: layout.layers[0].elements,
      referenceObservation: '观察点为最终整图像素，不能把原图像素直接传入' };
    const oldCount = generationState(j).requests.length;
    const rejected = await api(`/api/jobs/${j.id}/generation`, { ...body,
      anchors: [{ name: 'source-coordinate', point: [60, 50], observation: '错误地使用原图片坐标' }] }, 500);
    assert.match(rejected.error, /最终图层框内.*最终整图像素/);
    assert.equal(generationState(j).requests.length, oldCount);
    const anchors = [
      { name: 'manual-left', point: [120, 100], observation: '最终画布中的左端点' },
      { name: 'manual-right', point: [440, 100], observation: '最终画布中的右端点' },
    ];
    const p = await api(`/api/jobs/${j.id}/generation`, { ...body, anchors });
    assert.deepEqual(p.frame, { x: 80, y: 60, width: 400, height: 80 });
    assert.deepEqual(p.carrier.frame, { x: 80, y: 33, width: 400, height: 134 });
    assert.deepEqual(p.anchors, anchors);
    assert(p.prompt.includes(JSON.stringify([
      { ...anchors[0], generationPoint: [40, 67] }, { ...anchors[1], generationPoint: [360, 67] },
    ])));
  });
});
test('prepare anchors HTTP remain bound to their original request after generation and reject added or moved align targets', async (t) => {
  for (const type of ['layer', 'photoshop'] as const) await t.test(type, async () => {
    const { j, layout } = await prepareAnchorFixture(type, []);
    const anchors = [
      { name: 'manual-left', point: [60, 50], observation: '生成前冻结左端' },
      { name: 'manual-right', point: [220, 50], observation: '生成前冻结右端' },
    ];
    const p = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'prepare',
      sourceLayerIds: layout.layers[0].sourceLayerIds, purpose: '先冻结定位再生成',
      elements: layout.layers[0].elements, referenceObservation: '当前原图两端位置固定', anchors });
    const r = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'register', requestId: p.id,
      path: await file(p.generation.size.width * 2, p.generation.size.height * 2, true),
      prompt: p.prompt, referencePaths: p.referencePaths });
    assert.equal(r.isolationProblem, undefined);
    const before = structuredClone(generationState(j));
    for (const [names, target] of [[['added-after-generation', 'manual-right'], [20, 20]],
      [['manual-left', 'manual-right'], [30, 20]]] as const) {
      const error = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'align', generationId: r.id,
        anchorNames: names, anchors: [{ name: names[0], point: [target[0] + r.frame.x, target[1] + r.frame.y],
          observation: '生成后注入的目标不可采纳' }],
        points: [{ source: [40, 40], target }, { source: [360, 40], target: [180, 20] }],
        observation: '反例：新增点或移动已冻结目标' }, 500);
      assert.match(error.error, /冻结坐标/);
      assert.deepEqual(generationState(j), before);
    }
    const aligned = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'align', generationId: r.id,
      anchorNames: ['manual-left', 'manual-right'],
      points: [{ source: [40, 40], target: [20, 20] }, { source: [360, 40], target: [180, 20] }],
      observation: '使用生成前已冻结的两个点统一缩放和平移' });
    assert.deepEqual(aligned.placementFrame, { x: 40, y: 30, width: 200, height: 67 });
    assert.deepEqual(generationState(j).requests.find(request => request.id === p.id)?.anchors, anchors);
  });
});
async function review(j: any, r: any, name: string, status = 'accepted', candidateIds = [r.id]) {
  return generationAction(j, {
    action: 'review',
    generationId: r.id,
    comparisonHash: r.comparisonHash,
    elements: [
      {
        name,
        status: status === 'accepted' ? 'matched' : 'different',
        observation:
          status === 'accepted'
            ? '两个端点对应参考两端，红色横向形状和间距一致'
            : '横向形状仍偏窄，右端距离参考位置更远',
      },
    ],
    evidence: {
      geometry: '已在最终整图坐标检查两端及上下留白，中心横线位置匹配',
      appearance: '红色填充和两端轮廓经过局部对照，没有额外文字或物体',
      isolation: '物体之外是真透明，右下微弱透明边沿保留且不叠加背景',
      candidateIds,
    },
    review: {
      status,
      attempts:
        status === 'accepted'
          ? [{ method: '逐项查看实际局部对比', observation: '端点间距与预设几何夹具一致' }]
          : [
              { method: '原局部参考生成', observation: '两端间距偏小' },
              { method: '明确端点重新生成', observation: '另一候选仍偏窄' },
            ],
      issues: status === 'accepted' ? [] : [{ message: '标题仍有明显形状漂移，保留最好候选' }],
    },
  });
}
async function compositeReview(j: any, rs: any[], relations: any[] = []) {
  const c: any = await generationAction(j, {
    action: 'composite',
    generationIds: rs.map((r) => r.id),
  });
  await generationAction(j, {
    action: 'review-composite',
    comparisonHash: c.comparisonHash,
    layers: rs.map((r) => ({
      generationId: r.id,
      status: 'matched',
      observation: '已查看最终坐标叠放，框内位置和周边留白没有额外变化',
    })),
    relations,
  });
  return c;
}

test('RGB不透明背景登记成功，不要求重新生图制造alpha', async () => {
  const { j } = await fixture();
  j.snapshot.layers[0].role = 'background';
  delete j.reconstructionWorkflowVersion;
  const p: any = await generationAction(j, {
    action: 'prepare',
    sourceLayerIds: [j.snapshot.layers[0].id],
    purpose: '背景补全',
    elements: ['背景'],
    referenceObservation: '平面暖灰背景，不包含前景',
  });
  const original = await file(1024, 1536);
  const r: any = await generationAction(j, {
    action: 'register',
    requestId: p.id,
    path: original,
    prompt: p.prompt,
    referencePaths: p.referencePaths,
  });
  assert.equal(r.isolationProblem, undefined);
  assert.deepEqual(fs.readFileSync(original), fs.readFileSync(r.originalPath));
  assert(r.workingSize.width * r.workingSize.height <= 1500000);
});

test('狭长承载画幅仍在150万内；两点水平定位不限25%，弱alpha越框原样保留', async () => {
  for (const f of [
    { x: 0, y: 0, width: 554, height: 99 },
    { x: -10, y: 20, width: 400, height: 9000 },
  ]) {
    const carrier = generationCarrier(f);
    assert(carrier.expanded);
    assert(carrier.size.width * carrier.size.height <= 1500000);
    assert.equal(carrier.frame.x + carrier.artwork.x, f.x);
    assert.equal(carrier.frame.y + carrier.artwork.y, f.y);
  }
  const pairs = [
    { source: [10, 50] as [number, number], target: [20, 20] as [number, number] },
    { source: [90, 50] as [number, number], target: [180, 20] as [number, number] },
  ];
  assert.equal(landmarkTransform(pairs, { width: 200, height: 40 }).scale, 2);
  const p = await file(100, 100, true),
    bytes = fs.readFileSync(p);
  const aligned = await alignGeneration(bytes, { x: 40, y: 30, width: 200, height: 40 }, pairs);
  assert.deepEqual(aligned.placementFrame, { x: 40, y: -50, width: 200, height: 200 });
  assert.equal(
    (await sharp(aligned.bytes).ensureAlpha().raw().toBuffer())[(100 * 100 - 1) * 4 + 3],
    1,
  );
});

test('新流程最终合成必须审核；冻结目标点，真实输出PSD保留越框且不能模板完成', async () => {
  const { j, d, layout } = await fixture();
  await assert.rejects(() => prep(j, layout), /先layout/);
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout),
    r: any = await reg(j, p);
  assert(p.carrier.expanded);
  assert.notEqual(p.referencePaths[0], p.localPath);
  assert.equal(r.aspectError < 0.01, true);
  await assert.rejects(
    () =>
      generationAction(j, {
        action: 'align',
        generationId: r.id,
        anchorNames: ['left', 'right'],
        points: [
          { source: [90, 150], target: [30, 20] },
          { source: [810, 150], target: [180, 20] },
        ],
        observation: '故意迁就模型修改左目标点',
      }),
    /冻结坐标/,
  );
  const aligned: any = await generationAction(j, {
    action: 'align',
    generationId: r.id,
    anchorNames: ['left', 'right'],
    points: [
      { source: [90, 150], target: [20, 20] },
      { source: [810, 150], target: [180, 20] },
    ],
    observation: '按照原参考两端点恢复标题的横向跨度',
  });
  assert.equal(aligned.placementFrame.width, 200);
  assert(aligned.placementFrame.height > aligned.frame.height);
  await review(j, aligned, '标题');
  const payload = {
    taskId: j.taskId,
    baseVersion: j.version,
    layers: [
      {
        id: j.snapshot.layers[0].id,
        name: '标题',
        ...aligned.frame,
        path: aligned.originalPath,
        generationId: aligned.id,
      },
    ],
  };
  await api(`/api/jobs/${j.id}/apply`, payload, 500);
  const c = await compositeReview(j, [aligned]);
  assert(c.complete);
  assert(fs.existsSync(c.path));
  const done = await api(`/api/jobs/${j.id}/apply`, payload);
  assert.equal(done.document.images.length, 2);
  assert.deepEqual(done.document.images[0], d.images[0]);
  const im = done.document.images[1];
  assert.deepEqual(im.layers[0].frame, aligned.frame);
  assert(im.layers[0].height > im.layers[0].frame.height);
  const psd = readPsd(await exportPsd(d.id, im), { useImageData: true });
  assert.equal(psd.children?.[0].left, im.layers[0].x);
  assert.equal(psd.children![0].bottom! - psd.children![0].top!, im.layers[0].height);
  const approved = await sharp(fs.readFileSync(c.path)).ensureAlpha().raw().toBuffer();
  assert.deepEqual(
    await sharp(await renderImage(d.id, im))
      .ensureAlpha()
      .raw()
      .toBuffer(),
    approved,
  );
  assert.deepEqual(
    await sharp(store.assetPath(d.id, im.url)).ensureAlpha().raw().toBuffer(),
    approved,
  );
  assert.deepEqual(Buffer.from(psd.imageData!.data), approved);
});

test('登记尺寸取整后审核、正式回传、PSD逐像素一致；提交顺序不能改变冻结叠放', async () => {
  const { j, d, layout } = await fixture(true);
  const scale = 0.168517526;
  layout.layers[0].anchors = [
    { name: 'left', point: [90, 50], observation: '夹具冻结左端' },
    { name: 'right', point: [90 + 800 * scale, 50], observation: '夹具冻结右端' },
  ];
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout),
    r: any = await reg(j, p, 2169, 725);
  const aligned: any = await generationAction(j, {
    action: 'align',
    generationId: r.id,
    anchorNames: ['left', 'right'],
    points: [
      { source: [100, 100], target: [50, 20] },
      { source: [900, 100], target: [50 + 800 * scale, 20] },
    ],
    observation: '均匀缩放投影取整为366×122，不能按工作文件比例二次contain',
  });
  assert.deepEqual(aligned.workingSize, { width: 2118, height: 708 });
  assert.equal(aligned.placementFrame.width, 366);
  assert.equal(aligned.placementFrame.height, 122);
  await review(j, aligned, '标题');
  const p2: any = await prep(j, layout, 1),
    r2: any = await reg(j, p2, 600, 240);
  await review(j, r2, '底座');
  const c = await compositeReview(
    j,
    [r2, aligned],
    [
      {
        id: 'contact',
        status: 'matched',
        observation: '几何夹具按冻结次序叠放，越框透明素材完整',
      },
    ],
  );
  const done = await api(`/api/jobs/${j.id}/apply`, {
    taskId: j.taskId,
    baseVersion: j.version,
    layers: [r2, aligned].map((r) => ({
      id: r.sourceLayerIds[0],
      name: j.snapshot.layers.find((l) => l.id === r.sourceLayerIds[0])!.name,
      ...r.frame,
      path: r.originalPath,
      generationId: r.id,
    })),
  });
  const im = done.document.images[1];
  assert.deepEqual(
    im.layers.map((l: any) => l.id),
    j.snapshot.layers.map((l) => l.id),
  );
  assert.equal(im.layers[0].width, 366);
  assert.equal(im.layers[0].height, 122);
  const approved = await sharp(fs.readFileSync(c.path)).ensureAlpha().raw().toBuffer();
  assert.deepEqual(
    await sharp(store.assetPath(d.id, im.url)).ensureAlpha().raw().toBuffer(),
    approved,
  );
  assert.deepEqual(
    await sharp(await renderImage(d.id, im))
      .ensureAlpha()
      .raw()
      .toBuffer(),
    approved,
  );
  const psdBytes = await exportPsd(d.id, im);
  const psd = readPsd(psdBytes, { useImageData: true });
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const assembled = createCanvas(im.width, im.height),
    ctx = assembled.getContext('2d');
  for (let i = 0; i < im.layers.length; i++) {
    const layer = im.layers[i],
      child = psd.children![i];
    assert.equal(child.right! - child.left!, layer.width);
    assert.equal(child.bottom! - child.top!, layer.height);
    assert.deepEqual(
      Buffer.from(child.imageData!.data),
      await sharp(store.assetPath(d.id, layer.url)).ensureAlpha().raw().toBuffer(),
    );
    const png = await sharp(Buffer.from(child.imageData!.data), {
      raw: { width: layer.width, height: layer.height, channels: 4 },
    })
      .png()
      .toBuffer();
    ctx.globalAlpha = child.opacity ?? 1;
    if (!child.hidden) ctx.drawImage(await loadImage(png), child.left!, child.top!);
  }
  // PSD's flattened transparent preview is white-matted at 8 bits by ag-psd.
  // Its reconstructed unmatte is lossy; actual editable layer bytes and their
  // recomposition must still be exact, including translucent boundary pixels.
  assert.deepEqual(
    await sharp(assembled.toBuffer('image/png')).ensureAlpha().raw().toBuffer(),
    approved,
  );
  const psdPath = path.join(process.env.LAYER_CANVAS_DATA!, 'delivery-regression.psd');
  fs.writeFileSync(psdPath, psdBytes);
  fs.writeFileSync(
    path.join(process.env.LAYER_CANVAS_DATA!, 'delivery-pixel-evidence.json'),
    JSON.stringify(
      {
        fixture: 'New isolated API job; no historical user job modified',
        jobId: j.id,
        originalSize: aligned.originalSize,
        workingSize: aligned.workingSize,
        approvedPlacement: aligned.placementFrame,
        finalPlacement: {
          x: im.layers[0].x,
          y: im.layers[0].y,
          width: im.layers[0].width,
          height: im.layers[0].height,
        },
        approvedPath: c.path,
        finalPath: store.assetPath(d.id, im.url),
        psdPath,
        rawRGBAHash: crypto.createHash('sha256').update(approved).digest('hex'),
        changedChannels: { finalPNG: 0, rerender: 0, psdLayers: 0, psdLayerRecomposition: 0 },
        note: 'Transparent PSD flattened preview uses 8-bit white matte; exactness is checked against actual editable layers and their composition.',
      },
      null,
      2,
    ),
  );
});

test('不透明背景的审核合成、正式结果及PSD合成预览完全一致', async () => {
  const { j, d, layout } = await fixture(false, 'layer', true);
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout);
  const r: any = await generationAction(j, {
    action: 'register',
    requestId: p.id,
    path: await file(900, 540),
    prompt: p.prompt,
    referencePaths: p.referencePaths,
  });
  await review(j, r, '背景');
  const c = await compositeReview(j, [r]);
  const done = await api(`/api/jobs/${j.id}/apply`, {
    taskId: j.taskId,
    baseVersion: j.version,
    layers: [
      {
        id: r.sourceLayerIds[0],
        name: '背景',
        ...r.frame,
        path: r.originalPath,
        generationId: r.id,
      },
    ],
  });
  const im = done.document.images[1];
  const approved = await sharp(fs.readFileSync(c.path)).ensureAlpha().raw().toBuffer();
  assert.deepEqual(
    await sharp(store.assetPath(d.id, im.url)).ensureAlpha().raw().toBuffer(),
    approved,
  );
  const psd = readPsd(await exportPsd(d.id, im), { useImageData: true });
  assert.deepEqual(Buffer.from(psd.imageData!.data), approved);
});

test('background integer budget rounding fills the last column or row without stretching pixels', async () => {
  const { compositeSignature } = await import('../server/generation-workflow.js');
  for (const horizontal of [true, false]) {
    const size = horizontal ? { width: 1200, height: 1000 } : { width: 1000, height: 1200 };
    const native = horizontal ? { width: 1374, height: 1145 } : { width: 1145, height: 1374 };
    const { j, d, layout } = await fixture(false, 'layer', true, size);
    await generationAction(j, { action: 'layout', layout });
    const p: any = await prep(j, layout);
    const rgb = Buffer.alloc(native.width * native.height * 3);
    for (let y = 0; y < native.height; y++)
      for (let x = 0; x < native.width; x++) rgb.set([x % 251, y % 241, (x + y) % 239], (y * native.width + x) * 3);
    const original = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
    await sharp(rgb, { raw: { ...native, channels: 3 } }).png().toFile(original);
    const originalBytes = fs.readFileSync(original);
    const r: any = await generationAction(j, {
      action: 'register', requestId: p.id, path: original, prompt: p.prompt, referencePaths: p.referencePaths,
    });
    assert.deepEqual(r.originalSize, native);
    assert.deepEqual(r.workingSize, horizontal ? { width: 1341, height: 1118 } : { width: 1118, height: 1341 });
    assert(r.workingSize.width * r.workingSize.height <= 1500000);
    assert.equal(r.isolationProblem, undefined);
    assert.deepEqual(r.placementFrame, { x: 0, y: 0, ...size });
    assert.deepEqual(r.backgroundPadding, { left: 0, top: 0, right: horizontal ? 1 : 0, bottom: horizontal ? 0 : 1 });
    assert.deepEqual(fs.readFileSync(r.originalPath), originalBytes);
    assert.deepEqual(fs.readFileSync(original), originalBytes);
    await review(j, r, '背景');
    const c = await compositeReview(j, [r]);
    const state = generationState(j);
    assert.notEqual(compositeSignature(j, [r], state), compositeSignature(j, [{ ...r, backgroundPadding: undefined }], state));
    const done = await api(`/api/jobs/${j.id}/apply`, {
      taskId: j.taskId, baseVersion: j.version, layers: [{
        id: r.sourceLayerIds[0], name: '背景', ...r.frame, path: r.originalPath, generationId: r.id,
      }],
    });
    const im = done.document.images[1], layer = im.layers[0];
    assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [0, 0, size.width, size.height]);
    assert.equal(layer.generationAdaptation.padding, 'edge-copy');
    assert.equal(layer.generationAdaptation.contentWidth, size.width - (horizontal ? 1 : 0));
    assert.equal(layer.generationAdaptation.contentHeight, size.height - (horizontal ? 0 : 1));
    const approved = await sharp(fs.readFileSync(c.path)).ensureAlpha().raw().toBuffer();
    const pixels = await sharp(fs.readFileSync(store.assetPath(d.id, layer.url))).ensureAlpha().raw().toBuffer();
    const expected = await sharp(fs.readFileSync(r.workingPath))
      .resize(horizontal ? { height: size.height } : { width: size.width })
      .extend({ ...r.backgroundPadding, extendWith: 'copy' }).ensureAlpha().raw().toBuffer();
    assert.deepEqual(pixels, expected, 'one uniform resize plus explicit copied edge; never an anisotropic fit');
    assert.deepEqual(pixels, approved);
    for (let i = 3; i < pixels.length; i += 4) assert.equal(pixels[i], 255);
    assert.deepEqual(await sharp(fs.readFileSync(store.assetPath(d.id, im.url))).ensureAlpha().raw().toBuffer(), approved);
    const psdBytes = await exportPsd(d.id, im), psd = readPsd(psdBytes, { useImageData: true });
    assert.deepEqual([psd.children![0].left, psd.children![0].top, psd.children![0].right, psd.children![0].bottom], [0, 0, size.width, size.height]);
    assert.deepEqual(Buffer.from(psd.children![0].imageData!.data), pixels);
    assert.deepEqual(Buffer.from(psd.imageData!.data), approved);
    const evidencePrefix = path.join(process.env.LAYER_CANVAS_DATA!, `background-rounding-${horizontal ? 'horizontal' : 'vertical'}`);
    const finalPng = fs.readFileSync(store.assetPath(d.id, im.url));
    fs.writeFileSync(evidencePrefix + '.psd', psdBytes);
    fs.writeFileSync(evidencePrefix + '.png', finalPng);
    fs.writeFileSync(evidencePrefix + '-evidence.json', JSON.stringify({
      fixture: 'Isolated deterministic geometry regression; not a complex-poster visual acceptance sample',
      originalSize: r.originalSize, workingSize: r.workingSize, frame: r.frame,
      placementFrame: r.placementFrame, backgroundPadding: r.backgroundPadding, backgroundOpacity: r.backgroundOpacity,
      adaptation: layer.generationAdaptation, alphaRange: [255, 255], transparentEdgePixels: 0,
      pixelDifference: { expectedUniformResizeAndCopiedEdge: 0, reviewedComposite: 0, finalPNG: 0, psdLayer: 0, psdMerged: 0 },
      originalSHA256: crypto.createHash('sha256').update(originalBytes).digest('hex'),
      finalPNGSHA256: crypto.createHash('sha256').update(finalPng).digest('hex'),
      finalPSDSHA256: crypto.createHash('sha256').update(psdBytes).digest('hex'),
    }, null, 2));
  }
});

test('background native ratio gaps remain visible and cannot be accepted as integer rounding', async () => {
  for (const height of [1140, 1144]) {
    const { j, layout } = await fixture(false, 'layer', true, { width: 1200, height: 1000 });
    await generationAction(j, { action: 'layout', layout });
    const p: any = await prep(j, layout);
    const r: any = await generationAction(j, {
      action: 'register', requestId: p.id, path: await file(1374, height),
      prompt: p.prompt, referencePaths: p.referencePaths,
    });
    assert.equal(r.backgroundPadding, undefined);
    assert.match(r.isolationProblem, /背景.*未铺满/);
    if (height === 1140) assert(r.placementFrame.height < r.frame.height);
    else assert.equal(r.placementFrame.height, r.frame.height, 'working rounding must not conceal a native one-pixel ratio gap');
    await assert.rejects(() => review(j, r, '背景'), /不能标为通过/);
  }
});

test('background rounding never copies transparent or weak alpha pixels into a gap', async () => {
  const { j, layout } = await fixture(false, 'layer', true, { width: 1200, height: 1000 });
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout);
  const r: any = await generationAction(j, {
    action: 'register', requestId: p.id, path: await file(1374, 1145, true),
    prompt: p.prompt, referencePaths: p.referencePaths,
  });
  assert.equal(r.backgroundPadding, undefined);
  assert.equal(r.placementFrame.width, 1199);
  assert.match(r.isolationProblem, /背景仍有透明空洞/);
  await assert.rejects(() => review(j, r, '背景'), /不能标为通过/);
});

test('native sparse weak alpha erased by the budget resize still rejects background padding and acceptance', async () => {
  const { j, layout } = await fixture(false, 'layer', true, { width: 1200, height: 1000 });
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout);
  const data = Buffer.alloc(6000 * 5000 * 4).fill(Buffer.from([128, 128, 128, 255]));
  data[(2500 * 6000 + 3000) * 4 + 3] = 254;
  const original = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  await sharp(data, { raw: { width: 6000, height: 5000, channels: 4 } }).png().toFile(original);
  const originalBytes = fs.readFileSync(original);
  assert.equal((await sharp(originalBytes).stats()).channels[3].min, 254);
  const r: any = await generationAction(j, {
    action: 'register', requestId: p.id, path: original, prompt: p.prompt, referencePaths: p.referencePaths,
  });
  assert.deepEqual(r.workingSize, { width: 1341, height: 1118 });
  assert.equal((await sharp(fs.readFileSync(r.workingPath)).stats()).channels[3].min, 255,
    'the counterexample must actually lose its sparse weak alpha during the budget resize');
  assert.equal(r.backgroundPadding, undefined);
  assert.equal(r.placementFrame.width, 1199);
  assert.equal(r.backgroundOpacity.minAlpha, 254);
  assert.equal(r.backgroundOpacity.opaqueAlpha, 255);
  assert.equal(r.backgroundOpacity.sourceHash, r.hash);
  assert.match(r.isolationProblem, /背景原件.*透明/);
  await assert.rejects(() => review(j, r, '背景'), /不能标为通过/);
  assert.deepEqual(fs.readFileSync(original), originalBytes);
  assert.deepEqual(fs.readFileSync(r.originalPath), originalBytes);
  fs.writeFileSync(path.join(process.env.LAYER_CANVAS_DATA!, 'native-alpha-boundary-evidence.json'), JSON.stringify({
    originalSize: r.originalSize, workingSize: r.workingSize, nativeAlphaMin: 254, workingAlphaMin: 255,
    backgroundOpacity: r.backgroundOpacity, backgroundPadding: r.backgroundPadding || null,
    placementFrame: r.placementFrame, isolationProblem: r.isolationProblem, reviewAcceptedRejected: true,
    originalBytesUnchanged: true,
  }, null, 2));
});

test('native 16-bit weak alpha cannot be erased by conversion to an opaque budget image', async () => {
  const { j, layout } = await fixture(false, 'layer', true, { width: 1200, height: 1000 });
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout);
  const native = { width: 1374, height: 1145 };
  const data = new Uint16Array(native.width * native.height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([32768, 32768, 32768, 65535], i);
  data[(572 * native.width + 687) * 4 + 3] = 65534;
  const original = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  await sharp(data, { raw: { ...native, channels: 4 } }).toColourspace('rgb16').png().toFile(original);
  const bytes = fs.readFileSync(original);
  assert.equal((await sharp(bytes).metadata()).depth, 'ushort');
  assert.equal((await sharp(bytes).stats()).channels[3].min, 65534);
  const r: any = await generationAction(j, {
    action: 'register', requestId: p.id, path: original, prompt: p.prompt, referencePaths: p.referencePaths,
  });
  assert.equal((await sharp(fs.readFileSync(r.workingPath)).stats()).channels[3].min, 255);
  assert.deepEqual(r.backgroundOpacity, { version: 1, sourceHash: r.hash, minAlpha: 65534, opaqueAlpha: 65535 });
  assert.equal(r.backgroundPadding, undefined);
  assert.match(r.isolationProblem, /背景原件.*透明/);
  await assert.rejects(() => review(j, r, '背景'), /不能标为通过/);
  assert.deepEqual(fs.readFileSync(r.originalPath), bytes);
});

test('old accepted padding caches require native opacity proof and retain original and working hash guards', async () => {
  const { j, d, layout } = await fixture(false, 'layer', true, { width: 1200, height: 1000 });
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout);
  const r: any = await generationAction(j, {
    action: 'register', requestId: p.id, path: await file(1374, 1145),
    prompt: p.prompt, referencePaths: p.referencePaths,
  });
  await review(j, r, '背景');
  await compositeReview(j, [r]);
  const payload = { taskId: j.taskId, baseVersion: j.version, layers: [{
    id: r.sourceLayerIds[0], name: '背景', ...r.frame, path: r.originalPath, generationId: r.id,
  }] };
  for (const filePath of [r.originalPath, r.workingPath]) {
    const bytes = fs.readFileSync(filePath), changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    fs.writeFileSync(filePath, changed);
    await assert.rejects(() => generationAction(j, { action: 'composite', generationIds: [r.id] }), /生成原文件已变化/);
    const rejected = await api(`/api/jobs/${j.id}/apply`, payload, 500);
    assert.match(rejected.error, /生成原文件已变化/);
    fs.writeFileSync(filePath, bytes);
    assert.equal(store.load(d.id).images.length, 1);
  }
  const { compositeSignature } = await import('../server/generation-workflow.js');
  const registryPath = path.join(path.dirname(path.dirname(r.originalPath)), 'registry.json');
  const trustedState = generationState(j);
  for (const invalidProof of [undefined, { ...r.backgroundOpacity, sourceHash: 'unbound-native-hash' }]) {
    const state = structuredClone(trustedState);
    state.outputs[0].backgroundOpacity = invalidProof;
    // Emulate an old accepted cache with still-valid evidence hashes and an
    // otherwise-current signature. A cached accepted status is not a proof.
    state.composite!.signature = compositeSignature(j, state.outputs, state);
    fs.writeFileSync(registryPath, JSON.stringify(state));
    await assert.rejects(() => generationAction(j, { action: 'composite', generationIds: [r.id] }), /背景补边.*完全不透明/);
    await assert.rejects(() => generationAction(j, {
      ...trustedState.composite!.review, action: 'review-composite', comparisonHash: trustedState.composite!.comparisonHash,
    }), /背景补边.*完全不透明/);
    const rejected = await api(`/api/jobs/${j.id}/apply`, payload, 500);
    assert.match(rejected.error, /背景补边.*完全不透明/);
    assert.equal(store.load(d.id).images.length, 1);
    assert.equal(store.getJob(j.id).status, 'running');
  }
  fs.writeFileSync(registryPath, JSON.stringify(trustedState));
  const done = await api(`/api/jobs/${j.id}/apply`, payload);
  assert.equal(done.document.images.length, 2, 'unchanged originals with valid native opacity proof still complete');
  fs.writeFileSync(path.join(process.env.LAYER_CANVAS_DATA!, 'old-padding-cache-evidence.json'), JSON.stringify({
    missingProofRejected: true, unboundProofRejected: true,
    guardedActions: ['composite', 'review-composite', 'apply'], originalHashGuard: true, workingHashGuard: true,
    rejectedApplicationsCreatedNodes: 0, validApplicationCreatedNodes: 1, backgroundOpacity: r.backgroundOpacity,
  }, null, 2));
});

test('独立层准备不被其他层审核锁住；最终合成关联错误必须落实到红色问题层', async () => {
  const { j, layout } = await fixture(true);
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout),
    r: any = await reg(j, p);
  await assert.doesNotReject(() => prep(j, layout, 1));
  await assert.doesNotReject(() => review(j, r, '标题', 'needs-revision'));
  await assert.rejects(
    () => review(j, r, '标题', 'needs-revision', [r.id, 'invented-candidate']),
    /candidateIds/,
  );
  const retry: any = await reg(j, p, 901, 300);
  await review(j, retry, '标题', 'needs-revision', [r.id, retry.id]);
  await assert.doesNotReject(() => prep(j, layout, 1));
  await generationAction(j, { action: 'composite', generationIds: [retry.id] });
  const p2: any = await prep(j, layout, 1),
    r2: any = await reg(j, p2, 600, 240);
  await review(j, r2, '底座');
  const c: any = await generationAction(j, {
    action: 'composite',
    generationIds: [retry.id, r2.id],
  });
  await assert.rejects(
    () =>
      generationAction(j, {
        action: 'review-composite',
        comparisonHash: c.comparisonHash,
        layers: [retry, r2].map((r) => ({
          generationId: r.id,
          status: 'matched',
          observation: '实际检查所有图层最终位置并查看了相互接触关系',
        })),
      }),
    /接触/,
  );
  await compositeReview(
    j,
    [retry, r2],
    [
      {
        id: 'contact',
        status: 'different',
        observation: '标题右端仍比原图窄，底座位置正确，标题已标红待处理',
      },
    ],
  );
  const result = await api(`/api/jobs/${j.id}/apply`, {
    taskId: j.taskId,
    baseVersion: j.version,
    layers: [retry, r2].map((r, i) => ({
      id: j.snapshot.layers[i].id,
      name: j.snapshot.layers[i].name,
      ...r.frame,
      path: r.originalPath,
      generationId: r.id,
    })),
  });
  assert.equal(result.document.images.at(-1).layers[0].disposition, 'rebuild');
  assert.equal(result.document.images.at(-1).layers[1].disposition, 'keep');
});

test('最终合成含原尺寸细节，重复检查复用文件与审核；真实素材变动不得沿用审批', async () => {
  const { j, layout } = await fixture();
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout),
    r: any = await reg(j, p);
  assert(!p.prompt.includes('其他层已拥有的元素'));
  assert(!p.prompt.includes('冻结标注'));
  await review(j, r, '标题');
  await generationAction(j, {
    action: 'composite',
    generationIds: [r.id],
    detailGenerationIds: [r.id],
  });
  const c = await compositeReview(j, [r]);
  assert.equal(c.details.length, 1);
  const metadata = await sharp(fs.readFileSync(c.details[0].result.path)).metadata();
  assert.equal(metadata.width, r.frame.width);
  assert.equal(metadata.height, r.frame.height);
  const reused: any = await generationAction(j, { action: 'composite', generationIds: [r.id] });
  assert.equal(reused.path, c.path);
  assert(generationState(j).composite?.review);
  const { requireCompositeApproval } = await import('../server/generation-workflow.js');
  requireCompositeApproval(j, [r.id], generationState(j));
  fs.appendFileSync(r.workingPath, 'unexpected-modification');
  assert.throws(() => requireCompositeApproval(j, [r.id], generationState(j)), /素材已改变/);
});

test('自动特征定位应用真实测量、绑定文件哈希且不冒称视觉通过；低纹理保持原候选', async (t) => {
  const { pythonPath } = await import('../server/models.js');
  if (!pythonPath()) {
    t.skip('本地可选Python未安装');
    return;
  }
  const { j, layout } = await fixture();
  const frame = { x: 0, y: 0, width: 300, height: 180 };
  j.snapshot.layers[0].frame = frame;
  layout.layers[0].anchors = [];
  const pixels = Buffer.alloc(300 * 180 * 4);
  let seed = 81;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed >>> 24;
  };
  // Distributed textured object with an alpha border, not a preview cutout.
  for (let y = 10; y < 170; y++)
    for (let x = 10; x < 290; x++) {
      const value = random();
      pixels.set([value, value, value, 255], (y * 300 + x) * 4);
    }
  const source = await sharp(pixels, { raw: { width: 300, height: 180, channels: 4 } })
    .blur(0.7)
    .png()
    .toBuffer();
  fs.writeFileSync(
    store.assetPath(j.documentId, j.snapshot.source),
    await sharp(source).flatten({ background: '#808080' }).png().toBuffer(),
  );
  const enlargedLayout = { ...layout, width: 600, height: 360 };
  await generationAction(j, { action: 'layout', layout: enlargedLayout });
  const p: any = await prep(j, enlargedLayout);
  const file = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  fs.writeFileSync(
    file,
    await sharp(source)
      .resize(450, 270)
      .extend({
        left: 20,
        right: 20,
        top: 12,
        bottom: 12,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer(),
  );
  const r: any = await generationAction(j, {
    action: 'register',
    requestId: p.id,
    path: file,
    prompt: p.prompt,
    referencePaths: p.referencePaths,
  });
  const aligned: any = await generationAction(j, { action: 'auto-align', generationId: r.id });
  if (aligned.available === false) {
    t.skip(aligned.reason);
    return;
  }
  assert(aligned.applied, JSON.stringify(aligned.reason || aligned.proposal));
  assert(Math.abs(aligned.alignment.transform.scale - 4 / 3) < 0.01);
  assert(Math.abs(aligned.placementFrame.x + 27) <= 1);
  assert(Math.abs(aligned.placementFrame.y + 16) <= 1);
  assert.equal(aligned.autoAlignment.referenceToFrameScale, 2);
  assert.equal(aligned.autoAlignment.sourceHash, r.hash);
  assert.equal(aligned.isolationPreviews.workingHash, aligned.workingHash);
  assert.notEqual(aligned.isolationPreviews.dark.path, r.isolationPreviews.dark.path);
  assert(fs.existsSync(aligned.autoAlignment.evidencePath));
  assert.equal(aligned.review, undefined);
  assert.equal(generationState(j).composite, undefined);
  const plain: any = await reg(j, p, 600, 360);
  const declined: any = await generationAction(j, { action: 'auto-align', generationId: plain.id });
  assert.equal(declined.applied, false);
  assert.equal(declined.record.workingPath, plain.workingPath);
  assert.equal(declined.record.comparisonHash, plain.comparisonHash);
});

test('v4 HTTP independent model references default to local carrier; explicit context and legacy remain global', async (t) => {
  for (const type of ['layer', 'photoshop'] as const) await t.test(type, async () => {
    const { j, layout } = await prepareAnchorFixture(type, undefined, 1, [40, 30, 200, 100]);
    const body = { taskId: j.taskId, action: 'prepare', sourceLayerIds: layout.layers[0].sourceLayerIds,
      purpose: '只分离冻结局部中的既有对象，不能从整图重排构图', elements: layout.layers[0].elements,
      referenceObservation: '实际源局部用于识别归属，接口夹具不声称已通过真实模型验证', promptStyle: 'concise-edit' };
    const local = await api(`/api/jobs/${j.id}/generation`, body);
    assert.equal(local.referenceStrategy, 'local-only');
    assert.deepEqual(local.referencePaths, [local.localPath]);
    assert.match(local.prompt, /局部就是完整输出画幅/);
    assert(local.referencePaths.every((p: string) => p.includes(`${path.sep}references${path.sep}`)));
    const global = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceStrategy: 'local-and-global' });
    assert.equal(global.referenceStrategy, 'local-and-global');
    assert(global.referencePaths.length > local.referencePaths.length);
    await assert.rejects(() => generationAction(j, { action: 'register', requestId: local.id,
      path: 'unused.png', prompt: local.prompt, referencePaths: global.referencePaths }), /参考图与本层准备/);
    const frozen = generationState(j).requests.find(q => q.id === local.id)!;
    assert.deepEqual(frozen.referencePaths, local.referencePaths);
    delete j.reconstructionWorkflowVersion; store.saveJob(j);
    const legacy = await api(`/api/jobs/${j.id}/generation`, body);
    assert.equal(legacy.referenceStrategy, 'local-and-global');
    assert(legacy.referencePaths.length > local.referencePaths.length);
  });
});

test('精简编辑实验提示保留150万、来源归属与用户意见，不堆定位观察长文或其他层描述', async () => {
  const { j, layout } = await fixture();
  j.snapshot.opinion = '保持已确认的人物颜色';
  j.snapshot.layers[0].opinion = '标题左上角不要增加浮雕';
  await generationAction(j, { action: 'layout', layout });
  const standard: any = await prep(j, layout);
  const concise: any = await generationAction(j, {
    action: 'prepare',
    sourceLayerIds: layout.layers[0].sourceLayerIds,
    purpose: '只分离当前标题',
    elements: layout.layers[0].elements,
    referenceObservation: '这是用于归属理解的观察，不是要求重画的长描述',
    promptStyle: 'concise-edit',
    referenceStrategy: 'local-only',
  });
  assert.equal(concise.promptStyle, 'concise-edit');
  assert.equal(concise.referenceStrategy, 'local-only');
  assert(concise.prompt.length < standard.prompt.length);
  assert.match(concise.prompt, /1500000/);
  assert.match(concise.prompt, /保持已确认的人物颜色/);
  assert.match(concise.prompt, /标题左上角不要增加浮雕/);
  assert.match(concise.prompt, /其他层对象|其余层的物体/);
  assert.match(concise.prompt, /这是用于归属理解的观察，不是要求重画的长描述/);
  assert(!concise.prompt.includes('generationPoint'));
  assert(concise.prompt.includes('positionPercent'));
  assert(concise.referencePaths.length > 0);
  assert(
    concise.referencePaths.every((p: string) => p.includes(`${path.sep}references${path.sep}`)),
  );
  await assert.rejects(
    () =>
      generationAction(j, {
        action: 'register',
        requestId: concise.id,
        path: 'unused.png',
        prompt: concise.prompt,
        referencePaths: standard.referencePaths,
      }),
    /参考图与本层准备/,
  );
});

test('concise prepare HTTP carries frozen visual anchor positions in the actual full reference canvas', async (t) => {
  for (const type of ['layer', 'photoshop'] as const) for (const scale of [1, 2]) await t.test(`${type} x${scale}`, async () => {
    const anchors = [
      { name: 'source-left', point: [60 * scale, 50 * scale], observation: '实际源左特征，不传长观察去重画' },
      { name: 'source-right', point: [220 * scale, 50 * scale], observation: '实际源右特征' },
    ];
    const { j, layout } = await prepareAnchorFixture(type, anchors, scale);
    const before = structuredClone(generationState(j).requests);
    const p = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'prepare',
      sourceLayerIds: layout.layers[0].sourceLayerIds, purpose: '真实参考位置约束回归',
      elements: layout.layers[0].elements, referenceObservation: '源特征指认',
      promptStyle: 'concise-edit', referenceStrategy: 'local-only',
      anchors: [{ name: 'conflicting-input', point: [100 * scale, 50 * scale], observation: '不得覆盖冻结目标' }] });
    assert.deepEqual(p.anchors, anchors);
    assert(p.carrier.expanded);
    assert(p.prompt.includes(JSON.stringify([
      { name: 'source-left', positionPercent: [10, scale === 1 ? 49.25 : 50] },
      { name: 'source-right', positionPercent: [90, scale === 1 ? 49.25 : 50] },
    ])));
    assert(!p.prompt.includes('conflicting-input'));
    assert(!p.prompt.includes('实际源左特征，不传长观察去重画'));
    assert.equal(p.referencePaths.length, 2, 'padded first reference and unchanged clean local detail');
    const metadata = await sharp(fs.readFileSync(p.referencePaths[0])).metadata();
    assert.deepEqual([metadata.width, metadata.height], [p.generation.size.width, p.generation.size.height]);
    assert.deepEqual(generationState(j).requests.slice(0, before.length), before, 'existing prepared requests unchanged');
  });
  const { j, layout } = await prepareAnchorFixture('layer', []);
  const p = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'prepare',
    sourceLayerIds: layout.layers[0].sourceLayerIds, purpose: '无源定位观察不虚构',
    elements: layout.layers[0].elements, referenceObservation: '未提供定位点', promptStyle: 'concise-edit' });
  assert(!p.prompt.includes('positionPercent'));
  assert.deepEqual(p.anchors, []);
});

test('concise no-local fallback does not label carrier coordinates as positions in its first global reference', async () => {
  const anchors = [
    { name: 'outside-left', point: [330, 50], observation: '接口边界夹具，不声称源图中可见' },
    { name: 'outside-right', point: [410, 50], observation: '接口边界夹具，不声称源图中可见' },
  ];
  const { j, layout } = await prepareAnchorFixture('photoshop', anchors, 1, [320, 30, 100, 40]);
  const ps = await import('../server/photoshop-rebuild.js');
  const plan = structuredClone(ps.photoshopState(j).plan!);
  const p = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'prepare',
    sourceLayerIds: layout.layers[0].sourceLayerIds, purpose: '无真实局部参考的合法接口边界',
    elements: layout.layers[0].elements, referenceObservation: '仅完整源图可用，不虚构局部',
    promptStyle: 'concise-edit', referenceStrategy: 'local-and-global' });
  assert.equal(p.localPath, undefined);
  assert.equal(p.referencePaths.length, 1);
  const metadata = await sharp(fs.readFileSync(p.referencePaths[0])).metadata();
  assert.deepEqual([metadata.width, metadata.height], [300, 180]);
  assert(!p.prompt.includes('positionPercent'));
  assert.match(p.prompt, /没有精确局部参考/);
  assert.deepEqual(p.anchors, anchors);
  assert.deepEqual(ps.photoshopState(j).plan, plan, 'fallback must not relocate frozen targets');
});

test('strict and concise generation prompts use the same file-local scoped marks and keep frozen canvas annotations unchanged', async () => {
  const { j, layout } = await fixture(true);
  const target = j.snapshot.layers[0].id;
  const coverageRelation = { id: 'coverage', layerIds: [target, j.snapshot.layers[1].id],
    kind: 'occlusion', observation: '前景遮挡后方对象', point: [60, 50] };
  layout.relations = [coverageRelation];
  j.snapshot.annotations = [
    {
      id: 'selected-arrow',
      layerId: target,
      type: 'arrow',
      points: [-40, 5, 60, 50],
      text: '此笔画不要加阴影',
      color: '#00ff00',
    },
    {
      id: 'global-selection',
      layerId: null,
      type: 'pen',
      points: [80, 42, 90, 48],
      text: '保留这些边缘',
      brushSize: 14,
      color: '#ff00ff',
    },
    {
      id: 'other-layer',
      layerId: j.snapshot.layers[1].id,
      type: 'text',
      points: [120, 110],
      text: '不要传入当前层的意见',
      color: '#0000ff',
    },
  ];
  const frozen = JSON.stringify(j.snapshot.annotations);
  await generationAction(j, { action: 'layout', layout });
  for (const promptStyle of ['structured', 'concise-edit'] as const) {
    const r: any = await generationAction(j, {
      action: 'prepare',
      sourceLayerIds: [target],
      purpose: '仅隔离现有标题',
      elements: layout.layers[0].elements,
      referenceObservation: '左笔画边缘保持原有形状',
      promptStyle,
      referenceStrategy: 'local-only',
    });
    const { generationAnnotations } = await import('../shared/generation-annotations.js');
    const mapped = generationAnnotations(
      j.snapshot.annotations.slice(0, 2),
      j.snapshot,
      r.canvas,
      r.carrier,
    );
    assert(r.prompt.includes(JSON.stringify(mapped)));
    assert(!r.prompt.includes('不要传入当前层的意见'));
    assert(!r.prompt.includes('#00ff00'));
    assert(r.prompt.includes('左笔画边缘保持原有形状'));
    assert(r.prompt.includes('执行说明（隔离与纠错）：仅隔离现有标题'));
    assert(r.prompt.includes('执行说明不是新增用户改图授权'));
    assert(r.prompt.includes('仅保留属于本层的固有外观'));
    assert(r.prompt.includes('材质、颜色、明暗、纹理和形变按参考'));
    assert(r.prompt.includes('不增亮或新增光泽，也不抹掉原有光泽'));
    assert(!r.prompt.includes('固有外观：细亮边、反射、渐变、柔光'));
    assert(!r.prompt.includes('只移除候选比参考多出的部分'));
    const relationX = (60 - r.carrier.frame.x) * r.carrier.scale + r.carrier.offsetX;
    const relationY = (50 - r.carrier.frame.y) * r.carrier.scale + r.carrier.offsetY;
    assert(r.prompt.includes(`关系参考点(${relationX},${relationY})`));
    assert(r.prompt.includes('不能在可见遮挡边界提前截断'));
    assert(mapped.marks[0].points[0] < 0);
    assert.equal(JSON.stringify(j.snapshot.annotations), frozen);
  }
});

test('registration exposes immutable native-size isolated deep/light previews without substituting preview pixels for the generation', async () => {
  const { j, layout } = await fixture();
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout);
  const input = await file(200, 70, true);
  const bytes = fs.readFileSync(input);
  const r: any = await generationAction(j, {
    action: 'register',
    requestId: p.id,
    path: input,
    prompt: p.prompt,
    referencePaths: p.referencePaths,
  });
  assert.equal(r.isolationPreviews.surface, 'normal');
  assert.equal(r.isolationPreviews.workingHash, r.workingHash);
  for (const [tone, rgb] of [
    ['dark', [16, 16, 20]],
    ['light', [238, 238, 238]],
  ] as const) {
    const preview = r.isolationPreviews[tone];
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(preview.path)).digest('hex'),
      preview.hash,
    );
    const { data, info } = await sharp(fs.readFileSync(preview.path))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height], [200, 70]);
    assert.deepEqual([...data.subarray(0, 4)], [...rgb, 255]);
    const center = (35 * info.width + 100) * 4;
    assert.deepEqual([...data.subarray(center, center + 4)], [235, 70, 45, 255]);
  }
  assert.deepEqual(fs.readFileSync(input), bytes);
  assert.deepEqual(fs.readFileSync(r.originalPath), bytes);
  const { registeredGeneration } = await import('../server/generation.js');
  assert.throws(
    () =>
      registeredGeneration(
        j,
        r.id,
        r.sourceLayerIds,
        r.frame,
        fs.readFileSync(r.isolationPreviews.light.path),
      ),
    /生成原文件已变化/,
  );
  fs.appendFileSync(r.isolationPreviews.dark.path, 'mutated evidence');
  assert.throws(() => registeredGeneration(j, r.id, r.sourceLayerIds, r.frame), /深浅底证据已变化/);
});

test('PS黑底滤色生成参数一致；新素材先合成核对，不提前调用超分', async () => {
  const { j } = await fixture(false, 'photoshop');
  const ps = await import('../server/photoshop-rebuild.js');
  const { AdobeConnector } = await import('../server/adobe.js');
  const adobe = new AdobeConnector(process.cwd(), process.env.LAYER_CANVAS_DATA!);
  try {
    const l = j.snapshot.layers[0];
    await ps.photoshopAction(
      j,
      {
        action: 'plan',
        plan: {
          layers: [
            {
              layerId: l.id,
              name: l.name,
              frame: l.frame,
              route: 'generate',
              content: 'light',
              surface: 'screen',
              rationale: '黑底滤色光束',
              includes: '光线',
              excludes: '背景主体',
              compositing: 'screen，PS不重复添加同样光效',
              editable: 'pixels',
              elements: ['独立光束'],
            },
          ],
        },
      },
      adobe,
    );
    const plan = ps.photoshopState(j).plan!;
    const p: any = await generationAction(
      j,
      {
        action: 'prepare',
        sourceLayerIds: [l.id],
        purpose: '生成独立光效',
        elements: ['独立光束'],
        referenceObservation: '局部只有暖色光线，周围黑色用于滤色',
      },
      plan,
    );
    assert.equal(p.transparent_background, false);
    assert.match(p.prompt, /纯黑底/);
    // Full opaque RGB is valid for screen; separation quality remains PS visual review.
    const r: any = await generationAction(
      j,
      {
        action: 'register',
        requestId: p.id,
        path: await file(100, 20),
        prompt: p.prompt,
        referencePaths: p.referencePaths,
      },
      plan,
    );
    assert.equal(r.isolationProblem, undefined);
    assert.equal(r.isolationPreviews.surface, 'screen');
    const screenLight = await sharp(fs.readFileSync(r.isolationPreviews.light.path))
      .removeAlpha()
      .raw()
      .toBuffer();
    assert(
      screenLight[0] > 238 && screenLight[1] > 238 && screenLight[2] > 238,
      'screen evidence must display additive contribution instead of an opaque dark rectangle',
    );
    // Test scheduling with an isolated foreground rather than bypassing screen black checks.
    const dir = ps.photoshopFolder(j),
      f = await file(100, 20, true);
    const registered: any = await generationAction(j, {
      action: 'register', requestId: p.id, path: f, prompt: p.prompt, referencePaths: p.referencePaths,
    }, plan);
    store.atomic(path.join(dir, 'photoshop-rebuild.json'), {
      version: 2,
      plan,
      materials: {
        [l.id]: {
          path: registered.originalPath,
          hash: registered.hash,
          generationId: registered.id,
          originalPath: registered.originalPath,
          workingPath: registered.workingPath,
          originalSize: registered.originalSize,
          workingSize: registered.workingSize,
          status: 'processing',
          provenance: 'generated',
        },
      },
      reviews: {},
    });
    let calls = 0;
    await ps.processPhotoshopMaterial(j, l.id, new AbortController().signal, async () => {
      calls++;
      throw Error('should not execute');
    });
    assert.equal(calls, 0);
    assert.equal(ps.photoshopState(j).materials[l.id].needsUpscale, true);
    await assert.rejects(
      () => ps.photoshopAction(j, { action: 'upscale-material', layerId: l.id }, adobe),
      /先以原工作图/,
    );
  } finally {
    await adobe.close();
  }
});

test('相同复审可安全重试；复审结论变化使整图审批失效', async () => {
  const { j, layout } = await fixture();
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout),
    r: any = await reg(j, p);
  await review(j, r, '标题');
  await compositeReview(j, [r]);
  assert(generationState(j).composite?.review);
  await review(j, r, '标题');
  assert(generationState(j).composite?.review);
  await review(j, r, '标题', 'needs-revision');
  assert.equal(generationState(j).composite?.review, undefined);
});

test('v4合并加整图等比放大完成回传，框并集与来源映射保留', async () => {
  const { j } = await fixture(true),
    ids = j.snapshot.layers.map((l) => l.id);
  const layout = {
    width: 600,
    height: 360,
    layers: [{ sourceLayerIds: ids, elements: ['标题及底座'], excludes: '原背景', anchors: [] }],
    relations: [],
  };
  await assert.rejects(
    () => generationAction(j, { action: 'layout', layout: { ...layout, height: 400 } }),
    /等比例/,
  );
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout);
  assert.deepEqual(p.frame, { x: 80, y: 60, width: 400, height: 240 });
  const r: any = await reg(j, p, 1000, 600);
  await review(j, r, '标题及底座');
  await compositeReview(j, [r]);
  const done = await api(`/api/jobs/${j.id}/apply`, {
    taskId: j.taskId,
    baseVersion: j.version,
    width: 600,
    height: 360,
    layers: [
      {
        id: ids[0],
        sourceLayerIds: ids,
        name: '合并',
        ...p.frame,
        path: r.originalPath,
        generationId: r.id,
      },
    ],
  });
  const im = done.document.images.at(-1);
  assert.equal(im.width, 600);
  assert.equal(im.layers.length, 1);
  assert.deepEqual(im.layers[0].sourceLayerIds, ids);
  assert.deepEqual(im.layers[0].frame, p.frame);
});

test('PS透明狭长承载参考通过真实素材校验，保留独立放置范围', async () => {
  const { j } = await fixture(false, 'photoshop');
  const ps = await import('../server/photoshop-rebuild.js'),
    { AdobeConnector } = await import('../server/adobe.js');
  const adobe = new AdobeConnector(process.cwd(), process.env.LAYER_CANVAS_DATA!);
  try {
    const l = j.snapshot.layers[0];
    await ps.photoshopAction(
      j,
      {
        action: 'plan',
        plan: {
          layers: [
            {
              layerId: l.id,
              name: l.name,
              frame: l.frame,
              route: 'generate',
              content: 'bitmap',
              surface: 'transparent',
              rationale: '细长透明物体',
              includes: '红色条形物体',
              excludes: '背景与文字',
              compositing: 'normal',
              editable: 'pixels',
              elements: ['红色条形物体'],
            },
          ],
        },
      },
      adobe,
    );
    const plan = ps.photoshopState(j).plan!;
    const p: any = await generationAction(
      j,
      {
        action: 'prepare',
        sourceLayerIds: [l.id],
        purpose: '生成单层',
        elements: ['红色条形物体'],
        referenceObservation: '红色条形物体位于框中央，外部透明',
      },
      plan,
    );
    assert(p.carrier.expanded);
    const r: any = await reg(j, p);
    await ps.beginPhotoshopMaterial(j, {
      action: 'material',
      layerId: l.id,
      path: r.originalPath,
      generationId: r.id,
      provenance: 'generated',
      observation: '读取实际完整透明文件，不采用矩形裁片',
      allowAspectFit: false,
      evidence: {
        generation: {
          tool: 'image_gen',
          outputPath: r.originalPath,
          prompt: p.prompt,
          referencePaths: p.referencePaths,
        },
      },
    });
    await ps.processPhotoshopMaterial(j, l.id, new AbortController().signal);
    const m = ps.photoshopState(j).materials[l.id];
    assert.deepEqual(m.placementFrame, r.placementFrame);
    assert(m.placementFrame!.height > l.frame!.height);
  } finally {
    await adobe.close();
  }
});

test('多个已通过素材可连续排入超分，不因首个任务失效全局预览而重复审核', async () => {
  const { j } = await fixture(true, 'photoshop'),
    ps = await import('../server/photoshop-rebuild.js');
  const { AdobeConnector } = await import('../server/adobe.js');
  const adobe = new AdobeConnector(process.cwd(), process.env.LAYER_CANVAS_DATA!);
  try {
    await ps.photoshopAction(
      j,
      {
        action: 'plan',
        plan: {
          layers: j.snapshot.layers.map((l) => ({
            layerId: l.id,
            name: l.name,
            frame: l.frame,
            route: 'generate',
            content: 'bitmap',
            surface: 'transparent',
            rationale: '透明素材',
            includes: l.name,
            excludes: '其他层',
            compositing: 'normal',
            editable: 'pixels',
            elements: [l.name],
          })),
        },
      },
      adobe,
    );
    // Persisted review fixture: both approvals refer to the same immutable prior render.
    const s = ps.photoshopState(j),
      p = await file(40, 20, true),
      hash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    for (const l of j.snapshot.layers) {
      const prepared: any = await generationAction(j, {
        action: 'prepare', sourceLayerIds: [l.id], purpose: '按冻结框生成独立透明素材供调度回归',
        elements: [l.name], referenceObservation: '此隔离夹具检查对应来源层透明区域和预算工作文件',
      }, s.plan);
      const registered: any = await generationAction(j, {
        action: 'register', requestId: prepared.id,
        path: await file(l.frame!.width / 5, l.frame!.height / 5, true),
        prompt: prepared.prompt, referencePaths: prepared.referencePaths,
      }, s.plan);
      s.materials[l.id] = {
        path: registered.originalPath,
        hash: registered.hash,
        generationId: registered.id,
        originalPath: registered.originalPath,
        workingPath: registered.workingPath,
        originalSize: registered.originalSize,
        workingSize: registered.workingSize,
        status: 'ready',
        provenance: 'generated',
        observation: '已审核工作图',
        needsUpscale: true,
        upscaleEvidence: { workingHash: registered.workingHash, psdPath: p, psdHash: hash },
      };
    }
    store.atomic(path.join(ps.photoshopFolder(j), 'photoshop-rebuild.json'), s);
    for (const l of j.snapshot.layers)
      assert.equal(
        ((await ps.photoshopAction(j, { action: 'upscale-material', layerId: l.id }, adobe)) as any)
          .status,
        'processing',
      );
    assert(Object.values(ps.photoshopState(j).materials).every((m) => m.upscaleApproved));
  } finally {
    await adobe.close();
  }
});

test('screen carrier packages horizontal and vertical light without changing frozen artwork coordinates', () => {
  for (const frame of [
    { x: 0, y: 0, width: 610, height: 160 },
    { x: 7, y: 20, width: 160, height: 610 },
  ]) {
    const c = generationCarrier(frame, true, 2.5);
    assert(c.expanded);
    assert(Math.max(c.frame.width / c.frame.height, c.frame.height / c.frame.width) <= 2.5);
    assert.equal(c.frame.x + c.artwork.x, frame.x);
    assert.equal(c.frame.y + c.artwork.y, frame.y);
    assert.deepEqual([c.artwork.width, c.artwork.height], [frame.width, frame.height]);
    assert(c.size.width * c.size.height <= 1_500_000);
  }
  assert.deepEqual(generationCarrier({ x: 0, y: 0, width: 610, height: 160 }, true, 2.5).frame,
    { x: 0, y: -42, width: 610, height: 244 });
  const square = { x: 0, y: 0, width: 200, height: 200 };
  assert.deepEqual(generationCarrier(square, true, 2.5).frame, square);
});

test('ordinary and PS screen prepare use black neutral padding and register restores the full carrier', async () => {
  for (const type of ['layer', 'photoshop']) {
    const { j, layout } = await fixture(false, type);
    const entry = layout.layers[0] as any;
    entry.blendMode = 'screen'; entry.content = 'light-effect';
    let psPlan: any;
    if (type === 'layer') await generationAction(j, { action: 'layout', layout });
    else {
      const { photoshopAction, photoshopState } = await import('../server/photoshop-rebuild.js');
      const l = j.snapshot.layers[0];
      await photoshopAction(j, { action: 'plan', plan: { layers: [{
        layerId: l.id, name: l.name, frame: l.frame, route: 'generate', content: 'light',
        surface: 'screen', rationale: '独立狭长弧光', includes: '实际暖弧', excludes: '天空人物文字',
        compositing: 'screen，黑底中性', editable: 'pixels', elements: entry.elements, anchors: entry.anchors,
      }] } }, {} as any);
      psPlan = photoshopState(j).plan;
    }
    const p: any = await api(`/api/jobs/${j.id}/generation`, {
      taskId: j.taskId, action: 'prepare', sourceLayerIds: entry.sourceLayerIds,
      elements: entry.elements, referenceStrategy: 'local-only', promptStyle: 'structured',
      purpose: '独立光效纯黑滤色，按完整承载画幅定位', referenceObservation: '暖弧两端星心，保留实际源位置',
    });
    assert.equal(p.surface, 'screen'); assert.equal(p.transparent_background, false);
    assert.deepEqual(p.frame, { x: 40, y: 30, width: 200, height: 40 });
    assert.deepEqual(p.carrier.frame, { x: 40, y: 10, width: 200, height: 80 });
    assert.deepEqual(p.carrier.artwork, { x: 0, y: 20, width: 200, height: 40 });
    assert.match(p.prompt, /纯黑中性外沿/); assert(!p.prompt.includes('增加透明外沿'));
    assert.equal(p.referencePaths.length, 2);
    const originalLocal = fs.readFileSync(p.referencePaths[1]);
    const rgba = await sharp(fs.readFileSync(p.referencePaths[0])).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([rgba.info.width, rgba.info.height], [200, 80]);
    assert.deepEqual([...rgba.data.subarray(0, 4)], [0, 0, 0, 255]);
    for (let i = 3; i < rgba.data.length; i += 4) assert.equal(rgba.data[i], 255);
    assert.deepEqual(await sharp(fs.readFileSync(p.referencePaths[0])).extract({ left: 0, top: 20, width: 200, height: 40 }).ensureAlpha().raw().toBuffer(),
      await sharp(originalLocal).ensureAlpha().raw().toBuffer());
    const data = Buffer.alloc(200 * 80 * 3);data.set([255, 180, 60], (40 * 200 + 20) * 3);
    const own = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
    await sharp(data, { raw: { width: 200, height: 80, channels: 3 } }).png().toFile(own);
    const originalBytes = fs.readFileSync(own);
    const r: any = await generationAction(j, { action: 'register', requestId: p.id, path: own,
      prompt: p.prompt, referencePaths: p.referencePaths }, psPlan);
    assert.deepEqual(r.placementFrame, p.carrier.frame); assert.deepEqual(r.frame, p.frame);
    assert.equal(r.blendMode, 'screen'); assert.equal(r.aspectError, 0);
    assert.deepEqual(fs.readFileSync(own), originalBytes); assert.deepEqual(fs.readFileSync(r.originalPath), originalBytes);
    assert.deepEqual(fs.readFileSync(p.referencePaths[1]), originalLocal);
    const placed = await sharp(fs.readFileSync(r.placedPreviewPath)).ensureAlpha().raw().toBuffer();
    assert.deepEqual([...placed.subarray((20 * 200 + 20) * 4, (20 * 200 + 20) * 4 + 4)], [255, 180, 60, 255]);
    assert.equal(r.review, undefined);
  }
});

test('screen layout freezes light-only semantics and apply equals reviewed composite', async () => {
  const { j, d, layout } = await fixture();
  const entry = layout.layers[0] as any;
  entry.blendMode = 'screen';
  await assert.rejects(() => generationAction(j, { action: 'layout', layout }), /light-effect/);
  entry.content = 'light-effect';
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout);
  assert.equal(p.blendMode, 'screen'); assert.equal(p.transparent_background, false);
  assert(!p.prompt.includes('尚未实现'));
  await assert.rejects(() => generationAction(j, { action: 'prepare', blendMode: 'normal' }), /不能覆盖/);
  const original = await file(p.generation.size.width, p.generation.size.height);
  const r: any = await generationAction(j, { action: 'register', requestId: p.id, path: original, prompt: p.prompt, referencePaths: p.referencePaths });
  assert.equal(r.isolationProblem, undefined); assert.equal(r.blendMode, 'screen');
  await review(j, r, entry.elements[0]);
  const c = await compositeReview(j, [r]);
  const payload = { taskId: d.taskId, baseVersion: j.version, layers: [{
    id: j.snapshot.layers[0].id, name: entry.elements[0], generationId: r.id,
    sourceLayerIds: r.sourceLayerIds, path: r.originalPath, ...r.frame,
  }] };
  const bad = await api(`/api/jobs/${j.id}/apply`, { ...payload, layers: [{ ...payload.layers[0], blendMode: 'normal' }] }, 400);
  assert.match(bad.error, /混合模式/);
  const done = await api(`/api/jobs/${j.id}/apply`, payload);
  const im = done.document.images.at(-1);
  assert.equal(im.layers[0].blendMode, 'screen');
  assert.deepEqual(await sharp(fs.readFileSync(c.path)).raw().toBuffer(), await sharp(await renderImage(d.id, im)).raw().toBuffer());
  const { compositeSignature } = await import('../server/generation-workflow.js');
  const state = generationState(j);
  assert.notEqual(compositeSignature(j, [r], state), compositeSignature(j, [{ ...r, blendMode: 'normal' }], state));
});

test('screen manual alignment preserves opaque black carrier, frozen anchors and final PSD pixels', async () => {
  const { j, d, layout } = await fixture();
  const entry = layout.layers[0] as any;
  entry.blendMode = 'screen';
  entry.content = 'light-effect';
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout);
  const data = Buffer.alloc(100 * 100 * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (const x of [10, 90]) data.set([255, 180, 60, 255], (50 * 100 + x) * 4);
  const original = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  await sharp(data, { raw: { width: 100, height: 100, channels: 4 } }).removeAlpha().png().toFile(original);
  const originalBytes = fs.readFileSync(original);
  const r: any = await generationAction(j, {
    action: 'register', requestId: p.id, path: original, prompt: p.prompt, referencePaths: p.referencePaths,
  });
  assert.equal(r.isolationProblem, undefined);
  assert.equal((await generationAction(j, { action: 'auto-align', generationId: r.id }) as any).applied, false);
  const points = [
    { source: [10, 50], target: [20, 20] },
    { source: [90, 50], target: [180, 20] },
  ];
  await assert.rejects(() => generationAction(j, {
    action: 'align', generationId: r.id, anchorNames: ['left', 'right'],
    points: [{ ...points[0], target: [30, 20] }, points[1]], observation: '不能迁就生成结果修改冻结星心',
  }), /冻结坐标/);
  const aligned: any = await generationAction(j, {
    action: 'align', generationId: r.id, anchorNames: ['left', 'right'], points,
    observation: '依据冻结星心恢复纯黑底光效的统一缩放和平移',
  });
  assert.deepEqual(aligned.frame, r.frame);
  assert.deepEqual(aligned.placementFrame, { x: 40, y: -50, width: 200, height: 200 });
  assert.equal(aligned.blendMode, 'screen');
  assert.equal(aligned.isolationPreviews.surface, 'screen');
  assert.deepEqual(fs.readFileSync(aligned.originalPath), originalBytes);
  assert.deepEqual(fs.readFileSync(original), originalBytes);
  const working = await sharp(fs.readFileSync(aligned.workingPath)).ensureAlpha().raw().toBuffer();
  for (let i = 3; i < working.length; i += 4) assert.equal(working[i], 255);
  assert.deepEqual([...working.subarray((50 * 100 + 10) * 4, (50 * 100 + 10) * 4 + 4)], [255, 180, 60, 255]);
  const light = await sharp(fs.readFileSync(aligned.isolationPreviews.light.path)).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...light.subarray(0, 3)], [238, 238, 238], 'black is neutral in the screen isolation preview');
  assert.equal(generationState(j).requests[0].surface, 'screen');
  assert.equal(generationState(j).requests[0].blendMode, 'screen');
  await generationAction(j, {
    action: 'review', generationId: aligned.id, comparisonHash: aligned.comparisonHash,
    elements: [{ name: entry.elements[0], status: 'matched', observation: '两处金色星心按冻结锚点恢复，黑底外没有额外物体' }],
    evidence: {
      geometry: '两个星心统一缩放两倍，完整100×100原件映射为200×200像素框',
      appearance: '两处金色RGB像素保留，未改亮度、颜色或光效形状',
      isolation: '整个RGB黑底载体保持不透明，深浅底均按screen展示，黑色贡献中性',
      candidateIds: [aligned.id],
    },
    review: { status: 'accepted', attempts: [{ method: '冻结对应点统一定位', observation: '两处星心落于冻结坐标且黑底保留' }], issues: [] },
  });
  const c = await compositeReview(j, [aligned]);
  const done = await api(`/api/jobs/${j.id}/apply`, {
    taskId: d.taskId, baseVersion: j.version, layers: [{
      id: j.snapshot.layers[0].id, name: entry.elements[0], generationId: aligned.id,
      sourceLayerIds: aligned.sourceLayerIds, path: aligned.originalPath, ...aligned.frame,
    }],
  });
  const im = done.document.images.at(-1);
  assert.equal(im.layers[0].blendMode, 'screen');
  const approved = await sharp(fs.readFileSync(c.path)).ensureAlpha().raw().toBuffer();
  assert.deepEqual(await sharp(await renderImage(d.id, im)).ensureAlpha().raw().toBuffer(), approved);
  const psd = readPsd(await exportPsd(d.id, im), { useImageData: true });
  assert.equal(psd.children![0].blendMode, 'screen');
  assert.deepEqual(Buffer.from(psd.imageData!.data), approved);
});

test('background alignment remains rejected for manual and automatic requests', async () => {
  const { j, layout } = await fixture(false, 'layer', true);
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout);
  const r: any = await generationAction(j, {
    action: 'register', requestId: p.id, path: await file(300, 180),
    prompt: p.prompt, referencePaths: p.referencePaths,
  });
  assert.equal(r.isolationProblem, undefined);
  await assert.rejects(() => generationAction(j, {
    action: 'align', generationId: r.id, anchorNames: ['left', 'right'],
    points: [{ source: [60, 50], target: [60, 50] }, { source: [220, 50], target: [220, 50] }],
    observation: '背景仍须补全，不能用定位制造空边',
  }), /背景须重新生成补全/);
  const automatic: any = await generationAction(j, { action: 'auto-align', generationId: r.id });
  assert.equal(automatic.applied, false);
  assert.deepEqual(automatic.record.placementFrame, r.placementFrame);
});

test('native PSD save cannot introduce a fake ordinary blend mode', async () => {
  const { d } = await fixture();
  const current = store.load(d.id);
  const im = current.images[0];
  im.nativePsd = { version: 1, compositeUrl: im.url, mappings: [] } as any;
  store.save(current);
  const original = structuredClone(current);
  current.images[0].layers[0].blendMode = 'screen';
  const response = await fetch(base + `/api/document/${d.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': TOKEN },
    body: JSON.stringify({ document: current, expectedRevision: current.revision }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json() as any).error, /原生文字/);
  assert.deepEqual(store.load(d.id), original);
});

const regionalAlphaChecks = [
  { name: '环境孔隙', kind: 'clear', box: [100, 40, 10, 10], maxAlpha: 8, minPassingFraction: 0.95 },
  { name: '薄透内区', kind: 'transmissive', box: [140, 40, 10, 10], minAlpha: 64,
    maxAlpha: 224, minBackgroundResponse: 31, minPassingFraction: 0.95 },
];
function promptAlphaRegions(prompt: string) {
  const line = prompt.split('\n').find(line => line.startsWith('以下box已'));
  assert(line, 'the generation prompt must contain the carrier-coordinate regions');
  const marker = '不绘制边框/坐标/名字：';
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length));
}
test('v6 opaque prepare HTTP freezes one actual carrier box on nonzero and scaled frames without adding upper/response', async () => {
  const { j, layout } = await fixture();
  const solid = { name: '固有黑字与实体', kind: 'opaque', box: [100, 40, 10, 10], minAlpha: 255, minPassingFraction: 0.95 };
  const entry = { ...layout.layers[0], anchors: [], alphaChecks: [solid] };
  await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'layout',
    layout: { ...layout, width: 600, height: 360, layers: [entry] } });
  for (const promptStyle of ['structured', 'concise-edit']) {
    const p = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'prepare',
      sourceLayerIds: entry.sourceLayerIds, elements: entry.elements, promptStyle,
      purpose: '固定实体覆盖形状与固有墨色', referenceObservation: '黑色实体不因颜色暗就变透明' });
    assert.deepEqual(p.alphaChecks, [solid]); assert.deepEqual(p.alphaCheckRegions[0].canvasBox, [200, 80, 20, 20]);
    assert.deepEqual(promptAlphaRegions(p.prompt), [{ ...solid, box: p.alphaCheckRegions[0].generationBox }]);
    assert.equal(promptAlphaRegions(p.prompt)[0].maxAlpha, undefined); assert.equal(promptAlphaRegions(p.prompt)[0].minBackgroundResponse, undefined);
    assert.match(p.prompt, /不能按RGB明暗\/墨色/); assert(!p.prompt.includes('"canvasBox"')); assert(!p.prompt.includes('"generationBox"'));
    assert.deepEqual(generationState(j).requests.find(q => q.id === p.id)?.alphaChecks, [solid]);
  }
});
async function regionalAlphaFile(kind: 'near-opaque' | 'material' | 'empty', shift = 0, carrier = false) {
  const height = carrier ? 134 : 80, offsetY = carrier ? 26 : 0;
  const data = Buffer.alloc(400 * height * 4).fill(Buffer.from([180, 90, 50, 255]));
  data[3] = 0; // Global transparency alone must never satisfy named regions.
  for (const [left, alpha] of [[120 + shift, kind === 'near-opaque' ? 252 : 0],
    [200 + shift, kind === 'near-opaque' ? 252 : kind === 'empty' ? 0 : 128]]) {
    for (let y = 16 + offsetY; y < 44 + offsetY; y++) for (let x = left - 4; x < left + 24; x++)
      data[(y * 400 + x) * 4 + 3] = alpha;
  }
  const original = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  await sharp(data, { raw: { width: 400, height, channels: 4 } }).png().toFile(original);
  return original;
}

test('alphaChecks require explicit thresholds and image-local coordinates within their source scope', async () => {
  const { j, layout } = await fixture(true);
  await assert.rejects(() => generationAction(j, { action: 'prepare', alphaChecks: regionalAlphaChecks }), /冻结layout/);
  const entry = layout.layers[0] as any;
  for (const checks of [
    [{ ...regionalAlphaChecks[0], maxAlpha: undefined }],
    [{ ...regionalAlphaChecks[0], box: [100.5, 40, 10, 10] }],
    [{ ...regionalAlphaChecks[0], box: [100, 40, 0, 10] }],
    [{ ...regionalAlphaChecks[1], minAlpha: 240 }],
    [{ ...regionalAlphaChecks[1], minBackgroundResponse: 0 }],
  ]) {
    entry.alphaChecks = checks;
    await assert.rejects(() => generationAction(j, { action: 'layout', layout }));
  }
  for (const box of [[1200, 850, 10, 10], [50, 100, 10, 10]]) {
    entry.alphaChecks = [{ ...regionalAlphaChecks[0], box }];
    await assert.rejects(() => generationAction(j, { action: 'layout', layout }), /图片.*来源层冻结框/);
  }
  entry.alphaChecks = [regionalAlphaChecks[0], regionalAlphaChecks[0]];
  await assert.rejects(() => generationAction(j, { action: 'layout', layout }), /名称重复/);
  entry.alphaChecks = regionalAlphaChecks;
  entry.blendMode = 'screen'; entry.content = 'light-effect';
  await assert.rejects(() => generationAction(j, { action: 'layout', layout }), /normal透明前景/);
  delete entry.blendMode; delete entry.content;
  j.type = 'photoshop';
  await assert.rejects(() => generationAction(j, { action: 'layout', layout }), /普通v4/);
  j.type = 'layer'; delete j.reconstructionWorkflowVersion;
  await assert.rejects(() => generationAction(j, { action: 'layout', layout }), /普通v4/);
  const bg = await fixture(false, 'layer', true);
  (bg.layout.layers[0] as any).alphaChecks = regionalAlphaChecks;
  await assert.rejects(() => generationAction(bg.j, { action: 'layout', layout: bg.layout }), /普通v4/);
});

test('alphaChecks prepare maps source image through the output canvas and carrier without drawing marks', async () => {
  const { j, layout } = await fixture();
  const entry = layout.layers[0] as any;
  entry.alphaChecks = regionalAlphaChecks;
  entry.anchors = [];
  const scaled = { ...layout, width: 600, height: 360 };
  await generationAction(j, { action: 'layout', layout: scaled });
  for (const promptStyle of ['structured', 'concise-edit']) {
    const p: any = await generationAction(j, { action: 'prepare', sourceLayerIds: entry.sourceLayerIds,
      purpose: '保留环境孔隙和真实薄布纹理', elements: entry.elements,
      referenceObservation: '源图此处存在真实城市开口与薄布内区', promptStyle });
    assert.deepEqual(p.alphaChecks, regionalAlphaChecks);
    assert.deepEqual(p.alphaCheckRegions[0].canvasBox, [200, 80, 20, 20]);
    assert.deepEqual(p.alphaCheckRegions[0].generationBox, [
      (200 - p.carrier.frame.x) * p.generation.scale + p.generation.offsetX,
      (80 - p.carrier.frame.y) * p.generation.scale + p.generation.offsetY,
      20 * p.generation.scale, 20 * p.generation.scale,
    ]);
    assert.match(p.prompt, /原图可见环境孔隙.*不能当作被遮挡/);
    assert.match(p.prompt, /薄透区域的参考像素已经混合后层/);
    assert.match(p.prompt, /本层已冻结薄透材质区域/);
    assert.match(p.prompt, /保持本层实框、铰链/);
    assert.match(p.prompt, /去除这些后景RGB同时重建该处材质alpha/);
    assert.match(p.prompt, /无法确认归属的反射按源观察保留/);
    assert(!p.prompt.includes('变形、颜色、纹理与光照'));
    assert(!p.prompt.includes('纹理、颜色和效果；文字描述'));
    assert.match(p.prompt, /不绘制边框\/坐标\/名字/);
    assert.deepEqual(promptAlphaRegions(p.prompt), regionalAlphaChecks.map((check, i) =>
      ({ ...check, box: p.alphaCheckRegions[i].generationBox })));
    assert.deepEqual(p.alphaCheckRegions.map((region: any) => region.box), regionalAlphaChecks.map(check => check.box));
    assert(!p.prompt.includes('"generationBox"'));
    assert(!p.prompt.includes('"canvasBox"'));
    assert.deepEqual(generationState(j).requests.find(request => request.id === p.id)?.alphaChecks, regionalAlphaChecks);
  }
  const p: any = await generationAction(j, { action: 'prepare', sourceLayerIds: entry.sourceLayerIds,
    purpose: '使用冻结区域检查', elements: entry.elements, referenceObservation: '只检查这个来源组的可见负形和薄布' });
  entry.alphaChecks = [{ ...regionalAlphaChecks[0], maxAlpha: 16 }, regionalAlphaChecks[1]];
  await generationAction(j, { action: 'layout', layout: scaled });
  await assert.rejects(async () => generationAction(j, { action: 'register', requestId: p.id,
    path: await regionalAlphaFile('material'), prompt: p.prompt, referencePaths: p.referencePaths }), /冻结准备记录/);
  entry.alphaChecks = regionalAlphaChecks;
  await generationAction(j, { action: 'layout', layout: scaled });
  const r: any = await generationAction(j, { action: 'register', requestId: p.id,
    path: await regionalAlphaFile('material', 0, true), prompt: p.prompt, referencePaths: p.referencePaths });
  assert.equal(r.alphaDiagnostics.passed, true);
  assert.deepEqual(r.alphaDiagnostics.checks[0].canvasBox, [200, 80, 20, 20]);
  assert.deepEqual(r.alphaDiagnostics.checks[0].materialBox, [120, 47, 20, 20]);
});

test('alphaChecks prompt uses only budget-scaled carrier boxes with a nonzero frame origin', async () => {
  const { j, layout } = await fixture();
  const entry = layout.layers[0] as any;
  entry.alphaChecks = regionalAlphaChecks;
  entry.anchors = [];
  await generationAction(j, { action: 'layout', layout: { ...layout, width: 3600, height: 2160 } });
  for (const promptStyle of ['structured', 'concise-edit']) {
    const p: any = await generationAction(j, { action: 'prepare', sourceLayerIds: entry.sourceLayerIds,
      purpose: '在预算缩放后的完整文件中保持透明孔隙和薄布', elements: entry.elements,
      referenceObservation: '城市孔隙与薄布位置由源图冻结，不调整坐标作用域', promptStyle });
    assert.deepEqual(p.carrier.frame, { x: 480, y: 200, width: 2400, height: 800 });
    assert(p.generation.scale < 1);
    assert(p.generation.size.width * p.generation.size.height <= 1_500_000);
    const scale = p.generation.scale;
    const boxes = [[720 * scale + p.generation.offsetX, 280 * scale + p.generation.offsetY, 120 * scale, 120 * scale],
      [1200 * scale + p.generation.offsetX, 280 * scale + p.generation.offsetY, 120 * scale, 120 * scale]];
    assert.deepEqual(promptAlphaRegions(p.prompt), regionalAlphaChecks.map((check, i) => ({ ...check, box: boxes[i] })));
    assert.deepEqual(p.alphaCheckRegions.map((region: any) => region.canvasBox), [[1200, 480, 120, 120], [1680, 480, 120, 120]]);
    assert.deepEqual(p.alphaCheckRegions.map((region: any) => region.box), regionalAlphaChecks.map(check => check.box));
    for (const region of promptAlphaRegions(p.prompt)) {
      assert.deepEqual(Object.keys(region).sort(), Object.keys(regionalAlphaChecks.find(check => check.name === region.name)!).sort());
      const [x, y, w, h] = region.box;
      assert(x >= 0 && y >= 0 && x + w <= p.generation.size.width && y + h <= p.generation.size.height);
    }
    assert.deepEqual(generationState(j).requests.find(request => request.id === p.id)?.alphaChecks, regionalAlphaChecks);
  }
});

test('alphaChecks empty or absent add no regional coordinates while v4 material ownership stays explicit', async () => {
  for (const checks of [undefined, []]) {
    const { j, layout } = await fixture();
    const entry = layout.layers[0] as any;
    if (checks) entry.alphaChecks = checks;
    await generationAction(j, { action: 'layout', layout });
    for (const promptStyle of ['structured', 'concise-edit']) {
      const p: any = await generationAction(j, { action: 'prepare', sourceLayerIds: entry.sourceLayerIds,
        purpose: '保持没有局部透明检查的旧提示行为', elements: entry.elements,
        referenceObservation: '只按来源对象轮廓生成', promptStyle });
      assert.equal(p.alphaCheckRegions, undefined);
      assert.deepEqual(p.alphaChecks, checks);
      assert(!p.prompt.includes('以下box已'));
      assert(!p.prompt.includes('冻结区域隔离约束'));
      assert(p.prompt.includes('若本层含薄透材质'));
      assert(p.prompt.includes('输出透明只要求物体之外的区域透明'));
      assert(!p.prompt.includes('保持本层实框、铰链'));
      assert(p.prompt.includes('后层分离只改变材质归属'));
      assert(p.prompt.includes('未受分离影响的实体覆盖率'));
    }
  }
});

test('opaque coverage and clear holes do not declare thin material or require another-layer hardware', async () => {
  for (const check of [
    {name:'本层实体覆盖',kind:'opaque',box:[100,40,10,10],minAlpha:250,minPassingFraction:.9},
    {name:'物体之外孔隙',kind:'clear',box:[100,40,10,10],maxAlpha:20,minPassingFraction:.9},
  ]) {
    const {j,layout}=await fixture(); const entry=layout.layers[0] as any;
    entry.alphaChecks=[check]; await generationAction(j,{action:'layout',layout});
    for(const promptStyle of ['structured','concise-edit']){
      const p:any=await generationAction(j,{action:'prepare',sourceLayerIds:entry.sourceLayerIds,
        elements:entry.elements,purpose:'隔离本层实体，不增加透光附件',referenceObservation:'只按当前源实体与自身孔隙，其他层玻璃罩另列',promptStyle});
      assert.deepEqual(p.alphaChecks,[check]);assert(p.prompt.includes('输出透明只要求物体之外的区域透明'));
      assert(!p.prompt.includes('本层已冻结薄透材质区域'));
      assert(!p.prompt.includes('本层冻结的薄透材质要'));
      assert(!p.prompt.includes('保持本层实框、铰链'));
      if(check.kind==='opaque')assert(p.prompt.includes('冻结opaque区域要求实体覆盖率alpha下限'));
    }
  }
});

test('alphaChecks distinguish almost opaque pixels, a clear opening, real material response and an empty layer', async () => {
  const { j, d, layout } = await fixture();
  (layout.layers[0] as any).alphaChecks = regionalAlphaChecks;
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout), records: any[] = [];
  for (const kind of ['near-opaque', 'material', 'empty'] as const) {
    const r: any = await generationAction(j, { action: 'register', requestId: p.id,
      path: await regionalAlphaFile(kind, 0, true), prompt: p.prompt, referencePaths: p.referencePaths });
    records.push(r);
    assert.equal(r.isolationProblem, undefined, 'global minAlpha<255 is not regional acceptance');
    assert.equal(r.alphaDiagnostics.passed, kind === 'material');
    assert.deepEqual(r.alphaDiagnostics.checks[0].canvasBox, regionalAlphaChecks[0].box);
    if (kind === 'near-opaque') {
      for (const c of r.alphaDiagnostics.checks) {
        assert.equal(c.alpha.min, 252); assert.equal(c.alpha.max, 252);
        assert.equal(c.backgroundResponse.mean, 3); assert.equal(c.passingFraction, 0);
      }
    } else {
      assert.equal(r.alphaDiagnostics.checks[0].alpha.max, 0);
      assert.equal(r.alphaDiagnostics.checks[0].passed, true);
      const cloth = r.alphaDiagnostics.checks[1];
      assert.equal(cloth.alpha.min, kind === 'material' ? 128 : 0);
      assert.equal(cloth.backgroundResponse.mean, kind === 'material' ? 127 : 255);
      assert.equal(cloth.passed, kind === 'material', 'alpha0 is an empty hole, not transmissive material');
    }
    if (kind === 'material') await review(j, r, '标题');
    else {
      await assert.rejects(() => review(j, r, '标题'), /区域alpha检查未通过/);
      await review(j, r, '标题', 'needs-revision');
      const prior = generationState(j).outputs.find(o => o.id === r.id)!;
      await assert.doesNotReject(() => generationAction(j, {
        action: 'review', generationId: r.id, comparisonHash: r.comparisonHash,
        review: prior.review, evidence: prior.reviewEvidence,
        elements: prior.elements!.map(e => ({ ...e, status: 'matched',
          observation: '主体外形及颜色保留，剩余隔离问题由命名区域alpha诊断具体记录' })),
      }), 'honest needs-revision remains possible when the numerical region failure is already recorded');
    }
  }
  await assert.rejects(() => generationAction(j, { action: 'layout', layout: { ...layout,
    layers: [{ ...layout.layers[0], alphaChecks: [{ ...regionalAlphaChecks[0], maxAlpha: 16 }] }] } }), /已有真实候选/);
  const { generationSummary } = await import('../server/generation.js');
  assert.equal(generationSummary(j).outputs[0].alphaDiagnostics?.passed, false);
  const registry = path.join(path.dirname(path.dirname(records[0].originalPath)), 'registry.json');
  await compositeReview(j, [records[0]]);
  const honest = generationState(j), falselyAccepted = structuredClone(honest);
  falselyAccepted.outputs[0].review = { status: 'accepted', attempts: [{ method: '旧缓存通过', observation: '缓存不能替代当前区域失败' }], issues: [] };
  fs.writeFileSync(registry, JSON.stringify(falselyAccepted));
  const payload = (r: any) => ({ taskId: j.taskId, baseVersion: j.version, layers: [{
    id: r.sourceLayerIds[0], name: '标题', ...r.frame, path: r.originalPath, generationId: r.id,
  }] });
  const rejected = await api(`/api/jobs/${j.id}/apply`, payload(records[0]), 500);
  assert.match(rejected.error, /区域alpha检查失败.*accepted/);
  assert.equal(store.load(d.id).images.length, 1);
  fs.writeFileSync(registry, JSON.stringify(honest));
  const c = await compositeReview(j, [records[1]]);
  const done = await api(`/api/jobs/${j.id}/apply`, payload(records[1]));
  const image = done.document.images.at(-1), final = await sharp(store.assetPath(d.id, image.layers[0].url))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => final.data[((y - image.layers[0].y) * final.info.width + x - image.layers[0].x) * 4 + 3];
  assert.equal(at(100, 40), 0); assert.equal(at(140, 40), 128);
  assert.deepEqual(await sharp(await renderImage(d.id, image)).ensureAlpha().raw().toBuffer(),
    await sharp(fs.readFileSync(c.path)).ensureAlpha().raw().toBuffer());
  fs.writeFileSync(path.join(process.env.LAYER_CANVAS_DATA!, 'alpha-checks-regression-evidence.json'), JSON.stringify({
    fixture: 'Isolated protocol regression; explicit test thresholds, not optical transmission or visual acceptance',
    sourceSize: { width: j.snapshot.width, height: j.snapshot.height },
    registryPath: registry, falseAcceptedCacheApplyRejected: true, validCandidateApplySucceeded: true,
    checks: regionalAlphaChecks, candidates: records.map(r => ({ id: r.id, alphaDiagnostics: r.alphaDiagnostics,
      review: generationState(j).outputs.find(o => o.id === r.id)?.review?.status })),
  }, null, 2));
});

test('alphaChecks failures allow alignment, recompute placed regions and invalidate earlier diagnoses and approvals', async () => {
  const { j, layout } = await fixture();
  (layout.layers[0] as any).alphaChecks = regionalAlphaChecks;
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout);
  const r: any = await generationAction(j, { action: 'register', requestId: p.id,
    path: await regionalAlphaFile('material', 20), prompt: p.prompt, referencePaths: p.referencePaths });
  assert.equal(r.alphaDiagnostics.passed, false);
  await review(j, r, '标题', 'needs-revision');
  await generationAction(j, { action: 'composite', generationIds: [r.id] });
  const originalBytes = fs.readFileSync(r.originalPath);
  const aligned: any = await generationAction(j, { action: 'align', generationId: r.id,
    anchorNames: ['left', 'right'], points: [
      { source: [60, 40], target: [20, 20] }, { source: [380, 40], target: [180, 20] },
    ], observation: '按冻结参考点统一左移10像素，让既有孔隙和薄布回到正确的图片坐标' });
  assert.deepEqual(aligned.placementFrame, { x: 30, y: 30, width: 200, height: 40 });
  assert.equal(aligned.alphaDiagnostics.passed, true);
  assert.notEqual(aligned.alphaDiagnostics.signature, r.alphaDiagnostics.signature);
  assert.deepEqual(aligned.alphaDiagnostics.checks[0].materialBox, [70, 10, 10, 10]);
  assert.equal(aligned.review, undefined); assert.equal(generationState(j).composite, undefined);
  assert.deepEqual(fs.readFileSync(aligned.originalPath), originalBytes);
  await review(j, aligned, '标题'); await compositeReview(j, [aligned]);
  assert(generationState(j).composite?.review);
  const registry = path.join(path.dirname(path.dirname(r.originalPath)), 'registry.json');
  const trusted = generationState(j), stale = structuredClone(trusted);
  const oldDiagnostic = structuredClone(trusted);
  (oldDiagnostic.outputs[0].alphaDiagnostics as any).version = 1;
  fs.writeFileSync(registry, JSON.stringify(oldDiagnostic));
  const oldApply = await api(`/api/jobs/${j.id}/apply`, { taskId: j.taskId, baseVersion: j.version,
    layers: [{ id: r.sourceLayerIds[0], name: '标题', ...r.frame, path: r.originalPath, generationId: r.id }] }, 500);
  assert.match(oldApply.error, /区域alpha诊断已失效/);
  assert.equal(store.load(j.documentId).images.length, 1);
  fs.writeFileSync(registry, JSON.stringify(trusted));
  stale.outputs[0].placementFrame!.x++;
  fs.writeFileSync(registry, JSON.stringify(stale));
  const { registeredGeneration } = await import('../server/generation.js');
  assert.throws(() => registeredGeneration(j, r.id, r.sourceLayerIds, r.frame), /区域alpha诊断已失效/);
  await assert.rejects(() => generationAction(j, { action: 'composite', generationIds: [r.id] }), /区域alpha诊断已失效/);
  fs.writeFileSync(registry, JSON.stringify(trusted));
  const working = fs.readFileSync(aligned.workingPath), changed = Buffer.from(working);
  changed[changed.length - 1] ^= 1; fs.writeFileSync(aligned.workingPath, changed);
  assert.throws(() => registeredGeneration(j, r.id, r.sourceLayerIds, r.frame), /生成原文件已变化/);
  fs.writeFileSync(aligned.workingPath, working);
  const movedBack: any = await generationAction(j, { action: 'align', generationId: r.id,
    anchorNames: ['left', 'right'], points: [
      { source: [40, 40], target: [20, 20] }, { source: [360, 40], target: [180, 20] },
    ], observation: '第二组冻结对应点改变放置，必须重新检查区域，不能沿用上次通过' });
  assert.equal(movedBack.alphaDiagnostics.passed, false);
  assert.equal(movedBack.review, undefined); assert.equal(generationState(j).composite, undefined);
  await assert.rejects(() => review(j, movedBack, '标题'), /区域alpha检查未通过/);
  await review(j, movedBack, '标题', 'needs-revision');
});

test('alphaChecks tiny positive fractions never accept zero qualifying material pixels', async () => {
  const { evaluateGenerationAlphaChecks } = await import('../server/generation-alpha-checks.js');
  const bytes = await sharp(Buffer.from([80, 90, 100, 0, 80, 90, 100, 128]),
    { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const workingPath = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  fs.writeFileSync(workingPath, bytes);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const result = await evaluateGenerationAlphaChecks({
    checks: [{ name: '非空薄布', kind: 'transmissive', box: [0, 0, 1, 1], minAlpha: 1,
      maxAlpha: 254, minBackgroundResponse: 1, minPassingFraction: 1e-15 }],
    sourceSize: { width: 2, height: 1 }, canvas: { width: 2, height: 1 },
    originalHash: hash, workingHash: hash, workingPath, placementFrame: { x: 0, y: 0, width: 2, height: 1 },
  });
  assert.equal(result.checks[0].passingPixels, 0);
  assert.equal(result.checks[0].requiredPassingPixels, 1);
  assert.equal(result.passed, false);
});

test('alphaChecks downscaled edge regions sample real canvas pixels and share prepare guidance mapping', async () => {
  const { evaluateGenerationAlphaChecks, generationAlphaCheckRegions } = await import('../server/generation-alpha-checks.js');
  const workingPath = await file(10, 10), bytes = fs.readFileSync(workingPath);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const checks = [{ name: '右下孔隙', kind: 'clear' as const, box: [99, 99, 1, 1] as [number, number, number, number],
    maxAlpha: 0, minPassingFraction: 1 }];
  const result = await evaluateGenerationAlphaChecks({ checks, sourceSize: { width: 100, height: 100 },
    canvas: { width: 10, height: 10 }, originalHash: hash, workingHash: hash, workingPath,
    placementFrame: { x: 0, y: 0, width: 10, height: 10 } });
  const guidance = generationAlphaCheckRegions(checks, { width: 100, height: 100 }, { width: 10, height: 10 },
    { frame: { x: 0, y: 0, width: 10, height: 10 }, scale: 1, offsetX: 0, offsetY: 0 });
  assert.deepEqual(result.checks[0].canvasBox, [9, 9, 1, 1]);
  assert.deepEqual(guidance[0].canvasBox, result.checks[0].canvasBox);
  assert.deepEqual(guidance[0].generationBox, [9, 9, 1, 1]);
  assert.equal(result.checks[0].alpha.min, 255); assert.equal(result.passed, false);
});

test('occupied counts sparse ink with explicit lower bound and fails empty or displaced bands', async () => {
  const { evaluateGenerationAlphaChecks, alphaDiagnosticSignature } = await import('../server/generation-alpha-checks.js');
  const raw = Buffer.alloc(10 * 10 * 4); for (const n of [52, 53, 54, 62, 63, 64]) raw[n * 4 + 3] = 200;
  const workingPath = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  const bytes = await sharp(raw, { raw: { width: 10, height: 10, channels: 4 } }).png().toBuffer();
  fs.writeFileSync(workingPath, bytes); const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const input = { checks: [{ name: '稀疏墨迹', kind: 'occupied' as const, box: [0, 5, 10, 2] as [number, number, number, number],
    minAlpha: 32, minPassingFraction: 0.3 }], sourceSize: { width: 10, height: 10 }, canvas: { width: 10, height: 10 },
    originalHash: hash, workingHash: hash, workingPath, placementFrame: { x: 0, y: 0, width: 10, height: 10 } };
  const r = await evaluateGenerationAlphaChecks(input); assert.equal(r.checks[0].passingPixels, 6); assert.equal(r.passed, true);
  assert.equal((await evaluateGenerationAlphaChecks({ ...input, checks: [{ ...input.checks[0], minAlpha: 201 }] })).passed, false);
  const moved = { ...input, placementFrame: { ...input.placementFrame, y: 5 } };
  assert.equal((await evaluateGenerationAlphaChecks(moved)).passed, false);
  assert.notEqual(alphaDiagnosticSignature(input), alphaDiagnosticSignature(moved));
  await assert.rejects(evaluateGenerationAlphaChecks({ ...input, checks: [{ ...input.checks[0], minPassingFraction: 0 }] }));
});

test('alphaChecks hash and sampling use one buffer snapshot and reject a lasting file replacement', async () => {
  const { evaluateGenerationAlphaChecks } = await import('../server/generation-alpha-checks.js');
  const original = await sharp(Buffer.from([100, 100, 100, 255, 100, 100, 100, 128]),
    { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const substituted = await sharp(Buffer.from([100, 100, 100, 0, 100, 100, 100, 128]),
    { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const workingPath = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  fs.writeFileSync(workingPath, original);
  const hash = crypto.createHash('sha256').update(original).digest('hex');
  const input = { checks: [{ name: 'A的不透明区域不能被临时B冒充孔隙', kind: 'clear' as const,
    box: [0, 0, 1, 1] as [number, number, number, number], maxAlpha: 0, minPassingFraction: 1 }],
    sourceSize: { width: 2, height: 1 }, canvas: { width: 2, height: 1 }, originalHash: hash, workingHash: hash,
    workingPath, placementFrame: { x: 0, y: 0, width: 2, height: 1 } };
  const read = fs.readFileSync;
  let reads = 0;
  try {
    (fs as any).readFileSync = (...args: any[]) => {
      if (typeof args[0] !== 'string' || path.resolve(args[0]) !== workingPath) return (read as any)(...args);
      reads++;
      if (reads === 2) fs.writeFileSync(workingPath, original); // ABA restored before final verification.
      const bytes = (read as any)(...args);
      if (reads === 1) fs.writeFileSync(workingPath, substituted);
      return bytes;
    };
    const result = await evaluateGenerationAlphaChecks(input);
    assert.equal(reads, 2, 'only the first read feeds decoding; the second verifies current path stability');
    assert.equal(result.passed, false); assert.equal(result.checks[0].alpha.min, 255);
    assert.equal(result.materialHash, hash); assert.equal(result.binding.workingSnapshotHash, hash);
    reads = 0;
    (fs as any).readFileSync = (...args: any[]) => {
      const bytes = (read as any)(...args);
      if (typeof args[0] === 'string' && path.resolve(args[0]) === workingPath && ++reads === 1)
        fs.writeFileSync(workingPath, substituted);
      return bytes;
    };
    await assert.rejects(() => evaluateGenerationAlphaChecks(input), /诊断期间工作文件已改变/);
  } finally { fs.readFileSync = read; fs.writeFileSync(workingPath, original); }
});

test('needs-revision permits one real checked candidate while failed API calls and changed files cannot replace registration', async () => {
  const { j, layout } = await fixture();
  await generationAction(j, { action: 'layout', layout });
  const p: any = await prep(j, layout), r: any = await reg(j, p);
  await assert.rejects(() => generationAction(j, { action: 'register', requestId: 'failed-api-request',
    path: r.originalPath, prompt: p.prompt, referencePaths: p.referencePaths }), /准备记录不存在/);
  await review(j, r, '标题', 'needs-revision');
  const prior = generationState(j).outputs.find(o => o.id === r.id)!;
  const input = { action: 'review', generationId: r.id, comparisonHash: r.comparisonHash,
    review: { ...prior.review!, attempts: [prior.review!.attempts[0]] },
    elements: prior.elements, evidence: prior.reviewEvidence };
  await assert.doesNotReject(() => generationAction(j, input));
  assert.equal(generationState(j).outputs[0].review!.attempts.length, 1);
  await assert.rejects(() => generationAction(j, { ...input,
    evidence: { ...input.evidence, candidateIds: ['failed-api-request'] } }), /candidateIds/);
  const bytes = fs.readFileSync(r.originalPath), changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1; fs.writeFileSync(r.originalPath, changed);
  await assert.rejects(() => generationAction(j, input), /生成原文件已变化/);
  fs.writeFileSync(r.originalPath, bytes);
});

test('native text API freezes provenance, composes actual filled glyphs and refuses fake model registration', async () => {
  assert.ok(nativeFontPath, '工程验证需要实际字体，不隐式下载');
  const { j, layout } = await fixture(true, 'layer', false, undefined, [40, 30, 200, 60]);
  const ownFont = path.join(process.env.LAYER_CANVAS_DATA!, 'font-' + crypto.randomUUID() + '.ttf');
  const fontBytes = fs.readFileSync(nativeFontPath); fs.writeFileSync(ownFont, fontBytes);
  const fontHash = crypto.createHash('sha256').update(fontBytes).digest('hex');
  const nativeLayout: any = structuredClone(layout);
  nativeLayout.layers[0].nativeText = { version: 1, observation: '工程样例实际确认的三行黑色实心参数文字，空隙不带纸底',
    spans: ['Angle 0-60', 'Index 1.31-1.34', 'Air 1.0003'].map((text, i) => ({ text,
      fontPath: ownFont, fontHash, fontSize: 12, color: '#000000',
      box: { x: 48, y: 35 + i * 18, width: 184, height: 14 } })) };
  for (const change of [{ blendMode: 'screen', content: 'light-effect' }, { allowAuxMatte: true }])
    await assert.rejects(() => generationAction(j, { action: 'layout', layout: { ...nativeLayout,
      layers: [{ ...nativeLayout.layers[0], ...change }, nativeLayout.layers[1]] } }), /仅支持新普通v4/);
  await assert.rejects(() => generationAction({ ...j, type: 'photoshop' }, { action: 'layout', layout: nativeLayout }), /仅支持新普通v4/);
  await assert.rejects(() => generationAction({ ...j, reconstructionWorkflowVersion: undefined }, { action: 'layout', layout: nativeLayout }), /仅支持新普通v4/);
  await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'layout', layout: nativeLayout });
  const q: any = await prep(j, nativeLayout);
  assert.equal(q.role, 'native-text'); assert.match(q.instruction, /render-native-text/);
  const changed = structuredClone(nativeLayout); changed.layers[0].nativeText.spans[0].text = 'Wrong';
  await assert.rejects(() => generationAction(j, { action: 'layout', layout: changed }), /首次prepare前冻结/);
  await assert.rejects(() => generationAction(j, { action: 'register', requestId: q.id, path: q.localPath,
    prompt: q.prompt, referencePaths: q.referencePaths }), /后台render-native-text/);
  const r: any = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'render-native-text', requestId: q.id });
  assert.equal(r.kind, 'native-text'); assert.equal(r.receipt.tool, 'native-font-renderer');
  assert.equal(r.review, undefined); assert.ok(r.nativeTextProof); assert.ok(r.workingSize.width * r.workingSize.height <= 1500000);
  const repeated: any = await generationAction(j, { action: 'render-native-text', requestId: q.id });
  assert.equal(repeated.id, r.id); assert.equal(repeated.reused, true); assert.equal(generationState(j).outputs.length, 1);
  const composite: any = await generationAction(j, { action: 'composite', generationIds: [r.id] });
  assert.equal(composite.complete, false); assert.equal(composite.missing.length, 1);
  await assert.rejects(() => generationAction(j, { action: 'auto-align', generationId: r.id }), /冻结字形框/);
  const normal: any = await prep(j, nativeLayout, 1);
  const alias = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  await sharp(fs.readFileSync(r.originalPath)).png({ compressionLevel: 9 }).toFile(alias);
  await assert.rejects(() => generationAction(j, { action: 'register', requestId: normal.id,
    path: alias, prompt: normal.prompt, referencePaths: normal.referencePaths }), /native-text.*冒充image_gen/);
  const proofBytes = fs.readFileSync(r.nativeTextProof.path); fs.appendFileSync(r.nativeTextProof.path, ' ');
  await assert.rejects(() => generationAction(j, { action: 'composite', generationIds: [r.id] }), /渲染证明不匹配/);
  fs.writeFileSync(r.nativeTextProof.path, proofBytes);
  fs.appendFileSync(ownFont, ' ');
  await assert.rejects(() => generationAction(j, { action: 'composite', generationIds: [r.id] }), /字体文件已变化/);
  fs.writeFileSync(ownFont, fontBytes);
  const registry = path.join(path.dirname(path.dirname(r.originalPath)), 'registry.json');
  const saved = fs.readFileSync(registry), wrong = generationState(j);
  delete wrong.outputs[0].kind; delete wrong.outputs[0].nativeTextProof; wrong.outputs[0].receipt.tool = 'image_gen';
  fs.writeFileSync(registry, JSON.stringify(wrong));
  await assert.rejects(() => generationAction(j, { action: 'composite', generationIds: [r.id] }), /原生字体登记身份/);
  fs.writeFileSync(registry, saved);
  const { registeredGeneration } = await import('../server/generation.js');
  assert.equal(registeredGeneration(j, r.id, r.sourceLayerIds, r.frame).id, r.id);
  const result = await api(`/api/jobs/${j.id}/generation`, { taskId: 'other-task', action: 'render-native-text', requestId: q.id }, 403);
  assert.ok(result.error);
});
