import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { generationPlan, generationCarrier } from '../shared/generation-geometry.js';
import { photoshopSettingsSchema, photoshopPlanSchema } from '../shared/photoshop.js';

process.env.LAYER_CANVAS_DATA = path.resolve('test-output/generation-' + crypto.randomUUID());
const { app, TOKEN, BRIDGE_TOKEN } = await import('../server/index.js');
const { nativeTextReport } = await import('../server/photoshop-native.js');
const store = await import('../server/store.js');
const { budgetWorkingCopy } = await import('../server/generation.js');
const { alignGeneration, landmarkTransform } = await import('../server/generation-alignment.js');
app.locals.codexSender = async () => ({ delivered: true });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
after(() => {
  server.closeAllConnections();
  server.close();
});
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function api(route: string, body?: any, status = 200) {
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
async function png(width: number, height: number, transparent = false) {
  const file = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 160;
      data[i + 1] = x % 255;
      data[i + 2] = y % 255;
      data[i + 3] =
        !transparent || (x > width / 4 && x < width / 2 && y > height / 3 && y < height * 0.9)
          ? 255
          : 0;
    }
  await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(file);
  return file;
}
async function fixture(type = 'layer', split = false) {
  let d = await api('/api/document?taskId=generation_' + crypto.randomUUID());
  d = await api(`/api/document/${d.id}/import-path`, {
    taskId: d.taskId,
    path: await png(160, 120),
  });
  const planJob = await api(
    `/api/document/${d.id}/jobs`,
    { imageId: d.images[0].id, type: 'plan', mode: 3 },
    202,
  );
  await api(`/api/jobs/${planJob.id}/claim`, { taskId: d.taskId });
  const planned = await api(`/api/jobs/${planJob.id}/plan`, {
    taskId: d.taskId,
    baseVersion: planJob.version,
    layers: [
      { name: '物体', box: [20, 30, 60, 40] },
      ...(split ? [{ name: '物体二', box: [90, 30, 40, 40] }] : []),
    ],
  });
  d = planned.document;
  const j = await api(`/api/document/${d.id}/jobs`, { imageId: d.images[0].id, type }, 202);
  await api(`/api/jobs/${j.id}/claim`, { taskId: d.taskId });
  const job = store.getJob(j.id);
  assert.equal(job.reconstructionVersion, 3);
  // Persisted v3 compatibility; production v4 defaults are exercised separately.
  delete job.reconstructionWorkflowVersion;
  store.saveJob(job);
  const layer = job.snapshot.layers[0];
  return { d, j: job, layer };
}
const review = (status: 'accepted' | 'needs-revision') => ({
  status,
  attempts:
    status === 'accepted'
      ? [{ method: '查看原图和实际叠图', observation: '测试夹具一致' }]
      : [
          { method: '首轮参考裁片', observation: '比例不符' },
          { method: '纠正画幅要求', observation: '仍有留边，保留较好版本' },
        ],
  issues: status === 'accepted' ? [] : [{ message: '实际文件比例不同，请修正构图' }],
});
async function prepare(j: any, id: string) {
  return api(`/api/jobs/${j.id}/generation`, {
    taskId: j.taskId,
    action: 'prepare',
    sourceLayerIds: [id],
    purpose: '保持原图物体，仅删除其他内容',
    elements: ['物体及边缘'],
    referenceObservation: '主体偏左，保留原有倾斜，不居中',
  });
}
async function register(j: any, p: any, file: string) {
  return api(`/api/jobs/${j.id}/generation`, {
    taskId: j.taskId,
    action: 'register',
    requestId: p.id,
    path: file,
    prompt: p.prompt,
    referencePaths: p.referencePaths,
  });
}

const contextOptions = { marginPixels: 8,
  observation: '干净源的可见边缘延伸到设计框之外，需要周边原像素避免截断' };
const singleContext = { ...contextOptions, referenceMode: 'context-only' };
test('v4背景保留外观只限本层归属，不保护源中排除的灯；两路线提示模式保留用户意见和旧请求', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, layer } = await fixture(route);
    if (route === 'photoshop') await api(`/api/jobs/${j.id}/ps-rebuild`, {taskId:j.taskId,action:'plan',plan:{canvas:j.snapshot,
      layers:[{layerId:layer.id,name:layer.name,route:'generate',content:'bitmap',surface:'transparent',frame:layer.frame,
        elements:['物体及边缘'],excludes:'背景和其他层',rationale:'兼容旧路线请求',includes:'物体及边缘',compositing:'normal',editable:'pixels'}],relations:[]}});
    const legacy = await prepare(j, layer.id), legacyPrompt = legacy.prompt;
    j.reconstructionWorkflowVersion = 4;
    j.snapshot.opinion = '固定建筑青LED亮度保持，禁止删掉固有窗口灯';
    layer.role = 'background'; layer.opinion = '右上独立笼灯及其暖光从背景移除，原位置补墙';
    store.saveJob(j);
    const excludes = '另列右上笼灯及其固有暖光、人物、牌、天空独立金弧、纸面正文图表及页脚标志';
    if (route === 'layer') await api(`/api/jobs/${j.id}/generation`, {taskId:j.taskId,action:'layout',layout:{
      layers:[{sourceLayerIds:[layer.id],elements:['连续海岸背景及固定建筑青LED'],excludes}],relations:[]}});
    else await api(`/api/jobs/${j.id}/ps-rebuild`, {taskId:j.taskId,action:'plan',plan:{canvas:j.snapshot,
      layers:[{layerId:layer.id,name:layer.name,route:'generate',content:'background',surface:'opaque',
        frame:layer.frame,elements:['连续海岸背景及固定建筑青LED'],excludes,rationale:'已明确灯归属',
        includes:'固定建筑青LED及窗口灯',compositing:'normal',editable:'pixels'}],relations:[]}});
    for (const promptStyle of ['structured','concise-edit'] as const) {
      const p=await api(`/api/jobs/${j.id}/generation`,{taskId:j.taskId,action:'prepare',sourceLayerIds:[layer.id],
        purpose:'补全遮挡背景，移除已另列独立灯具，固定楼灯仍属于本层',elements:['连续海岸背景及固定建筑青LED'],
        referenceObservation:'右上源中原有笼灯，冻结计划另列；楼宇竖青LED仍属于本背景',referenceStrategy:'local-only',promptStyle});
      assert.match(p.prompt,/仅保留属于本层的固有外观/);
      assert.match(p.prompt,/材质、颜色、明暗、纹理和形变按参考/);
      assert.match(p.prompt,/不增亮或新增光泽，也不抹掉原有光泽/);
      assert.doesNotMatch(p.prompt,/固有外观：细亮边、反射、渐变、柔光/);
      assert.match(p.prompt,/即使.*参考中.*已有.*仍须移除/);
      assert.match(p.prompt,/归属无法确认.*待审/);
      assert.match(p.prompt,/保留范围由本层元素清单决定/);
      assert.match(p.prompt,/即使印在本层保留的纸面、墙面或器物表面.*必须移除/);
      assert.match(p.prompt,/不保留残字、图表线或标志，不生成替代文字，不留透明孔洞/);
      assert.match(p.prompt,/本层元素清单明确拥有的文字、刻纹、细线和固定灯仍按参考保留/);
      assert.match(p.prompt,/纸面正文图表及页脚标志/);
      assert.doesNotMatch(p.prompt,/保留参考中实际可见的字形/);
      assert.doesNotMatch(p.prompt,/严格保持对象在完整文件中的位置、占比、字形/);
      assert.doesNotMatch(p.prompt,/只移除候选比参考多出的部分/);
      assert.match(p.prompt,/固定建筑青LED亮度保持，禁止删掉固有窗口灯/);
      assert.match(p.prompt,/右上独立笼灯及其暖光从背景移除，原位置补墙/);
      assert.match(p.prompt,/另列右上笼灯及其固有暖光、人物、牌、天空独立金弧/);
      assert.equal(p.surface,'opaque');
      assert.doesNotMatch(p.prompt,/使用真透明素材/);
      assert.deepEqual(p.anchors,[]);
    }
    const state=await api(`/api/jobs/${j.id}/generation`,{taskId:j.taskId,action:'status'});
    assert.equal(state.requests.find((p:any)=>p.id===legacy.id).prompt,legacyPrompt);
    assert.match(legacyPrompt,/只移除候选比参考多出的部分/);
  }
});
test('两路线背景可用未分离源细节区分排除灯与保留固定灯，完整首图和旧请求不变且细节不能登记为素材', async () => {
  for (const route of ['layer','photoshop'] as const) {
    const {j,layer}=await fixture(route);j.reconstructionWorkflowVersion=4;
    layer.role='background';layer.frame={x:0,y:0,width:160,height:120};store.saveJob(j);
    const elements=['背景与固定灯'],excludes='第二物体实体灯与其他前景';
    if(route==='layer')await api(`/api/jobs/${j.id}/generation`,{taskId:j.taskId,action:'layout',layout:{
      layers:[{sourceLayerIds:[layer.id],elements,excludes}],relations:[]}});
    else await api(`/api/jobs/${j.id}/ps-rebuild`,{taskId:j.taskId,action:'plan',plan:{canvas:j.snapshot,
      layers:[{layerId:layer.id,name:layer.name,route:'generate',content:'background',surface:'opaque',frame:layer.frame,
        elements,excludes,rationale:'明确保持固定灯、排除其他实体灯',includes:'背景与固定灯',compositing:'normal',editable:'pixels'}],relations:[]}});
    const body={taskId:j.taskId,action:'prepare',sourceLayerIds:[layer.id],elements,purpose:'仅移除指定实体灯，固定楼灯保持原位',
      referenceObservation:'完整构图中两种光源归属不同，细节只识别来源',referenceStrategy:'local-only',promptStyle:'concise-edit'};
    const old=await api(`/api/jobs/${j.id}/generation`,body),oldPrompt=old.prompt,oldFirst=fs.readFileSync(old.referencePaths[0]),snapshot=JSON.stringify(j.snapshot);
    const details=[{name:'识别移除另列实体灯',box:[90,30,40,40],observation:'此完整未分离源区域仅指认另列实体灯及其暖光，输出背景必须移除，不保留该灯或粘贴此裁片。'},
      {name:'识别保留建筑固定灯',box:[5,25,15,40],observation:'此完整未分离源区域用于指认本背景固定楼灯，保留其原位与亮度，不把此裁片粘贴进输出。'}];
    const p=await api(`/api/jobs/${j.id}/generation`,{...body,detailReferences:details});
    assert.equal(p.surface,'opaque');assert.equal(p.referencePaths.length,3);
    assert.deepEqual(p.referenceHashes[0],old.referenceHashes[0]);assert.deepEqual(fs.readFileSync(p.referencePaths[0]),oldFirst);
    const full=fs.readFileSync(p.referencePaths[0]);
    for(const [i,d]of details.entries()){
      const actual=p.detailReferences[i],expected=await sharp(full).extract({left:d.box[0],top:d.box[1],width:d.box[2],height:d.box[3]}).ensureAlpha().raw().toBuffer();
      assert.deepEqual(await sharp(fs.readFileSync(actual.path)).ensureAlpha().raw().toBuffer(),expected);
      assert.equal(actual.path,p.referencePaths[i+1]);assert.match(p.prompt,new RegExp(`第${i+2}张参考「${d.name}」`));
      assert(p.prompt.includes(d.observation));
      await api(`/api/jobs/${j.id}/generation`,{taskId:j.taskId,action:'register',requestId:p.id,path:actual.path,prompt:p.prompt,referencePaths:p.referencePaths},400);
    }
    const state=await api(`/api/jobs/${j.id}/generation`,{taskId:j.taskId,action:'status'});
    assert.equal(state.requests.find((x:any)=>x.id===old.id).prompt,oldPrompt);assert.equal(state.outputs.length,0);
    assert.equal(JSON.stringify(store.getJob(j.id).snapshot),snapshot);
    assert.match(p.prompt,/不把细节放大铺满、不粘贴裁片/);assert.deepEqual(p.frame,layer.frame);
  }
});
async function contextFixture(route: 'layer' | 'photoshop', scale = 1, twoAnchors = false,
  anchorRegion: 'design' | 'context' | 'outside-context' | 'outside-canvas' = 'design', thin = false) {
  const { j, layer } = await fixture(route);
  if (thin) layer.frame = { x: 20, y: 30, width: 120, height: 20 };
  j.reconstructionWorkflowVersion = 4; store.saveJob(j);
  const anchors = anchorRegion === 'design'
    ? [{ name: '固定源点', point: [25 * scale, 35 * scale], observation: '原像素纹理的固定交点' },
      ...(twoAnchors ? [{ name: '第二源点', point: [45 * scale, 45 * scale], observation: '合成夹具第二个冻结像素交点' }] : [])]
    : [{ name: '左框外源点', point: [(anchorRegion === 'outside-context' ? 11 : anchorRegion === 'outside-canvas' ? -1 : 15) * scale, 25 * scale], observation: '合成源参考左侧可见位置，首次prepare之前冻结' },
      { name: '右框外源点', point: [85 * scale, 75 * scale], observation: '合成源参考右下可见位置，首次prepare之前冻结' }];
  const frame = Object.fromEntries(Object.entries(layer.frame!).map(([k, v]) => [k, (v as number) * scale]));
  if (route === 'layer') await api(`/api/jobs/${j.id}/generation`, {
    taskId: j.taskId, action: 'layout', layout: { width: j.snapshot.width * scale, height: j.snapshot.height * scale,
      layers: [{ sourceLayerIds: [layer.id], elements: ['物体及边缘'], excludes: '背景和其他层', anchors }], relations: [] },
  });
  else await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan',
    plan: { canvas: { width: j.snapshot.width * scale, height: j.snapshot.height * scale },
      layers: [{ layerId: layer.id, name: layer.name, route: 'generate', content: 'bitmap', surface: 'transparent',
        frame, elements: ['物体及边缘'], excludes: '背景和其他层', rationale: '周边参考测试',
        includes: '物体及边缘', compositing: 'normal', editable: 'pixels', anchors }], relations: [] } });
  const body = { taskId: j.taskId, action: 'prepare', sourceLayerIds: [layer.id],
    purpose: '按原位置保留完整可见边缘，只移除其他层', elements: ['物体及边缘'],
    referenceObservation: '参考中纹理固定在原图位置，设计框外仍有本层真实笔画', referenceStrategy: 'local-only',
    referenceContext: contextOptions };
  return { j, layer, anchors, frame, body };
}

