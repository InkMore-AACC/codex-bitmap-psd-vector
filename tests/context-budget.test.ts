import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore exported JavaScript CLI utility
import {checkContextBudget} from '../scripts/check-context-budget.mjs';
test('context guard counts inline bytes, respects compaction, preserves input and rejects wrong task',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'context-budget-'));
 try{
  const file=path.join(dir,'synthetic.jsonl');
  const image={type:'input_image',image_url:'data:image/png;base64,'+'A'.repeat(9000)};
  const records=[{type:'session_meta',payload:{id:'test'}},{type:'response_item',payload:{type:'custom_tool_call_output',output:[image]}},{type:'event_msg',payload:{duplicateImage:image}}];
  const original=records.map(x=>JSON.stringify(x)).join('\n')+'\n';await fs.writeFile(file,original);
  const before=await checkContextBudget(file,{taskId:'test',reserveBytes:0,envelopeReserveBytes:0,limitBytes:5000});
  assert.equal(before.allowed,false);assert.equal(before.inlineImageBytes,image.image_url.length);assert.equal(await fs.readFile(file,'utf8'),original);
  await assert.rejects(checkContextBudget(file,{taskId:'different'}),/belong/);
  await fs.appendFile(file,JSON.stringify({type:'compacted',payload:{replacement_history:[{type:'message',content:[{type:'input_text',text:'checkpoint'}]}]}})+'\n');
  const after=await checkContextBudget(file,{taskId:'test',reserveBytes:100,envelopeReserveBytes:0,limitBytes:5000});
  assert.equal(after.allowed,true);assert.equal(after.inlineImageBytes,0);assert.equal(after.compactions,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
