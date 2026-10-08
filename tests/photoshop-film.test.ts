import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { readPsd, writePsdBuffer } from 'ag-psd';
import { photoshopPlanSchema, photoshopGroupName, photoshopActionSchema } from '../shared/photoshop.js';
import { validateNativeFilmRecipe } from '../shared/native-film.js';
import { planningLayer } from '../shared/planning.js';
process.env.LAYER_CANVAS_DATA = path.resolve('test-output/native-film-' + crypto.randomUUID());
const { prepareNativeFilmPsd, verifyNativeFilmGroup, renderNativeFilm } = await import('../server/photoshop-film.js');
const { nativeProgressLayers } = await import('../server/photoshop-native.js');
const { validatePhotoshopPlan, photoshopState } = await import('../server/photoshop-rebuild.js');
const { app, TOKEN, BRIDGE_TOKEN, adobe } = await import('../server/index.js');
const store = await import('../server/store.js');
const frame = { x: 10, y: 10, width: 80, height: 80 };
const knot = (x: number, y: number): [number,number,number,number,number,number] => [x,y,x,y,x,y];
function plan() {
  return photoshopPlanSchema.parse({ canvas: { width: 100, height: 100 },
    relations: [{ id: 'coincident', kind: 'alignment', layerIds: ['film','ink'], observation: 'separate parts align with same source coordinates' }],
    layers: ['film','ink'].map((id, i) => ({ layerId: id, name: id, frame, route: i ? 'generate' : 'native', content: i ? 'bitmap' : 'shape',
      surface: 'transparent', editable: i ? 'pixels' : 'native-shape', rationale: 'isolated representation', includes: id, excludes: 'environment and other part',
      compositing: 'normal alpha', elements: [id], opticalPart: { version: 1, assemblyId: 'PET', kind: i ? 'opaque-structure' : 'thin-film' },
      alphaChecks: [{ name: 'empty margin', kind: 'clear', box: [11,11,2,2], maxAlpha: 8, minPassingFraction: 1 }, i
        ? { name: 'ink mark', kind: 'occupied', box: [30,30,4,4], minAlpha: 240, minPassingFraction: 0.8 }
        : { name: 'continuous film', kind: 'transmissive', box: [30,30,4,4], minAlpha: 20, maxAlpha: 220, minBackgroundResponse: 35, minPassingFraction: 1 }],
      ...(!i ? { nativeFilm: { version: 1, observation: 'engineering quadrilateral, not actual poster tracing',
        knots: [knot(20,20),knot(80,20),knot(80,80),knot(20,80)], gradient: { angle: 15, stops: [
          { position: 0, color: [60,130,150], alpha: 48 }, { position: 1, color: [90,180,190], alpha: 160 }] } } } : {}),
    })) });
}
const meta = (bytes: Buffer) => readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
test('native film PSD stores editable closed path and explicit opacity/color stops; raster cache is not PS evidence', () => {
  const p = plan(), bytes = prepareNativeFilmPsd(p, 'film'), psd = meta(bytes);
  assert.equal(psd.width, 100); assert.equal(psd.children!.length, 1);
  const group = psd.children![0], layer = group.children![0];
  assert.equal(layer.vectorMask!.paths[0].knots.length, 4); assert.equal(layer.vectorFill!.type, 'solid');
  assert.doesNotThrow(() => verifyNativeFilmGroup(group, p.layers[0]));
  assert.deepEqual(nativeProgressLayers(bytes, p, p.canvas!).map(l => l.layerId), ['film']);
  const raster = readPsd(bytes, { useImageData: true });
  const rgba = raster.children![0].children![0].imageData!.data;
  assert(rgba.some((v, i) => i % 4 === 3 && v === 0));
  assert(rgba.some((v, i) => i % 4 === 3 && v >= 48 && v <= 160));
});
test('native PS film keeps declared ellipse windows as subtract paths and cache alpha holes, with exact metadata verification',()=>{
  const p=plan();p.layers[0].nativeFilm!.cutouts=[{name:'clear circular window',center:[50,50],radiusX:8,radiusY:10,angle:17}];
  const bytes=prepareNativeFilmPsd(p,'film'),group=meta(bytes).children![0];assert.equal(group.children![0].vectorMask!.paths.length,2);
  assert.equal(group.children![0].vectorMask!.paths[1].operation,'subtract');assert.doesNotThrow(()=>verifyNativeFilmGroup(group,p.layers[0]));
  const raster=readPsd(bytes,{useImageData:true}).children![0].children![0],data=raster.imageData!.data;
  const pixel=(x:number,y:number)=>data[((y-raster.top!)*raster.imageData!.width+x-raster.left!)*4+3];
  assert.equal(pixel(50,50),0);assert.ok(pixel(30,30)>20);assert.deepEqual(nativeProgressLayers(bytes,p,p.canvas!).map(l=>l.layerId),['film']);
  for(const mode of ['fill','center','missing']){
    const bad=structuredClone(group),mask=bad.children![0].vectorMask!;
    if(mode==='fill')mask.paths[1].operation='combine';if(mode==='center')mask.paths[1].knots[0].points[2]+=2;if(mode==='missing')mask.paths.pop();
    assert.throws(()=>verifyNativeFilmGroup(bad,p.layers[0]),/冻结配方/);
  }
  const moved=structuredClone(p);moved.layers[0].nativeFilm!.cutouts![0].center=[81,50];assert.throws(()=>prepareNativeFilmPsd(moved,'film'),/完整|内含/);
});

