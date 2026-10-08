import test from 'node:test';
import assert from 'node:assert/strict';
import {protectKnownBackgroundRgba} from '../server/background-source-protection.js';

const image=(pixels:number[][],width=3)=>({width,height:pixels.length/width,data:new Uint8Array(pixels.flat())});
const source=image([[255,0,0,255],[11,22,33,255],[0,0,0,255],[8,7,6,255],[23,45,67,255],[9,8,7,255]]);
const generated=image([[0,200,100,255],[91,82,73,255],[41,42,43,255],[80,70,60,255],[230,45,6,255],[90,80,70,255]]);

test('confirmed visible pixels stay at their original positions, while unknown pixels come from the real fill',()=>{
  const beforeSource=new Uint8Array(source.data),beforeGenerated=new Uint8Array(generated.data);
  const result=protectKnownBackgroundRgba({source,generated,keepMask:new Uint8Array([255,0,255,0,255,0])});
  assert.deepEqual([...result.image.data],[255,0,0,255,91,82,73,255,0,0,0,255,80,70,60,255,23,45,67,255,90,80,70,255]);
  assert.equal(result.keptPixels,3);assert.equal(result.generatedFillPixels,3);
  assert.deepEqual(source.data,beforeSource);assert.deepEqual(generated.data,beforeGenerated);
});

test('binary selection is required and cannot turn the complete original into a background',()=>{
  for(const mask of [new Uint8Array(6),new Uint8Array(6).fill(255),new Uint8Array([255,0,127,0,0,0])])
    assert.throws(()=>protectKnownBackgroundRgba({source,generated,keepMask:mask}),/Keep mask|binary/);
});

test('no implicit resize, crop, transparent foreground copy or unbounded canvas is accepted',()=>{
  const mask=new Uint8Array([255,0,255,0,255,0]);
  assert.throws(()=>protectKnownBackgroundRgba({source,generated:{...generated,width:2,height:3},keepMask:mask}),/identical full-file/);
  assert.throws(()=>protectKnownBackgroundRgba({source,generated,keepMask:mask.subarray(1)}),/identical full-file/);
  const translucent={...source,data:new Uint8Array(source.data)};translucent.data[3]=254;
  assert.throws(()=>protectKnownBackgroundRgba({source:translucent,generated,keepMask:mask}),/opaque/);
  const incomplete={...generated,data:generated.data.subarray(1)};
  assert.throws(()=>protectKnownBackgroundRgba({source,generated:incomplete,keepMask:mask}),/complete RGBA8/);
  assert.throws(()=>protectKnownBackgroundRgba({source:{width:1500001,height:1,data:new Uint8Array(0)},generated,keepMask:mask}),/1500000/);
});
