import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
// @ts-expect-error Standalone diagnostic JavaScript helper.
import {reviewRegistrationPoints} from '../scripts/review-registration-points.mjs';

const taskId = process.env.CODEX_THREAD_ID ?? '01900000-0000-7000-8000-000000000000';
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'registration-review-'));
  const source = path.join(dir, 'source.png'), local = path.join(dir, 'local.png'), original = path.join(dir, 'original.png');
  const input = await sharp({create:{width:120,height:100,channels:3,background:'#664455'}}).png().toBuffer();
  await fs.writeFile(source, input);
  const crop = await sharp(input).extract({left:10,top:10,width:80,height:80}).png().toBuffer();
  await fs.writeFile(local, crop); await fs.writeFile(original, crop);
  const ids = {jobId:'01900000-0000-7000-8000-000000000001',imageId:'01900000-0000-7000-8000-000000000002',requestId:'01900000-0000-7000-8000-000000000003',generationId:'01900000-0000-7000-8000-000000000004',layerId:'01900000-0000-7000-8000-000000000005'};
  const frame = {x:10,y:10,width:80,height:80};
  const q = {id:ids.requestId,frame,canvas:{width:120,height:100},sourceLayerIds:[ids.layerId],localPath:local,localReferenceHash:hash(crop)};
  const g = {id:ids.generationId,requestId:q.id,frame,sourceLayerIds:q.sourceLayerIds,originalPath:original,hash:hash(crop)};
  const points = Array.from({length:12},(_,i)=>({source:[2+i*5,4+i*4],target:[2+i*5,4+i*4],role:i%4===1?'validation':'fit',residual:11-i,inlier:i%3===0}));
  const proposal = {accepted:false,method:'sift',reason:'heldout failed',sourceSize:[80,80],referenceSize:[80,80],scale:1,points};
  const evidencePath = path.join(dir,'evidence.json'); await fs.writeFile(evidencePath,JSON.stringify(proposal));
  const records:any = {freeze:{taskId,jobId:ids.jobId,imageId:ids.imageId,ids:{object:ids.layerId},sourcePath:source,sourceHash:hash(input)},prepare:q,registered:g,alignment:{applied:false,reason:'heldout failed',record:g,proposal,evidencePath}};
  const manifestPath = path.join(dir,'manifest.json'), destination = path.join(dir,'review.jpg');
  async function save() {
    const m:any = {taskId};
    for(const[key,record]of Object.entries(records)){const p=path.join(dir,key+'.json'),bytes=Buffer.from(JSON.stringify(record));await fs.writeFile(p,bytes);m[key]={path:p,sha256:hash(bytes)};}
    await fs.writeFile(manifestPath,JSON.stringify(m));
  }
  await save(); return {dir,source,local,original,records,proposal,evidencePath,manifestPath,destination,save};
}
test('existing fit and heldout pairs are sampled without residual selection; diagnostics preserve all inputs',async()=>{
  const f=await fixture();try{
    // The server schema orders keys differently from the Python evidence JSON.
    await fs.writeFile(f.evidencePath,JSON.stringify(Object.fromEntries(Object.entries(f.proposal).reverse())));
    const files=[f.source,f.local,f.original,f.evidencePath,f.manifestPath];const before=await Promise.all(files.map(p=>fs.readFile(p)));
    const r=await reviewRegistrationPoints(f.manifestPath,f.destination,{taskId,contextGuard:false});
    assert.deepEqual(r.rows.map((p:any)=>p.source),[[2,4],[32,28],[57,48],[7,8],[27,24],[47,40]]);
    assert.equal(r.altersMeasurementOrAcceptance,false);assert.equal(r.confirmsCorrespondenceSemantics,false);assert.equal(r.referencesAllowed,false);assert.equal(r.productionMaterial,false);assert.equal(r.independentReview,false);
    assert.ok(r.previewBytes<=131072);assert.equal(hash(await fs.readFile(f.destination)),r.previewSha256);
    assert.deepEqual((await sharp(await fs.readFile(f.destination)).metadata()).width,480);
    for(let i=0;i<files.length;i++)assert.deepEqual(await fs.readFile(files[i]),before[i]);
    await assert.rejects(reviewRegistrationPoints(f.manifestPath,f.destination,{taskId,contextGuard:false}),/already exists/);
  }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('foreign or mismatched job receipts and changed measurement evidence never create viewing output',async()=>{
  for(const mutate of[(f:any)=>{f.records.freeze.taskId='foreign';},(f:any)=>{f.records.registered.requestId='other';},(f:any)=>{f.records.alignment.record={...f.records.registered,hash:'a'.repeat(64)};},(f:any)=>{f.records.prepare.sourceLayerIds=['other'];},async(f:any)=>{await fs.writeFile(f.evidencePath,JSON.stringify({...f.proposal,scale:2}));}]){
    const f=await fixture();try{await mutate(f);await f.save();await assert.rejects(reviewRegistrationPoints(f.manifestPath,f.destination,{taskId,contextGuard:false}));await assert.rejects(fs.stat(f.destination),{code:'ENOENT'});}finally{await fs.rm(f.dir,{recursive:true,force:true});}
  }
});
test('legacy clean local reference must still have its exact hash in the frozen ordered references',async()=>{
  const f=await fixture();try{
    f.records.prepare.referencePaths=[f.local];f.records.prepare.referenceHashes=[f.records.prepare.localReferenceHash];delete f.records.prepare.localReferenceHash;await f.save();
    const r=await reviewRegistrationPoints(f.manifestPath,f.destination,{taskId,contextGuard:false});assert.equal(r.referenceHash,f.records.prepare.referenceHashes[0]);
    f.records.prepare.referencePaths=[f.source];await f.save();await assert.rejects(reviewRegistrationPoints(f.manifestPath,path.join(f.dir,'wrong.jpg'),{taskId,contextGuard:false}),/hashes required/);
  }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('changed hashes, wrong source pixels, out-of-bounds coordinates, missing holdout and unsupported edge proposals are rejected',async()=>{
  for(const mutate of[async(f:any)=>{await fs.writeFile(f.local,await sharp({create:{width:80,height:80,channels:3,background:'#112233'}}).png().toBuffer());f.records.prepare.localReferenceHash=hash(await fs.readFile(f.local));},(f:any)=>{f.records.freeze.sourceHash='a'.repeat(64);},(f:any)=>{f.proposal.points[0].source=[80,10];},(f:any)=>{f.proposal.points=f.proposal.points.map((p:any)=>({...p,role:'fit'}));},(f:any)=>{f.proposal.method='edge';}]){
    const f=await fixture();try{await mutate(f);await fs.writeFile(f.evidencePath,JSON.stringify(f.proposal));await f.save();await assert.rejects(reviewRegistrationPoints(f.manifestPath,f.destination,{taskId,contextGuard:false}));await assert.rejects(fs.stat(f.destination),{code:'ENOENT'});}finally{await fs.rm(f.dir,{recursive:true,force:true});}
  }
});
