import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { renderNativeGeometryRaster } from '../server/native-geometry-renderer.js';
import { type NativeGeometryRecipe } from '../shared/native-geometry.js';
import { generationLayoutSchema } from '../shared/generation.js';
import { planningLayer } from '../shared/planning.js';
const frame={x:20,y:20,width:80,height:80};
const recipe:NativeGeometryRecipe={version:1,observation:'Manually declared synthetic oblique quads; no image pixels or source outline tracing.',shapes:[
 {name:'ring',color:[8,12,16],outer:[[30,35],[80,30],[75,90],[25,95]],hole:[[37,40],[72,37],[67,83],[32,87]]},
 {name:'core',color:[5,7,9],outer:[[45,55],[63,53],[62,74],[44,76]]}]};
test('native geometry raster retains the observed skew, solid core and clear hole at full and uniform half carriers',async()=>{
  for(const size of [80,40]){
    const r=renderNativeGeometryRaster(recipe,frame,{width:size,height:size}),{data,info}=await sharp(r.bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true}),s=size/80;
    const pixel=(x:number,y:number)=>Array.from(data.subarray((Math.floor((y-20)*s)*info.width+Math.floor((x-20)*s))*4,(Math.floor((y-20)*s)*info.width+Math.floor((x-20)*s))*4+4));
    assert.equal(pixel(22,22)[3],0);assert.equal(pixel(40,55)[3],0);assert.equal(pixel(50,60)[3],255);
    assert.deepEqual(pixel(50,60).slice(0,3),[5,7,9]);
    assert.equal(r.proof.algorithm,'native-opaque-quadrilaterals-v1');assert.equal(r.proof.sourceVisualAccepted,false);
    assert.equal(r.proof.outputHash,crypto.createHash('sha256').update(r.bytes).digest('hex'));
  }
  assert.throws(()=>renderNativeGeometryRaster(recipe,frame,{width:1500,height:1001}),/150万/);
  assert.throws(()=>renderNativeGeometryRaster(recipe,frame,{width:80,height:60}),/统一比例/);
});
test('native geometry raster and PSD ordering agree when simple shapes overlap',async()=>{
  const r=structuredClone(recipe);r.shapes[0].hole=undefined;r.shapes[0].color=[100,150,200];
  const {data}=await sharp(renderNativeGeometryRaster(r,frame,{width:80,height:80}).bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const i=((60-20)*80+50-20)*4;assert.deepEqual(Array.from(data.subarray(i,i+4)),[100,150,200,255]);
});
process.env.LAYER_CANVAS_DATA=path.resolve('test-output/native-geometry-raster-'+crypto.randomUUID());
const {app,TOKEN,BRIDGE_TOKEN}=await import('../server/index.js'),store=await import('../server/store.js');
const {generationState,registeredGeneration}=await import('../server/generation.js');
const {validateLayout}=await import('../server/generation-workflow.js');
app.locals.codexSender=async()=>({delivered:true});const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
after(()=>{server.closeAllConnections();server.close();});const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
async function post(route:string,body:unknown,status=200){const r=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json','X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN},body:JSON.stringify(body)});const value:any=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
async function fixture(filmRecipe?:NativeGeometryRecipe){
  const d=store.getByTask('geometry_raster_'+crypto.randomUUID()),url=store.writeAsset(d.id,await sharp({create:{width:120,height:120,channels:3,background:'#456789'}}).png().toBuffer(),'.png');
  d.images.push({id:'source',name:'synthetic engineering fixture',width:120,height:120,x:0,y:0,source:url,url,status:'preview',version:1,annotations:[],opinion:'',layers:['film','marker'].map(id=>planningLayer(id,id,frame,'foreground',''))});store.save(d);
  const created=await post(`/api/document/${d.id}/jobs`,{imageId:'source',type:'layer'},202);await post(`/api/jobs/${created.id}/claim`,{taskId:d.taskId});
  const j=store.getJob(created.id),anchors=[{name:'a',point:[30,35],observation:'synthetic first corner'},{name:'b',point:[80,30],observation:'synthetic second corner'},{name:'c',point:[75,90],observation:'synthetic third corner'}];
  const layout=generationLayoutSchema.parse({layers:['film','marker'].map((id,i)=>({sourceLayerIds:[id],elements:[id],excludes:'environment and other owned part',anchors,
    opticalPart:{version:2,assemblyId:'panel',kind:i?'opaque-structure':'thin-film'},
    alphaChecks:[{name:'exterior',kind:'clear',box:[22,22,2,2],maxAlpha:8,minPassingFraction:1},i?
      {name:'core',kind:'occupied',box:[48,58,4,4],minAlpha:240,minPassingFraction:1}:
      {name:'film',kind:'transmissive',box:[48,58,4,4],minAlpha:24,maxAlpha:224,minBackgroundResponse:31,minPassingFraction:1}],
    ...(i?{nativeGeometry:recipe}:filmRecipe?{nativeGeometry:filmRecipe}:{})})),relations:[{id:'same-plane',kind:'alignment',layerIds:['film','marker'],observation:'synthetic same plane before rendering'}]});
  if(filmRecipe?.shapes[0].cutouts)for(const c of filmRecipe.shapes[0].cutouts)layout.layers[0].alphaChecks!.push({name:'declared round window '+c.name,kind:'clear',box:[c.center[0]-1,c.center[1]-1,2,2],maxAlpha:8,minPassingFraction:1});
  if(filmRecipe?.version===3)layout.layers[0].alphaChecks!.find(c=>c.kind==='transmissive')!.box=[35,55,2,2];
  const send=(body:object,status=200)=>post(`/api/jobs/${j.id}/generation`,{taskId:j.taskId,...body},status);await send({action:'layout',layout});
  return {j,d,layout,send};
}
test('public ordinary native geometry renders and records genuine provenance; external registration, relocation and late changes are refused',async()=>{
  const {j,d,layout,send}=await fixture();validateLayout(j,layout);
  const q=await send({action:'prepare',purpose:'source-free native geometry engineering test',sourceLayerIds:['marker'],elements:['marker'],referenceObservation:'synthetic marker plan observed before prepare'});
  assert.equal(q.role,'native-geometry');assert.match(q.prompt,/native-geometry-renderer/);assert.match(q.instruction,/render-native-geometry/);
  const changed=structuredClone(layout);changed.layers[1].nativeGeometry!.shapes[0].color=[0,0,0];assert.match((await send({action:'layout',layout:changed},400)).error,/首次prepare/);
  assert.match((await send({action:'prepare',purpose:'source-free native geometry engineering test',sourceLayerIds:['marker'],elements:['marker'],referenceObservation:'different rendering options not authorized',referenceScale:2},400)).error,/参考扩展/);
  assert.match((await send({action:'register',requestId:q.id,path:q.referencePaths[0],prompt:q.prompt,referencePaths:q.referencePaths},400)).error,/后台render-native-geometry/);
  const r=await send({action:'render-native-geometry',requestId:q.id});assert.equal(r.kind,'native-geometry');assert.equal(r.receipt.tool,'native-geometry-renderer');assert.equal(r.alphaDiagnostics.passed,true);
  assert.equal((await send({action:'render-native-geometry',requestId:q.id})).reused,true);assert.equal(generationState(j).outputs.length,1);
  assert.match((await send({action:'auto-align',generationId:r.id},400)).error,/冻结位置/);
  const c=await send({action:'composite',generationIds:[r.id]});assert.equal(c.complete,false);assert.equal(store.load(d.id).images.length,1);
  const film=await send({action:'prepare',purpose:'source-free native geometry engineering test',sourceLayerIds:['film'],elements:['film'],referenceObservation:'isolated counterpart engineering fixture'});
  assert.match((await send({action:'register',requestId:film.id,path:r.originalPath,prompt:film.prompt,referencePaths:film.referencePaths},400)).error,/原生|角色|身份|native/);
});
const filmRecipe:NativeGeometryRecipe={version:2,observation:'Synthetic frozen flat PET tint and alpha gradient, not a real poster or measured optical transmission.',shapes:[
  {name:'continuous-film',color:[90,145,170],outer:[[25,25],[95,25],[95,95],[25,95]],gradient:{angle:0,stops:[{position:0,alpha:54},{position:1,alpha:96}]}}]};
