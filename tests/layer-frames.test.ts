import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {readPsd} from 'ag-psd';
import {resizeFrame,layerFrame,unionFrames} from '../shared/layer-frame.js';
import {generationPlan,generationPoint,aspectError} from '../shared/generation-geometry.js';

process.env.LAYER_CANVAS_DATA=path.resolve('test-output/frames-'+crypto.randomUUID());
const {app,TOKEN,BRIDGE_TOKEN}=await import('../server/index.js');
const {writeAsset,assetPath,getJob}=await import('../server/store.js');
app.locals.codexSender=async()=>({delivered:true});
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
 let d=await api('/api/document?taskId=frames_'+crypto.randomUUID());const input=await png(80,60);
 d=await api(`/api/document/${d.id}/import-path`,{taskId:d.taskId,path:input});
 const image=d.images[0];image.status='preview';
 image.layers=[{id:'a',name:'主体',x:10,y:12,width:20,height:10,frame:{x:8,y:10,width:24,height:14},role:'foreground',
  url:writeAsset(d.id,fs.readFileSync(await png(20,10)),'.png'),visible:true,opacity:1,opinion:'保留半透明细节',disposition:'rebuild',kind:'raster',preview:true}];
 image.annotations=[{id:'mark',layerId:'a',type:'arrow',points:[-5,0,18,18],text:'这里',color:'#123456'}];
 return api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
}
test('frames resize without crossing or changing object bounds; support negative local coordinates',()=>{
 const frame={x:10,y:20,width:50,height:30};
 assert.deepEqual(resizeFrame(frame,'nw',-20,-30),{x:-10,y:-10,width:70,height:60});
 assert.deepEqual(resizeFrame(frame,'e',-100,10),{...frame,width:1});
 assert.deepEqual(resizeFrame(frame,'move',-30,10),{...frame,x:-20,y:30});
 assert.deepEqual(unionFrames([frame,{x:-10,y:0,width:20,height:30}]),{x:-10,y:0,width:70,height:50});
 assert.deepEqual(layerFrame({...frame,role:'background'},{width:800,height:600}),{x:0,y:0,width:800,height:600});
});

test('generation budget preserves frame and maps negative coordinates with a uniform scale',()=>{
 for(const [width,height] of [[1550,1000],[1551,1000],[1242,2688],[30000,1],[1,30000],[8000,8000],[64,25000],[25000,64]]){
  const f={x:-72,y:35,width,height}, copy={...f}, p=generationPlan(f);
  assert(p.size.width*p.size.height<=1550000); assert.deepEqual(f,copy);
  assert.equal(p.exceedsBudget,width*height>1550000);
  assert(aspectError(p.size,f)<=.01);
  const [u,v]=generationPoint(f,-200,87);
  assert(Math.abs((u-p.offsetX)/p.scale+f.x+200)<1e-9);
  assert(Math.abs((v-p.offsetY)/p.scale+f.y-87)<1e-9);
 }
 assert(aspectError({width:101,height:100},{width:100,height:100})<=.01+1e-12);
});

test('actual resolution may be above budget or below final frame; 1% tolerance with uniform padding',async()=>{
 for(const [fw,fh,aw,ah] of [[1242,2688,853,1844],[24,14,12,7],[24,14,1646,960],[100,100,101,100],[1156,1390,1143,1376]]){
  let d=await fixture();const f={x:-20,y:-7,width:fw,height:fh};d.images[0].layers[0].frame=f;
  d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
  const j=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'layer'},'POST',202);
  const file=await png(aw,ah,'#55aa44');
  if(fw===100) await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{id:'a',name:'主体',...f,path:await png(102,100)}]},'POST',400);
  const done=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{id:'a',name:'主体',...f,path:file}]});
  const l=done.document.images.at(-1).layers[0],m=await sharp(assetPath(d.id,l.url)).metadata();
  assert.deepEqual([m.width,m.height],[fw,fh]);assert.deepEqual(l.frame,f);
  assert.deepEqual(l.generationSize,{width:aw,height:ah});
  assert.deepEqual(fs.readFileSync(assetPath(d.id,l.generationSourceUrl)),fs.readFileSync(file));
  assert.equal(l.generationAdaptation.scale,Math.min(fw/aw,fh/ah));
 }
});

