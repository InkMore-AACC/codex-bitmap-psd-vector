import type {CanvasImage,Layer,Job} from './types.js';
import {load,getJob,history,save,uid} from './store.js';
export function preserveLayerIdentity(before:CanvasImage,layers:Layer[]){
 if(new Set(layers.map(l=>l.id)).size!==layers.length)throw new Error('图层 ID 不可重复');
 const consumed=new Set<string>();const mapped=layers.map(layer=>{let old=before.layers.find(l=>l.id===layer.id);if(!old){const matches=before.layers.filter(l=>l.name===layer.name&&!consumed.has(l.id));if(matches.length===1)old=matches[0]}if(!old)return layer;consumed.add(old.id);return {...layer,id:old.id,opinion:layer.opinion||old.opinion}});
 const ids=new Set(mapped.map(l=>l.id));if(ids.size!==mapped.length)throw new Error('图层名称匹配造成重复 ID，请提供明确唯一 ID');for(const old of before.layers){if(!ids.has(old.id)&&(old.opinion||before.annotations.some(a=>a.layerId===old.id)))throw Object.assign(new Error(`重建结果丢失了「${old.name}」的关联关系，请保留其图层 ID 或原图层名称`),{status:409})}return mapped;
}
/** All completed outputs branch from the frozen input. Only an unchanged planning node is updated in place. */
export function commitImage(job:Job,prepared:CanvasImage){
 const state=getJob(job.id);if(state.status==='cancelled')throw Object.assign(new Error('请求已取消，未覆盖画布'),{status:409});if(state.status==='completed')throw Object.assign(new Error('请求已经完成'),{status:409});
 const d=load(job.documentId);const index=d.images.findIndex(i=>i.id===job.imageId);if(index<0)throw Object.assign(new Error('来源图片已移除；产物保存在任务目录'),{status:409});
 const prior=d.images.find(i=>i.sourceJobId===job.id);if(prior)throw Object.assign(new Error('该任务的结果节点已经存在'),{status:409});
 const source=d.images[index];const stale=source.version!==job.version;
 history(d);
 if(job.type==='plan'&&!stale){prepared.id=source.id;prepared.x=source.x;prepared.y=source.y;prepared.name=source.name;prepared.version=source.version+1;d.images[index]=prepared}
 else{
  if(d.images.length>=100)throw Object.assign(new Error('画布节点已达100个，产物已保留，请腾出位置后重试'),{status:409});
  prepared.id=uid();prepared.parentId=source.id;prepared.sourceJobId=job.id;prepared.sourceVersion=job.version;prepared.basedOnOlderVersion=stale;prepared.version=0;
  prepared.name=source.name.replace(/\.[^.]+$/,'')+' · '+({plan:'预分层',layer:'PSD 分层',revise:'修改结果',vectorize:'矢量结果',photoshop:'PS 结果',illustrator:'AI 结果'}[job.type]);
  prepared.x=source.x+source.width+100;prepared.y=source.y;
  while(d.images.some(i=>prepared.x<i.x+i.width+40&&prepared.x+prepared.width+40>i.x&&prepared.y<i.y+i.height+40&&prepared.y+prepared.height+40>i.y))prepared.y+=prepared.height+100;
  // Annotation IDs also identify SVG marker definitions; they must be unique between nodes.
  prepared.annotations=prepared.annotations.map(a=>({...a,id:uid()}));
  d.images.push(prepared);
 }
 job.result={...(job.result as object||{}),imageId:prepared.id,parentId:job.type==='plan'&&!stale?undefined:source.id,basedOnOlderVersion:stale};
 d.revision++;return save(d);
}
