import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

process.env.LAYER_CANVAS_DATA=path.resolve('test-output/canvas-update-'+crypto.randomUUID());
const {app,TOKEN,BRIDGE_TOKEN,adobe}=await import('../server/index.js');
const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
after(async()=>{await adobe.close();server.closeAllConnections();server.close()});
async function api(route:string,body?:any,method=body?'POST':'GET',internal=false){const response=await fetch(base+route,{method,headers:{'X-Canvas-Token':TOKEN,...internal?{'X-Canvas-Bridge':BRIDGE_TOKEN}:{},...body?{'Content-Type':'application/json'}:{}},body:body?JSON.stringify(body):undefined});const result:any=await response.json();assert.equal(response.status<400,true,JSON.stringify(result));return result;}
async function fixture(){let d=await api('/api/document?taskId=canvas_update_'+crypto.randomUUID());const file=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');await sharp({create:{width:100,height:80,channels:4,background:'#aa6677'}}).png().toFile(file);d=await api(`/api/document/${d.id}/import-path`,{taskId:d.taskId,path:file},'POST',true);return {d,file}}

test('node deletion persists, cancels only its jobs, supports undo and isolates descendant processing',async()=>{
 let {d,file}=await fixture();const root=d.images[0];
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:root.id,type:'layer'});
 const done=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{id:'one',name:'完成层',path:file,width:100,height:80}]},'POST',true);d=done.document;
 const child=d.images[1];child.opinion='只改当前结果';
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 const next=await api(`/api/document/${d.id}/jobs`,{imageId:child.id,type:'revise'});
 const packet=await api(`/api/jobs/${next.id}/packet?taskId=${d.taskId}`,undefined,'GET',true);
 assert.equal(packet.image.id,child.id);assert.notEqual(packet.originalSourcePath,packet.sourcePath);assert.equal(packet.originalReference.imageId,root.id);assert.equal(packet.originalReference.url,root.source);assert.equal(packet.originalReference.readOnly,true);assert.equal(packet.executionScope.nodeOnly,true);assert.equal(packet.globalOpinion,'只改当前结果');
 const rootJob=await api(`/api/document/${d.id}/jobs`,{imageId:root.id,type:'plan'});
 const before=structuredClone(d);d.images=d.images.filter((i:any)=>i.id!==root.id);
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');assert.equal(d.images.length,1);assert.equal(d.images[0].id,child.id);
 const {getJob}=await import('../server/store.js');assert.equal(getJob(rootJob.id).status,'cancelled');assert.notEqual(getJob(next.id).status,'cancelled');
 const reference=await api(`/api/document/${d.id}/images/${child.id}/reference`);assert.equal(reference.url,root.source);assert.equal(reference.complete,true);assert.equal(reference.path,undefined);
 const archivedPacket=await api(`/api/jobs/${next.id}/packet?taskId=${d.taskId}`,undefined,'GET',true);assert.equal(archivedPacket.originalSourcePath,packet.originalSourcePath);
 const restored=await api(`/api/document/${d.id}`,{document:{...before,revision:d.revision},expectedRevision:d.revision},'PUT');assert.equal(restored.images.length,2);assert.equal(restored.images[1].parentId,root.id);
 const applied=await api(`/api/jobs/${next.id}/apply`,{taskId:d.taskId,baseVersion:next.version,layers:[{id:'one',name:'完成层',path:file,width:100,height:80}]},'POST',true);
 assert.equal(applied.document.images.length,3);assert.equal(applied.document.images[2].parentId,child.id);assert.deepEqual(applied.document.images.slice(0,2),restored.images);
});