test('explicit PS polygon film retains five-corner native path and two subtract windows without widening v1',()=>{
  const p=plan(),recipe=p.layers[0].nativeFilm!;
  recipe.version=2;recipe.knots=[knot(20,20),knot(90,20),knot(90,70),knot(70,90),knot(20,80)];
  recipe.cutouts=[{name:'left window',center:[45,45],radiusX:5,radiusY:6,angle:0},{name:'right window',center:[70,50],radiusX:5,radiusY:7,angle:0}];
  const bytes=prepareNativeFilmPsd(p,'film'),group=meta(bytes).children![0],layer=group.children![0];
  assert.equal(layer.vectorMask!.paths[0].knots.length,5);assert.equal(layer.vectorMask!.paths.length,3);
  assert.deepEqual(layer.vectorMask!.paths.slice(1).map(p=>p.operation),['subtract','subtract']);
  assert.doesNotThrow(()=>verifyNativeFilmGroup(group,p.layers[0]));
  const rendered=readPsd(bytes,{useImageData:true}).children![0].children![0],data=rendered.imageData!.data;
  const alpha=(x:number,y:number)=>data[((y-rendered.top!)*rendered.imageData!.width+x-rendered.left!)*4+3];
  assert.equal(alpha(45,45),0);assert.equal(alpha(70,50),0);assert.equal(alpha(85,85),0);assert.ok(alpha(30,40)>20&&alpha(30,40)<220);
  const old=structuredClone(p);old.layers[0].nativeFilm!.version=1;assert.throws(()=>prepareNativeFilmPsd(old,'film'),/四边形/);
  const curved=structuredClone(p);curved.layers[0].nativeFilm!.knots[0][0]+=1;assert.throws(()=>prepareNativeFilmPsd(curved,'film'),/直线/);
  const escaped=structuredClone(p);escaped.layers[0].nativeFilm!.cutouts![0].center=[84,84];assert.throws(()=>prepareNativeFilmPsd(escaped,'film'),/内含/);
  const bad=structuredClone(group);bad.children![0].vectorMask!.paths[0].knots[2].points[2]-=1;assert.throws(()=>verifyNativeFilmGroup(bad,p.layers[0]),/冻结配方/);
});

