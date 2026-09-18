/** Real local inference through the HTTP queue; all state is isolated from user canvases. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const engine=process.argv[2]||'supersvg';if(!['supersvg','adavec'].includes(engine))throw new Error('Only local engines are allowed');
const output=path.resolve('test-output','vector-node-'+engine+'-'+Date.now());fs.mkdirSync(output,{recursive:true});
process.env.LAYER_CANVAS_DATA=output;
const {app,TOKEN,BRIDGE_TOKEN,adobe}=await import('../server/index.js');
const {assetPath}=await import('../server/store.js');
const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
async function api(route:string,body?:any,method=body?'POST':'GET'){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Canvas-Token':TOKEN,'X-Canvas-Bridge':BRIDGE_TOKEN},body:body?JSON.stringify(body):undefined});const result:any=await r.json();if(!r.ok)throw new Error(JSON.stringify(result));return result;}
try{
 const file=path.join(output,'fixture.png');await sharp(Buffer.from('<svg width="96" height="96"><circle cx="48" cy="48" r="35" fill="#efb12f"/><circle cx="36" cy="39" r="4"/><circle cx="60" cy="39" r="4"/><path d="M 30 57 Q 48 76 66 57" fill="none" stroke="#552211" stroke-width="4"/></svg>')).png().toFile(file);
 let doc=await api('/api/document?taskId=local-vector-node-'+engine);
 doc=await api(`/api/document/${doc.id}/import-path`,{taskId:doc.taskId,path:file});
 doc.settings.vectorEngine=engine;doc.settings.vectorOptions={supersvg:{pathNum:128,seed:7,refineBatchSize:4},adavec:{segments:64,pathIterations:5,shapeIterations:5}};
 doc=await api(`/api/document/${doc.id}`,{document:doc,expectedRevision:doc.revision},'PUT');
 const source=doc.images[0],started=Date.now();const job=await api(`/api/document/${doc.id}/jobs`,{imageId:source.id,type:'vectorize',useOriginal:true});
 let done:any;
 for(let i=0;i<600;i++){done=(await api(`/api/document/${doc.id}/jobs`)).find((j:any)=>j.id===job.id);if(['completed','failed','cancelled'].includes(done.status))break;await new Promise(r=>setTimeout(r,1000));}
 assert.equal(done.status,'completed',done.message);doc=await api('/api/document?taskId='+doc.taskId);
 assert.equal(doc.images.length,2);const child=doc.images.find((im:any)=>im.id===done.result.imageId);assert.equal(child.parentId,source.id);assert.equal(child.sourceJobId,job.id);assert.equal(doc.images[0].url,source.url);assert.equal(child.status,'vector');
 const svg=fs.readFileSync(assetPath(doc.id,child.vectorUrl),'utf8');assert(!/<image\b/i.test(svg));const rgba=await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();assert.equal(rgba[3],0);
 const result={engine,elapsedSeconds:(Date.now()-started)/1000,jobId:job.id,sourceId:source.id,resultId:child.id,layerCount:child.vectorLayers.length,pureVector:true,transparentCorner:true,sourceUnchanged:true};fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,evidence:output},null,2));
}finally{await adobe.close();server.closeAllConnections();server.close();}
