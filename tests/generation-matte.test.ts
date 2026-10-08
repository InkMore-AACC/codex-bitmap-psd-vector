import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { planningLayer } from '../shared/planning.js';
import { generationLayoutSchema } from '../shared/generation.js';
process.env.LAYER_CANVAS_DATA = path.resolve('test-output/aux-matte-' + crypto.randomUUID());
fs.mkdirSync(process.env.LAYER_CANVAS_DATA, { recursive: true });
const { applyGeneratedMatte, applyDualBackdrop, analyzeKnownBackdropRGBA, nearNeutralScalar, MATTE_LUMA_FORMULA, NEAR_NEUTRAL_LIMITS, NEAR_NEUTRAL_V3_LIMITS } = await import('../server/generation-matte.js');
const { app, TOKEN, BRIDGE_TOKEN } = await import('../server/index.js');
const store = await import('../server/store.js');
const { generationState, registeredGeneration } = await import('../server/generation.js');
app.locals.codexSender = async () => ({ delivered: true });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
after(() => { server.closeAllConnections(); server.close(); });
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function post(route: string, body: unknown) {
  const response = await fetch(origin + route, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': TOKEN, 'X-Canvas-Bridge': BRIDGE_TOKEN } });
  return { status: response.status, value: await response.json() as any };
}
async function api(route: string, body: unknown, status = 200) {
  const result = await post(route, body); assert.equal(result.status, status, JSON.stringify(result.value)); return result.value;
}
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const checks = [
  { name: 'visible gap', kind: 'clear', box: [30, 30, 4, 4], maxAlpha: 8, minPassingFraction: 1 },
  { name: 'thin material', kind: 'transmissive', box: [50, 50, 8, 8], minAlpha: 24,
    maxAlpha: 224, minBackgroundResponse: 31, minPassingFraction: 1 },
];
async function image(kind: 'base' | 'gray' | 'white' | 'black' | 'uniform' | 'color', size = 80) {
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, px = x * 80 / size, py = y * 80 / size;
    const support = px >= 8 && px < 72 && py >= 8 && py < 72;
    const hole = px >= 10 && px < 14 && py >= 10 && py < 14;
    const scalar = kind === 'white' ? 255 : kind === 'black' ? 0 : kind === 'uniform' ? support && !hole ? 128 : 0
      : support && !hole ? (px < 16 || py < 16 || px >= 64 || py >= 64 ? 255 : 120 + Math.floor(px) % 17) : 0;
    data.set(kind === 'base' ? [160 + x % 55, 80 + y % 45, 100 + x % 23, support && !hole ? 252 : 0]
      : [scalar, kind === 'color' ? 35 : scalar, scalar, 255], i);
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}
async function fixture(optIn: boolean | 'absent' = true, type = 'layer', extraLayer = false) {
  const d = store.getByTask('aux_fixture_' + crypto.randomUUID());
  const url = store.writeAsset(d.id, await sharp({ create: { width: 120, height: 120, channels: 3, background: '#324859' } }).png().toBuffer(), '.png');
  d.images.push({ id: 'source', name: 'isolated fixture', width: 120, height: 120, x: 0, y: 0,
    source: url, url, status: 'preview', version: 1, annotations: [], opinion: '',
    layers: [planningLayer('cloth', 'cloth', { x: 20, y: 20, width: 80, height: 80 }, 'foreground', ''),
      ...(extraLayer ? [planningLayer('other', 'other', { x: 20, y: 20, width: 80, height: 80 }, 'foreground', '')] : [])] });
  store.save(d);
  const created = await api(`/api/document/${d.id}/jobs`, { imageId: 'source', type }, 202);
  await api(`/api/jobs/${created.id}/claim`, { taskId: d.taskId });
  const j = store.getJob(created.id);
  const layout: any = { layers: [{ sourceLayerIds: ['cloth'], elements: ['cloth'], excludes: 'scene', alphaChecks: checks,
    anchors: [{ name: 'left', point: [40, 60], observation: 'fixture frozen left' },
      { name: 'right', point: [80, 60], observation: 'fixture frozen right' }],
    ...(optIn === 'absent' ? {} : { allowAuxMatte: optIn }) }], relations: [] };
  if (extraLayer) layout.layers.push({sourceLayerIds:['other'],elements:['other'],excludes:'cloth',anchors:[]});
  const route = `/api/jobs/${j.id}/generation`, send = (body: unknown) => api(route, { taskId: d.taskId, ...body as any });
  const reject = async (body: unknown, pattern: RegExp) => {
    const result = await post(route, { taskId: d.taskId, ...body as any });
    assert(result.status >= 400, JSON.stringify(result.value)); assert.match(result.value.error, pattern);
    return result;
  };
  if (type !== 'photoshop') await send({ action: 'layout', layout });
  const folder = path.join(store.dir(d.id), 'jobs', j.id, 'generation');
  return { j, d, layout, send, reject, folder, registry: path.join(folder, 'registry.json') };
}
async function base(f: Awaited<ReturnType<typeof fixture>>, customBytes?: Buffer) {
  const request = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
    purpose: 'real isolated HTTP fixture, not a model call', referenceObservation: 'two frozen corners and thin interior' });
  const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.writeFileSync(tool, customBytes || await image('base'));
  const record = await f.send({ action: 'register', requestId: request.id, path: tool,
    prompt: request.prompt, referencePaths: request.referencePaths });
  if (!customBytes) assert.equal(record.alphaDiagnostics.passed, false);
  return { request, record, tool };
}
async function auxiliary(f: Awaited<ReturnType<typeof fixture>>, b: Awaited<ReturnType<typeof base>>, kind: Parameters<typeof image>[0] = 'gray') {
  const request = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
    matteForGenerationId: b.record.id, purpose: 'independent scalar estimate fixture', referenceObservation: 'not optical truth' });
  const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.writeFileSync(tool, await image(kind));
  const record = await f.send({ action: 'register', requestId: request.id, path: tool,
    prompt: request.prompt, referencePaths: request.referencePaths });
  return { request, record, tool };
}
async function nearImage() {
  const raw = await sharp(await image('gray')).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < raw.length; i += 4) {
    const spread = [0, 1, 1, 1, 2, 2, 3][i / 4 % 7];
    raw[i] = Math.max(0, raw[i] - spread);
  }
  const rare = (40 * 80 + 40) * 4; raw[rare] = raw[rare + 1] - 11;
  return sharp(raw, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer();
}
async function nearAuxiliary(f: Awaited<ReturnType<typeof fixture>>, b: Awaited<ReturnType<typeof base>>,
  encoding: 'near-neutral-luma8-v2' | 'near-neutral-luma8-v3' = 'near-neutral-luma8-v2', bytes?: Buffer) {
  const request = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
    matteForGenerationId: b.record.id, matteEncoding: encoding,
    purpose: 'new encoded neutral PNG fixture, not a model history assertion', referenceObservation: 'raw tint is bounded before scalar conversion' });
  const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.writeFileSync(tool, bytes || await nearImage());
  const record = await f.send({ action: 'register', requestId: request.id, path: tool,
    prompt: request.prompt, referencePaths: request.referencePaths });
  return { request, record, tool };
}
function deriveBody(b: Awaited<ReturnType<typeof base>>, m: Awaited<ReturnType<typeof auxiliary>>) {
  return { action: 'derive-alpha', baseGenerationId: b.record.id, matteId: m.record.id,
    expectedBaseWorkingHash: b.record.workingHash, expectedMatteWorkingHash: m.record.workingHash };
}
async function approveFixture(f: Awaited<ReturnType<typeof fixture>>, r: any, status: 'accepted' | 'needs-revision' = 'accepted') {
  await f.send({ action: 'review', generationId: r.id, comparisonHash: r.comparisonHash,
    elements: [{ name: 'cloth', status: status === 'accepted' ? 'matched' : 'different', observation: '隔离夹具中矩形布材边折保持白色覆盖，内区仍显示彩色条纹；区域失败如实记录' }],
    evidence: { geometry: '夹具布材位于冻结框内，两个基底端点未移动',
      appearance: '夹具RGB每个通道与登记基底一致，中部颜色条纹保持',
      isolation: '透明孔隙保留为零，夹具中部灰阶使深浅底响应达到冻结要求', candidateIds: [r.id] },
    review: { status, attempts: [{ method: '隔离PNG夹具数值与像素核验', observation: '这是接口测试批准，不是真实海报视觉批准' }],
      issues: status === 'accepted' ? [] : [{ message: '实际opaque覆盖下限失败，保留红层并修正材质估计' }] } });
  const c = await f.send({ action: 'composite', generationIds: [r.id] });
  await f.send({ action: 'review-composite', comparisonHash: c.comparisonHash,
    layers: [{ generationId: r.id, status: status === 'accepted' ? 'matched' : 'different', observation: '夹具在真实输出坐标完整放置，透明孔隙和中部纹理保持；实体覆盖失败仍如实红标' }], relations: [] });
  return { taskId: f.j.taskId, baseVersion: f.j.version,
    layers: [{ id: 'cloth', name: 'cloth', ...r.frame, path: r.originalPath, generationId: r.id }] };
}

