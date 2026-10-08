import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { readPsd, writePsdBuffer } from 'ag-psd';
import type { Layer, CanvasImage, Job } from '../server/types.js';
import { DEFAULT_UPSCALE } from '../shared/upscale.js';
process.env.LAYER_CANVAS_DATA = path.resolve('test-output/screen-' + crypto.randomUUID());
const store = await import('../server/store.js');
const media = await import('../server/media.js');
const { upscaleLayers } = await import('../server/upscale-layers.js');
const { verifyUpscaledPsd } = await import('../server/upscale-psd.js');
const doc = store.getByTask('screen-fixture');
async function png(rgb: number[], alpha = 255) {
  const data = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, alpha], i);
  return sharp(data, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer();
}
async function fixture() {
  const make = async (id: string, rgb: number[], alpha = 255): Promise<Layer> => ({
    id, name: id, kind: 'raster', url: store.writeAsset(doc.id, await png(rgb, alpha), '.png'),
    x: 0, y: 0, width: 4, height: 4, opacity: 1, visible: true, opinion: '', disposition: 'keep',
  });
  const bg = await make('background', [60, 100, 140]);
  const fx = await make('light', [100, 70, 20]); fx.blendMode = 'screen';
  const im: CanvasImage = { id: 'im', name: 'screen', x: 0, y: 0, width: 4, height: 4,
    source: bg.url!, url: bg.url!, layers: [bg, fx], annotations: [], opinion: '', version: 1, status: 'layered' };
  return im;
}
const raw = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();
test('screen actual pixels, opacity, visibility, order and normal default', async () => {
  const im = await fixture();
  const full = await raw(await media.renderImage(doc.id, im));
  const expected = [60,100,140].map((v,i) => Math.round(255 - (255-v)*(255-[100,70,20][i])/255));
  full.subarray(0,3).forEach((v,i) => assert(Math.abs(v-expected[i]) <= 1));
  im.layers[1].opacity = .5;
  const half = await raw(await media.renderImage(doc.id, im));
  half.subarray(0,3).forEach((v,i) => assert(Math.abs(v-(expected[i]+[60,100,140][i])/2) <= 1));
  im.layers[1].visible = false;
  assert.deepEqual([...((await raw(await media.renderImage(doc.id, im))).subarray(0,4))], [60,100,140,255]);
  im.layers[1].visible = true; im.layers[1].opacity = 1;
  im.layers.reverse();
  assert.deepEqual([...((await raw(await media.renderImage(doc.id, im))).subarray(0,4))], [60,100,140,255]);
  im.layers.reverse(); delete im.layers[1].blendMode;
  assert.deepEqual([...((await raw(await media.renderImage(doc.id, im))).subarray(0,4))], [100,70,20,255]);
});
test('screen PSD export/import preserves leaf mode and merged pixels; fake upscale retains mode', async () => {
  const im = await fixture();
  const pixels = await raw(await media.renderImage(doc.id, im));
  const bytes = await media.exportPsd(doc.id, im);
  const psd = readPsd(bytes, { useImageData: true });
  assert.equal(psd.children![1].blendMode, 'screen');
  assert.deepEqual(Buffer.from(psd.imageData!.data), pixels);
  const imported = await media.importImage(doc, bytes, 'screen.psd');
  assert.equal(imported.layers[1].blendMode, 'screen');
  assert.deepEqual(await raw(await media.renderImage(doc.id, imported)), pixels);
  const out = path.join(process.env.LAYER_CANVAS_DATA!, 'upscale'); fs.mkdirSync(out, { recursive: true });
  const result = await upscaleLayers({ documentId: doc.id, snapshot: imported } as Job,
    { ...DEFAULT_UPSCALE, scale: 2 }, out,
    async (input, _out, size) => ({ bytes: await sharp(input).resize(size.width, size.height).png().toBuffer(), warnings: [] }),
    new AbortController().signal, () => {});
  assert.equal(result.image.layers[1].blendMode, 'screen');
  const output = fs.readFileSync(store.assetPath(doc.id, result.image.psdSource!));
  assert.equal(readPsd(output).children![1].blendMode, 'screen');
  const tampered = structuredClone(result.image); tampered.layers[1].blendMode = 'normal';
  assert.throws(() => verifyUpscaledPsd(output, tampered), /混合模式/);
  const old = structuredClone(imported); delete old.layers[1].blendMode;
  await assert.rejects(() => media.renderImage(doc.id, old), /旧PSD节点缺少/);
});
test('unsupported leaves and isolated screen groups fail before import; pass through works', async () => {
  const im = await fixture();
  const base = readPsd(await media.exportPsd(doc.id, im), { useImageData: true });
  for (const mode of ['multiply', 'overlay'] as const) {
    const psd = readPsd(await media.exportPsd(doc.id, im), { useImageData: true }); psd.children![1].blendMode = mode;
    await assert.rejects(() => media.importImage(doc, writePsdBuffer(psd), 'unsafe.psd'), /混合模式/);
  }
  const nested = { ...base, children: [base.children![0], { name: 'group', blendMode: 'normal' as const, children: [base.children![1]] }] };
  await assert.rejects(() => media.importImage(doc, writePsdBuffer(nested), 'unsafe-group.psd'), /复杂组/);
  nested.children[1].blendMode = 'pass through' as any;
  const accepted = await media.importImage(doc, writePsdBuffer(nested), 'passthrough.psd');
  assert.deepEqual(await raw(await media.renderImage(doc.id, accepted)), await raw(await media.renderImage(doc.id, im)));
});
test('native PSD bypass keeps exact native bytes and composite', async () => {
  const im = await fixture();
  const bytes = Buffer.from('native opaque bytes');
  im.psdSource = store.writeAsset(doc.id, bytes, '.psd');
  const composite = await png([13,17,29]);
  im.nativePsd = { version: 1, compositeUrl: store.writeAsset(doc.id, composite, '.png'), mappings: [] } as any;
  assert.deepEqual(await media.exportPsd(doc.id, im), bytes);
  assert.deepEqual(await media.renderImage(doc.id, im), composite);
});

