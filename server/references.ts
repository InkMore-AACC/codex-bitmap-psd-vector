import path from 'node:path';
import {load,json,dir,assetPath} from './store.js';
import type {CanvasImage} from './types.js';

// Reading provenance never schedules operations or imports ancestor opinions.
export function originalReference(documentId:string,current:CanvasImage){
  const document=load(documentId);
  const archived=json<Record<string,CanvasImage>>(path.join(dir(documentId),'deleted-images.json'),{});
  let image=current;
  const visited=new Set([image.id]);
  while(image.parentId){
    const parent=document.images.find(i=>i.id===image.parentId)||archived[image.parentId];
    if(!parent||visited.has(parent.id))break;
    visited.add(parent.id);image=parent;
  }
  return {imageId:image.id,url:image.source,path:assetPath(documentId,image.source),width:image.width,height:image.height,complete:!image.parentId,readOnly:true,role:'auxiliary' as const};
}