async function sparseChroma() {
  const data = await sharp(await nearImage()).ensureAlpha().raw().toBuffer();
  data.set([58, 60, 125, 255], (40 * 80 + 40) * 4);
  return sharp(data, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer();
}
const opaqueCheck = { name: 'dark solid and inherent print', kind: 'opaque', box: [40, 40, 4, 4],
  minAlpha: 255, minPassingFraction: 1 };
async function withOpaque(bytes: Buffer, alpha: number, scalar = false) {
  const data = await sharp(bytes).ensureAlpha().raw().toBuffer();
  for (let y = 20; y < 24; y++) for (let x = 20; x < 24; x++)
    data.set(scalar ? [alpha, alpha, alpha, 255] : [8, 9, 10, alpha], (y * 80 + x) * 4);
  return sharp(data, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer();
}

const backdrop = { version: 1, color: '#808080', space: 'srgb-byte-v1' } as const;
test('C57 fixed-equation diagnostics separate empty-background mismatch from material coverage deficit without repairs', () => {
  const rgb = Buffer.from([128,128,128,255, 124,124,124,255, 0,0,0,255, 255,255,255,255, 0,0,0,255]);
  const mask = Buffer.from([0,0,0,255, 0,0,0,255, 0,0,0,255, 64,64,64,255, 255,255,255,255]);
  const before = [Buffer.from(rgb),Buffer.from(mask)],r=analyzeKnownBackdropRGBA(rgb,mask,5,1);
  assert.equal(r.zeroAlphaPixels,3);assert.equal(r.incompatibleZeroAlpha,2);assert.equal(r.incompatibleMaterial,1);
  assert.equal(r.maxRecompositionError,128);assert.equal(r.compatible,false);
  assert.equal(r.examples.find(e=>e.x===2)?.minimumFeasibleAlpha,255);
  assert.equal(r.examples.find(e=>e.x===3)?.minimumFeasibleAlpha,255);
  assert.deepEqual([rgb,mask],before);assert.throws(()=>analyzeKnownBackdropRGBA(rgb,mask,4,1),/同尺寸/);
  const colored=Buffer.from(mask);colored[1]=1;assert.throws(()=>analyzeKnownBackdropRGBA(rgb,colored,5,1),/严格/);
});

async function dualFixture() {
  const mask = await sharp(await image('gray')).ensureAlpha().raw().toBuffer();
  const black = Buffer.alloc(mask.length), white = Buffer.alloc(mask.length);
  for (let i = 0; i < mask.length; i += 4) {
    const x = (i / 4) % 80, y = Math.floor(i / 4 / 80), ink = x >= 20 && x < 24 && y >= 20 && y < 24;
    const m = ink ? 255 : mask[i], a = m / 255, fg = ink ? [0,0,0] : [180,60,90];
    black.set([...fg.map(v => Math.round(a * v)),255],i);
    white.set([...fg.map(v => Math.round(a * v + 255 - m)),255],i);
  }
  const png = (b: Buffer) => sharp(b,{raw:{width:80,height:80,channels:4}}).png().toBuffer();
  return { black,white,blackPNG:await png(black),whitePNG:await png(white),png };
}
test('C58 two actual composite equations preserve black opaque ink, colored thin material and clear gaps without a brightness mask', async () => {
  const p=await dualFixture(),before=[Buffer.from(p.black),Buffer.from(p.white)],r=await applyDualBackdrop(p.blackPNG,p.whitePNG);
  const out=await sharp(r.bytes).ensureAlpha().raw().toBuffer();
  assert.deepEqual(out.subarray((20*80+20)*4,(20*80+20)*4+4),Buffer.from([0,0,0,255]));
  assert.equal(out[(10*80+10)*4+3],0);assert(out[(30*80+30)*4+3]>24&&out[(30*80+30)*4+3]<224);
  assert(r.unmix.maxRecompositionError<=1);assert.deepEqual([p.black,p.white],before);
  const wrong=Buffer.from(p.white);wrong.set([255,0,255,255],(30*80+30)*4);
  await assert.rejects(applyDualBackdrop(p.blackPNG,await p.png(wrong)),/不相容/);
  await assert.rejects(applyDualBackdrop(p.blackPNG,await sharp(p.whitePNG).resize(79,80).png().toBuffer()),/同尺寸/);
  wrong.set([255,255,255,254],0);await assert.rejects(applyDualBackdrop(p.blackPNG,await p.png(wrong)),/alpha255/);
});
test('C58 HTTP freezes black/white roles, refuses raw candidates and wrong encoding, and rechecks both inputs on consumption', async () => {
  const f=await fixture(),p=await dualFixture();f.layout.layers[0].matteBackdrop={version:2,color:'#000000',space:'srgb-byte-v1'};
  await f.reject({action:'layout',layout:f.layout},/覆盖区域/);
  f.layout.layers[0].alphaChecks=[...checks,{name:'inherent black print',kind:'occupied',box:[40,40,4,4],minAlpha:250,minPassingFraction:1}];
  await f.send({action:'layout',layout:f.layout});const b=await base(f,p.blackPNG);
  assert.match(b.request.prompt,/#000000/);assert.equal(b.request.transparent_background,false);
  await f.reject({action:'prepare',sourceLayerIds:['cloth'],elements:['cloth'],matteForGenerationId:b.record.id,
    purpose:'wrong gray method',referenceObservation:'must not migrate'},/白底RGB编码/);
  const q=await f.send({action:'prepare',sourceLayerIds:['cloth'],elements:['cloth'],matteForGenerationId:b.record.id,
    matteEncoding:'white-composite-rgb8-v1',purpose:'engineering composite pair',referenceObservation:'same geometry and inherent ink'});
  assert.match(q.prompt,/彩色白底合成图/);assert.doesNotMatch(q.prompt,/只输出自身完全不透明的8位灰阶/);
  const tool=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');fs.writeFileSync(tool,p.whitePNG);
  const m={request:q,tool,record:await f.send({action:'register',requestId:q.id,path:tool,prompt:q.prompt,referencePaths:q.referencePaths})};
  assert.equal(m.record.encodingProof,undefined);
  await f.reject({action:'composite',generationIds:[b.record.id]},/不是最终透明层/);
  const r=await f.send(deriveBody(b,m));assert.equal(r.derivedAlpha.algorithm,'black-white-composite-unmix-v1');
  assert.equal(r.alphaDiagnostics.passed,true);assert.equal(r.review,undefined);
  registeredGeneration(f.j,r.id,['cloth'],r.frame);await f.send({action:'composite',generationIds:[r.id]});
  for(const change of ['algorithm','encoding','backdrop'] as const){const saved=generationState(f.j),s:any=structuredClone(saved);
    if(change==='algorithm')s.outputs[1].derivedAlpha.algorithm='known-backdrop-unmix-gray-v2';
    if(change==='encoding')delete s.auxiliaries[0].matteEncoding;
    if(change==='backdrop')s.layout.layers[0].matteBackdrop={version:1,color:'#808080',space:'srgb-byte-v1'};
    store.atomic(f.registry,s);try{await f.reject({action:'composite',generationIds:[r.id]},/来源|编码|登记|算法|底色|派生|灰阶/);}finally{store.atomic(f.registry,s);}
  }
  fs.writeFileSync(m.record.originalPath,await image('white'));
  await f.reject({action:'composite',generationIds:[r.id]},/变化|文件|摘要/);
});
test('C58 white background errors and generated ink omission cannot become approved coverage', async () => {
  const f=await fixture(),p=await dualFixture();f.layout.layers[0].matteBackdrop={version:2,color:'#000000',space:'srgb-byte-v1'};
  f.layout.layers[0].alphaChecks=[...checks,{name:'black print',kind:'occupied',box:[40,40,4,4],minAlpha:250,minPassingFraction:1}];
  await f.send({action:'layout',layout:f.layout});const b=await base(f,p.blackPNG);
  const q=await f.send({action:'prepare',sourceLayerIds:['cloth'],elements:['cloth'],matteForGenerationId:b.record.id,
    matteEncoding:'white-composite-rgb8-v1',purpose:'negative white proof',referenceObservation:'same ink'});
  const wrong=Buffer.from(p.white);for(let y=10;y<14;y++)for(let x=10;x<14;x++)wrong.set([245,245,245,255],(y*80+x)*4);
  const tool=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');fs.writeFileSync(tool,await p.png(wrong));
  const m={record:await f.send({action:'register',requestId:q.id,path:tool,prompt:q.prompt,referencePaths:q.referencePaths}),request:q,tool};
  const saved=generationState(f.j);await f.reject(deriveBody(b,m),/clear区域/);assert.deepEqual(generationState(f.j),saved);
  // Pair equations alone cannot detect a omitted neutral-black feature; frozen
  // occupied checks are therefore mandatory and remain separate from optics.
  const omitted=Buffer.from(p.white);for(let y=20;y<24;y++)for(let x=20;x<24;x++)omitted.set([255,255,255,255],(y*80+x)*4);
  const result=await applyDualBackdrop(p.blackPNG,await p.png(omitted));
  assert.equal((await sharp(result.bytes).ensureAlpha().raw().toBuffer())[(20*80+20)*4+3],0);
  const omittedTool=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');fs.writeFileSync(omittedTool,await p.png(omitted));
  const omittedRecord=await f.send({action:'register',requestId:q.id,path:omittedTool,prompt:q.prompt,referencePaths:q.referencePaths});
  const failedCoverage=await f.send({...deriveBody(b,m),matteId:omittedRecord.id,expectedMatteWorkingHash:omittedRecord.workingHash});
  assert.equal(failedCoverage.alphaDiagnostics.passed,false);assert.equal(failedCoverage.review,undefined);
});

test('C59 persists actual incompatibility without a generated layer and blocks duplicate white calls or derivation on that base only', async () => {
  const f=await fixture(),p=await dualFixture();f.layout.layers[0].matteBackdrop={version:2,color:'#000000',space:'srgb-byte-v1'};
  f.layout.layers[0].alphaChecks=[...checks,{name:'black print',kind:'occupied',box:[40,40,4,4],minAlpha:240,minPassingFraction:1}];
  await f.send({action:'layout',layout:f.layout});const b=await base(f,p.blackPNG);
  const prepare={action:'prepare',sourceLayerIds:['cloth'],elements:['cloth'],matteForGenerationId:b.record.id,
    matteEncoding:'white-composite-rgb8-v1',purpose:'two composites geometry mismatch fixture',referenceObservation:'immutable engineering fixture'};
  const q=await f.send(prepare),wrong=Buffer.from(p.white);wrong.set([255,0,255,255],(30*80+30)*4);
  const tool=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');fs.writeFileSync(tool,await p.png(wrong));
  const m={request:q,tool,record:await f.send({action:'register',requestId:q.id,path:tool,prompt:q.prompt,referencePaths:q.referencePaths})};
  const preserved=[hash(b.record.originalPath),hash(b.record.workingPath),hash(m.record.originalPath),hash(m.record.workingPath)];
  await f.reject(deriveBody(b,m),/双背景颜色\/几何不相容/);
  const s=generationState(f.j);assert.equal(s.outputs.length,1);assert.equal(s.matteFailures?.length,1);
  const failure=s.matteFailures![0];assert.equal(failure.baseGenerationId,b.record.id);assert.equal(failure.matteId,m.record.id);
  assert.equal(hash(failure.diagnosticPath),failure.diagnosticHash);
  const report=JSON.parse(fs.readFileSync(failure.diagnosticPath,'utf8'));assert.equal(report.generatedRGBA,false);assert(report.diagnostic.incompatiblePixels>0);
  await f.reject(prepare,/已有真实不相容失败记录/);assert.deepEqual(generationState(f.j),s);
  await f.reject(deriveBody(b,m),/相同双输入已保存/);assert.deepEqual(generationState(f.j),s);
  assert.deepEqual([hash(b.record.originalPath),hash(b.record.workingPath),hash(m.record.originalPath),hash(m.record.workingPath)],preserved);
  const other=await fixture(),ordinary=await base(other);await auxiliary(other,ordinary);
  assert.equal(generationState(other.j).matteFailures,undefined);
});
async function backdropFixture() {
  const f = await fixture(); f.layout.layers[0].matteBackdrop = backdrop;
  await f.send({ action: 'layout', layout: f.layout }); return f;
}
/** Independent numeric ground truth, never passed off as a model output. */
async function blendedFixture() {
  const matte = await image('gray'), mask = await sharp(matte).ensureAlpha().raw().toBuffer();
  const composite = Buffer.alloc(mask.length), foreground = Buffer.alloc(mask.length);
  for (let i = 0; i < mask.length; i += 4) {
    const a = mask[i] / 255, rgb = [210 + (i / 4) % 25, 70 + Math.floor(i / 320) % 25, 95];
    foreground.set([...rgb, mask[i]], i);
    composite.set([...rgb.map(v => Math.round(a * v + (1 - a) * 128)), 255], i);
  }
  const bytes = await sharp(composite, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer();
  return { bytes, matte, mask, composite, foreground };
}
test('C57 refuses further matte requests when actual frozen clear RGB violates known backdrop; legacy remains unchanged', async () => {
  const f=await backdropFixture(),input=await blendedFixture(),raw=Buffer.from(input.composite);
  for(let y=10;y<14;y++)for(let x=10;x<14;x++)raw.set([124,124,124,255],(y*80+x)*4);
  const bytes=await sharp(raw,{raw:{width:80,height:80,channels:4}}).png().toBuffer(),b=await base(f,bytes),before=generationState(f.j);
  await f.reject({action:'prepare',sourceLayerIds:['cloth'],elements:['cloth'],matteForGenerationId:b.record.id,
    purpose:'must stop before another model call',referenceObservation:'RGB itself violates known clear background'},/必要条件失败.*clear区域/);
  assert.deepEqual(generationState(f.j),before);assert.equal(before.auxiliaries?.length||0,0);
  const old=await fixture(),ordinary=await base(old);const m=await auxiliary(old,ordinary);
  assert.equal(m.request.role,'aux-matte');assert.equal(m.request.matteFeasibility.knownBackdrop,undefined);
});
test('C56 unmix recovers foreground RGB and alpha with bounded re-composition while legacy preserves RGB', async () => {
  const input = await blendedFixture(), result = await applyGeneratedMatte(input.bytes, input.matte, backdrop);
  assert(result.unmix && result.unmix.maxRecompositionError <= 2); assert(result.unmix.zeroAlphaPixels > 0);
  const out = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < out.length; i += 4) {
    const a = input.mask[i] / 255; assert.equal(out[i + 3], input.mask[i]);
    for (let c = 0; c < 3; c++) {
      assert(Math.abs(a * out[i + c] + (1 - a) * 128 - input.composite[i + c]) <= 2);
      if (a) assert(Math.abs(out[i + c] - input.foreground[i + c]) <= 2);
      else assert.equal(out[i + c], 0);
    }
  }
  assert.notDeepEqual(out.subarray((40 * 80 + 40) * 4, (40 * 80 + 40) * 4 + 3),
    input.composite.subarray((40 * 80 + 40) * 4, (40 * 80 + 40) * 4 + 3));
  const legacy = await applyGeneratedMatte(input.bytes, input.matte), old = await sharp(legacy.bytes).ensureAlpha().raw().toBuffer();
  assert.equal(legacy.unmix, undefined);
  for (let i = 0; i < old.length; i += 4) assert.deepEqual(old.subarray(i, i + 3), input.composite.subarray(i, i + 3));
});
test('C56 HTTP two real-role registrations derive only after freezing backdrop; raw RGB cannot be a final layer', async () => {
  const f = await backdropFixture(), input = await blendedFixture(), b = await base(f, input.bytes);
  assert.equal(b.request.transparent_background, false); assert.deepEqual(b.request.matteBackdrop, backdrop);
  assert.equal(b.record.kind, 'matte-rgb-base'); assert.equal(b.record.matteBackdropRaw.hash, b.record.hash);
  assert.match(b.request.prompt, /#808080|中灰/); assert.doesNotMatch(b.request.prompt, /其他区域真透明/);
  const originals = [hash(b.tool), hash(b.record.originalPath), hash(store.assetPath(f.d.id, f.j.snapshot.source))];
  await f.reject({ action: 'composite', generationIds: [b.record.id] }, /不是最终透明层/);
  assert.throws(() => registeredGeneration(f.j, b.record.id, ['cloth'], b.record.frame), /不是最终透明层/);
  const m = await auxiliary(f, b), r = await f.send(deriveBody(b, m));
  assert.equal(r.derivedAlpha.algorithm, 'known-backdrop-unmix-gray-v2'); assert(r.derivedAlpha.unmix.maxRecompositionError <= 2);
  assert.deepEqual(r.derivedAlpha.binding.matteBackdrop, backdrop); assert.equal(r.alphaDiagnostics.passed, true);
  assert.equal(r.receipt.tool, 'derived-alpha'); assert.equal(r.review, undefined);
  registeredGeneration(f.j, r.id, ['cloth'], r.frame);
  await f.send({ action: 'composite', generationIds: [r.id] });
  assert.deepEqual([hash(b.tool), hash(b.record.originalPath), hash(store.assetPath(f.d.id, f.j.snapshot.source))], originals);
  for (const mutation of ['kind', 'raw-proof', 'algorithm', 'unmix-proof', 'backdrop'] as const) {
    const before = generationState(f.j), changed: any = structuredClone(before);
    if (mutation === 'kind') { delete changed.outputs[0].kind; delete changed.outputs[0].alphaDiagnostics; }
    if (mutation === 'raw-proof') changed.outputs[0].matteBackdropRaw.size.width++;
    if (mutation === 'algorithm') changed.outputs[1].derivedAlpha.algorithm = 'min-alpha-direct-gray-v1';
    if (mutation === 'unmix-proof') changed.outputs[1].derivedAlpha.unmix.maxRecompositionError = -1;
    if (mutation === 'backdrop') changed.requests[0].matteBackdrop.color = '#ffffff';
    store.atomic(f.registry, changed);
    try { await f.reject({ action: 'composite', generationIds: [r.id] }, /基底|证明|派生|底色|算法/); }
    finally { store.atomic(f.registry, before); }
  }
});
test('C56 freeze is before first prepare; no retrofit, callers cannot supply curves or change the background', async () => {
  const f = await fixture(); await base(f);
  f.layout.layers[0].matteBackdrop = backdrop;
  await f.reject({ action: 'layout', layout: f.layout }, /首次prepare/);
  const fresh = await backdropFixture();
  await fresh.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteBackdrop: backdrop,
    purpose: 'caller cannot inject backdrop', referenceObservation: 'layout only' }, /只能在首次prepare/);
  const b = await base(fresh, (await blendedFixture()).bytes), m = await auxiliary(fresh, b);
  await fresh.reject({ ...deriveBody(b, m), opacity: 0.5 }, /固定min/);
  const s = generationState(fresh.j);
  for (const value of [{ ...backdrop, color: '#ffffff' }, { ...backdrop, space: 'linear' }, { ...backdrop, curve: 1 }]) {
    const layout = structuredClone(fresh.layout); layout.layers[0].matteBackdrop = value;
    await fresh.reject({ action: 'layout', layout }, /输入格式|首次prepare/);
    assert.deepEqual(generationState(fresh.j), s);
  }
});
test('C56 refuses incompatible background/matte and weak raw alpha before resizing can hide it', async () => {
  const input = await blendedFixture(), raw = Buffer.from(input.composite);
  raw.set([32, 128, 128, 255], 0);
  await assert.rejects(applyGeneratedMatte(await sharp(raw, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer(),
    input.matte, backdrop), /不相容/);
  raw.set([128, 128, 128, 255], 0); raw.set([255, 0, 0, 255], (40 * 80 + 40) * 4);
  await assert.rejects(applyGeneratedMatte(await sharp(raw, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer(),
    input.matte, backdrop), /不相容/);
  const f = await backdropFixture(), q = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
    purpose: 'raw weak alpha validation', referenceObservation: 'single weak corner cannot be lost' });
  const large = Buffer.alloc(1500 * 1500 * 4).fill(Buffer.from([128, 128, 128, 255])); large[3] = 254;
  const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  fs.writeFileSync(tool, await sharp(large, { raw: { width: 1500, height: 1500, channels: 4 } }).png().toBuffer());
  const before = generationState(f.j);
  await f.reject({ action: 'register', requestId: q.id, path: tool, prompt: q.prompt, referencePaths: q.referencePaths }, /完整原件.*alpha255/);
  assert.deepEqual(generationState(f.j), before); assert.equal((await sharp(fs.readFileSync(tool)).metadata()).width, 1500);
});
test('C56 preserves ordinary-only guards and refuses raw RGB aliases in another role', async () => {
  for (const mutate of [(l: any) => { l.allowAuxMatte = false; }, (l: any) => { l.alphaChecks = [checks[1]]; },
    (l: any) => { l.blendMode = 'screen'; }, (l: any) => { l.content = 'light'; }]) {
    const f = await fixture(); f.layout.layers[0].matteBackdrop = backdrop; mutate(f.layout.layers[0]);
    await f.reject({ action: 'layout', layout: f.layout }, /底色|aux-matte|光效|输入格式/);
  }
  const ps = await fixture(true, 'photoshop');
  await ps.reject({ action: 'derive-alpha', baseGenerationId: crypto.randomUUID(), matteId: crypto.randomUUID(),
    expectedBaseWorkingHash: 'a'.repeat(64), expectedMatteWorkingHash: 'b'.repeat(64) }, /unsupported/);
  const f = await backdropFixture(), b = await base(f, (await blendedFixture()).bytes), before = generationState(f.j);
  const copy = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  fs.writeFileSync(copy, await sharp(fs.readFileSync(b.record.originalPath)).png({ compressionLevel: 9 }).toBuffer());
  await f.reject({ action: 'register', requestId: b.request.id, path: copy, prompt: b.request.prompt,
    referencePaths: b.request.referencePaths }, /角色文件.*冒充image_gen/);
  assert.deepEqual(generationState(f.j), before);
});

test('v6 near-neutral v3 removes only the global cap; raw integer mean, tail, alpha and bit-depth remain fixed', async (t) => {
  const sparse = await sparseChroma(); await assert.rejects(nearNeutralScalar(sparse), /固定16/);
  const parsed = await nearNeutralScalar(sparse, 'near-neutral-luma8-v3');
  assert.equal(parsed.proof.encoding, 'near-neutral-luma8-v3'); assert.equal(parsed.proof.statistics.maxSpread, 67);
  assert.deepEqual(parsed.proof.limits, NEAR_NEUTRAL_V3_LIMITS); assert(!Object.hasOwn(parsed.proof.limits, 'maxSpread'));
  const before = await sharp(sparse).ensureAlpha().raw().toBuffer(), after = await sharp(parsed.scalarBytes).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < before.length; i += 4) assert.deepEqual([...after.subarray(i, i + 4)],
    [Math.round((2126 * before[i] + 7152 * before[i + 1] + 722 * before[i + 2]) / 10000)].flatMap(m => [m, m, m, 255]));
  for (const c of [
    { name: 'mean2', pixels: 1000, edit: (d: Buffer) => { for (let i = 0; i < d.length; i += 4) d[i] = 130; }, pass: true },
    { name: 'mean2plus', pixels: 1000, edit: (d: Buffer) => { for (let i = 0; i < d.length; i += 4) d[i] = 130; d[0]++; }, pass: false },
    { name: 'tail1of1000-max255', pixels: 1000, edit: (d: Buffer) => d.set([255, 0, 0, 255], 0), pass: true },
    { name: 'tail2of1000', pixels: 1000, edit: (d: Buffer) => { d.set([255, 0, 0, 255], 0); d.set([255, 0, 0, 255], 4); }, pass: false },
    { name: 'tail1of999', pixels: 999, edit: (d: Buffer) => d.set([255, 0, 0, 255], 0), pass: false },
    { name: 'alpha254', pixels: 1000, edit: (d: Buffer) => { d[3] = 254; }, pass: false },
    { name: 'significant-color', pixels: 1000, edit: (d: Buffer) => { for (let i = 0; i < d.length; i += 4) d.set([128, 80, 128, 255], i); }, pass: false },
  ]) await t.test(c.name, async () => {
    const raw = Buffer.alloc(c.pixels * 4).fill(Buffer.from([128, 128, 128, 255])); c.edit(raw);
    const png = await sharp(raw, { raw: { width: c.pixels, height: 1, channels: 4 } }).png().toBuffer();
    if (c.pass) await nearNeutralScalar(png, 'near-neutral-luma8-v3');
    else await assert.rejects(nearNeutralScalar(png, 'near-neutral-luma8-v3'), /固定2|99.9%|alpha必须255/);
  });
  const highDepth = await sharp(sparse).toColourspace('rgb16').png().toBuffer();
  assert.equal((await sharp(highDepth).metadata()).depth, 'ushort');
  await assert.rejects(nearNeutralScalar(highDepth, 'near-neutral-luma8-v3'), /8位PNG/);
});

test('v6 HTTP explicit v3 raw/scalar/derived retains role identities and RGB0 while v2 and absence stay rejected', async () => {
  const f = await fixture(), b = await base(f), raw = await sparseChroma();
  const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.writeFileSync(tool, raw);
  for (const encoding of [undefined, 'near-neutral-luma8-v2']) {
    const request = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: b.record.id,
      ...(encoding ? { matteEncoding: encoding } : {}), purpose: 'old semantic fixture', referenceObservation: 'old request cannot change after actual PNG' });
    const prior = generationState(f.j);
    await f.reject({ action: 'register', requestId: request.id, path: tool, prompt: request.prompt, referencePaths: request.referencePaths }, /灰阶|固定16/);
    assert.deepEqual(generationState(f.j), prior);
    await f.reject({ action: 'register', requestId: request.id, path: tool, prompt: request.prompt, referencePaths: request.referencePaths,
      matteEncoding: 'near-neutral-luma8-v3' }, /只能在aux prepare/);
  }
  const m = await nearAuxiliary(f, b, 'near-neutral-luma8-v3', raw), r = await f.send(deriveBody(b, m));
  assert.equal(m.request.matteBinding.matteEncoding, 'near-neutral-luma8-v3');
  assert.equal(m.record.encodingProof.encoding, 'near-neutral-luma8-v3'); assert.equal(r.derivedAlpha.matteEncoding, 'near-neutral-luma8-v3');
  assert.equal(r.review, undefined); assert.equal(r.receipt.matteEncoding, 'near-neutral-luma8-v3');
  assert.deepEqual(fs.readFileSync(m.record.originalPath), raw);
  const before = await sharp(fs.readFileSync(b.record.workingPath)).ensureAlpha().raw().toBuffer(), mask = await sharp(fs.readFileSync(m.record.workingPath)).ensureAlpha().raw().toBuffer();
  const after = await sharp(fs.readFileSync(r.workingPath)).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < after.length; i += 4) { assert.deepEqual(after.subarray(i, i + 3), before.subarray(i, i + 3)); assert.equal(after[i + 3], Math.min(before[i + 3], mask[i])); }
  for (const file of [m.record.originalPath, m.record.workingPath, r.workingPath]) {
    const alias = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
    fs.writeFileSync(alias, await sharp(fs.readFileSync(file)).withMetadata({ density: 72 }).png({ compressionLevel: 1 }).toBuffer());
    await f.reject({ action: 'register', requestId: b.request.id, path: alias, prompt: b.request.prompt, referencePaths: b.request.referencePaths }, /角色文件.*冒充image_gen/);
  }
});

