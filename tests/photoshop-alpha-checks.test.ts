import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { planningLayer } from '../shared/planning.js';
import { photoshopPlanSchema } from '../shared/photoshop.js';
import type { Job } from '../server/types.js';
process.env.LAYER_CANVAS_DATA = path.resolve('test-output/ps-alpha-' + crypto.randomUUID());
const store = await import('../server/store.js');
const alpha = await import('../server/photoshop-alpha-checks.js');
const { validatePhotoshopPlan } = await import('../server/photoshop-rebuild.js');
const hash = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const transmissive = { name: '薄纱', kind: 'transmissive' as const, box: [50, 50, 2, 2] as [number, number, number, number],
  minAlpha: 8, maxAlpha: 220, minBackgroundResponse: 35, minPassingFraction: 1 };
const clear = { name: '环境孔隙', kind: 'clear' as const, box: [20, 20, 2, 2] as [number, number, number, number],
  maxAlpha: 8, minPassingFraction: 1 };
async function fixture(canvas = { width: 100, height: 100 }) {
  const d = store.getByTask('ps_alpha_test_' + crypto.randomUUID());
  const url = store.writeAsset(d.id, await sharp({ create: {
    width: 100, height: 100, channels: 4, background: '#586070',
  } }).png().toBuffer(), '.png');
  const j = { id: crypto.randomUUID(), documentId: d.id, taskId: d.taskId, type: 'photoshop',
    reconstructionVersion: 3, reconstructionWorkflowVersion: 4,
    snapshot: { id: 'source', source: url, url, status: 'preview', width: 100, height: 100,
      layers: [planningLayer('fg', '薄纱', { x: 0, y: 0, width: 100, height: 100 }, 'foreground', '')] },
  } as Job;
  const plan = photoshopPlanSchema.parse({ canvas, layers: [{ layerId: 'fg', name: '薄纱', frame: { x: 0, y: 0, ...canvas },
    route: 'generate', content: 'bitmap', surface: 'transparent', rationale: '保留可见环境',
    includes: '薄纱', excludes: '环境', compositing: '普通透明合成', editable: 'pixels', elements: ['薄纱'],
    alphaChecks: [clear, transmissive],
  }] });
  const folder = path.join(store.dir(d.id), 'jobs', j.id);
  fs.mkdirSync(folder, { recursive: true });
  const psdPath = path.join(folder, 'provenance-only.psd'), png = path.join(folder, 'actual-group.png');
  fs.writeFileSync(psdPath, 'synthetic helper provenance; HTTP tests validate actual PSD structure');
  async function rgba(a: number, hole = 0) {
    const bytes = Buffer.alloc(canvas.width * canvas.height * 4);
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const k = (y * canvas.width + x) * 4;
      bytes[k] = 128; bytes[k + 1] = 90; bytes[k + 2] = 60;
      bytes[k + 3] = a;
      if (canvas.width === 100 && x >= 20 && x < 22 && y >= 20 && y < 22) bytes[k + 3] = hole;
    }
    await sharp(bytes, { raw: { ...canvas, channels: 4 } }).png().toFile(png);
  }
  await rgba(128);
  const render = () => ({ psdPath, previewPath: png, thumbnails: { fg: png }, hash: hash(psdPath) });
  return { j, plan, folder, png, psdPath, rgba, render };
}

test('PS occupied bands reject missing printed content in actual group pixels', async () => {
  const f = await fixture(); const plan = structuredClone(f.plan) as any;
  plan.layers[0].alphaChecks = [{ name: '正文内容范围', kind: 'occupied', box: [50, 50, 10, 10], minAlpha: 32, minPassingFraction: 0.05 }];
  const parsed = photoshopPlanSchema.parse(plan);
  await f.rgba(0); const context = alpha.capturePhotoshopAlphaContext(f.j, parsed, {});
  const empty = (await alpha.inspectPhotoshopAlphaChecks(context, f.render()))!;
  assert.equal(empty.fg.passed, false); assert.equal(empty.fg.sampling.checks[0].passingPixels, 0);
  await f.rgba(128); const ink = (await alpha.inspectPhotoshopAlphaChecks(context, f.render()))!;
  assert.equal(ink.fg.passed, true);
  assert.throws(() => alpha.verifyPhotoshopAlphaChecks(context, f.render(), empty), /变化/);
});

