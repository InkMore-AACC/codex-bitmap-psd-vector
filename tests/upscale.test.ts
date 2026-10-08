import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { readPsd, writePsdBuffer } from 'ag-psd';
import { DEFAULT_UPSCALE, upscaleDimensions, upscaleSchema } from '../shared/upscale.js';

process.env.LAYER_CANVAS_DATA = path.resolve('test-output/upscale-' + crypto.randomUUID());
const { app, TOKEN, BRIDGE_TOKEN } = await import('../server/index.js');
const { getJob, load, assetPath } = await import('../server/store.js');
let dispatches = 0;
app.locals.codexSender = async () => {
  dispatches++;
  return { delivered: true };
};
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
after(() => {
  server.closeAllConnections();
  server.close();
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const headers = {
  'Content-Type': 'application/json',
  'X-Canvas-Token': TOKEN,
  'X-Canvas-Bridge': BRIDGE_TOKEN,
};
async function api(
  p: string,
  body?: any,
  method = body ? 'POST' : 'GET',
  expected = 200,
): Promise<any> {
  const r = await fetch(base + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const v = await r.json();
  assert.equal(r.status, expected, JSON.stringify(v));
  return v;
}
async function fixture() {
  const d = await api('/api/document?taskId=upscale_' + crypto.randomUUID());
  const p = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  await sharp({
    create: {
      width: 40,
      height: 30,
      channels: 4,
      background: { r: 52, g: 86, b: 120, alpha: 0.5 },
    },
  })
    .png()
    .toFile(p);
  return api(`/api/document/${d.id}/import-path`, { taskId: d.taskId, path: p });
}
async function wait(id: string) {
  for (let i = 0; i < 150; i++) {
    const j = getJob(id);
    if (['completed', 'failed', 'cancelled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job timeout');
}
async function fake(args: string[]) {
  assert.equal(args[0], 'upscale');
  const p = path.join(args[args.indexOf('--output') + 1], 'upscaled.png');
  const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--options') + 1], 'utf8'));
  // Deliberately wrong alpha; the adapter must preserve source alpha independently.
  await sharp({
    create: {
      width: 40 * settings.scale,
      height: 30 * settings.scale,
      channels: 3,
      background: '#345678',
    },
  })
    .png()
    .toFile(p);
  return { path: p, warnings: [], seconds: 0.1 };
}

test('video import, frozen local queue, new result node and export preserve media metadata', async () => {
  let d = await api('/api/document?taskId=video_' + crypto.randomUUID());
  const input = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.mp4');
  fs.writeFileSync(input, 'fixture video bytes');
  const info = {
    width: 40,
    height: 30,
    duration: 1,
    fpsNumerator: 12,
    fpsDenominator: 1,
    frameCount: 12,
    audioStreams: 1,
  };
  app.locals.videoWorker = async (args: string[]) => {
    const out = args[args.indexOf('--output') + 1];
    const poster = path.join(out, 'poster.png'),
      preview = path.join(out, 'preview.mp4');
    await sharp({ create: { width: 40, height: 30, channels: 3, background: 'red' } })
      .png()
      .toFile(poster);
    fs.writeFileSync(preview, 'preview');
    return { ...info, poster, preview };
  };
  d = await api(`/api/document/${d.id}/import-path`, { taskId: d.taskId, path: input });
  const source = structuredClone(d.images[0]);
  assert.equal(source.mediaType, 'video');
  assert.equal(source.video.audioStreams, 1);
  for (const type of ['cutout', 'plan', 'layer', 'vectorize', 'revise', 'photoshop', 'illustrator'])
    await api(`/api/document/${d.id}/jobs`, { imageId: source.id, type }, 'POST', 400);
  const tampered = structuredClone(d);
  tampered.images[0].video.frameCount++;
  await api(
    `/api/document/${d.id}`,
    { document: tampered, expectedRevision: d.revision },
    'PUT',
    400,
  );
  app.locals.upscaleWorker = async (args: string[]) => {
    assert.equal(args[0], 'video-upscale');
    assert.equal(args[args.indexOf('--input') + 1], assetPath(d.id, source.source));
    const out = args[args.indexOf('--output') + 1],
      poster = path.join(out, 'poster.png'),
      output = path.join(out, 'upscaled.mp4');
    const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--options') + 1], 'utf8'));
    assert.equal(settings.videoFrames, 9);
    await sharp({ create: { width: 80, height: 60, channels: 3, background: 'red' } })
      .png()
      .toFile(poster);
    fs.writeFileSync(output, 'generated MP4');
    return { ...info, width: 80, height: 60, poster, path: output, warnings: [], seconds: 1 };
  };
  const job = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: source.id, type: 'upscale' },
    'POST',
    202,
  );
  const complete = await wait(job.id);
  assert.equal(complete.status, 'completed', complete.message);
  const result = load(d.id).images.find((i) => i.sourceJobId === job.id)!;
  assert.equal(result.parentId, source.id);
  assert.equal(result.mediaType, 'video');
  assert.deepEqual(load(d.id).images[0], source);
  assert.equal(result.video!.frameCount, 12);
  const exported = await fetch(
    `${base}/api/document/${d.id}/export?imageId=${result.id}&format=mp4`,
    { headers },
  );
  assert.equal(exported.status, 200);
  assert.equal(await exported.text(), 'generated MP4');
  await api(`/api/document/${d.id}/export?imageId=${result.id}&format=psd`, undefined, 'GET', 400);
  // A malformed worker result must not leave a success node.
  app.locals.upscaleWorker = async () => ({ path: 'outside.mp4' });
  const bad = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: source.id, type: 'upscale' },
    'POST',
    202,
  );
  assert.equal((await wait(bad.id)).status, 'failed');
  assert.equal(load(d.id).images.length, 2);
  app.locals.upscaleWorker = async (_args: string[], signal: AbortSignal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  const cancelled = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: source.id, type: 'upscale' },
    'POST',
    202,
  );
  await api(`/api/jobs/${cancelled.id}/cancel`, {});
  assert.equal((await wait(cancelled.id)).status, 'cancelled');
  assert.equal(load(d.id).images.length, 2);
});
test('upscale defaults validate, persist and are independent from PSD settings', async () => {
  const before = await fixture();
  const settings = { ...DEFAULT_UPSCALE, scale: 4 };
  await api('/api/upscale-defaults', settings, 'PUT');
  const fresh = await fixture();
  assert.deepEqual(fresh.settings.upscale, settings);
  assert.deepEqual(load(before.id).settings.upscale, DEFAULT_UPSCALE);
  assert.deepEqual(fresh.settings.cutoutOptions, before.settings.cutoutOptions);
  for (const invalid of [
    { videoFrames: 5, videoOverlap: 5 },
    { scale: 3 },
    { seedVaeTile: 256, seedVaeOverlap: 128 },
    { seed: -1 },
  ])
    await api('/api/upscale-defaults', { ...settings, ...invalid }, 'PUT', 400);
  assert.throws(() => upscaleDimensions(4000, 4000, { ...DEFAULT_UPSCALE, scale: 4 }));
  await api('/api/upscale-defaults', DEFAULT_UPSCALE, 'PUT');
});

