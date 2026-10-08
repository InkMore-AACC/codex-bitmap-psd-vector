import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import sharp from 'sharp';

const { createNativeFontReview, nativeFontReviewSchema } = await import('../scripts/' + 'review-native-fonts.mjs');
const installed = [
  ['Arial', 'C:/Windows/Fonts/arial.ttf'], ['Arial Bold', 'C:/Windows/Fonts/arialbd.ttf'],
  ['DejaVu Sans', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
  ['DejaVu Bold', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
].filter(([, p]) => fs.existsSync(p)).slice(0, 2);
assert.equal(installed.length, 2, '字体诊断测试使用实际已安装字体，不下载或访问收费服务');
const hash = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fonts = installed.map(([name, fontPath]) => ({ name, fontPath, fontHash: hash(fontPath) }));
const fixtureTask = '10000000-0000-4000-8000-000000000055';
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-font-review-'));
  const sourcePath = path.join(dir, 'source.png');
  await sharp({ create: { width: 96, height: 64, channels: 4, background: '#ffffee' } }).png().toFile(sourcePath);
  return { dir, input: { taskId: fixtureTask, sourcePath, sourceHash: hash(sourcePath), sourceSize: { width: 96, height: 64 },
    frame: { x: 0, y: 0, width: 96, height: 64 }, observation: '工程诊断输入仅验证候选来源、字号范围和只读边界，不冒称海报验收',
    fonts, sizes: { min: 10, max: 16, step: 1 }, spans: [
      { text: 'Angle', inkBox: { x: 4, y: 4, width: 35, height: 14 }, color: '#202020', selection: 'fit', sizeHint: 14 },
      { text: 'Range', inkBox: { x: 4, y: 30, width: 40, height: 14 }, color: '#202020', selection: 'holdout', sizeHint: 14 },
    ] } };
}

test('font preflight renders real candidates, keeps held-out size fixed and writes only bounded diagnostics', async () => {
  const { dir, input } = await fixture(), initial = JSON.stringify(input);
  const result = await createNativeFontReview(input, path.join(dir, 'diagnostic'), { taskId: fixtureTask, contextGuard: false });
  assert.equal(result.results.length, 2);
  for (const resultFont of result.results) assert.equal(resultFont.spans[1].fontSize, input.spans[1].sizeHint);
  assert.ok(result.pixels <= 1_500_000 && result.view.previewBytes <= 131072);
  assert.equal(result.automaticVisualAcceptance, false);
  assert.equal(result.recipeOrJobChanged, false);
  assert.equal(result.sourcePixelsInCandidateGlyphs, false);
  assert.equal(hash(input.sourcePath), input.sourceHash);
  assert.deepEqual(fonts.map(f => hash(f.fontPath)), fonts.map(f => f.fontHash));
  assert.equal(JSON.stringify(input), initial);
  await assert.rejects(createNativeFontReview(input, path.join(dir, 'diagnostic'), { taskId: fixtureTask, contextGuard: false }), /目录已存在/);
});

test('font preflight refuses wrong task, changed source/font and missing glyphs before producing a sheet', async () => {
  const { dir, input } = await fixture(), dest = path.join(dir, 'invalid');
  await assert.rejects(createNativeFontReview(input, dest, { taskId: 'wrong', contextGuard: false }), /当前任务/);
  await assert.rejects(createNativeFontReview({ ...input, sourceHash: '0'.repeat(64) }, dest, { taskId: fixtureTask, contextGuard: false }), /源摘要/);
  await assert.rejects(createNativeFontReview({ ...input, fonts: [{ ...fonts[0], fontHash: '0'.repeat(64) }, fonts[1]] }, dest, { taskId: fixtureTask, contextGuard: false }), /字体文件/);
  await assert.rejects(createNativeFontReview({ ...input, spans: input.spans.map((s, i) => i ? s : { ...s, text: '\u{10ffff}' }) }, dest, { taskId: fixtureTask, contextGuard: false }), /缺少字形/);
  assert.equal(fs.existsSync(dest), false);
});

test('light glyph candidates remain visible on a dark review tile without changing glyph colors', async () => {
  const { dir, input } = await fixture(), dest = path.join(dir, 'light-glyphs');
  const light = { ...input, spans: input.spans.map(s => ({ ...s, color: '#eeeeee' })) };
  const result = await createNativeFontReview(light, dest, { taskId: fixtureTask, contextGuard: false });
  assert.deepEqual(result.candidateBackgrounds, ['#151515', '#f1f1f1']);
  const tileW = result.diagnosticCarrier.width + 18, tileH = result.diagnosticCarrier.height + 35;
  const pixels = await sharp(fs.readFileSync(path.join(dest, 'font-sheet-view-only.png')))
    .extract({ left: tileW, top: 28, width: tileW, height: tileH - 28 }).removeAlpha().raw().toBuffer();
  let dark = 0, glyph = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i] === 21 && pixels[i + 1] === 21 && pixels[i + 2] === 21) dark++;
    if (pixels[i] === 238 && pixels[i + 1] === 238 && pixels[i + 2] === 238) glyph++;
  }
  assert.ok(dark > 0 && glyph > 0, 'real light glyphs are visible on the declared dark background');
  assert.equal(hash(input.sourcePath), input.sourceHash);
  assert.ok(result.pixels <= 1_500_000 && result.view.previewBytes <= 131072);
  assert.equal(result.automaticVisualAcceptance, false);
});