test('v6 HTTP v3 proof cache cannot endorse v2, absent encoding, changed limits or later opaque rules', async () => {
  const f = await fixture(), b = await base(f), m = await nearAuxiliary(f, b, 'near-neutral-luma8-v3', await sparseChroma());
  const r = await f.send(deriveBody(b, m)); await approveFixture(f, r); const stable = generationState(f.j);
  for (const edit of [
    (s: any) => { s.auxiliaries[0].encodingProof.limits.maxSpread = 16; },
    (s: any) => { s.auxiliaries[0].encodingProof.statistics.materialOutliers = 0; },
    (s: any) => { s.requests.find((q: any) => q.id === m.request.id).matteEncoding = 'near-neutral-luma8-v2'; },
    (s: any) => {
      const aux = s.auxiliaries[0], req = s.requests.find((q: any) => q.id === m.request.id), out = s.outputs.find((q: any) => q.id === r.id);
      for (const obj of [aux, aux.binding, aux.receipt, req, req.matteBinding, out.derivedAlpha, out.receipt]) obj.matteEncoding = 'near-neutral-luma8-v2';
      aux.encodingProof.encoding = 'near-neutral-luma8-v2'; aux.encodingProof.limits = NEAR_NEUTRAL_LIMITS;
    },
    (s: any) => {
      const aux = s.auxiliaries[0], req = s.requests.find((q: any) => q.id === m.request.id), out = s.outputs.find((q: any) => q.id === r.id);
      for (const obj of [aux, aux.binding, aux.receipt, req, req.matteBinding, out.derivedAlpha, out.receipt]) delete obj.matteEncoding;
      delete aux.encodingProof;
    },
    (s: any) => { s.layout.layers[0].alphaChecks.push(opaqueCheck); },
  ]) {
    const modified = structuredClone(stable); edit(modified); store.atomic(f.registry, modified);
    await f.reject({ action: 'composite', generationIds: [r.id] }, /证明|变化|不一致|灰阶|固定16/);
    assert.equal(generationState(f.j).outputs.find(o => o.id === r.id)!.review, undefined);
    assert.equal(generationState(f.j).composite, undefined); store.atomic(f.registry, stable);
  }
  await f.reject({ action: 'layout', layout: { ...f.layout, layers: [{ ...f.layout.layers[0], alphaChecks: [...checks, opaqueCheck] }] } }, /已有真实候选/);
});

test('v6 HTTP v3 register and derive source/registry CAS still preserve concurrent records and artifacts', async (t) => {
  for (const phase of ['register', 'derive'] as const) for (const target of ['source', 'registry'] as const) await t.test(phase + '-' + target, async () => {
    const f = await fixture(), b = await base(f), request = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
      matteForGenerationId: b.record.id, matteEncoding: 'near-neutral-luma8-v3', purpose: 'snapshot fixture', referenceObservation: 'real files and latest registry' });
    const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.writeFileSync(tool, await sparseChroma());
    const register = { action: 'register', requestId: request.id, path: tool, prompt: request.prompt, referencePaths: request.referencePaths };
    const m = phase === 'derive' ? { record: await f.send(register) } : undefined;
    const stable = generationState(f.j), write = fs.writeFileSync; let fired = false, artifact = '', changed: any;
    fs.writeFileSync = ((p: any, ...args: any[]) => {
      const result = Reflect.apply(write, fs, [p, ...args]);
      if (!fired && typeof p === 'string' && (phase === 'derive' ? path.basename(p) === 'derived.png' :
          p.includes(path.sep + 'aux-') && path.basename(p) === 'working.png')) {
        fired = true; artifact = p;
        if (target === 'source') fs.appendFileSync(phase === 'register' ? tool : m!.record.originalPath, 'source changed');
        else { changed = { ...stable, v6ConcurrentMarker: 'preserve latest' }; store.atomic(f.registry, changed); }
      } return result;
    }) as typeof fs.writeFileSync;
    try {
      await f.reject(phase === 'register' ? register : deriveBody(b, m as any), /变化|改变/);
      assert(fired); assert(fs.existsSync(artifact)); assert.deepEqual(generationState(f.j), target === 'registry' ? changed : stable);
    } finally { fs.writeFileSync = write; }
  });
});

test('v6 HTTP opaque is ordinary opt-in only, cannot retroactively alter rules and preserves legacy absence', async () => {
  const f = await fixture(), layout = { ...f.layout, layers: [{ ...f.layout.layers[0], alphaChecks: [...checks, opaqueCheck] }] };
  await f.send({ action: 'layout', layout });
  for (const invalid of [{ ...opaqueCheck, minAlpha: 0 }, { ...opaqueCheck, minAlpha: 256 },
    { ...opaqueCheck, minPassingFraction: 0 }, { ...opaqueCheck, maxAlpha: 255 },
    { ...opaqueCheck, minBackgroundResponse: 0 }, { ...opaqueCheck, box: [0, 0, 4, 4] }])
    await f.reject({ action: 'layout', layout: { ...layout, layers: [{ ...layout.layers[0], alphaChecks: [invalid] }] } }, /输入格式|来源层冻结框/);
  const screen = structuredClone(layout); screen.layers[0].blendMode = 'screen'; screen.layers[0].content = 'light-effect';
  await f.reject({ action: 'layout', layout: screen }, /opaque.*PS、screen、背景及旧流程/);
  for (const target of ['photoshop', 'background', 'old-workflow', 'old-protocol'] as const) {
    const original = store.getJob(f.j.id), changed = structuredClone(original);
    if (target === 'photoshop') changed.type = 'photoshop'; if (target === 'background') changed.snapshot.layers[0].role = 'background';
    if (target === 'old-workflow') delete changed.reconstructionWorkflowVersion; if (target === 'old-protocol') delete changed.reconstructionVersion;
    store.saveJob(changed); await f.reject({ action: 'layout', layout }, /opaque.*PS、screen、背景及旧流程/); store.saveJob(original);
  }
  const b = await base(f, await withOpaque(await image('base'), 255));
  assert.deepEqual(b.request.alphaChecks.at(-1), opaqueCheck); assert.match(b.request.prompt, /实体覆盖率.*固有印字/);
  assert.equal(b.record.alphaDiagnostics.checks.at(-1).passingPixels, 16);
  await f.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], alphaChecks: [opaqueCheck],
    purpose: 'cannot inject', referenceObservation: 'must freeze in layout' }, /只能在冻结layout/);
  const old = await fixture('absent'), oldLayout = structuredClone(old.layout); delete oldLayout.layers[0].alphaChecks;
  await old.send({ action: 'layout', layout: oldLayout }); const legacy = await base(old, await image('base'));
  assert.equal(legacy.request.alphaChecks, undefined); assert.equal(legacy.record.alphaDiagnostics, undefined);
  assert(!Object.hasOwn(generationState(old.j).layout!.layers[0], 'alphaChecks'));
  const late = await fixture('absent'), request = await late.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
    purpose: 'before new entity rule', referenceObservation: 'original clear/trans criteria frozen' });
  await late.send({ action: 'layout', layout: { ...late.layout, layers: [{ ...late.layout.layers[0], alphaChecks: [...checks, opaqueCheck] }] } });
  const file = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.writeFileSync(file, await image('base'));
  await late.reject({ action: 'register', requestId: request.id, path: file, prompt: request.prompt, referencePaths: request.referencePaths }, /约束.*不一致/);
  assert.equal(generationState(late.j).outputs.length, 0); assert.deepEqual(generationState(late.j).requests[0].alphaChecks, checks);
});

