import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

process.env.LAYER_CANVAS_DATA=path.resolve('test-output/vector-providers-'+crypto.randomUUID());
const {vectorizeBytes}=await import('../server/providers.js');
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80"><path fill="#aa6677" d="M0 0H100V80H0Z"/></svg>';
test('302 sends its own Bearer key and multipart image, validates raw SVG',async()=>{
 let calls=0;
 const request=(async(url,init)=>{calls++;assert.equal(url,'https://api.302.ai/vectorizer/api/v1/vectorize');assert.equal((init!.headers as any).Authorization,'Bearer test302');assert.equal(init!.redirect,'error');assert.ok((init!.body as FormData).get('image') instanceof Blob);assert.equal((init!.body as FormData).get('output.file_format'),'svg');return new Response(svg)}) as typeof fetch;
 assert.match(await vectorizeBytes(Buffer.from('test'),'vectorizer302',{api302Key:'test302'},undefined,request),/<path/);assert.equal(calls,1);
 await assert.rejects(vectorizeBytes(Buffer.from('test'),'vectorizer302',{},undefined,request),/302.AI API Key/);assert.equal(calls,1);
});

test('Recraft decodes official base64 response and both providers reject non-vector output',async()=>{
 const request=(async(url,init)=>{assert.equal(url,'https://external.api.recraft.ai/v1/images/vectorize');assert.equal((init!.headers as any).Authorization,'Bearer testrecraft');assert.ok((init!.body as FormData).get('file'));return Response.json({image:{b64_json:Buffer.from(svg).toString('base64')}})}) as typeof fetch;
 assert.match(await vectorizeBytes(Buffer.from('test'),'recraft',{recraftKey:'testrecraft'},undefined,request),/<path/);
 await assert.rejects(vectorizeBytes(Buffer.from('test'),'vectorizer302',{api302Key:'test'},undefined,(async()=>new Response('<svg><image href="data:image/png;base64,AAA"/></svg>')) as typeof fetch),/不允许/);
 for(const engine of ['supersvg','adavec','vectorizerCom'])await assert.rejects(vectorizeBytes(Buffer.from('test'),engine,{},undefined,request),/移除|网页/);
 await assert.rejects(vectorizeBytes(Buffer.from('test'),'recraft',{recraftKey:'test'},undefined,(async()=>new Response('secret echoed by upstream',{status:401})) as typeof fetch),/HTTP 401/);
});