test('完整参考放大呈现两路只替换模型首图，源/定位/旧请求不变且拒绝原样或重编码素材冒充', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, body, anchors, frame } = await contextFixture(route);
    const baseBody = { ...body, referenceContext: undefined };
    const old = await api(`/api/jobs/${j.id}/generation`, baseBody);
    const snapshot = JSON.stringify(store.getJob(j.id).snapshot), source = fs.readFileSync(old.localPath);
    const p = await api(`/api/jobs/${j.id}/generation`, { ...baseBody, referenceScale: 3,
      promptStyle: route === 'layer' ? 'structured' : 'concise-edit' });
    assert.equal(p.referencePaths.length, 1); assert.notEqual(p.referencePaths[0], p.localPath);
    assert.deepEqual(p.frame, frame); assert.deepEqual(p.anchors, anchors);
    assert.deepEqual(p.generation, old.generation); assert.equal(p.transparent_background, true);
    assert.deepEqual(fs.readFileSync(p.localPath), source);
    const meta = await sharp(source).metadata(), rp = p.referencePresentation;
    assert.deepEqual(rp.size, { width: meta.width! * 3, height: meta.height! * 3 });
    assert(rp.size.width * rp.size.height <= 1500000);
    assert.equal(rp.sourceHash, p.localReferenceHash);
    assert.deepEqual(await sharp(fs.readFileSync(rp.path)).raw().toBuffer(),
      await sharp(source).resize({ ...rp.size, kernel: 'lanczos3' }).raw().toBuffer());
    assert.match(p.prompt, /插值不增加真实细节/);
    assert.match(p.prompt, /不把倍率当作对象放大要求/);
    for (const file of [rp.path, p.localPath]) {
      const alias = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
      await sharp(fs.readFileSync(file)).png({ compressionLevel: 0 }).toFile(alias);
      for (const output of [file, alias]) await api(`/api/jobs/${j.id}/generation`, {
        taskId: j.taskId, action: 'register', requestId: p.id, path: output,
        prompt: p.prompt, referencePaths: p.referencePaths }, 400);
    }
    const state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.equal(state.outputs.length, 0); assert.equal(state.requests.find((x: any) => x.id === old.id).prompt, old.prompt);
    assert.equal(JSON.stringify(store.getJob(j.id).snapshot), snapshot);
    const generated = await png(180, 120, true);
    const registered = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'register',
      requestId: p.id, path: generated, prompt: p.prompt, referencePaths: p.referencePaths });
    assert.deepEqual(registered.frame, frame); assert(registered.workingSize.width * registered.workingSize.height <= 1500000);
  }
});

test('窄条参考两路放大全部透明承载留白，冻结源/位置/预算并拒绝三类参考冒充与变更', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, body, anchors, frame } = await contextFixture(route, 1, true, 'design', true);
    const baseBody = { ...body, referenceContext: undefined };
    const old = await api(`/api/jobs/${j.id}/generation`, baseBody);
    const snapshot = JSON.stringify(store.getJob(j.id).snapshot);
    const p = await api(`/api/jobs/${j.id}/generation`, { ...baseBody, referenceScale: 4 });
    assert(p.generation.expanded); assert.deepEqual(p.frame, frame); assert.deepEqual(p.anchors, anchors);
    assert.deepEqual(p.generation, old.generation); assert.equal(p.referencePaths.length, 1);
    const rp = p.referencePresentation, local = fs.readFileSync(p.localPath), carrier = fs.readFileSync(rp.sourcePath);
    assert.notEqual(rp.sourcePath, p.localPath);
    assert.equal(p.localReferenceHash, crypto.createHash('sha256').update(local).digest('hex'));
    assert.equal(rp.sourceHash, crypto.createHash('sha256').update(carrier).digest('hex'));
    assert.deepEqual(rp.sourceSize, { width: 120, height: 40 });
    assert.deepEqual(rp.size, { width: 480, height: 160 });
    assert.deepEqual(await sharp(carrier).resize({ ...rp.size, kernel: 'lanczos3' }).raw().toBuffer(),
      await sharp(fs.readFileSync(rp.path)).raw().toBuffer());
    const raw = await sharp(carrier).ensureAlpha().raw().toBuffer();
    assert.equal(raw[3], 0); assert.equal(raw[raw.length - 1], 0);
    assert.deepEqual(await sharp(carrier).extract({ left: 0, top: 10, width: 120, height: 20 }).raw().toBuffer(),
      await sharp(local).ensureAlpha().raw().toBuffer());
    assert.match(p.prompt, /完整透明承载留白/);
    for (const file of [p.localPath, rp.sourcePath, rp.path]) {
      const alias = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
      await sharp(fs.readFileSync(file)).png({ compressionLevel: 0 }).toFile(alias);
      for (const output of [file, alias]) await api(`/api/jobs/${j.id}/generation`, {
        taskId: j.taskId, action: 'register', requestId: p.id, path: output,
        prompt: p.prompt, referencePaths: p.referencePaths }, 400);
    }
    const generated = await png(240, 80, true);
    for (const file of [p.localPath, rp.sourcePath, rp.path]) {
      const original = fs.readFileSync(file);
      fs.appendFileSync(file, Buffer.from('changed-reference'));
      await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'register', requestId: p.id,
        path: generated, prompt: p.prompt, referencePaths: p.referencePaths }, 500);
      fs.writeFileSync(file, original);
    }
    const r = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'register', requestId: p.id,
      path: generated, prompt: p.prompt, referencePaths: p.referencePaths });
    fs.appendFileSync(rp.sourcePath, Buffer.from('late-carrier-change'));
    await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'auto-align', generationId: r.id }, 500);
    fs.writeFileSync(rp.sourcePath, carrier);
    assert.deepEqual(r.frame, frame); assert(r.workingSize.width * r.workingSize.height <= 1500000);
    assert.equal(JSON.stringify(store.getJob(j.id).snapshot), snapshot);
    const state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.equal(state.requests.find((q: any) => q.id === old.id).prompt, old.prompt);
    const count = state.requests.length;
    // Entire padded file at 4x exceeds budget; never silently use 2x or crop away margins.
    const large = await contextFixture(route, 5, true, 'design', true);
    await api(`/api/jobs/${large.j.id}/generation`, { ...large.body, referenceContext: undefined, referenceScale: 4 }, 400);
    const rejected = await api(`/api/jobs/${large.j.id}/generation`, { taskId: large.j.taskId, action: 'status' });
    assert.equal(rejected.requests.length, 0); assert.equal(count, 2);
  }
});

test('单张放大参考提示与实际附件一致，两路两种文案及承载留白不指向不存在的第二张', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    for (const promptStyle of ['structured', 'concise-edit'] as const) {
      for (const expanded of [false, true]) {
        const { j, body, anchors, frame } = await contextFixture(route, 1, expanded, 'design', expanded);
        const baseBody = { ...body, referenceContext: undefined, promptStyle };
        const old = await api(`/api/jobs/${j.id}/generation`, baseBody);
        if (expanded) {
          assert.equal(old.referencePaths.length, 2);
          assert.match(old.prompt, /第二张(?:参考)?(?:是|保留)/);
        }
        const p = await api(`/api/jobs/${j.id}/generation`, { ...baseBody, referenceScale: 4 });
        assert.equal(p.referencePaths.length, 1);
        assert.equal(p.referencePaths[0], p.referencePresentation.path);
        assert.match(p.prompt, /没有第二张/);
        assert.doesNotMatch(p.prompt, /第二张(?:参考)?(?:是|保留)|后续整图提供语境|其余参考仅补充/);
        assert.deepEqual(p.frame, frame); assert.deepEqual(p.anchors, anchors);
        assert.deepEqual(p.generation, old.generation);
        const state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
        const frozen = state.requests.find((q: any) => q.id === old.id);
        assert.equal(frozen.prompt, old.prompt); assert.deepEqual(frozen.referencePaths, old.referencePaths);
      }
    }
  }
});