test('SeedVR2 settings migrate old documents, validate and freeze the selected engine', async () => {
  const { model, seedColor, seedDetail, seedVaeTile, seedVaeOverlap, seedMemory, ...old } =
    DEFAULT_UPSCALE;
  assert.equal(upscaleSchema.parse(old).model, 'seedvr2-7b-int8');
  assert.equal(upscaleSchema.parse(old).seedVaeOverlap, 128);
  for (const invalid of [
    { seedDetail: 1.1 },
    { seedVaeTile: 256, seedVaeOverlap: 128 },
    { model: 'seedvr2-sharp' },
  ])
    assert.equal(upscaleSchema.safeParse({ ...DEFAULT_UPSCALE, ...invalid }).success, false);
  let d = await fixture();
  const source = structuredClone(d.images[0]);
  d.settings.upscale = { ...DEFAULT_UPSCALE, model: 'seedvr2-7b-int8', seedDetail: 0.8 };
  d = await api(`/api/document/${d.id}`, { document: d, expectedRevision: d.revision }, 'PUT');
  app.locals.upscaleWorker = async (args: string[]) => {
    const frozen = JSON.parse(fs.readFileSync(args[args.indexOf('--options') + 1], 'utf8'));
    assert.equal(frozen.model, 'seedvr2-7b-int8');
    assert.equal(frozen.seedDetail, 0.8);
    return fake(args);
  };
  const j = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: source.id, type: 'upscale' },
    'POST',
    202,
  );
  const completed = await wait(j.id);
  assert.equal(completed.status, 'completed');
  assert.equal((completed.result as any).model, 'SeedVR2 7B 标准版 INT8');
  assert.deepEqual(load(d.id).images[0], source);
  assert.match(load(d.id).images.at(-1)!.name, /SeedVR2/);
});
test('upscale freezes current node, preserves alpha and source, returns an exact-size linked node without Codex', async () => {
  let d = await fixture();
  const source = structuredClone(d.images[0]);
  let release!: () => void, called!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (called = r));
  app.locals.upscaleWorker = async (args: string[]) => {
    called();
    await held;
    return fake(args);
  };
  const job = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: source.id, type: 'upscale' },
    'POST',
    202,
  );
  await started;
  assert.equal(job.dispatch, undefined);
  await api(`/api/jobs/${job.id}/claim`, { taskId: d.taskId }, 'POST', 409);
  await api(
    `/api/jobs/${job.id}/apply`,
    { taskId: d.taskId, baseVersion: job.version, layers: [] },
    'POST',
    409,
  );
  d.images[0].opinion = '保留运行中修改';
  d.settings.upscale.scale = 4;
  d = await api(`/api/document/${d.id}`, { document: d, expectedRevision: d.revision }, 'PUT');
  release();
  const done = await wait(job.id);
  assert.equal(done.status, 'completed', done.message);
  const result = load(d.id).images.at(-1)!;
  assert.equal(result.status, 'upscaled');
  assert.equal(result.parentId, source.id);
  assert.equal(result.basedOnOlderVersion, true);
  assert.equal(load(d.id).images[0].opinion, '保留运行中修改');
  assert.deepEqual([result.width, result.height], [80, 60]);
  assert.equal(result.layers.length, 1);
  assert.equal(result.annotations.length, 0);
  assert.equal(dispatches, 0);
  const bytes = fs.readFileSync(assetPath(d.id, result.url));
  const alpha = await sharp(bytes).extractChannel('alpha').raw().toBuffer();
  assert(alpha.every((v) => v === 128));
  const exported = await fetch(
    base + `/api/document/${d.id}/export?imageId=${result.id}&format=png`,
    { headers },
  );
  assert.equal(exported.status, 200);
  assert.equal((await sharp(Buffer.from(await exported.arrayBuffer())).metadata()).width, 80);
});
test('cancel, invalid output and per-layer targeting never create incorrect results', async () => {
  const d = await fixture();
  await api(
    `/api/document/${d.id}/jobs`,
    { imageId: d.images[0].id, type: 'upscale', useOriginal: true },
    'POST',
    400,
  );
  let called!: () => void;
  const started = new Promise<void>((r) => (called = r));
  app.locals.upscaleWorker = async (_: string[], signal: AbortSignal) => {
    called();
    await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
    );
  };
  const j = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: d.images[0].id, type: 'upscale' },
    'POST',
    202,
  );
  await started;
  await api(`/api/jobs/${j.id}/cancel`, {});
  assert.equal((await wait(j.id)).status, 'cancelled');
  app.locals.upscaleWorker = async (args: string[]) => {
    const r = await fake(args);
    await sharp({ create: { width: 20, height: 30, channels: 3, background: 'red' } })
      .png()
      .toFile(r.path);
    return r;
  };
  const bad = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: d.images[0].id, type: 'upscale' },
    'POST',
    202,
  );
  assert.equal((await wait(bad.id)).status, 'failed');
  assert.equal(load(d.id).images.length, 1);
  assert.equal(dispatches, 0);
});
test('preview inputs ignore preview masks; visible result layers override original source', async () => {
  let d = await fixture();
  const im = d.images[0];
  const asset = path.join(process.env.LAYER_CANVAS_DATA!, 'red.png');
  await sharp({ create: { width: 40, height: 30, channels: 4, background: '#ff0000' } })
    .png()
    .toFile(asset);
  const second = await api(`/api/document/${d.id}/import-path`, { taskId: d.taskId, path: asset });
  d = second;
  d.images[0].status = 'preview';
  d.images[0].layers = [
    {
      id: 'preview',
      name: 'mask',
      kind: 'raster',
      url: d.images[1].source,
      x: 0,
      y: 0,
      width: 40,
      height: 30,
      visible: true,
      opacity: 1,
      disposition: 'rebuild',
      opinion: '',
      preview: true,
    },
  ];
  d = await api(`/api/document/${d.id}`, { document: d, expectedRevision: d.revision }, 'PUT');
  let red = false;
  app.locals.upscaleWorker = async (args: string[]) => {
    const px = await sharp(args[args.indexOf('--input') + 1])
      .ensureAlpha()
      .raw()
      .toBuffer();
    assert.equal(px[0], red ? 255 : 52);
    return fake(args);
  };
  const j = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: im.id, type: 'upscale' },
    'POST',
    202,
  );
  assert.equal((await wait(j.id)).status, 'completed');
  d = load(d.id);
  d.images[0].status = 'layered';
  d.images[0].layers[0].preview = false;
  d = await api(`/api/document/${d.id}`, { document: d, expectedRevision: d.revision }, 'PUT');
  red = true;
  const j2 = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: im.id, type: 'upscale' },
    'POST',
    202,
  );
  assert.equal((await wait(j2.id)).status, 'completed');
  assert.equal(load(d.id).images.length, 4);
});