test('v6 HTTP opaque participates in necessary prepare and final alpha; lowered dark solid cannot accepted but red layer can apply', async () => {
  const f = await fixture(), layout = { ...f.layout, layers: [{ ...f.layout.layers[0], alphaChecks: [...checks, opaqueCheck] }] };
  await f.send({ action: 'layout', layout });
  const b = await base(f, await withOpaque(await image('base'), 255));
  const m = await nearAuxiliary(f, b, 'near-neutral-luma8-v3', await sparseChroma());
  assert.match(m.request.prompt, /不按实体颜色明暗、固有黑墨/); assert(!m.request.prompt.includes('不得绘制背景/树/人物/文字'));
  assert.equal(m.request.matteFeasibility.checks.at(-1).eligiblePixels, 16);
  const r = await f.send(deriveBody(b, m)); assert.equal(r.alphaDiagnostics.checks.at(-1).kind, 'opaque');
  assert.equal(r.alphaDiagnostics.checks.at(-1).passingPixels, 0); assert.equal(r.alphaDiagnostics.passed, false);
  await assert.rejects(approveFixture(f, r), /区域alpha检查未通过/);
  const payload = await approveFixture(f, r, 'needs-revision'), honest = generationState(f.j), bad = structuredClone(honest);
  bad.outputs.find(o => o.id === r.id)!.review!.status = 'accepted'; store.atomic(f.registry, bad);
  await f.reject({ action: 'composite', generationIds: [r.id] }, /区域alpha检查失败.*accepted/);
  store.atomic(f.registry, bad); const rejectApply = await post(`/api/jobs/${f.j.id}/apply`, payload);
  assert(rejectApply.status >= 400); assert.match(rejectApply.value.error, /区域alpha检查失败.*accepted/); assert.equal(store.load(f.d.id).images.length, 1);
  store.atomic(f.registry, honest); const done = await api(`/api/jobs/${f.j.id}/apply`, payload);
  assert.equal(done.document.images.length, 2); assert.equal(done.document.images.at(-1).layers[0].review.status, 'needs-revision');
  const low = await fixture(); await low.send({ action: 'layout', layout: { ...low.layout, layers: [{ ...low.layout.layers[0], alphaChecks: [...checks, opaqueCheck] }] } });
  const missing = await base(low, await withOpaque(await image('base'), 254)), before = generationState(low.j), files = fs.readdirSync(low.folder);
  await low.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: missing.record.id,
    matteEncoding: 'near-neutral-luma8-v3', purpose: 'solid cannot be increased', referenceObservation: 'lower-bound necessary condition' }, /dark solid.*仅0\/16像素.*至少需16/);
  assert.deepEqual(generationState(low.j), before); assert.deepEqual(fs.readdirSync(low.folder), files);
});

test('v6 HTTP opaque alpha255 can remain intact with spatial matte while encoded proof and rule changes invalidate quality', async () => {
  const f = await fixture(); await f.send({ action: 'layout', layout: { ...f.layout, layers: [{ ...f.layout.layers[0], alphaChecks: [...checks, opaqueCheck] }] } });
  const b = await base(f, await withOpaque(await image('base'), 255));
  const m = await nearAuxiliary(f, b, 'near-neutral-luma8-v3', await withOpaque(await sparseChroma(), 255, true));
  const r = await f.send(deriveBody(b, m)); assert.equal(r.alphaDiagnostics.passed, true); assert.equal(r.alphaDiagnostics.checks.at(-1).alpha.min, 255);
  assert.equal(r.review, undefined); await approveFixture(f, r);
  const stable = generationState(f.j);
  for (const target of ['rule', 'placement', 'source'] as const) {
    const changed = structuredClone(stable), source = store.assetPath(f.j.documentId, f.j.snapshot.source), bytes = fs.readFileSync(source);
    if (target === 'rule') changed.layout!.layers[0].alphaChecks!.at(-1)!.minPassingFraction = 0.9;
    if (target === 'placement') changed.outputs.find(o => o.id === r.id)!.placementFrame!.x++;
    store.atomic(f.registry, changed); if (target === 'source') fs.appendFileSync(source, 'changed source');
    try {
      await f.reject({ action: 'composite', generationIds: [r.id] }, /约束.*不一致|基底登记.*变化|诊断已失效|来源.*变化|参考图.*改变/);
      assert.equal(generationState(f.j).composite, undefined); assert.equal(generationState(f.j).outputs.find(o => o.id === r.id)!.review, undefined);
    } finally { fs.writeFileSync(source, bytes); store.atomic(f.registry, stable); }
  }
});

test('aux-matte fixed min mapping preserves every RGB channel, zero support and full carrier', async () => {
  const bytes = await image('base'), scalar = await image('gray', 160), result = await applyGeneratedMatte(bytes, scalar);
  assert.deepEqual(result.size, { width: 80, height: 80 }); assert.equal(result.mapping.scale, 0.5);
  const before = await sharp(bytes).ensureAlpha().raw().toBuffer(), after = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  const mapped = await sharp(scalar).resize(80, 80).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < before.length; i += 4) {
    assert.deepEqual(after.subarray(i, i + 3), before.subarray(i, i + 3));
    assert.equal(after[i + 3], Math.min(before[i + 3], mapped[i]));
    if (before[i + 3] === 0) assert.equal(after[i + 3], 0);
  }
  for (const kind of ['white', 'black', 'uniform', 'color'] as const)
    await assert.rejects(applyGeneratedMatte(bytes, await image(kind)), /统一灰|全空|灰阶/);
  const wrong = await sharp(await image('gray')).resize(80, 40).png().toBuffer();
  await assert.rejects(applyGeneratedMatte(bytes, wrong), /比例/);
  const over = await sharp({ create: { width: 1250, height: 1250, channels: 3, background: '#808080' } }).png().toBuffer();
  await assert.rejects(applyGeneratedMatte(bytes, over), /预算/);
  const transparent = await sharp(await image('gray')).ensureAlpha(0.5).png().toBuffer();
  // Existing opaque alpha is not replaced by ensureAlpha; edit one actual pixel.
  const raw = await sharp(transparent).ensureAlpha().raw().toBuffer(); raw[3] = 254;
  await assert.rejects(applyGeneratedMatte(bytes, await sharp(raw, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer()), /完全不透明/);
});

async function alphaROI(eligible: number, eligibleAlpha = 24) {
  const raw = await sharp(await image('base')).ensureAlpha().raw().toBuffer(); let n = 0;
  for (let y = 30; y < 38; y++) for (let x = 30; x < 38; x++) raw[(y * 80 + x) * 4 + 3] = n++ < eligible ? eligibleAlpha : 0;
  return sharp(raw, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer();
}

test('aux-matte feasibility HTTP refuses fresh collapsed alpha despite forged diagnostic summaries without request, reference or registry writes', async () => {
  const f = await fixture(), b = await base(f, await alphaROI(5));
  const stale: any = generationState(f.j); stale.outputs[0].alphaDiagnostics.passed = true;
  stale.outputs[0].alphaDiagnostics.checks.forEach((c: any) => { c.alpha.mean = 252; c.passingPixels = c.pixels; c.passed = true; });
  store.atomic(f.registry, stale);
  const registryHash = hash(f.registry), folder = path.dirname(f.folder), beforeFiles = fs.readdirSync(folder, { recursive: true }).sort();
  const result = await f.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: b.record.id,
    matteEncoding: 'near-neutral-luma8-v2', purpose: 'cannot restore missing alpha', referenceObservation: 'actual alpha ROI, no persisted summary trust' }, /只能减alpha.*仅5\/64像素.*至少需64/);
  assert.equal(result.status, 400); assert.equal(hash(f.registry), registryHash);
  assert.deepEqual(fs.readdirSync(folder, { recursive: true }).sort(), beforeFiles);
  assert.equal(generationState(f.j).requests.length, 1); assert.equal(generationState(f.j).auxiliaries, undefined);
});

test('aux-matte feasibility HTTP honors partial-zero tolerance and exact count boundary; high opaque alpha remains eligible', async (t) => {
  for (const eligible of [57, 58]) await t.test(String(eligible), async () => {
    const f = await fixture(); f.layout.layers[0].alphaChecks[1].minPassingFraction = 0.9;
    await f.send({ action: 'layout', layout: f.layout });
    const b = await base(f, await alphaROI(eligible, 255)), body = { action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
      matteForGenerationId: b.record.id, purpose: 'necessary condition only, opacity can be reduced', referenceObservation: 'six zero pixels tolerated only at the frozen fraction' };
    assert.equal(b.record.alphaDiagnostics.passed, false); // Upper alpha fails, but min(A,M) may fix that direction.
    if (eligible === 57) {
      const before = hash(f.registry); await f.reject(body, /仅57\/64像素.*至少需58/); assert.equal(hash(f.registry), before);
    } else {
      const request = await f.send(body), necessary = request.matteFeasibility;
      assert.equal(necessary.necessaryConditionMet, true); assert.equal(necessary.checks[0].eligiblePixels, 58);
      assert.equal(necessary.checks[0].requiredPixels, 58); assert.equal(request.role, 'aux-matte');
      assert.equal(request.review, undefined); assert.equal(generationState(f.j).auxiliaries, undefined);
    }
  });
});

test('aux-matte feasibility HTTP prepare refuses async registry, working and source races while preserving current state and existing files', async (t) => {
  for (const target of ['registry', 'working', 'source', 'family-original'] as const) await t.test(target, async () => {
    const f = await fixture(), b = await base(f);
    if (target === 'family-original') { const m = await auxiliary(f, b), r = await f.send(deriveBody(b, m)); await approveFixture(f, r); }
    const stable = generationState(f.j), read = fs.readFileSync, original = fs.readFileSync(b.record.originalPath);
    const source = store.assetPath(f.j.documentId, f.j.snapshot.source), bytes = fs.readFileSync(source);
    let reads = 0, fired = false, changed: any;
    fs.readFileSync = ((p: any, ...args: any[]) => {
      const data = Reflect.apply(read, fs, [p, ...args]);
      // registeredGeneration and captureBinding hash the same path first;
      // the third read is the helper's actual Buffer snapshot before awaits.
      if (!fired && p === b.record.workingPath && ++reads === (target === 'family-original' ? 5 : 3)) {
        fired = true;
        if (target === 'registry') { changed = { ...stable, currentFeasibilityMarker: 'preserve latest' }; store.atomic(f.registry, changed); }
        else fs.appendFileSync(target === 'working' ? b.record.workingPath : target === 'family-original' ? b.record.originalPath : source,
          'changed after feasibility snapshot');
      }
      return data;
    }) as typeof fs.readFileSync;
    try {
      await f.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: b.record.id,
        purpose: 'CAS fixture', referenceObservation: 'current snapshot must not overwrite new state' }, /变化|改变|变更/);
      assert(fired); assert.equal(generationState(f.j).requests.length, stable.requests.length);
      if (target === 'registry') assert.deepEqual(generationState(f.j), changed); else assert.deepEqual(generationState(f.j), stable);
    } finally { fs.readFileSync = read; fs.writeFileSync(source, bytes); fs.writeFileSync(b.record.originalPath, original); }
  });
});

test('aux-matte feasibility rejection still permits normal RGB needs-revision review, composition and a new red result node', async () => {
  const f = await fixture(), b = await base(f, await alphaROI(0));
  await f.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: b.record.id,
    purpose: 'empty ROI cannot be increased by matte', referenceObservation: 'keep actual RGB failure without a futile model request' }, /仅0\/64像素/);
  await f.send({ action: 'review', generationId: b.record.id, comparisonHash: b.record.comparisonHash,
    elements: [{ name: 'cloth', status: 'different', observation: '真实RGB夹具薄材质内区被清空，min-alpha方法无法补回' }],
    evidence: { geometry: '已有RGB夹具仍在冻结图层框内，位置保持', appearance: '外部条纹存在但内区材质缺失',
      isolation: '真实内区alpha零，辅助matte只能下降而不能重建缺失', candidateIds: [b.record.id] },
    review: { status: 'needs-revision', attempts: [{ method: '实际RGB夹具检查', observation: '准备辅助matte必要条件拒绝，不作为新增生成次数' }],
      issues: [{ message: '内区材质已清空，需修RGB候选而非无效减alpha请求' }] } });
  const c = await f.send({ action: 'composite', generationIds: [b.record.id] });
  await f.send({ action: 'review-composite', comparisonHash: c.comparisonHash,
    layers: [{ generationId: b.record.id, status: 'different', observation: '保留真实缺失内区的RGB候选并诚实红标' }], relations: [] });
  const finished = await api(`/api/jobs/${f.j.id}/apply`, { taskId: f.j.taskId, baseVersion: f.j.version,
    layers: [{ id: 'cloth', name: 'cloth', ...b.record.frame, path: b.record.originalPath, generationId: b.record.id }] });
  assert.equal(finished.document.images.length, 2); assert.equal(finished.document.images[1].layers[0].review.status, 'needs-revision');
  assert.equal(generationState(f.j).auxiliaries, undefined);
});

test('aux-matte near-neutral v2 uses fixed full-raw integer limits and luma, retaining strict v1', async (t) => {
  const bytes = await nearImage(), parsed = await nearNeutralScalar(bytes);
  assert.equal(parsed.proof.statistics.maxSpread, 11); assert.equal(parsed.proof.statistics.materialOutliers, 1);
  assert(parsed.proof.statistics.materialSpreadSum / parsed.proof.statistics.materialPixels <= 2);
  const before = await sharp(bytes).ensureAlpha().raw().toBuffer(), after = await sharp(parsed.scalarBytes).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < before.length; i += 4) {
    const m = Math.round((2126 * before[i] + 7152 * before[i + 1] + 722 * before[i + 2]) / 10000);
    assert.deepEqual([...after.subarray(i, i + 4)], [m, m, m, 255]);
  }
  const patch = async (pixels: number, edit: (data: Buffer) => void) => {
    const data = Buffer.alloc(pixels * 4); for (let i = 0; i < data.length; i += 4) data.set([128, 128, 128, 255], i);
    edit(data); return sharp(data, { raw: { width: pixels, height: 1, channels: 4 } }).png().toBuffer();
  };
  for (const c of [
    { name: 'hardmax16', pixels: 1000, edit: (d: Buffer) => d.set([144, 128, 128, 255], 0), pass: true },
    { name: 'hardmax17', pixels: 1000, edit: (d: Buffer) => d.set([145, 128, 128, 255], 0), pass: false, pattern: /固定16/ },
    { name: 'mean2', pixels: 1000, edit: (d: Buffer) => { for (let i = 0; i < d.length; i += 4) d[i] = 130; }, pass: true },
    { name: 'mean2plus', pixels: 1000, edit: (d: Buffer) => { for (let i = 0; i < d.length; i += 4) d[i] = 130; d[0] = 131; }, pass: false, pattern: /平均spread.*2/ },
    { name: 'outlier1of1000', pixels: 1000, edit: (d: Buffer) => d.set([137, 128, 128, 255], 0), pass: true },
    { name: 'outlier2of1000', pixels: 1000, edit: (d: Buffer) => { d.set([137, 128, 128, 255], 0); d.set([137, 128, 128, 255], 4); }, pass: false, pattern: /99.9%/ },
    { name: 'outlier1of999', pixels: 999, edit: (d: Buffer) => d.set([137, 128, 128, 255], 0), pass: false, pattern: /99.9%/ },
    { name: 'alpha254', pixels: 1000, edit: (d: Buffer) => { d[3] = 254; }, pass: false, pattern: /alpha必须255/ },
    { name: 'blackThreshold8Excluded', pixels: 1001, edit: (d: Buffer) => d.set([8, 0, 0, 255], 0), pass: true },
  ]) await t.test(c.name, async () => {
    const png = await patch(c.pixels, c.edit);
    if (c.pass) await nearNeutralScalar(png); else await assert.rejects(nearNeutralScalar(png), c.pattern!);
  });
});