test('font preflight refuses unbounded search, duplicate bank and missing held-out observations', async () => {
  const { input } = await fixture();
  assert.equal(nativeFontReviewSchema.safeParse({ ...input, sizes: { min: 2, max: 100, step: .25 } }).success, false);
  assert.equal(nativeFontReviewSchema.safeParse({ ...input, fonts: [fonts[0], fonts[0]] }).success, false);
  assert.equal(nativeFontReviewSchema.safeParse({ ...input, spans: input.spans.map(s => ({ ...s, selection: 'fit' })) }).success, false);
});

test('large editorial type is diagnosed at real size while preserving holdout and full pixel budget', async () => {
  const { dir, input } = await fixture();
  const sourcePath = path.join(dir, 'headline-source.png');
  await sharp({ create: { width: 700, height: 230, channels: 4, background: '#ffffee' } }).png().toFile(sourcePath);
  const large = { ...input, sourcePath, sourceHash: hash(sourcePath), sourceSize: { width: 700, height: 230 },
    frame: { x: 0, y: 0, width: 700, height: 230 }, sizes: { min: 124, max: 128, step: 1 },
    spans: [
      { ...input.spans[0], text: 'ANGLE', inkBox: { x: 4, y: 8, width: 400, height: 94 }, sizeHint: 128 },
      { ...input.spans[1], text: 'RANGE', inkBox: { x: 4, y: 115, width: 410, height: 94 }, sizeHint: 128 },
    ] };
  const result = await createNativeFontReview(large, path.join(dir, 'large'), { taskId: fixtureTask, contextGuard: false });
  assert.ok(result.pixels <= 1_500_000 && result.view.previewBytes <= 131072);
  for (const font of result.results) assert.equal(font.spans[1].fontSize, 128);
  assert.equal(result.sourcePixelsInCandidateGlyphs, false);
  assert.equal(result.recipeOrJobChanged, false);
  assert.equal(result.automaticVisualAcceptance, false);
  assert.equal(hash(sourcePath), large.sourceHash);
  assert.equal(nativeFontReviewSchema.safeParse({ ...large, sizes: { min: 2, max: 1000, step: .25 } }).success, false);
  assert.equal(nativeFontReviewSchema.safeParse({ ...large, spans: large.spans.map(s => ({ ...s, sizeHint: 1001 })) }).success, false);
  const oversize = { ...large, spans: large.spans.map(s => ({ ...s, text: 'W'.repeat(1000), sizeHint: 1000 })) };
  await assert.rejects(createNativeFontReview(oversize, path.join(dir, 'over-budget'), { taskId: fixtureTask, contextGuard: false }), /超过150万像素/);
  assert.equal(fs.existsSync(path.join(dir, 'over-budget')), false);
});

test('planar font preflight compares projected ink while retaining the frozen held-out size', async () => {
  const { dir, input } = await fixture();
  const plane = { transform: [1, .1, -.05, 1, 8, 8], transformObservation: '诊断前冻结同一平面的轻微倾斜和斜切，不按候选字形重新拟合' };
  const planar = { ...input, plane, spans: [
    { ...input.spans[0], localInkBox: { x: 0, y: 0, width: 35, height: 14 }, inkBox: { x: 7, y: 8, width: 36, height: 18 } },
    { ...input.spans[1], localInkBox: { x: 0, y: 25, width: 40, height: 14 }, inkBox: { x: 6, y: 33, width: 41, height: 18 } },
  ] };
  const result = await createNativeFontReview(planar, path.join(dir, 'planar'), { taskId: fixtureTask, contextGuard: false });
  for (const font of result.results) {
    assert.equal(font.spans[1].fontSize, 14);
    for (const span of font.spans) {
      assert.ok(span.localMeasuredInk.width > 0);
      assert.ok(Math.abs(span.measuredInk.width - span.localMeasuredInk.width - .05 * span.localMeasuredInk.height) < 1e-8);
      assert.ok(Math.abs(span.measuredInk.height - span.localMeasuredInk.height - .1 * span.localMeasuredInk.width) < 1e-8);
    }
  }
  assert.ok(result.view.previewBytes <= 131072 && result.pixels <= 1_500_000);
  assert.equal(result.recipeOrJobChanged, false);
  assert.equal(hash(input.sourcePath), input.sourceHash);
  assert.equal(nativeFontReviewSchema.safeParse({ ...input, plane }).success, false);
  assert.equal(nativeFontReviewSchema.safeParse({ ...input, spans: planar.spans }).success, false);
});

test('unfavorable wide or tilted candidates retain full ink beyond the source crop, without altering observed source or holdout',async()=>{
  const {dir,input}=await fixture(),original=JSON.stringify(input);
  const wide={...input,frame:{x:20,y:0,width:76,height:64},sizes:{min:10,max:16,step:1},spans:[
    {...input.spans[0],inkBox:{x:24,y:4,width:35,height:14}},
    {...input.spans[1],text:'EXTREMELY WIDE HELDOUT',inkBox:{x:24,y:30,width:40,height:14},sizeHint:14}]};
  const result=await createNativeFontReview(wide,path.join(dir,'wide'),{taskId:fixtureTask,contextGuard:false});
  assert(result.diagnosticCarrier.x+result.diagnosticCarrier.width>96,'完整查看候选，原图读取框仍在96px源内');
  for(const f of result.results)assert.equal(f.spans[1].fontSize,14);
  assert.equal(hash(input.sourcePath),input.sourceHash);assert.equal(JSON.stringify(input),original);
  assert(result.pixels<=1500000&&result.view.previewBytes<=131072);
});
