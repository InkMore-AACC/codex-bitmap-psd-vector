import {EventEmitter} from 'node:events';
import {isCodexWeb} from './external-vector.js';
import path from 'node:path';
import {jobs,safeJob,getJob,saveJob,load,ROOT,now} from './store.js';
import type {Job} from './types.js';
import {appToolsServer,sendToDesktop,DeliveryError} from './app-tools.js';

const events=new EventEmitter();events.setMaxListeners(100);
const listeners=new Map<string,Set<symbol>>();
const lastSeen=new Map<string,string>();
const desktopPipes=new Map<string,string>();
const inFlight=new Map<string,Promise<void>>();
export function connectDesktop(taskId:string,pipePath?:string){
 // Only called by the authenticated local MCP bridge, not the browser.
 if(pipePath){if(!pipePath.startsWith('\\\\.\\pipe\\')||pipePath.length>1000)throw new Error('无效的桌面连接地址');desktopPipes.set(taskId,pipePath);}
 return dispatchStatus(taskId);
}
function pipeFor(taskId:string){return desktopPipes.get(taskId)||process.env.CODEX_APP_TOOLS_PIPE_PATH||''}
export function dispatchStatus(taskId:string){const ready=!!pipeFor(taskId)&&!!appToolsServer();return {automaticWake:ready,listenerActive:!!listeners.get(taskId)?.size,lastSeenAt:lastSeen.get(taskId),mode:'desktop-app-tools',note:ready?'画布按钮会自动发送到绑定的 Codex 对话':'未取得桌面发送接口，请从目标对话重新打开画布'};}
export function needsCodex(j:Job){return j.mode!==1&&(j.type!=='vectorize'||isCodexWeb(j))}
export function dispatchPrompt(j:Job){
 const names={plan:'预分层',layer:'真实分层',revise:'按标注修改',vectorize:'矢量化',photoshop:'交接 Photoshop',illustrator:'交接 Illustrator'};
 return `请处理我刚在分层画布点击的“${names[j.type]}”请求。这是画布按钮自动发送的任务，无需让我再次手动接单。\n`+
 `当前对话 taskId：${j.taskId}\n请求 jobId：${j.id}\n画布 documentId：${j.documentId}\n图片 imageId：${j.imageId}\n输入版本：${j.version}\n`+
 `只处理这个 jobId 及其 imageId 节点，不要执行其他旧请求，也不要沿上下游连线重做其他节点。先读取分层画布技能并核实当前真实 taskId；通过 canvas_get_request 查看状态，任务已取消、失败或完成则停止，已运行则不要重复领取。待处理时用 canvas_claim_request 领取，按冻结原图、图层及意见执行，将实际产物返回同一画布。\n`+
 (isCodexWeb(j)?'本次选择 Vectorizer.com 免费网站 + Codex 操作网页。用当前对话可见浏览器逐层上传 webVector.uploadPath。全部转换完成后进入公开 REVIEW AND DOWNLOAD 结果页，读取完整 URL，再用 canvas_web_vector action=download,reviewUrl,baseVersion 接收已有 SVG 并自动回传画布；接收器不重新上传或转换。不要更换引擎。遇到验证请用户完成，status phase=verification 保留任务；下载受阻用 phase=blocked 明确原因。工具尚未刷新时可通过 bridge/cli.ts 调用同一 download 动作。\n':'')+
 `插件工具未加载时，技能在 ${path.join(ROOT,'plugins/layer-canvas/skills/layer-canvas/SKILL.md')}；相同接口可用 ${path.join(ROOT,'bridge/cli.ts')}，调用方式 node --import tsx bridge/cli.ts <toolName> <arguments.json>（工作目录 ${ROOT}）。不要新建对话、启动另一个推理会话或将排队当作完成。`;
}
export function prepareDispatch(j:Job){if(needsCodex(j)){j.dispatch={state:'sending',updatedAt:now()};j.message='正在自动发送到当前 Codex 对话…';}return j;}
export function dispatchJob(id:string,sender=sendToDesktop):Promise<void>{
 const existing=inFlight.get(id);if(existing)return existing;
 const work=(async()=>{
  const j=getJob(id);
  if(!needsCodex(j)||j.status!=='waiting_codex'||j.dispatch?.state!=='sending')return;
  try{
   if(load(j.documentId).taskId!==j.taskId)throw new DeliveryError('画布与目标对话不匹配');
   await sender(j.taskId,dispatchPrompt(j),pipeFor(j.taskId));
   const fresh=getJob(id);if(fresh.status!=='waiting_codex')return;
   fresh.dispatch={state:'sent',updatedAt:now()};fresh.message='已发送到当前 Codex 对话，等待处理';saveJob(fresh);
  }catch(e){
   const fresh=getJob(id);if(fresh.status!=='waiting_codex')return;
   const uncertain=e instanceof DeliveryError&&e.uncertain;
   fresh.dispatch={state:uncertain?'uncertain':'failed',updatedAt:now(),detail:e instanceof Error?e.message:String(e)};
   fresh.message=uncertain?'发送回执暂未确认，已停止重复发送':'发送到 Codex 失败，图片和修改意见已保留';saveJob(fresh);
  }
 })().finally(()=>inFlight.delete(id));inFlight.set(id,work);return work;
}
export function notifyRequests(taskId:string){events.emit(taskId)}
export async function waitRequests(taskId:string,timeoutMs:number,excludeJobIds:string[],signal?:AbortSignal){
 const until=Date.now()+Math.max(0,Math.min(50000,timeoutMs));
 const available=()=>jobs().filter(j=>j.taskId===taskId&&j.mode!==1&&(j.type!=='vectorize'||isCodexWeb(j))&&['queued','waiting_codex'].includes(j.status)&&!excludeJobIds.includes(j.id)).map(safeJob);
 lastSeen.set(taskId,new Date().toISOString());
 const current=available();if(current.length||timeoutMs===0)return {taskId,available:current.length>0,jobs:current,dispatch:dispatchStatus(taskId)};
 return new Promise(resolve=>{
  const key=Symbol();if(!listeners.has(taskId))listeners.set(taskId,new Set());listeners.get(taskId)!.add(key);
  const finish=()=>{clearTimeout(timer);events.off(taskId,finish);signal?.removeEventListener('abort',finish);listeners.get(taskId)?.delete(key);if(!listeners.get(taskId)?.size)listeners.delete(taskId);const result=available();resolve({taskId,available:result.length>0,jobs:result,dispatch:dispatchStatus(taskId)})};
  const timer=setTimeout(finish,Math.max(0,until-Date.now()));events.once(taskId,finish);signal?.addEventListener('abort',finish,{once:true});if(signal?.aborted)finish();
 });
}
