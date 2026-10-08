import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { readPsd, writePsdBuffer, type Layer as PsdLayer } from 'ag-psd';
import './media.js';
import { type PhotoshopPlan, photoshopGroupName } from '../shared/photoshop.js';
import { validateNativeGeometryRecipe } from '../shared/native-geometry.js';
import { GENERATION_PIXEL_BUDGET } from '../shared/generation-geometry.js';
import { opticalPartError } from '../shared/optical-parts.js';
import { type AdobeConnector, scopedAdobePath } from './adobe.js';
import { uid } from './store.js';

type Entry = PhotoshopPlan['layers'][number];
const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const metadata = (bytes: Buffer) => readPsd(bytes,{skipLayerImageData:true,skipCompositeImageData:true,skipThumbnail:true});
export function validateNativeGeometryEntry(entry: Entry) {
  if (!entry.nativeGeometry) return;
  if (entry.nativeGeometry.version!==1) throw opticalPartError('PS实体几何仅支持配方v1；连续薄膜须使用已实现的nativeFilm路径，不能将普通v2薄膜变成不透明实体');
  if (entry.route!=='native'||entry.content!=='shape'||entry.editable!=='native-shape'||entry.surface!=='transparent'||
      entry.opticalPart?.version!==2||entry.opticalPart.kind!=='opaque-structure'||entry.textTargets.length||entry.nativeFallback||
      entry.nativeFilm||entry.nativeTextPlane||entry.contourSearch||entry.sourceProtection)
    throw opticalPartError('原生实体几何仅用于native/shape/native-shape独立v2实体分件；不用于文字、薄膜、光效、背景或fallback');
  validateNativeGeometryRecipe(entry.nativeGeometry,entry.frame);
}
export function prepareNativeGeometryPsd(plan: PhotoshopPlan, layerId: string) {
  const entry=plan.layers.find(l=>l.layerId===layerId);
  if (!entry?.nativeGeometry||!plan.canvas) throw opticalPartError('缺少冻结原生实体几何配方或PS画布');
  validateNativeGeometryEntry(entry);
  if (plan.canvas.width*plan.canvas.height>GENERATION_PIXEL_BUDGET)
    throw opticalPartError('原生实体几何工作画布含留白不得超过150万像素');
  const f=entry.frame;
  const children: PsdLayer[]=entry.nativeGeometry.shapes.map(s=>{
    const canvas=createCanvas(f.width,f.height),ctx=canvas.getContext('2d');
    ctx.beginPath();
    for (const points of [s.outer,s.hole].filter(p=>!!p)) {
      ctx.moveTo(points![0][0]-f.x,points![0][1]-f.y);
      for (const p of points!.slice(1)) ctx.lineTo(p[0]-f.x,p[1]-f.y);
      ctx.closePath();
    }
    ctx.fillStyle=`rgb(${s.color.join(',')})`;ctx.fill('evenodd');
    return {name:s.name,left:f.x,top:f.y,right:f.x+f.width,bottom:f.y+f.height,opacity:1,blendMode:'normal',canvas:canvas as any,
      vectorFill:{type:'color',color:{r:s.color[0],g:s.color[1],b:s.color[2]}},
      vectorMask:{fillStartsWithAllPixels:false,paths:[s.outer,...(s.hole?[s.hole]:[])].map((points,i)=>({open:false,
        fillRule:'non-zero',operation:i?'subtract':'combine',knots:points.map(p=>({linked:false,points:[p[0],p[1],p[0],p[1],p[0],p[1]]}))}))}};
  });
  return writePsdBuffer({...plan.canvas,channels:4,bitsPerChannel:8,colorMode:3,
    children:[{name:photoshopGroupName(layerId),children,opacity:1,blendMode:'normal'}]});
}

/** This is execution geometry, never source visual acceptance. Both partial and final inspection enforce it. */
export function verifyNativeGeometryGroup(group: PsdLayer|undefined,entry: Entry) {
  if (!entry.nativeGeometry) return;
  validateNativeGeometryEntry(entry);
  const fail=()=>{throw opticalPartError(`「${entry.name}」原生实体几何实色/路径/透明孔与冻结配方不符`);};
  if (!group||group.hidden||(group.opacity??1)!==1||group.blendMode&&group.blendMode!=='normal'||
      group.effects||group.mask||group.vectorMask||group.children?.length!==entry.nativeGeometry.shapes.length) return fail();
  for (const [i,s] of entry.nativeGeometry.shapes.entries()) {
    const l=group.children[i],fill=l.vectorFill,mask=l.vectorMask;
    if (l.name!==s.name||l.hidden||(l.opacity??1)!==1||l.blendMode&&l.blendMode!=='normal'||l.text||l.children||l.effects||l.mask||
        l.vectorStroke?.strokeEnabled||l.vectorStroke?.fillEnabled===false||!fill||fill.type!=='color'||!('r' in fill.color)||
        [fill.color.r,fill.color.g,fill.color.b].some((v,k)=>!Number.isFinite(v)||Math.abs(v-s.color[k])>0.01)||
        !mask||mask.disable||mask.invert||mask.fillStartsWithAllPixels||mask.paths.length!==(s.hole?2:1)) return fail();
    for (const [n,points] of [s.outer,...(s.hole?[s.hole]:[])].entries()) {
      const p=mask.paths[n];
      if (p.open||p.fillRule!=='non-zero'||(p.operation??'combine')!==(n?'subtract':'combine')||p.knots.length!==4||
          p.knots.some((k,j)=>k.points.length!==6||k.points.some((v,t)=>!Number.isFinite(v)||Math.abs(v-points[j][t%2])>0.01))) return fail();
    }
  }
}

