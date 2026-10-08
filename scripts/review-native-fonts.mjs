import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {z} from 'zod';
import {frameSchema} from '../shared/layer-frame.ts';
import {nativeTextSpanSchema,nativeTextTransformSchema,nativeTextInkQuad} from '../shared/native-text.ts';
import {renderNativeText,measureNativeTextSpan} from '../server/native-text-renderer.ts';
import {createCanvas} from '@napi-rs/canvas';
import {createReviewImage} from './review-image.mjs';

const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fontSchema=z.object({name:z.string().min(1).max(80),fontPath:z.string().min(1),fontHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const nativeFontReviewSchema=z.object({
 taskId:z.string().uuid(),sourcePath:z.string().min(1),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),
 sourceSize:z.object({width:z.number().int().positive(),height:z.number().int().positive()}).strict(),
 frame:frameSchema,observation:z.string().trim().min(12).max(2000),
 plane:z.object({transform:nativeTextTransformSchema,transformObservation:z.string().trim().min(12).max(3000)}).strict().optional(),
 fonts:z.array(fontSchema).min(2).max(8),
 sizes:z.object({min:z.number().finite().min(2),max:z.number().finite().max(1000),step:z.number().finite().min(.25).max(2)}).strict(),
 spans:z.array(z.object({text:nativeTextSpanSchema.shape.text,
  inkBox:frameSchema,localInkBox:frameSchema.optional(),color:z.string().regex(/^#[a-fA-F0-9]{6}$/),
  selection:z.enum(['fit','holdout']),sizeHint:z.number().finite().min(2).max(1000)}).strict()).min(2).max(24),
}).strict().superRefine((v,c)=>{
 if(v.spans.some(s=>!!s.localInkBox!==!!v.plane))c.addIssue({code:'custom',message:'平面字体诊断须逐行冻结localInkBox；旧水平诊断不接收局部平面框'});
 if(v.sizes.min>v.sizes.max||(v.sizes.max-v.sizes.min)/v.sizes.step>120)c.addIssue({code:'custom',message:'字号搜索必须为有限的最多121档'});
 if(!v.spans.some(s=>s.selection==='fit')||!v.spans.some(s=>s.selection==='holdout'))c.addIssue({code:'custom',message:'字体选择与留出字形须在运行前明确区分'});
 if(new Set(v.fonts.map(f=>f.fontHash)).size!==v.fonts.length)c.addIssue({code:'custom',message:'字体银行不可重复相同字体摘要'});
});

/** Read-only font/size preflight. Source pixels appear only in the labelled review sheet. */
export async function createNativeFontReview(input,destination,{taskId=process.env.CODEX_THREAD_ID,contextGuard=true}={}){
 const v=nativeFontReviewSchema.parse(input),frame=v.frame;
 if(!taskId||v.taskId!==taskId)throw Error('字体诊断必须绑定真实当前任务');
 if(!path.isAbsolute(v.sourcePath)||frame.x<0||frame.y<0||frame.x+frame.width>v.sourceSize.width||frame.y+frame.height>v.sourceSize.height||v.sourceSize.width*v.sourceSize.height>1500000)throw Error('诊断源和框须位于150万预算内真实整图');
 // Editorial headlines can exceed 600px or use >100px type. Bound the complete
 // source and diagnostic carrier by pixels instead of rejecting these real cases.
 // The finite search cap and native-text's 1000px type limit still apply.
 const source=fs.readFileSync(v.sourcePath),sourceHash=sha(source),meta=await sharp(source).metadata();
 if(sourceHash!==v.sourceHash||meta.width!==v.sourceSize.width||meta.height!==v.sourceSize.height)throw Error('实际源摘要或尺寸变化');
 for(const s of v.spans)if(s.inkBox.x<frame.x||s.inkBox.y<frame.y||s.inkBox.x+s.inkBox.width>frame.x+frame.width||s.inkBox.y+s.inkBox.height>frame.y+frame.height)throw Error('可见墨迹观察框不完整属于本局部');
 const dest=path.resolve(destination);if(fs.existsSync(dest))throw Error('诊断目录已存在，读取旧结果而不覆盖');
 // No production files, recipe or frozen job records are written by this tool.
 const results=[];
 for(const font of v.fonts){
  if(!path.isAbsolute(font.fontPath)||sha(fs.readFileSync(font.fontPath))!==font.fontHash)throw Error('真实字体文件或摘要变化');
  const spans=[];
  for(const s of v.spans){
   const sizes=s.selection==='holdout'?[s.sizeHint]:Array.from({length:Math.floor((v.sizes.max-v.sizes.min)/v.sizes.step)+1},(_,i)=>v.sizes.min+i*v.sizes.step);
   let best;
   for(const fontSize of sizes){
    const measured=measureNativeTextSpan({text:s.text,fontPath:font.fontPath,fontHash:font.fontHash,fontSize,color:s.color,
     box:{x:0,y:0,width:2048,height:2048}});
    let projected=measured;
    if(v.plane){const q=nativeTextInkQuad({version:2,...v.plane}, {...s.localInkBox,...measured});
     const xs=q.map(p=>p[0]),ys=q.map(p=>p[1]);projected={width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};}
    const error=Math.hypot((projected.width-s.inkBox.width)/s.inkBox.width,(projected.height-s.inkBox.height)/s.inkBox.height);
    if(!best||error<best.error)best={text:s.text,selection:s.selection,fontSize,error,measuredInk:projected,
     ...(v.plane?{localMeasuredInk:measured}:{}),observedInkBox:s.inkBox};
   }
   spans.push(best);
  }
  const fit=spans.filter(s=>s.selection==='fit'),holdout=spans.filter(s=>s.selection==='holdout');
  results.push({font,fitMeanRelativeGeometryError:fit.reduce((n,s)=>n+s.error,0)/fit.length,
   holdoutMeanRelativeGeometryError:holdout.reduce((n,s)=>n+s.error,0)/holdout.length,spans});
 }
 results.sort((a,b)=>a.fitMeanRelativeGeometryError-b.fitMeanRelativeGeometryError);
 const recipes=results.map(result=>({version:v.plane?2:1,observation:v.observation,...(v.plane||{}),spans:v.spans.map((s,j)=>{
  const b=v.plane?s.localInkBox:s.inkBox,m=v.plane?result.spans[j].localMeasuredInk:result.spans[j].measuredInk;
  return{text:s.text,fontPath:result.font.fontPath,fontHash:result.font.fontHash,fontSize:result.spans[j].fontSize,color:s.color,
    box:{...b,width:Math.ceil(Math.max(b.width,m.width))+2,height:Math.ceil(Math.max(b.height,m.height))+2}};
 })}));
 // A diagnostic carrier is the union of all candidate boxes. It may extend beyond
 // the observed source crop; source pixels are still read only within that crop.
 // Preserve unfavorable candidates and the frozen holdout rather than clipping them.
 const quads=recipes.flatMap(r=>r.spans.flatMap(s=>nativeTextInkQuad(r,s.box)));
 const leftEdge=Math.floor(Math.min(frame.x,...quads.map(p=>p[0])))-2,
  topEdge=Math.floor(Math.min(frame.y,...quads.map(p=>p[1])))-2;
 const local={x:leftEdge,y:topEdge,width:Math.ceil(Math.max(frame.x+frame.width,...quads.map(p=>p[0])))-leftEdge+2,
  height:Math.ceil(Math.max(frame.y+frame.height,...quads.map(p=>p[1])))-topEdge+2};
 const columns=3,tileW=local.width+18,tileH=local.height+35,
  width=tileW*columns,height=tileH*Math.ceil((results.length*2+1)/columns);
 if(width*height>1500000)throw Error('整个候选查看承载超过150万像素，减少局部或字体数');
 const sourceTile=await sharp(source).extract({left:Math.floor(frame.x),top:Math.floor(frame.y),width:Math.ceil(frame.width),height:Math.ceil(frame.height)}).png().toBuffer();
 const overlays=[{input:sourceTile,left:9+frame.x-local.x,top:28+frame.y-local.y}];
 const caption=(text)=>{const c=createCanvas(tileW,25),ctx=c.getContext('2d');ctx.fillStyle='#eeeeee';ctx.fillRect(0,0,tileW,25);ctx.font='11px Arial';ctx.fillStyle='#202020';ctx.fillText(text,8,17);return c.toBuffer('image/png');};
 overlays.push({input:caption('0 SOURCE / observed ink'),left:0,top:0});
 for(let i=0;i<results.length;i++){
  const result=results[i];
  const r=renderNativeText(recipes[i],local,{width:local.width,height:local.height});
  // A fixed light-grey sheet made light title glyphs invisible. Show both
  // backgrounds without altering glyph RGB/alpha or omitting unfavourable ink.
  for(const [j,background] of ['#151515','#f1f1f1'].entries()){
   const index=i*2+j+1,left=index%columns*tileW,top=Math.floor(index/columns)*tileH;
   const backdrop=await sharp({create:{width:tileW,height:tileH,channels:4,background}}).png().toBuffer();
   overlays.push({input:backdrop,left,top});
   overlays.push({input:r.bytes,left:left+9,top:top+28});
   overlays.push({input:caption(`${i+1} ${result.font.name} / ${j?'light':'dark'} / fit ${result.fitMeanRelativeGeometryError.toFixed(3)}`),left,top});
  }
 }
 if(sha(fs.readFileSync(v.sourcePath))!==sourceHash||v.fonts.some(f=>sha(fs.readFileSync(f.fontPath))!==f.fontHash))throw Error('诊断期间实际来源或字体变化');
 fs.mkdirSync(dest,{recursive:false});const sheetPath=path.join(dest,'font-sheet-view-only.png');
 await sharp({create:{width,height,channels:4,background:'#eeeeee'}}).composite(overlays).png().toFile(sheetPath);
 const view=await createReviewImage(sheetPath,path.join(dest,'font-sheet.jpg'),{maxBytes:131072,maxEdge:1400,contextGuard});
 const report={taskId,kind:'readonly-font-preflight',inputHash:sha(Buffer.from(JSON.stringify(v))),sourceHash,results,
  selectionUses:'fit spans only; holdout uses its frozen sizeHint without size search',
  outputRole:'diagnostic only, never model reference or production material',sourcePixelsInCandidateGlyphs:false,
  fontsAndSourcePreserved:true,pixels:width*height,diagnosticCarrier:local,view,
  candidateBackgrounds:['#151515','#f1f1f1'],automaticVisualAcceptance:false,recipeOrJobChanged:false,wholeGoalAccepted:false};
 fs.writeFileSync(path.join(dest,'input.json'),JSON.stringify(v,null,2),{flag:'wx'});
 fs.writeFileSync(path.join(dest,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [input,dest]=process.argv.slice(2);if(!input||!dest)throw Error('Usage: node --import tsx scripts/review-native-fonts.mjs <observed-input.json> <new-diagnostic-dir>');
 const r=await createNativeFontReview(JSON.parse(fs.readFileSync(input)),dest);
 console.log(JSON.stringify({kind:r.kind,fonts:r.results.map(f=>({name:f.font.name,fit:f.fitMeanRelativeGeometryError,holdout:f.holdoutMeanRelativeGeometryError})),previewPath:r.view.previewPath,previewBytes:r.view.previewBytes,recipeOrJobChanged:false,wholeGoalAccepted:false}));
}
