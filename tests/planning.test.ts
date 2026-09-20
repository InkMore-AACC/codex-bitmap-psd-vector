import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {planningLayer} from '../shared/planning.js';
import {unionFrames} from '../shared/layer-frame.js';

process.env.LAYER_CANVAS_DATA=path.resolve('test-output/planning-'+crypto.randomUUID());
const {app,TOKEN,BRIDGE_TOKEN}=await import('../server/index.js');
const {load,getJob,dir,writeAsset}=await import('../server/store.js');
app.locals.codexSender=async()=>({delivered:true});
app.locals.cutoutWorker=async()=>{throw new Error('Box planning must never invoke a cutout worker')};
const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
const headers={'Content-Type':'application/json','X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN};
after(()=>{server.closeAllConnections();server.close()});
async function api(route:string,body?:any,method=body?'POST':'GET',expected=200){
 const r=await fetch(base+route,{method,headers,body:body?JSON.stringify(body):undefined});const data:any=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;
}
async function png(w:number,h:number,color='#123456'){
 const p=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');
 await sharp({create:{width:w,height:h,channels:4,background:color}}).png().toFile(p);return p;
}
async function fixture(){
 let d=await api('/api/document?taskId=planning_'+crypto.randomUUID());
 d=await api(`/api/document/${d.id}/import-path`,{taskId:d.taskId,path:await png(80,60)});
 return d;
}
async function planned(){
 const d=await fixture();const j=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'plan',mode:3},'POST',202);
 await api(`/api/jobs/${j.id}/claim`,{taskId:d.taskId});
 const result=await api(`/api/jobs/${j.id}/plan`,{taskId:d.taskId,baseVersion:j.version,layers:[{name:'背景',role:'background',box:[0,0,80,60]},{name:'人物',role:'foreground',box:[10,12,20,30],opinion:'保留发丝'}]});
 return result.document;
}
test('Codex planning accepts only named boxes, creates no pixels, and stops before reconstruction',async()=>{
 const d=await fixture();const original=structuredClone(d.images[0]);
 const assets=()=>fs.readdirSync(path.join(dir(d.id),'assets')).sort();const before=assets();
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:original.id,type:'plan',mode:3},'POST',202);
 await api(`/api/jobs/${j.id}/claim`,{taskId:d.taskId});
 const packet=await api(`/api/jobs/${j.id}/packet?taskId=${d.taskId}`);
 assert.equal(packet.planningContract.mode,'bounds-only');assert.equal(packet.planningContract.generationAllowed,false);assert.equal(packet.localTools,undefined);
 assert(!packet.requirements.includes('预分层必须是真实透明抠图，不是矩形截图'));
 const submit=(layers:any[],expected=400)=>api(`/api/jobs/${j.id}/plan`,{taskId:d.taskId,baseVersion:j.version,layers},'POST',expected);
 const layer={name:'人物',box:[10,12,20,30],opinion:'保留发丝'};
 await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{name:'人物',path:await png(20,30)}]},'POST',400);
 await submit([{...layer,path:await png(20,30)}]);await submit([{...layer,url:original.source}]);
 await submit([{...layer,box:[1.5,2,20,30]}]);await submit([{...layer,box:[0,0,0,30]}]);await submit([{...layer,name:'  '}]);
 const result=await submit([layer],200);const im=result.document.images[0];
 assert.equal(im.status,'preview');assert.equal(result.document.images.length,1);assert.equal(im.source,original.source);assert.equal(im.url,original.url);
 assert.equal(im.layers[0].kind,'plan');assert.equal(im.layers[0].url,undefined);assert.deepEqual(im.layers[0].frame,{x:10,y:12,width:20,height:30});
 assert.equal(getJob(j.id).status,'completed');assert.deepEqual(assets(),before);
 assert.deepEqual(load(d.id).images[0],im);
});
test('manual layers persist with local previews and cannot masquerade as finished PSD/vector layers',async()=>{
 let d=await planned();const im=d.images[0];
 im.layers.push(planningLayer('manual','右侧装饰',{x:-4,y:8,width:16,height:12},'foreground','仅右侧花纹'));
 im.layers.push({id:'local',name:'本地预览',x:0,y:0,width:80,height:60,url:writeAsset(d.id,fs.readFileSync(await png(80,60)),'.png'),visible:true,opacity:1,opinion:'局部意见',kind:'raster',preview:true,disposition:'rebuild'});
 im.annotations.push({id:'a',layerId:'manual',type:'arrow',points:[-20,0,4,14],text:'装饰归属此层',color:'#ff6600'});
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 assert.deepEqual(load(d.id).images[0].layers,im.layers);assert.deepEqual(load(d.id).images[0].annotations,im.annotations);
 for(const change of [(v:any)=>v.layers[0].url=v.source,(v:any)=>v.status='layered',(v:any)=>v.vectorLayers=[v.layers[0]]]){
  const bad=structuredClone(d);change(bad.images[0]);await api(`/api/document/${d.id}`,{document:bad,expectedRevision:d.revision},'PUT',400);
 }
 const psd=await fetch(base+`/api/document/${d.id}/export?imageId=${im.id}&format=psd`,{headers});assert.equal(psd.status,400);
 const pngResponse=await fetch(base+`/api/document/${d.id}/export?imageId=${im.id}&format=png`,{headers});assert.equal(pngResponse.status,200);
 await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'vectorize'},'POST',400);
});
test('planned and manually added layers freeze frames, reconstruct only after confirmation, and branch without altering the source',async()=>{
 let d=await planned();d.images[0].layers.push(planningLayer('manual','装饰',{x:40,y:8,width:16,height:12}));
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');const original=structuredClone(d.images[0]);
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:original.id,type:'layer'},'POST',202);
 const packet=await api(`/api/jobs/${j.id}/packet?taskId=${d.taskId}`);
 assert.equal(packet.frameContract.layers.length,3);assert(packet.layers.every((l:any)=>!l.url&&!l.path&&l.inputRole==='annotation-only'));
 await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:original.layers},'POST',400);
 const layers=[];for(const l of original.layers)layers.push({id:l.id,name:l.name,...l.frame,path:await png(l.frame.width,l.frame.height,'#ffaacc')});
 const result=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers});
 assert.deepEqual(result.document.images[0],original);const child=result.document.images[1];
 assert.equal(child.parentId,original.id);assert.equal(child.status,'layered');assert(child.layers.every((l:any)=>l.kind==='raster'&&!l.preview));
 assert.deepEqual(child.layers.map((l:any)=>l.frame),original.layers.map((l:any)=>l.frame));
});
test('partial merges bind manual layer annotations, keep unselected plans unfinished, and reject empty confirmation',async()=>{
 let d=await planned();const im=d.images[0];im.layers.push(planningLayer('manual','饰品',{x:32,y:12,width:8,height:8}));
 im.annotations.push({id:'mark',layerId:'manual',type:'arrow',points:[-3,0,34,16],text:'一起合并',color:'#ff6600'});
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 const ids=[im.layers[1].id,'manual'];const frame=unionFrames(im.layers.slice(1).map((l:any)=>l.frame));
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'revise',layerIds:ids},'POST',202);
 const r=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{name:'人物与饰品',sourceLayerIds:ids,...frame,path:await png(frame.width,frame.height,'#eeffaa')}]});
 const child=r.document.images[1];assert.equal(child.layers.length,2);assert.equal(child.status,'preview');assert.equal(child.layers[0].kind,'plan');assert.equal(child.annotations[0].layerId,ids[0]);assert.equal(child.source,im.source);
 d=load(d.id);d.images[0].layers=[];d.images[0].annotations=[];d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'layer'},'POST',400);
});