const clippedFilmRecipe:NativeGeometryRecipe={...structuredClone(filmRecipe),version:3};
clippedFilmRecipe.shapes[0].outer=[[25,25],[100,25],[100,70],[75,100],[25,95]];
clippedFilmRecipe.shapes[0].cutouts=[{name:'left observed window',center:[50,55],radiusX:6,radiusY:8,angle:0},{name:'right observed window',center:[77,52],radiusX:5,radiusY:6,angle:10}];
test('explicit clipped polygon film keeps clipped corner, two clear windows and true transmission at full/half whole carriers',async()=>{
  for(const size of [80,40]){
    const r=renderNativeGeometryRaster(clippedFilmRecipe,frame,{width:size,height:size}),{data,info}=await sharp(r.bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const alpha=(x:number,y:number)=>data[(Math.floor((y-20)*size/80)*info.width+Math.floor((x-20)*size/80))*4+3];
    assert.equal(alpha(22,22),0);assert.equal(alpha(95,95),0);assert.equal(alpha(50,55),0);assert.equal(alpha(77,52),0);
    assert.ok(alpha(35,55)>=54&&alpha(35,55)<=96);
    assert.equal(r.proof.algorithm,'native-tinted-film-convex-polygon-v4');assert.equal(r.proof.sourceVisualAccepted,false);
  }
  for(const version of [1,2] as const){const old=structuredClone(clippedFilmRecipe);old.version=version;assert.throws(()=>renderNativeGeometryRaster(old,frame,{width:80,height:80}),/v1|四角/);}
  const concave=structuredClone(clippedFilmRecipe);concave.shapes[0].outer[2]=[60,50];assert.throws(()=>renderNativeGeometryRaster(concave,frame,{width:80,height:80}),/凸|内含/);
  const escaping=structuredClone(clippedFilmRecipe);escaping.shapes[0].cutouts![0].center=[95,90];assert.throws(()=>renderNativeGeometryRaster(escaping,frame,{width:80,height:80}),/完整|内含/);
});

test('clipped polygon public rendering freezes new recipe, refuses source aliases and preserves exact provenance/geometry',async()=>{
  const {j,layout,send}=await fixture(clippedFilmRecipe);
  const q=await send({action:'prepare',purpose:'Synthetic clipped polygon engineering validation only',sourceLayerIds:['film'],elements:['film'],referenceObservation:'Manually declared five-corner fixture, no source tracing or poster acceptance'});
  assert.match(q.prompt,/凸多边形/);
  assert.match((await send({action:'register',requestId:q.id,path:q.referencePaths[0],prompt:q.prompt,referencePaths:q.referencePaths},400)).error,/后台render-native-geometry/);
  const r=await send({action:'render-native-geometry',requestId:q.id}),again=await send({action:'render-native-geometry',requestId:q.id});
  assert.equal(r.receipt.tool,'native-geometry-renderer');assert.equal(again.hash,r.hash);assert.equal(again.reused,true);assert.deepEqual(r.frame,frame);assert.equal(r.alphaDiagnostics.passed,true);
  const changed=structuredClone(layout);changed.layers[0].nativeGeometry!.shapes[0].outer[2]=[99,70];
  assert.match((await send({action:'layout',layout:changed},400)).error,/首次prepare/);
  assert.match((await send({action:'auto-align',generationId:r.id},400)).error,/冻结位置/);
  const file=path.join(store.dir(j.documentId),'jobs',j.id,'generation/registry.json'),saved=fs.readFileSync(file),state=JSON.parse(saved.toString());
  state.layout.layers[0].nativeGeometry.shapes[0].outer[2]=[99,70];fs.writeFileSync(file,JSON.stringify(state));
  assert.throws(()=>registeredGeneration(j,r.id,['film'],frame),/身份|冻结|计划/);fs.writeFileSync(file,saved);
});

test('continuous film has nonempty semi-transparent interior, empty exterior and real black/white response at two uniform carriers',async()=>{
  for(const size of [80,40]) {
    const r=renderNativeGeometryRaster(filmRecipe,frame,{width:size,height:size});
    const {data,info}=await sharp(r.bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const pixel=(x:number,y:number)=>data[(Math.floor((y-20)*size/80)*info.width+Math.floor((x-20)*size/80))*4+3];
    assert.equal(pixel(22,22),0);assert.ok(pixel(35,55)>54 && pixel(35,55)<96);assert.ok(pixel(80,55)>pixel(35,55));
    const sample:number[][]=[];
    for(const background of ['#000000','#ffffff']) {
      const image=await sharp({create:{width:size,height:size,channels:4,background}}).composite([{input:r.bytes}]).raw().toBuffer();
      const offset=(Math.floor(35*size/80)*size+Math.floor(30*size/80))*4;sample.push(Array.from(image.subarray(offset,offset+3)));
    }
    const a=pixel(50,55);assert.ok(sample[1].every((v,k)=>Math.abs(v-sample[0][k]-(255-a))<=2));
    assert.equal(r.proof.algorithm,'native-tinted-film-quadrilateral-v2');assert.equal(r.proof.sourceVisualAccepted,false);
  }
});
test('public frozen film reuses exact output and cannot change recipe, provenance or production placement',async()=>{
  const {j,layout,send}=await fixture(filmRecipe);
  const q=await send({action:'prepare',purpose:'synthetic controlled film test, no real generation',sourceLayerIds:['film'],elements:['film'],referenceObservation:'frozen source-free continuous tint fixture before rendering'});
  assert.match(q.prompt,/alpha渐变/);
  assert.match((await send({action:'register',requestId:q.id,path:q.referencePaths[0],prompt:q.prompt,referencePaths:q.referencePaths},400)).error,/后台render-native-geometry/);
  const r=await send({action:'render-native-geometry',requestId:q.id});assert.equal(r.receipt.tool,'native-geometry-renderer');assert.equal(r.alphaDiagnostics.passed,true);
  const reused=await send({action:'render-native-geometry',requestId:q.id});assert.equal(reused.reused,true);assert.equal(reused.hash,r.hash);
  const changed=structuredClone(layout);changed.layers[0].nativeGeometry!.shapes[0].gradient!.stops[0].alpha=100;
  assert.match((await send({action:'layout',layout:changed},400)).error,/首次prepare/);
  for(const mutate of [(l:any)=>l.opticalPart.kind='opaque-structure',(l:any)=>l.alphaChecks=l.alphaChecks.filter((c:any)=>c.kind!=='transmissive'),(l:any)=>l.content='light-effect']) {
    const wrong=structuredClone(layout);mutate(wrong.layers[0]);assert.throws(()=>validateLayout(j,wrong),/原生|光效|光学|screen|实体|薄膜/);
  }
  assert.match((await send({action:'auto-align',generationId:r.id},400)).error,/冻结位置/);
  const composite=await send({action:'composite',generationIds:[r.id]});assert.equal(composite.complete,false);
  const file=path.join(store.dir(j.documentId),'jobs',j.id,'generation/registry.json'),saved=fs.readFileSync(file),state=JSON.parse(saved.toString());
  state.layout.layers[0].nativeGeometry.shapes[0].gradient.stops[0].alpha=130;fs.writeFileSync(file,JSON.stringify(state));
  assert.throws(()=>registeredGeneration(j,r.id,['film'],frame),/身份|冻结|计划/);fs.writeFileSync(file,saved);
});
test('film recipes cannot enter opaque v1 or PS solid-shape rendering, or accept degenerate gradient stops',async()=>{
  const bad=structuredClone(filmRecipe);bad.version=1;assert.throws(()=>renderNativeGeometryRaster(bad,frame,{width:80,height:80}),/v1/);
  const unordered=structuredClone(filmRecipe);unordered.shapes[0].gradient!.stops[1].position=0;assert.throws(()=>renderNativeGeometryRaster(unordered,frame,{width:80,height:80}),/端点/);
  const {validateNativeGeometryEntry}=await import('../server/photoshop-geometry.js');
  assert.throws(()=>validateNativeGeometryEntry({nativeGeometry:filmRecipe} as any),/PS实体几何仅支持配方v1/);
});
test('ordinary frozen ellipse windows stay empty while the continuous film retains transmission, with genuine proof and unchanged reuse',async()=>{
  const r=structuredClone(filmRecipe);r.shapes[0].cutouts=[{name:'observed window',center:[70,70],radiusX:7,radiusY:8,angle:20}];
  for(const size of [80,40]){
    const out=renderNativeGeometryRaster(r,frame,{width:size,height:size}),{data,info}=await sharp(out.bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const alpha=(x:number,y:number)=>data[(Math.floor((y-20)*size/80)*info.width+Math.floor((x-20)*size/80))*4+3];
    assert.equal(alpha(70,70),0);assert.ok(alpha(45,55)>20 && alpha(45,55)<220);assert.equal(out.proof.algorithm,'native-tinted-film-cutouts-v3');
  }
  const {j,send}=await fixture(r),q=await send({action:'prepare',purpose:'synthetic transparent round window integration',sourceLayerIds:['film'],elements:['film'],referenceObservation:'synthetic ellipse primitive frozen before any render'});
  const actual=await send({action:'render-native-geometry',requestId:q.id});assert.equal(actual.alphaDiagnostics.passed,true);assert.equal(actual.receipt.tool,'native-geometry-renderer');
  const proof=JSON.parse(fs.readFileSync(actual.nativeGeometryProof.path,'utf8'));assert.equal(proof.algorithm,'native-tinted-film-cutouts-v3');
  assert.equal((await send({action:'render-native-geometry',requestId:q.id})).hash,actual.hash);
  assert.doesNotThrow(()=>registeredGeneration(j,actual.id,['film'],frame));
});
test('ordinary proof binding rejects source/recipe/role/placement substitution independently of raster dimensions',async()=>{
  const {j,send}=await fixture(),q=await send({action:'prepare',purpose:'source-free native geometry engineering test',sourceLayerIds:['marker'],elements:['marker'],referenceObservation:'synthetic planar geometry before rendering'});
  const r=await send({action:'render-native-geometry',requestId:q.id}),file=path.join(store.dir(j.documentId),'jobs',j.id,'generation/registry.json'),before=fs.readFileSync(file),state=JSON.parse(before.toString());
  for(const mode of ['role','proof','placement','recipe']){
    const s=structuredClone(state);
    if(mode==='role'){s.outputs[0].receipt.tool='image_gen';delete s.outputs[0].kind;delete s.outputs[0].nativeGeometryProof;}
    if(mode==='proof')s.outputs[0].nativeGeometryProof.hash='0'.repeat(64);
    if(mode==='placement')s.outputs[0].placementFrame.y+=3;
    if(mode==='recipe')s.layout.layers[1].nativeGeometry.shapes[0].color=[50,60,70];
    fs.writeFileSync(file,JSON.stringify(s));assert.throws(()=>registeredGeneration(j,r.id,['marker'],frame),/几何|身份|计划|冻结/,mode);
  }
  fs.writeFileSync(file,before);assert.doesNotThrow(()=>registeredGeneration(j,r.id,['marker'],frame));
  const reference=fs.readFileSync(q.referencePaths[0]);
  fs.writeFileSync(q.referencePaths[0],await sharp({create:{width:80,height:80,channels:3,background:'#aaaaaa'}}).png().toBuffer());
  assert.throws(()=>registeredGeneration(j,r.id,['marker'],frame),/几何|身份/,'changed clean reference cannot reuse old rendering proof');
  fs.writeFileSync(q.referencePaths[0],reference);assert.doesNotThrow(()=>registeredGeneration(j,r.id,['marker'],frame));
});
