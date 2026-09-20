import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {DEFAULT_CUTOUT,cutoutOptionsSchema} from '../shared/cutout.js';

process.env.LAYER_CANVAS_DATA=path.resolve('test-output/cutouts-'+crypto.randomUUID());
const {app,TOKEN,BRIDGE_TOKEN}=await import('../server/index.js');
const {load,getJob}=await import('../server/store.js');
const {readCutoutDefaults}=await import('../server/cutout-settings.js');
app.locals.codexSender=async()=>({delivered:true});
const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
after(()=>{server.closeAllConnections();server.close()});
async function api(route:string,body?:any,method=body?'POST':'GET',expected=200){
 const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN},body:body?JSON.stringify(body):undefined});const data:any=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;
}
async function fixture(){let d=await api('/api/document?taskId=cutout_'+crypto.randomUUID());const file=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');await sharp({create:{width:64,height:48,channels:4,background:'#123456'}}).png().toFile(file);d=await api(`/api/document/${d.id}/import-path`,{taskId:d.taskId,path:file});return d;}

test('local settings persist for new canvases, isolate existing canvases, and validate soft alpha levels',async()=>{
 const old=await fixture();assert.equal(old.settings.psdMode,4);
 const options=structuredClone(DEFAULT_CUTOUT);options.lucida.feather=1.5;options.coarse.threads=3;
 await api('/api/cutout-defaults',{psdMode:5,cutoutOptions:options},'PUT');
 assert.deepEqual(readCutoutDefaults(),{psdMode:5,cutoutOptions:options});
 const fresh=await fixture();assert.equal(fresh.settings.psdMode,5);assert.equal(fresh.settings.cutoutOptions.lucida.feather,1.5);
 assert.equal(load(old.id).settings.psdMode,4);assert.deepEqual(load(old.id).settings.cutoutOptions,DEFAULT_CUTOUT);
 assert.throws(()=>cutoutOptionsSchema.parse({...options,lucida:{...options.lucida,blackPoint:.8,whitePoint:.2}}));
 await api('/api/cutout-defaults',{psdMode:4,cutoutOptions:{...options,birefnet:{...options.birefnet,resolution:999}}},'PUT',400);
 assert.equal(readCutoutDefaults().psdMode,5);
});

test('coarse and fine flows share annotation-only reconstruction inputs and reject reused preview pixels',async()=>{
 for(const mode of [2,4,5] as const){
  let d=await fixture();d.settings.psdMode=mode;d.settings.cutoutOptions=structuredClone(DEFAULT_CUTOUT);
  d.settings.cutoutOptions[mode===4?'birefnet':'lucida'].blackPoint=.02;
  d=await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
  const job=await api(`/api/document/${d.id}/jobs`,{type:'plan',imageId:d.images[0].id},'POST',202);
  await api(`/api/jobs/${job.id}/plan`,{taskId:d.taskId,baseVersion:job.version,layers:[{name:'主体',box:[0,0,64,48]}]},'POST',409);
  d.settings.cutoutOptions[mode===4?'birefnet':'lucida'].blackPoint=.25;
  await api(`/api/document/${d.id}`,{document:d,expectedRevision:d.revision},'PUT');
  await api(`/api/jobs/${job.id}/claim`,{taskId:d.taskId});
  const calls:{model:string;options:any;input:string;boxes:any[]}[]=[];
  app.locals.cutoutWorker=async(args:string[])=>{
   const arg=(flag:string)=>args[args.indexOf(flag)+1],folder=arg('--output');
   const boxes=JSON.parse(fs.readFileSync(arg('--boxes'),'utf8'));const options=JSON.parse(fs.readFileSync(arg('--options'),'utf8'));
   calls.push({model:arg('--model'),options,input:arg('--input'),boxes});
   const layers=[];for(let i=0;i<boxes.length;i++){const file=path.join(folder,`layer-${i}.png`);fs.writeFileSync(file,await sharp(fs.readFileSync(arg('--input'))).ensureAlpha().png().toBuffer());layers.push({name:boxes[i].name,path:file,x:0,y:0,width:64,height:48,preview:true});}return {layers,warnings:[]};
  };
  const planned=await api(`/api/jobs/${job.id}/plan`,{taskId:d.taskId,baseVersion:job.version,layers:[{name:'背景',role:'background',box:[0,0,64,48]},{name:'主体',role:'foreground',box:[5,6,20,30],opinion:'保留光晕'}]});
  assert.equal(calls[0].model,mode===4?'birefnet':mode===5?'lucida':'coarse');assert.equal(calls[0].options.blackPoint,mode===2?0:.02);
  assert.equal(calls[0].input.endsWith(path.basename(d.images[0].source)),true);
  d=planned.document;assert.equal(d.images.length,1);assert.equal(d.images[0].layers[1].disposition,'rebuild');assert.equal(d.images[0].layers[0].disposition,'rebuild');assert.deepEqual(d.images[0].layers[1].cutoutBox,[5,6,20,30]);
  const layer=await api(`/api/document/${d.id}/jobs`,{type:'layer',imageId:d.images[0].id},'POST',202);
  await api(`/api/jobs/${layer.id}/cutouts`,{taskId:d.taskId,baseVersion:layer.version},'POST',409);
  await api(`/api/jobs/${layer.id}/claim`,{taskId:d.taskId});
  await api(`/api/jobs/${layer.id}/cutouts`,{taskId:'wrong-task',baseVersion:layer.version},'POST',403);
  await api(`/api/jobs/${layer.id}/cutouts`,{taskId:d.taskId,baseVersion:layer.version+1},'POST',409);
  await api(`/api/jobs/${layer.id}/cutouts`,{taskId:d.taskId,baseVersion:layer.version},'POST',409);
  assert.equal(calls.length,1,'reconstruction must not run any local cutout');
  const packet=await api(`/api/jobs/${layer.id}/packet?taskId=${d.taskId}`);
  assert.equal(packet.generationInputs.workflow,'original-and-annotations');assert.equal(packet.generationInputs.previewPixelsAllowed,false);
  assert.equal(packet.cutout.prepareTool,undefined);assert.equal(packet.localTools,undefined);
  for(const preview of d.images[0].layers){
   const plan=packet.layers.find((l:any)=>l.id===preview.id);assert.equal(plan.opinion,preview.opinion);assert.deepEqual(plan.cutoutBox,preview.cutoutBox);
   assert.equal(plan.path,undefined);assert.equal(plan.url,undefined);assert.equal(plan.previewUrl,undefined);
   assert(!JSON.stringify(packet).includes(preview.url),'no nested image or layer may leak preview assets');
  }
  const previewLayers=d.images[0].layers;
  await api(`/api/jobs/${layer.id}/apply`,{taskId:d.taskId,baseVersion:layer.version,layers:previewLayers},'POST',400);
  await api(`/api/jobs/${layer.id}/apply`,{taskId:d.taskId,baseVersion:layer.version,layers:previewLayers.map((l:any)=>({...l,preview:false}))},'POST',400);
  const {assetPath}=await import('../server/store.js');
  const copied=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');
  await sharp(fs.readFileSync(assetPath(d.id,previewLayers[0].url))).png({compressionLevel:0}).toFile(copied);
  await api(`/api/jobs/${layer.id}/apply`,{taskId:d.taskId,baseVersion:layer.version,layers:[{...previewLayers[0],url:undefined,path:copied,preview:false}]},'POST',400);
  assert.equal(load(d.id).images.length,1);assert.equal(getJob(layer.id).status,'running');
  // Synthetic final-output fixture: no model or paid generation is invoked in this test.
  const finalPath=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.png');
  await sharp({create:{width:64,height:48,channels:4,background:'#654321'}}).png().toFile(finalPath);
  const finalLayers=previewLayers.map((l:any)=>({...l,path:finalPath,preview:false,disposition:'keep'}));
  const returned=await api(`/api/jobs/${layer.id}/apply`,{taskId:d.taskId,baseVersion:layer.version,layers:finalLayers});
  assert.equal(returned.document.images.length,2);assert.equal(returned.document.images[1].parentId,d.images[0].id);
  assert.equal(getJob(layer.id).status,'completed');
  await api(`/api/jobs/${layer.id}/cutouts`,{taskId:d.taskId,baseVersion:layer.version},'POST',409);
 }
});

test('cancelling local matting signals the worker and prevents a preview commit',async()=>{
 const d=await fixture();const j=await api(`/api/document/${d.id}/jobs`,{type:'plan',imageId:d.images[0].id},'POST',202);
 await api(`/api/jobs/${j.id}/claim`,{taskId:d.taskId});
 let release!:()=>void,start!:()=>void;let signal:AbortSignal|undefined;
 const started=new Promise<void>(resolve=>start=resolve);const finish=new Promise<void>(resolve=>release=resolve);
 app.locals.cutoutWorker=async(_args:string[],s:AbortSignal)=>{signal=s;start();await finish;return {layers:[]};};
 const pending=api(`/api/jobs/${j.id}/plan`,{taskId:d.taskId,baseVersion:j.version,layers:[{name:'主体',box:[0,0,64,48]}]},'POST',409);
 await started;await api(`/api/jobs/${j.id}/cancel`,{});assert.equal(signal?.aborted,true);release();await pending;
 assert.equal(load(d.id).images[0].layers.length,0);assert.equal(getJob(j.id).status,'cancelled');
});