test('layered PSD retains offsets, soft alpha, groups, hidden/empty layers, editable text and annotations after 2x and 4x', async () => {
  for (const scale of [2, 4] as const) {
    let d = await api('/api/document?taskId=upscale_psd_' + crypto.randomUUID());
    function pixels(w: number, h: number, alpha = 128) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) data.set([80, 120, 180, alpha], i);
      return { width: w, height: h, data };
    }
    const psd = writePsdBuffer(
      {
        width: 80,
        height: 60,
        children: [
          { name: '背景', left: 0, top: 0, imageData: pixels(80, 60, 255) },
          {
            name: '主体组',
            children: [
              { name: '超出画幅', left: -7, top: 14, opacity: 0.6, imageData: pixels(31, 27) },
              { name: '隐藏层', left: 55, top: -9, hidden: true, imageData: pixels(28, 19) },
              { name: '空透明层', left: 11, top: 7, imageData: pixels(8, 8, 0) },
              {
                name: '可编辑文字',
                left: 20,
                top: 20,
                imageData: pixels(30, 15, 255),
                effects: {
                  stroke: [
                    {
                      enabled: true,
                      size: { units: 'Pixels', value: 2 },
                      position: 'outside',
                      fillType: 'color',
                      color: { r: 255, g: 0, b: 0 },
                      opacity: 1,
                      blendMode: 'normal',
                    },
                  ],
                  dropShadow: [
                    {
                      enabled: true,
                      size: { units: 'Pixels', value: 3 },
                      distance: { units: 'Pixels', value: 5 },
                      angle: 120,
                      color: { r: 0, g: 0, b: 0 },
                      opacity: 0.5,
                      blendMode: 'multiply',
                      useGlobalLight: false,
                    },
                  ],
                },
                text: {
                  text: '文字 Abc',
                  transform: [1, 0, 0, 1, 20, 30],
                  style: { font: { name: 'Arial' }, fontSize: 12 },
                  styleRuns: [
                    { length: 2, style: { fontSize: 16 } },
                    { length: 4, style: { fontSize: 12 } },
                  ],
                },
              },
            ],
          },
        ],
      },
      { trimImageData: false, generateThumbnail: false },
    );
    const file = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.psd');
    fs.writeFileSync(file, psd);
    d = await api(`/api/document/${d.id}/import-path`, { taskId: d.taskId, path: file });
    const source = d.images[0];
    d.settings.upscale = {
      ...DEFAULT_UPSCALE,
      scale,
      model: 'seedvr2-7b-int8',
    };
    const edge = source.layers.find((l: any) => l.name === '超出画幅');
    edge.frame = { x: -7, y: 14, width: 31, height: 27 };
    edge.opinion = '保持透明边缘';
    source.opinion = '总图意见';
    source.annotations = [
      {
        id: 'mark',
        layerId: edge.id,
        type: 'arrow',
        points: [-3, 18, 12, 25],
        labelPosition: [2, 10],
        text: '边缘',
        color: '#ff0000',
        brushSize: 10,
      },
    ];
    d = await api(`/api/document/${d.id}`, { document: d, expectedRevision: d.revision }, 'PUT');
    let calls = 0;
    app.locals.upscaleWorker = async (args: string[]) => {
      calls++;
      const input = args[args.indexOf('--input') + 1],
        out = args[args.indexOf('--output') + 1];
      const m = await sharp(input).metadata();
      const p = path.join(out, 'upscaled.png');
      await sharp(input)
        .removeAlpha()
        .resize(m.width! * scale, m.height! * scale)
        .png()
        .toFile(p);
      return { path: p, warnings: [], seconds: 0.01 };
    };
    const job = await api(
      `/api/document/${d.id}/jobs`,
      { type: 'upscale', imageId: source.id },
      'POST',
      202,
    );
    const done = await wait(job.id);
    assert.equal(done.status, 'completed', done.message);
    assert.equal(calls, 3, 'all raster layers including hidden; text and empty bypass model');
    const result = load(d.id).images.at(-1)!;
    assert.equal(result.layers.length, source.layers.length);
    assert.equal(result.parentId, source.id);
    assert.deepEqual(
      result.layers.map((l) => l.id),
      source.layers.map((l: any) => l.id),
    );
    const got = result.layers.find((l) => l.id === edge.id)!;
    assert.deepEqual(
      [got.x, got.y, got.width, got.height],
      [-7 * scale, 14 * scale, 31 * scale, 27 * scale],
    );
    assert.equal(got.opacity, edge.opacity);
    assert.equal(got.opinion, edge.opinion);
    assert.equal(result.opinion, '总图意见');
    assert.deepEqual(result.annotations[0].points, [
      -3 * scale,
      18 * scale,
      12 * scale,
      25 * scale,
    ]);
    assert.equal(result.annotations[0].layerId, edge.id);
    const alpha = await sharp(fs.readFileSync(assetPath(d.id, got.url!)))
      .extractChannel('alpha')
      .raw()
      .toBuffer();
    assert(alpha.every((v) => v === 128));
    assert.equal(result.layers.find((l) => l.name === '隐藏层')!.visible, false);
    const r = await fetch(base + `/api/document/${d.id}/export?imageId=${result.id}&format=psd`, {
      headers,
    });
    assert.equal(r.status, 200);
    const round = readPsd(Buffer.from(await r.arrayBuffer()), { useImageData: true });
    assert.deepEqual([round.width, round.height], [80 * scale, 60 * scale]);
    const group = round.children![1];
    assert.equal(group.name, '主体组');
    assert.equal(group.children!.length, 4);
    const text = group.children!.find((l) => l.name === '可编辑文字')!;
    assert.equal(text.text!.text, '文字 Abc');
    assert.equal(text.text!.styleRuns![1].style.fontSize, 12 * scale);
    assert.deepEqual(text.text!.transform, [1, 0, 0, 1, 20 * scale, 30 * scale]);
    assert.equal(text.text!.styleRuns![0].style.fontSize, 16 * scale);
    assert.equal(text.effects!.stroke![0].size!.value, 2 * scale);
    assert.equal(text.effects!.dropShadow![0].size!.value, 3 * scale);
    assert.equal(text.effects!.dropShadow![0].distance!.value, 5 * scale);
    assert.equal(group.children![0].left, -7 * scale);
    assert.equal(group.children![0].top, 14 * scale);
    assert.equal(load(d.id).images[0].width, 80);
  }
});