test('完整参考呈现不支持冲突路由，未落地请求；不向旧请求追改或退回别的倍率', async () => {
  const { j, body } = await contextFixture('layer');
  const plain = { ...body, referenceContext: undefined, referenceScale: 3 };
  for (const change of [{ referenceContext: body.referenceContext }, { referenceStrategy: 'local-and-global' },
    { detailReferences: [{ name: '局部', box: [25, 35, 20, 10], observation: '固定邻接纹理仅供细节识别使用' }] },
    { referenceScale: 1 }, { referenceScale: 2.5 }, { referenceScale: 5 }]) {
    await api(`/api/jobs/${j.id}/generation`, { ...plain, ...change }, 400);
  }
  j.reconstructionWorkflowVersion = undefined; store.saveJob(j);
  await api(`/api/jobs/${j.id}/generation`, plain, 400);
  let state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
  assert.equal(state.requests.length, 0);
  const background = await contextFixture('layer');
  background.j.snapshot.layers[0].role = 'background'; store.saveJob(background.j);
  await api(`/api/jobs/${background.j.id}/generation`, { ...background.body, referenceContext: undefined, referenceScale: 2 }, 400);
  state = await api(`/api/jobs/${background.j.id}/generation`, { taskId: background.j.taskId, action: 'status' });
  assert.equal(state.requests.length, 0);
});

test('完整参考呈现保留未传入模型的原局部哈希守卫，源变更不能登记或再使用已登记结果', async () => {
  const { j, body } = await contextFixture('layer');
  const p = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: undefined, referenceScale: 2 });
  const original = fs.readFileSync(p.localPath), generated = await png(120, 80, true);
  fs.appendFileSync(p.localPath, Buffer.from('changed'));
  await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'register', requestId: p.id,
    path: generated, prompt: p.prompt, referencePaths: p.referencePaths }, 500);
  fs.writeFileSync(p.localPath, original);
  const r = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'register', requestId: p.id,
    path: generated, prompt: p.prompt, referencePaths: p.referencePaths });
  fs.appendFileSync(p.localPath, Buffer.from('changed-again'));
  await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'auto-align', generationId: r.id }, 500);
  fs.writeFileSync(p.localPath, original);
});

test('周边承载不改冻结设计框和位置映射，旧默认不变，透明留白计入150万预算', () => {
  const frame = { x: 543, y: 43, width: 308, height: 129 }, copy = { ...frame };
  assert.deepEqual(generationCarrier(frame), generationCarrier(frame, true, 3, 0));
  const c = generationCarrier(frame, true, 3, 16);
  assert.deepEqual(frame, copy);
  assert.deepEqual(c.frame, { x: 527, y: 27, width: 340, height: 161 });
  assert.deepEqual(c.artwork, { x: 16, y: 16, width: 308, height: 129 });
  const large = generationCarrier({ x: 0, y: 0, width: 3000, height: 2000 }, true, 3, 128);
  assert(large.size.width * large.size.height <= 1500000);
  assert.throws(() => generationCarrier(frame, false, 3, 8), /周边参考/);
  assert.throws(() => generationCarrier({ x: 0, y: 0, width: 8000, height: 8000 }, true, 3, 8), /4000万/);
});

test('两路线周边首图取真实框外源像素，禁止裁片或重编码冒充，登记完整承载保留框外弱alpha', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, layer, body, anchors, frame } = await contextFixture(route);
    const frozen = JSON.stringify(j.snapshot);
    const p = await api(`/api/jobs/${j.id}/generation`, { ...body,
      promptStyle: route === 'layer' ? 'structured' : 'concise-edit',
      detailReferences: [{ name: '纹理', box: [25, 35, 20, 10], observation: '保留源图固定纹理与邻接像素的相对位置' }] });
    assert.deepEqual(p.frame, frame); assert.deepEqual(p.anchors, anchors);
    assert.equal(JSON.stringify(store.getJob(j.id).snapshot), frozen);
    assert.deepEqual(p.carrier.frame, { x: 12, y: 22, width: 76, height: 56 });
    assert.equal(p.referencePaths[0], p.referenceContext.path);
    assert.equal(p.referencePaths[1], p.localPath);
    assert.equal(p.referencePaths[2], p.detailReferences[0].path);
    assert.match(p.prompt, /旧.*框.*截/); assert.match(p.prompt, /第3张参考「纹理」/);
    assert.equal(p.referenceContext.sourceHash, crypto.createHash('sha256')
      .update(fs.readFileSync(p.referenceContext.sourcePath)).digest('hex'));
    const expected = await sharp(fs.readFileSync(p.referenceContext.sourcePath)).extract({ left: 12, top: 22, width: 76, height: 56 })
      .ensureAlpha().raw().toBuffer();
    const first = fs.readFileSync(p.referencePaths[0]);
    assert.deepEqual(await sharp(first).ensureAlpha().raw().toBuffer(), expected);
    const alias = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
    fs.writeFileSync(alias, await sharp(first).png({ compressionLevel: 0 }).toBuffer());
    for (const fake of [p.referenceContext.path, p.referenceContext.cropPath, alias]) {
      const rejected = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'register',
        requestId: p.id, path: fake, prompt: p.prompt, referencePaths: p.referencePaths }, 400);
      assert.match(rejected.error, /周边参考.*image_gen产物/);
    }
    const actual = await png(76, 56, true), raw = await sharp(actual).ensureAlpha().raw().toBuffer();
    raw.set([70, 100, 130, 1], (3 * 76 + 3) * 4); // Outside the original artwork rectangle.
    fs.writeFileSync(actual, await sharp(raw, { raw: { width: 76, height: 56, channels: 4 } }).png().toBuffer());
    const attempt = { taskId: j.taskId, action: 'register', requestId: p.id,
      path: actual, prompt: p.prompt, referencePaths: p.referencePaths };
    fs.writeFileSync(p.referenceContext.path, await sharp(first).negate().png().toBuffer());
    assert.match((await api(`/api/jobs/${j.id}/generation`, attempt, 500)).error, /参考已变更/);
    fs.writeFileSync(p.referenceContext.path, first);
    const cropBytes = fs.readFileSync(p.referenceContext.cropPath);
    fs.writeFileSync(p.referenceContext.cropPath, await sharp(cropBytes).negate().png().toBuffer());
    assert.match((await api(`/api/jobs/${j.id}/generation`, attempt, 400)).error, /冻结周边参考发生变化/);
    fs.writeFileSync(p.referenceContext.cropPath, cropBytes);
    assert.equal((await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' })).outputs.length, 0);
    const r = await register(j, p, actual);
    assert.deepEqual(r.frame, layer.frame); assert.deepEqual(r.placementFrame, p.carrier.frame);
    assert.deepEqual(fs.readFileSync(r.originalPath), fs.readFileSync(actual));
    assert.equal((await sharp(fs.readFileSync(r.workingPath)).ensureAlpha().raw().toBuffer())[(3 * 76 + 3) * 4 + 3], 1);
    const preview = await sharp(fs.readFileSync(r.placedPreviewPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([preview.info.width, preview.info.height], [76, 56]);
    assert.equal(preview.data[(3 * 76 + 3) * 4 + 3], 1, 'Review must retain the actual alpha outside the design frame');
    assert.deepEqual(r.comparisonFrame, p.carrier.frame);
    assert.equal(r.comparisonReferencePath, p.referenceContext.path);
    assert.equal(JSON.stringify(store.getJob(j.id).snapshot), frozen);
  }
});

test('两路线周边定位后仍按完整carrier审查，旧框和旧对比原件保留', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, body, anchors: points, frame } = await contextFixture(route, 1, true);
    const p = await api(`/api/jobs/${j.id}/generation`, body), actual = await png(76, 56, true);
    const raw = await sharp(fs.readFileSync(actual)).ensureAlpha().raw().toBuffer();
    raw.set([70, 100, 130, 1], (3 * 76 + 3) * 4);
    fs.writeFileSync(actual, await sharp(raw, { raw: { width: 76, height: 56, channels: 4 } }).png().toBuffer());
    const r = await register(j, p, actual), oldPreview = fs.readFileSync(r.placedPreviewPath), oldComparison = fs.readFileSync(r.comparisonPath);
    const frozen = JSON.stringify(store.getJob(j.id).snapshot);
    const aligned = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'align', generationId: r.id,
      anchorNames: points.map(a => a.name), points: [{ source: [13, 13], target: [5, 5] }, { source: [33, 23], target: [25, 15] }],
      observation: '合成夹具按两个生成前冻结对应点等比原位定位，仅验证审核视窗不丢框外像素' });
    assert.deepEqual(aligned.frame, frame); assert.deepEqual(aligned.placementFrame, p.carrier.frame);
    assert.deepEqual(aligned.comparisonFrame, p.carrier.frame); assert.equal(aligned.comparisonReferencePath, p.referenceContext.path);
    const preview = await sharp(fs.readFileSync(aligned.placedPreviewPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([preview.info.width, preview.info.height], [76, 56]); assert.equal(preview.data[(3 * 76 + 3) * 4 + 3], 1);
    assert.deepEqual(fs.readFileSync(r.placedPreviewPath), oldPreview); assert.deepEqual(fs.readFileSync(r.comparisonPath), oldComparison);
    assert.equal(JSON.stringify(store.getJob(j.id).snapshot), frozen);
  }
});

test('周边源框外冻结定位点在两路线prepare和align中有效，完整载体和弱alpha不截断', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, body, anchors, frame } = await contextFixture(route, 1, true, 'context');
    const frozen = JSON.stringify(j.snapshot), p = await api(`/api/jobs/${j.id}/generation`, body);
    assert.deepEqual(p.anchors, anchors); assert.deepEqual(p.frame, frame);
    const actual = await png(76, 56, true), raw = await sharp(fs.readFileSync(actual)).ensureAlpha().raw().toBuffer();
    raw.set([70, 100, 130, 1], (3 * 76 + 3) * 4);
    fs.writeFileSync(actual, await sharp(raw, { raw: { width: 76, height: 56, channels: 4 } }).png().toBuffer());
    const r = await register(j, p, actual), before = fs.readFileSync(r.originalPath);
    const input = { taskId: j.taskId, action: 'align', generationId: r.id, anchorNames: anchors.map(a => a.name),
      points: [{ source: [3, 3], target: [-5, -5] }, { source: [73, 53], target: [65, 45] }],
      observation: '合成周边源点落在设计框之外而在冻结真实周边之内，只做统一比例与平移，不修改目标或裁去框外像素' };
    await api(`/api/jobs/${j.id}/generation`, { ...input, points: [{ source: [3, 3], target: [-3, -5] }, input.points[1]] }, 500);
    const aligned = await api(`/api/jobs/${j.id}/generation`, input);
    assert.deepEqual(aligned.frame, frame); assert.deepEqual(aligned.placementFrame, p.carrier.frame);
    assert.deepEqual(aligned.comparisonFrame, p.carrier.frame);
    assert.deepEqual(fs.readFileSync(r.originalPath), before); assert.equal(JSON.stringify(store.getJob(j.id).snapshot), frozen);
    const view = await sharp(fs.readFileSync(aligned.placedPreviewPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([view.info.width, view.info.height], [76, 56]); assert.equal(view.data[(3 * 76 + 3) * 4 + 3], 1);
    assert(aligned.workingSize.width * aligned.workingSize.height <= 1500000);
  }
});

