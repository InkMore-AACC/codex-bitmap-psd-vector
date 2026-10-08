import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { prepareDetailReferences, prepareReferencePresentation } from '../server/generation-detail-references.js';

test('完整参考呈现含全幅留白预算，超预算不创建文件且不会自动裁边或降低倍率', async () => {
  const folder = path.resolve('test-output/reference-presentation-' + crypto.randomUUID());
  fs.mkdirSync(folder, { recursive: true });
  const source = path.join(folder, 'clean.png');
  await sharp({ create: { width: 700, height: 600, channels: 4, background: '#00000000' } }).png().toFile(source);
  const before = fs.readFileSync(source), files = fs.readdirSync(folder);
  await assert.rejects(prepareReferencePresentation(source, 2, folder, 'rejected'), /150万/);
  assert.deepEqual(fs.readdirSync(folder), files); assert.deepEqual(fs.readFileSync(source), before);
});

test('细节参考采样真实局部像素，保留坐标关系且不放大；越界与合计预算拒绝不落地细节文件', async () => {
  const folder = path.resolve('test-output/detail-references-' + crypto.randomUUID());
  fs.mkdirSync(folder, { recursive: true });
  const source = path.join(folder, 'clean.png');
  const rgba = Buffer.alloc(800 * 600 * 4);
  for (let i = 0; i < 800 * 600; i++) {
    rgba[i * 4] = i % 251; rgba[i * 4 + 1] = Math.floor(i / 800) % 251;
    rgba[i * 4 + 2] = 67; rgba[i * 4 + 3] = i % 253;
  }
  await sharp(rgba, { raw: { width: 800, height: 600, channels: 4 } }).png().toFile(source);
  const before = fs.readFileSync(source), frame = { x: 40, y: 30, width: 400, height: 300 };
  const canvas = { width: 500, height: 400 };
  const detail = { name: '暗带', box: [100, 100, 60, 40] as [number, number, number, number], observation: '窗下沿与栏杆暗带是不同结构，保持位置关系' };
  const [r] = await prepareDetailReferences(source, frame, canvas, [detail], folder, 'actual-test');
  assert.deepEqual(r.crop, { left: 120, top: 140, width: 120, height: 80 });
  assert.deepEqual(await sharp(r.path).ensureAlpha().raw().toBuffer(),
    await sharp(before).extract(r.crop).ensureAlpha().raw().toBuffer());
  assert.deepEqual(fs.readFileSync(source), before);
  const beforeFiles = fs.readdirSync(folder);
  for (const box of [[0, 0, 60, 40], [40, 30, 400, 300]]) {
    await assert.rejects(prepareDetailReferences(source, frame, canvas,
      [{ ...detail, box: box as typeof detail.box }], folder, 'rejected'), /frame内|262144/);
  }
  await assert.rejects(prepareDetailReferences(source, frame, canvas,
    [detail, detail], folder, 'duplicate'), /不同名称/);
  // Individually small crops still cannot exceed the aggregate budget.
  await assert.rejects(prepareDetailReferences(source, frame, canvas,
    [1, 2, 3].map(i => ({ ...detail, name: String(i), box: [40, 30, 200, 120] })), folder, 'aggregate'), /262144/);
  assert.deepEqual(fs.readdirSync(folder), beforeFiles);
});