test('aux-matte HTTP new v2 request authenticates near-neutral raw, preserves original and derives fixed scalar while old strict fails', async () => {
  const f = await fixture(), b = await base(f), old = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
    matteForGenerationId: b.record.id, purpose: 'strict frozen fixture', referenceObservation: 'strict is not migrated after failure' });
  const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.writeFileSync(tool, await nearImage());
  assert(!Object.hasOwn(old, 'matteEncoding')); assert(!Object.hasOwn(old.matteBinding, 'matteEncoding'));
  await f.reject({ action: 'register', requestId: old.id, path: tool, prompt: old.prompt, referencePaths: old.referencePaths }, /不透明的灰阶/);
  await f.reject({ action: 'register', requestId: old.id, path: tool, prompt: old.prompt,
    referencePaths: old.referencePaths, matteEncoding: 'near-neutral-luma8-v2' }, /只能在aux prepare/);
  const exact = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: b.record.id,
    matteEncoding: 'exact-gray8-v1', purpose: 'explicit strict encoded fixture', referenceObservation: 'near-neutral raw is still rejected by strict v1' });
  assert.equal(exact.matteBinding.matteEncoding, 'exact-gray8-v1');
  await f.reject({ action: 'register', requestId: exact.id, path: tool, prompt: exact.prompt, referencePaths: exact.referencePaths }, /不透明的灰阶/);
  const m = await nearAuxiliary(f, b), proof = m.record.encodingProof;
  assert.equal(m.request.matteEncoding, 'near-neutral-luma8-v2'); assert.equal(m.request.matteBinding.matteEncoding, m.request.matteEncoding);
  assert.equal(m.record.receipt.matteEncoding, m.request.matteEncoding); assert.equal(proof.rawHash, hash(m.tool));
  assert.equal(proof.formula, MATTE_LUMA_FORMULA); assert.deepEqual(proof.limits, NEAR_NEUTRAL_LIMITS);
  assert.deepEqual(fs.readFileSync(m.record.originalPath), fs.readFileSync(m.tool));
  assert.notEqual(m.record.hash, m.record.workingHash); await applyGeneratedMatte(fs.readFileSync(b.record.workingPath), fs.readFileSync(m.record.workingPath));
  const r = await f.send(deriveBody(b, m)); assert.equal(r.derivedAlpha.matteEncoding, m.request.matteEncoding);
  assert.equal(r.receipt.matteEncoding, m.request.matteEncoding); assert.equal(r.alphaDiagnostics.passed, true); assert.equal(r.review, undefined);
  const before = await sharp(fs.readFileSync(b.record.workingPath)).ensureAlpha().raw().toBuffer(), mask = await sharp(fs.readFileSync(m.record.workingPath)).ensureAlpha().raw().toBuffer();
  const after = await sharp(fs.readFileSync(r.workingPath)).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < after.length; i += 4) { assert.deepEqual(after.subarray(i, i + 3), before.subarray(i, i + 3)); assert.equal(after[i + 3], Math.min(before[i + 3], mask[i])); }
  for (const file of [m.tool, m.record.originalPath, m.record.workingPath, r.workingPath]) {
    const alias = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
    fs.writeFileSync(alias, await sharp(fs.readFileSync(file)).withMetadata({ density: 72 }).png({ compressionLevel: 1 }).toBuffer());
    await f.reject({ action: 'register', requestId: b.request.id, path: alias, prompt: b.request.prompt, referencePaths: b.request.referencePaths }, /角色文件.*冒充image_gen/);
  }
});

test('aux-matte HTTP v2 rejects color and full raw outliers before budget resize and binds encoding formula/statistics through every consumer', async () => {
  const f = await fixture(), b = await base(f), m = await nearAuxiliary(f, b), r = await f.send(deriveBody(b, m));
  await f.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteEncoding: 'near-neutral-luma8-v2',
    purpose: 'nonaux cannot opt encoding', referenceObservation: 'not auxiliary' }, /只能在aux prepare/);
  const req = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: b.record.id,
    matteEncoding: 'near-neutral-luma8-v2', purpose: 'bad raw fixture', referenceObservation: 'must authenticate before resize' });
  const colored = Buffer.alloc(1400 * 1400 * 4, 128); for (let i = 3; i < colored.length; i += 4) colored[i] = 255;
  colored.set([255, 0, 0, 255], 0);
  const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  fs.writeFileSync(tool, await sharp(colored, { raw: { width: 1400, height: 1400, channels: 4 } }).png().toBuffer());
  await f.reject({ action: 'register', requestId: req.id, path: tool, prompt: req.prompt, referencePaths: req.referencePaths }, /原件全图.*固定16/);
  const stable = generationState(f.j);
  for (const edit of [
    (s: any) => { s.requests.find((q: any) => q.id === m.request.id).matteEncoding = 'exact-gray8-v1'; },
    (s: any) => { s.auxiliaries[0].matteEncoding = 'exact-gray8-v1'; },
    (s: any) => { s.auxiliaries[0].encodingProof.formula = 'custom'; },
    (s: any) => { s.auxiliaries[0].encodingProof.statistics.maxSpread = 0; },
    (s: any) => { s.auxiliaries[0].encodingProof.limits.maxSpread = 17; },
    (s: any) => { s.outputs.find((o: any) => o.id === r.id).derivedAlpha.matteEncoding = 'exact-gray8-v1'; },
    (s: any) => { s.outputs.find((o: any) => o.id === r.id).receipt.matteEncoding = undefined; },
    (s: any) => {
      const aux = s.auxiliaries[0], req = s.requests.find((q: any) => q.id === m.request.id);
      delete aux.matteEncoding; delete aux.encodingProof; delete aux.binding.matteEncoding; delete aux.receipt.matteEncoding;
      delete req.matteEncoding; delete req.matteBinding.matteEncoding;
      delete s.outputs.find((o: any) => o.id === r.id).derivedAlpha.matteEncoding;
    },
  ]) {
    const modified: any = structuredClone(stable); modified.outputs.find((o: any) => o.id === r.id).review = { status: 'accepted' };
    modified.composite = { stale: true }; edit(modified); store.atomic(f.registry, modified);
    await f.reject({ action: 'composite', generationIds: [r.id] }, /编码|证明|变化|不一致|灰阶/);
    assert.equal(generationState(f.j).outputs.find(o => o.id === r.id)!.review, undefined);
    assert.equal(generationState(f.j).composite, undefined); store.atomic(f.registry, stable);
  }
  await approveFixture(f, r);
  const payload = { taskId: f.j.taskId, baseVersion: f.j.version,
    layers: [{ id: 'cloth', name: 'cloth', ...r.frame, path: r.originalPath, generationId: r.id }] };
  fs.appendFileSync(m.record.originalPath, 'source changed');
  const result = await post(`/api/jobs/${f.j.id}/apply`, payload); assert(result.status >= 400, JSON.stringify(result.value));
  assert.equal(store.load(f.d.id).images.length, 1);
});

test('aux-matte HTTP near-neutral v2 registration rejects raw or registry races after scalar work writes without changing the receipt or raw snapshot', async (t) => {
  for (const target of ['tool', 'registry'] as const) await t.test(target, async () => {
    const f = await fixture(), b = await base(f), request = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
      matteForGenerationId: b.record.id, matteEncoding: 'near-neutral-luma8-v2', purpose: 'snapshot race fixture', referenceObservation: 'retain actual bytes and concurrent state' });
    const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'), raw = await nearImage(); fs.writeFileSync(tool, raw);
    const stable = generationState(f.j), write = fs.writeFileSync; let fired = false, artifact = '', changed: any;
    fs.writeFileSync = ((p: any, ...args: any[]) => {
      const result = Reflect.apply(write, fs, [p, ...args]);
      if (!fired && typeof p === 'string' && p.includes(path.sep + 'aux-') && path.basename(p) === 'working.png') {
        fired = true; artifact = p;
        if (target === 'tool') fs.appendFileSync(tool, 'raw changed after scalar normalization');
        else { changed = { ...stable, concurrentEncodingMarker: 'preserve latest' }; store.atomic(f.registry, changed); }
      }
      return result;
    }) as typeof fs.writeFileSync;
    try {
      await f.reject({ action: 'register', requestId: request.id, path: tool, prompt: request.prompt, referencePaths: request.referencePaths }, /变化/);
      assert(fired); assert(fs.existsSync(artifact)); assert.deepEqual(fs.readFileSync(path.join(path.dirname(artifact), 'original.png')), raw);
      assert.equal(generationState(f.j).auxiliaries, undefined);
      if (target === 'registry') assert.deepEqual(generationState(f.j), changed); else assert.deepEqual(generationState(f.j), stable);
    } finally { fs.writeFileSync = write; }
  });
});

test('aux-matte HTTP legal two-source derivation remains unaccepted and auxiliaries cannot become layer candidates', async () => {
  const f = await fixture(), b = await base(f), m = await auxiliary(f, b);
  assert.equal(m.request.role, 'aux-matte'); assert.deepEqual(m.request.referencePaths, [b.record.workingPath, b.request.localPath]);
  assert.equal(b.request.allowAuxMatte, true); assert.equal(m.request.allowAuxMatte, true);
  assert.equal(m.request.transparent_background, false); assert.equal(m.request.surface, 'opaque');
  assert.equal(m.record.generationId, undefined); assert.equal(m.record.role, 'aux-matte');
  assert.equal(generationState(f.j).outputs.length, 1); assert.equal(generationState(f.j).auxiliaries!.length, 1);
  await f.reject({ action: 'composite', generationIds: [m.record.id] }, /不存在/);
  await f.reject({ action: 'align', generationId: m.record.id, anchorNames: ['left', 'right'],
    points: [{ source: [20, 40], target: [20, 40] }, { source: [60, 40], target: [60, 40] }], observation: 'aux cannot align' }, /不存在/);
  assert.throws(() => registeredGeneration(f.j, m.record.id, ['cloth'], b.record.frame), /缺少/);
  const originalHashes = [hash(b.tool), hash(b.record.originalPath), hash(m.tool), hash(m.record.originalPath)];
  const r = await f.send(deriveBody(b, m));
  assert.equal(r.kind, 'derived-alpha'); assert.equal(r.receipt.tool, 'derived-alpha');
  assert.equal(r.receipt.baseGenerationId, b.record.id); assert.equal(r.receipt.matteId, m.record.id);
  assert.equal(r.alphaDiagnostics.passed, true); assert.equal(r.review, undefined);
  assert.deepEqual(r.placementFrame, b.record.placementFrame); assert.equal(r.workingSize.width * r.workingSize.height, 6400);
  assert.deepEqual([hash(b.tool), hash(b.record.originalPath), hash(m.tool), hash(m.record.originalPath)], originalHashes);
  const a = await sharp(fs.readFileSync(b.record.workingPath)).ensureAlpha().raw().toBuffer(), z = await sharp(fs.readFileSync(r.workingPath)).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < a.length; i += 4) { assert.deepEqual(z.subarray(i, i + 3), a.subarray(i, i + 3)); assert(z[i + 3] <= a[i + 3]); }
  registeredGeneration(f.j, r.id, ['cloth'], r.frame);
  await f.reject({ action: 'align', generationId: r.id, anchorNames: ['left', 'right'],
    points: [{ source: [20, 40], target: [20, 40] }, { source: [60, 40], target: [60, 40] }], observation: 'cannot drop matte after alignment' }, /丢弃蒙版/);
  await f.reject({ ...deriveBody(b, m), opacity: 0.5 }, /固定min/);
});

test('aux-matte HTTP freezes opt-in in the actual RGB request before output, refusing post-output enablement without migrating absence', async (t) => {
  for (const earlier of ['absent', false] as const) await t.test(String(earlier), async () => {
    const f = await fixture(earlier);
    const old = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
      purpose: 'RGB before any aux experiment opt-in', referenceObservation: 'the frozen request must retain its original flag' });
    if (earlier === 'absent') assert(!Object.hasOwn(old, 'allowAuxMatte'));
    else assert.equal(old.allowAuxMatte, false);
    // Actual PNG output exists before the legal layout change; no registry edits.
    const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.writeFileSync(tool, await image('base'));
    const enabled = structuredClone(f.layout); enabled.layers[0].allowAuxMatte = true;
    await f.send({ action: 'layout', layout: enabled });
    const rgb = await f.send({ action: 'register', requestId: old.id, path: tool, prompt: old.prompt, referencePaths: old.referencePaths });
    const stored = generationState(f.j).requests.find(q => q.id === old.id)!;
    if (earlier === 'absent') assert(!Object.hasOwn(stored, 'allowAuxMatte'));
    else assert.equal(stored.allowAuxMatte, false);
    await f.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: rgb.id,
      purpose: 'post-output opt-in must fail', referenceObservation: 'cannot retrospectively enable the old real RGB request' }, /生成前.*allowAuxMatte|事后开启/);
    assert.equal(generationState(f.j).auxiliaries?.length || 0, 0);
  });
});