test('周边定位范围不放宽旧默认，不允许越过真实参考或整图画外留白', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const legacy = await contextFixture(route, 1, true, 'context');
    await api(`/api/jobs/${legacy.j.id}/generation`, { ...legacy.body, referenceContext: undefined }, 500);
    assert.equal((await api(`/api/jobs/${legacy.j.id}/generation`, { taskId: legacy.j.taskId, action: 'status' })).requests.length, 0);
    const outside = await contextFixture(route, 1, true, 'outside-context');
    await api(`/api/jobs/${outside.j.id}/generation`, outside.body, 400);
    const blank = await contextFixture(route, 1, true, 'outside-canvas');
    await api(`/api/jobs/${blank.j.id}/generation`, { ...blank.body,
      referenceContext: { ...contextOptions, marginPixels: 64 } }, 400);
    assert.equal((await api(`/api/jobs/${outside.j.id}/generation`, { taskId: outside.j.taskId, action: 'status' })).requests.length, 0);
    assert.equal((await api(`/api/jobs/${blank.j.id}/generation`, { taskId: blank.j.taskId, action: 'status' })).requests.length, 0);
  }
});

test('同路径源像素更新生成新裁片缓存，旧参考原件不覆盖；当前编辑优先且等比canvas映射已记录', async () => {
  const { j, body } = await contextFixture('layer', 2);
  const { assetPath, writeAsset } = store;
  const previous = assetPath(j.documentId, j.snapshot.source);
  const currentBytes = await sharp(previous).negate().png().toBuffer();
  j.snapshot.url = writeAsset(j.documentId, currentBytes, '.png'); j.snapshot.status = 'layered'; store.saveJob(j);
  const p = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: { ...contextOptions, marginPixels: 16 } });
  assert.equal(p.referenceContext.role, 'current');
  assert.deepEqual(p.referenceContext.frame, { x: 12, y: 22, width: 76, height: 56 });
  assert.deepEqual(p.referenceContext.carrierFrame, { x: 24, y: 44, width: 152, height: 112 });
  const native = await sharp(currentBytes).extract({ left: 12, top: 22, width: 76, height: 56 }).ensureAlpha().raw().toBuffer();
  assert.deepEqual(await sharp(fs.readFileSync(p.referenceContext.cropPath)).ensureAlpha().raw().toBuffer(), native);
  const old = fs.readFileSync(p.localPath), oldContext = fs.readFileSync(p.referenceContext.path);
  const changed = await sharp(currentBytes).modulate({ brightness: 0.5 }).png().toBuffer();
  fs.writeFileSync(p.referenceContext.sourcePath, changed);
  const next = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: { ...contextOptions, marginPixels: 16 } });
  assert.notEqual(p.localPath, next.localPath); assert.notEqual(p.referenceContext.cropPath, next.referenceContext.cropPath);
  assert.deepEqual(fs.readFileSync(p.localPath), old); assert.deepEqual(fs.readFileSync(p.referenceContext.path), oldContext);
  assert.notDeepEqual(await sharp(fs.readFileSync(next.localPath)).raw().toBuffer(), await sharp(fs.readFileSync(p.localPath)).raw().toBuffer());
});

test('周边参考只补整图外透明；当前源尺寸未知时不退回旧原图，也不保存请求', async () => {
  const { j, layer, body } = await contextFixture('layer');
  const frozen = { ...layer.frame!, x: 0, y: 0 }; layer.frame = frozen; store.saveJob(j);
  const p = await api(`/api/jobs/${j.id}/generation`, body);
  assert.deepEqual(p.carrier.frame, { x: -8, y: -8, width: 76, height: 56 });
  const raw = await sharp(fs.readFileSync(p.referenceContext.path)).ensureAlpha().raw().toBuffer();
  assert.equal(raw[3], 0); assert.equal(raw[(8 * 76 + 8) * 4 + 3], 255);
  const { writeAsset } = store;
  j.snapshot.url = writeAsset(j.documentId, fs.readFileSync(await png(80, 60)), '.png'); j.snapshot.status = 'layered'; store.saveJob(j);
  const rejected = await api(`/api/jobs/${j.id}/generation`, body, 400);
  assert.match(rejected.error, /不能退回旧原图/);
  const state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
  assert.equal(state.requests.length, 1); assert.equal(state.outputs.length, 0);
});

test('已有周边缓存遭改写不能被新请求背书为干净源，拒绝且保留文件；恢复后两路线成功', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, layer, body } = await contextFixture(route);
    const { reconstructionCrops } = await import('../server/reconstruction-crops.js');
    const source = store.assetPath(j.documentId, j.snapshot.source), sourceBytes = fs.readFileSync(source);
    const carrier = generationCarrier(layer.frame!, true, 3, 8);
    const refs = await reconstructionCrops(j, { version: 2, space: 'image-pixels',
      canvas: j.snapshot, layers: [{ layerId: layer.id, sourceLayerIds: [layer.id], name: layer.name,
        frame: carrier.frame, generation: carrier, annotations: [] }], instruction: '' }, source, source);
    const cache = refs[0].path!, clean = fs.readFileSync(cache);
    const poisoned = await sharp(clean).negate().png().toBuffer(); fs.writeFileSync(cache, poisoned);
    const failed = await api(`/api/jobs/${j.id}/generation`, body, 400);
    assert.match(failed.error, /缓存与当前源裁片不一致/);
    assert.deepEqual(fs.readFileSync(cache), poisoned); assert.deepEqual(fs.readFileSync(source), sourceBytes);
    const state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.equal(state.requests.length, 0); assert.equal(state.outputs.length, 0);
    fs.writeFileSync(cache, clean);
    const p = await api(`/api/jobs/${j.id}/generation`, body);
    assert.deepEqual(await sharp(fs.readFileSync(p.referencePaths[0])).ensureAlpha().raw().toBuffer(),
      await sharp(clean).ensureAlpha().raw().toBuffer());
  }
});

test('周边参考拒绝旧流程、背景与辅助请求，非法边距不创建请求', async () => {
  const legacy = await fixture();
  const body = { taskId: legacy.j.taskId, action: 'prepare', sourceLayerIds: [legacy.layer.id],
    purpose: '仅验证不支持路线不调用真实模型', elements: ['物体及边缘'], referenceObservation: '源参考的可见边缘',
    referenceContext: contextOptions };
  assert.match((await api(`/api/jobs/${legacy.j.id}/generation`, body, 400)).error, /v4普通透明前景/);
  assert.match((await api(`/api/jobs/${legacy.j.id}/generation`, { ...body, matteForGenerationId: 'missing' }, 500)).error, /周边参考/);
  {
    const { j, layer, body: valid } = await contextFixture('layer');
    layer.role = 'background'; store.saveJob(j);
    await api(`/api/jobs/${j.id}/generation`, valid, 400);
    for (const marginPixels of [0, 129, 1.5]) await api(`/api/jobs/${j.id}/generation`,
      { ...valid, referenceContext: { ...contextOptions, marginPixels } }, 400);
    const state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.equal(state.requests.length, 0); assert.equal(state.outputs.length, 0);
  }
});

async function contextLightFixture(route: 'layer' | 'photoshop', content = 'light') {
  const f = await contextFixture(route, 1, true, 'context'), { j, layer, anchors, frame } = f;
  if (route === 'layer') await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'layout',
    layout: { layers: [{ sourceLayerIds: [layer.id], elements: ['物体及边缘'], excludes: '实体灯和背景',
      blendMode: 'screen', content: 'light-effect', anchors }], relations: [] } });
  else await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan', plan: {
    canvas: j.snapshot, layers: [{ layerId: layer.id, name: layer.name, route: 'generate', content,
      surface: 'screen', frame, elements: ['物体及边缘'], includes: '独立光效', excludes: '实体灯和背景',
      rationale: '真实周边源测试', compositing: '纯黑中性底screen，不纳入实体灯', editable: 'pixels', anchors }], relations: [] } });
  return f;
}

test('单周边新请求只有完整构图参考，旧请求不变；只读局部不能原样或重编码冒充生成', async () => {
  for (const route of ['layer', 'photoshop'] as const) for (const screen of [false, true]) {
    const { j, body, frame, anchors } = screen ? await contextLightFixture(route) : await contextFixture(route);
    const old = await api(`/api/jobs/${j.id}/generation`, body), oldBytes = fs.readFileSync(old.referencePaths[0]);
    const oldRecord = (await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' })).requests.find((q: any) => q.id === old.id);
    const p = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: singleContext,
      promptStyle: route === 'layer' ? 'structured' : 'concise-edit' });
    assert.deepEqual(p.referencePaths, [p.referenceContext.path]); assert.deepEqual(p.frame, frame); assert.deepEqual(p.anchors, anchors);
    assert(p.localPath && !p.referencePaths.includes(p.localPath));
    assert.equal(p.localReferenceHash, crypto.createHash('sha256').update(fs.readFileSync(p.localPath)).digest('hex'));
    assert.doesNotMatch(p.prompt, /第二张|其余参考/); assert(p.carrier.size.width * p.carrier.size.height <= 1500000);
    const state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.deepEqual(state.requests.find((q: any) => q.id === old.id), oldRecord);
    assert.deepEqual(fs.readFileSync(old.referencePaths[0]), oldBytes);
    const alias = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
    fs.writeFileSync(alias, await sharp(fs.readFileSync(p.localPath)).png({ compressionLevel: 0 }).toBuffer());
    for (const fake of [p.localPath, alias]) {
      const rejected = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'register', requestId: p.id,
        path: fake, prompt: p.prompt, referencePaths: p.referencePaths }, 400);
      assert.match(rejected.error, /参考|引用/);
    }
    const file = await png(p.carrier.frame.width, p.carrier.frame.height, !screen), r = await register(j, p, file);
    const local = fs.readFileSync(p.localPath);
    fs.writeFileSync(p.localPath, await sharp(local).negate().png().toBuffer());
    const rejected = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'auto-align', generationId: r.id }, 500);
    assert.match(rejected.error, /参考.*改变|参考.*变更/); fs.writeFileSync(p.localPath, local);
  }
});

test('单周边必须显式local-only，拒绝相互冲突的全图、细节引用和未知模式', async () => {
  const { j, body } = await contextFixture('layer');
  for (const override of [{ referenceStrategy: undefined }, { referenceStrategy: 'local-and-global' },
    { detailReferences: [{ name: '局部', box: [25, 35, 20, 10], observation: '真实局部纹理供细节对照但会破坏唯一构图条件' }] },
    { referenceContext: { ...singleContext, referenceMode: 'unknown' } }]) {
    await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: singleContext, ...override }, 400);
  }
  assert.equal((await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' })).requests.length, 0);
});