test('v6 ordinary opaque rule is rejected by PS schema and persisted plan consumers', async () => {
  const f = await fixture(), plan = structuredClone(f.plan) as any;
  plan.layers[0].alphaChecks = [{ name: 'solid coverage', kind: 'opaque', box: [50, 50, 2, 2], minAlpha: 255, minPassingFraction: 1 }];
  assert.throws(() => photoshopPlanSchema.parse(plan));
  assert.throws(() => alpha.capturePhotoshopAlphaContext(f.j, plan, {}));
  assert.throws(() => alpha.validatePhotoshopAlphaCheckScope(f.j, plan));
});

test('PS alpha optional plan field keeps absent legacy hashes and validates source-owned scope', async () => {
  const f = await fixture(), input = structuredClone(f.plan);
  delete input.layers[0].alphaChecks;
  const before = JSON.stringify(input), parsed = photoshopPlanSchema.parse(input);
  assert.equal(JSON.stringify(parsed), before);
  assert(!Object.hasOwn(parsed.layers[0], 'alphaChecks'));
  assert.equal(alpha.capturePhotoshopAlphaContext(f.j, parsed, {}), undefined);
  assert.equal(validatePhotoshopPlan(f.j, f.plan).layers[0].alphaChecks?.length, 2);
  const scaled = structuredClone(f.plan);
  scaled.canvas = { width: 10, height: 10 };
  scaled.layers[0].frame = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(validatePhotoshopPlan(f.j, scaled).layers[0].alphaChecks![1].box[0], 50);
  for (const alter of [
    (j: Job, _p: typeof f.plan) => { j.reconstructionWorkflowVersion = undefined; },
    (j: Job, _p: typeof f.plan) => { j.reconstructionVersion = undefined; },
    (j: Job, _p: typeof f.plan) => { j.layerIds = ['other']; },
    (_j: Job, p: typeof f.plan) => { p.layers[0].surface = 'screen'; },
    (_j: Job, p: typeof f.plan) => { p.layers[0].content = 'background'; },
    (_j: Job, p: typeof f.plan) => { p.layers[0].alphaChecks![0].box = [99, 20, 2, 2]; },
    (j: Job, _p: typeof f.plan) => { j.snapshot.layers[0].frame = { x: 30, y: 30, width: 70, height: 70 }; },
    (_j: Job, p: typeof f.plan) => { p.layers[0].alphaChecks![0].name = '薄纱'; },
  ]) {
    const j = structuredClone(f.j), p = structuredClone(f.plan); alter(j, p);
    assert.throws(() => alpha.validatePhotoshopAlphaCheckScope(j, p));
  }
  const missing = structuredClone(f.plan) as any;
  delete missing.layers[0].alphaChecks[1].minBackgroundResponse;
  assert.throws(() => photoshopPlanSchema.parse(missing));
});

test('PS alpha actual full-canvas PNG rejects almost opaque and empty transmissive regions; clear holes and visible response pass', async () => {
  const f = await fixture(), context = alpha.capturePhotoshopAlphaContext(f.j, f.plan, {});
  await f.rgba(252);
  let d = (await alpha.inspectPhotoshopAlphaChecks(context, f.render()))!;
  assert.equal(d.fg.passed, false);
  assert.equal(d.fg.sampling.checks[0].passed, true);
  assert.equal(d.fg.sampling.checks[1].backgroundResponse.min, 3);
  assert.equal(d.fg.sampling.checks[1].passingPixels, 0);
  assert.throws(() => alpha.requirePhotoshopAlphaPassed(d, 'fg'), /薄纱/);
  await f.rgba(0);
  const tiny = structuredClone(f.plan);
  tiny.layers[0].alphaChecks![1].minPassingFraction = 1e-15;
  d = (await alpha.inspectPhotoshopAlphaChecks(alpha.capturePhotoshopAlphaContext(f.j, tiny, {}), f.render()))!;
  assert.equal(d.fg.sampling.checks[1].requiredPassingPixels, 1);
  assert.equal(d.fg.passed, false);
  await f.rgba(128);
  d = (await alpha.inspectPhotoshopAlphaChecks(context, f.render()))!;
  assert.equal(d.fg.passed, true);
  assert.equal(d.fg.sampling.checks[1].alpha.mean, 128);
  assert.equal(d.fg.sampling.checks[1].backgroundResponse.mean, 127);
  alpha.verifyPhotoshopAlphaChecks(context, f.render(), d);
  alpha.requirePhotoshopAlphaPassed(d);
  await f.rgba(128, 255);
  d = (await alpha.inspectPhotoshopAlphaChecks(context, f.render()))!;
  assert.equal(d.fg.sampling.checks[0].passed, false);
});

