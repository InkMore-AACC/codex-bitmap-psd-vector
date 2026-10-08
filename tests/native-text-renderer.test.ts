import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { fontHasCodePoint, measureNativeTextSpan, renderNativeText, validateNativeTextRecipe } from '../server/native-text-renderer.js';
import { nativeTextRecipeSchema, nativeTextInkQuad, type NativeTextRecipe } from '../shared/native-text.js';

const fontPath = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
  .find(p => fs.existsSync(p));
assert.ok(fontPath, '真实字体渲染测试需要已安装TTF，不访问收费服务或下载字体');
const font = fs.readFileSync(fontPath), fontHash = crypto.createHash('sha256').update(font).digest('hex');
const frame = { x: 40, y: 30, width: 200, height: 96 };
const recipe: NativeTextRecipe = { version: 1, observation: '实际观察的黑色实心单行参数表，字距保持字体原始度量',
  spans: ['Angle 0-60', 'Index 1.31-1.34', 'Air 1.0003'].map((text, i) => ({
    text, fontPath, fontHash, fontSize: 18, color: '#000000', box: { x: 48, y: 35 + i * 30, width: 184, height: 24 },
  })) };

test('native font diagnostic metrics match actual source-scale glyphs and preserve font trust', () => {
  const measured = measureNativeTextSpan(recipe.spans[0]);
  const actual = renderNativeText(recipe, frame, { width: frame.width, height: frame.height }).proof.measured[0].inkBox;
  assert.deepEqual(measured, { width: actual.width, height: actual.height });
  assert.throws(() => measureNativeTextSpan({ ...recipe.spans[0], fontHash: '0'.repeat(64) }), /字体文件已变化/);
  assert.throws(() => measureNativeTextSpan({ ...recipe.spans[0], text: '\u{10ffff}' }), /缺少字形/);
});

