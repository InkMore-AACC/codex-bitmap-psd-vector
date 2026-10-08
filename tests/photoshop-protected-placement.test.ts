import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { photoshopMaterialTarget, photoshopMaterialQuadMatches, type PhotoshopPlan } from '../shared/photoshop.js';
import { verifyMaterialPlacement } from '../server/photoshop-native.js';

const folder = fs.mkdtempSync(path.resolve('test-output/ps-protected-placement-'));
after(() => fs.rmSync(folder, { recursive: true, force: true }));
const size = { width: 48, height: 72 }, frame = { x: 0, y: 0, ...size };
const quad = [0, 0, 48, 0, 48, 72, 0, 72];

test('protected full backgrounds keep exact pixels; ordinary opaque backgrounds retain bleed', () => {
  assert.deepEqual(photoshopMaterialTarget(size, frame, true, true), { ...frame, bleedScale: 1 });
  const ordinary = photoshopMaterialTarget(size, frame, true);
  assert.equal(ordinary.x, -1);
  assert.equal(ordinary.y, -1.5);
  assert.equal(ordinary.width / ordinary.height, size.width / size.height);
  for (const altered of [ { ...frame, x: 1 }, { ...frame, y: 1 }, { ...frame, width: 49 }, { ...frame, height: 73 } ])
    assert.throws(() => photoshopMaterialTarget(size, altered, true, true), /不能缩放、平移或补边/);
  assert.throws(() => photoshopMaterialTarget(size, frame, false, true), /同尺寸满幅/);
});

test('protected quads reject subpixel drift, shear at any corner, NaN and the old bleed quad', () => {
  const target = photoshopMaterialTarget(size, frame, true, true);
  assert.equal(photoshopMaterialQuadMatches(quad, target, true), true);
  for (let i = 0; i < 8; i++) {
    const drift = [...quad]; drift[i] += 0.25;
    assert.equal(photoshopMaterialQuadMatches(drift, target, true), false);
    assert.equal(photoshopMaterialQuadMatches(drift, target), true);
    drift[i] = NaN;
    assert.equal(photoshopMaterialQuadMatches(drift, target, true), false);
  }
  assert.equal(photoshopMaterialQuadMatches([-1,-1.5,49,-1.5,49,73.5,-1,73.5], target, true), false);
});

test('native verifier binds exact protected quad and unchanged embedded file to the registered material', async () => {
  const bytes = await sharp({ create: { ...size, channels: 4, background: '#395168' } }).png().toBuffer();
  const file = path.join(folder, 'background.png'); fs.writeFileSync(file, bytes);
  const protection = { version: 1, sourceHash: 'a'.repeat(64), keepMask: {path:'mask',hash:'b'.repeat(64)},review:{path:'review',hash:'c'.repeat(64)} };
  const plan = { canvas: size, layers: [{ layerId:'bg', name:'background', route:'generate',surface:'opaque',frame,sourceProtection:protection }] } as unknown as PhotoshopPlan;
  const material = { path:file,originalPath:file,workingPath:file,provenance:'source-protected' };
  const psd: any = { width:48,height:72,children:[{ name:'LC_bg',children:[{name:'LC_MATERIAL',placedLayer:{id:'link',transform:[...quad]}}]}],linkedFiles:[{id:'link',data:bytes}] };
  assert.deepEqual(await verifyMaterialPlacement(psd, plan, {bg:material}), {bg:quad});
  psd.children[0].children[0].placedLayer.transform[2] += 0.25;
  await assert.rejects(verifyMaterialPlacement(psd,plan,{bg:material}), /位置\/比例/);
  psd.children[0].children[0].placedLayer.transform = [...quad];
  psd.linkedFiles[0].data = Buffer.from('changed embedded bytes');
  await assert.rejects(verifyMaterialPlacement(psd,plan,{bg:material}), /登记版本不符/);
  psd.linkedFiles[0].data = bytes;
  const withoutProtection = structuredClone(plan); delete withoutProtection.layers[0].sourceProtection;
  await assert.rejects(verifyMaterialPlacement(psd,withoutProtection,{bg:material}), /缺少冻结/);
  await assert.rejects(verifyMaterialPlacement(psd,plan,{bg:{...material,placementFrame:{...frame,x:1}}}), /不能缩放、平移或补边/);
});