test('单周边精简编辑分清整图观察与文件定位，用户意见和标注不丢，旧请求不追改', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, layer, body } = await contextFixture(route);
    const old = await api(`/api/jobs/${j.id}/generation`, { ...body, promptStyle: 'concise-edit' });
    const oldRecord = (await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' })).requests.find((q: any) => q.id === old.id);
    j.snapshot.opinion = '总图只修指定部分，保持用户已经确认的冷色';
    j.snapshot.layers.find((l: any) => l.id === layer.id)!.opinion = '本层保留旧字形细亮边，不添加浮雕';
    j.snapshot.annotations.push({ id: 'frozen-note', layerId: layer.id, type: 'arrow', points: [10, 10, 25, 35],
      text: '只修这个角，不重排其余字', color: '#ff0000' }); store.saveJob(j);
    const purpose = '仅移除冻结排除对象；源已有轮廓和金属纹理保持原样';
    const referenceObservation = '原始整图观察交点[25,35]，这是源特征，不是当前局部文件的位置';
    const p = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: singleContext,
      promptStyle: 'concise-edit', purpose, referenceObservation });
    for (const text of [purpose, referenceObservation, j.snapshot.opinion, j.snapshot.layers[0].opinion,
      '只修这个角，不重排其余字', '背景和其他层']) assert(p.prompt.includes(text));
    assert.match(p.prompt, /整图坐标.*不能.*参考文件坐标/);
    assert(p.prompt.includes('"positionPercent":[17.11,23.21]'));
    assert(p.prompt.includes('"target":[13,13]')); assert.match(p.prompt, /不绘制标记/);
    assert.doesNotMatch(p.prompt, /插件负责|不是自动精确定位保证|第二张|其余参考/);
    assert.match(p.prompt, /1500000/); assert.deepEqual(p.referencePaths, [p.referenceContext.path]);
    const saved = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.deepEqual(saved.requests.find((q: any) => q.id === old.id), oldRecord);
    assert.deepEqual(store.getJob(j.id).snapshot.annotations, j.snapshot.annotations);
  }
});

test('v4两路线未声明数值alpha区域也区分薄透自身外观和后层，不改源/几何/旧请求', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, body, frame, anchors } = await contextFixture(route);
    const sourcePath = store.assetPath(j.documentId, j.snapshot.source);
    const sourceBytes = fs.readFileSync(sourcePath), snapshot = JSON.stringify(store.getJob(j.id).snapshot);
    const old = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: undefined });
    const oldRecord = (await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' }))
      .requests.find((q: any) => q.id === old.id);
    for (const promptStyle of ['structured', 'concise-edit'] as const) {
      const p = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: undefined, promptStyle });
      assert.match(p.prompt, /后层的结构及颜色不属于本层RGB/);
      assert.match(p.prompt, /若本层含薄透材质/);
      assert.match(p.prompt, /输出透明只要求物体之外的区域透明，不意味着本层实体是薄透材料/);
      assert.match(p.prompt, /不得借此保留明确排除的透光附件/);
      assert.doesNotMatch(p.prompt, /保持本层实框、铰链/);
      assert.match(p.prompt, /后层分离只改变材质归属/);
      assert.match(p.prompt, /必要遮挡补全不得改画已可见边界/);
      assert.match(p.prompt, /未受分离影响的实体覆盖率/);
      assert.doesNotMatch(p.prompt, /严格保持对象.*颜色、纹理与光照/);
      assert.doesNotMatch(p.prompt, /冻结区域隔离约束/);
      assert.deepEqual(p.alphaChecks || [], []); assert.equal(p.allowAuxMatte, undefined);
      assert.deepEqual(p.frame, frame); assert.deepEqual(p.anchors, anchors);
      assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes);
      assert.equal(JSON.stringify(store.getJob(j.id).snapshot), snapshot);
      const live = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
      assert.deepEqual(live.requests.find((q: any) => q.id === old.id), oldRecord);
    }
  }
});

test('单周边精简编辑不能省略薄透RGB分离或冻结alpha区域约束', async () => {
  const { j, layer, body, anchors } = await contextFixture('layer');
  await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'layout', layout: {
    layers: [{ sourceLayerIds: [layer.id], elements: ['物体及边缘'], excludes: '可辨认后景线条', anchors,
      alphaChecks: [{ name: '薄透窗口', kind: 'transmissive', box: [25, 35, 8, 8], minAlpha: 24,
        maxAlpha: 224, minBackgroundResponse: 31, minPassingFraction: 1 }] }], relations: [] } });
  const p = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: singleContext, promptStyle: 'concise-edit' });
  assert.match(p.prompt, /后层.*不属于本层RGB|后层的结构及颜色不属于本层RGB/);
  assert.match(p.prompt, /不能只降低整层opacity/); assert.match(p.prompt, /冻结区域隔离约束/);
  assert(p.prompt.includes('"box":[13,13,8,8]')); assert(p.prompt.includes('"maxAlpha":224'));
});

test('复合薄透组两路区分同组实体和悬空薄透窗，保留冻结参考及区域', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, layer, body, anchors, frame } = await contextFixture(route);
    const elements = ['不透明人物和衣身', '透明面罩及自身印字'];
    const alphaChecks = [{ name: '悬空薄透窗', kind: 'transmissive', box: [25, 35, 8, 8],
      minAlpha: 24, maxAlpha: 224, minBackgroundResponse: 31, minPassingFraction: 1 }];
    if (route === 'layer') await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'layout',
      layout: { layers: [{ sourceLayerIds: [layer.id], elements, excludes: '森林和外围光效', anchors, alphaChecks }], relations: [] } });
    else await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan',
      plan: { canvas: j.snapshot, layers: [{ layerId: layer.id, name: layer.name, route: 'generate',
        content: 'bitmap', surface: 'transparent', frame, elements, includes: elements.join('；'),
        excludes: '森林和外围光效', rationale: '复合归属检查', compositing: 'normal', editable: 'pixels', anchors, alphaChecks }], relations: [] } });
    const input = { ...body, elements, referenceContext: undefined };
    const first = await api(`/api/jobs/${j.id}/generation`, input), firstBytes = fs.readFileSync(first.localPath);
    const stored = (await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' })).requests.find((q: any) => q.id === first.id);
    for (const promptStyle of ['structured', 'concise-edit']) {
      const p = await api(`/api/jobs/${j.id}/generation`, { ...input, promptStyle });
      assert.match(p.prompt, /同组元素清单内的可见实体RGB仍归本组/);
      assert.match(p.prompt, /没有同组实体承接的薄透窗口须以局部alpha透见组外后景/);
      assert.match(p.prompt, /不能因本组含不透明实体就使该窗口继承近不透明alpha/);
      assert.match(p.prompt, /不扩大元素清单或保留明确排除的附件/);
      assert.deepEqual(p.elements, elements); assert.deepEqual(p.alphaChecks, alphaChecks);
      assert.deepEqual(p.frame, frame); assert.deepEqual(p.anchors, anchors);
      assert.deepEqual(fs.readFileSync(p.localPath), firstBytes);
      assert.equal(p.referenceHashes[0], first.referenceHashes[0]);
      assert(p.generation.size.width * p.generation.size.height <= 1_500_000);
    }
    const live = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.deepEqual(live.requests.find((q: any) => q.id === first.id), stored);
    assert.equal(live.outputs.length, 0);
  }
});

test('复合薄透说明不扩散到旧v3实体或独立screen光效', async () => {
  const { j, layer } = await fixture();
  const legacy = await prepare(j, layer.id);
  assert(!legacy.prompt.includes('同组元素清单内的可见实体RGB'));
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, body } = await contextLightFixture(route);
    const p = await api(`/api/jobs/${j.id}/generation`, body);
    assert.equal(p.surface, 'screen'); assert.equal(p.transparent_background, false);
    assert(!p.prompt.includes('同组元素清单内的可见实体RGB'));
    assert(!p.prompt.includes('没有同组实体承接的薄透窗口'));
  }
});

test('两路重复元素审查返回400，保留原件与已有审查，修改输入即可续审', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, layer, body, anchors, frame } = await contextFixture(route);
    const elements = ['上部可见轮廓', '下部实体边缘'];
    if (route === 'layer') await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'layout',
      layout: { layers: [{ sourceLayerIds: [layer.id], elements, excludes: '背景及其他物体', anchors }], relations: [] } });
    else await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan',
      plan: { canvas: j.snapshot, layers: [{ layerId: layer.id, name: layer.name, route: 'generate',
        content: 'bitmap', surface: 'transparent', frame, elements, includes: elements.join('；'),
        excludes: '背景及其他物体', rationale: '真实本地审查接口夹具', compositing: 'normal', editable: 'pixels', anchors }], relations: [] } });
    const p = await api(`/api/jobs/${j.id}/generation`, { ...body, elements, referenceContext: undefined });
    const r = await register(j, p, await png(frame.width as number, frame.height as number, true));
    const input = { taskId: j.taskId, action: 'review', generationId: r.id, comparisonHash: r.comparisonHash,
      review: { status: 'needs-revision', attempts: [{ method: '原位文件对照', observation: '轮廓仍需调整，保留真实候选' }],
        issues: [{ message: '上边界需要按源形状调整' }] },
      elements: [{ name: elements[0], status: 'different', observation: '上轮廓实际偏窄，仍需源位纠正' },
        { name: elements[1], status: 'matched', observation: '下边界与框底接触，完整边缘已保留' }],
      evidence: { geometry: '上部边界偏窄，位置尚待纠正', appearance: '下部边缘实际绿色纹理保持',
        isolation: '对象之外真透明，深浅底无矩形底块', candidateIds: [r.id] } };
    await api(`/api/jobs/${j.id}/generation`, input);
    const before = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    const originals = [r.originalPath, r.workingPath, r.comparisonPath, p.localPath]
      .map(file => ({ file, bytes: fs.readFileSync(file) }));
    const bad = await api(`/api/jobs/${j.id}/generation`, { ...input,
      elements: input.elements.map(e => ({ ...e, observation: '上轮廓实际偏窄，仍需源位纠正' })) }, 400);
    assert.match(bad.error, /元素检查存在重复模板/);
    assert.deepEqual(await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' }), before);
    for (const { file, bytes } of originals) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(store.getJob(j.id).status, 'running');
    const corrected = await api(`/api/jobs/${j.id}/generation`, { ...input,
      elements: input.elements.map((e, i) => i ? e : { ...e, observation: '上轮廓向内缩窄，源位外沿还需恢复' }) });
    assert.equal(corrected.id, r.id); assert.equal(corrected.review.status, 'needs-revision');
    const after = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.equal(after.requests.length, 1); assert.equal(after.outputs.length, 1);
  }
});

test('单周边登记异步期间只读局部被改写，拒绝旧登记且保留生成原件', async () => {
  const { j, body } = await contextFixture('layer');
  const p = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: singleContext });
  const output = await png(76, 56, true), original = fs.readFileSync(output), local = fs.readFileSync(p.localPath);
  const metadata = sharp.prototype.metadata;
  let enteredResolve!: () => void, releaseResolve!: () => void, held = false;
  const entered = new Promise<void>(r => { enteredResolve = r; }), release = new Promise<void>(r => { releaseResolve = r; });
  sharp.prototype.metadata = async function(this: any, ...args: any[]) {
    const m = await (metadata as any).apply(this, args);
    if (!held) { held = true; enteredResolve(); await release; } return m;
  } as typeof metadata;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'register', requestId: p.id,
      path: output, prompt: p.prompt, referencePaths: p.referencePaths }, 500);
    await Promise.race([entered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('registration did not enter')), 3000); })]);
    // Encode before the hook was installed, so the out-of-band writer does not wait on it.
    fs.writeFileSync(p.localPath, Buffer.concat([local, Buffer.from('changed-local')]));
    releaseResolve(); const rejected = await pending; assert.match(rejected.error, /参考.*变化/);
    assert.equal((await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' })).outputs.length, 0);
    assert.deepEqual(fs.readFileSync(output), original);
  } finally { sharp.prototype.metadata = metadata; releaseResolve(); if (timer) clearTimeout(timer); fs.writeFileSync(p.localPath, local); }
});

