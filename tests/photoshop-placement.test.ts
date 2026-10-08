import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import type { AdobeConnector } from '../server/adobe.js';
import { replaceMaterialInGroup, configureScreenMaterialGroup, placeNativeMaterial } from '../server/photoshop-placement.js';

const placement = { PLACEBEFORE: 'before', INSIDE: 'inside' };
class Group {
  layers: Layer[] = [];
}
let nextId = 0;
class Layer {
  id = ++nextId;
  constructor(
    public name: string,
    public parent: Group,
  ) {
    parent.layers.push(this);
  }
  remove() {
    this.parent.layers.splice(this.parent.layers.indexOf(this), 1);
  }
  move(target: unknown, where: unknown) {
    this.remove();
    if (where === placement.INSIDE) {
      this.parent = target as Group;
      this.parent.layers.unshift(this);
    } else {
      const t = target as Layer;
      this.parent = t.parent;
      this.parent.layers.splice(this.parent.layers.indexOf(t), 0, this);
    }
  }
}
// Execute the exact source embedded in the generated JSX, not a parallel imitation.
const execute = vm.runInNewContext(
  `(${replaceMaterialInGroup.toString()})`,
) as typeof replaceMaterialInGroup;

test('screen material escapes only its own logical group isolation and refuses ignored blend writes', () => {
  const configure = vm.runInNewContext(`(${configureScreenMaterialGroup.toString()})`) as typeof configureScreenMaterialGroup;
  const modes = { SCREEN: 'screen', PASSTHROUGH: 'pass-through' }, layer = { blendMode: 'normal' }, group = { blendMode: 'normal' };
  const unrelated = { blendMode: 'normal' };
  assert.throws(() => configure(layer, group, { SCREEN: undefined, PASSTHROUGH: undefined }), /unavailable/);
  assert.equal(layer.blendMode, 'normal');
  assert.equal(group.blendMode, 'normal');
  configure(layer, group, modes);
  assert.equal(layer.blendMode, 'screen');
  assert.equal(group.blendMode, 'pass-through');
  assert.equal(unrelated.blendMode, 'normal');
  const silentGroup = { get blendMode() { return 'normal'; }, set blendMode(_value: unknown) {} };
  assert.throws(() => configure({ blendMode: 'normal' }, silentGroup, modes), /Pass Through/);
});

test('PS replacement preserves occluders/effects above, patches below, and unrelated groups', () => {
  const group = new Group(),
    other = new Group(),
    incoming = new Group();
  const occluder = new Layer('foreground table', group),
    glow = new Layer('glow', group);
  const old = new Layer('LC_MATERIAL', group),
    patch = new Layer('occluded fill', group);
  const otherMaterial = new Layer('LC_MATERIAL', other);
  const fresh = new Layer('LC_MATERIAL', incoming);
  execute(fresh, group, placement);
  assert.deepEqual(group.layers, [occluder, glow, fresh, patch]);
  assert.equal(group.layers.includes(old), false);
  assert.deepEqual(other.layers, [otherMaterial]);
  assert.deepEqual(incoming.layers, []);
});

test('PS initial insertion retains top-of-group behavior and removes only stale material duplicates', () => {
  const group = new Group(),
    incoming = new Group();
  const existing = new Layer('effect', group),
    first = new Layer('LC_MATERIAL', incoming);
  execute(first, group, placement);
  assert.deepEqual(group.layers, [first, existing]);
  const duplicate = new Layer('LC_MATERIAL', group),
    patch = new Layer('patch', group);
  const second = new Layer('LC_MATERIAL', incoming);
  execute(second, group, placement);
  assert.deepEqual(group.layers, [second, existing, patch]);
  assert.equal(group.layers.includes(duplicate), false);
});

