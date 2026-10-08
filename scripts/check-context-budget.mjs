import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';
import {pathToFileURL} from 'node:url';

const MiB=1024*1024;
export async function findCurrentHistory(taskId,codexHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')){
 if(!/^[a-f0-9-]{36}$/i.test(taskId))throw Error('Invalid current task identity');
 const folder=path.join(codexHome,'sessions');
 const entries=await fs.promises.readdir(folder,{recursive:true});
 const matches=entries.filter(name=>name.endsWith('-'+taskId+'.jsonl'));
 if(matches.length!==1)throw Error('Cannot uniquely locate current history; preserve checkpoint and inspect context');
 return path.join(folder,matches[0]);
}
function imageBytes(value){
 if(Array.isArray(value))return value.reduce((sum,v)=>sum+imageBytes(v),0);
 if(!value||typeof value!=='object')return 0;
 let total=0;
 for(const [k,v] of Object.entries(value)){
  if(k==='image_url'&&typeof v==='string'&&v.startsWith('data:'))total+=Buffer.byteLength(v);
  else if(k==='data'&&value.type==='image'&&typeof v==='string')total+=Buffer.byteLength(v);
  else if(v&&typeof v==='object')total+=imageBytes(v);
 }
 return total;
}
// Read only. This is an estimate and a conservative workflow budget, not a server limit.
export async function checkContextBudget(history,{taskId,reserveBytes=512*1024,limitBytes=16*MiB,envelopeReserveBytes=4*MiB}={}){
 if(!taskId)throw Error('Real current taskId is required');
 for(const n of [reserveBytes,limitBytes,envelopeReserveBytes])if(!Number.isSafeInteger(n)||n<0)throw Error('Byte budgets must be nonnegative integers');
 let seenTask=null,bytes=0,images=0,items=0,compactions=0;
 const lines=readline.createInterface({input:fs.createReadStream(history),crlfDelay:Infinity});
 for await(const line of lines){
  if(!line.trim())continue;
  const record=JSON.parse(line);if(!record||typeof record!=='object')continue;
  if(record.type==='session_meta'){seenTask=record.payload?.id;if(seenTask!==taskId)throw Error('History does not belong to the current task');if(record.payload?.history_base)throw Error('Inherited history requires a lineage-aware audit');}
  if(/rollback|rolled_back/i.test(record.type||'')||/rollback|rolled_back/i.test(record.payload?.type||''))throw Error('Rolled-back history requires a lineage-aware audit');
  if(record.type==='compacted'){
   const history=record.payload?.replacement_history;
   if(!Array.isArray(history))throw Error('Unsupported compaction shape; cannot safely estimate');
   bytes=Buffer.byteLength(JSON.stringify(history));images=imageBytes(history);items=history.length;compactions++;
  }else if(record.type==='response_item'){
   bytes+=Buffer.byteLength(JSON.stringify(record.payload));images+=imageBytes(record.payload);items++;
  }
 }
 if(seenTask!==taskId)throw Error('Missing current task identity');
 const projectedBytes=bytes+reserveBytes+envelopeReserveBytes;
 return {taskId,activeHistoryEstimateBytes:bytes,inlineImageBytes:images,items,compactions,reserveBytes,envelopeReserveBytes,projectedBytes,limitBytes,allowed:projectedBytes<=limitBytes,note:'只读估算；不等于实际HTTP请求尺寸，也不能排除其他400原因。超预算时先保存检查点，使用官方上下文管理；禁止改写历史或盲目重试。'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [history,reserveMiB='0.5']=process.argv.slice(2);
 if(!history)throw Error('Usage: node scripts/check-context-budget.mjs <current-rollout.jsonl> [upcoming-MiB]');
 const result=await checkContextBudget(history,{taskId:process.env.CODEX_THREAD_ID,reserveBytes:Math.ceil(Number(reserveMiB)*MiB)});
 console.log(JSON.stringify(result,null,2));if(!result.allowed)process.exitCode=2;
}