const {app,TOKEN,BRIDGE_TOKEN,adobe,runVectorJob}=await import('../server/index.js');
const {load,save,saveJob,getJob}=await import('../server/store.js');
const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const base=`http://127.0.0.1:${(server.address() as any).port}`;
after(async()=>{await adobe.close();server.closeAllConnections();server.close()});
async function api(route:string,body?:any,method=body?'POST':'GET'){
 const multipart=body instanceof FormData;const r=await fetch(base+route,{method,headers:{'X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN,...body&&!multipart?{'Content-Type':'application/json'}:{}},body:body?multipart?body:JSON.stringify(body):undefined});
 return {status:r.status,body:await r.json() as any};
}
test('manual website roundtrip freezes two layers, rejects incomplete upload and creates linked stale-version node',async()=>{
 let d=(await api('/api/document?taskId=manual_'+crypto.randomUUID())).body;
 const imagePath=path.join(process.env.LAYER_CANVAS_DATA!,'source.png');await sharp({create:{width:100,height:80,channels:4,background:'#aa6677'}}).png().toFile(imagePath);
 d=(await api(`/api/document/${d.id}/import-path`,{taskId:d.taskId,path:imagePath})).body;
 const im=d.images[0];im.layers=[{url:im.source,visible:true,opacity:1,kind:'raster',opinion:'',disposition:'keep',id:'bottom',name:'底层',x:7,y:8,width:60,height:40},{url:im.source,visible:true,opacity:1,kind:'raster',opinion:'',disposition:'keep',id:'top',name:'顶层',x:19,y:21,width:30,height:20}];im.status='layered';save(d);
 const job=manualJob(d,im);
 assert.equal(job.status,'queued');assert.match(job.message,/网页/);
 const packet=(await api(`/api/jobs/${job.id}/external-inputs`)).body;assert.deepEqual(packet.inputs.map((l:any)=>l.id),['bottom','top']);
 const incomplete=new FormData();incomplete.append('bottom',new Blob([svg]),'b.svg');assert.ok((await api(`/api/jobs/${job.id}/external-complete`,incomplete)).status>=400);
 const source=load(d.id);source.images[0].opinion='保留新意见';source.images[0].version++;save(source);
 const form=new FormData();for(const id of ['bottom','top'])form.append(id,new Blob([svg]),id+'.svg');
 const result=await api(`/api/jobs/${job.id}/external-complete`,form);assert.equal(result.status,200,JSON.stringify(result.body));
 const child=result.body.document.images[1];assert.equal(child.parentId,im.id);assert.equal(child.basedOnOlderVersion,true);assert.equal(child.status,'vector');assert.deepEqual(child.layers.map((l:any)=>[l.id,l.x,l.y,l.width,l.height]),[['bottom',7,8,60,40],['top',19,21,30,20]]);assert.equal(result.body.document.images[0].opinion,'保留新意见');
 assert.equal((await api(`/api/jobs/${job.id}/external-complete`,form)).status,409);
 const next=manualJob(d,im);
 await api(`/api/jobs/${next.id}/cancel`,{});assert.equal((await api(`/api/jobs/${next.id}/external-complete`,new FormData())).status,409);
});

function manualJob(d:any,im:any){return saveJob({id:crypto.randomUUID(),documentId:d.id,taskId:d.taskId,imageId:im.id,type:'vectorize',engine:'vectorizerCom',mode:2,status:'queued',message:'历史网页转换任务',createdAt:new Date().toISOString(),version:im.version,snapshot:structuredClone(im)})}
test('official Vectorizer uses distinct Basic ID/Secret and SVG output',async()=>{
 let called=0;const request=(async(url,init)=>{called++;assert.equal(url,'https://vectorizer.ai/api/v1/vectorize');assert.equal((init!.headers as any).Authorization,'Basic '+Buffer.from('official-id:official-secret').toString('base64'));assert.ok((init!.body as FormData).get('image'));return new Response(svg)}) as typeof fetch;
 await assert.rejects(vectorizeBytes(Buffer.from('x'),'vectorizer',{api302Key:'not-official'},undefined,request),/官方 API/);assert.equal(called,0);
 assert.match(await vectorizeBytes(Buffer.from('x'),'vectorizer',{vectorizerId:'official-id',vectorizerSecret:'official-secret'},undefined,request),/<path/);
});
test('automatic webpage job returns aligned child, preserves edits, and honours cancellation',async()=>{
 let d=(await api('/api/document?taskId=automatic_'+crypto.randomUUID())).body;
 const file=path.join(process.env.LAYER_CANVAS_DATA!,'auto.png');await sharp({create:{width:100,height:80,channels:4,background:'#aa6677'}}).png().toFile(file);
 d=(await api(`/api/document/${d.id}/import-path`,{taskId:d.taskId,path:file})).body;
 const im=d.images[0];im.layers=[{url:im.source,visible:true,opacity:1,kind:'raster',opinion:'',disposition:'keep',id:'one',name:'底层',x:7,y:8,width:60,height:40},{url:im.source,visible:true,opacity:1,kind:'raster',opinion:'',disposition:'keep',id:'two',name:'顶层',x:12,y:9,width:30,height:20}];im.status='layered';save(d);
 const job=manualJob(d,im);let count=0,closed=false;
 await runVectorJob(job.id,()=>({open:async()=>{},close:async()=>{closed=true},convert:async(_data:Buffer,_signal:AbortSignal,progress:(s:string)=>void)=>{count++;progress('网页测试');if(count===1){const latest=load(d.id);latest.images[0].opinion='新的修改';latest.images[0].version++;save(latest)}return svg}} as any));
 assert.equal(count,2,JSON.stringify(getJob(job.id)));assert.equal(closed,true);assert.equal(getJob(job.id).status,'completed');const result=load(d.id);assert.equal(result.images[0].opinion,'新的修改');assert.equal(result.images[1].parentId,im.id);assert.equal(result.images[1].basedOnOlderVersion,true);assert.deepEqual(result.images[1].layers.map(l=>[l.id,l.x,l.y]),[['one',7,8],['two',12,9]]);
 const next=manualJob(d,im);await runVectorJob(next.id,()=>({open:async()=>{},close:async()=>{},convert:async()=>{await api(`/api/jobs/${next.id}/cancel`,{});return svg}} as any));assert.equal(getJob(next.id).status,'cancelled');assert.equal(load(d.id).images.length,2);
});

test('Codex webpage option queues to current thread, preserves verification pause and accepts exact downloaded layers',async()=>{
 let d=(await api('/api/document?taskId=codex_web_'+crypto.randomUUID())).body;
 const file=path.join(process.env.LAYER_CANVAS_DATA!,'codex.png');await sharp({create:{width:100,height:80,channels:4,background:'#aa6677'}}).png().toFile(file);
 d=(await api(`/api/document/${d.id}/import-path`,{taskId:d.taskId,path:file})).body;const im=d.images[0];
 im.layers=[{id:'bottom',name:'底层',url:im.source,x:7,y:8,width:60,height:40,visible:true,opacity:1,kind:'raster',opinion:'',disposition:'keep'},{id:'top',name:'顶层',url:im.source,x:20,y:15,width:30,height:20,visible:true,opacity:.7,kind:'raster',opinion:'',disposition:'keep'}];im.status='layered';d.settings.vectorizerComMode='codex';save(d);
 const job=(await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'vectorize',engine:'vectorizerCom'})).body;assert.equal(job.status,'waiting_codex');assert.equal(job.webMode,'codex');
 const {waitRequests}=await import('../server/dispatch.js');const event:any=await waitRequests(d.taskId,0,[]);assert.ok(event.jobs.some((j:any)=>j.id===job.id));
 assert.equal((await api(`/api/jobs/${job.id}/claim`,{taskId:'other'})).status,403);
 assert.equal((await api(`/api/jobs/${job.id}/claim`,{taskId:d.taskId})).status,200);
 const packet=(await api(`/api/jobs/${job.id}/packet?taskId=${d.taskId}`)).body;assert.deepEqual(packet.webVector.inputs.map((l:any)=>l.layerId),['bottom','top']);assert.ok(packet.webVector.inputs.every((l:any)=>fs.existsSync(l.uploadPath)));
 const status=await api(`/api/jobs/${job.id}/web-vector`,{taskId:d.taskId,action:'status',message:'等待你在网页完成验证'});assert.equal(status.body.status,'running');assert.equal(getJob(job.id).status,'running');assert.equal(load(d.id).images.length,1);
 const output=path.join(packet.outputDirectory,'download.svg');fs.writeFileSync(output,svg);
 const complete=(files:any[],baseVersion=job.version)=>api(`/api/jobs/${job.id}/web-vector`,{taskId:d.taskId,action:'complete',baseVersion,files});
 assert.ok((await complete([{layerId:'bottom',path:output}])).status>=400);
 const files=packet.webVector.inputs.map((l:any)=>({layerId:l.layerId,path:output}));assert.ok((await complete(files,job.version+1)).status>=400);
 const result=await complete(files);assert.equal(result.status,200,JSON.stringify(result.body));const child=result.body.document.images[1];assert.equal(child.parentId,im.id);assert.deepEqual(child.layers.map((l:any)=>[l.id,l.x,l.y,l.opacity]),[['bottom',7,8,1],['top',20,15,.7]]);assert.equal(getJob(job.id).status,'completed');assert.equal((await complete(files)).status,409);
 const next=(await api(`/api/document/${d.id}/jobs`,{imageId:im.id,type:'vectorize',engine:'vectorizerCom'})).body;await api(`/api/jobs/${next.id}/claim`,{taskId:d.taskId});await api(`/api/jobs/${next.id}/cancel`,{});assert.equal((await api(`/api/jobs/${next.id}/web-vector`,{taskId:d.taskId,action:'status',message:'继续'})).status,409);
});

test('Codex result receiver reports verification and blocked download, then resumes to one linked node',async()=>{
 const {codexWebAction,webVectorPacket}=await import('../server/external-vector.js');
 const {VerificationRequired}=await import('../server/web-vector-download.js');
 let d=(await api('/api/document?taskId=receive_'+crypto.randomUUID())).body;
 const file=path.join(process.env.LAYER_CANVAS_DATA!,'receive.png');await sharp({create:{width:100,height:80,channels:4,background:'#aa6677'}}).png().toFile(file);
 d=(await api(`/api/document/${d.id}/import-path`,{taskId:d.taskId,path:file})).body;const im=d.images[0];
 const job=manualJob(d,im);job.webMode='codex';job.status='running';saveJob(job);
 const options={action:'download',reviewUrl:'https://vectorizer.com/review/0123456789abcdef',baseVersion:job.version};
 await assert.rejects(codexWebAction(getJob(job.id),options,async()=>{throw new VerificationRequired('请完成网页验证')}),/验证/);
 assert.equal(getJob(job.id).webProgress?.phase,'verification');assert.equal(load(d.id).images.length,1);
 await assert.rejects(codexWebAction(getJob(job.id),options,async(_address,_inputs,_out,_signal,progress)=>{progress('已收到部分文件',1);throw new Error('下载中断')}),/下载中断/);
 assert.equal(getJob(job.id).webProgress?.phase,'blocked');assert.equal(getJob(job.id).webProgress?.completed,1);
 const packet=await webVectorPacket(getJob(job.id));assert.ok(packet!.inputs[0].uploadPath.includes(job.id.slice(0,8)));
 await assert.rejects(codexWebAction(getJob(job.id),{...options,reviewUrl:'https://vectorizer.com/review/fedcba9876543210'},async()=>[]),/不一致/);
 await codexWebAction(getJob(job.id),options,async(_address,inputs,out)=>{const output=path.join(out,'received.svg');fs.writeFileSync(output,svg);return inputs.map(l=>({layerId:l.layerId,path:output}))});
 const complete=getJob(job.id);assert.equal(complete.status,'completed');assert.ok((complete.result as any).artifactUrl.endsWith('.svg'));assert.equal(load(d.id).images.length,2);assert.equal(load(d.id).images[1].parentId,im.id);
 const repeated=await codexWebAction(complete,options,async()=>{throw new Error('completed download must not run again')});assert.equal((repeated as any).alreadyCompleted,true);assert.equal(load(d.id).images.length,2);
 const httpRepeated=await api(`/api/jobs/${job.id}/web-vector`,{...options,taskId:d.taskId});assert.equal(httpRepeated.status,200,JSON.stringify(httpRepeated.body));assert.equal(httpRepeated.body.alreadyCompleted,true);assert.equal(load(d.id).images.length,2);
 await assert.rejects(codexWebAction(complete,{...options,baseVersion:job.version+1},async()=>[]),/领取/);
 const cancelled=manualJob(d,im);cancelled.webMode='codex';cancelled.status='running';saveJob(cancelled);
 await assert.rejects(codexWebAction(getJob(cancelled.id),{...options,baseVersion:cancelled.version},async()=>{const latest=getJob(cancelled.id);latest.status='cancelled';saveJob(latest);return []}),/取消/);
 assert.equal(getJob(cancelled.id).status,'cancelled');assert.equal(load(d.id).images.length,2);
});