test('crop removes only declared fully transparent margins; weak alpha is protected',async()=>{
 let d=await fixture();const f={x:0,y:0,width:100,height:100};d.images[0].layers[0].frame=f;
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'layer'},'POST',202);
 const bytes=Buffer.alloc(120*100*4);bytes.set([255,0,0,255],(50*120+60)*4);bytes.set([0,0,255,1],0);
 const file=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');
 const input={id:'a',name:'主体',...f,path:file,sourceCrop:{x:10,y:0,width:100,height:100}};
 const apply=(expected:number)=>api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[input]},'POST',expected);
 await sharp(bytes,{raw:{width:120,height:100,channels:4}}).png().toFile(file);
 assert.match((await apply(400)).error,/弱透明/);
 bytes[3]=0;await sharp(bytes,{raw:{width:120,height:100,channels:4}}).png().toFile(file);
 const done=await apply(200),l=done.document.images.at(-1).layers[0];
 assert.deepEqual(l.generationAdaptation.crop,input.sourceCrop);
 assert.deepEqual(l.generationSize,{width:120,height:100});
});

test('opaque background uses edge-copy for tiny gaps and refuses transparent background gaps',async()=>{
 for(const transparent of [false,true]){
  let d=await fixture();const f={x:0,y:0,width:200,height:200};Object.assign(d.images[0].layers[0],{frame:f,role:'background'});
  d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
  const j=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'layer'},'POST',202);
  let source:string;
  if(transparent) source=await png(201,200,'#55aa4400');
  else {source=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');await sharp({create:{width:201,height:200,channels:3,background:'#55aa44'}}).png().toFile(source)}
  const result=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{id:'a',name:'主体',...f,path:source}]},'POST',transparent?400:200);
  if(transparent){assert.match(result.error,/背景含透明/);continue;}
  const l=result.document.images.at(-1).layers[0],output=sharp(assetPath(d.id,l.url)),metadata=await output.metadata();
  if(metadata.hasAlpha){const raw=await output.ensureAlpha().raw().toBuffer({resolveWithObject:true});for(let i=3;i<raw.data.length;i+=raw.info.channels)assert.equal(raw.data[i],255)}
  assert.equal(l.generationAdaptation.padding,'edge-copy');
 }
});

