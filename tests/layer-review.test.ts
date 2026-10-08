import { persistedLegacyJob } from './legacy-reconstruction.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { layerReviewSchema, RECONSTRUCTION_REVIEW_POLICY } from '../shared/layer-review.js';

process.env.LAYER_CANVAS_DATA = path.resolve('test-output/review-' + crypto.randomUUID());
const { app, TOKEN, BRIDGE_TOKEN } = await import('../server/index.js');
const { assetPath } = await import('../server/store.js');
app.locals.codexSender = async () => ({ delivered: true });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(r => server.once('listening', r));
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
async function api(route:string, body?:any, method=body?'POST':'GET', expected=200):Promise<any> {
  const r = await fetch(base + route, { method, headers: {'Content-Type':'application/json',
    'X-Canvas-Token':TOKEN, 'X-Canvas-Bridge':BRIDGE_TOKEN }, body:body ? JSON.stringify(body) : undefined });
  const data = await r.json(); assert.equal(r.status, expected, JSON.stringify(data)); await persistedLegacyJob(route,data); return data;
}
async function png(width:number,height:number,color:string) {
  const file=path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID()+'.png');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  await sharp({create:{width,height,channels:4,background:color}}).png().toFile(file); return file;
}
const accepted = { status:'accepted', attempts:[{method:'首轮局部原图与整图参照', observation:'合成后可接受，轻微纹理差异不影响整体'}], issues:[] };
const drift = { status:'needs-revision', attempts:[
  {method:'首轮局部原图与整图参照', observation:'主体偏右'},
  {method:'明确局部位置与占比，补充干净周边参考', observation:'略有改善，仍明显偏右，采用这一版'},
], issues:[{message:'主体仍明显偏右；参照原图恢复位置', box:[10,10,20,20]}] };
async function fixture() {
  let d=await api('/api/document?taskId=review_'+crypto.randomUUID());
  d=await api(`/api/document/${d.id}/import-path`,{taskId:d.taskId,path:await png(80,60,'#334455')});
  const j=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'plan',mode:3},'POST',202);
  await api(`/api/jobs/${j.id}/claim`,{taskId:d.taskId});
  const done=await api(`/api/jobs/${j.id}/plan`,{taskId:d.taskId,baseVersion:j.version,layers:[
    {name:'人物',box:[10,10,20,20],opinion:'用户要求保留发丝'}, {name:'装饰',box:[40,10,20,20]},
  ]});
  d=done.document; const im=d.images[0];
  im.annotations=[{id:'user-note',layerId:im.layers[0].id,type:'arrow',points:[0,0,15,15],text:'用户标注',color:'#aabbcc'}];
  return api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
}
test('review accepts one checked failure without forcing retries and retains issue and attempt bounds',()=>{
  assert(layerReviewSchema.safeParse(accepted).success);
  assert(layerReviewSchema.safeParse(drift).success);
  assert(layerReviewSchema.safeParse({...drift,attempts:[drift.attempts[0]]}).success);
  assert(layerReviewSchema.safeParse({...drift,attempts:[drift.attempts[0],drift.attempts[0]]}).success);
  assert(!layerReviewSchema.safeParse({...drift,attempts:[]}).success);
  assert(!layerReviewSchema.safeParse({...drift,issues:[]}).success);
  assert(!layerReviewSchema.safeParse({...drift,attempts:Array(4).fill(drift.attempts[0])}).success);
  assert(!layerReviewSchema.safeParse({...accepted,issues:drift.issues}).success);
  assert.equal(RECONSTRUCTION_REVIEW_POLICY.retryBeforeMarking,false);
  assert.equal(RECONSTRUCTION_REVIEW_POLICY.maxAttemptsPerLayer,3);
  assert.match(RECONSTRUCTION_REVIEW_POLICY.instructions,/新的复杂图.*旧图仅补充回归/);
});
test('drift completes with red annotations; next revision preserves accepted pixels and user notes',async()=>{
  const d=await fixture(), source=d.images[0];
  const j=await api(`/api/document/${d.id}/jobs`,{imageId:source.id,type:'layer'},'POST',202);
  const packet=await api(`/api/jobs/${j.id}/packet?taskId=${d.taskId}`);
  assert.equal(packet.reviewPolicy.maxAttemptsPerLayer,3);
  assert.equal(packet.reviewPolicy.retryBeforeMarking,false);
  assert.equal(packet.localReferences.length,2);
  for(const ref of packet.localReferences) {
    assert(packet.generationInputs.allowedImagePaths.includes(ref.path));
    const m=await sharp(fs.readFileSync(ref.path)).metadata(); assert.deepEqual([m.width,m.height],[20,20]);
  }
  const layers=await Promise.all(source.layers.map(async(l:any,i:number)=>({id:l.id,name:l.name,...l.frame,
    path:await png(20,20,i?'#ccaa33':'#cc5544'),review:i?accepted:{...drift,attempts:[drift.attempts[0]]}})));
  await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,stageOnly:true,layers:[layers[0]]});
  const done=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers});
  assert.equal(done.job.status,'completed'); assert.match(done.job.message,/1 个图层已标红/);
  const result=done.document.images.at(-1);
  assert.deepEqual(done.document.images[0],source);
  assert.equal(result.layers[0].disposition,'rebuild'); assert.equal(result.layers[1].disposition,'keep');
  assert(result.layers.every((l:any)=>l.visible));
  assert.equal(result.annotations.filter((a:any)=>a.origin==='auto-review').length,1);
  assert.equal(result.annotations.find((a:any)=>a.origin==='auto-review').color,'#ff3b30');
  assert(result.annotations.some((a:any)=>a.text==='用户标注'));
  assert.match(result.layers[0].opinion,/用户要求保留发丝/); assert.match(result.layers[0].opinion,/已尝试/);
  // Real document schema round trip must retain metadata and existing chip-editable marks.
  const saved=await api(`/api/document/${d.id}`,{document:done.document,expectedRevision:done.document.revision},'PUT');
  assert.equal(saved.images.at(-1).layers[0].review.status,'needs-revision');
  const revise=await api(`/api/document/${d.id}/jobs`,{imageId:result.id,type:'revise'},'POST',202);
  assert.deepEqual(revise.layerIds,[layers[0].id]);
  const rp=await api(`/api/jobs/${revise.id}/packet?taskId=different-task`,undefined,'GET',403);
  assert(rp.error);
  const fixed={...layers[0],path:await png(20,20,'#aabb33'),review:accepted};
  await api(`/api/jobs/${revise.id}/apply`,{taskId:d.taskId,baseVersion:revise.version,layers:[layers[1]]},'POST',400);
  const repair=await api(`/api/jobs/${revise.id}/apply`,{taskId:d.taskId,baseVersion:revise.version,layers:[fixed]});
  const next=repair.document.images.at(-1);
  assert.deepEqual(next.layers[1],result.layers[1]);
  assert.deepEqual(fs.readFileSync(assetPath(d.id,next.layers[1].url)),fs.readFileSync(assetPath(d.id,result.layers[1].url)));
  assert.equal(next.layers[0].disposition,'keep'); assert.equal(next.layers[0].opinion,'用户要求保留发丝');
  assert.equal(next.annotations.filter((a:any)=>a.origin==='auto-review').length,0);
  assert(next.annotations.some((a:any)=>a.text==='用户标注'));
});
test('clean crop respects extended negative frames; missing files cannot masquerade as drift completion',async()=>{
  let d=await fixture(); const im=d.images[0]; im.layers[0].frame={x:-10,y:-5,width:40,height:30};
  d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
  const j=await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'layer'},'POST',202);
  const packet=await api(`/api/jobs/${j.id}/packet?taskId=${d.taskId}`);
  const ref=packet.localReferences.find((r:any)=>r.layerId===im.layers[0].id);
  const raw=await sharp(fs.readFileSync(ref.path)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.deepEqual([raw.info.width,raw.info.height],[40,30]);assert.equal(raw.data[3],0);
  assert.equal(raw.data[(5*40+10)*4+3],255);
  const layer={id:im.layers[1].id,name:im.layers[1].name,...im.layers[1].frame,path:await png(20,20,'#abcdef'),review:accepted};
  await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,stageOnly:true,layers:[layer]});
  await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[layer]},'POST',400);
  const unchanged=await api('/api/document?taskId='+d.taskId);assert.equal(unchanged.images.length,1);
});
test('whole-node resize keeps accepted assets, scales their placement and rejects replacing them',async()=>{
  let d=await fixture(); const im=d.images[0];
  im.status='layered';
  im.layers=im.layers.map((l:any,i:number)=>({...l,kind:'raster',preview:false,url:im.source,
    disposition:i?'keep':'rebuild',review:i?accepted:undefined}));
  d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
  const j=await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'revise'},'POST',202);
  const plan=encodeURIComponent(JSON.stringify({width:160,height:120}));
  const packet=await api(`/api/jobs/${j.id}/packet?taskId=${d.taskId}&generationPlan=${plan}`);
  const l=packet.frameContract.layers[0];assert.equal(packet.frameContract.layers.length,1);
  const done=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,width:160,height:120,
    layers:[{id:l.layerId,name:'人物',...l.frame,path:await png(40,40,'#ccaabb'),review:accepted}]});
  const out=done.document.images.at(-1), kept=out.layers[1];
  assert.deepEqual([kept.x,kept.y,kept.width,kept.height],[80,20,40,40]);
  assert.equal(kept.url,im.layers[1].url);assert.equal(out.width,160);
  await api(`/api/document/${d.id}/jobs`,{imageId:out.id,type:'revise'},'POST',400);
  // Deliberately selecting a kept layer is an explicit edit, without touching its neighbours.
  const explicit=await api(`/api/document/${d.id}/jobs`,{imageId:out.id,type:'revise',layerIds:[kept.id]},'POST',202);
  assert.deepEqual(explicit.layerIds,[kept.id]);
});
