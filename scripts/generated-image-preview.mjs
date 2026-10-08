import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {pathToFileURL} from 'node:url';

// This bounds only the image displayed in chat. Production PNGs and task history are never rewritten.
export const GENERATED_PREVIEW_MAX_FILE_BYTES=128*1024;
export const GENERATED_PREVIEW_MAX_INLINE_BYTES=4*Math.ceil(GENERATED_PREVIEW_MAX_FILE_BYTES/3)+64;
export const GENERATED_PREVIEW_RESPONSE_RESERVE_BYTES=1024*1024;
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export async function validateGeneratedPreview(sourceProof,viewProof,{taskId=process.env.CODEX_THREAD_ID}={}){
 if(!taskId||sourceProof.taskId!==taskId||!sourceProof.actualToolPath.includes(taskId))throw Error('Actual tool/source task mismatch');
 if(sha(sourceProof.actualToolPath)!==sourceProof.originalSha256||sha(sourceProof.originalPath)!==sourceProof.originalSha256||sha(sourceProof.workingPath)!==sourceProof.workingSha256)throw Error('Actual original/working bytes changed');
 const working=await sharp(fs.readFileSync(sourceProof.workingPath)).metadata();
 if(working.width*working.height>1500000||JSON.stringify([working.width,working.height])!==JSON.stringify(sourceProof.workingSize))throw Error('Working canvas budget/size mismatch');
 if(viewProof.kind!=='viewing-only-jpeg'||path.resolve(viewProof.sourcePath)!==path.resolve(sourceProof.workingPath)||viewProof.sourceSha256!==sourceProof.workingSha256||viewProof.crop!==null||viewProof.maxBytes>GENERATED_PREVIEW_MAX_FILE_BYTES)throw Error('Full-source bounded viewing proof required');
 const bytes=fs.readFileSync(viewProof.previewPath),meta=await sharp(bytes).metadata();
 if(meta.format!=='jpeg'||bytes.length!==viewProof.previewBytes||bytes.length>GENERATED_PREVIEW_MAX_FILE_BYTES||JSON.stringify([meta.width,meta.height])!==JSON.stringify(viewProof.previewSize)||meta.width>working.width||meta.height>working.height)throw Error('Actual viewing JPEG exceeds bound or changed');
 await sharp(bytes).raw().toBuffer();
 return {taskId,actualToolPath:sourceProof.actualToolPath,originalSha256:sourceProof.originalSha256,originalPreserved:true,previewPath:viewProof.previewPath,previewSha256:sha(viewProof.previewPath),previewBytes:bytes.length,previewSize:viewProof.previewSize,maxInlineImageBytes:GENERATED_PREVIEW_MAX_INLINE_BYTES,responseReserveBytes:GENERATED_PREVIEW_RESPONSE_RESERVE_BYTES,viewingOnly:true,formalRegistrationUsesOriginal:true,historyModified:false};
}

// Reuse the source adapter for a real registered component, never a JPEG material.
export async function validateGeneratedComponentPreview(modelProof,record,viewProof,{taskId=process.env.CODEX_THREAD_ID}={}){
 if(!taskId||modelProof.taskId!==taskId||modelProof.kind!=='actual-current-image_gen-prepared-output')throw Error('Actual component tool/task proof required');
 const request=JSON.parse(fs.readFileSync(modelProof.requestPath,'utf8'));
 if(request.id!==modelProof.requestId||record.requestId!==request.id||
   JSON.stringify(record.sourceLayerIds)!==JSON.stringify(request.sourceLayerIds)||
   modelProof.nativeHash!==record.hash||sha(modelProof.nativePath)!==record.hash||
   fs.statSync(modelProof.actualToolPath).size!==modelProof.nativeBytes||
   request.referencePaths.some((p,i)=>sha(p)!==request.referenceHashes[i]))throw Error('Registered component/request/native proof differs');
 const verified=await validateGeneratedPreview({taskId,actualToolPath:modelProof.actualToolPath,
   originalPath:record.originalPath,originalSha256:record.hash,workingPath:record.workingPath,
   workingSha256:record.workingHash,workingSize:[record.workingSize.width,record.workingSize.height]},viewProof,{taskId});
 return {...verified,generationId:record.id,requestId:record.requestId,registeredComponent:true,wholeGoalAccepted:false};
}

export function boundedGeneratedResponse(dataUrl,verified){
 if(!verified?.viewingOnly||verified.originalPreserved!==true||verified.maxInlineImageBytes!==GENERATED_PREVIEW_MAX_INLINE_BYTES||!/^data:(?:image\/jpeg|application\/octet-stream);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)||Buffer.byteLength(dataUrl)>GENERATED_PREVIEW_MAX_INLINE_BYTES)throw Error('Only size-bounded verified JPEG may be displayed');
 const bytes=Buffer.from(dataUrl.slice(dataUrl.indexOf(',')+1),'base64');
 if(bytes.length!==verified.previewBytes||crypto.createHash('sha256').update(bytes).digest('hex')!==verified.previewSha256)throw Error('Displayed bytes differ from verified preview');
 return {image_url:'data:image/jpeg;base64,'+bytes.toString('base64'),output_hint:'Shown image is a size-bounded viewing preview. Actual image_gen original preserved at '+verified.actualToolPath+'. Formal registration and pixel checks use that original, never this JPEG.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2),read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
 if(args[0]==='--component'){
  if(args.length!==4)throw Error('Usage: node scripts/generated-image-preview.mjs --component <model-proof.json> <registered-record.json> <view-proof.json>');
  console.log(JSON.stringify(await validateGeneratedComponentPreview(read(args[1]),read(args[2]),read(args[3]))));
 }else{
  if(args.length!==2)throw Error('Usage: node scripts/generated-image-preview.mjs <source-proof.json> <view-proof.json>');
  console.log(JSON.stringify(await validateGeneratedPreview(read(args[0]),read(args[1]))));
 }
}
