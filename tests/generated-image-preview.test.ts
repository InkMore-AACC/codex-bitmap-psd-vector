import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import sharp from 'sharp';
// @ts-ignore JavaScript viewing utility
import {validateGeneratedPreview,validateGeneratedComponentPreview,boundedGeneratedResponse,GENERATED_PREVIEW_MAX_FILE_BYTES,GENERATED_PREVIEW_MAX_INLINE_BYTES,GENERATED_PREVIEW_RESPONSE_RESERVE_BYTES} from '../scripts/generated-image-preview.mjs';
// @ts-ignore JavaScript viewing utility
import {createReviewImage} from '../scripts/review-image.mjs';
// @ts-ignore JavaScript budget utility
import {checkContextBudget} from '../scripts/check-context-budget.mjs';

test('bounded generation display preserves full original and fits a measured output reserve without rewriting history',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'generated-preview-')),taskId='00000000-0000-4000-8000-000000000014';
 try{
  const tool=path.join(dir,taskId,'exec-fixture.png');await fs.mkdir(path.dirname(tool));
  const bytes=await sharp({create:{width:80,height:120,channels:4,background:'#123456'}}).png().toBuffer(),hash=crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(tool,bytes);const original=path.join(dir,'original.png'),working=path.join(dir,'working.png');await fs.writeFile(original,bytes);await fs.writeFile(working,bytes);
  const source={taskId,actualToolPath:tool,originalPath:original,originalSha256:hash,workingPath:working,workingSha256:hash,workingSize:[80,120]};
  const view=await createReviewImage(working,path.join(dir,'preview.jpg'),{maxBytes:128*1024,maxEdge:128,contextGuard:false});
  const verified=await validateGeneratedPreview(source,view,{taskId});const jpeg=await fs.readFile(view.previewPath),dataUrl='data:image/jpeg;base64,'+jpeg.toString('base64');
  const output=boundedGeneratedResponse(dataUrl,verified);assert.equal(output.image_url,dataUrl);assert.ok(Buffer.byteLength(dataUrl)<=GENERATED_PREVIEW_MAX_INLINE_BYTES);assert.ok(GENERATED_PREVIEW_MAX_INLINE_BYTES+512*1024<GENERATED_PREVIEW_RESPONSE_RESERVE_BYTES);
  assert.equal(boundedGeneratedResponse(dataUrl.replace('image/jpeg','application/octet-stream'),verified).image_url,dataUrl);
  assert.throws(()=>boundedGeneratedResponse(dataUrl.replace('image/jpeg','image/png'),verified),/bounded/);
  assert.equal(verified.formalRegistrationUsesOriginal,true);assert.equal(verified.historyModified,false);assert.deepEqual(await fs.readFile(tool),bytes);assert.deepEqual(await fs.readFile(original),bytes);assert.deepEqual(await fs.readFile(working),bytes);
  assert.throws(()=>boundedGeneratedResponse('data:image/png;base64,'+'A'.repeat(4*1024*1024),verified),/bounded/);
  assert.throws(()=>boundedGeneratedResponse(dataUrl.replace('EjR','EjS'),{...verified,previewSha256:'0'.repeat(64)}),/differ/);
  await assert.rejects(validateGeneratedPreview(source,{...view,sourceSha256:'0'.repeat(64)},{taskId}),/proof/);
  await assert.rejects(validateGeneratedPreview(source,view,{taskId:'other-task'}),/task/);
  const history=path.join(dir,'synthetic.jsonl');const saved=JSON.stringify({type:'session_meta',payload:{id:taskId}})+'\n'+JSON.stringify({type:'response_item',payload:{text:'A'.repeat(9*1024*1024)}})+'\n';await fs.writeFile(history,saved);
  const old=await checkContextBudget(history,{taskId,reserveBytes:4*1024*1024});assert.equal(old.allowed,false);
  const bounded=await checkContextBudget(history,{taskId,reserveBytes:GENERATED_PREVIEW_RESPONSE_RESERVE_BYTES});assert.equal(bounded.allowed,true);assert.equal(bounded.envelopeReserveBytes,old.envelopeReserveBytes);assert.equal(bounded.limitBytes,old.limitBytes);assert.equal(await fs.readFile(history,'utf8'),saved);
 }finally{const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'generated-preview-'));await fs.rm(resolved,{recursive:true,force:true});}
});

