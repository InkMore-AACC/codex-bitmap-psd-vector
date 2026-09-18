import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type {CanvasImage} from './types.js';

/** UI marks are never composited onto the input artwork. Coordinates always refer to input image pixels. */
export async function annotationPacket(image:CanvasImage,outputDirectory:string){
 const result=[];
 for(const [index,a] of image.annotations.entries()){
  const p=a.points;if(p.length<2||p.length%2||p.some(v=>!Number.isFinite(v)))throw new Error('标注坐标无效');
  const xs=p.filter((_,i)=>i%2===0),ys=p.filter((_,i)=>i%2===1);
  const radius=a.type==='pen'?(a.brushSize||12)/2:0;
  const x=Math.max(0,Math.min(...xs)-radius),y=Math.max(0,Math.min(...ys)-radius);
  const right=Math.min(image.width,Math.max(...xs)+radius),bottom=Math.min(image.height,Math.max(...ys)+radius);
  const selected=['box','ellipse','pen'].includes(a.type);
  const target=a.type==='arrow'?p.slice(-2):undefined;
  let maskPath:string|undefined;
  if(selected&&right>x&&bottom>y){
   let shape='';
   if(a.type==='box')shape=`<rect x="${Math.min(...xs)}" y="${Math.min(...ys)}" width="${Math.max(...xs)-Math.min(...xs)}" height="${Math.max(...ys)-Math.min(...ys)}" fill="white"/>`;
   if(a.type==='ellipse')shape=`<ellipse cx="${(Math.min(...xs)+Math.max(...xs))/2}" cy="${(Math.min(...ys)+Math.max(...ys))/2}" rx="${(Math.max(...xs)-Math.min(...xs))/2}" ry="${(Math.max(...ys)-Math.min(...ys))/2}" fill="white"/>`;
   if(a.type==='pen')shape=p.length===2?`<circle cx="${p[0]}" cy="${p[1]}" r="${radius}" fill="white"/>`:`<polyline points="${xs.map((v,i)=>`${v},${ys[i]}`).join(' ')}" fill="none" stroke="white" stroke-width="${radius*2}" stroke-linecap="round" stroke-linejoin="round"/>`;
   const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}"><rect width="100%" height="100%" fill="black"/>${shape}</svg>`;
   fs.mkdirSync(outputDirectory,{recursive:true});maskPath=path.join(outputDirectory,`selection-${index}.png`);
   fs.writeFileSync(maskPath,await sharp(Buffer.from(svg)).greyscale().png().toBuffer());
  }
  result.push({id:a.id,imageId:image.id,layerId:a.layerId,coordinateSpace:'image-pixels',imageSize:[image.width,image.height],type:a.type,instruction:a.text,points:p,target,normalizedTarget:target?[target[0]/image.width,target[1]/image.height]:undefined,bounds:selected?[x,y,Math.max(0,right-x),Math.max(0,bottom-y)]:undefined,brushSize:a.brushSize,maskPath,maskMeaning:maskPath?'白色是选区，黑色是保留区；独立蒙版，未画入原图':undefined});
 }
 return result;
}
