import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {ROOT} from './store.js';
export function pythonPath(){const candidates=[process.env.LAYER_CANVAS_PYTHON,path.join(ROOT,'.runtime','python','Scripts','python.exe'),path.join(ROOT,'.runtime','python','python.exe')];return candidates.find(p=>p&&fs.existsSync(p))}
export async function worker(args:string[],signal?:AbortSignal):Promise<any>{
 const python=pythonPath();if(!python)throw new Error('本地模型运行环境尚未安装，请运行 scripts/setup-models.ps1');
 if(signal?.aborted)throw new Error('已取消');
 return new Promise((resolve,reject)=>{
  const proc=spawn(python,['-X','utf8',path.join(ROOT,'python','worker.py'),...args],{cwd:ROOT,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});let out='',err='',stopped='';
  const stop=(reason:string)=>{if(stopped)return;stopped=reason;if(proc.pid&&process.platform==='win32')execFile('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true},()=>{});else proc.kill();};
  const abort=()=>stop('已取消');signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>stop('本地模型超时（20分钟）'),20*60*1000);
  const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort)};
  proc.stdout.on('data',b=>{out+=b.toString();if(out.length>4e6)stop('模型输出超出限制')});proc.stderr.on('data',b=>{err=(err+b.toString()).slice(-6000)});
  proc.on('error',e=>{cleanup();reject(e)});
  proc.on('close',code=>{cleanup();if(stopped)return reject(new Error(stopped));if(code!==0)return reject(new Error(`本地模型执行失败：${err||out}`));try{const lines=out.trim().split(/\r?\n/);const result=JSON.parse(lines[lines.length-1]);if(result.error)throw new Error(result.error);resolve(result)}catch(e){reject(new Error('模型未返回有效结果：'+out.slice(-1000)))}});
  if(signal?.aborted)abort();
 });
}
let cache:any=null;let timestamp=0;
export async function modelStatus(){if(cache&&Date.now()-timestamp<15000)return cache;try{cache=await worker(['status']);timestamp=Date.now();return cache}catch(e:any){return {available:false,message:e.message}}}