test('aux-matte HTTP cannot launder known auxiliary or derived paths and byte-copy aliases into image_gen RGB registrations', async () => {
  const f = await fixture(), b = await base(f), m = await auxiliary(f, b), r = await f.send(deriveBody(b, m));
  const before = generationState(f.j);
  for (const file of [m.tool, m.record.originalPath, m.record.workingPath, r.originalPath, r.workingPath]) {
    const copy = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.copyFileSync(file, copy);
    for (const input of [file, copy]) await f.reject({ action: 'register', requestId: b.request.id,
      path: input, prompt: b.request.prompt, referencePaths: b.request.referencePaths }, /角色文件.*冒充image_gen/);
  }
  // A changed PNG compression header still normalizes to the known work identity.
  const encoded = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  fs.writeFileSync(encoded, await sharp(fs.readFileSync(r.workingPath)).png({ compressionLevel: 9 }).toBuffer());
  await f.reject({ action: 'register', requestId: b.request.id, path: encoded,
    prompt: b.request.prompt, referencePaths: b.request.referencePaths }, /角色文件.*冒充image_gen/);
  assert.deepEqual(generationState(f.j), before);
  registeredGeneration(f.j, r.id, ['cloth'], r.frame); // Canonical derived identity still consumes its verified chain.
  const honest = await fixture('absent'), badRgb = await base(honest);
  await honest.send({ action: 'review', generationId: badRgb.record.id, comparisonHash: badRgb.record.comparisonHash,
    elements: [{ name: 'cloth', status: 'different', observation: '普通真实RGB候选薄内区仍近不透明，诚实标红保留' }],
    evidence: { geometry: '普通夹具布材仍在真实冻结框内', appearance: '条纹颜色正常但透底响应不够',
      isolation: '外围透明孔隙保留，内部alpha252未达到透底检查', candidateIds: [badRgb.record.id] },
    review: { status: 'needs-revision', attempts: [{ method: '普通RGB实际PNG检查', observation: '区域alpha检查失败，非辅助别名' }],
      issues: [{ message: '薄内区近不透明，保留真实RGB候选待改' }] } });
  assert.equal(generationState(honest.j).outputs[0].review!.status, 'needs-revision');
  const red = await honest.send({ action: 'composite', generationIds: [badRgb.record.id] });
  await honest.send({ action: 'review-composite', comparisonHash: red.comparisonHash,
    layers: [{ generationId: badRgb.record.id, status: 'different', observation: '真实RGB夹具薄内区检查失败，选择该真实候选并明确标红' }], relations: [] });
  const finished = await api(`/api/jobs/${honest.j.id}/apply`, { taskId: honest.j.taskId, baseVersion: honest.j.version,
    layers: [{ id: 'cloth', name: 'cloth', ...badRgb.record.frame, path: badRgb.record.originalPath, generationId: badRgb.record.id }] });
  assert.equal(finished.document.images.length, 2); assert.equal(finished.document.images[1].layers[0].review.status, 'needs-revision');
});

test('aux-matte HTTP existing plain aliases become ineligible after the canonical derived role is registered, without registry edits', async () => {
  const f = await fixture(), b = await base(f);
  const future = await applyGeneratedMatte(fs.readFileSync(b.record.workingPath), await image('gray'));
  const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.writeFileSync(tool, future.bytes);
  // Before its role exists, the ordinary route records this fixture PNG normally.
  const old = await f.send({ action: 'register', requestId: b.request.id, path: tool,
    prompt: b.request.prompt, referencePaths: b.request.referencePaths });
  const payload = await approveFixture(f, old), c = generationState(f.j).composite!;
  const m = await auxiliary(f, b), canonical = await f.send(deriveBody(b, m));
  assert.equal(old.hash, canonical.hash); assert.equal(old.workingHash, canonical.workingHash);
  await f.reject({ action: 'composite', generationIds: [old.id] }, /角色文件.*冒充image_gen/);
  await f.reject({ action: 'review-composite', ...c.review }, /最新合成与对比图/); // New canonical registration also invalidates the old approval.
  const before = store.load(f.d.id), result = await post(`/api/jobs/${f.j.id}/apply`, payload);
  assert(result.status >= 400, JSON.stringify(result.value)); assert.match(result.value.error, /角色文件.*冒充image_gen/);
  assert.deepEqual(store.load(f.d.id), before);
  registeredGeneration(f.j, canonical.id, ['cloth'], canonical.frame);
});

test('aux-matte HTTP exact RGBA plus dimensions refuses metadata-only re-encoding of both known roles', async () => {
  const f = await fixture(), b = await base(f), m = await auxiliary(f, b), r = await f.send(deriveBody(b, m));
  const stable = generationState(f.j);
  for (const file of [m.record.originalPath, m.record.workingPath, r.originalPath, r.workingPath]) {
    const snapshot = fs.readFileSync(file), encoded = await sharp(snapshot).withMetadata({ density: 72 }).png({ compressionLevel: 1 }).toBuffer();
    const alias = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.writeFileSync(alias, encoded);
    assert.notEqual(hash(alias), hash(file));
    const a = await sharp(snapshot).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const z = await sharp(encoded).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(z.info.width, a.info.width); assert.equal(z.info.height, a.info.height); assert.deepEqual(z.data, a.data);
    await f.reject({ action: 'register', requestId: b.request.id, path: alias,
      prompt: b.request.prompt, referencePaths: b.request.referencePaths }, /角色文件的精确RGBA及尺寸别名.*冒充image_gen/);
    assert.deepEqual(generationState(f.j), stable);
  }
  registeredGeneration(f.j, r.id, ['cloth'], r.frame);
});

test('aux-matte HTTP prior metadata-only alias has no identity fields yet review, cache and apply reject it after role registration', async () => {
  const f = await fixture(), b = await base(f), future = await applyGeneratedMatte(fs.readFileSync(b.record.workingPath), await image('gray'));
  const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  fs.writeFileSync(tool, await sharp(future.bytes).withMetadata({ density: 72 }).png({ compressionLevel: 1 }).toBuffer());
  const old = await f.send({ action: 'register', requestId: b.request.id, path: tool,
    prompt: b.request.prompt, referencePaths: b.request.referencePaths });
  assert.equal(old.kind, undefined); assert.equal(old.derivedAlpha, undefined);
  const payload = await approveFixture(f, old), beforeDoc = store.load(f.d.id), approved = generationState(f.j).outputs.find(o => o.id === old.id)!;
  const m = await auxiliary(f, b), canonical = await f.send(deriveBody(b, m));
  assert.notEqual(old.hash, canonical.hash); assert.notEqual(old.workingHash, canonical.workingHash);
  assert.deepEqual(await sharp(fs.readFileSync(old.workingPath)).toColourspace('srgb').ensureAlpha().raw().toBuffer(),
    await sharp(fs.readFileSync(canonical.workingPath)).toColourspace('srgb').ensureAlpha().raw().toBuffer());
  await f.reject({ action: 'review', generationId: old.id, comparisonHash: old.comparisonHash,
    elements: approved.elements, evidence: approved.reviewEvidence, review: approved.review }, /精确RGBA及尺寸别名.*冒充image_gen/);
  await f.reject({ action: 'composite', generationIds: [old.id] }, /精确RGBA及尺寸别名.*冒充image_gen/);
  const result = await post(`/api/jobs/${f.j.id}/apply`, payload);
  assert(result.status >= 400, JSON.stringify(result.value)); assert.match(result.value.error, /精确RGBA及尺寸别名.*冒充image_gen/);
  assert.deepEqual(store.load(f.d.id), beforeDoc);
  // Plain candidates carry no trusted derived/pixel identity metadata. Restore
  // a pre-fix cached review only as an old-record fixture and deny cache use.
  await approveFixture(f, canonical);
  const persisted = generationState(f.j), cache = persisted.composite!;
  const cached: any = generationState(f.j); cached.composite.generationIds = [old.id]; store.atomic(f.registry, cached);
  await f.reject({ action: 'review-composite', comparisonHash: cache.comparisonHash,
    layers: [{ generationId: old.id, status: 'matched', observation: 'pre-fix cached plain alias' }], relations: [] }, /精确RGBA及尺寸别名.*冒充image_gen/);
  store.atomic(f.registry, persisted);
  registeredGeneration(f.j, canonical.id, ['cloth'], canonical.frame);
});

test('aux-matte HTTP exact-pixel preflight caches cannot authorize changed source snapshots or overwrite concurrent state', async (t) => {
  for (const target of ['file', 'registry'] as const) await t.test(target, async () => {
    const f = await fixture(), b = await base(f), m = await auxiliary(f, b), r = await f.send(deriveBody(b, m));
    await approveFixture(f, r);
    const stable = generationState(f.j), original = fs.readFileSync(m.record.originalPath), read = fs.readFileSync;
    let fired = false, changed: any;
    fs.readFileSync = ((p: any, ...args: any[]) => {
      const bytes = Reflect.apply(read, fs, [p, ...args]);
      if (!fired && typeof p === 'string' && p === m.record.originalPath) {
        fired = true;
        if (target === 'file') fs.appendFileSync(p, 'snapshot changed during identity preflight');
        else { changed = { ...stable, concurrentIdentityMarker: 'preserve current state' }; store.atomic(f.registry, changed); }
      }
      return bytes;
    }) as typeof fs.readFileSync;
    try {
      await f.reject({ action: 'composite', generationIds: [r.id] }, /变化/);
      assert(fired);
      if (target === 'registry') assert.deepEqual(generationState(f.j), changed);
      else { assert.equal(generationState(f.j).outputs.at(-1)!.review, undefined); assert.equal(generationState(f.j).composite, undefined); }
    } finally { fs.readFileSync = read; fs.writeFileSync(m.record.originalPath, original); }
  });
});

test('aux-matte HTTP unrelated genuine RGB failure remains an honest red layer with known auxiliary and derived roles present', async () => {
  const f = await fixture(), b = await base(f), m = await auxiliary(f, b); await f.send(deriveBody(b, m));
  const rgb = await f.send({ action: 'register', requestId: b.request.id, path: b.tool,
    prompt: b.request.prompt, referencePaths: b.request.referencePaths });
  await f.send({ action: 'review', generationId: rgb.id, comparisonHash: rgb.comparisonHash,
    elements: [{ name: 'cloth', status: 'different', observation: '真实RGB薄内区仍alpha252，诚实记录失败' }],
    evidence: { geometry: '真实RGB夹具仍在冻结布料框内', appearance: '颜色条纹存在，内区近不透明',
      isolation: '外围孔隙透明，薄区仍无足够深浅底响应', candidateIds: [rgb.id] },
    review: { status: 'needs-revision', attempts: [{ method: '实际RGB夹具检查', observation: '角色guard不能挡普通真实失败红层' }],
      issues: [{ message: '薄内区响应未达到冻结标准' }] } });
  const c = await f.send({ action: 'composite', generationIds: [rgb.id] });
  await f.send({ action: 'review-composite', comparisonHash: c.comparisonHash,
    layers: [{ generationId: rgb.id, status: 'different', observation: '保留真实RGB失败候选并明确标红' }], relations: [] });
  const finished = await api(`/api/jobs/${f.j.id}/apply`, { taskId: f.j.taskId, baseVersion: f.j.version,
    layers: [{ id: 'cloth', name: 'cloth', ...rgb.frame, path: rgb.originalPath, generationId: rgb.id }] });
  assert.equal(finished.document.images.length, 2); assert.equal(finished.document.images[1].layers[0].review.status, 'needs-revision');
});

test('aux-matte HTTP rejects pre-fix plain records and approved caches sharing auxiliary or derived identity', async () => {
  const f = await fixture(), b = await base(f), m = await auxiliary(f, b), r = await f.send(deriveBody(b, m));
  const stable = generationState(f.j), beforeDoc = store.load(f.d.id);
  for (const file of [m.record.originalPath, r.originalPath]) {
    // Fixture represents the pre-fix ordinary register output, not a new supported registration.
    const old: any = structuredClone(r); old.id = crypto.randomUUID(); delete old.kind; delete old.derivedAlpha;
    old.outputPath = old.originalPath = old.workingPath = file; old.hash = old.workingHash = hash(file);
    old.receipt = { ...old.receipt, tool: 'image_gen' }; delete old.receipt.baseGenerationId; delete old.receipt.matteId;
    old.review = { status: 'needs-revision', attempts: [{ method: 'pre-fix cached alias', observation: 'known bad role fixture' }], issues: [{ message: 'gray/derived role alias' }] };
    const seeded: any = structuredClone(stable); seeded.outputs.push(old); seeded.composite = { stale: true };
    store.atomic(f.registry, seeded);
    await f.reject({ action: 'composite', generationIds: [old.id] }, /角色文件.*冒充image_gen/);
    await f.reject({ action: 'review', generationId: old.id, comparisonHash: old.comparisonHash,
      elements: [{ name: 'cloth', status: 'different', observation: 'the cached auxiliary alias must still be rejected' }],
      review: old.review }, /角色文件.*冒充image_gen/);
    const applied = await post(`/api/jobs/${f.j.id}/apply`, { taskId: f.j.taskId, baseVersion: f.j.version,
      layers: [{ id: 'cloth', name: 'cloth', ...old.frame, path: file, generationId: old.id }] });
    assert(applied.status >= 400, JSON.stringify(applied.value)); assert.match(applied.value.error, /角色文件.*冒充image_gen/);
    assert.deepEqual(store.load(f.d.id), beforeDoc); store.atomic(f.registry, stable);
    // Even an old alias without any regional diagnostics must be denied before cache use.
    const withoutChecks: any = structuredClone(seeded);
    delete withoutChecks.outputs.at(-1).alphaDiagnostics;
    delete withoutChecks.requests.find((q: any) => q.id === old.requestId).alphaChecks;
    delete withoutChecks.layout.layers[0].alphaChecks;
    store.atomic(f.registry, withoutChecks);
    await f.reject({ action: 'composite', generationIds: [old.id] }, /角色文件.*冒充image_gen/);
    store.atomic(f.registry, stable);
  }
});

test('aux-matte HTTP opt-in and unsupported routes stay narrow and absent old plans stay unchanged', async () => {
  for (const enabled of ['absent', false] as const) {
    const f = await fixture(enabled), b = await base(f);
    if (enabled === 'absent') assert(!Object.hasOwn(generationState(f.j).layout!.layers[0], 'allowAuxMatte'));
    await f.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: b.record.id,
      purpose: 'not opted in', referenceObservation: 'not permitted' }, /opt-in/);
  }
  const f = await fixture();
  for (const edit of [
    (l: any) => { l.alphaChecks = [checks[0]]; }, (l: any) => { l.blendMode = 'screen'; l.content = 'light-effect'; },
  ]) {
    const layout = structuredClone(f.layout); edit(layout.layers[0]);
    await f.reject({ action: 'layout', layout }, /normal透明|transmissive/);
  }
  const legacy = structuredClone(f.layout); delete legacy.layers[0].allowAuxMatte;
  assert.deepEqual(generationLayoutSchema.parse(legacy), legacy);
  const ps = await fixture('absent', 'photoshop');
  await ps.reject({ action: 'derive-alpha', baseGenerationId: 'none', matteId: 'none',
    expectedBaseWorkingHash: 'a'.repeat(64), expectedMatteWorkingHash: 'b'.repeat(64) }, /unsupported/);
  await ps.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: 'none',
    purpose: 'unsupported', referenceObservation: 'not a PS path' }, /unsupported/);
  for (const changed of ['legacy-workflow', 'legacy-protocol', 'illustrator', 'background'] as const) {
    const normal = await fixture(), rgb = await base(normal), job = store.getJob(normal.j.id);
    if (changed === 'legacy-workflow') delete job.reconstructionWorkflowVersion;
    if (changed === 'legacy-protocol') delete job.reconstructionVersion;
    if (changed === 'illustrator') job.type = 'illustrator';
    if (changed === 'background') job.snapshot.layers[0].role = 'background';
    store.saveJob(job);
    await normal.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: rgb.record.id,
      purpose: 'ordinary-only scope', referenceObservation: 'must reject the changed route' }, /opt-in|normal透明|此任务不使用图层生成/);
  }
});

