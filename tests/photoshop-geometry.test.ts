import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { readPsd, writePsdBuffer } from 'ag-psd';
import { photoshopPlanSchema, photoshopGroupName, photoshopActionSchema } from '../shared/photoshop.js';
import { validateNativeGeometryRecipe } from '../shared/native-geometry.js';
import { planningLayer } from '../shared/planning.js';
process.env.LAYER_CANVAS_DATA=path.resolve('test-output/native-geometry-'+crypto.randomUUID());
const { prepareNativeGeometryPsd, verifyNativeGeometryGroup, renderNativeGeometry }=await import('../server/photoshop-geometry.js');
const { nativeProgressLayers }=await import('../server/photoshop-native.js');
const { photoshopState, validatePhotoshopPlan }=await import('../server/photoshop-rebuild.js');
const { app,TOKEN,BRIDGE_TOKEN,adobe }=await import('../server/index.js');
const store=await import('../server/store.js');
const frame={x:10,y:10,width:80,height:80};
function plan(){const p=photoshopPlanSchema.parse({canvas:{width:100,height:100},relations:[],layers:[{
  layerId:'marker',name:'synthetic skewed ring and core',frame,route:'native',content:'shape',surface:'transparent',editable:'native-shape',
  rationale:'engineering primitive fixture, not a source reconstruction',includes:'ring and core',excludes:'text film and lights',
  compositing:'normal alpha',elements:['ring and core'],opticalPart:{version:2,assemblyId:'panel',kind:'opaque-structure'},
  anchors:[{name:'a',point:[20,25],observation:'synthetic first independent corner'},
    {name:'b',point:[70,20],observation:'synthetic second independent corner'},
    {name:'c',point:[65,70],observation:'synthetic third independent corner'}],
  alphaChecks:[{name:'exterior',kind:'clear',box:[11,11,2,2],maxAlpha:8,minPassingFraction:1},
    {name:'solid core',kind:'occupied',box:[37,42,3,3],minAlpha:240,minPassingFraction:1}],
  nativeGeometry:{version:1,observation:'Synthetic manually specified quads, no source pixels or masks.',shapes:[
    {name:'outer ring',color:[6,16,19],outer:[[20,25],[70,20],[65,70],[15,75]],hole:[[25,30],[60,27],[56,60],[23,65]]},
    {name:'core',color:[6,16,19],outer:[[33,38],[50,36],[48,53],[31,56]]}]}}]});
  const film=structuredClone(p.layers[0]);delete film.nativeGeometry;
  Object.assign(film,{layerId:'film',name:'film',route:'generate',content:'bitmap',editable:'pixels',includes:'film only',elements:['film only'],
    opticalPart:{version:2,assemblyId:'panel',kind:'thin-film'},alphaChecks:[
      {name:'exterior',kind:'clear',box:[11,11,2,2],maxAlpha:8,minPassingFraction:1},
      {name:'film',kind:'transmissive',box:[28,40,3,3],minAlpha:20,maxAlpha:220,minBackgroundResponse:35,minPassingFraction:1}]});
  p.layers.unshift(film);p.relations.push({id:'panel-registration',kind:'alignment',layerIds:['film','marker'],observation:'same source plane for separated film and opaque geometry'});
  return p;
}
const meta=(bytes:Buffer)=>readPsd(bytes,{skipLayerImageData:true,skipCompositeImageData:true,skipThumbnail:true});
test('opaque native quads preserve transparent holes, actual skew coordinates and editable metadata',()=>{
  const p=plan(),bytes=prepareNativeGeometryPsd(p,'marker'),group=meta(bytes).children![0];
  verifyNativeGeometryGroup(group,p.layers[1]);
  assert.deepEqual(nativeProgressLayers(bytes,p,p.canvas!).map(l=>l.layerId),['marker']);
  const raster=readPsd(bytes,{useImageData:true}),ring=raster.children![0].children![0].imageData!;
  const a=(x:number,y:number)=>ring.data[((y-frame.y)*ring.width+x-frame.x)*4+3];
  assert.equal(a(12,12),0);assert.equal(a(28,40),0);assert.equal(a(20,40),255);
  assert.equal(group.children![0].vectorMask!.paths[1].operation,'subtract');
  assert.equal(group.children![1].vectorFill!.type,'color');
});
test('native geometry rejects misplaced/compressed paths, substituted pixels, hole changes and decorations',()=>{
  const p=plan(),original=meta(prepareNativeGeometryPsd(p,'marker')).children![0];
  for(const mode of ['path','hole','color','opacity','bitmap','curve','order','effects','extra','hidden']){
    const g=structuredClone(original),l=g.children![0];
    if(mode==='path')l.vectorMask!.paths[0].knots[2].points[3]-=3;
    if(mode==='hole')l.vectorMask!.paths[1].operation='combine';
    if(mode==='color')(l.vectorFill as any).color.r=50;
    if(mode==='opacity')l.opacity=.9;
    if(mode==='bitmap')delete l.vectorMask;
    if(mode==='curve')l.vectorMask!.paths[0].knots[0].points[0]+=1;
    if(mode==='order')g.children!.reverse();
    if(mode==='effects')l.effects={disabled:true};
    if(mode==='extra')g.children!.push({name:'hidden pixels',hidden:true});
    if(mode==='hidden')l.hidden=true;
    assert.throws(()=>verifyNativeGeometryGroup(g,p.layers[1]),/冻结配方/,mode);
  }
});
test('recipe remains narrow: reject self intersection, escaping hole, clipping, source fields and budget violation',()=>{
  const p=plan(),r=p.layers[1].nativeGeometry!;
  const crossed=structuredClone(r);[crossed.shapes[0].outer[1],crossed.shapes[0].outer[2]]=[crossed.shapes[0].outer[2],crossed.shapes[0].outer[1]];
  assert.throws(()=>validateNativeGeometryRecipe(crossed,frame),/凸四边形/);
  const escaped=structuredClone(r);escaped.shapes[0].hole![0]=[10,10];assert.throws(()=>validateNativeGeometryRecipe(escaped,frame),/透明孔|凸四边形/);
  const clipped=structuredClone(r);clipped.shapes[0].outer[0]=[0,25];assert.throws(()=>validateNativeGeometryRecipe(clipped,frame),/画幅/);
  assert.throws(()=>validateNativeGeometryRecipe({...r,sourcePath:'source.png'} as any,frame));
  assert.throws(()=>prepareNativeGeometryPsd({...p,canvas:{width:2000,height:1000}},'marker'),/150万/);
  assert.throws(()=>photoshopActionSchema.parse({action:'render-native-geometry',layerId:'marker',inputPsdPath:'a.psd',scaleY:.9}));
  for(const mode of ['text','generate','film','fallback']){
    const changed=structuredClone(p);
    if(mode==='text')changed.layers[1].content='text';
    if(mode==='generate')changed.layers[1].route='generate';
    if(mode==='film')changed.layers[1].opticalPart!.kind='thin-film';
    if(mode==='fallback')changed.layers[1].nativeFallback={reason:'pixels',attempts:[]};
    assert.throws(()=>prepareNativeGeometryPsd(changed,'marker'));
  }
});
function emptyBase(p:ReturnType<typeof plan>){return writePsdBuffer({...p.canvas!,children:[{name:photoshopGroupName('marker'),children:[]}]});}
// Tests simulate file execution; they do not prove real Photoshop output or visual source fidelity.
async function simulatedExecute(_app:string,script:string,_scope:string,outputs:string[]){
  const text=fs.readFileSync(script,'utf8'),src=text.match(/src=app\.open\(new File\(("(?:\\.|[^"\\])*")\)\)/)!,work=text.match(/d=app\.open\(new File\(("(?:\\.|[^"\\])*")\)\)/)!;
  const s=readPsd(fs.readFileSync(JSON.parse(src[1])),{useImageData:true}),d=readPsd(fs.readFileSync(JSON.parse(work[1])),{useImageData:true});
  d.children![0].children=s.children![0].children;d.children![0].blendMode='normal';
  outputs.forEach(p=>assert(!fs.existsSync(p)));fs.writeFileSync(outputs[0],writePsdBuffer(d));
  fs.writeFileSync(outputs[1],JSON.stringify({nativePhotoshopVersion:'SIMULATED-NOT-PHOTOSHOP',before:1,after:1}));
}
test('renderer rejects foreign and nonempty inputs before execution and preserves the original copy',async()=>{
  const folder=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID());fs.mkdirSync(folder,{recursive:true});
  const p=plan(),input=path.join(folder,'base.psd'),bytes=emptyBase(p);fs.writeFileSync(input,bytes);let calls=0;
  const stub={executeScript:async(...args:Parameters<typeof simulatedExecute>)=>{calls++;await simulatedExecute(...args);}};
  const r=await renderNativeGeometry(stub as any,folder,input,p,'marker');assert.equal(calls,1);assert.deepEqual(fs.readFileSync(input),bytes);
  assert.equal(r.sourceVisualAccepted,false);verifyNativeGeometryGroup(meta(fs.readFileSync(r.artifactPath)).children![0],p.layers[1]);
  await assert.rejects(()=>renderNativeGeometry(stub as any,folder,r.artifactPath,p,'marker'),/已有内容/);
  const foreign=path.join(process.env.LAYER_CANVAS_DATA!,crypto.randomUUID()+'.psd');fs.writeFileSync(foreign,bytes);
  await assert.rejects(()=>renderNativeGeometry(stub as any,folder,foreign,p,'marker'),/本次交接目录/);assert.equal(calls,1);
});
app.locals.codexSender=async()=>({delivered:true});const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
after(()=>{server.closeAllConnections();server.close();});const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
async function post(route:string,body:unknown,status=200){const r=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json','X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN},body:JSON.stringify(body)});const value:any=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
test('public native geometry receipt freezes full plan, supports idempotent reuse and scoped resume without acceptance',async()=>{
  const d=store.getByTask('geometry_http_'+crypto.randomUUID()),p=plan(),url=store.writeAsset(d.id,await sharp({create:{width:100,height:100,channels:3,background:'#123456'}}).png().toBuffer(),'.png');
  d.images.push({id:'source',name:'synthetic fixture',width:100,height:100,x:0,y:0,source:url,url,status:'preview',version:1,annotations:[],opinion:'',layers:p.layers.map(l=>planningLayer(l.layerId,l.name,l.frame,'foreground',''))});store.save(d);
  const j=await post(`/api/document/${d.id}/jobs`,{imageId:'source',type:'photoshop'},202);await post(`/api/jobs/${j.id}/claim`,{taskId:d.taskId});
  const send=(body:object,status=200)=>post(`/api/jobs/${j.id}/ps-rebuild`,{taskId:d.taskId,...body},status);
  validatePhotoshopPlan(store.getJob(j.id),p);await send({action:'plan',plan:p});
  const folder=path.join(store.dir(d.id),'jobs',j.id),input=path.join(folder,'base.psd');fs.writeFileSync(input,emptyBase(p));
  const original=adobe.executeScript;let calls=0;adobe.executeScript=(async(...args:Parameters<typeof simulatedExecute>)=>{calls++;return simulatedExecute(...args);}) as any;
  try{
    const r=await send({action:'render-native-geometry',layerId:'marker',inputPsdPath:input});assert.equal(r.sourceVisualAccepted,false);
    assert.equal((await send({action:'render-native-geometry',layerId:'marker',inputPsdPath:r.artifactPath})).reused,true);assert.equal(calls,1);
    assert.equal(photoshopState(store.getJob(j.id)).inspection,undefined);assert.deepEqual(photoshopState(store.getJob(j.id)).reviews,{});
    const changed=structuredClone(p);changed.layers[1].nativeGeometry!.shapes[0].color=[5,10,15];assert.match((await send({action:'plan',plan:changed},400)).error,/首次prepare/);
    await post(`/api/jobs/${j.id}/fail`,{taskId:d.taskId,message:'engineering restart fixture'});
    const stateBefore=fs.readFileSync(path.join(folder,'photoshop-rebuild.json'));
    const resumed=await post(`/api/jobs/${j.id}/resume`,{taskId:d.taskId,reason:'same job native geometry preparation only',nativeArtifactPath:r.artifactPath});
    assert.equal(resumed.checkpoints.psNativePrepared,1);assert.equal(resumed.checkpoints.psInspection,false);
    assert.deepEqual(fs.readFileSync(path.join(folder,'photoshop-rebuild.json')),stateBefore);assert.equal(store.load(d.id).images.length,1);
  }finally{adobe.executeScript=original;}
});
