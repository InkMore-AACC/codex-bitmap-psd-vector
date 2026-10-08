import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { writePsdBuffer, type Layer } from 'ag-psd';
import { createCanvas } from '@napi-rs/canvas';
import { photoshopPlanSchema, photoshopActionSchema } from '../shared/photoshop.js';
import { nativeTextInkQuad } from '../shared/native-text.js';
import sharp from 'sharp';
import { planningLayer } from '../shared/planning.js';
process.env.LAYER_CANVAS_DATA=path.resolve('test-output/native-plane-http-'+crypto.randomUUID());
const { fontPostscriptName, decomposeTextPlane, validateNativeTextPlaneEntry, verifyNativeTextPlaneGroup, renderNativeTextPlane } = await import('../server/photoshop-plane-text.js');
const { nativeProgressLayers, validateNativeStructure } = await import('../server/photoshop-native.js');
const { measureNativeTextSpan } = await import('../server/native-text-renderer.js');

const fontPath=['C:/Windows/Fonts/arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(fs.existsSync)!;
assert(fontPath,'已安装单字体测试，不下载或调用收费服务');
const font=fs.readFileSync(fontPath),fontHash=crypto.createHash('sha256').update(font).digest('hex'),postscript=fontPostscriptName(font);
function plan() {
  const recipe={version:2 as const,observation:'工程字体测试，非真实海报或视觉验收',transform:[1,.178,-.02,1,30,30] as [number,number,number,number,number,number],
    transformObservation:'工程冻结仿射平面，不读取任何源RGB字形',spans:[{text:'TEST-09',fontPath,fontHash,fontSize:18,color:'#071414',box:{x:0,y:0,width:85,height:18}}]};
  const measured=measureNativeTextSpan(recipe.spans[0]);recipe.spans[0].box.width=Math.ceil(measured.width);recipe.spans[0].box.height=Math.ceil(measured.height)+1;
  const p=nativeTextInkQuad(recipe,recipe.spans[0].box),xs=p.map(q=>q[0]),ys=p.map(q=>q[1]);
  const box={x:Math.round(Math.min(...xs)),y:Math.round(Math.min(...ys)),width:Math.round(Math.max(...xs)-Math.min(...xs)),height:Math.round(Math.max(...ys)-Math.min(...ys))};
  const d=decomposeTextPlane(recipe.transform);
  return photoshopPlanSchema.parse({canvas:{width:200,height:120},relations:[],layers:[{layerId:'ink',name:'ink',frame:{x:10,y:10,width:180,height:100},
    route:'native',content:'text',surface:'transparent',editable:'native-text',rationale:'font fixture',includes:'ink',excludes:'film and glow',compositing:'normal',elements:['TEST-09实心文字'],
    nativeTextPlane:{version:1,recipe},textTargets:[{layerName:'label',text:'TEST-09',box,appearance:{font:postscript,color:[7,20,20],rotation:d.rotation,shear:d.shear,warpStyle:'none',observation:'冻结真实字体及平面变换的测试目标'}}]}]});
}
function group(p=plan()):Layer {
  const b=p.layers[0].textTargets[0].box,r=p.layers[0].nativeTextPlane!.recipe;
  assert.equal(r.version,2);if(r.version!==2)throw Error('v2');
  const m=measureNativeTextSpan(r.spans[0]),w=Math.round(Math.abs(r.transform[0])*m.width+Math.abs(r.transform[2])*m.height),
    h=Math.round(Math.abs(r.transform[1])*m.width+Math.abs(r.transform[3])*m.height);
  return {name:'LC_ink',opacity:1,blendMode:'normal',children:[{name:'label',left:b.x,top:b.y,right:b.x+w,bottom:b.y+h,
    text:{text:'TEST-09',transform:[...r.transform],warp:{style:'none'},style:{font:{name:postscript},fontSize:18,fillColor:{r:7,g:20,b:20}}}}]};
}
test('frozen PS plane validates actual font bytes, target appearance and nonsingular decomposition',()=>{
  const p=plan();assert.doesNotThrow(()=>validateNativeTextPlaneEntry(p.layers[0]));
  const d=decomposeTextPlane([1,.178,-.02,1]);const t=d.rotation*Math.PI/180,k=Math.tan(d.shear*Math.PI/180)*d.sy;
  assert(Math.abs(Math.cos(t)*d.sx-1)<1e-12);assert(Math.abs(Math.sin(t)*d.sx-.178)<1e-12);
  assert(Math.abs(Math.cos(t)*k-Math.sin(t)*d.sy+.02)<1e-12);assert(Math.abs(Math.sin(t)*k+Math.cos(t)*d.sy-1)<1e-12);
  for(const mode of ['font','hash','colour','target','route','v1','effect']){const a=structuredClone(p),l=a.layers[0];
    if(mode==='font')l.textTargets[0].appearance!.font='Fake';if(mode==='hash')l.nativeTextPlane!.recipe.spans[0].fontHash='0'.repeat(64);
    if(mode==='colour')l.textTargets[0].appearance!.color=[255,255,255];if(mode==='target')l.textTargets[0].box.x+=10;
    if(mode==='route')l.route='generate';if(mode==='v1')(l.nativeTextPlane!.recipe as any).version=1;
    if(mode==='effect')l.textTargets[0].appearance!.requiredEffects=['outerGlow'];assert.throws(()=>validateNativeTextPlaneEntry(l),Error,mode);}
  assert.throws(()=>decomposeTextPlane([1,0,0,-1]));assert.throws(()=>decomposeTextPlane([0,0,0,0]));
  assert.throws(()=>photoshopActionSchema.parse({action:'render-native-plane-text',layerId:'ink',inputPsdPath:'x.psd',fontSize:100}));
});
test('native readiness measures frozen font geometry separately from source ink observations; source differences remain unaccepted',()=>{
  const p=plan(),g=group(p),l=g.children![0];
  // A before-prepare source observation can be taller than this exact real font.
  p.layers[0].textTargets[0].box.height+=1;
  const rows=verifyNativeTextPlaneGroup(g,p.layers[0])!;
  assert.equal(rows[0].sourceVisualAccepted,false);assert(rows[0].sourceSizeDelta[1]<-1);
  const clipped=structuredClone(g);clipped.children![0].right!-=4;
  assert.throws(()=>verifyNativeTextPlaneGroup(clipped,p.layers[0]),/冻结/);
  const stretched=structuredClone(g);stretched.children![0].bottom!+=5;
  assert.throws(()=>verifyNativeTextPlaneGroup(stretched,p.layers[0]),/冻结/);
  const displaced=structuredClone(g);displaced.children![0].left!+=2;displaced.children![0].right!+=2;
  assert.throws(()=>verifyNativeTextPlaneGroup(displaced,p.layers[0]),/冻结/);
  const wrongBaseline=structuredClone(g),t=wrongBaseline.children![0].text!;
  t.boundingBox={left:{value:0,units:'Points'},top:{value:0,units:'Points'},right:{value:100,units:'Points'},bottom:{value:20,units:'Points'}};
  t.transform![4]+=100;
  assert.throws(()=>verifyNativeTextPlaneGroup(wrongBaseline,p.layers[0]),/冻结/);
  assert.equal(l.text!.style!.fontSize,18);assert.equal(p.layers[0].nativeTextPlane!.recipe.spans[0].fontSize,18);
});
test('actual PSD metadata gate rejects hidden/bitmap/duplicate text and changed font/plane/placement before readiness and final delivery',()=>{
  const p=plan(),g=group(p);verifyNativeTextPlaneGroup(g,p.layers[0]);
  for(const mode of ['font','size','colour','matrix','move','hidden','extra','bitmap','effect','run','scale']){
    const a=structuredClone(g),l=a.children![0];if(mode==='font')l.text!.style!.font!.name='Fake';if(mode==='size')l.text!.style!.fontSize=30;
    if(mode==='colour')l.text!.style!.fillColor={r:255,g:255,b:255};if(mode==='matrix')l.text!.transform![1]=0;
    if(mode==='move')l.left!+=10;if(mode==='hidden')l.hidden=true;if(mode==='extra')a.children!.push(structuredClone(l));
    if(mode==='bitmap')delete l.text;if(mode==='effect')l.effects={outerGlow:{enabled:true,color:{r:255,g:255,b:255},size:{value:2,units:'Pixels'}}};
    if(mode==='run')l.text!.styleRuns=[{length:7,style:{font:{name:'Fake'}}}];if(mode==='scale')l.text!.style!.horizontalScale=1.1;
    assert.throws(()=>verifyNativeTextPlaneGroup(a,p.layers[0]),/冻结/,mode);
    const bytes=writePsdBuffer({...p.canvas!,children:[a]});
    assert.throws(()=>nativeProgressLayers(bytes,p,p.canvas!),Error,mode);
    assert.throws(()=>validateNativeStructure(bytes,p,p.canvas!),Error,mode);
  }
});
test('native production action preserves input and refuses populated, foreign and over-budget targets before execution; simulated execution is not Photoshop acceptance',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'lc-text-plane-')),p=plan(),input=path.join(folder,'base.psd');
  const bytes=writePsdBuffer({...p.canvas!,children:[{name:'LC_ink',children:[]}]});fs.writeFileSync(input,bytes);let calls=0;
  const stub={executeScript:async(_app:string,script:string,_scope:string,outputs:string[])=>{calls++;const code=fs.readFileSync(script,'utf8');assert(code.includes("executeAction(ci('Trnf')"));
    assert(code.includes('text-plane-progress-'));assert(code.indexOf("phase('setting-text-kind',i)")<code.indexOf('l.kind=LayerKind.TEXT'));
    assert(code.includes("phase('saving-native-output',-1)"));
    const g=group(p),b=p.layers[0].textTargets[0].box,c=createCanvas(b.width,b.height);c.getContext('2d').fillRect(0,0,b.width,b.height);g.children![0].canvas=c as any;
    fs.writeFileSync(outputs[0],writePsdBuffer({...p.canvas!,children:[g]}));fs.writeFileSync(outputs[1],JSON.stringify({nativePhotoshopVersion:'SIMULATED-NOT-PHOTOSHOP',before:1,after:1}));}};
  try{const result=await renderNativeTextPlane(stub as any,folder,input,p,'ink');assert.notEqual(result.artifactPath,input);assert.deepEqual(fs.readFileSync(input),bytes);
    assert.equal(result.facts.nativePhotoshopVersion,'SIMULATED-NOT-PHOTOSHOP');
    await assert.rejects(()=>renderNativeTextPlane(stub as any,folder,result.artifactPath,p,'ink'),/已有内容/);
    fs.mkdirSync(path.join(folder,'other'));
    await assert.rejects(()=>renderNativeTextPlane(stub as any,path.join(folder,'other'),input,p,'ink'),/本次交接目录/);
    const big={...p,canvas:{width:2000,height:1000}},bigPath=path.join(folder,'big.psd');fs.writeFileSync(bigPath,writePsdBuffer({...big.canvas,children:[{name:'LC_ink',children:[]}]}));
    await assert.rejects(()=>renderNativeTextPlane(stub as any,folder,bigPath,big,'ink'),/150万/);assert.equal(calls,1);
  }finally{const actual=fs.realpathSync(folder),temp=fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(actual),temp);assert(path.basename(actual).startsWith('lc-text-plane-'));fs.rmSync(actual,{recursive:true,force:true});}
});