/** Real PS only on new, task-scoped copies with an empty target; retain and restore all existing documents. */
export async function renderNativeGeometry(adobe: AdobeConnector,folder: string,input: string,plan: PhotoshopPlan,layerId: string) {
  scopedAdobePath(folder,input,true);
  if (path.extname(input).toLowerCase()!=='.psd') throw opticalPartError('原生实体几何输入须为本job PSD');
  const bytes=fs.readFileSync(input),psd=metadata(bytes),entry=plan.layers.find(l=>l.layerId===layerId);
  if (!entry?.nativeGeometry||!plan.canvas||psd.width!==plan.canvas.width||psd.height!==plan.canvas.height)
    throw opticalPartError('原生实体几何输入画布须匹配冻结计划');
  const groups=psd.children?.filter(g=>g.name===photoshopGroupName(layerId));
  if (groups?.length!==1||groups[0].children?.length!==0)
    throw opticalPartError('原生实体几何只写入本任务空的目标组，已有内容必须保留');
  const tag=uid(),source=path.join(folder,`geometry-source-${tag}.psd`),output=path.join(folder,`geometry-native-${tag}.psd`),
    working=path.join(folder,`geometry-work-${tag}.psd`),report=path.join(folder,`geometry-native-${tag}.json`),script=path.join(folder,`geometry-native-${tag}.jsx`);
  fs.writeFileSync(source,prepareNativeGeometryPsd(plan,layerId),{flag:'wx'});fs.copyFileSync(input,working,fs.constants.COPYFILE_EXCL);
  const q=(v: unknown)=>JSON.stringify(v).replace(/\u2028|\u2029/g,' ');
  fs.writeFileSync(script,`#target photoshop
(function(){var before=app.documents.length,prior=before?app.activeDocument:null,dialogs=app.displayDialogs,d=null,src=null;
try{app.displayDialogs=DialogModes.NO;src=app.open(new File(${q(source)}));d=app.open(new File(${q(working)}));
var target=null;for(var i=0;i<d.layerSets.length;i++)if(d.layerSets[i].name===${q(photoshopGroupName(layerId))}){if(target)throw Error('Duplicate target');target=d.layerSets[i];}
if(!target||target.layers.length)throw Error('Target must be empty');target.blendMode=BlendMode.NORMAL;target.opacity=100;target.visible=true;
app.activeDocument=src;for(var j=0;j<src.layerSets[0].layers.length;j++)src.layerSets[0].layers[j].duplicate(target,ElementPlacement.PLACEATEND);app.activeDocument=d;
var save=new PhotoshopSaveOptions();save.layers=true;save.embedColorProfile=true;d.saveAs(new File(${q(output)}),save,true,Extension.LOWERCASE);
d.close(SaveOptions.DONOTSAVECHANGES);d=null;src.close(SaveOptions.DONOTSAVECHANGES);src=null;
var f=new File(${q(report)});f.encoding='UTF8';f.open('w');f.write('{"nativePhotoshopVersion":"'+app.version+'","before":'+before+',"after":'+app.documents.length+'}');f.close();
}finally{if(d)d.close(SaveOptions.DONOTSAVECHANGES);if(src)src.close(SaveOptions.DONOTSAVECHANGES);app.displayDialogs=dialogs;if(prior)try{app.activeDocument=prior;}catch(e){}}})();`,{flag:'wx'});
  await adobe.executeScript('photoshop',script,folder,[output,report]);
  if (digest(fs.readFileSync(input))!==digest(bytes)) throw opticalPartError('原生实体几何制作期间输入PSD变化，保留新文件但不提交');
  const actual=metadata(fs.readFileSync(output));
  if(actual.width!==psd.width||actual.height!==psd.height) throw opticalPartError('实际PS原生实体几何画布变化');
  const actualGroups=actual.children?.filter(g=>g.name===photoshopGroupName(layerId));
  if(actualGroups?.length!==1) throw opticalPartError('实际PS原生实体几何分组缺失或重复');
  verifyNativeGeometryGroup(actualGroups[0],entry);
  const facts=JSON.parse(fs.readFileSync(report,'utf8').replace(/^\uFEFF/,''));
  if(facts.before!==facts.after||!facts.nativePhotoshopVersion) throw opticalPartError('原生实体几何未保持已有PS文档状态');
  return {artifactPath:output,inputPath:input,inputHash:digest(bytes),artifactHash:digest(fs.readFileSync(output)),sourcePath:source,
    sourceHash:digest(fs.readFileSync(source)),reportPath:report,facts,planHash:digest(Buffer.from(JSON.stringify(plan))),
    recipeHash:digest(Buffer.from(JSON.stringify(entry.nativeGeometry))),sourceVisualAccepted:false,
    note:'真实PS在新副本制作可编辑实色四边形及透明孔；仍须inspect实际alpha、与源形状对照及整体验收，不是image_gen。'};
}