test('PS alpha downscaled source corner samples a real canvas pixel and never rescales a wrong-sized group export', async () => {
  const f = await fixture({ width: 10, height: 10 });
  f.plan.layers[0].alphaChecks = [{ ...clear, box: [99, 99, 1, 1] }];
  await f.rgba(255);
  const context = alpha.capturePhotoshopAlphaContext(f.j, f.plan, {}), d = (await alpha.inspectPhotoshopAlphaChecks(context, f.render()))!;
  assert.deepEqual(d.fg.sampling.checks[0].canvasBox, [9, 9, 1, 1]);
  assert.equal(d.fg.sampling.checks[0].alpha.min, 255);
  assert.equal(d.fg.passed, false);
  await sharp({ create: { width: 2, height: 2, channels: 4, background: '#00000000' } }).png().toFile(f.png);
  await assert.rejects(alpha.inspectPhotoshopAlphaChecks(context, f.render()), /完整画布/);
});

test('PS alpha cached results bind sources, rules, source owner, PSD, group PNG, selected material and placement chain', async () => {
  const f = await fixture();
  const materialFile = path.join(f.folder, 'material.png'); fs.copyFileSync(f.png, materialFile);
  const materials = { fg: { provenance: 'generated', status: 'ready', originalPath: materialFile,
    workingPath: materialFile, originalSize: { width: 100, height: 100 }, placementFrame: f.plan.layers[0].frame,
    repair: { kind: 'fixture', version: 1 }, receipt: { outputHash: hash(materialFile) } } };
  const context = alpha.capturePhotoshopAlphaContext(f.j, f.plan, materials), render = f.render(), d = (await alpha.inspectPhotoshopAlphaChecks(context, render))!;
  assert.throws(() => alpha.verifyPhotoshopAlphaChecks(context, render, undefined), /缺失/);
  const old = structuredClone(d); old.fg.version = 0 as any;
  assert.throws(() => alpha.verifyPhotoshopAlphaChecks(context, render, old), /版本旧/);
  for (const alter of [
    (_j: Job, p: typeof f.plan, _m: typeof materials) => {
      const check = p.layers[0].alphaChecks![1]; assert.notEqual(check.kind, 'occupied');
      if (check.kind !== 'occupied') check.maxAlpha = 210;
    },
    (j: Job, _p: typeof f.plan, _m: typeof materials) => { j.snapshot.layers[0].frame = { x: 10, y: 10, width: 90, height: 90 }; },
    (_j: Job, _p: typeof f.plan, m: typeof materials) => { m.fg.placementFrame = { ...m.fg.placementFrame, x: 1 }; },
    (_j: Job, _p: typeof f.plan, m: typeof materials) => { m.fg.repair.version = 2; },
    (_j: Job, _p: typeof f.plan, m: typeof materials) => { Object.assign(m.fg, { choice: 'upscaled', upscaledPath: materialFile }); },
    (j: Job, _p: typeof f.plan, _m: typeof materials) => { j.taskId += '_other'; },
  ]) {
    const j = structuredClone(f.j), p = structuredClone(f.plan), m = structuredClone(materials); alter(j, p, m);
    assert.throws(() => alpha.verifyPhotoshopAlphaChecks(alpha.capturePhotoshopAlphaContext(j, p, m), render, d), /变化/);
  }
  const source = store.assetPath(f.j.documentId, f.j.snapshot.source);
  for (const file of [source, materialFile, f.psdPath, f.png]) {
    const bytes = fs.readFileSync(file); fs.appendFileSync(file, 'changed');
    assert.throws(() => alpha.verifyPhotoshopAlphaChecks(alpha.capturePhotoshopAlphaContext(f.j, f.plan, materials), render, d), /变化/);
    fs.writeFileSync(file, bytes);
  }
  // Recording an accepted review/upscale receipt is not a pixel or placement change.
  Object.assign(materials.fg, { choice: 'original', upscaleEvidence: { psdHash: render.hash } });
  alpha.verifyPhotoshopAlphaChecks(alpha.capturePhotoshopAlphaContext(f.j, f.plan, materials), render, d);
});