test('aux-matte HTTP rejects fake base IDs, wrong ordered references, expected hashes and constant pseudo repairs', async () => {
  const f = await fixture(), b = await base(f), m = await auxiliary(f, b);
  await f.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: crypto.randomUUID(),
    purpose: 'another job id cannot be guessed', referenceObservation: 'must exist' }, /本任务真实RGB/);
  await f.reject({ action: 'register', requestId: m.request.id, path: m.tool, prompt: m.request.prompt,
    referencePaths: [...m.request.referencePaths].reverse() }, /有序引用/);
  await f.reject({ ...deriveBody(b, m), expectedBaseWorkingHash: '0'.repeat(64) }, /expected/);
  for (const kind of ['white', 'black', 'uniform'] as const) {
    const pseudo = await auxiliary(f, b, kind), before = generationState(f.j).outputs.length;
    await f.reject(deriveBody(b, pseudo), /全空|统一灰/);
    assert.equal(generationState(f.j).outputs.length, before);
  }
});

test('aux-matte HTTP every consumer revalidates both source files, provenance and placement and clears stale approvals', async () => {
  const f = await fixture(), b = await base(f), m = await auxiliary(f, b), r = await f.send(deriveBody(b, m));
  const stable = generationState(f.j);
  for (const file of [b.tool, b.record.originalPath, b.record.workingPath, m.tool, m.record.originalPath, m.record.workingPath,
    r.originalPath, r.workingPath, store.assetPath(f.j.documentId, f.j.snapshot.source)]) {
    const bytes = fs.readFileSync(file); fs.appendFileSync(file, 'changed');
    const approved: any = structuredClone(stable); approved.outputs[1].review = { status: 'accepted' }; approved.composite = { stale: true };
    store.atomic(f.registry, approved);
    try {
      await f.reject({ action: 'composite', generationIds: [r.id] }, /变化|变更|改变/);
      assert.equal(generationState(f.j).outputs[1].review, undefined); assert.equal(generationState(f.j).composite, undefined);
    }
    finally { fs.writeFileSync(file, bytes); store.atomic(f.registry, stable); }
  }
  for (const change of [
    (s: any) => { s.outputs[0].placementFrame.x += 1; },
    (s: any) => { s.auxiliaries[0].receipt.prompt += 'changed'; },
    (s: any) => { s.requests.find((q: any) => q.role === 'aux-matte').canvas.width += 1; },
    (s: any) => { s.layout.layers[0].alphaChecks[1].maxAlpha = 210; },
    (s: any) => { s.outputs[1].derivedAlpha.mapping.scale = 2; },
    (s: any) => { s.outputs[1].receipt.tool = 'image_gen'; },
  ]) {
    const modified: any = structuredClone(stable); modified.outputs[1].review = { status: 'accepted' }; modified.composite = { stale: true };
    change(modified); store.atomic(f.registry, modified);
    await f.reject({ action: 'composite', generationIds: [r.id] }, /变化|不一致|真实双来源|receipt|诊断已失效/);
    assert.equal(generationState(f.j).outputs[1].review, undefined); assert.equal(generationState(f.j).composite, undefined);
    store.atomic(f.registry, stable);
  }
  await f.send({ action: 'align', generationId: b.record.id, anchorNames: ['left', 'right'],
    points: [{ source: [19, 40], target: [20, 40] }, { source: [59, 40], target: [60, 40] }], observation: 'real align shifts base one pixel' });
  await f.reject({ action: 'composite', generationIds: [r.id] }, /基底登记|位置|变化/);
});

test('aux-matte HTTP async snapshot/CAS refuses changed sources or registry and retains derived files', async (t) => {
  for (const target of ['base', 'mask', 'source', 'placement', 'plan', 'aux-record', 'job-snapshot'] as const) await t.test(target, async () => {
    const f = await fixture(), b = await base(f), m = await auxiliary(f, b);
    const originalWrite = fs.writeFileSync, before = generationState(f.j); let fired = false, artifact = '';
    const file = target === 'base' ? b.record.workingPath : target === 'mask' ? m.record.workingPath
      : store.assetPath(f.j.documentId, f.j.snapshot.source), originalBytes = fs.readFileSync(file);
    fs.writeFileSync = ((p: any, ...args: any[]) => {
      const result = Reflect.apply(originalWrite, fs, [p, ...args]);
      if (!fired && typeof p === 'string' && path.basename(p) === 'derived.png') {
        fired = true; artifact = p;
        if (['base', 'mask', 'source'].includes(target)) fs.appendFileSync(file, 'raced');
        else {
          const changed: any = generationState(f.j);
          if (target === 'placement') changed.outputs[0].placementFrame.x += 1;
          if (target === 'plan') changed.layout.layers[0].allowAuxMatte = false;
          if (target === 'aux-record') changed.auxiliaries[0].receipt.prompt += 'changed';
          if (target === 'job-snapshot') { const current = store.getJob(f.j.id); current.snapshot.opinion += 'changed'; store.saveJob(current); }
          else store.atomic(f.registry, changed);
        }
      }
      return result;
    }) as typeof fs.writeFileSync;
    try {
      await f.reject(deriveBody(b, m), /变化|变更|改变|不一致/);
      assert(fired); assert(fs.existsSync(artifact)); assert.equal(generationState(f.j).outputs.length, 1);
      if (['base', 'mask', 'source', 'job-snapshot'].includes(target)) assert.deepEqual(generationState(f.j), before);
      else assert.notDeepEqual(generationState(f.j), before);
    } finally { fs.writeFileSync = originalWrite; originalWrite(file, originalBytes); }
  });
});

test('aux-matte HTTP registration snapshots its real tool bytes and rejects file/registration races without overwriting', async (t) => {
  for (const target of ['tool', 'base-record'] as const) await t.test(target, async () => {
    const f = await fixture(), b = await base(f);
    const request = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
      matteForGenerationId: b.record.id, purpose: 'snapshot race probe', referenceObservation: 'must retain the bytes actually read' });
    const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
    const original = await image('gray'); fs.writeFileSync(tool, original);
    const replacement = await image('black'), originalWrite = fs.writeFileSync, before = generationState(f.j);
    let fired = false, artifact = '';
    fs.writeFileSync = ((p: any, ...args: any[]) => {
      const result = Reflect.apply(originalWrite, fs, [p, ...args]);
      if (!fired && typeof p === 'string' && p.includes(path.sep + 'aux-') && path.basename(p) === 'original.png') {
        fired = true; artifact = p;
        if (target === 'tool') originalWrite(tool, replacement);
        else { const changed = generationState(f.j); changed.outputs[0].placementFrame!.x += 1; store.atomic(f.registry, changed); }
      }
      return result;
    }) as typeof fs.writeFileSync;
    try {
      await f.reject({ action: 'register', requestId: request.id, path: tool, prompt: request.prompt,
        referencePaths: request.referencePaths }, /变化|变更|改变/);
      assert(fired); assert.deepEqual(fs.readFileSync(artifact), original);
      assert(fs.existsSync(path.join(path.dirname(artifact), 'working.png')));
      assert.equal(generationState(f.j).auxiliaries?.length || 0, 0);
      if (target === 'tool') assert.deepEqual(generationState(f.j), before);
      else assert.equal(generationState(f.j).outputs[0].placementFrame!.x, b.record.placementFrame.x + 1);
    } finally { fs.writeFileSync = originalWrite; }
  });
});

test('aux-matte HTTP preserves a large original but uses a budget full carrier and rejects actual cross-job bases', async () => {
  const f = await fixture(), b = await base(f), foreign = await fixture(), foreignBase = await base(foreign);
  await f.reject({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], matteForGenerationId: foreignBase.record.id,
    purpose: 'foreign actual registered candidate', referenceObservation: 'must not cross jobs' }, /本任务真实RGB/);
  const request = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'],
    matteForGenerationId: b.record.id, purpose: 'budget carrier probe', referenceObservation: 'full file, no alpha crop' });
  const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png'); fs.writeFileSync(tool, await image('gray', 1400));
  const originalHash = hash(tool);
  const m = await f.send({ action: 'register', requestId: request.id, path: tool, prompt: request.prompt, referencePaths: request.referencePaths });
  assert.deepEqual(m.originalSize, { width: 1400, height: 1400 }); assert.equal(hash(m.originalPath), originalHash);
  assert(m.workingSize.width * m.workingSize.height <= 1_500_000); assert(m.workingSize.width < 1400);
  const r = await f.send({ action: 'derive-alpha', baseGenerationId: b.record.id, matteId: m.id,
    expectedBaseWorkingHash: b.record.workingHash, expectedMatteWorkingHash: m.workingHash });
  assert.deepEqual(r.workingSize, { width: 80, height: 80 }); assert.equal(hash(tool), originalHash);
  assert.equal(r.derivedAlpha.mapping.scale, 80 / m.workingSize.width);
});

test('aux-matte HTTP review, composite approval and final apply recursively check sources; valid completion creates a new node', async () => {
  const f = await fixture(), b = await base(f), m = await auxiliary(f, b), r = await f.send(deriveBody(b, m));
  const before = store.load(f.d.id), payload = await approveFixture(f, r), stable = generationState(f.j);
  for (const action of ['review', 'review-composite', 'apply'] as const) {
    fs.appendFileSync(m.tool, 'changed');
    try {
      const composite = stable.composite!;
      const result = action === 'apply' ? await post(`/api/jobs/${f.j.id}/apply`, payload)
        : await post(`/api/jobs/${f.j.id}/generation`, { taskId: f.j.taskId,
          ...(action === 'review' ? { action, generationId: r.id, comparisonHash: r.comparisonHash,
            elements: [{ name: 'cloth', status: 'matched', observation: 'fixture with changed matte must not be accepted' }],
            review: { status: 'accepted', attempts: [{ method: 'guard probe', observation: 'source changed' }], issues: [] } }
            : { action, ...composite.review }) });
      assert(result.status >= 400, JSON.stringify(result.value)); assert.match(result.value.error, /变化/);
      assert.deepEqual(store.load(f.d.id), before); assert.equal(generationState(f.j).outputs[1].review, undefined);
    } finally { fs.writeFileSync(m.tool, fs.readFileSync(m.record.originalPath)); store.atomic(f.registry, stable); }
  }
  const done = await api(`/api/jobs/${f.j.id}/apply`, payload);
  assert.equal(done.document.images.length, 2); assert.deepEqual(done.document.images[0], before.images[0]);
  const im = done.document.images[1]; assert.equal(im.layers[0].generationId, r.id);
  const current = generationState(store.getJob(f.j.id));
  assert.equal(current.outputs.length, 2); assert.equal(current.auxiliaries!.length, 1);
});

test('aux-matte HTTP composite/apply async consumers refuse changed lineage and preserve existing documents', async (t) => {
  for (const action of ['composite', 'apply'] as const) await t.test(action, async () => {
    const f = await fixture(), b = await base(f), m = await auxiliary(f, b), r = await f.send(deriveBody(b, m));
    const payload = action === 'apply' ? await approveFixture(f, r) : undefined;
    const beforeDoc = store.load(f.d.id), before = generationState(f.j), originalWrite = fs.writeFileSync;
    let fired = false, artifact = '', assetWrites = 0;
    fs.writeFileSync = ((p: any, ...args: any[]) => {
      const result = Reflect.apply(originalWrite, fs, [p, ...args]);
      const output = typeof p === 'string' && path.extname(p) === '.png';
      const trigger = output && (action === 'composite' ? p.includes(path.sep + 'composites' + path.sep)
        : p.includes(path.sep + 'assets' + path.sep) && ++assetWrites === 3);
      if (!fired && trigger) {
        fired = true; artifact = p;
        const changed = generationState(f.j); changed.auxiliaries![0].receipt.prompt += 'changed'; store.atomic(f.registry, changed);
      }
      return result;
    }) as typeof fs.writeFileSync;
    try {
      const result = action === 'apply' ? await post(`/api/jobs/${f.j.id}/apply`, payload)
        : await post(`/api/jobs/${f.j.id}/generation`, { taskId: f.j.taskId, action, generationIds: [r.id] });
      assert(fired, `${action} window was not reached`); assert(result.status >= 400, JSON.stringify(result.value));
      assert.match(result.value.error, /变化/); assert(fs.existsSync(artifact));
      assert.deepEqual(store.load(f.d.id), beforeDoc);
      assert.equal(generationState(f.j).auxiliaries![0].receipt.prompt, before.auxiliaries![0].receipt.prompt + 'changed');
    } finally { fs.writeFileSync = originalWrite; }
  });
});

