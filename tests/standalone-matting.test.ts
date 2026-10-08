import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { DEFAULT_MATTING } from '../shared/standalone-matting.js';

process.env.LAYER_CANVAS_DATA=path.resolve('test-output/standalone-'+crypto.randomUUID());
const {app,TOKEN,BRIDGE_TOKEN}=await import('../server/index.js');
const {getJob,load,assetPath}=await import('../server/store.js');
let dispatches=0;app.locals.codexSender=async()=>{dispatches++;return {delivered:true}};
const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
after(()=>{server.closeAllConnections();server.close()});
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
const headers={'Content-Type':'application/json','X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN};
async function api(p:string,body?:any,method=body?'POST':'GET',expected=200):Promise<any>{
 const r=await fetch(base+p,{method,headers,body:body?JSON.stringify(body):undefined});const v=await r.json();assert.equal(r.status,expected,JSON.stringify(v));return v;
}
async function fixture(){let d=await api('/api/document?taskId=standalone_'+crypto.randomUUID());
 const p=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');
 await sharp({create:{width:40,height:30,channels:4,background:'#345678'}}).png().toFile(p);
 return api(`/api/document/${d.id}/import-path`,{taskId:d.taskId,path:p});
}
async function wait(id:string){for(let i=0;i<100;i++){const j=getJob(id);if(['completed','failed','cancelled'].includes(j.status))return j;await new Promise(r=>setTimeout(r,20));}throw new Error('job timeout')}
async function fake(args:string[]){
 assert.equal(args[0],'matte');assert(!args.includes('--boxes'));
 const out=args[args.indexOf('--output')+1],p=path.join(out,'cutout.png');
 const bytes=Buffer.alloc(40*30*4);for(let y=5;y<25;y++)for(let x=10;x<30;x++)bytes.set([52,86,120,128],(y*40+x)*4);
 fs.writeFileSync(p,await sharp(bytes,{raw:{width:40,height:30,channels:4}}).png().toBuffer());
 return {path:p,warnings:[],execution:{device:'cpu',precision:'fp32'},seconds:.01};
}
test('independent defaults persist without changing PSD parameters or existing canvases',async()=>{
 const before=await fixture();const settings=structuredClone(DEFAULT_MATTING);settings.model='lucida';settings.options.lucida.feather=.5;
 await api('/api/matting-defaults',settings,'PUT');const fresh=await fixture();
 assert.deepEqual(fresh.settings.matting,settings);assert.deepEqual(load(before.id).settings.matting,DEFAULT_MATTING);
 assert.deepEqual(fresh.settings.cutoutOptions,before.settings.cutoutOptions);assert.equal(fresh.settings.psdMode,before.settings.psdMode);
 await api('/api/matting-defaults',{...settings,model:'coarse'},'PUT',400);
 await api('/api/matting-defaults',DEFAULT_MATTING,'PUT');
});
test('local job freezes settings, returns linked alpha node, exports PNG, never dispatches or alters the source',async()=>{
 let d=await fixture();const source=structuredClone(d.images[0]);let release!:()=>void;
 const held=new Promise<void>(r=>release=r);let called!:()=>void;const started=new Promise<void>(r=>called=r);
 app.locals.mattingWorker=async(args:string[])=>{const opts=JSON.parse(fs.readFileSync(args[args.indexOf('--options')+1],'utf8'));
   assert.equal(opts.precision,'fp32');assert.equal(opts.resolution,2048);called();await held;return fake(args);};
 const job=await api(`/api/document/${d.id}/jobs`,{imageId:source.id,type:'cutout'},'POST',202);
 assert.equal(job.dispatch,undefined);await started;
 await api(`/api/jobs/${job.id}/claim`,{taskId:d.taskId},'POST',409);
 await api(`/api/jobs/${job.id}/apply`,{taskId:d.taskId,baseVersion:job.version,layers:[]},'POST',409);
 d.images[0].opinion='用户运行中修改';d.settings.matting.options.birefnet.resolution=1024;
 d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');release();
 const done=await wait(job.id);assert.equal(done.status,'completed',done.message);assert.equal(dispatches,0);
 const result=load(d.id).images.at(-1)!;assert.equal(result.status,'cutout');assert.equal(result.parentId,source.id);
 assert.equal(result.basedOnOlderVersion,true);assert.equal(load(d.id).images[0].opinion,'用户运行中修改');
 assert.equal(result.layers.length,1);assert.equal(result.layers[0].preview,undefined);
 assert.deepEqual([result.width,result.height,result.layers[0].x,result.layers[0].y],[40,30,0,0]);
 assert.equal(result.annotations.length,0);
 const r=await fetch(base+`/api/document/${d.id}/export?imageId=${result.id}&format=png`,{headers});
 assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());
 const m=await sharp(bytes).metadata();assert.equal(m.hasAlpha,true);assert.equal(m.width,40);
 const raw=await sharp(bytes).ensureAlpha().raw().toBuffer();assert.equal(raw[3],0);assert.equal(raw[(10*40+15)*4+3],128);
 // Stored model output is the same full-size transparent file.
 assert.equal((await sharp(fs.readFileSync(assetPath(d.id,result.url))).metadata()).height,30);
});
test('cancellation and invalid output never create a fake result',async()=>{
 const d=await fixture();let called!:()=>void;const started=new Promise<void>(r=>called=r);
 app.locals.mattingWorker=async(_args:string[],signal:AbortSignal)=>{called();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));};
 const j=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'cutout'},'POST',202);await started;
 await api(`/api/jobs/${j.id}/cancel`,{});assert.equal((await wait(j.id)).status,'cancelled');
 app.locals.mattingWorker=async(args:string[])=>{
   const r=await fake(args);fs.writeFileSync(r.path,await sharp({create:{width:20,height:30,channels:3,background:'#ffffff'}}).png().toBuffer());return r;
 };
 const bad=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'cutout'},'POST',202);
 assert.equal((await wait(bad.id)).status,'failed');assert.equal(load(d.id).images.length,1);
 assert.equal(dispatches,0);
});
