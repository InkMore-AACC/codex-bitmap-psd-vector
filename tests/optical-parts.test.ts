import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { planningLayer } from '../shared/planning.js';
import { generationLayoutSchema } from '../shared/generation.js';
import { photoshopPlanSchema } from '../shared/photoshop.js';
import { validateOpticalParts } from '../shared/optical-parts.js';
process.env.LAYER_CANVAS_DATA = path.resolve('test-output/optical-parts-' + crypto.randomUUID());
const { app, TOKEN, BRIDGE_TOKEN } = await import('../server/index.js');
const store = await import('../server/store.js');
const { generationState, registeredGeneration } = await import('../server/generation.js');
const { validateLayout } = await import('../server/generation-workflow.js');
const { validatePhotoshopPlan, photoshopState } = await import('../server/photoshop-rebuild.js');
app.locals.codexSender = async () => ({ delivered: true });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(r => server.once('listening', r));
after(() => { server.closeAllConnections(); server.close(); });
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function post(route: string, body: unknown, status = 200) {
  const response = await fetch(origin + route, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': TOKEN, 'X-Canvas-Bridge': BRIDGE_TOKEN } });
  const value: any = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
}
const frame = { x: 20, y: 20, width: 80, height: 80 };
const clear = { name: 'outside owned part', kind: 'clear', box: [22, 22, 4, 4], maxAlpha: 8, minPassingFraction: 1 };
const film = { name: 'continuous film', kind: 'transmissive', box: [50, 50, 8, 8], minAlpha: 24,
  maxAlpha: 224, minBackgroundResponse: 31, minPassingFraction: 1 };
const ink = { name: 'black ink', kind: 'occupied', box: [50, 50, 8, 8], minAlpha: 240, minPassingFraction: 0.8 };
async function fixture(type = 'layer') {
  const d = store.getByTask('optical_fixture_' + crypto.randomUUID());
  const url = store.writeAsset(d.id, await sharp({ create: { width: 120, height: 120, channels: 3, background: '#324859' } }).png().toBuffer(), '.png');
  const names = ['continuous PET', 'black print and rim', 'droplets'];
  d.images.push({ id: 'source', name: 'engineering fixture, not model output', width: 120, height: 120, x: 0, y: 0,
    source: url, url, status: 'preview', version: 1, annotations: [], opinion: '',
    layers: names.map((name, i) => planningLayer('part' + i, name, frame, 'foreground', '')) });
  store.save(d);
  const created = await post(`/api/document/${d.id}/jobs`, { imageId: 'source', type }, 202);
  await post(`/api/jobs/${created.id}/claim`, { taskId: d.taskId });
  const j = store.getJob(created.id); assert.equal(j.reconstructionWorkflowVersion, 4);
  const layout = generationLayoutSchema.parse({ layers: names.map((name, i) => ({ sourceLayerIds: ['part' + i], elements: [name], excludes: 'environment',
    opticalPart: { version: 1, assemblyId: 'PET', kind: ['thin-film', 'opaque-structure', 'surface-detail'][i] },
    alphaChecks: i === 0 ? [clear, film] : i === 1 ? [clear, ink] : [clear],
  })), relations: [{ id: 'registration', kind: 'alignment', layerIds: ['part0', 'part1', 'part2'], observation: 'all three keep frozen source positions' }] });
  const plan = photoshopPlanSchema.parse({ canvas: { width: 120, height: 120 }, relations: layout.relations,
    layers: layout.layers.map((l, i) => ({ layerId: l.sourceLayerIds[0], name: names[i], frame, route: 'generate', content: 'bitmap', surface: 'transparent',
      rationale: 'own material separate from environment', includes: names[i], excludes: l.excludes, compositing: 'normal alpha', editable: 'pixels',
      elements: l.elements, opticalPart: l.opticalPart, alphaChecks: l.alphaChecks })) });
  const route = `/api/jobs/${j.id}/generation`, psRoute = `/api/jobs/${j.id}/ps-rebuild`;
  const send = (body: unknown, status = 200) => post(route, { taskId: d.taskId, ...body as any }, status);
  const psSend = (body: unknown, status = 200) => post(psRoute, { taskId: d.taskId, ...body as any }, status);
  const save = () => type === 'photoshop' ? psSend({ action: 'plan', plan }) : send({ action: 'layout', layout });
  const prepare = (index = 0, promptStyle?: string) => send({ action: 'prepare', sourceLayerIds: ['part' + index], elements: [names[index]],
    purpose: 'engineering prompt and ownership test, no billed call', referenceObservation: 'frozen component location', ...(promptStyle ? { promptStyle } : {}) });
  const registry = path.join(store.dir(d.id), 'jobs', j.id, 'generation', 'registry.json');
  return { d, j, names, layout, plan, send, psSend, save, prepare, registry };
}

test('new explicit optical ownership preserves absent old schema fields and rejects invented parameters', () => {
  const old = generationLayoutSchema.parse({ layers: [{ sourceLayerIds: ['x'], elements: ['x'], excludes: 'environment' }] });
  assert(!Object.hasOwn(old.layers[0], 'opticalPart'));
  assert(!Object.hasOwn(old.layers[0], 'contourSearch'));
  assert.throws(() => generationLayoutSchema.parse({ ...old, layers: [{ ...old.layers[0], opticalPart: {
    version: 1, assemblyId: 'PET', kind: 'thin-film', opacity: 0.5 } }] }));
  assert.doesNotThrow(() => validateOpticalParts([], []));
});

test('v2 both-route plans require shared noncollinear source anchors before preparing, and preserve their binding', async () => {
  const anchors = [
    { name: 'upper left rim', point: [30, 30] as [number, number], observation: 'actual source corner; not painted into the film' },
    { name: 'upper right rim', point: [90, 30] as [number, number], observation: 'actual source corner; not painted into the film' },
    { name: 'lower right rim', point: [90, 90] as [number, number], observation: 'actual source corner; not painted into the film' },
  ];
  for (const type of ['layer', 'photoshop']) for (const style of ['structured', 'concise-edit']) {
    const f = await fixture(type);
    const plan = type === 'photoshop' ? f.plan : f.layout;
    plan.layers.forEach(l => { l.opticalPart!.version = 2; l.anchors = structuredClone(anchors); });
    const validate = (p: any) => type === 'photoshop' ? validatePhotoshopPlan(f.j, p) : validateLayout(f.j, p);
    assert.doesNotThrow(() => validate(plan));
    for (const variant of ['missing', 'two', 'collinear', 'duplicate', 'name', 'point', 'observation', 'mixed']) {
      const bad = structuredClone(plan);
      if (variant === 'missing') bad.layers[0].anchors = [];
      if (variant === 'two') bad.layers.forEach(l => { l.anchors.pop(); });
      if (variant === 'collinear') bad.layers.forEach(l => { l.anchors[2].point = [60, 30]; });
      if (variant === 'duplicate') bad.layers.forEach(l => { l.anchors[2].point = [90, 30]; });
      if (variant === 'name') bad.layers[1].anchors[0].name = 'invented corner';
      if (variant === 'point') bad.layers[1].anchors[0].point[0] += 3;
      if (variant === 'observation') bad.layers[1].anchors[0].observation = 'a different source feature';
      if (variant === 'mixed') bad.layers[1].opticalPart!.version = 1;
      assert.throws(() => validate(bad), /光学组件|共同源定位点/, variant);
    }
    // Ordering is not identity; source coordinates and observations are.
    plan.layers[1].anchors.reverse(); assert.doesNotThrow(() => validate(plan));
    await f.save();
    const q = await f.prepare(0, style);
    assert.equal(q.opticalPart.version, 2); assert.deepEqual(q.anchors, anchors);
    assert.match(q.prompt, /相同画幅不是轮廓相合的证据/); assert.match(q.prompt, /upper left rim/);
    const changed = structuredClone(plan); changed.layers.forEach(l => { l.anchors[0].point[0] += 3; });
    const failure = type === 'photoshop'
      ? await f.psSend({ action: 'plan', plan: changed }, 400)
      : await f.send({ action: 'layout', layout: changed }, 400);
    assert.match(failure.error, /首次prepare|共同源定位点/);
    assert.equal(generationState(f.j).outputs.length, 0);
  }
});

test('both route plans reject mixed film/ink, missing parts, fake ownership routes and unlinked details', async () => {
  const f = await fixture(), ps = await fixture('photoshop');
  assert.doesNotThrow(() => validateLayout(f.j, f.layout));
  assert.doesNotThrow(() => validatePhotoshopPlan(ps.j, ps.plan));
  for (const variant of ['film-ink', 'ink-film', 'missing', 'two-films', 'unlinked', 'screen', 'matte', 'packed', 'duplicate']) {
    const layout: any = structuredClone(f.layout);
    if (variant === 'film-ink') layout.layers[0].alphaChecks.push(ink);
    if (variant === 'ink-film') layout.layers[1].alphaChecks.push(film);
    if (variant === 'missing') delete layout.layers[1].opticalPart;
    if (variant === 'two-films') { layout.layers[2].opticalPart.kind = 'thin-film'; layout.layers[2].alphaChecks.push(film); }
    if (variant === 'unlinked') layout.relations[0].layerIds.pop();
    if (variant === 'screen') { layout.layers[0].blendMode = 'screen'; layout.layers[0].content = 'light-effect'; }
    if (variant === 'matte') layout.layers[0].allowAuxMatte = true;
    if (variant === 'packed') layout.layers[0].packedBackdrop = { version: 2, arrangement: 'black-left-white-right', panelSize: { width: 80, height: 80 }, normalization: 'whole-carrier-nearest-v1' };
    if (variant === 'duplicate') layout.layers[1].elements = layout.layers[0].elements;
    assert.throws(() => validateLayout(f.j, layout), /光学|薄膜|实体|分件/, variant);
    if (!['screen', 'matte', 'packed'].includes(variant)) {
      const plan: any = structuredClone(ps.plan);
      plan.layers.forEach((l: any, i: number) => { l.opticalPart = layout.layers[i].opticalPart; l.elements = layout.layers[i].elements; l.alphaChecks = layout.layers[i].alphaChecks; });
      plan.relations = layout.relations;
      assert.throws(() => validatePhotoshopPlan(ps.j, plan), /光学|薄膜|实体|分件/, variant);
    }
  }
  for (const route of ['hybrid', 'extract', 'preserve']) {
    const plan = structuredClone(ps.plan); plan.layers[0].route = route as any;
    assert.throws(() => validatePhotoshopPlan(ps.j, plan), /光学分件/);
  }
  const native = structuredClone(ps.plan); native.layers[0].route = 'native'; native.layers[0].content = 'shape'; native.layers[0].editable = 'native-shape';
  assert.throws(() => validatePhotoshopPlan(ps.j, native), /nativeFilm/); // A route label cannot substitute a frozen recipe.
});
test('both routes freeze source-observed contour scope before prepare and reject film, out-of-frame and late target changes',async()=>{
  const anchors=[{name:'a',point:[30,30] as [number,number],observation:'source corner before output'},
    {name:'b',point:[90,30] as [number,number],observation:'source corner before output'},
    {name:'c',point:[90,90] as [number,number],observation:'source corner before output'}];
  for(const type of ['layer','photoshop']){
    const f=await fixture(type),p=type==='photoshop'?f.plan:f.layout;
    p.layers.forEach(l=>{l.opticalPart!.version=2;l.anchors=structuredClone(anchors);});
    p.layers[1].contourSearch={version:1,box:[40,40,30,30],observation:'源图观察实体黑印的范围，事前冻结，不按输出调整'};
    const validate=(p:any)=>type==='photoshop'?validatePhotoshopPlan(f.j,p):validateLayout(f.j,p);
    validate(p);
    const wrong=structuredClone(p);wrong.layers[0].contourSearch=structuredClone(p.layers[1].contourSearch);
    assert.throws(()=>validate(wrong),/轮廓搜索/);
    const outside=structuredClone(p);outside.layers[1].contourSearch!.box[0]=95;
    assert.throws(()=>validate(outside),/搜索范围/);
    await f.save();const q=await f.prepare(1);assert.deepEqual(q.contourSearch,p.layers[1].contourSearch);
    assert.match((await f.send({action:'auto-align',generationId:'not-yet-produced',contourSearch:p.layers[1].contourSearch},400)).error,/执行阶段不能覆盖/);
    assert.equal(q.referencePaths.length>0,true);assert.equal(generationState(f.j).outputs.length,0);
    const late=structuredClone(p);late.layers[1].contourSearch!.box[0]+=2;
    const rejected=type==='photoshop'?await f.psSend({action:'plan',plan:late},400):await f.send({action:'layout',layout:late},400);
    assert.match(rejected.error,/首次prepare/);
  }
});

test('v2 optical print can use declared planar native font rendering but cannot impersonate a film or image_gen', async () => {
  const f=await fixture(),fontPath='C:/Windows/Fonts/arial.ttf';
  const anchors=[{name:'left corner',point:[30,30] as [number,number],observation:'engineering actual source left corner'},
    {name:'right corner',point:[90,30] as [number,number],observation:'engineering actual source right corner'},
    {name:'lower corner',point:[90,90] as [number,number],observation:'engineering actual source lower corner'}];
  f.layout.layers.forEach(l=>{l.opticalPart!.version=2;l.anchors=structuredClone(anchors);});
  f.layout.layers[1].nativeText={version:2,observation:'工程已确认源位单色印字，不能冒称实际海报或字体匹配',
    transform:[1,.1,-.1,1,37,32],transformObservation:'工程已冻结轻微倾斜/斜切，只用于登记及身份验证',
    spans:[{text:'A B',fontPath,fontHash:crypto.createHash('sha256').update(fs.readFileSync(fontPath)).digest('hex'),
      fontSize:18,color:'#000000',box:{x:0,y:0,width:53,height:27}}]};
  assert.doesNotThrow(()=>validateLayout(f.j,f.layout));
  const wrong=structuredClone(f.layout);wrong.layers[0].nativeText=wrong.layers[1].nativeText;
  assert.throws(()=>validateLayout(f.j,wrong),/光学分件/);
  const legacy=structuredClone(f.layout);legacy.layers[1].nativeText={version:1,observation:'旧版水平字形不能套用v2光学平面窄例外',spans:legacy.layers[1].nativeText!.spans};
  assert.throws(()=>validateLayout(f.j,legacy),/光学分件/);
  await f.save();const q=await f.prepare(1,'concise-edit');
  assert.equal(q.role,'native-text');assert.equal(q.nativeText.version,2);assert.match(q.prompt,/事前观察的平面/);
  assert.match((await f.send({action:'register',requestId:q.id,path:q.localPath,prompt:q.prompt,referencePaths:q.referencePaths},500)).error,/后台render-native-text/);
  const result=await f.send({action:'render-native-text',requestId:q.id});
  assert.equal(result.kind,'native-text');assert.equal(result.receipt.tool,'native-font-renderer');
  registeredGeneration(f.j,result.id,result.sourceLayerIds,result.frame);
  const saved=fs.readFileSync(f.registry,'utf8'),drift=JSON.parse(saved);drift.layout.layers[1].nativeText.transform[4]+=3;
  fs.writeFileSync(f.registry,JSON.stringify(drift));assert.throws(()=>registeredGeneration(f.j,result.id,result.sourceLayerIds,result.frame),/原生字体|光学分件/);
  fs.writeFileSync(f.registry,saved);registeredGeneration(f.j,result.id,result.sourceLayerIds,result.frame);
  assert.equal(generationState(f.j).outputs.length,1);
});

test('ordinary and PS prepare propagate sibling exclusions in both prompt formats and freeze whole plan', async () => {
  for (const type of ['layer', 'photoshop']) for (const style of ['structured', 'concise-edit']) {
    const f = await fixture(type); await f.save();
    const q = await f.prepare(0, style);
    assert.equal(q.opticalPart.kind, 'thin-film'); assert.match(q.opticalPlanHash, /^[a-f0-9]{64}$/);
    assert.match(q.prompt, /冻结光学唯一归属/); assert.match(q.prompt, /black print and rim/); assert.match(q.prompt, /droplets/);
    assert.match(q.prompt, /背景RGB/); assert.match(q.prompt, /碎孔/); assert.equal(q.transparent_background, true);
    assert.doesNotMatch(q.prompt, /保留该材质自身水滴\/刻痕|保持本层实框、铰链|例如面罩后同组脸部皮肤/);
    const rim = await f.prepare(1, style); assert.match(rim.prompt, /固有黑墨不能因颜色深而删除/); assert.match(rim.prompt, /其余薄膜区域完全清空/);
    const detail = await f.prepare(2, style); assert.match(detail.prompt, /不填充薄膜底色/);
    for (const request of [q, rim, detail]) {
      assert.doesNotMatch(request.prompt, /仅保留该材质自身反射、水滴和印字/);
      assert.match(request.prompt, /同组件排除件/);
      assert.equal(request.referencePaths.length > 0, true);
    }
    if (type === 'photoshop') {
      const modified = structuredClone(f.plan); modified.layers.forEach(l => { delete l.opticalPart; });
      assert.match((await f.psSend({ action: 'plan', plan: modified }, 400)).error, /首次prepare/);
      await f.psSend({ action: 'plan', plan: f.plan });
      assert.equal(photoshopState(f.j).plan!.layers[0].opticalPart?.kind, 'thin-film');
    } else {
      const modified = structuredClone(f.layout); modified.layers.forEach(l => { delete l.opticalPart; });
      assert.match((await f.send({ action: 'layout', layout: modified }, 400)).error, /首次prepare/);
      await f.send({ action: 'layout', layout: f.layout });
    }
    assert.equal(generationState(f.j).outputs.length, 0);
    assert.match((await f.send({ action: 'prepare', sourceLayerIds: ['part0'], elements: [f.names[0]], purpose: 'inject', referenceObservation: 'inject',
      opticalPart: q.opticalPart }, 400)).error, /不能覆盖/);
  }
});

test('undeclared mixed-material prompts retain ownership instructions and prepared requests remain frozen', async () => {
  for (const type of ['layer', 'photoshop']) for (const style of ['structured', 'concise-edit']) {
    const f = await fixture(type);
    f.layout.layers.forEach(l => { delete l.opticalPart; });
    f.plan.layers.forEach(l => { delete l.opticalPart; });
    await f.save();
    const q = await f.prepare(0, style);
    assert.match(q.prompt, /保留该材质自身水滴\/刻痕/);
    assert.match(q.prompt, /例如面罩后同组脸部皮肤/);
    assert.match(q.prompt, /保持本层实框、铰链/);
    const before = JSON.stringify(generationState(f.j).requests.find(r => r.id === q.id));
    await f.prepare(1, style);
    assert.equal(JSON.stringify(generationState(f.j).requests.find(r => r.id === q.id)), before);
    assert.equal(generationState(f.j).outputs.length, 0);
  }
});

test('register and cached composite consumers reject optical plan drift or removed request binding; raw pixels remain intact', async () => {
  for (const type of ['layer', 'photoshop']) {
    const f = await fixture(type); await f.save(); const q = await f.prepare();
    const data = Buffer.alloc(80 * 80 * 4);
    for (let y = 12; y < 68; y++) for (let x = 12; x < 68; x++) data.set([70, 120, 160, 128], (y * 80 + x) * 4);
    const tool = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
    fs.writeFileSync(tool, await sharp(data, { raw: { width: 80, height: 80, channels: 4 } }).png().toBuffer());
    const body = { action: 'register', requestId: q.id, path: tool, prompt: q.prompt, referencePaths: q.referencePaths };
    const psFile = path.join(store.dir(f.d.id), 'jobs', f.j.id, 'photoshop-rebuild.json');
    const file = type === 'photoshop' ? psFile : f.registry, original = fs.readFileSync(file, 'utf8');
    const modified = JSON.parse(original); const p = type === 'photoshop' ? modified.plan : modified.layout;
    p.layers[1].excludes = 'silently changed ownership'; fs.writeFileSync(file, JSON.stringify(modified));
    assert.match((await f.send(body, 400)).error, /光学分件/);
    assert.equal(generationState(f.j).outputs.length, 0); fs.writeFileSync(file, original);
    const r = await f.send(body); assert.equal(r.receipt.tool, 'image_gen'); assert.equal(r.alphaDiagnostics.passed, true);
    // Synthetic fixture receipt exercises the API, never evidence of an actual model or PS.
    const before = fs.readFileSync(r.originalPath); registeredGeneration(f.j, r.id, r.sourceLayerIds, r.frame);
    const cached = type === 'layer' ? await f.send({ action: 'composite', generationIds: [r.id] }) : undefined;
    if (cached) assert.equal(cached.complete, false); // Two unmade parts are explicitly missing.
    const good = fs.readFileSync(f.registry, 'utf8'); const bad = JSON.parse(good);
    delete bad.requests[0].opticalPart; delete bad.requests[0].opticalPlanHash;
    fs.writeFileSync(f.registry, JSON.stringify(bad));
    assert.throws(() => registeredGeneration(f.j, r.id, r.sourceLayerIds, r.frame), /光学分件/);
    if (cached) {
      assert.equal(generationState(f.j).composite, undefined);
      assert.match((await f.send({ action: 'review-composite', comparisonHash: cached.comparisonHash,
        layers: [{ generationId: r.id, status: 'matched', observation: 'engineering cache cannot authorize changed ownership' }], relations: [] }, 500)).error, /最新合成/);
    }
    if (type === 'layer') assert.match((await f.send({ action: 'composite', generationIds: [r.id] }, 400)).error, /光学分件/);
    fs.writeFileSync(f.registry, good); assert.deepEqual(fs.readFileSync(r.originalPath), before);
    assert.equal(generationState(f.j).outputs.length, 1);
  }
});
