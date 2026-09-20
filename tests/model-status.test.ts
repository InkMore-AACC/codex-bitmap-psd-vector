import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createModelStatusReader} from '../server/models.js';

test('concurrent status requests share one probe and expire after 15 seconds',async()=>{
 let calls=0,time=0;
 const read=createModelStatusReader(async()=>{calls++;return {segmentation:true}},()=>time);
 const results=await Promise.all(Array.from({length:20},()=>read()));
 assert.equal(calls,1);assert.ok(results.every(r=>r.segmentation));
 time=14999;await read();assert.equal(calls,1);
 time=15000;await Promise.all([read(),read()]);assert.equal(calls,2);
});

test('failed status probes are not cached and can recover',async()=>{
 let calls=0;
 const read=createModelStatusReader(async()=>{if(++calls===1)throw new Error('not installed');return {lucida:true}});
 const failures=await Promise.all([read(),read()]);assert.equal(calls,1);
 assert.deepEqual(failures[0],{available:false,message:'not installed'});
 assert.equal((await read()).lucida,true);assert.equal(calls,2);
});