test('native film rejects edited paths, opacity/gradient, baked pixels, hidden content and extra ink before progress readiness', () => {
  const p = plan(), bytes = prepareNativeFilmPsd(p, 'film'), original = meta(bytes).children![0];
  for (const mode of ['path','alpha','color','angle','solid','hidden','extra','bitmap','hole']) {
    const group = structuredClone(original), l = group.children![0];
    if (mode === 'path') l.vectorMask!.paths[0].knots[0].points[2] += 2;
    if (mode === 'alpha') (l.vectorFill as any).opacityStops[0].opacity = 1;
    if (mode === 'color') (l.vectorFill as any).colorStops[0].color.r = 0;
    if (mode === 'angle') (l.vectorFill as any).angle = 90;
    if (mode === 'solid') (l.vectorFill as any).type = 'color';
    if (mode === 'hidden') l.hidden = true;
    if (mode === 'extra') group.children!.push({ name: 'ink placeholder', left: 0, top: 0, right: 30, bottom: 30 });
    if (mode === 'bitmap') delete l.vectorMask;
    if (mode === 'hole') l.vectorMask!.paths[0].operation = 'subtract';
    assert.throws(() => verifyNativeFilmGroup(group, p.layers[0]), /冻结配方/, mode);
  }
});

test('native recipe rejects out-of-frame control points, bad stop order, wrong route and over-budget whole canvas', () => {
  const p = plan(), recipe = structuredClone(p.layers[0].nativeFilm!);
  recipe.knots[0][0] = 0; assert.throws(() => validateNativeFilmRecipe(recipe, frame), /画幅/);
  const order = structuredClone(p.layers[0].nativeFilm!); order.gradient.stops[0].position = 0.2;
  assert.throws(() => validateNativeFilmRecipe(order, frame), /0\/1/);
  assert.throws(() => prepareNativeFilmPsd({ ...p, canvas: { width: 2000, height: 1000 } }, 'film'), /150万/);
  const fallback = structuredClone(p); fallback.layers[0].route = 'generate';
  assert.throws(() => prepareNativeFilmPsd(fallback, 'film'), /原生薄膜配方/);
  assert.throws(() => photoshopActionSchema.parse({ action: 'render-native-film', layerId: 'film', inputPsdPath: 'a.psd', opacity: 0.5 }));
});

test('PS saved default omission is compatible, while explicit alignment/angle/scale/reverse changes remain rejected', () => {
  const p = plan(); p.layers[0].nativeFilm!.gradient.angle = 0;
  const group = meta(prepareNativeFilmPsd(p, 'film')).children![0], fill = group.children![0].vectorFill as any;
  for (const key of ['align','angle','scale','reverse','dither']) delete fill[key];
  assert.doesNotThrow(() => verifyNativeFilmGroup(group, p.layers[0]));
  for (const [key,value] of [['align',false],['angle',90],['scale',0.5],['reverse',true]] as const) {
    const changed = structuredClone(group); (changed.children![0].vectorFill as any)[key] = value;
    assert.throws(() => verifyNativeFilmGroup(changed,p.layers[0]), /冻结配方/);
  }
});

