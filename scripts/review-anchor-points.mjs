import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import{pathToFileURL}from'node:url';import sharp from'sharp';
import{checkContextBudget,findCurrentHistory}from'./check-context-budget.mjs';
// Diagnostic pixels only. Never use them as generation references or materials.
// This checks a recorded independent measurement, not the truth of its semantics or reviewer identity.
export function checkSourceAnchorReview(proposal,review,{taskId,proposalSha256}={}){
 if(!taskId||!Number.isInteger(proposal.width)||!Number.isInteger(proposal.height)||proposal.width<1||proposal.height<1||!/^[a-f0-9]{64}$/.test(proposal.sourceHash??'')||!/^[a-f0-9]{64}$/.test(proposalSha256??'')||proposal.taskId!==taskId||review.taskId!==taskId||review.sourceHash!==proposal.sourceHash||review.proposalSha256!==proposalSha256)throw Error('Own unchanged source/proposal review required');
 if(review.status!=='accepted'||typeof review.authorId!=='string'||typeof review.reviewerId!=='string'||!review.authorId.trim()||!review.reviewerId.trim()||review.authorId.trim()===review.reviewerId.trim())throw Error('Separate accepted source-feature review required');
 const tolerance=proposal.limits?.manualAnchorErrorPixels;if(!Number.isFinite(tolerance)||tolerance<=0)throw Error('Declare source-point tolerance before independent review');
 const expected=proposal.units.flatMap(u=>(u.anchors??[]).map(a=>({...a,proposalId:u.proposalId}))),observed=review.observedAnchors;
 if(!expected.length||!Array.isArray(observed)||observed.length!==expected.length)throw Error('Every named source point must be independently reviewed');
 const named=a=>a&&typeof a.proposalId==='string'&&a.proposalId.trim()&&typeof a.name==='string'&&a.name.trim();
 if(!expected.every(named)||!observed.every(named))throw Error('Nonempty named source feature identity required');
 // Trim for identity comparison only; keep the frozen names and coordinates unchanged in the result.
 const key=a=>JSON.stringify([a.proposalId.trim(),a.name.trim()]);if(new Set(expected.map(key)).size!==expected.length||new Set(observed.map(key)).size!==observed.length)throw Error('Duplicate source feature identity');
 const point=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=0&&p[1]>=0&&p[0]<proposal.width&&p[1]<proposal.height;
 const rows=expected.map(a=>{const v=observed.find(v=>key(v)===key(a));if(!v||v.sourceFeatureMatched!==true||!point(a.point)||!point(v.observedSourcePoint)||JSON.stringify(v.proposedPoint)!==JSON.stringify(a.point)||!Number.isFinite(v.measurementErrorPixels)||v.measurementErrorPixels<0)throw Error('Missing, ambiguous or changed named source feature');
  const distance=Math.hypot(v.observedSourcePoint[0]-a.point[0],v.observedSourcePoint[1]-a.point[1]),upperError=distance+v.measurementErrorPixels;
  if(upperError>tolerance)throw Error('Source-point discrepancy exceeds declared tolerance: '+a.proposalId+'/'+a.name);
  return{proposalId:a.proposalId,name:a.name,proposedPoint:a.point,observedSourcePoint:v.observedSourcePoint,distancePixels:distance,measurementErrorPixels:v.measurementErrorPixels,upperErrorPixels:upperError};
 });
 return{taskId,sourceHash:proposal.sourceHash,proposalSha256,status:'eligible-to-freeze',manualAnchorErrorPixels:tolerance,rows,automaticSemanticConfirmation:false,reviewerIdentityAuthenticated:false,historyModified:false,note:'Eligible only according to the separately recorded human source-feature measurements. This is not pixel detection, authenticated reviewer identity, generation approval, or whole-image acceptance. Unanchored groups still need explicit geometry limitations.'};
}
export async function reviewAnchorPoints(source,proposalPath,destination,options={}){
 const taskId=options.taskId??process.env.CODEX_THREAD_ID;
 if(!taskId||process.env.CODEX_THREAD_ID&&taskId!==process.env.CODEX_THREAD_ID)throw Error('Real current task identity required');
 if(!/\.jpg$/i.test(destination)||path.resolve(destination)===path.resolve(source))throw Error('New diagnostic JPEG required');
 const[input,proposalBytes]=await Promise.all([fs.readFile(source),fs.readFile(proposalPath)]),proposal=JSON.parse(proposalBytes.toString('utf8')),digest=b=>crypto.createHash('sha256').update(b).digest('hex');
 if(proposal.taskId!==taskId||proposal.sourceHash!==digest(input))throw Error('Own proposal with exact source hash required');
 const meta=await sharp(input).metadata();if(meta.width!==proposal.width||meta.height!==proposal.height)throw Error('Source coordinates/dimensions mismatch');
 const anchors=proposal.units.flatMap(u=>(!options.proposalId||u.proposalId===options.proposalId)?(u.anchors??[]).map(a=>({...a,proposalId:u.proposalId})):[]);
 if(!anchors.length||anchors.length>8)throw Error('Select 1..8 actual source anchors for bounded review');
 for(const a of anchors)if(!a.name||!Array.isArray(a.point)||a.point.length!==2||a.point.some(v=>!Number.isFinite(v))||a.point[0]<0||a.point[1]<0||a.point[0]>=meta.width||a.point[1]>=meta.height)throw Error('Named source point outside original image');
 const maxBytes=131072;let contextBudget;
 if(process.env.CODEX_THREAD_ID&&options.contextGuard!==false){contextBudget=await checkContextBudget(await findCurrentHistory(taskId),{taskId,reserveBytes:Math.ceil(maxBytes*4/3)+2048});if(!contextBudget.allowed)throw Error('Viewing context budget exceeded; preserve checkpoint, never rewrite history');}
 const tile=80,scale=2,width=320,height=anchors.length*160,parts=[],rows=[];
 for(let i=0;i<anchors.length;i++){
  const a=anchors[i],w=Math.min(tile,meta.width),h=Math.min(tile,meta.height),left=Math.max(0,Math.min(meta.width-w,Math.floor(a.point[0]-w/2))),top=Math.max(0,Math.min(meta.height-h,Math.floor(a.point[1]-h/2))),crop={left,top,width:w,height:h};
  const plain=await sharp(input).extract(crop).flatten({background:'#eeeeee'}).resize(w*scale,h*scale,{kernel:'nearest'}).png().toBuffer(),x=(a.point[0]-left)*scale,y=(a.point[1]-top)*scale;
  const svg=Buffer.from(`<svg width="${w*scale}" height="${h*scale}" xmlns="http://www.w3.org/2000/svg"><path d="M${x-12} ${y}h24 M${x} ${y-12}v24" fill="none" stroke="black" stroke-width="3"/><path d="M${x-12} ${y}h24 M${x} ${y-12}v24" fill="none" stroke="#00ffff" stroke-width="1"/></svg>`),marked=await sharp(plain).composite([{input:svg,left:0,top:0}]).png().toBuffer();
  parts.push({input:plain,left:0,top:i*160},{input:marked,left:160,top:i*160});rows.push({index:i+1,proposalId:a.proposalId,name:a.name,sourcePoint:a.point,crop,viewScale:scale,unmarkedLeft:0,markedLeft:160,rowTop:i*160,markerPoint:[160+x,i*160+y],sourceFeatureConfirmed:false});
 }
 const png=await sharp({create:{width,height,channels:3,background:'#eeeeee'}}).composite(parts).png().toBuffer();let jpeg;
 for(const quality of[92,85,78,70]){const b=await sharp(png).jpeg({quality,chromaSubsampling:'4:4:4'}).toBuffer();if(b.length<=maxBytes){jpeg=b;break;}}if(!jpeg)throw Error('Diagnostic cannot fit viewing byte budget');
 const report={taskId,kind:'anchor-diagnostic-only',sourcePath:path.resolve(source),sourceSha256:digest(input),proposalPath:path.resolve(proposalPath),proposalSha256:digest(proposalBytes),previewPath:path.resolve(destination),previewBytes:jpeg.length,previewSize:[width,height],previewSha256:digest(jpeg),contextBudget,rows,referencesAllowed:false,productionMaterial:false,automaticallyConfirmsAnchors:false,note:'Each row: unmarked actual source at left; identical source with coordinate crosshair at right. Human review must confirm the named feature. This is not a mask, material, generation reference, automatic semantic measurement or permission to rewrite frozen anchors.'};
 const reportPath=destination.replace(/\.jpg$/i,'.json');for(const p of[destination,reportPath]){try{await fs.stat(p);throw Error('Diagnostic output already exists');}catch(e){if(e.code!=='ENOENT')throw e;}}
 if(digest(await fs.readFile(source))!==report.sourceSha256||digest(await fs.readFile(proposalPath))!==report.proposalSha256)throw Error('Source/proposal changed during review');
 await fs.mkdir(path.dirname(path.resolve(destination)),{recursive:true});await fs.writeFile(destination,jpeg,{flag:'wx'});await fs.writeFile(reportPath,JSON.stringify(report,null,2),{flag:'wx'});return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const args=process.argv.slice(2);if(args[0]==='--check-review'){
 const[,sourcePath,proposalPath,reviewPath]=args;if(!sourcePath||!proposalPath||!reviewPath)throw Error('Usage: --check-review <source.png> <unfrozen-proposal.json> <independent-review.json>');
 const[source,proposalBytes,reviewBytes]=await Promise.all([fs.readFile(sourcePath),fs.readFile(proposalPath),fs.readFile(reviewPath)]),proposal=JSON.parse(proposalBytes.toString('utf8')),review=JSON.parse(reviewBytes.toString('utf8')),digest=b=>crypto.createHash('sha256').update(b).digest('hex'),meta=await sharp(source).metadata();
 if(digest(source)!==proposal.sourceHash||meta.width!==proposal.width||meta.height!==proposal.height||meta.width*meta.height>1500000)throw Error('Actual source changed or exceeds working budget');
 const result=checkSourceAnchorReview(proposal,review,{taskId:process.env.CODEX_THREAD_ID,proposalSha256:digest(proposalBytes)});
 if(digest(await fs.readFile(sourcePath))!==digest(source)||digest(await fs.readFile(proposalPath))!==digest(proposalBytes)||digest(await fs.readFile(reviewPath))!==digest(reviewBytes))throw Error('Source/proposal/review changed during check');
 console.log(JSON.stringify({...result,reviewSha256:digest(reviewBytes)},null,2));
 }else{const[source,proposal,destination,proposalId]=args;if(!source||!proposal||!destination)throw Error('Usage: node scripts/review-anchor-points.mjs <source.png> <proposal.json> <new-diagnostic.jpg> [proposalId]');console.log(JSON.stringify(await reviewAnchorPoints(source,proposal,destination,{proposalId}),null,2));}}
