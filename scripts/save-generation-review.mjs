import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {createReviewImage} from './review-image.mjs';

// This is a file/proof helper after current-chat image_gen has actually returned.
// It never invokes a model, uses a private API or substitutes a preview for an original.
export async function saveGenerationReview(source,directory,options={}) {
 const taskId=process.env.CODEX_THREAD_ID;
 if(!taskId||!source.includes(taskId))throw Error('Returned source must belong to the current conversation');
 const root=path.resolve(directory),workspace=path.resolve('test-output');
 const rel=path.relative(workspace,root);
 if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('Review output must be a new project experiment subdirectory');
 if(fs.existsSync(root))throw Error('Immutable generation proof exists');
 fs.mkdirSync(root,{recursive:true});
 const originalPath=path.join(root,'original.png');fs.copyFileSync(source,originalPath);
 const input=fs.readFileSync(originalPath),meta=await sharp(input).metadata();
 const size=options.size;
 let workingPath=originalPath,workingSize=[meta.width,meta.height];
 if(size||meta.width*meta.height>1500000){
  const scale=Math.min(1,size?Math.min(size.width/meta.width,size.height/meta.height):Math.sqrt(1500000/(meta.width*meta.height)));
  const width=Math.max(1,Math.floor(meta.width*scale)),height=Math.max(1,Math.floor(meta.height*scale));
  if(width*height>1500000)throw Error('Working pixel budget exceeded');
  workingPath=path.join(root,'working.png');
  await sharp(input).resize({width,height,fit:'inside',withoutEnlargement:true}).png().toFile(workingPath);
  const m=await sharp(workingPath).metadata();workingSize=[m.width,m.height];
 }
 const preview=await createReviewImage(originalPath,path.join(root,'review.jpg'),{maxEdge:options.maxEdge??900,maxBytes:options.maxBytes??96*1024});
 const record={taskId,sourcePath:source,originalPath,originalSha256:crypto.createHash('sha256').update(input).digest('hex'),originalSize:[meta.width,meta.height],originalPixels:meta.width*meta.height,workingPath,workingSize,workingPixels:workingSize[0]*workingSize[1],hasAlpha:!!meta.hasAlpha,previewPath:preview.previewPath,previewBytes:preview.previewBytes,preview,notes:'Original immutable. Working budget <=1500000. JPEG viewing only; precise alpha/geometry/hash from actual PNG.'};
 fs.writeFileSync(path.join(root,'proof.json'),JSON.stringify(record,null,2),{flag:'wx'});return record;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const [source,directory,rawOptions]=process.argv.slice(2);
 if(!source||!directory)throw Error('Usage: save-generation-review.mjs returned-file new-proof-directory [options-json]');
 const r=await saveGenerationReview(source,directory,rawOptions?JSON.parse(rawOptions):{});
 console.log(JSON.stringify({taskId:r.taskId,originalPath:r.originalPath,originalSize:r.originalSize,workingPath:r.workingPath,workingSize:r.workingSize,previewPath:r.previewPath,previewBytes:r.previewBytes}));
}