test('real native glyphs retain three solid ink rows, transparent paper and one carrier transform', async () => {
  const r = renderNativeText(recipe, frame, { width: 200, height: 96 });
  const { data, info } = await sharp(r.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual({ width: info.width, height: info.height }, r.proof.size);
  assert.equal(r.proof.measured.length, 3);
  for (let row = 0; row < 3; row++) {
    let solid = 0;
    for (let y = 5 + row * 30; y < 29 + row * 30; y++) for (let x = 8; x < 192; x++) {
      const p = (y * info.width + x) * 4;
      if (data[p + 3] >= 248) { solid++; assert.equal(data[p], 0); assert.equal(data[p + 1], 0); assert.equal(data[p + 2], 0); }
    }
    assert.ok(solid > 25, '每行有实际实心墨迹，不是空白或空心轮廓');
  }
  for (let y = 0; y < 96; y++) for (const x of [0, 1, 198, 199]) assert.equal(data[(y * 200 + x) * 4 + 3], 0);
  for (let x = 0; x < 200; x++) assert.equal(data[(32 * 200 + x) * 4 + 3], 0, '段间无灰纸底');
  const small = renderNativeText(recipe, frame, { width: 100, height: 48 });
  assert.equal(small.proof.scale, .5);
  assert.deepEqual(small.proof.measured, r.proof.measured, '统一缩放不改变源中字号和字间距');
  assert.throws(() => renderNativeText(recipe, frame, { width: 1500, height: 1001 }), /150万/);
});

test('font bytes/coverage and glyph bounds reject substitutions, source overflow and unsafe text', () => {
  assert.equal(fontHasCodePoint(font, 'A'.codePointAt(0)!), true);
  assert.equal(fontHasCodePoint(font, 0x10ffff), false);
  assert.throws(() => validateNativeTextRecipe({ ...recipe, spans: [{ ...recipe.spans[0], fontHash: '0'.repeat(64) }] }, frame), /字体文件已变化/);
  assert.throws(() => validateNativeTextRecipe({ ...recipe, spans: [{ ...recipe.spans[0], text: '\u{10ffff}' }] }, frame), /缺少字形/);
  assert.throws(() => validateNativeTextRecipe({ ...recipe, spans: [{ ...recipe.spans[0], box: { ...recipe.spans[0].box, x: 0 } }] }, frame), /完整属于/);
  assert.throws(() => renderNativeText({ ...recipe, spans: [{ ...recipe.spans[0], box: { ...recipe.spans[0].box, width: 2 } }] }, frame, { width: 200, height: 96 }), /字形超出/);
  assert.throws(() => fontHasCodePoint(Buffer.from('not-font-data'), 65));
  assert.equal(nativeTextRecipeSchema.safeParse({ ...recipe, spans: [{ ...recipe.spans[0], text: 'A\nB' }] }).success, false);
});

test('explicit v2 plane renders solid tilted ink at its frozen quad with transparent surrounding pixels', async () => {
  const planar: NativeTextRecipe = { version: 2, observation: '工程夹具中已观察的印字平面，不能声称真实海报通过',
    transform: [1, .2, -.1, 1, 70, 45], transformObservation: '工程已冻结向右下倾斜的平面基，非从源图复制像素',
    spans: [{...recipe.spans[0],text:'TIDE-07',fontSize:22,box:{x:0,y:0,width:120,height:28}}] };
  const r = renderNativeText(planar, frame, {width:200,height:96});
  assert.equal(r.proof.algorithm, 'native-planar-solid-glyphs-v2');
  assert.deepEqual(r.proof.transform, planar.transform);
  const measured = r.proof.measured[0];
  assert.deepEqual(measured.inkQuad, nativeTextInkQuad(planar, measured.localInkBox!));
  const {data,info} = await sharp(r.bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let solid = 0, leadingY=96, trailingY=0;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
    const i=(y*info.width+x)*4;if(data[i+3]<240)continue;
    solid++;assert.equal(data[i],0);assert.equal(data[i+1],0);assert.equal(data[i+2],0);
    assert.ok(x+frame.x>=measured.inkBox.x-1&&x+frame.x<=measured.inkBox.x+measured.inkBox.width+1);
    assert.ok(y+frame.y>=measured.inkBox.y-1&&y+frame.y<=measured.inkBox.y+measured.inkBox.height+1);
    if(x<40)leadingY=Math.min(leadingY,y);if(x>95)trailingY=Math.max(trailingY,y);
  }
  assert.ok(solid>80);assert.ok(trailingY>leadingY+8,'印字实际沿冻结平面倾斜，非只改证明字段');
  assert.equal(data[3],0);assert.equal(data[((info.height-1)*info.width)*4+3],0);
  const half=renderNativeText(planar,frame,{width:100,height:48});
  assert.deepEqual(half.proof.measured,r.proof.measured,'预算缩小只作用于完整载体，平面源坐标不变');
  assert.throws(()=>renderNativeText(planar,frame,{width:1500,height:1001}),/150万/);
});

test('v2 plane rejects singular/mirrored/undeclared transforms and clips no glyphs to satisfy a frame', () => {
  const spans=[{...recipe.spans[0],text:'A',box:{x:0,y:0,width:30,height:25}}];
  const planar={version:2,observation:'工程定位范围校验，不是源字形匹配证明',spans,
    transform:[1,0,0,1,50,40],transformObservation:'实际冻结的完整平面变换观察，不临时拟合'};
  const parsed=nativeTextRecipeSchema.parse(planar);assert.doesNotThrow(()=>validateNativeTextRecipe(parsed,frame));
  for(const transform of [[1,0,2,0,50,40],[-1,0,0,1,50,40],[1,Infinity,0,1,50,40]])
    assert.equal(nativeTextRecipeSchema.safeParse({...planar,transform}).success,false);
  assert.equal(nativeTextRecipeSchema.safeParse({...planar,version:1}).success,false,'旧v1不接受变换字段');
  assert.equal(nativeTextRecipeSchema.safeParse({...planar,transformObservation:''}).success,false);
  assert.throws(()=>validateNativeTextRecipe(nativeTextRecipeSchema.parse({...planar,transform:[1,0,0,1,235,40]}),frame),/完整属于/);
  assert.throws(()=>renderNativeText(nativeTextRecipeSchema.parse({...planar,spans:[{...spans[0],box:{x:0,y:0,width:1,height:1}}]}),frame,{width:200,height:96}),/字形超出/);
});