// Native execution is deliberately simulated for tests. It cannot establish actual Photoshop behavior.
async function simulatedExecute(_app: string, script: string, _scope: string, outputs: string[]) {
  const text = fs.readFileSync(script,'utf8');
  const match = text.match(/src=app\.open\(new File\(("(?:\\.|[^"\\])*")\)\)/)!;
  const src = readPsd(fs.readFileSync(JSON.parse(match[1])), { useImageData: true });
  outputs.forEach(p => assert(!fs.existsSync(p), 'Adobe expectedOutputs must be new paths'));
  const working = text.match(/d=app\.open\(new File\(("(?:\\.|[^"\\])*")\)\)/)!;
  const out = readPsd(fs.readFileSync(JSON.parse(working[1])), { useImageData: true });
  const target = out.children!.find(g => g.name === 'LC_film')!;
  target.children = src.children![0].children; target.opacity = 1; target.blendMode = 'normal';
  fs.writeFileSync(outputs[0], writePsdBuffer(out));
  fs.writeFileSync(outputs[1], JSON.stringify({ nativePhotoshopVersion: 'SIMULATED-NOT-PHOTOSHOP', before: 1, after: 1 }));
}
function emptyBase(p: ReturnType<typeof plan>) {
  return writePsdBuffer({ ...p.canvas!, children: p.layers.map(l => ({ name: photoshopGroupName(l.layerId), children: [] })) });
}
test('native renderer preserves input/new-copy boundary and rejects nonempty or unscoped targets before any execution', async () => {
  const folder = path.join(process.env.LAYER_CANVAS_DATA!, crypto.randomUUID()); fs.mkdirSync(folder,{recursive:true});
  const p = plan(), input = path.join(folder,'base.psd'), bytes = emptyBase(p); fs.writeFileSync(input, bytes);
  let calls = 0;
  const stub = { executeScript: async (...args: Parameters<typeof simulatedExecute>) => { calls++; await simulatedExecute(...args); } };
  const result = await renderNativeFilm(stub as any, folder, input, p, 'film');
  assert.equal(calls,1); assert.notEqual(result.artifactPath,input); assert.deepEqual(fs.readFileSync(input),bytes);
  assert.equal(result.facts.nativePhotoshopVersion,'SIMULATED-NOT-PHOTOSHOP');
  verifyNativeFilmGroup(meta(fs.readFileSync(result.artifactPath)).children![0],p.layers[0]);
  await assert.rejects(() => renderNativeFilm(stub as any,folder,result.artifactPath,p,'film'), /已有内容/);
  const outside = path.join(process.env.LAYER_CANVAS_DATA!,'outside-'+crypto.randomUUID()+'.psd'); fs.writeFileSync(outside, bytes);
  await assert.rejects(() => renderNativeFilm(stub as any,folder,outside,p,'film'), /本次交接目录/);
  assert.equal(calls,1);
});

app.locals.codexSender = async () => ({ delivered:true });
const server = app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.once('listening',r));
after(()=>{server.closeAllConnections();server.close();});
const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
async function post(route:string,body:unknown,status=200){const r=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json','X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN},body:JSON.stringify(body)});const value:any=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
test('public native film action freezes recipe before any model request and records preparation without acceptance', async () => {
  for(const polygon of [false,true]){
  const d=store.getByTask('film_native_http_'+crypto.randomUUID()),p=plan();
  if(polygon){const r=p.layers[0].nativeFilm!;r.version=2;r.knots=[knot(20,20),knot(90,20),knot(90,70),knot(70,90),knot(20,80)];r.cutouts=[{name:'window',center:[50,50],radiusX:7,radiusY:8,angle:0}];}
  const url=store.writeAsset(d.id,await sharp({create:{width:100,height:100,channels:3,background:'#123456'}}).png().toBuffer(),'.png');
  d.images.push({id:'source',name:'synthetic engineering fixture',width:100,height:100,x:0,y:0,source:url,url,status:'preview',version:1,annotations:[],opinion:'',layers:p.layers.map(l=>planningLayer(l.layerId,l.name,l.frame,'foreground',''))});store.save(d);
  const j=await post(`/api/document/${d.id}/jobs`,{imageId:'source',type:'photoshop'},202);await post(`/api/jobs/${j.id}/claim`,{taskId:d.taskId});
  const route=`/api/jobs/${j.id}/ps-rebuild`,send=(body:unknown,status=200)=>post(route,{taskId:d.taskId,...body as any},status);
  assert.doesNotThrow(()=>validatePhotoshopPlan(store.getJob(j.id),p));await send({action:'plan',plan:p});
  const folder=path.join(store.dir(d.id),'jobs',j.id),input=path.join(folder,'base.psd');fs.writeFileSync(input,emptyBase(p));
  const original=adobe.executeScript; let executions=0; adobe.executeScript=(async(...args:Parameters<typeof simulatedExecute>)=>{executions++;return simulatedExecute(...args);}) as any;
  try{
    const result=await send({action:'render-native-film',layerId:'film',inputPsdPath:input});
    const s=photoshopState(store.getJob(j.id));assert.equal(s.nativeFilms!.film.artifactPath,result.artifactPath);assert.equal(s.inspection,undefined);assert.deepEqual(s.reviews,{});
    assert.equal((await send({action:'render-native-film',layerId:'film',inputPsdPath:input})).reused,true);
    assert.equal((await send({action:'render-native-film',layerId:'film',inputPsdPath:result.artifactPath})).reused,true);assert.equal(executions,1);
    const edited=structuredClone(p);edited.layers[0].nativeFilm!.gradient.stops[0].alpha=20;
    assert.match((await send({action:'plan',plan:edited},400)).error,/首次prepare/);
    const changed=structuredClone(p);delete changed.layers[0].nativeFilm;
    assert.match((await send({action:'plan',plan:changed},400)).error,/nativeFilm/);
    await send({action:'plan',plan:p});
  }finally{adobe.executeScript=original;}
  }
});

test('same-job resume accepts scoped native prepared geometry, rejects empty/foreign files, and never treats it as acceptance', async () => {
  const d=store.getByTask('native_resume_http_'+crypto.randomUUID()),p=plan();
  const url=store.writeAsset(d.id,await sharp({create:{width:100,height:100,channels:3,background:'#123456'}}).png().toBuffer(),'.png');
  d.images.push({id:'source',name:'native preparation fixture, not actual PS',width:100,height:100,x:0,y:0,source:url,url,status:'preview',version:1,annotations:[],opinion:'',layers:p.layers.map(l=>planningLayer(l.layerId,l.name,l.frame,'foreground',''))});store.save(d);
  const j=await post(`/api/document/${d.id}/jobs`,{imageId:'source',type:'photoshop'},202);await post(`/api/jobs/${j.id}/claim`,{taskId:d.taskId});
  await post(`/api/jobs/${j.id}/ps-rebuild`,{taskId:d.taskId,action:'plan',plan:p});
  const folder=path.join(store.dir(d.id),'jobs',j.id),native=path.join(folder,'native-prepared.psd'),empty=path.join(folder,'empty.psd');
  fs.writeFileSync(native,prepareNativeFilmPsd(p,'film'));fs.writeFileSync(empty,emptyBase(p));
  const body={taskId:d.taskId,reason:'resume prepared native film, actual PS still required',nativeArtifactPath:native};
  const route=`/api/jobs/${j.id}/resume`;await post(route,body,409);
  await post(`/api/jobs/${j.id}/fail`,{taskId:d.taskId,message:'engineering restart fixture'});
  await post(route,{taskId:d.taskId,reason:'no registered checkpoint'},409);
  await post(route,{...body,nativeArtifactPath:empty},409);
  const foreign=path.join(store.dir(d.id),'foreign.psd');fs.writeFileSync(foreign,fs.readFileSync(native));
  const rejected=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json','X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN},body:JSON.stringify({...body,nativeArtifactPath:foreign})});assert(rejected.status>=400);
  const stateFile=path.join(folder,'photoshop-rebuild.json'),stateBefore=fs.readFileSync(stateFile),fileBefore=fs.readFileSync(native);
  const result=await post(route,body);assert.equal(result.job.id,j.id);assert.equal(result.job.status,'running');assert.equal(result.checkpoints.psNativePrepared,1);assert.equal(result.checkpoints.psInspection,false);
  assert.deepEqual(fs.readFileSync(native),fileBefore);assert.deepEqual(fs.readFileSync(stateFile),stateBefore);assert.deepEqual(photoshopState(store.getJob(j.id)).reviews,{});
  const history=JSON.parse(fs.readFileSync(path.join(folder,'resume-history.json'),'utf8'));assert.equal(history[0].nativePrepared.path,native);assert.deepEqual(history[0].nativePrepared.layerIds,['film']);
  const changed=structuredClone(p);changed.layers[0].excludes='change ownership after native resume';
  assert.match((await post(`/api/jobs/${j.id}/ps-rebuild`,{taskId:d.taskId,action:'plan',plan:changed},400)).error,/首次prepare/);
  assert.equal(store.load(d.id).images.length,1);
});
