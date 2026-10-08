import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {planningLayer} from '../shared/planning.js';
import {photoshopSettingsSchema} from '../shared/photoshop.js';
process.env.LAYER_CANVAS_DATA=path.resolve('test-output/background-http-'+crypto.randomUUID());
const {app,TOKEN,BRIDGE_TOKEN,adobe}=await import('../server/index.js');
const store=await import('../server/store.js');
const gen=await import('../server/generation.js');
const ps=await import('../server/photoshop-rebuild.js');
app.locals.codexSender=async()=>({delivered:true});
const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
after(()=>{server.closeAllConnections();server.close();});
const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
const sha=(p:string)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function post(route:string,body:unknown){const r=await fetch(origin+route,{method:'POST',
 headers:{'Content-Type':'application/json','X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN},body:JSON.stringify(body)});
 return {status:r.status,value:await r.json() as any};}
async function api(route:string,body:unknown,status=200){const r=await post(route,body);assert.equal(r.status,status,JSON.stringify(r.value));return r.value;}
async function fixture(type:'layer'|'photoshop'='layer',optIn=true,allowExtraction=true){
 const d=store.getByTask('background_fixture_'+crypto.randomUUID());
 d.settings.photoshop=photoshopSettingsSchema.parse({...d.settings.photoshop,allowExtraction,autoUpscale:false});
 const source=Buffer.alloc(96*96*4);for(let p=0;p<96*96;p++)source.set([p%200,19,111,255],p*4);
 const url=store.writeAsset(d.id,await sharp(source,{raw:{width:96,height:96,channels:4}}).png().toBuffer(),'.png');
 d.images.push({id:'source',name:'offline protocol fixture — not a generated poster',width:96,height:96,x:0,y:0,
  source:url,url,status:'preview',version:1,annotations:[],opinion:'',
  layers:[planningLayer('background','environment',{x:0,y:0,width:96,height:96},'background','')]});store.save(d);
 const created=await api(`/api/document/${d.id}/jobs`,{imageId:'source',type},202);
 await api(`/api/jobs/${created.id}/claim`,{taskId:d.taskId});const j=store.getJob(created.id);
 const selection=path.join(store.dir(d.id),'jobs',j.id,'background-selections');fs.mkdirSync(selection,{recursive:true});
 const mask=Buffer.alloc(96*96*4);for(let y=0;y<96;y++)for(let x=0;x<96;x++){const v=x<32?255:0;mask.set([v,v,v,255],(y*96+x)*4);}
 const mp=path.join(selection,'independent.png');fs.writeFileSync(mp,await sharp(mask,{raw:{width:96,height:96,channels:4}}).png().toBuffer());
 const sourcePath=store.assetPath(d.id,j.snapshot.source),rp=path.join(selection,'review.json');
 fs.writeFileSync(rp,JSON.stringify({taskId:j.taskId,jobId:j.id,documentId:d.id,imageId:j.imageId,
  sourceHash:sha(sourcePath),keepMaskHash:sha(mp),status:'accepted',observation:'Offline fixture selection ownership declaration; no semantic image review or model invocation.'}));
 const protection={version:1,sourceHash:sha(sourcePath),keepMask:{path:mp,hash:sha(mp)},review:{path:rp,hash:sha(rp)}};
 const layout={layers:[{sourceLayerIds:['background'],elements:['fixed environment'],excludes:'all foreground and independent effects',
  ...(optIn?{sourceProtection:protection}:{})}],relations:[]};
 const plan={canvas:{width:96,height:96},layers:[{layerId:'background',name:'environment',frame:{x:0,y:0,width:96,height:96},
  route:'generate',content:'background',surface:'opaque',rationale:'offline protocol fixture, not real model output',includes:'fixed environment',
  excludes:'foreground',compositing:'full canvas below all foreground',elements:['fixed environment'],editable:'pixels',
  ...(optIn?{sourceProtection:protection}:{})}],relations:[]};
 const send=(body:unknown)=>api(`/api/jobs/${j.id}/generation`,{taskId:j.taskId,...body as object});
 const reject=async(body:unknown,pattern:RegExp)=>{const r=await post(`/api/jobs/${j.id}/generation`,{taskId:j.taskId,...body as object});
  assert(r.status>=400,JSON.stringify(r.value));assert.match(r.value.error,pattern);};
 return {j,d,protection,layout,plan,sourcePath,mp,rp,send,reject,registry:path.join(store.dir(d.id),'jobs',j.id,'generation','registry.json')};
}
async function freeze(f:Awaited<ReturnType<typeof fixture>>){
 if(f.j.type==='photoshop')await api(`/api/jobs/${f.j.id}/ps-rebuild`,{taskId:f.j.taskId,action:'plan',plan:f.plan});
 else await f.send({action:'layout',layout:f.layout});
}
async function parentReview(f:Awaited<ReturnType<typeof fixture>>,record:any,status:'accepted'|'needs-revision'='accepted'){
 return f.send({action:'review',generationId:record.id,comparisonHash:record.comparisonHash,
  review:{status,attempts:[{method:'Offline protocol review fixture; no image_gen or visual acceptance',
   observation:'Synthetic 96x96 fixture for checking review binding, not a generated poster or semantic approval.'}],
   issues:status==='accepted'?[]:[{message:'Synthetic fixed-structure mismatch used to exercise the rejection path.'}]},
  elements:[{name:'fixed environment',status:status==='accepted'?'matched':'different',observation:'Offline single-element fixture checks review protocol fields only; no material truth is asserted.'}],
  evidence:{geometry:'Offline geometry review field fixture, not real poster measurement.',appearance:'Offline appearance review field fixture, not visual acceptance.',
   isolation:'Offline exclusion review field fixture, not semantic ownership evidence.',candidateIds:[record.id]}});
}
async function parent(f:Awaited<ReturnType<typeof fixture>>,reviewed=true){
 const q=await f.send({action:'prepare',sourceLayerIds:['background'],elements:['fixed environment'],purpose:'offline protocol fixture only',
  referenceObservation:'Full canvas fixture used to verify identity guards; not visual acceptance.'});
 const tool=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');
 fs.writeFileSync(tool,await sharp({create:{width:96,height:96,channels:4,background:'#235b7a'}}).png().toBuffer());
 let record=await f.send({action:'register',requestId:q.id,path:tool,prompt:q.prompt,referencePaths:q.referencePaths});
 if(reviewed)record=await parentReview(f,record);return {q,record};
}
async function derive(f:Awaited<ReturnType<typeof fixture>>,b:Awaited<ReturnType<typeof parent>>,reviewed=true){
 const r=await f.send({action:'derive-background',baseGenerationId:b.record.id,expectedBaseWorkingHash:b.record.workingHash});
 return reviewed?parentReview(f,r):r;
}

test('unreviewed and failed derived seams cannot enter ordinary composites or PS materials, but direct review remains available',async()=>{
 for(const type of ['layer','photoshop'] as const){
  const f=await fixture(type);await freeze(f);const b=await parent(f),r=await derive(f,b,false);
  const body={taskId:f.j.taskId,action:'material',layerId:'background',path:r.originalPath,provenance:'source-protected',generationId:r.id,
   observation:'Offline derived seam consumer fixture only; no model or Adobe invocation.',
   evidence:{backgroundProtection:{tool:'derived-background',generationId:r.id,baseGenerationId:b.record.id,
    sourceHash:f.protection.sourceHash,keepMaskHash:f.protection.keepMask.hash}}};
  const consume=()=>type==='layer'?post(`/api/jobs/${f.j.id}/generation`,{taskId:f.j.taskId,action:'composite',generationIds:[r.id]}):post(`/api/jobs/${f.j.id}/ps-rebuild`,body);
  for(const reviewed of [false,true]){
   if(reviewed)await parentReview(f,r,'needs-revision');
   const result=await consume();assert(result.status>=400);assert.match(result.value.error,/派生背景本件接缝审核/);
   assert.equal(gen.generationState(f.j).outputs.length,2);assert.equal(gen.generationState(f.j).composite,undefined);
   assert.equal(ps.photoshopState(f.j).materials.background,undefined);
   if(reviewed)assert.equal(gen.generationState(f.j).outputs.find(x=>x.id===r.id)?.review?.status,'needs-revision');
  }
  await parentReview(f,r);assert.equal((await consume()).status,200);
  if(type==='photoshop'){
   for(let i=0;i<60&&ps.photoshopState(f.j).materials.background?.status==='processing';i++)await new Promise<void>(resolve=>setTimeout(resolve,25));
   const ready=ps.photoshopState(f.j).materials.background;assert.equal(ready.status,'ready',ready.error);
   await parentReview(f,r,'needs-revision');const failed=await consume();assert(failed.status>=400);assert.match(failed.value.error,/派生背景本件接缝审核/);
   assert.deepEqual(ps.photoshopState(f.j).materials.background,ready);
   assert.equal(gen.generationState(f.j).outputs.find(x=>x.id===r.id)?.review?.status,'needs-revision');
  }
 }
});

test('late derived seam rejection blocks cached consumers without erasing the failed review',async()=>{
 const f=await fixture();await freeze(f);const b=await parent(f),r=await derive(f,b);
 const c=await f.send({action:'composite',generationIds:[r.id]});
 const compositeReview={action:'review-composite',comparisonHash:c.comparisonHash,
  layers:[{generationId:r.id,status:'matched',observation:'Offline full fixture comparison protocol only, not real poster acceptance.'}],relations:[]};
 await f.send(compositeReview);const beforeDocument=store.load(f.d.id);await parentReview(f,r,'needs-revision');
 const failed=gen.generationState(f.j).outputs.find(x=>x.id===r.id)!;
 await f.reject({action:'composite',generationIds:[r.id]},/派生背景本件接缝审核/);
 await f.reject(compositeReview,/派生背景本件接缝审核/);
 const applied=await post(`/api/jobs/${f.j.id}/apply`,{taskId:f.j.taskId,baseVersion:f.j.version,stageOnly:true,
  layers:[{id:'background',name:'environment',...r.frame,path:r.originalPath,generationId:r.id}]});
 assert(applied.status>=400);assert.match(applied.value.error,/派生背景本件接缝审核/);assert.deepEqual(store.load(f.d.id),beforeDocument);
 assert.deepEqual(gen.generationState(f.j).outputs.find(x=>x.id===r.id)?.review,failed.review);
 await parentReview(f,r);await f.send({action:'composite',generationIds:[r.id]});
});

test('PS rejects a late placement after direct seam rejection and permits freshly reviewed retry',async()=>{
 const f=await fixture('photoshop');await freeze(f);const b=await parent(f),r=await derive(f,b);
 await api(`/api/jobs/${f.j.id}/ps-rebuild`,{taskId:f.j.taskId,action:'material',layerId:'background',
  path:r.originalPath,provenance:'source-protected',generationId:r.id,
  observation:'Offline async review fixture, no real Adobe or model call.',
  evidence:{backgroundProtection:{tool:'derived-background',generationId:r.id,baseGenerationId:b.record.id,
   sourceHash:f.protection.sourceHash,keepMaskHash:f.protection.keepMask.hash}}});
 for(let i=0;i<60&&ps.photoshopState(f.j).materials.background?.status==='processing';i++)
  await new Promise<void>(resolve=>setTimeout(resolve,25));
 assert.equal(ps.photoshopState(f.j).materials.background.status,'ready');
 const {writePsdBuffer}=await import('ag-psd');
 const artifact=path.join(ps.photoshopFolder(f.j),'offline-async-input.psd');
 fs.writeFileSync(artifact,Buffer.from(writePsdBuffer({width:96,height:96,
  imageData:{width:96,height:96,data:new Uint8ClampedArray(96*96*4)},
  children:[{name:'LC_background',children:[]}]},{generateThumbnail:false})));
 let enteredResolve!:()=>void,releaseResolve!:()=>void;
 const entered=new Promise<void>(resolve=>enteredResolve=resolve),release=new Promise<void>(resolve=>releaseResolve=resolve);
 const old=adobe.executeScript;let calls=0,timer:ReturnType<typeof setTimeout>|undefined;
 adobe.executeScript=async(_app,_script,_scope,outputs)=>{
  calls++;enteredResolve();await release;assert(outputs);
  fs.copyFileSync(artifact,outputs[0]);fs.writeFileSync(outputs[1],JSON.stringify({transform:[0,0,96,0,96,96,0,96]}));
  return {execution:{mock:true},artifacts:outputs.map(p=>({path:p,bytes:fs.statSync(p).size})),
   verified:true,note:'Offline synthetic bridge only; no real Adobe execution.'};
 };
 try {
  const input={taskId:f.j.taskId,action:'place-material',layerId:'background',artifactPath:artifact};
  const pending=post(`/api/jobs/${f.j.id}/ps-rebuild`,input);
  await Promise.race([entered,new Promise<void>((_,reject)=>timer=setTimeout(()=>reject(Error('Mock PS await did not start')),3000))]);
  const failed=await parentReview(f,r,'needs-revision');releaseResolve();const late=await pending;
  assert.equal(late.status,400);assert.match(late.value.error,/派生背景本件接缝审核/);
  assert.equal(late.value.artifactPath,undefined);
  assert.equal(ps.photoshopState(f.j).materials.background.choice,undefined);
  assert.equal(ps.photoshopState(f.j).materials.background.status,'ready');
  assert.deepEqual(gen.generationState(f.j).outputs.find(x=>x.id===r.id)?.review,failed.review);
  await parentReview(f,r);const retry=await api(`/api/jobs/${f.j.id}/ps-rebuild`,input);
  assert(retry.artifactPath);assert.equal(ps.photoshopState(f.j).materials.background.choice,'original');
  assert.equal(calls,2);
 }finally{adobe.executeScript=old;releaseResolve();if(timer)clearTimeout(timer);}
});

test('changed derived comparison evidence invalidates its own accepted seam review and cached composite',async()=>{
 const f=await fixture();await freeze(f);const b=await parent(f),r=await derive(f,b);
 await f.send({action:'composite',generationIds:[r.id]});fs.appendFileSync(r.comparisonPath,'changed derived comparison');
 await f.reject({action:'composite',generationIds:[r.id]},/派生背景本件对比证据已变化/);
 assert.equal(gen.generationState(f.j).composite,undefined);
 assert.equal(gen.generationState(f.j).outputs.find(x=>x.id===r.id)?.review,undefined);
});
test('both routes reject unreviewed or failed background parents before any source patch is derived',async()=>{
 for(const type of ['layer','photoshop'] as const){
  const f=await fixture(type);await freeze(f);const b=await parent(f,false);
  const input={action:'derive-background',baseGenerationId:b.record.id,expectedBaseWorkingHash:b.record.workingHash};
  await f.reject(input,/派生前须先审核/);assert.equal(gen.generationState(f.j).outputs.length,1);
  b.record=await parentReview(f,b.record,'needs-revision');await f.reject(input,/派生前须先审核/);
  b.record=await parentReview(f,b.record);const r=await derive(f,b);assert.equal(r.kind,'derived-background');
 }
});

test('background parent review and comparison mutations invalidate derivation and an already verified child',async()=>{
 const f=await fixture();await freeze(f);const b=await parent(f),r=await derive(f,b);
 await f.send({action:'composite',generationIds:[r.id]});
 const original=fs.readFileSync(f.registry),state=JSON.parse(original.toString()),base=state.outputs.find((o:any)=>o.id===b.record.id);
 base.reviewEvidence.geometry+=' changed concurrent observation';fs.writeFileSync(f.registry,JSON.stringify(state));
 await f.reject({action:'composite',generationIds:[r.id]},/变化|绑定不符/);
 fs.writeFileSync(f.registry,original);fs.appendFileSync(b.record.comparisonPath,'modified comparison bytes');
 await f.reject({action:'composite',generationIds:[r.id]},/对比证据已变化/);
 const fresh=await fixture();await freeze(fresh);const freshBase=await parent(fresh);
 fs.appendFileSync(freshBase.record.comparisonPath,'modified before first derivation');
 await fresh.reject({action:'derive-background',baseGenerationId:freshBase.record.id,expectedBaseWorkingHash:freshBase.record.workingHash},/对比证据已变化/);
});

test('ordinary HTTP derived background keeps exact selected source pixels, real fill and distinct provenance',async()=>{
 const f=await fixture();await freeze(f);const b=await parent(f),r=await derive(f,b);
 assert.equal(r.kind,'derived-background');assert.equal(r.receipt.tool,'derived-background');
 const pixels=await sharp(fs.readFileSync(r.workingPath)).ensureAlpha().raw().toBuffer(),source=await sharp(fs.readFileSync(f.sourcePath)).ensureAlpha().raw().toBuffer();
 for(let y=0;y<96;y++)for(let x=0;x<96;x++){const k=(y*96+x)*4;assert.deepEqual([...pixels.subarray(k,k+4)],x<32?[...source.subarray(k,k+4)]:[35,91,122,255]);}
 const c=await f.send({action:'composite',generationIds:[r.id]});assert.equal(c.complete,true);
 await f.reject({action:'composite',generationIds:[b.record.id]},/派生结果/);
 await f.reject({action:'align',generationId:r.id,points:[{source:[0,0],target:[0,0]},{source:[90,90],target:[90,90]}],
  anchorNames:['a','b'],observation:'Cannot retarget protected source pixels.'},/不能align/);
});
test('new protection cannot retrofit an already prepared ordinary or PS job',async()=>{
 for(const type of ['layer','photoshop'] as const){const f=await fixture(type,false);await freeze(f);await parent(f);
  if(type==='layer')await f.reject({action:'layout',layout:{...f.layout,layers:f.layout.layers.map(l=>({...l,sourceProtection:f.protection}))}},/首次prepare/);
  else {const r=await post(`/api/jobs/${f.j.id}/ps-rebuild`,{taskId:f.j.taskId,action:'plan',plan:{...f.plan,
   layers:f.plan.layers.map(l=>({...l,sourceProtection:f.protection}))}});assert(r.status>=400);assert.match(r.value.error,/首次prepare/);}
 }
});

test('PS plan rejects a first generation prepared while protection selection is being checked',async()=>{
 const f=await fixture('photoshop',false);await freeze(f);
 const original=(sharp.prototype as any).metadata;
 let enteredResolve!:()=>void,releaseResolve!:()=>void,held=false;
 const entered=new Promise<void>(r=>enteredResolve=r),release=new Promise<void>(r=>releaseResolve=r);
 (sharp.prototype as any).metadata=async function(...args:any[]){
  const result=await original.apply(this,args);
  if(!held){held=true;enteredResolve();await release;}
  return result;
 };
 const protectedPlan={...f.plan,layers:f.plan.layers.map(l=>({...l,sourceProtection:f.protection}))};
 try {
  const pending=post(`/api/jobs/${f.j.id}/ps-rebuild`,{taskId:f.j.taskId,action:'plan',plan:protectedPlan});
  await entered;
  const q=await f.send({action:'prepare',sourceLayerIds:['background'],elements:['fixed environment'],
   purpose:'offline concurrent prepare fixture; no model invocation',referenceObservation:'Complete clean fixture reference.'});
  assert.equal(q.sourceProtection,undefined);assert.equal(gen.generationState(f.j).requests.length,1);
  releaseResolve();const result=await pending;
  assert(result.status>=400,'Late protection plan must not commit after the first unprotected prepare');
  assert.match(result.value.error,/生成登记已改变/);
  assert.equal(ps.photoshopState(f.j).plan?.layers[0].sourceProtection,undefined);
  const next=await f.send({action:'prepare',sourceLayerIds:['background'],elements:['fixed environment'],
   purpose:'offline preserved plan fixture',referenceObservation:'Original unprotected plan must remain active.'});
  assert.equal(next.sourceProtection,undefined);assert.equal(gen.generationState(f.j).requests.length,2);
 } finally {(sharp.prototype as any).metadata=original;releaseResolve();}
});
test('source, keep selection and review evidence changes invalidate repeated cached composites',async()=>{
 for(const role of ['sourcePath','mp','rp'] as const){const f=await fixture();await freeze(f);const b=await parent(f),r=await derive(f,b);
  await f.send({action:'composite',generationIds:[r.id]});fs.appendFileSync(f[role],'changed');
  await f.reject({action:'composite',generationIds:[r.id]},/摘要|bytes changed|参考图已改变/);
  assert.equal(gen.generationState(f.j).composite,undefined);
 }
});
test('derived pixels cannot be re-registered as an image_gen output through a re-encoded alias',async()=>{
 const f=await fixture();await freeze(f);const b=await parent(f),r=await derive(f,b);
 const q=await f.send({action:'prepare',sourceLayerIds:['background'],elements:['fixed environment'],purpose:'offline alias rejection fixture',referenceObservation:'Must retain the derived role.'});
 const alias=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');
 fs.writeFileSync(alias,await sharp(fs.readFileSync(r.workingPath)).png({compressionLevel:0}).toBuffer());
 await f.reject({action:'register',requestId:q.id,path:alias,prompt:q.prompt,referencePaths:q.referencePaths},/RGBA|角色文件/);
});
test('PS protected material requires its own derived receipt and becomes ready without invoking a model',async()=>{
 const f=await fixture('photoshop');await freeze(f);const b=await parent(f),r=await derive(f,b);
 const evidence={backgroundProtection:{tool:'derived-background',generationId:r.id,baseGenerationId:b.record.id,
  sourceHash:f.protection.sourceHash,keepMaskHash:f.protection.keepMask.hash}};
 const route=`/api/jobs/${f.j.id}/ps-rebuild`,body={taskId:f.j.taskId,action:'material',layerId:'background',path:r.originalPath,
  generationId:r.id,observation:'Offline protected background provenance fixture, no Photoshop or model execution.',evidence};
 const wrong=await post(route,{...body,provenance:'generated'});assert(wrong.status>=400);assert.match(wrong.value.error,/source-protected|派生/);
 await api(route,{...body,provenance:'source-protected'});
 // Exercise the actual server queue once. At 1:1 with autoUpscale=false its
 // processing path does not call a model; do not start a duplicate processor.
 for(let i=0;i<60 && ps.photoshopState(f.j).materials.background.status==='processing';i++)
   await new Promise<void>(resolve=>setTimeout(resolve,25));
 const ready=ps.photoshopState(f.j).materials.background;
 assert.equal(ready.status,'ready',ready.error);
 fs.appendFileSync(f.mp,'source changed after material ready');
 const failure=await post(route,{taskId:f.j.taskId,action:'upscale-material',layerId:'background',force:true});
 assert(failure.status>=400);assert.equal(ps.photoshopState(f.j).inspection,undefined);
});
test('PS protection is rejected when extraction is disabled before any model request',async()=>{
 const f=await fixture('photoshop',true,false);const r=await post(`/api/jobs/${f.j.id}/ps-rebuild`,{taskId:f.j.taskId,action:'plan',plan:f.plan});
 assert(r.status>=400);assert.match(r.value.error,/allowExtraction/);assert.equal(gen.generationState(f.j).requests.length,0);
});
test('foreign review evidence and foreground/effect ownership cannot authorize background protection',async()=>{
 const f=await fixture(),foreign=await fixture();
 fs.copyFileSync(foreign.rp,f.rp);f.protection.review.hash=sha(f.rp);
 await f.reject({action:'layout',layout:f.layout},/同task\/job\/image/);
 assert.equal(gen.generationState(f.j).requests.length,0);
 const g=await fixture();const changed=store.getJob(g.j.id);changed.snapshot.layers[0].role='foreground';store.saveJob(changed);
 await g.reject({action:'layout',layout:g.layout},/满幅背景/);
 const h=await fixture();await h.reject({action:'layout',layout:{...h.layout,layers:h.layout.layers.map(l=>({...l,blendMode:'screen',content:'light-effect'}))}},/光效|背景/);
});
test('a forged leaf file and matching stored digests still cannot change the protected source mapping',async()=>{
 const f=await fixture();await freeze(f);const b=await parent(f),r=await derive(f,b);
 await f.send({action:'composite',generationIds:[r.id]});
 const rgba=await sharp(fs.readFileSync(r.workingPath)).ensureAlpha().raw().toBuffer();rgba[0]=(rgba[0]+37)%255;
 const forged=await sharp(rgba,{raw:{width:96,height:96,channels:4}}).png().toBuffer();
 const state=JSON.parse(fs.readFileSync(f.registry,'utf8')),leaf=state.outputs.find((o:any)=>o.id===r.id);
 fs.writeFileSync(leaf.originalPath,forged);fs.writeFileSync(leaf.workingPath,forged);
 leaf.hash=leaf.workingHash=sha(leaf.workingPath);leaf.derivedBackground.proof.outputHash=leaf.hash;
 leaf.derivedBackground.proof.outputPixelHash=crypto.createHash('sha256').update('96,96,RGBA8\0').update(rgba).digest('hex');
 fs.writeFileSync(f.registry,JSON.stringify(state));
 await f.reject({action:'composite',generationIds:[r.id]},/do not reproduce/);
 assert.equal(gen.generationState(f.j).composite,undefined);
});
test('a parent change during derivation is preserved and prevents committing the stale child in both routes',async()=>{
 for(const type of ['layer','photoshop'] as const){
  const f=await fixture(type);await freeze(f);const b=await parent(f),write=fs.writeFileSync;let mutated=false;
  fs.writeFileSync=((...args:Parameters<typeof fs.writeFileSync>)=>{
    write(...args);
    if(!mutated && String(args[0]).endsWith('derived-background.png')){
      mutated=true;const current=JSON.parse(fs.readFileSync(f.registry,'utf8'));
      current.outputs[0].review={status:'needs-revision',attempts:[{method:'concurrent independent update',observation:'Actual parent review changed while child output awaited decoding.'}],issues:[]};
      write(f.registry,JSON.stringify(current));
    }
  }) as typeof fs.writeFileSync;
  try{await assert.rejects(gen.generationAction(store.getJob(f.j.id),{action:'derive-background',baseGenerationId:b.record.id,
    expectedBaseWorkingHash:b.record.workingHash},type==='photoshop'?ps.photoshopState(f.j).plan:undefined),/变化|绑定不符|派生前须先审核/);}
  finally{fs.writeFileSync=write;}
  assert.equal(mutated,true);const final=gen.generationState(f.j);
  assert.equal(final.outputs.length,1);assert.equal(final.outputs[0].review?.status,'needs-revision');
 }
});
