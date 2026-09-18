import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
process.env.LAYER_CANVAS_DATA=path.resolve('test-output/dispatch-'+crypto.randomUUID());
const {app,TOKEN,BRIDGE_TOKEN,adobe}=await import('../server/index.js');
const {getByTask,save,getJob,saveJob}=await import('../server/store.js');
const {dispatchJob,prepareDispatch,needsCodex}=await import('../server/dispatch.js');
const {DeliveryError}=await import('../server/app-tools.js');
const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
const base=`http://127.0.0.1:${(server.address() as any).port}`;
after(async()=>{await adobe.close();server.closeAllConnections();server.close()});
async function api(route:string,body:any,internal=false){const r=await fetch(base+route,{method:'POST',headers:{'X-Canvas-Token':TOKEN,'Content-Type':'application/json',...(internal?{'X-Canvas-Bridge':BRIDGE_TOKEN}:{})},body:JSON.stringify(body)});return {status:r.status,value:await r.json() as any}}
function fixture(){const d=getByTask(crypto.randomUUID());d.settings.vectorizerComMode='codex';d.images=[{id:crypto.randomUUID(),name:'测试图片',source:'/fixture.png',url:'/fixture.png',width:32,height:24,x:0,y:0,layers:[],annotations:[],opinion:'冻结意见',status:'original',version:3}];save(d);return d}
const tick=()=>new Promise(r=>setTimeout(r,20));
async function settle(id:string){for(let i=0;i<50;i++){if(getJob(id).dispatch?.state!=='sending')return getJob(id);await tick()}throw new Error('dispatch did not settle')}

test('button sends once to the owning idle thread without listener, not the server launch thread',async()=>{
 const d=fixture(),calls:any[]=[];let release!:()=>void;
 app.locals.codexSender=async(...args:any[])=>{calls.push(args);await new Promise<void>(r=>release=r)};
 const response=await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'vectorize'});assert.equal(response.status,202);
 const j=response.value;assert.equal(j.dispatch.state,'sending');
 for(let n=0;n<30&&!release;n++)await tick();assert.equal(calls.length,1);assert.equal(calls[0][0],d.taskId);assert.notEqual(calls[0][0],process.env.CODEX_THREAD_ID);
 assert.ok(calls[0][1].includes(j.id));assert.ok(calls[0][1].includes(d.images[0].id));assert.match(calls[0][1],/Codex 操作网页/);
 const duplicate=dispatchJob(j.id,app.locals.codexSender);release();await duplicate;
 assert.equal((await settle(j.id)).dispatch?.state,'sent');await dispatchJob(j.id,app.locals.codexSender);assert.equal(calls.length,1);
 assert.equal((await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'vectorize'})).status,409);
 assert.equal(needsCodex({...getJob(j.id),webMode:'auto'}),false);assert.equal(needsCodex({...getJob(j.id),engine:'recraft'}),false);
 const other=fixture();app.locals.codexSender=async(...args:any[])=>{calls.push(args)};
 const second=(await api(`/api/document/${other.id}/jobs`,{imageId:other.images[0].id,type:'plan'})).value;await settle(second.id);assert.equal(calls[1][0],other.taskId);assert(!calls[1][1].includes(j.id));
});

test('claim or cancellation during sending never regresses into waiting or overwrites its message',async()=>{
 for(const action of ['claim','cancel']){
  const d=fixture();let release!:()=>void;app.locals.codexSender=async()=>{await new Promise<void>(r=>release=r)};
  const j=(await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'vectorize'})).value;
  for(let n=0;n<30&&!release;n++)await tick();assert.ok(release);
  const done=await api(`/api/jobs/${j.id}/${action}`,{taskId:d.taskId},true);assert.equal(done.status,200);
  const waiting=dispatchJob(j.id,app.locals.codexSender);release();await waiting;
  assert.equal(getJob(j.id).status,action==='claim'?'running':'cancelled');assert.equal(getJob(j.id).message,done.value.message);
 }
});

test('failed and uncertain sends are explicit, no automatic retries and no old-job delivery',async()=>{
 for(const uncertain of [false,true]){
  const d=fixture();let count=0;app.locals.codexSender=async()=>{count++;throw new DeliveryError('模拟连接失败',uncertain)};
  const j=(await api(`/api/document/${d.id}/jobs`,{imageId:d.images[0].id,type:'vectorize'})).value;
  const done=await settle(j.id);assert.equal(done.dispatch?.state,uncertain?'uncertain':'failed');assert.equal(done.dispatch?.detail,'模拟连接失败');
  await dispatchJob(j.id,app.locals.codexSender);assert.equal(count,1);
  const old={...done,id:crypto.randomUUID(),dispatch:undefined};saveJob(old);await dispatchJob(old.id,app.locals.codexSender);assert.equal(count,1);
 }
});

test('desktop connection refresh is internal only and never exposed to browser status',async()=>{
 const d=fixture(),body={taskId:d.taskId,pipePath:'\\\\.\\pipe\\canvas-test'};
 assert.equal((await api('/api/dispatch/connect',body)).status,403);
 const result=await api('/api/dispatch/connect',body,true);assert.equal(result.status,200);assert(!JSON.stringify(result.value).includes('canvas-test'));
 const j=prepareDispatch({mode:2,type:'vectorize',engine:'vectorizerCom',webMode:'auto'} as any);assert.equal(j.dispatch,undefined);
});
