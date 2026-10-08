import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BackgroundSourceProtection } from '../shared/generation.js';
import type { GenerationState, GenerationRecord } from './generation.js';
import type { Job } from './types.js';
import { assetPath, dir, getJob } from './store.js';
import { photoshopState } from './photoshop-rebuild.js';
import { validateBackgroundSelectionSnapshot, verifyBackgroundProtectionFiles,
  verifyProtectedBackgroundSnapshot, type BackgroundProtectionInputs, type ProtectedBackgroundProof } from './background-protection-snapshot.js';

const digest=(b:Buffer)=>crypto.createHash('sha256').update(b).digest('hex');
export const backgroundSignature=(v:unknown)=>digest(Buffer.from(JSON.stringify(v)));
const file=(p:string)=>({path:path.resolve(p),hash:digest(fs.readFileSync(p))});
const fail=(s:string)=>Object.assign(new Error(`背景保护：${s}`),{status:400});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const jobBinding=(j:Job)=>({taskId:j.taskId,documentId:j.documentId,imageId:j.imageId,jobId:j.id,
  snapshot:j.snapshot,layerIds:j.layerIds,versions:[j.reconstructionVersion,j.reconstructionWorkflowVersion,j.frameContractVersion],photoshop:j.photoshop});
export function backgroundProtectionPlan(j:Job,s:GenerationState,ids:string[]) {
  if(j.type==='photoshop') {
    const plan=photoshopState(j).plan, entry=plan?.layers.find(l=>ids.length===1 && l.layerId===ids[0]);
    return {config:entry?.sourceProtection,plan,canvas:plan?.canvas,
      background:entry?.content==='background',opaque:entry?.surface==='opaque',normal:entry?.surface!=='screen',
      frame:entry?.frame,route:entry?.route};
  }
  const entry=s.layout?.layers.find(l=>same(l.sourceLayerIds,ids));
  return {config:entry?.sourceProtection,plan:s.layout,canvas:s.layout?.width ?
    {width:s.layout.width,height:s.layout.height!}:{width:j.snapshot.width,height:j.snapshot.height},
    background:ids.length===1 && j.snapshot.layers.find(l=>l.id===ids[0])?.role==='background',
    opaque:true,normal:(entry?.blendMode||'normal')==='normal',frame:undefined,route:undefined};
}
export function validateBackgroundProtectionRoute(j:Job,ids:string[],config:BackgroundSourceProtection|undefined,
  canvas:{width:number;height:number}, frame?:{x:number;y:number;width:number;height:number},
  normal=true,background=ids.length===1 && j.snapshot.layers.find(l=>l.id===ids[0])?.role==='background') {
  if(!config)return;
  if(j.reconstructionVersion!==3 || j.reconstructionWorkflowVersion!==4 ||
    !['layer','revise','photoshop'].includes(j.type) || ids.length!==1 || !normal || !background ||
    j.snapshot.layers.find(l=>l.id===ids[0])?.role!=='background' ||
    (j.type==='photoshop' && j.photoshop?.allowExtraction!==true) ||
    canvas.width!==j.snapshot.width || canvas.height!==j.snapshot.height || canvas.width*canvas.height>1_500_000 ||
    (frame && (frame.x!==0 || frame.y!==0 || frame.width!==canvas.width || frame.height!==canvas.height)))
    throw fail('仅新v4单层normal满幅背景；PS还须明确allowExtraction=true，来源工作画幅须在150万像素内且无需换算');
}
function protectedSource(j:Job) {
  return assetPath(j.documentId,j.snapshot.status==='preview'?j.snapshot.source:j.snapshot.url||j.snapshot.source);
}
function ownSelection(j:Job,p:string) {
  const root=path.join(dir(j.documentId),'jobs',j.id,'background-selections');
  const contained=(target:string)=>{const rel=path.relative(path.resolve(root),target);return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);};
  if(!path.isAbsolute(p)||!contained(path.resolve(p))||!contained(fs.realpathSync(p)))
    throw fail('选区与独审证据必须来自本job的background-selections，不能使用预抠、祖先或其他任务文件');
}
export function backgroundSelectionBinding(j:Job,config:BackgroundSourceProtection) {
  ownSelection(j,config.keepMask.path);ownSelection(j,config.review.path);
  const source=file(protectedSource(j)),keepMask=file(config.keepMask.path),review=file(config.review.path);
  if(source.hash!==config.sourceHash || keepMask.hash!==config.keepMask.hash || review.hash!==config.review.hash)
    throw fail('当前干净来源/选区/独审摘要与生成前冻结的保护计划不符');
  const evidence=JSON.parse(fs.readFileSync(review.path,'utf8'));
  if(evidence.taskId!==j.taskId||evidence.jobId!==j.id||evidence.documentId!==j.documentId||evidence.imageId!==j.imageId||
    evidence.sourceHash!==source.hash||evidence.keepMaskHash!==keepMask.hash||evidence.status!=='accepted'||
    typeof evidence.observation!=='string'||evidence.observation.trim().length<20)
    throw fail('需要同task/job/image的来源与选区独审声明；摘要校验不自动证明选区语义');
  return {source,keepMask,review};
}
export async function preflightBackgroundSelection(j:Job,config:BackgroundSourceProtection,canvas:{width:number;height:number}) {
  const captured=backgroundSelectionBinding(j,config);
  const result=await validateBackgroundSelectionSnapshot(fs.readFileSync(captured.source.path),fs.readFileSync(captured.keepMask.path),canvas);
  if(!same(captured,backgroundSelectionBinding(j,config)))throw fail('准备期间来源或选区已变化');
  return result;
}
export function captureBackgroundBinding(j:Job,s:GenerationState,base:GenerationRecord) {
  if(!same(jobBinding(j),jobBinding(getJob(j.id))))throw fail('当前冻结任务身份/来源/设置已变化，不能沿用旧任务快照');
  const p=backgroundProtectionPlan(j,s,base.sourceLayerIds),q=s.requests.find(r=>r.id===base.requestId);
  if(!p.config || !q?.sourceProtection || !same(q.sourceProtection,p.config) || q.sourceProtectionPlanHash!==backgroundSignature(p.plan))
    throw fail('保护选项必须在本次真实RGB prepare之前冻结，不能事后启用旧候选');
  if(!p.canvas || !p.opaque || !['generate','hybrid',undefined].includes(p.route))throw fail('计划须为完整opaque背景生成路线');
  validateBackgroundProtectionRoute(j,base.sourceLayerIds,p.config,p.canvas,p.frame,p.normal,p.background);
  const full={x:0,y:0,width:p.canvas.width,height:p.canvas.height};
  if(!q.background || q.surface!=='opaque' || (q.blendMode||'normal')!=='normal' || q.role ||
    base.kind || base.derivedAlpha || base.derivedBackground || base.receipt.tool!=='image_gen' || base.isolationProblem ||
    !same(q.frame,full)||!same(base.frame,full)||!same(base.placementFrame||base.frame,full)||
    !same(q.canvas,p.canvas)||!same(base.workingSize,p.canvas))
    throw fail('基底须为本job真实image_gen完整背景登记，不能引用辅助、派生、裁片或重新定位的素材');
  // Source patches cannot repair a parent's displaced geometry. Its own current
  // review is bound into parentRecordHash, invalidating descendants on edits.
  const evidence=base.reviewEvidence;
  if(base.review?.status!=='accepted'||base.review.issues.length||!evidence||
    new Set([evidence.geometry,evidence.appearance,evidence.isolation]).size!==3||
    [evidence.geometry,evidence.appearance,evidence.isolation].some(t=>t.trim().length<12)||
    !evidence.candidateIds.includes(base.id)||new Set(evidence.candidateIds).size!==evidence.candidateIds.length||
    evidence.candidateIds.some(id=>!s.outputs.some(o=>o.id===id&&same(o.sourceLayerIds,base.sourceLayerIds)&&same(o.frame,base.frame)))||
    base.elements?.length!==q.elements.length||new Set(base.elements?.map(e=>e.name)).size!==q.elements.length||
    q.elements.some(name=>!base.elements?.some(e=>e.name===name&&e.status==='matched')))
    throw fail('派生前须先审核真实补全父件的固定结构、接缝连续与排除项；缺失或needs-revision不能靠贴回源选区掩盖');
  if(file(base.comparisonPath).hash!==base.comparisonHash)throw fail('父件审核对比证据已变化，不能继续派生');
  const selection=backgroundSelectionBinding(j,p.config);
  if(file(base.originalPath).hash!==base.hash || file(base.outputPath).hash!==base.hash ||
    file(base.workingPath).hash!==base.workingHash)throw fail('真实父原件或工作件摘要不匹配登记');
  return {inputs:{scope:{taskId:j.taskId,jobId:j.id,documentId:j.documentId,imageId:j.imageId,
    parentGenerationId:base.id,planHash:backgroundSignature(p.plan),requestHash:backgroundSignature(q)},
    source:selection.source,generated:file(base.workingPath),keepMask:selection.keepMask} satisfies BackgroundProtectionInputs,
    review:selection.review,parentRecordHash:backgroundSignature(base),parentOriginal:file(base.originalPath),
    parentToolOutput:file(base.outputPath),jobBinding:backgroundSignature(jobBinding(j))};
}
export type DerivedBackground={binding:ReturnType<typeof captureBackgroundBinding>;proof:ProtectedBackgroundProof};
const verified=new Map<string,string>();
const proofKey=(r:GenerationRecord)=>backgroundSignature({proof:r.derivedBackground,
  hash:r.hash,workingHash:r.workingHash,frame:r.frame,placement:r.placementFrame,size:r.workingSize});