const {app,TOKEN,BRIDGE_TOKEN,adobe}=await import('../server/index.js');
const store=await import('../server/store.js');const {photoshopState}=await import('../server/photoshop-rebuild.js');
app.locals.codexSender=async()=>({delivered:true});
const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
after(()=>{server.closeAllConnections();server.close();});
async function post(route:string,body:unknown,status=200){const r=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}`+route,
  {method:'POST',headers:{'Content-Type':'application/json','X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN},body:JSON.stringify(body)});
  const value:any=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
test('public plane action freezes before native execution, binds actual job and reuses only intact receipt; simulated Adobe is not actual PS proof',async()=>{
  const p=plan(),d=store.getByTask('native_plane_http_'+crypto.randomUUID());
  const url=store.writeAsset(d.id,await sharp({create:{width:200,height:120,channels:3,background:'#123456'}}).png().toBuffer(),'.png');
  d.images.push({id:'source',name:'synthetic engineering fixture',width:200,height:120,x:0,y:0,source:url,url,status:'preview',version:1,annotations:[],opinion:'',
    layers:p.layers.map(l=>planningLayer(l.layerId,l.name,l.frame,'foreground',''))});store.save(d);
  const j=await post(`/api/document/${d.id}/jobs`,{imageId:'source',type:'photoshop'},202);await post(`/api/jobs/${j.id}/claim`,{taskId:d.taskId});
  const route=`/api/jobs/${j.id}/ps-rebuild`,send=(body:unknown,status=200)=>post(route,{taskId:d.taskId,...body as any},status);
  await send({action:'plan',plan:p});const folder=path.join(store.dir(d.id),'jobs',j.id),input=path.join(folder,'base.psd');
  fs.writeFileSync(input,writePsdBuffer({...p.canvas!,children:[{name:'LC_ink',children:[]}]}));
  const original=adobe.executeScript;let calls=0;
  adobe.executeScript=(async(_app:string,_script:string,_scope:string,outputs:string[])=>{calls++;const g=group(p),b=p.layers[0].textTargets[0].box,c=createCanvas(b.width,b.height);
    c.getContext('2d').fillRect(0,0,b.width,b.height);g.children![0].canvas=c as any;fs.writeFileSync(outputs[0],writePsdBuffer({...p.canvas!,children:[g]}));
    fs.writeFileSync(outputs[1],JSON.stringify({nativePhotoshopVersion:'SIMULATED-NOT-PHOTOSHOP',before:1,after:1}));}) as any;
  try{await send({action:'render-native-plane-text',layerId:'ink',inputPsdPath:input,jobId:'foreign'},400);assert.equal(calls,0);
    const r=await send({action:'render-native-plane-text',layerId:'ink',inputPsdPath:input});
    assert.equal(photoshopState(store.getJob(j.id)).nativeTextPlanes!.ink.artifactPath,r.artifactPath);
    assert.deepEqual(photoshopState(store.getJob(j.id)).reviews,{});assert.equal(photoshopState(store.getJob(j.id)).inspection,undefined);
    assert.equal((await send({action:'render-native-plane-text',layerId:'ink',inputPsdPath:input})).reused,true);assert.equal(calls,1);
    const changed=structuredClone(p);changed.layers[0].excludes='different after native prepare';assert.match((await send({action:'plan',plan:changed},400)).error,/首次prepare/);
    await send({action:'fit-text',layerId:'ink',layerName:'label',artifactPath:r.artifactPath,targetBox:p.layers[0].textTargets[0].box},400);assert.equal(calls,1);
    fs.appendFileSync(r.artifactPath,Buffer.from('changed'));assert.match((await send({action:'render-native-plane-text',layerId:'ink',inputPsdPath:input},400)).error,/变化/);assert.equal(calls,1);
  }finally{adobe.executeScript=original;}
});