test('两路线独立screen周边保留框外真实弱RGB，画外仅黑底、原件和全carrier定位不截尾', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, body, anchors, frame } = await contextLightFixture(route);
    const sourcePath = store.assetPath(j.documentId, j.snapshot.source);
    const source = await sharp(fs.readFileSync(sourcePath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    source.data.set([0, 1, 2, 255], (25 * source.info.width + 15) * 4);
    fs.writeFileSync(sourcePath, await sharp(source.data, { raw: source.info }).png().toBuffer());
    const sourceBefore = fs.readFileSync(sourcePath), oldDefault = await api(`/api/jobs/${j.id}/generation`,
      { ...body, referenceContext: undefined, anchors: [] }, 500);
    assert.match(oldDefault.error, /最终图层框内/);
    const p = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: { ...contextOptions, marginPixels: 64 } });
    assert.equal(p.surface, 'screen'); assert.equal(p.blendMode, 'screen'); assert.deepEqual(p.frame, frame);
    assert.deepEqual(p.anchors, anchors); assert(p.carrier.size.width * p.carrier.size.height <= 1500000);
    assert.match(p.prompt, /纯黑中性区/); assert.doesNotMatch(p.prompt, /整图之外仍透明|整图之外的透明区/);
    const cf = p.carrier.frame, context = await sharp(fs.readFileSync(p.referencePaths[0])).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const expected = await sharp(fs.readFileSync(p.referenceContext.cropPath)).flatten({ background: '#000000' }).ensureAlpha().raw().toBuffer();
    assert.deepEqual(context.data, expected); assert.deepEqual([...context.data.subarray(0, 4)], [0, 0, 0, 255]);
    const k = ((25 - cf.y) * context.info.width + 15 - cf.x) * 4;
    assert.deepEqual([...context.data.subarray(k, k + 4)], [0, 1, 2, 255]);
    const rejected = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'register', requestId: p.id,
      path: p.referencePaths[0], prompt: p.prompt, referencePaths: p.referencePaths }, 400);
    assert.match(rejected.error, /参考|引用/);
    const pixels = Buffer.alloc(context.info.width * context.info.height * 4); for (let n = 3; n < pixels.length; n += 4) pixels[n] = 255;
    pixels.set([0, 1, 2, 255], k); pixels.set([0, 160, 220, 255], ((75 - cf.y) * context.info.width + 85 - cf.x) * 4);
    const file = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
    fs.writeFileSync(file, await sharp(pixels, { raw: { width: context.info.width, height: context.info.height, channels: 4 } }).png().toBuffer());
    const r = await register(j, p, file), original = fs.readFileSync(r.originalPath);
    const aligned = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'align', generationId: r.id,
      anchorNames: anchors.map(a => a.name), points: anchors.map(a => ({ source: [a.point[0] - cf.x, a.point[1] - cf.y], target: [a.point[0] - frame.x, a.point[1] - frame.y] })),
      observation: '合成夹具既有源点，完整周边正比例和平移，不裁弱RGB尾迹' });
    assert.deepEqual(aligned.placementFrame, cf); assert.deepEqual(aligned.comparisonFrame, cf);
    assert.deepEqual(fs.readFileSync(r.originalPath), original); assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
    const work = await sharp(fs.readFileSync(aligned.workingPath)).ensureAlpha().raw().toBuffer();
    assert.deepEqual([...work.subarray(k, k + 4)], [0, 1, 2, 255]);
    assert(aligned.workingSize.width * aligned.workingSize.height <= 1500000);
  }
});

test('PS周边screen必须声明独立light，不能把bitmap或text换成黑底绕过隔离', async () => {
  for (const content of ['bitmap', 'text']) {
    const { j, layer, frame } = await contextFixture('photoshop');
    const rejected = await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan', plan: {
      canvas: j.snapshot, layers: [{ layerId: layer.id, name: layer.name, route: 'generate', content,
        surface: 'screen', frame, elements: ['物体及边缘'], includes: '普通物体或字', excludes: '背景',
        rationale: '非法screen归属测试', compositing: 'screen', editable: 'pixels' }], relations: [] } }, 500);
    assert.match(rejected.error, /screen黑底只允许独立光效/);
    assert.equal((await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' })).requests.length, 0);
  }
});

test('周边准备异步期间源、PS计划或登记状态变更，拒绝旧请求且不回滚新内容', async () => {
  for (const change of ['source', 'ps-plan', 'request-state'] as const) {
    const { j, body } = await contextFixture(change === 'ps-plan' ? 'photoshop' : 'layer');
    const metadata = sharp.prototype.metadata;
    let enteredResolve!: () => void, releaseResolve!: () => void, held = false;
    const entered = new Promise<void>(r => { enteredResolve = r; });
    const release = new Promise<void>(r => { releaseResolve = r; });
    sharp.prototype.metadata = async function(this: any, ...args: any[]) {
      const meta = await (metadata as any).apply(this, args);
      if (!held && meta.width === 160 && meta.height === 120) { held = true; enteredResolve(); await release; }
      return meta;
    } as typeof metadata;
    let timer: ReturnType<typeof setTimeout> | undefined, changedBytes: Buffer | undefined;
    try {
      const pending = api(`/api/jobs/${j.id}/generation`, body, change === 'request-state' ? 400 : 409);
      await Promise.race([entered, new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(Error('未进入周边参考源采样')), 3000);
      })]);
      if (change === 'source') {
        const source = store.assetPath(j.documentId, j.snapshot.source);
        changedBytes = await sharp(fs.readFileSync(source)).negate().png().toBuffer();
        fs.writeFileSync(source, changedBytes);
      } else if (change === 'ps-plan') {
        const { photoshopState } = await import('../server/photoshop-rebuild.js');
        const plan = photoshopState(j).plan!;
        await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan',
          plan: { ...plan, layers: plan.layers.map(l => ({ ...l, excludes: '并发更新后的排除项' })) } });
      } else {
        // Generation actions serialize a job. Simulate an out-of-band writer
        // in this isolated fixture to test CAS; no second queued action awaits it.
        const { generationState } = await import('../server/generation.js');
        const current = generationState(j);
        current.layout!.layers[0].excludes = '并发状态写入后的排除项';
        store.atomic(path.join(store.dir(j.documentId), 'jobs', j.id, 'generation', 'registry.json'), current);
      }
      releaseResolve();
      const rejected = await pending;
      assert.match(rejected.error, change === 'source' ? /干净源.*已变化/ :
        change === 'ps-plan' ? /PS完整计划已变化/ : /变化|改变/);
      const state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
      assert.equal(state.requests.length, 0); assert.equal(state.outputs.length, 0);
      if (change === 'request-state') assert.equal(state.layout.layers[0].excludes, '并发状态写入后的排除项');
      if (changedBytes) assert.deepEqual(fs.readFileSync(store.assetPath(j.documentId, j.snapshot.source)), changedBytes);
      if (change === 'ps-plan') {
        const { photoshopState } = await import('../server/photoshop-rebuild.js');
        assert.equal(photoshopState(j).plan!.layers[0].excludes, '并发更新后的排除项');
      }
    } finally { sharp.prototype.metadata = metadata; releaseResolve(); if (timer) clearTimeout(timer); }
  }
});

test('prepare把干净细节追加至有序工具引用，冻结实际裁片；两路线都拒绝篡改细节登记', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, layer } = await fixture(route);
    if (route === 'photoshop') await api(`/api/jobs/${j.id}/ps-rebuild`, {
      taskId: j.taskId, action: 'plan', plan: { canvas: { width: j.snapshot.width, height: j.snapshot.height },
        layers: [{ layerId: layer.id, name: layer.name, route: 'generate', content: 'bitmap', surface: 'transparent',
          frame: layer.frame, elements: ['物体及边缘'], excludes: '其他物体', rationale: '测试生成参考绑定',
          includes: '物体及边缘', compositing: 'normal', editable: 'pixels' }], relations: [] },
    });
    const body = { taskId: j.taskId, action: 'prepare', sourceLayerIds: [layer.id],
      purpose: '保持既有物体与边缘，排除背景', elements: ['物体及边缘'],
      referenceObservation: '源局部中有位置固定的纹理边缘', referenceStrategy: 'local-only',
      detailReferences: [{ name: '细边', box: [25, 35, 20, 10], observation: '细边与邻接纹理交界保持原来的相对位置' }] };
    const p = await api(`/api/jobs/${j.id}/generation`, body);
    assert.equal(p.referencePaths[0], p.localPath);
    assert.equal(p.referencePaths.length, 2);
    const detail = p.detailReferences[0];
    assert.equal(p.referencePaths[1], detail.path);
    assert.deepEqual(await sharp(fs.readFileSync(detail.path)).ensureAlpha().raw().toBuffer(),
      await sharp(fs.readFileSync(p.localPath)).extract(detail.crop).ensureAlpha().raw().toBuffer());
    assert.match(p.prompt, /第2张参考「细边」/);
    assert.match(p.prompt, /输出仍按第一张完整文件边界/);
    const original = fs.readFileSync(detail.path), toolFile = await png(600, 400, true);
    fs.writeFileSync(detail.path, await sharp(original).negate().png().toBuffer());
    const rejected = await api(`/api/jobs/${j.id}/generation`, {
      taskId: j.taskId, action: 'register', requestId: p.id, path: toolFile,
      referencePaths: p.referencePaths, prompt: p.prompt,
    }, 500);
    assert.match(rejected.error, /参考.*变更/);
    const state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.equal(state.outputs.length, 0);
    fs.writeFileSync(detail.path, original);
    const encodedAlias = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
    fs.writeFileSync(encodedAlias, await sharp(original).png({ compressionLevel: 0 }).toBuffer());
    for (const fake of [detail.path, encodedAlias]) {
      const aliasRejected = await api(`/api/jobs/${j.id}/generation`, {
        taskId: j.taskId, action: 'register', requestId: p.id, path: fake,
        referencePaths: p.referencePaths, prompt: p.prompt,
      }, 400);
      assert.match(aliasRejected.error, /细节参考.*image_gen产物/);
    }
    if (route === 'layer') {
      await api(`/api/jobs/${j.id}/generation`, { ...body, matteForGenerationId: 'no-authority' }, 500);
    }
    await api(`/api/jobs/${j.id}/generation`, { ...body, detailReferences: [
      { ...body.detailReferences[0], box: [0, 0, 5, 5] },
    ] }, 400);
    const after = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.equal(after.requests.length, 1);
    assert.equal(after.outputs.length, 0);
  }
});