export function verifyBackgroundRecord(j:Job,s:GenerationState,r:GenerationRecord,registered:(id:string)=>GenerationRecord) {
  const d=r.derivedBackground;
  if(r.kind!=='derived-background'||r.receipt.tool!=='derived-background'||!d||r.derivedAlpha)
    throw fail('派生背景必须保留derived-background身份及完整双来源绑定');
  const base=registered(d.binding.inputs.scope.parentGenerationId),current=captureBackgroundBinding(j,s,base);
  if(!same(current,d.binding)||r.receipt.baseGenerationId!==base.id||r.requestId!==base.requestId||
    !same(r.sourceLayerIds,base.sourceLayerIds)||!same(r.frame,base.frame)||!same(r.placementFrame,base.frame)||
    !same(r.workingSize,d.proof.size)||!same(r.originalSize,d.proof.size)||r.hash!==d.proof.outputHash||
    r.workingHash!==d.proof.outputHash||r.backgroundPadding||r.backgroundOpacity||r.alignment||r.autoAlignment)
    throw fail('派生来源/位置/计划/父登记已变化；不能沿用旧审核或合成');
  verifyBackgroundProtectionFiles(current.inputs);
  if(file(r.originalPath).hash!==r.hash||file(r.workingPath).hash!==r.workingHash)
    throw fail('派生背景真实文件已改变');
  if(file(r.comparisonPath).hash!==r.comparisonHash)
    throw fail('派生背景本件对比证据已变化，不能沿用接缝审核或合成');
  if(verified.get(r.id)!==proofKey(r))throw fail('派生背景尚未从固定来源字节完成消费前验证');
  return current;
}
/** Parent approval and exact S-or-G pixels do not approve a mixed contour seam. */
export function requireDerivedBackgroundReview(s:GenerationState,r:GenerationRecord) {
  if(r.kind!=='derived-background'&&!r.derivedBackground)return;
  const q=s.requests.find(q=>q.id===r.requestId),e=r.reviewEvidence;
  if(!q||r.review?.status!=='accepted'||r.review.issues.length||!e||
    new Set([e.geometry,e.appearance,e.isolation]).size!==3||
    [e.geometry,e.appearance,e.isolation].some(t=>t.trim().length<12)||
    !e.candidateIds.includes(r.id)||new Set(e.candidateIds).size!==e.candidateIds.length||
    e.candidateIds.some(id=>!s.outputs.some(o=>o.id===id&&same(o.sourceLayerIds,r.sourceLayerIds)&&same(o.frame,r.frame)))||
    r.elements?.length!==q.elements.length||new Set(r.elements?.map(e=>e.name)).size!==q.elements.length||
    q.elements.some(name=>!r.elements?.some(e=>e.name===name&&e.status==='matched')))
    throw fail('派生背景本件接缝审核须accepted，缺失或needs-revision不能进入合成、回传或PS素材消费；父件通过和源像素零差不能替代本件轮廓审核');
}
export async function primeBackgroundRecord(j:Job,s:GenerationState,r:GenerationRecord,registered:(id:string)=>GenerationRecord) {
  if(!r.derivedBackground)throw fail('派生背景缺少来源绑定');
  const base=registered(r.derivedBackground.binding.inputs.scope.parentGenerationId),binding=captureBackgroundBinding(j,s,base);
  if(!same(binding,r.derivedBackground.binding))throw fail('派生背景消费前来源绑定不符');
  const key=proofKey(r);
  await verifyProtectedBackgroundSnapshot(binding.inputs,r.derivedBackground.proof,fs.readFileSync(r.workingPath));
  if(!same(binding,captureBackgroundBinding(j,s,registered(base.id)))||key!==proofKey(r))
    throw fail('消费期间完整派生绑定已变化');
  verified.set(r.id,key);
  verifyBackgroundRecord(j,s,r,registered);
}