test('registered component uses the same bounded display adapter, preserves PNGs and binds exact prepared request',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'generated-preview-')),taskId=crypto.randomUUID(),digest=(b:Buffer)=>crypto.createHash('sha256').update(b).digest('hex');
 try{
  const own=path.join(dir,taskId);await fs.mkdir(own);
  const tool=path.join(own,'tool.png'),native=path.join(own,'native.png'),original=path.join(own,'original.png'),working=path.join(own,'working.png');
  const bytes=await sharp(crypto.randomBytes(700*1000*4),{raw:{width:700,height:1000,channels:4}}).png().toBuffer();
  for(const p of [tool,native,original])await fs.writeFile(p,bytes);
  const work=await sharp(bytes).resize(350,500).png().toBuffer();await fs.writeFile(working,work);
  const request={id:crypto.randomUUID(),sourceLayerIds:[crypto.randomUUID()],referencePaths:[tool],referenceHashes:[digest(bytes)]};
  const requestPath=path.join(own,'request.json');await fs.writeFile(requestPath,JSON.stringify(request));
  const model={taskId,kind:'actual-current-image_gen-prepared-output',requestPath,requestId:request.id,nativePath:native,nativeHash:digest(bytes),actualToolPath:tool,nativeBytes:bytes.length};
  const record={id:crypto.randomUUID(),requestId:request.id,sourceLayerIds:request.sourceLayerIds,hash:digest(bytes),originalPath:original,workingPath:working,workingHash:digest(work),workingSize:{width:350,height:500}};
  const view=await createReviewImage(working,path.join(own,'preview.jpg'),{maxBytes:GENERATED_PREVIEW_MAX_FILE_BYTES,maxEdge:640,contextGuard:false});
  const verified=await validateGeneratedComponentPreview(model,record,view,{taskId});
  const output=boundedGeneratedResponse('data:image/jpeg;base64,'+(await fs.readFile(view.previewPath)).toString('base64'),verified);
  assert(Buffer.byteLength(output.image_url)<=GENERATED_PREVIEW_MAX_INLINE_BYTES);
  assert(view.previewBytes<=131072);assert.equal(verified.generationId,record.id);assert.equal(verified.registeredComponent,true);
  assert.equal(verified.wholeGoalAccepted,false);assert.equal(verified.formalRegistrationUsesOriginal,true);
  for(const p of [tool,native,original])assert.deepEqual(await fs.readFile(p),bytes);
  assert.deepEqual(await fs.readFile(working),work);
  await assert.rejects(validateGeneratedComponentPreview(model,{...record,requestId:crypto.randomUUID()},view,{taskId}),/proof differs/);
  await assert.rejects(validateGeneratedComponentPreview(model,{...record,sourceLayerIds:['other']},view,{taskId}),/proof differs/);
  await assert.rejects(validateGeneratedComponentPreview({...model,nativeBytes:bytes.length-1},record,view,{taskId}),/proof differs/);
  await assert.rejects(validateGeneratedComponentPreview(model,record,{...view,crop:{left:0,top:0,width:10,height:10}},{taskId}),/proof/);
 }finally{const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'generated-preview-'));await fs.rm(resolved,{recursive:true,force:true});}
});

test('display limit is128KiB and an older larger proof cannot authorize a larger inline JPEG',async()=>{
 assert.equal(GENERATED_PREVIEW_MAX_FILE_BYTES,131072);
 assert(GENERATED_PREVIEW_MAX_INLINE_BYTES<=174828);
 assert.throws(()=>boundedGeneratedResponse('data:image/jpeg;base64,'+'A'.repeat(200000),{viewingOnly:true,originalPreserved:true,maxInlineImageBytes:GENERATED_PREVIEW_MAX_INLINE_BYTES}),/bounded/);
});