test('staging persists without creating nodes; merged generation plans map annotations; final completion reuses originals',async()=>{
 let d=await fixture();const im=d.images[0];im.layers.push({...structuredClone(im.layers[0]),id:'b',name:'B',frame:{x:36,y:12,width:8,height:8}});
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'layer'},'POST',202);await api(`/api/jobs/${j.id}/claim`,{taskId:d.taskId});
 const plan={groups:[['a','b']],width:160,height:120};
 const packet=await api(`/api/jobs/${j.id}/packet?taskId=${d.taskId}&generationPlan=${encodeURIComponent(JSON.stringify(plan))}`);
 const contract=packet.frameContract.layers[0];assert.equal(packet.frameContract.version,2);
 assert.deepEqual(contract.frame,{x:16,y:20,width:72,height:28});assert.deepEqual(contract.annotations[0].points,[-26,-20,20,16]);
 const stage={taskId:d.taskId,baseVersion:j.version,stageOnly:true,layers:[{id:'a',name:'主体',...im.layers[0].frame,path:await png(12,7,'#ff5522')}]};
 const response=await api(`/api/jobs/${j.id}/apply`,stage);assert.equal(response.completed,false);assert.equal(getJob(j.id).status,'running');
 const fresh=await api('/api/document?taskId='+d.taskId);assert.deepEqual(fresh.images,d.images);
 const next=await api(`/api/jobs/${j.id}/packet?taskId=${d.taskId}`);assert.equal(next.stagedLayers.length,1);assert(fs.existsSync(next.stagedLayers[0].originalPath));
 await api(`/api/jobs/${j.id}/apply`,{...stage,stageOnly:'yes'},'POST',400);
 await api(`/api/jobs/${j.id}/apply`,{...stage,stageOnly:false},'POST',400);
 const done=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{...stage.layers[0],path:next.stagedLayers[0].originalPath},{id:'b',name:'B',...im.layers[1].frame,path:await png(8,8,'#ffaa33')}]});
 assert.equal(done.document.images.length,2);assert.equal(done.document.images.at(-1).layers.length,2);
});
test('frames persist, freeze per job, reject wrong geometry/aspect and normalize at return',async()=>{
 let d=await fixture();const original=structuredClone(d.images[0]);
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:original.id,type:'layer'},'POST',202);
 await api(`/api/jobs/${j.id}/claim`,{taskId:d.taskId});
 assert.equal(j.frameContractVersion,1);
 const packet=await api(`/api/jobs/${j.id}/packet?taskId=${d.taskId}`);
 assert.deepEqual(packet.frameContract.layers[0].frame,original.layers[0].frame);
 assert.equal(packet.layers[0].url,undefined);
 d.images[0].layers[0].frame={x:-2,y:3,width:30,height:20};
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 assert.equal(d.images[0].version,original.version+1);assert.deepEqual(d.images[0].annotations,original.annotations);
 assert.deepEqual(getJob(j.id).snapshot.layers[0].frame,original.layers[0].frame);
 const good=await png(48,28,'#ff6611');
 const result={id:'a',name:'主体',...original.layers[0].frame,path:good};
 const post=(l:any,status=400)=>api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[l]},'POST',status);
 await post({...result,x:9});await post({...result,path:await png(48,48)});await post({...result,path:await png(12,8)});
 assert.equal(getJob(j.id).status,'running');
 const done=await post(result,200);const child=done.document.images.at(-1);const l=child.layers[0];
 assert(child.basedOnOlderVersion);assert.equal(child.parentId,original.id);assert.equal(done.document.images[0].layers[0].frame.x,-2);
 assert.deepEqual(l.frame,original.layers[0].frame);assert.deepEqual(l.generationSize,{width:48,height:28});
 assert.deepEqual([l.x,l.y,l.width,l.height],[8,10,24,14]);
 const m=await sharp(fs.readFileSync(assetPath(d.id,l.url))).metadata();assert.equal(m.width,24);assert.equal(m.height,14);
 assert.deepEqual(child.annotations[0].points,original.annotations[0].points);
 const response=await fetch(base+`/api/document/${d.id}/export?imageId=${child.id}&format=psd`,{headers});assert.equal(response.status,200);
 const psd=readPsd(Buffer.from(await response.arrayBuffer()),{useImageData:true});
 assert.equal(psd.width,80);assert.equal(psd.height,60);assert.deepEqual([psd.children![0].left,psd.children![0].top,psd.children![0].right,psd.children![0].bottom],[8,10,32,24]);
});
test('same-size output preserves faint disconnected alpha and original color without trimming',async()=>{
 const d=await fixture(),f=d.images[0].layers[0].frame;
 const bytes=Buffer.alloc(f.width*f.height*4);bytes.set([22,77,133,9],0);bytes.set([75,80,30,180],(f.width*7+10)*4);
 const file=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');
 await sharp(bytes,{raw:{width:f.width,height:f.height,channels:4}}).png().toFile(file);
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'layer'},'POST',202);
 const done=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{id:'a',name:'主体',...f,path:file}]});
 const output=await sharp(fs.readFileSync(assetPath(d.id,done.document.images.at(-1).layers[0].url))).ensureAlpha().raw().toBuffer();
 assert.deepEqual(output,bytes,'small components, weak alpha, colors and transparent margins must not be filtered');
});
test('merged results require all source IDs and union frames, retaining both layers annotations',async()=>{
 let d=await fixture();const im=d.images[0];
 im.layers.push({...structuredClone(im.layers[0]),id:'b',name:'装饰',x:36,y:12,width:8,height:8,frame:{x:36,y:12,width:8,height:8}});
 im.annotations.push({...im.annotations[0],id:'mark2',layerId:'b',text:'合并这层'});
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'layer'},'POST',202);
 const f=unionFrames(im.layers.map((l:any)=>l.frame)),file=await png(f.width,f.height,'#aa66ee');
 const merged={name:'合并层',sourceLayerIds:['a','b'],...f,path:file};
 await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{...merged,width:20}]},'POST',400);
 const done=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[merged]});
 assert.equal(done.document.images.at(-1).layers.length,1);assert.deepEqual(done.document.images.at(-1).layers[0].frame,f);
 assert.deepEqual(done.document.images.at(-1).annotations.map((a:any)=>a.layerId),['a','a']);
});