async function nativePathFixture(overlongFolder = false) {
  let folder = path.resolve('test-output', 'ps-path-' + crypto.randomUUID());
  while (folder.length < (overlongFolder ? 235 : 195)) folder = path.join(folder, 'nested-folder');
  fs.mkdirSync(folder, { recursive: true });
  const source = path.join(folder, 't.psd'); fs.writeFileSync(source, 'offline PSD fixture; no Adobe execution');
  const longDir = path.join(folder, 'materials', crypto.randomUUID()); fs.mkdirSync(longDir, { recursive: true });
  const material = path.join(longDir, 'full-carrier-material.png');
  const bytes = await sharp({ create: { width: 606, height: 261, channels: 4, background: { r: 40, g: 90, b: 120, alpha: 0.5 } } }).png().toBuffer();
  fs.writeFileSync(material, bytes); return { folder, source, material, bytes };
}
test('PS long material uses a byte-identical in-job short path and preserves full-carrier placement', async () => {
  const { folder, source, material, bytes } = await nativePathFixture(); assert(material.length >= 260);
  let scriptSeen = '';
  const adobe = { executeScript: async (_app: string, script: string, scope: string, outputs: string[]) => {
    assert.equal(scope, folder); assert([script, ...outputs].every(p => p.length < 260));
    scriptSeen = fs.readFileSync(script, 'utf8'); new vm.Script(scriptSeen.replace(/^#target photoshop\r?\n/, ''));
    assert(!scriptSeen.includes(JSON.stringify(material)));
    const alias = fs.readdirSync(folder).find(n => /^m-.*\.png$/.test(n))!;
    assert.deepEqual(fs.readFileSync(path.join(folder, alias)), bytes);
    fs.writeFileSync(outputs[0], 'offline native result fixture'); fs.writeFileSync(outputs[1], JSON.stringify({ transform: [22,7,628,7,628,268,22,268] }));
  } } as unknown as AdobeConnector;
  const out = await placeNativeMaterial(adobe, folder, source, 'own-layer', material, { x:22,y:7,width:606,height:261 });
  assert(scriptSeen.includes('"x":22')); assert(out.materialSource.stagedPath);
  assert.equal(out.materialSource.hash, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(fs.readFileSync(material), bytes); assert.deepEqual(fs.readFileSync(out.materialSource.stagedPath!), bytes);
  assert.deepEqual(out.metrics.transform, [22,7,628,7,628,268,22,268]);
});

test('actual placement JSX configures the target screen group without changing material bytes or file quad', async () => {
  const { folder, source, material, bytes } = await nativePathFixture();
  let seen = '';
  const adobe = { executeScript: async (_app: string, script: string, _scope: string, outputs: string[]) => {
    seen = fs.readFileSync(script, 'utf8');
    new vm.Script(seen.replace(/^#target photoshop\r?\n/, ''));
    assert.ok(seen.includes(configureScreenMaterialGroup.toString()));
    assert.ok(seen.includes(')(l,group,BlendMode);'));
    fs.writeFileSync(outputs[0], 'offline native result fixture');
    fs.writeFileSync(outputs[1], JSON.stringify({ transform: [22,7,628,7,628,268,22,268] }));
  } } as unknown as AdobeConnector;
  const result = await placeNativeMaterial(adobe, folder, source, 'screen-layer', material,
    { x:22,y:7,width:606,height:261 }, true);
  assert.deepEqual(fs.readFileSync(material), bytes);
  assert.deepEqual(result.metrics.transform, [22,7,628,7,628,268,22,268]);
});
test('PS material or staged copy changes during native execution reject success and retain outputs', async () => {
  for (const which of ['original', 'staged']) {
    const { folder, source, material } = await nativePathFixture(); let preserved = '';
    const adobe = { executeScript: async (_app: string, _script: string, _scope: string, outputs: string[]) => {
      preserved = outputs[0]; fs.writeFileSync(outputs[0], 'preserved failed candidate'); fs.writeFileSync(outputs[1], '{}');
      const alias = path.join(folder, fs.readdirSync(folder).find(n => /^m-.*\.png$/.test(n))!);
      fs.writeFileSync(which === 'original' ? material : alias, 'changed during native execution');
    } } as unknown as AdobeConnector;
    await assert.rejects(placeNativeMaterial(adobe, folder, source, 'own-layer', material, { x:0,y:0,width:12,height:8 }), /期间.*发生变化/);
    assert.equal(fs.readFileSync(preserved, 'utf8'), 'preserved failed candidate');
  }
});
test('PS overlong own job folder fails before Adobe without deleting or moving originals', async () => {
  const { folder, source, material, bytes } = await nativePathFixture(true); let called = false;
  const adobe = { executeScript: async () => { called = true; } } as unknown as AdobeConnector;
  await assert.rejects(placeNativeMaterial(adobe, folder, source, 'own-layer', material, { x:0,y:0,width:12,height:8 }), /路径.*超过/);
  assert.equal(called, false); assert.deepEqual(fs.readFileSync(material), bytes); assert(fs.existsSync(source));
});