test('new settings reject retired engines and migrate legacy settings on read',async()=>{
 const {d}=await fixture();assert.equal(d.settings.psdMode,4);
 const {documentSchema,jobSchema}=await import('../server/validation.js');
 assert.throws(()=>jobSchema.parse({imageId:d.images[0].id,type:'layer',mode:1}));
 d.settings.vectorEngine='vectorizer302';d.settings.vectorOptions={supersvg:{pathNum:512},adavec:{segments:600}};
 assert.equal(documentSchema.parse(d).settings.vectorEngine,'vectorizer302');
 assert.throws(()=>jobSchema.parse({imageId:d.images[0].id,type:'vectorize',engine:'adavec'}));
 d.settings.vectorOptions.supersvg.pathNum=100000;assert.equal('vectorOptions' in documentSchema.parse(d).settings,false);
 const {dir,load}=await import('../server/store.js');d.settings.psdMode=1;d.settings.vectorEngine='adavec';fs.writeFileSync(path.join(dir(d.id),'document.json'),JSON.stringify(d));assert.equal(load(d.id).settings.psdMode,2);assert.equal(load(d.id).settings.vectorEngine,'vectorizerCom');assert.equal('vectorOptions' in load(d.id).settings,false);assert.equal(JSON.parse(fs.readFileSync(path.join(dir(d.id),'document.json'),'utf8')).settings.vectorEngine,'adavec');
});

test('outside arrow coordinates and brush masks stay separate from original pixels',async()=>{
 let {d}=await fixture();const im=d.images[0];im.annotations=[{id:'arrow-out',layerId:null,type:'arrow',points:[-120,-40,25,30],labelPosition:[-130,-55],color:'#ff0000',strokeWidth:8,fontWeight:700,fontSize:20,text:'修改这里'},{id:'paint',layerId:null,type:'pen',points:[10,10,20,10],brushSize:8,opacity:.1,color:'#ff0000',text:'这个选区'}];
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 const loaded=await api('/api/document?taskId='+d.taskId);assert.equal(loaded.images[0].annotations[0].strokeWidth,8);assert.equal(loaded.images[0].annotations[0].fontWeight,700);assert.equal(loaded.images[0].annotations[0].fontSize,20);
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'revise'});
 const p=await api(`/api/jobs/${j.id}/packet?taskId=${d.taskId}`,undefined,'GET',true);
 assert.deepEqual(p.coordinateAnnotations[0].target,[25,30]);assert.deepEqual(p.coordinateAnnotations[0].points,[-120,-40,25,30]);assert.equal(p.annotationContract.artworkContainsMarks,false);
 assert.equal(loaded.images[0].annotations[1].opacity,.1);
 const raw=await sharp(fs.readFileSync(p.coordinateAnnotations[1].maskPath)).raw().toBuffer();assert.equal(raw[10*100+15],255);assert.equal(raw[50*100+50],0);
 const actual=await sharp(fs.readFileSync(p.sourcePath)).raw().toBuffer();assert.deepEqual([...actual.subarray(0,4)],[170,102,119,255]);
});

test('formal outputs branch from frozen source and preserve newer edits and annotation bindings',async()=>{
 let {d,file}=await fixture();const im=d.images[0];im.annotations=[{id:'label',layerId:null,type:'text',points:[-25,15],color:'#ff0000',text:'标题'}];
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'layer'});
 d.images[0].opinion='任务提交后新增';d.images[0].x=500;
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 const done=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{name:'完成层',path:file,width:100,height:80}]},'POST',true);
 const node=done.document.images.find((i:any)=>i.id===done.job.result.imageId);
 assert.notEqual(node.id,im.id);assert.equal(node.parentId,im.id);assert.equal(node.basedOnOlderVersion,true);assert.equal(node.opinion,'');assert.equal(done.document.images[0].opinion,'任务提交后新增');assert(node.x>=700);assert.deepEqual(node.annotations[0].points,[-25,15]);assert.notEqual(node.annotations[0].id,'label');
 const repeat=await fetch(base+`/api/jobs/${j.id}/apply`,{method:'POST',headers:{'X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({taskId:d.taskId,baseVersion:j.version,layers:[]})});assert.equal(repeat.status,409);
});

test('moving image and toggling preview visibility do not advance content version',async()=>{
 let {d,file}=await fixture();const original=d.images[0];const j=await api(`/api/document/${d.id}/jobs`,{imageId:original.id,type:'layer'});
 const done=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{name:'层',path:file,width:100,height:80}]},'POST',true);d=done.document;const child=d.images.at(-1),version=child.version;
 child.layers[0].visible=false;child.x+=100;child.y+=30;
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');assert.equal(d.images.at(-1).version,version);
 d.images.at(-1).layers[0].opinion='改颜色';d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');assert.equal(d.images.at(-1).version,version+1);
});