test('whole-image resize scales frozen frames, while a partial preview edit keeps other previews unfinished',async()=>{
 let d=await fixture();const im=d.images[0];
 im.layers.push({...structuredClone(im.layers[0]),id:'b',name:'另一层'});
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'revise',layerIds:['a']},'POST',202);
 const file=await png(24,14,'#ffbb55');
 const partial=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{id:'a',name:'主体',...im.layers[0].frame,path:file}]});
 const child=partial.document.images.at(-1);assert.equal(child.status,'preview');assert.equal(child.layers[1].preview,true);
 assert.equal(child.source,im.source,'a composite containing previews must not become a clean generation input');
 const exportResult=await fetch(base+`/api/document/${d.id}/export?imageId=${child.id}&format=psd`,{headers});assert.equal(exportResult.status,400);
 const resize=await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'layer'},'POST',202);
 const doubled={x:16,y:20,width:48,height:28},big=await png(96,56,'#ff00ee');
 const result=await api(`/api/jobs/${resize.id}/apply`,{taskId:d.taskId,baseVersion:resize.version,width:160,height:120,layers:im.layers.map((l:any)=>({id:l.id,name:l.name,...doubled,path:big}))});
 assert.deepEqual(result.document.images.at(-1).layers[0].frame,doubled);
 assert.deepEqual(result.document.images.at(-1).annotations[0].points,[-10,0,36,36]);
});

test('partial merge consumes selected sources, rebinds annotations and preserves unselected layers',async()=>{
 for(const unfinished of [true,false]){
  let d=await fixture();const im=d.images[0];
  im.layers.push({...structuredClone(im.layers[0]),id:'b',name:'装饰',opinion:'保留装饰',frame:{x:36,y:12,width:8,height:8}});
  im.layers.push({...structuredClone(im.layers[0]),id:'c',name:'未选中',opinion:'不可修改',preview:unfinished,disposition:'keep'});
  im.annotations.push({...im.annotations[0],id:'mark-b',layerId:'b'}, {...im.annotations[0],id:'mark-c',layerId:'c'}, {...im.annotations[0],id:'global',layerId:null});
  d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
  const frozen=structuredClone(d.images[0]);
  const j=await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'revise',layerIds:['a','b']},'POST',202);
  const frame=unionFrames(frozen.layers.slice(0,2).map((l:any)=>l.frame));
  const result=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{name:'合并层',sourceLayerIds:['a','b'],...frame,path:await png(frame.width,frame.height,'#bbaaff')}]});
  const child=result.document.images.at(-1);
  assert.deepEqual(child.layers.map((l:any)=>l.id),['a','c']);
  assert.deepEqual(child.layers[0].frame,frame);
  assert.equal(child.layers[0].opinion,'保留半透明细节\n保留装饰');
  assert.deepEqual(child.layers[1],frozen.layers[2]);
  const withoutId=(a:any)=>{const {id:_id,...rest}=a;return rest};
  assert.deepEqual(child.annotations.map(withoutId),frozen.annotations.map((a:any)=>withoutId({...a,layerId:a.layerId==='b'?'a':a.layerId})));
  assert.equal(new Set(child.annotations.map((a:any)=>a.id)).size,4);
  assert.equal(child.status,unfinished?'preview':'layered');
  assert.deepEqual(result.document.images[0],frozen);
 }
});
