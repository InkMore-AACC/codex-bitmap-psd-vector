import crypto from 'node:crypto';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { validateNativeGeometryRecipe, type NativeGeometryRecipe } from '../shared/native-geometry.js';
import { GENERATION_PIXEL_BUDGET } from '../shared/generation-geometry.js';
import { filePlacement } from './generation-placement.js';
import type { Job } from './types.js';
import type { GenerationRecord, GenerationState } from './generation.js';

type Frame = { x: number; y: number; width: number; height: number };
const digest = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
export const nativeGeometrySignature = (v: unknown) => digest(Buffer.from(JSON.stringify(v)));
export const NATIVE_GEOMETRY_ALGORITHM = 'native-opaque-quadrilaterals-v1';
export const NATIVE_FILM_GEOMETRY_ALGORITHM = 'native-tinted-film-quadrilateral-v2';
const algorithm = (r:NativeGeometryRecipe) => r.version===3 ? 'native-tinted-film-convex-polygon-v4' : r.version===2 ? r.shapes[0].cutouts ? 'native-tinted-film-cutouts-v3' : NATIVE_FILM_GEOMETRY_ALGORITHM : NATIVE_GEOMETRY_ALGORITHM;
/** Entire transparent carrier. No source pixels, masks, cropped outlines or model output are used. */
export function renderNativeGeometryRaster(recipe: NativeGeometryRecipe, frame: Frame, size: { width: number; height: number }) {
  validateNativeGeometryRecipe(recipe, frame);
  if (![size.width,size.height].every(v=>Number.isSafeInteger(v)&&v>0)||size.width*size.height>GENERATION_PIXEL_BUDGET)
    throw new Error('原生实体几何完整承载不得超过150万工作像素');
  if (Math.abs(size.width/size.height-frame.width/frame.height)>1/Math.min(size.width,size.height))
    throw new Error('原生实体几何承载须与冻结画幅统一比例，不能非等比拉伸');
  const canvas=createCanvas(size.width,size.height),ctx=canvas.getContext('2d'),scale=Math.min(size.width/frame.width,size.height/frame.height);
  ctx.translate((size.width-frame.width*scale)/2-frame.x*scale,(size.height-frame.height*scale)/2-frame.y*scale);ctx.scale(scale,scale);
  // Recipe shapes follow PSD top-to-bottom ordering; canvas paints bottom first.
  for(const s of [...recipe.shapes].reverse()) {
    ctx.beginPath();
    for(const points of [s.outer,s.hole].filter(p=>!!p)) {
      ctx.moveTo(...points![0]);for(const p of points!.slice(1))ctx.lineTo(...p);ctx.closePath();
    }
    for(const c of s.cutouts||[]){ctx.moveTo(c.center[0]+c.radiusX*Math.cos(c.angle*Math.PI/180),c.center[1]+c.radiusX*Math.sin(c.angle*Math.PI/180));ctx.ellipse(c.center[0],c.center[1],c.radiusX,c.radiusY,c.angle*Math.PI/180,0,2*Math.PI);ctx.closePath();}
    if(s.gradient) {
      const angle=-s.gradient.angle*Math.PI/180,dx=Math.cos(angle),dy=Math.sin(angle),radius=(Math.abs(dx)*frame.width+Math.abs(dy)*frame.height)/2;
      const cx=frame.x+frame.width/2,cy=frame.y+frame.height/2;
      const gradient=ctx.createLinearGradient(cx-dx*radius,cy-dy*radius,cx+dx*radius,cy+dy*radius);
      for(const stop of s.gradient.stops)gradient.addColorStop(stop.position,`rgba(${s.color.join(',')},${stop.alpha/255})`);
      ctx.fillStyle=gradient;
    } else ctx.fillStyle=`rgb(${s.color.join(',')})`;
    ctx.fill('evenodd');
  }
  const bytes=canvas.toBuffer('image/png');
  return {bytes,proof:{algorithm:algorithm(recipe),recipeHash:nativeGeometrySignature(recipe),frame,size,outputHash:digest(bytes),sourceVisualAccepted:false}};
}
export function verifyNativeGeometryRecord(j: Job,state: GenerationState,r: GenerationRecord) {
  const q=state.requests.find(q=>q.id===r.requestId),entry=state.layout?.layers.find(l=>JSON.stringify(l.sourceLayerIds)===JSON.stringify(r.sourceLayerIds));
  if (r.kind!=='native-geometry'||r.receipt.tool!=='native-geometry-renderer'||q?.role!=='native-geometry'||
      !q.nativeGeometry||!q.carrier||!entry?.nativeGeometry||j.type==='photoshop'||q.background||q.surface!=='transparent'||
      (q.blendMode||'normal')!=='normal'||JSON.stringify(q.nativeGeometry)!==JSON.stringify(entry.nativeGeometry)||
      q.referencePaths.some((p,i)=>!fs.existsSync(p)||digest(fs.readFileSync(p))!==q.referenceHashes[i])||
      !r.nativeGeometryProof||!fs.existsSync(r.nativeGeometryProof.path)||digest(fs.readFileSync(r.nativeGeometryProof.path))!==r.nativeGeometryProof.hash)
    throw new Error('原生实体几何登记身份/冻结计划/渲染证明不匹配');
  validateNativeGeometryRecipe(q.nativeGeometry,q.frame);
  const p=JSON.parse(fs.readFileSync(r.nativeGeometryProof.path,'utf8'));
  if (p.algorithm!==algorithm(q.nativeGeometry)||p.taskId!==j.taskId||p.jobId!==j.id||p.requestId!==q.id||
      p.requestHash!==nativeGeometrySignature(q)||p.recipeHash!==nativeGeometrySignature(q.nativeGeometry)||
      p.outputHash!==r.hash||JSON.stringify(p.size)!==JSON.stringify(r.originalSize)||
      JSON.stringify(p.frame)!==JSON.stringify(q.carrier.frame)||
      JSON.stringify(r.placementFrame)!==JSON.stringify(filePlacement(r.workingSize,q.carrier.frame)))
    throw new Error('原生实体几何证明与当前任务/完整文件/冻结位置不一致');
}