test('PS准备细节的异步采样期间更新合法计划，拒绝旧请求且保留更新计划', async () => {
  const { j, layer } = await fixture('photoshop');
  const plan = { canvas: { width: j.snapshot.width, height: j.snapshot.height }, layers: [{
    layerId: layer.id, name: layer.name, route: 'generate', content: 'bitmap', surface: 'transparent',
    frame: layer.frame, elements: ['物体及边缘'], excludes: '旧排除项', rationale: '并发计划测试',
    includes: '物体及边缘', compositing: 'normal', editable: 'pixels',
  }], relations: [] };
  await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan', plan });
  const original = sharp.prototype.metadata;
  let enteredResolve!: () => void, releaseResolve!: () => void, held = false;
  const entered = new Promise<void>(r => { enteredResolve = r; });
  const release = new Promise<void>(r => { releaseResolve = r; });
  sharp.prototype.metadata = async function(this: any, ...args: any[]) {
    const meta = await (original as any).apply(this, args);
    if (!held && meta.width === 60 && meta.height === 40) { held = true; enteredResolve(); await release; }
    return meta;
  } as typeof original;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'prepare',
      sourceLayerIds: [layer.id], elements: ['物体及边缘'], referenceStrategy: 'local-only',
      purpose: '并发原图细节参考测试，不运行模型', referenceObservation: '本夹具实际干净局部的边界',
      detailReferences: [{ name: '边界', box: [25, 35, 20, 10], observation: '保持夹具边界纹理与邻接区域的实际相对位置' }],
    }, 409);
    await Promise.race([entered, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(Error('未进入预期细节采样')), 3000);
    })]);
    const changed = { ...plan, layers: plan.layers.map(l => ({ ...l, excludes: '已授权更新的排除项' })) };
    await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan', plan: changed });
    releaseResolve();
    assert.match((await pending).error, /PS完整计划已变化/);
    const state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.equal(state.requests.length, 0); assert.equal(state.outputs.length, 0);
    const { photoshopState } = await import('../server/photoshop-rebuild.js');
    assert.equal(photoshopState(j).plan!.layers[0].excludes, '已授权更新的排除项');
  } finally { sharp.prototype.metadata = original; releaseResolve(); if (timer) clearTimeout(timer); }
});

test('150万预算固定，包括透明像素；旧设置不能重新扩大预算', async () => {
  for (const n of [undefined, 1550000, 1700000, 3000000]) {
    assert.equal(
      photoshopSettingsSchema.parse({ generationPixelBudget: n }).generationPixelBudget,
      1500000,
    );
    const p = generationPlan({ x: -30, y: 80, width: 1242, height: 2688 }, n);
    assert.equal(p.pixelBudget, 1500000);
    assert(p.size.width * p.size.height <= 1500000);
  }
  const raw = fs.readFileSync(await png(1024, 1536, true)),
    copy = Buffer.from(raw);
  const normalized = await budgetWorkingCopy(raw);
  assert(normalized.workingSize.width * normalized.workingSize.height <= 1500000);
  assert.deepEqual(normalized.originalSize, { width: 1024, height: 1536 });
  assert.deepEqual(raw, copy);
});

test('极端狭长原件不能突破150万工作预算，拒绝时不改变输入字节', async () => {
  for (const size of [
    { width: 1, height: 2_000_000 },
    { width: 2_000_000, height: 1 },
  ]) {
    assert.throws(() => generationPlan({ x: 0, y: 0, ...size }), /比例过于狭长/);
    const raw = await sharp({ create: { ...size, channels: 3, background: '#aabbcc' } })
      .png()
      .toBuffer();
    const sourceHash = crypto.createHash('sha256').update(raw).digest('hex');
    await assert.rejects(budgetWorkingCopy(raw), /比例过于狭长/);
    assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), sourceHash);
  }
  const validThin = generationPlan({ x: 0, y: 0, width: 51, height: 30000 });
  assert(validThin.size.width * validThin.size.height <= 1_500_000);
});

test('v3局部参考、原件登记、逐元素检查和完成回传；私自适配和SVG替换被拒绝', async () => {
  const { d, j, layer } = await fixture(),
    p = await prepare(j, layer.id);
  assert(p.localPath);
  assert.equal(p.referencePaths[0], p.localPath);
  assert.deepEqual(p.frame, layer.frame);
  assert.match(p.prompt, /1500000/);
  const file = await png(600, 400, true),
    r = await register(j, p, file);
  const payload = {
    taskId: j.taskId,
    baseVersion: j.version,
    layers: [
      { id: layer.id, name: layer.name, ...layer.frame, path: r.originalPath, generationId: r.id },
    ],
  };
  await api(`/api/jobs/${j.id}/apply`, payload, 400); // Review is mandatory.
  const altered = await png(60, 40, true);
  await api(
    `/api/jobs/${j.id}/apply`,
    { ...payload, stageOnly: true, layers: [{ ...payload.layers[0], path: altered }] },
    500,
  );
  const svg = path.join(path.dirname(file), 'substitute.svg');
  fs.writeFileSync(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="50" height="30"/></svg>',
  );
  await api(
    `/api/jobs/${j.id}/apply`,
    { ...payload, layers: [{ ...payload.layers[0], path: svg, kind: 'vector' }] },
    500,
  );
  await api(`/api/jobs/${j.id}/generation`, {
    taskId: j.taskId,
    action: 'review',
    generationId: r.id,
    comparisonHash: r.comparisonHash,
    review: review('accepted'),
    elements: [{ name: '物体及边缘', status: 'matched', observation: '检查实际尺寸与原图位置' }],
  });
  const done = await api(`/api/jobs/${j.id}/apply`, payload);
  assert.equal(done.document.images.length, 2);
  assert.deepEqual(done.document.images[0], d.images[0]);
  const output = done.document.images[1].layers[0];
  assert.equal(output.kind, 'raster');
  assert.equal(output.disposition, 'keep');
  assert.deepEqual(output.frame, layer.frame);
  assert.equal(output.generationId, r.id);
  assert.deepEqual(
    fs.readFileSync(store.assetPath(d.id, output.generationSourceUrl)),
    fs.readFileSync(file),
  );
});

test('大比例误差不能模板验收，真实纠正后可标红完成，且图层坐标与原节点不变', async () => {
  const { j, layer } = await fixture(),
    p = await prepare(j, layer.id),
    r = await register(j, p, await png(100, 100, true));
  assert(r.aspectError > 0.01);
  const input = {
    taskId: j.taskId,
    action: 'review',
    generationId: r.id,
    comparisonHash: r.comparisonHash,
    elements: [{ name: '物体及边缘', status: 'different', observation: '主体占比偏差' }],
  };
  await api(`/api/jobs/${j.id}/generation`, { ...input, review: review('accepted') }, 500);
  await api(`/api/jobs/${j.id}/generation`, { ...input, review: review('needs-revision') });
  const done = await api(`/api/jobs/${j.id}/apply`, {
    taskId: j.taskId,
    baseVersion: j.version,
    layers: [
      {
        id: layer.id,
        name: layer.name,
        ...layer.frame,
        path: r.originalPath,
        generationId: r.id,
        review: review('accepted'),
      },
    ],
  });
  const result = done.document.images.at(-1);
  assert.equal(result.layers[0].review.status, 'needs-revision');
  assert.equal(result.layers[0].disposition, 'rebuild');
  assert(result.annotations.some((a: any) => a.color === '#ef4444' || a.color === '#ff3b30'));
  assert.deepEqual(result.layers[0].frame, layer.frame);
});

test('PS文字验收检测无倾斜、无斜切、颜色错误和缺少效果，不能以矩形大小通过', () => {
  const plan = photoshopPlanSchema.parse({
    layers: [
      {
        layerId: 'text',
        name: '文字',
        frame: { x: 0, y: 0, width: 300, height: 100 },
        route: 'native',
        content: 'text',
        surface: 'transparent',
        rationale: '参考',
        includes: '文字',
        excludes: '背景',
        compositing: 'normal',
        editable: 'native-text',
        elements: ['Test'],
        textTargets: [
          {
            layerName: 'Title',
            text: 'Test',
            box: { x: 0, y: 0, width: 300, height: 100 },
            appearance: {
              rotation: -12,
              requiresShear: true,
              color: [255, 0, 0],
              requiredEffects: ['stroke'],
              observation: '原字红色，斜切旋转并描边',
            },
          },
        ],
      },
    ],
  });
  const report = nativeTextReport(
    {
      width: 300,
      height: 100,
      children: [
        {
          name: 'LC_text',
          children: [
            {
              name: 'Title',
              left: 0,
              top: 0,
              right: 300,
              bottom: 100,
              text: {
                text: 'Test',
                transform: [1, 0, 0, 1, 0, 0],
                style: { fillColor: { r: 0, g: 0, b: 0 } },
              },
            },
          ],
        },
      ],
    },
    plan,
  ).text[0];
  assert.equal(report.severeGeometry, false);
  assert.equal(report.appearanceMismatch.length, 4);
});

test('定位点只允许统一缩放和平移；越框弱alpha保留为扩展像素边界', async () => {
  const pairs = [
    { source: [25, 25], target: [30, 35] },
    { source: [50, 25], target: [55, 35] },
    { source: [25, 50], target: [30, 60] },
  ] as { source: [number, number]; target: [number, number] }[];
  assert.deepEqual(landmarkTransform(pairs, { width: 100, height: 100 }), {
    scale: 1,
    x: 5,
    y: 10,
    residual: 0,
  });
  const bytes = Buffer.alloc(100 * 100 * 4);
  bytes.set([255, 0, 0, 255], (35 * 100 + 30) * 4);
  const png = await sharp(bytes, { raw: { width: 100, height: 100, channels: 4 } })
    .png()
    .toBuffer();
  const aligned = await alignGeneration(png, { x: 200, y: 300, width: 100, height: 100 }, pairs);
  const raw = await sharp(aligned.bytes).ensureAlpha().raw().toBuffer();
  assert.equal(raw[(35 * 100 + 30) * 4 + 3], 255);
  assert.deepEqual(aligned.placementFrame, { x: 205, y: 310, width: 100, height: 100 });
  assert.throws(
    () =>
      landmarkTransform(
        [
          { source: [0, 0], target: [0, 0] },
          { source: [80, 0], target: [96, 0] },
          { source: [0, 80], target: [0, 64] },
        ],
        { width: 100, height: 100 },
      ),
    /统一缩放/,
  );
  bytes.set([255, 0, 0, 1], (95 * 100 + 95) * 4);
  const weak = await sharp(bytes, { raw: { width: 100, height: 100, channels: 4 } })
    .png()
    .toBuffer();
  const preserved = await alignGeneration(weak, { x: 0, y: 0, width: 100, height: 100 }, pairs);
  const weakRaw = await sharp(preserved.bytes).ensureAlpha().raw().toBuffer();
  assert.equal(weakRaw[(95 * 100 + 95) * 4 + 3], 1);
});