test('active listener receives button event automatically and remains isolated by task',async()=>{
 const {d}=await fixture();const {waitRequests,dispatchStatus}=await import('../server/dispatch.js');
 const started=Date.now();const pending=waitRequests(d.taskId,10000,[]);assert.equal(dispatchStatus(d.taskId).listenerActive,true);assert.equal(dispatchStatus('other').listenerActive,false);
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'plan'});const event:any=await pending;
 assert.equal(event.jobs[0].id,j.id);assert(Date.now()-started<3000);assert.equal(event.dispatch.mode,'desktop-app-tools');
});

test('Adobe execution is inaccessible to web token and bound to the handoff task',async()=>{
 const {d}=await fixture();const j=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'revise'});
 const call=async(internal:boolean)=>fetch(base+`/api/jobs/${j.id}/adobe`,{method:'POST',headers:{'Content-Type':'application/json','X-Canvas-Token':TOKEN,...internal?{'X-Canvas-Bridge':BRIDGE_TOKEN}:{}},body:JSON.stringify({taskId:d.taskId,action:'call',tool:'invalid'})});
 assert.equal((await call(false)).status,403);assert.equal((await call(true)).status,400);
});

test('cancelled listener becomes inactive immediately without disconnecting another listener',async()=>{
 const {waitRequests,dispatchStatus}=await import('../server/dispatch.js');const task='listener-'+crypto.randomUUID();const first=new AbortController(),second=new AbortController();
 const a=waitRequests(task,50000,[],first.signal),b=waitRequests(task,50000,[],second.signal);
 first.abort();await a;assert.equal(dispatchStatus(task).listenerActive,true);second.abort();await b;assert.equal(dispatchStatus(task).listenerActive,false);
});

test('duplicate layer identities and partial whole-image resize are rejected before committing',async()=>{
 let {d,file}=await fixture();let j=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'layer'});
 const done=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,layers:[{id:'a',name:'A',path:file,width:100,height:80},{id:'b',name:'B',path:file,width:100,height:80}]},'POST',true);d=done.document;
 j=await api(`/api/document/${d.id}/jobs`,{imageId:done.job.result.imageId,type:'revise',layerIds:['a']});
 const apply=async(extra:any)=>fetch(base+`/api/jobs/${j.id}/apply`,{method:'POST',headers:{'X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({taskId:d.taskId,baseVersion:j.version,...extra})});
 assert.equal((await apply({width:200,height:160,layers:[{id:'a',name:'A',path:file,width:200,height:160}]})).status,400);
 assert.equal((await apply({layers:[{id:'a',name:'A',path:file,width:100,height:80},{id:'a',name:'A2',path:file,width:100,height:80}]})).status,400);
 const fresh=await api(`/api/document?taskId=${d.taskId}`);assert.equal(fresh.images.length,2);
});

test('returned SVG dimensions define the new node and scale annotation coordinates',async()=>{
 let {d}=await fixture();d.images[0].annotations=[{id:'target',layerId:null,type:'arrow',points:[-20,-10,25,30],labelPosition:[-30,-20],color:'#ff0000',text:'此处'}];d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'illustrator'});
 const done=await api(`/api/jobs/${j.id}/apply`,{taskId:d.taskId,baseVersion:j.version,vectorSvg:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160"><rect width="200" height="160" fill="red"/></svg>'},'POST',true);
 const node=done.document.images.at(-1);assert.equal(node.width,200);assert.equal(node.height,160);assert.deepEqual(node.annotations[0].points,[-40,-20,50,60]);assert.deepEqual(node.annotations[0].labelPosition,[-60,-40]);assert.equal(done.document.images[0].width,100);
});