test('independent PSD masks cannot silently reveal hidden screen pixels', async () => {
  const im = await fixture();
  for (const mode of ['normal', 'screen'] as const) {
    const psd = readPsd(await media.exportPsd(doc.id, im), { useImageData: true });
    const fx = psd.children![1];
    fx.blendMode = mode;
    fx.mask = { left: 0, top: 0, right: 4, bottom: 4, defaultColor: 0,
      imageData: { width: 4, height: 4, data: new Uint8ClampedArray(64) } };
    const bytes = writePsdBuffer(psd);
    assert(readPsd(bytes, { useImageData: true }).children![1].mask);
    await assert.rejects(() => media.importImage(doc, bytes, 'masked.psd'), /独立蒙版/);
  }
});

test('browser isolated layer container matches backend pixels without blending checker background', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 200, height: 200 }, deviceScaleFactor: 1 });
    const im = await fixture();
    const style = fs.readFileSync('web/style.css', 'utf8');
    for (const single of [false, true]) {
      const layers = single ? [im.layers[1]] : im.layers;
      const imgs = layers.map(l => `<img src="data:image/png;base64,${fs.readFileSync(store.assetPath(doc.id,l.url!)).toString('base64')}" style="opacity:${l.opacity};mix-blend-mode:${l.blendMode || 'normal'}">`).join('');
      await page.setContent(`<style>${style}</style><div class="image-content checker" style="width:4px;height:4px;background:#00ff00"><div class="layer-composite">${imgs}</div></div>`);
      await page.locator('img').evaluateAll(imgs => Promise.all(imgs.map(img => (img as HTMLImageElement).decode())));
      assert.equal(await page.locator('.layer-composite').evaluate(el => getComputedStyle(el).isolation), 'isolate');
      const screenshot = await page.locator('.image-content').screenshot();
      const browserPixels = await sharp(screenshot).ensureAlpha().raw().toBuffer();
      const expected = await raw(await media.renderImage(doc.id, { ...im, layers }));
      assert.equal(browserPixels.length, expected.length);
      for (let i=0; i<expected.length; i++) assert(Math.abs(browserPixels[i]-expected[i]) <= 1, `pixel ${i}: ${browserPixels[i]} != ${expected[i]}`);
    }
  } finally { await browser.close(); }
});