test('layer failure never publishes partial PSD; unsupported native features fail before GPU work', async () => {
  let d = await fixture();
  d.images[0].status = 'layered';
  d.images[0].layers = [0, 1].map((i) => ({
    id: 'l' + i,
    name: 'layer' + i,
    kind: 'raster',
    url: d.images[0].source,
    x: i * 3,
    y: 0,
    width: 40,
    height: 30,
    visible: true,
    opacity: 1,
    opinion: '',
    disposition: 'keep',
  }));
  d = await api(`/api/document/${d.id}`, { document: d, expectedRevision: d.revision }, 'PUT');
  let calls = 0;
  app.locals.upscaleWorker = async (args: string[]) => {
    if (++calls === 2) throw new Error('second layer failed');
    return fake(args);
  };
  const j = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: d.images[0].id, type: 'upscale' },
    'POST',
    202,
  );
  assert.equal((await wait(j.id)).status, 'failed');
  assert.equal(load(d.id).images.length, 1);
  const file = path.join(process.env.LAYER_CANVAS_DATA!, 'blend.psd');
  fs.writeFileSync(
    file,
    writePsdBuffer({
      width: 10,
      height: 10,
      children: [
        {
          name: '混合层',
          blendMode: 'multiply',
          imageData: { width: 10, height: 10, data: new Uint8ClampedArray(400).fill(255) },
        },
      ],
    }),
  );
  calls = 0;
  const rejected = await api(`/api/document/${d.id}/import-path`, { taskId: d.taskId, path: file }, 'POST', 500);
  assert.match(rejected.error, /混合/);
  assert.equal(calls, 0);
  assert.equal(load(d.id).images.length, 1);
});
