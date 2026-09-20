import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

process.env.LAYER_CANVAS_DATA=path.resolve('test-output','long-path-'+crypto.randomUUID(),'a'.repeat(70),'b'.repeat(70));
const {getByTask,writeAsset,save,uid}=await import('../server/store.js');
const {webVectorPacket}=await import('../server/external-vector.js');
const {annotationPacket}=await import('../server/annotations.js');
const {renderImage,renderStyledLayer,exportPsd,importImage}=await import('../server/media.js');

test('web uploads and annotation masks work beyond Windows legacy path length',async()=>{
  const d=getByTask('long_path_fixture');
  const source=writeAsset(d.id,await sharp({create:{width:20,height:20,channels:4,background:'#f00'}}).png().toBuffer(),'.png');
  const image:any={id:uid(),name:'fixture',source,url:source,width:20,height:20,x:0,y:0,layers:[],annotations:[{id:'mark',type:'box',layerId:null,points:[1,1,10,10],text:'test'}],opinion:'',version:1,status:'original'};
  d.images.push(image);save(d);
  const job:any={id:uid(),documentId:d.id,taskId:d.taskId,imageId:image.id,snapshot:image,type:'vectorize',engine:'vectorizerCom',webMode:'codex'};
  const packet=await webVectorPacket(job);
  assert.ok(packet);assert.ok(packet.inputs[0].uploadPath.length>260);
  assert.equal((await sharp(fs.readFileSync(packet.inputs[0].uploadPath)).metadata()).width,20);
  const annotations=await annotationPacket(image,packet.outputDirectory);
  assert.ok(annotations[0].maskPath!.length>260);
  assert.equal((await sharp(fs.readFileSync(annotations[0].maskPath!)).metadata()).width,20);
  assert.equal((await sharp(await renderImage(d.id,image)).metadata()).width,20);
  image.layers=[{id:uid(),name:'主体',url:source,x:0,y:0,width:20,height:20,visible:true,opacity:1,opinion:'',disposition:'keep',kind:'raster',psdStyle:{stroke:{color:'#0000ff',size:1}}}];
  assert.equal((await sharp(await renderImage(d.id,image)).metadata()).width,20);
  assert.equal((await sharp(await renderStyledLayer(d.id,image.layers[0],20,20)).metadata()).width,20);
  const imported=await importImage(d,await exportPsd(d.id,image),'roundtrip.psd');
  assert.equal(imported.layers.length,1);assert.equal(imported.width,20);
});