async function packedFixture(extraLayer = false, version: 1 | 2 = 1) {
  const f = await fixture(false, 'layer', extraLayer);
  f.layout.layers[0].packedBackdrop = { version, arrangement: 'black-left-white-right', panelSize: { width: 80, height: 80 },
    ...(version === 2 ? { normalization: 'whole-carrier-nearest-v1' } : {}) };
  f.layout.layers[0].alphaChecks = [...checks, { name: 'own black ink', kind: 'occupied', box: [40, 40, 4, 4], minAlpha: 240, minPassingFraction: 1 }];
  await f.send({ action: 'layout', layout: f.layout });
  const q = await f.send({ action: 'prepare', sourceLayerIds: ['cloth'], elements: ['cloth'], purpose: 'single carrier engineered fixture, no inference', referenceObservation: 'same opaque black ink and continuously thin foreground with real clear gap' });
  return { ...f, q };
}
async function packedPixels(incompatible = false, w = 80, h = 80) {
  const data = Buffer.alloc(2*w*h*4);
  for (let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const px = Math.floor((x+.5)*80/w), py = Math.floor((y+.5)*80/h);
    const gap = px<16 && py<16, ink = px>=20 && px<24 && py>=20 && py<24;
    const a = gap ? 0 : ink ? 255 : 128, fg = ink ? [0,0,0] : [160,80,40];
    for (let side=0;side<2;side++) {
      const i=(y*w*2+x+side*w)*4;
      for(let k=0;k<3;k++) data[i+k]=Math.round(a/255*fg[k]+(side ? 255-a : 0));
      data[i+3]=255;
    }
  }
  if(incompatible) data.set([255,0,0,255],(35*160+35+80)*4);
  return sharp(data,{raw:{width:w*2,height:h,channels:4}}).png().toBuffer();
}
async function packedRegister(f: Awaited<ReturnType<typeof packedFixture>>, bytes: Buffer) {
  const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID()+'.png');fs.writeFileSync(tool,bytes);
  const c = await f.send({action:'register',requestId:f.q.id,path:tool,prompt:f.q.prompt,referencePaths:f.q.referencePaths});
  return {c,tool};
}
test('single carrier HTTP derives actual same-foreground panels; honest provenance survives composite, failed review and new canvas node', async () => {
  const f=await packedFixture();assert.equal(f.q.transparent_background,false);assert.deepEqual(f.q.generation.size,{width:160,height:80});
  assert.match(f.q.prompt,/两板合计/);assert.match(f.q.prompt,/固定垂直中线/);
  const {c,tool}=await packedRegister(f,await packedPixels());const originalHash=hash(tool);
  assert.equal(c.intermediateOnly,true);assert.equal(c.receipt.modelCalls,1);assert.equal(generationState(f.j).outputs.length,0);
  await f.reject({action:'composite',generationIds:[c.id]},/缺少|不存在|匹配/);
  const r=await f.send({action:'derive-packed-alpha',packedId:c.id,expectedCarrierHash:c.working.hash});
  assert.equal(r.kind,'derived-packed-alpha');assert.equal(r.receipt.tool,'derived-packed-alpha');assert.equal(r.alphaDiagnostics.passed,true);
  assert.equal(generationState(f.j).auxiliaries,undefined);assert.equal(hash(tool),originalHash);
  const px=await sharp(fs.readFileSync(r.workingPath)).ensureAlpha().raw().toBuffer();
  assert.equal(px[(22*80+22)*4+3],255);assert.equal(px[(11*80+11)*4+3],0);assert.equal(px[(35*80+35)*4+3],128);
  assert.deepEqual([...px.subarray((22*80+22)*4,(22*80+22)*4+3)],[0,0,0]);
  await f.reject({action:'align',generationId:r.id,points:[{source:[0,0],target:[20,20]},{source:[80,80],target:[100,100]}],observation:'cannot adjust packed panels'},/不能|冻结/);
  await f.send({action:'review',generationId:r.id,comparisonHash:r.comparisonHash,elements:[{name:'cloth',status:'different',observation:'工程夹具内容尚未匹配实际海报'}],evidence:{geometry:'实际夹具完整板面原位固定，与原图内容仍有差异',appearance:'夹具前景非真实模型输出，不声称视觉一致',isolation:'两板方程与黑墨覆盖通过但仅为工程夹具',candidateIds:[r.id]},
    review:{status:'needs-revision',attempts:[{method:'固定单次carrier工程验证',observation:'未调用真实模型，不作为视觉验收'}],issues:[{message:'夹具不是实际海报重建，保持未通过'}]}});
  const composite=await f.send({action:'composite',generationIds:[r.id]});
  await f.send({action:'review-composite',comparisonHash:composite.comparisonHash,layers:[{generationId:r.id,status:'different',observation:'工程夹具验证来源协议，未匹配实际源海报内容'}],relations:[]});
  const applied=await api('/api/jobs/'+f.j.id+'/apply',{taskId:f.j.taskId,baseVersion:f.j.version,layers:[{id:'cloth',name:'cloth',...r.frame,path:r.originalPath,generationId:r.id}]});
  assert.equal(applied.document.images.length,2);assert.equal(applied.document.images[1].layers[0].review.status,'needs-revision');
});
test('single carrier refuses input drift and repeats, preserves failure panels and prevents role laundering', async () => {
  const f=await packedFixture(),{c,tool}=await packedRegister(f,await packedPixels(true)),rawHash=hash(tool);
  await f.reject({action:'derive-packed-alpha',packedId:c.id,expectedCarrierHash:'0'.repeat(64)},/摘要/);
  await f.reject({action:'derive-packed-alpha',packedId:c.id,expectedCarrierHash:c.working.hash},/不相容/);
  const s=generationState(f.j);assert.equal(s.outputs.length,0);assert.equal(s.packedFailures?.length,1);
  const failure=s.packedFailures![0];assert.equal(JSON.parse(fs.readFileSync(failure.diagnosticPath,'utf8')).generatedRGBA,false);
  const registryHash=hash(f.registry);
  await f.reject({action:'derive-packed-alpha',packedId:c.id,expectedCarrierHash:c.working.hash},/已保存/);
  assert.equal(hash(f.registry),registryHash);assert.equal(hash(tool),rawHash);
  await f.reject({action:'prepare',sourceLayerIds:['cloth'],elements:['cloth'],purpose:'repeat same method',referenceObservation:'same frozen carrier must not be billed again'},/已经准备/);
  const q=generationState(f.j).requests[0];
  await f.reject({action:'register',requestId:q.id,path:failure.black.path,prompt:q.prompt,referencePaths:q.referencePaths},/已经登记/);
  const other=await fixture(),otherQ=await other.send({action:'prepare',sourceLayerIds:['cloth'],elements:['cloth'],purpose:'unrelated existing route',referenceObservation:'legacy unchanged background alpha fixture'});
  assert.equal(otherQ.transparent_background,true);
});
test('single carrier checks complete budget, native format, binding, panel provenance and cached approvals after tampering', async () => {
  const {normalizePackedCarrier,splitPackedCarrier}=await import('../server/generation-packed.js');
  const recipe={version:1,arrangement:'black-left-white-right',panelSize:{width:80,height:80}} as const;
  const over=await sharp(await packedPixels()).resize(2000,1000,{kernel:'nearest'}).png().toBuffer();
  const normalized=await normalizePackedCarrier(over,recipe);assert(normalized.workingSize.width*normalized.workingSize.height<=1500000);
  assert.equal(normalized.workingSize.width%2,0);assert.deepEqual(normalized.originalSize,{width:2000,height:1000});
  await assert.rejects(normalizePackedCarrier(await sharp(await packedPixels()).resize(161,80).png().toBuffer(),recipe),/偶数宽/);
  await assert.rejects(normalizePackedCarrier(await sharp(await packedPixels()).resize(160,90).png().toBuffer(),recipe),/比例/);
  assert.throws(()=>generationLayoutSchema.parse({layers:[{sourceLayerIds:['a'],elements:['a'],excludes:'b',packedBackdrop:{...recipe,panelSize:{width:1000,height:1000}}}]}),/150万/);
  const f=await packedFixture(),{c}=await packedRegister(f,await packedPixels());
  const r=await f.send({action:'derive-packed-alpha',packedId:c.id,expectedCarrierHash:c.working.hash});
  const state=generationState(f.j), saved=structuredClone(state), panel=r.packedAlpha.white;
  const old=fs.readFileSync(panel.path);fs.writeFileSync(panel.path,await sharp(old).negate().png().toBuffer());
  await f.reject({action:'composite',generationIds:[r.id]},/板件|来源|变化/);
  fs.writeFileSync(panel.path,old);store.atomic(f.registry,saved);
  const forged=generationState(f.j);forged.outputs[0].packedAlpha!.outputHash='0'.repeat(64);store.atomic(f.registry,forged);
  await f.reject({action:'composite',generationIds:[r.id]},/输出|来源|变化/);
  store.atomic(f.registry,saved);
  forged.requests[0].packedBackdrop!.panelSize.width=79;store.atomic(f.registry,forged);
  await f.reject({action:'composite',generationIds:[r.id]},/绑定|计划|摘要|来源|不符/);
  store.atomic(f.registry,saved);
  const stripped=generationState(f.j);delete stripped.outputs[0].packedAlpha;delete stripped.outputs[0].kind;stripped.outputs[0].receipt.tool='image_gen';store.atomic(f.registry,stripped);
  await f.reject({action:'composite',generationIds:[r.id]},/角色|单次|双板|身份|派生/);
  const panels=await splitPackedCarrier(fs.readFileSync(c.working.path));assert.equal(hash(c.original.path),hash(c.toolOutput.path));assert.equal(panels.size.width,80);
});

test('single carrier generated panels including failed panels cannot be re-registered under an unrelated image_gen layer', async () => {
  for(const incompatible of [false,true]) {
    const f=await packedFixture(true),{c}=await packedRegister(f,await packedPixels(incompatible));
    let panels;
    if(incompatible){await f.reject({action:'derive-packed-alpha',packedId:c.id,expectedCarrierHash:c.working.hash},/不相容/);panels=generationState(f.j).packedFailures![0];}
    else {const r=await f.send({action:'derive-packed-alpha',packedId:c.id,expectedCarrierHash:c.working.hash});panels=r.packedAlpha;}
    const q=await f.send({action:'prepare',sourceLayerIds:['other'],elements:['other'],purpose:'alias probe no model call',referenceObservation:'unrelated image_gen candidate must retain generated panel identity'});
    for(const p of [panels.black.path,panels.white.path,c.original.path]) {
      const alias=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');
      fs.writeFileSync(alias,await sharp(fs.readFileSync(p)).png({compressionLevel:0}).toBuffer());
      await f.reject({action:'register',requestId:q.id,path:alias,prompt:q.prompt,referencePaths:q.referencePaths},/角色|别名|派生|image_gen/);
    }
  }
});
test('single carrier registration and derivation reject async source, raw and registry races without overwriting current state', async (t) => {
  for(const target of ['register-raw','register-source','register-registry','derive-raw','derive-source','derive-registry'] as const) await t.test(target,async()=>{
    const f=await packedFixture(),tool=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');fs.writeFileSync(tool,await packedPixels());
    let c;
    if(target.startsWith('derive'))c=await f.send({action:'register',requestId:f.q.id,path:tool,prompt:f.q.prompt,referencePaths:f.q.referencePaths});
    const before=generationState(f.j),source=store.assetPath(f.j.documentId,f.j.snapshot.source),rawFile=target.endsWith('source')?source:tool;
    const raw=fs.readFileSync(rawFile),originalWrite=fs.writeFileSync;let fired=false,artifact='';
    fs.writeFileSync=((p:any,...args:any[])=>{
      const result=Reflect.apply(originalWrite,fs,[p,...args]);
      const trigger=target.startsWith('register')?'original.png':'derived.png';
      if(!fired && typeof p==='string' && path.basename(p)===trigger && p.includes(target.startsWith('register')?'packed-':'packed-derived-')){
        fired=true;artifact=p;
        if(target.endsWith('registry')){const s:any=generationState(f.j);s.concurrentPackedProbe='preserve newer state';store.atomic(f.registry,s);}
        else fs.appendFileSync(rawFile,'raced');
      }
      return result;
    }) as typeof fs.writeFileSync;
    try {
      await f.reject(target.startsWith('register')?{action:'register',requestId:f.q.id,path:tool,prompt:f.q.prompt,referencePaths:f.q.referencePaths}
        :{action:'derive-packed-alpha',packedId:c.id,expectedCarrierHash:c.working.hash},/变化|不符|摘要|来源/);
      assert(fired);assert(fs.existsSync(artifact));assert.equal(generationState(f.j).outputs.length,0);
      if(target.endsWith('registry'))assert.equal((generationState(f.j) as any).concurrentPackedProbe,'preserve newer state');
      else assert.deepEqual(generationState(f.j),before);
    }finally{fs.writeFileSync=originalWrite;originalWrite(rawFile,raw);}
  });
});

test('single carrier V2 eliminates negative-lobe seam contamination without altering frozen V1 or real foreground incompatibility',async()=>{
  const {normalizePackedCarrier,splitPackedCarrier}=await import('../server/generation-packed.js');
  const width=2000,height=1000,half=1000,data=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<half;x++)for(let side=0;side<2;side++){
    const a=x<500?0:255,v=side?255-a:0;data.set([v,v,v,255],(y*width+x+side*half)*4);
  }
  const raw=await sharp(data,{raw:{width,height,channels:4}}).png().toBuffer();
  const recipe={version:1,arrangement:'black-left-white-right',panelSize:{width:80,height:80}} as const;
  const old=await normalizePackedCarrier(raw,recipe),oldPanels=await splitPackedCarrier(old.bytes);
  await assert.rejects(applyDualBackdrop(oldPanels.black,oldPanels.white),/不相容.*866像素/);
  const next={...recipe,version:2,normalization:'whole-carrier-nearest-v1'} as const;
  const fixed=await normalizePackedCarrier(raw,next),panels=await splitPackedCarrier(fixed.bytes),result=await applyDualBackdrop(panels.black,panels.white);
  assert.equal(result.unmix.maxRecompositionError,0);assert(fixed.workingSize.width*fixed.workingSize.height<=1500000);
  assert.deepEqual(fixed.workingSize,old.workingSize);
  const decoded=await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  for(let i=0;i<decoded.length;i+=4){assert.equal(decoded[i],0);assert.equal(decoded[i+1],0);assert.equal(decoded[i+2],0);assert([0,255].includes(decoded[i+3]));}
  const native=await packedPixels(true),bad=await normalizePackedCarrier(native,next),badPanels=await splitPackedCarrier(bad.bytes);
  await assert.rejects(applyDualBackdrop(badPanels.black,badPanels.white),/不相容/);
  assert.throws(()=>generationLayoutSchema.parse({layers:[{sourceLayerIds:['a'],elements:['a'],excludes:'b',packedBackdrop:{...recipe,version:2}}]}),/normalization/);
  assert.throws(()=>generationLayoutSchema.parse({layers:[{sourceLayerIds:['a'],elements:['a'],excludes:'b',packedBackdrop:{...recipe,normalization:'whole-carrier-nearest-v1'}}]}),/unrecognized|Unrecognized/);
});
test('single carrier V2 HTTP freezes normalization before real receipt and derives the complete budget carrier with unchanged opaque ink',async()=>{
  const f=await packedFixture(false,2);assert.match(f.q.prompt,/whole-carrier-nearest-v1/);
  // Construct the high-resolution physical pair directly. An external library
  // resize of a packed fixture can itself phase the halves before registration.
  const bytes=await packedPixels(false,1000,1000);
  const {c,tool}=await packedRegister(f,bytes);assert.equal(c.recipe.version,2);assert.equal(hash(tool),c.original.hash);
  const r=await f.send({action:'derive-packed-alpha',packedId:c.id,expectedCarrierHash:c.working.hash});
  assert.equal(r.alphaDiagnostics.passed,true);assert(r.workingSize.width*r.workingSize.height*2<=1500000);
  assert(r.packedAlpha.unmix.maxRecompositionError<=1); // encoded 8-bit rounding, not a relaxed production limit
  const state=generationState(f.j);state.packedCarriers![0].recipe={version:1,arrangement:'black-left-white-right',panelSize:{width:80,height:80}};store.atomic(f.registry,state);
  await f.reject({action:'composite',generationIds:[r.id]},/来源|角色|不符|变化/);
});