test('新PS任务必须提交元素清单和登记原件；修改该层制作路线后旧登记失效', async () => {
  const { j, layer } = await fixture('photoshop');
  const { photoshopAction, beginPhotoshopMaterial, processPhotoshopMaterial } =
    await import('../server/photoshop-rebuild.js');
  const { AdobeConnector } = await import('../server/adobe.js');
  const adobe = new AdobeConnector(process.cwd(), process.env.LAYER_CANVAS_DATA!);
  try {
    const plan = {
      layers: [
        {
          layerId: layer.id,
          name: layer.name,
          frame: layer.frame,
          route: 'generate',
          content: 'bitmap',
          surface: 'transparent',
          rationale: '透明物体',
          includes: '物体',
          excludes: '背景',
          compositing: 'normal',
          editable: 'pixels',
          elements: ['物体及边缘'],
        },
      ],
    };
    await assert.rejects(
      () =>
        photoshopAction(
          j,
          { action: 'plan', plan: { layers: plan.layers.map((l) => ({ ...l, elements: [] })) } },
          adobe,
        ),
      /元素清单/,
    );
    const packet: any = await photoshopAction(j, { action: 'plan', plan }, adobe);
    assert.equal(packet.protocolVersion, 3);
    assert.match(packet.instructions, /place-material/);
    const p = await prepare(j, layer.id),
      file = await png(600, 400, true),
      r = await register(j, p, file);
    const material: any = {
      action: 'material',
      layerId: layer.id,
      path: r.originalPath,
      provenance: 'generated',
      observation: '测试真实alpha',
      allowAspectFit: false,
      evidence: {
        generation: {
          tool: 'image_gen',
          outputPath: r.originalPath,
          prompt: p.prompt,
          referencePaths: p.referencePaths,
        },
      },
    };
    await assert.rejects(() => beginPhotoshopMaterial(j, material), /登记/);
    await beginPhotoshopMaterial(j, { ...material, generationId: r.id });
    await processPhotoshopMaterial(j, layer.id, new AbortController().signal);
    const stateFile = path.join(store.dir(j.documentId), 'jobs', j.id, 'photoshop-rebuild.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const workingPath = state.materials[layer.id].workingPath;
    const workingBytes = fs.readFileSync(workingPath);
    fs.writeFileSync(workingPath, Buffer.concat([workingBytes, Buffer.from([0])]));
    await assert.rejects(
      () => photoshopAction(j, { action: 'inspect', artifactPath: 'unused.psd' }, adobe),
      /重新material/,
    );
    fs.writeFileSync(workingPath, workingBytes);
    state.materials = {};
    store.atomic(stateFile, state);
    await photoshopAction(
      j,
      {
        action: 'plan',
        plan: { layers: plan.layers.map((l) => ({ ...l, includes: '修改为新物体' })) },
      },
      adobe,
    );
    await assert.rejects(
      () => beginPhotoshopMaterial(j, { ...material, generationId: r.id }),
      /计划已改变/,
    );
  } finally {
    await adobe.close();
  }
});

test('两路alpha提示分开空隙和连续薄透材质，冻结范围及参考保持不变', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    for (const kinds of [['transmissive'], ['clear'], ['clear', 'transmissive']] as const) {
      const { j, layer, body, frame, anchors } = await contextFixture(route);
      const elements = ['实体衣领与面部', '自由玻璃窗及自身水滴'];
      const alphaChecks = kinds.map(kind => kind === 'clear'
        ? { name: '框外环境孔隙', kind, box: [25, 35, 4, 4], maxAlpha: 8, minPassingFraction: 1 }
        : { name: '连续薄透窗', kind, box: [31, 35, 8, 8], minAlpha: 24, maxAlpha: 224,
            minBackgroundResponse: 31, minPassingFraction: 0.9 });
      if (route === 'layer') await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'layout',
        layout: { layers: [{ sourceLayerIds: [layer.id], elements, excludes: '组外栏杆和星图', anchors, alphaChecks }], relations: [] } });
      else await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan',
        plan: { canvas: j.snapshot, layers: [{ layerId: layer.id, name: layer.name, route: 'generate',
          content: 'bitmap', surface: 'transparent', frame, elements, includes: elements.join('；'),
          excludes: '组外栏杆和星图', rationale: '材质类别分离', compositing: 'normal', editable: 'pixels', anchors, alphaChecks }], relations: [] } });
      const beforeSource = fs.readFileSync(store.assetPath(j.documentId, j.snapshot.source));
      for (const promptStyle of ['structured', 'concise-edit'] as const) {
        const p = await api(`/api/jobs/${j.id}/generation`, { ...body, elements, referenceContext: undefined, promptStyle });
        const hasClear = kinds.some(k => k === 'clear'), hasTransmission = kinds.some(k => k === 'transmissive');
        assert.equal(p.prompt.includes('clear区域是原图可见环境孔隙'), hasClear);
        assert.equal(p.prompt.includes('连续的非空薄透材质覆盖'), hasTransmission);
        if (hasTransmission) {
          assert.match(p.prompt, /minAlpha至maxAlpha范围并满足minPassingFraction/);
          assert.match(p.prompt, /不能只剩零散水滴\/细边/);
          assert.match(p.prompt, /不另造这些后景纹理作为材质反射/);
          assert.match(p.prompt, /不降低同组实体或整层opacity/);
        }
        if (hasClear) assert.match(p.prompt, /此清空规则不用于transmissive或opaque/);
        assert(!p.prompt.includes('冻结区域隔离约束：原图可见环境孔隙属于背景'));
        assert.deepEqual(p.alphaChecks, alphaChecks);
        assert.deepEqual(p.frame, frame); assert.deepEqual(p.anchors, anchors);
        assert.deepEqual(fs.readFileSync(store.assetPath(j.documentId, j.snapshot.source)), beforeSource);
        assert.equal(p.referencePaths.length, 1);
      }
      const live = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
      assert.equal(live.outputs.length, 0);
    }
  }
});

test('两路occupied冻结内容范围拒绝空正文accepted且不改实际原件', async () => {
  for (const route of ['layer', 'photoshop'] as const) {
    const { j, layer, body, frame, anchors } = await contextFixture(route);
    const alphaChecks = [{ name: '正文必须存在', kind: 'occupied', box: [25, 55, 12, 8], minAlpha: 32, minPassingFraction: 0.05 }];
    const elements = ['大标题', '正文符号表'];
    if (route === 'layer') await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'layout',
      layout: { layers: [{ sourceLayerIds: [layer.id], elements, excludes: '纸底', anchors, alphaChecks }], relations: [] } });
    else await api(`/api/jobs/${j.id}/ps-rebuild`, { taskId: j.taskId, action: 'plan', plan: { canvas: j.snapshot,
      layers: [{ layerId: layer.id, name: layer.name, frame, route: 'generate', content: 'bitmap', surface: 'transparent',
        elements, includes: elements.join('；'), excludes: '纸底', rationale: '正文缺失守卫', compositing: 'normal', editable: 'pixels', anchors, alphaChecks }], relations: [] } });
    const p = await api(`/api/jobs/${j.id}/generation`, { ...body, elements, referenceContext: undefined, promptStyle: 'concise-edit' });
    assert.deepEqual(p.alphaChecks, alphaChecks); assert.match(p.prompt, /不允许只保留大标题\/主图而省略正文/);
    assert(!p.prompt.includes('clear区域是原图可见环境孔隙')); assert(!p.prompt.includes('连续的非空薄透材质覆盖'));
    const empty = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID() + '.png');
    const pixels = Buffer.alloc(frame.width * frame.height * 4); pixels.fill(255, 0, frame.width * 4);
    await sharp(pixels, { raw: { width: frame.width, height: frame.height, channels: 4 } }).png().toFile(empty);
    const before = fs.readFileSync(empty);
    const r = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'register', requestId: p.id,
      path: empty, prompt: p.prompt, referencePaths: p.referencePaths });
    assert.equal(r.alphaDiagnostics.passed, false); assert.equal(r.alphaDiagnostics.checks[0].passingPixels, 0);
    const evidence = { geometry: '完整文件框原位，没有改变源坐标。', appearance: '这是错误审查声明，用于检查正文遗漏能否阻止接受。',
      isolation: '顶部有白像素而正文范围完全空，冻结occupied必须拒绝。', candidateIds: [r.id] };
    const accepted = { taskId: j.taskId, action: 'review', generationId: r.id, comparisonHash: r.comparisonHash,
      review: review('accepted'), elements: elements.map((name, i) => ({ name, status: 'matched',
        observation: i === 0 ? '顶部候选大标题所在位置有实际像素，本测试不推定真实字形。' : '假装正文存在的错误观察应被冻结覆盖守卫独立拒绝。' })), evidence };
    const failed = await api(`/api/jobs/${j.id}/generation`, accepted, 500);
    assert.match(failed.error, /区域alpha检查未通过/);
    assert.deepEqual(fs.readFileSync(empty), before);
    const state = await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'status' });
    assert.equal(state.outputs.length, 1); assert.equal(state.outputs[0].review, undefined);
  }
});

test('仅opaque实体不收到clear清空或transmissive连续薄透指令', async () => {
  const { j, layer, body, anchors } = await contextFixture('layer');
  const alphaChecks = [{ name: '脸部实体', kind: 'opaque', box: [25, 35, 8, 8], minAlpha: 248, minPassingFraction: 0.95 }];
  await api(`/api/jobs/${j.id}/generation`, { taskId: j.taskId, action: 'layout',
    layout: { layers: [{ sourceLayerIds: [layer.id], elements: body.elements, excludes: '其他物体', anchors, alphaChecks }], relations: [] } });
  const p = await api(`/api/jobs/${j.id}/generation`, { ...body, referenceContext: undefined });
  assert.match(p.prompt, /冻结opaque区域要求实体覆盖率alpha下限/);
  assert(!p.prompt.includes('clear区域是原图可见环境孔隙'));
  assert(!p.prompt.includes('连续的非空薄透材质覆盖'));
  assert(!p.prompt.includes('冻结区域隔离约束：原图可见环境孔隙属于背景'));
  assert.deepEqual(p.alphaChecks, alphaChecks);
});

test('v3合并与整图放大使用框并集，登记对应来源不丢失，跨对话或未领取不能登记', async () => {
  const { j } = await fixture('layer', true),
    ids = j.snapshot.layers.map((l) => l.id);
  await api(`/api/jobs/${j.id}/generation`, { taskId: 'wrong-task', action: 'status' }, 403);
  const p = await api(`/api/jobs/${j.id}/generation`, {
    taskId: j.taskId,
    action: 'prepare',
    sourceLayerIds: ids,
    width: 320,
    height: 240,
    elements: ['合并物体'],
    purpose: '合并重建',
    referenceObservation: '对应原始两层的并集',
  });
  assert.deepEqual(p.frame, { x: 40, y: 60, width: 220, height: 80 });
  const r = await register(j, p, await png(550, 200, true));
  await api(`/api/jobs/${j.id}/generation`, {
    taskId: j.taskId,
    action: 'review',
    generationId: r.id,
    comparisonHash: r.comparisonHash,
    review: review('accepted'),
    elements: [{ name: '合并物体', status: 'matched', observation: '几何夹具' }],
  });
  const done = await api(`/api/jobs/${j.id}/apply`, {
    taskId: j.taskId,
    baseVersion: j.version,
    width: 320,
    height: 240,
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
  assert.equal(im.layers.length, 1);
  assert.deepEqual(im.layers[0].sourceLayerIds, ids);
  assert.deepEqual(im.layers[0].frame, p.frame);
  await api(
    `/api/jobs/${j.id}/generation`,
    {
      taskId: j.taskId,
      action: 'prepare',
      sourceLayerIds: ids,
      purpose: 'stale',
      elements: ['合并物体'],
      referenceObservation: 'completed',
    },
    409,
  );
});
