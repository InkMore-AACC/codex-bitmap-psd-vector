import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { evaluateMatteFeasibility, requireMatteFeasibility } from '../server/generation-matte-feasibility.js';
import { evaluateGenerationAlphaChecks } from '../server/generation-alpha-checks.js';
import type { GenerationAlphaCheck } from '../shared/generation.js';
const root = path.resolve('test-output/matte-feasibility-' + crypto.randomUUID()); fs.mkdirSync(root, { recursive: true });
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
async function carrier(width: number, height: number, alphas: number[]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < alphas.length; i++) data.set([121, 73, 96, alphas[i]], i * 4);
  const bytes = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const workingPath = path.join(root, crypto.randomUUID() + '.png'); fs.writeFileSync(workingPath, bytes);
  return { workingPath, workingHash: hash(bytes), workingSize: { width, height } };
}
const check = (box: [number, number, number, number], fraction = 0.75): GenerationAlphaCheck =>
  ({ name: 'fixed thin material', kind: 'transmissive', box, minAlpha: 24, maxAlpha: 224,
    minBackgroundResponse: 31, minPassingFraction: fraction });

test('v6 opaque samples actual placed alpha including255, exact ceil tolerance and scaled/nonzero carrier coordinates', async () => {
  const base = await carrier(4, 4, [0, 0, 0, 254, ...new Array<number>(12).fill(255)]);
  const solid: GenerationAlphaCheck = { name: 'solid coverage', kind: 'opaque', box: [10, 15, 2, 2], minAlpha: 255, minPassingFraction: 0.75 };
  const input = { ...base, sourceSize: { width: 50, height: 50 }, canvas: { width: 100, height: 100 },
    placementFrame: { x: 20, y: 30, width: 4, height: 4 }, checks: [solid] };
  const necessary = await evaluateMatteFeasibility(input), diagnostic = await evaluateGenerationAlphaChecks({ ...input, originalHash: base.workingHash });
  assert.deepEqual(necessary.checks[0].canvasBox, [20, 30, 4, 4]); assert.equal(necessary.checks[0].eligiblePixels, 12);
  assert.equal(diagnostic.checks[0].passingPixels, 12); assert.equal(diagnostic.checks[0].requiredPassingPixels, 12); assert(diagnostic.passed);
  assert.equal(necessary.materialHash, diagnostic.materialHash); assert(necessary.necessaryConditionMet);
  for (const fraction of [0.7500001, 1]) {
    const stricter: typeof input = { ...input, checks: [{ ...solid, minPassingFraction: fraction }] };
    assert.equal((await evaluateMatteFeasibility(stricter)).necessaryConditionMet, false);
    assert.equal((await evaluateGenerationAlphaChecks({ ...stricter, originalHash: base.workingHash })).passed, false);
  }
  const partial = { ...input, checks: [{ ...solid, minAlpha: 254, minPassingFraction: 13 / 16 }] };
  assert.equal((await evaluateGenerationAlphaChecks({ ...partial, originalHash: base.workingHash })).checks[0].passingPixels, 13);
  const outside = { ...input, checks: [{ ...solid, box: [0, 0, 1, 1] as [number, number, number, number], minPassingFraction: 1e-15 }] };
  assert.equal((await evaluateMatteFeasibility(outside)).checks[0].eligiblePixels, 0);
  assert.equal((await evaluateGenerationAlphaChecks({ ...outside, originalHash: base.workingHash })).passed, false);
});

test('matte feasibility tolerates partial zeros, counts alpha255 as reducible and uses exact ceil per ROI', async () => {
  const base = await carrier(4, 4, [0, 0, 0, 23, ...new Array<number>(12).fill(255)]);
  const input = { ...base, placementFrame: { x: 20, y: 30, width: 4, height: 4 },
    sourceSize: { width: 100, height: 100 }, canvas: { width: 100, height: 100 }, checks: [check([20, 30, 4, 4])] };
  const result = await evaluateMatteFeasibility(input); requireMatteFeasibility(result);
  assert.equal(result.checks[0].eligiblePixels, 12); assert.equal(result.checks[0].requiredPixels, 12);
  assert.equal(result.necessaryConditionMet, true);
  // Opaque pixels fail the final upper/response check but can be reduced by M.
  const diagnostic = await evaluateGenerationAlphaChecks({ ...input, originalHash: base.workingHash });
  assert.equal(diagnostic.passed, false); assert.equal(diagnostic.materialHash, result.materialHash);
  const stricter = await evaluateMatteFeasibility({ ...input, checks: [check([20, 30, 4, 4], 0.7500001)] });
  assert.equal(stricter.checks[0].requiredPixels, 13); assert.equal(stricter.necessaryConditionMet, false);
  assert.throws(() => requireMatteFeasibility(stricter), /至少需13/);
});

test('matte feasibility uses source-to-canvas mapping and actual uniform carrier restoration with nonzero origin', async () => {
  const base = await carrier(2, 2, [24, 24, 24, 24]);
  const result = await evaluateMatteFeasibility({ ...base, sourceSize: { width: 100, height: 100 },
    canvas: { width: 200, height: 200 }, placementFrame: { x: 50, y: 60, width: 4, height: 4 },
    checks: [check([25, 30, 2, 2], 1)] });
  assert.deepEqual(result.checks[0].canvasBox, [50, 60, 4, 4]); assert.equal(result.checks[0].pixels, 16);
  assert.equal(result.checks[0].eligiblePixels, 16); assert.equal(result.necessaryConditionMet, true);
});

test('matte feasibility checks all ROIs independently and never invents downscaled corner pixels', async () => {
  const base = await carrier(1, 1, [24]), input = { ...base,
    sourceSize: { width: 1000, height: 1000 }, canvas: { width: 100, height: 100 },
    placementFrame: { x: 99, y: 99, width: 1, height: 1 }, checks: [check([999, 999, 1, 1], 0.0001)] };
  const result = await evaluateMatteFeasibility(input);
  assert.deepEqual(result.checks[0].canvasBox, [99, 99, 1, 1]); assert.equal(result.checks[0].requiredPixels, 1);
  assert.equal(result.necessaryConditionMet, true);
  const second = { ...check([0, 0, 1, 1], 0.0001), name: 'second ROI outside placed material' };
  const multiple = await evaluateMatteFeasibility({ ...input, checks: [...input.checks, second] });
  assert.equal(multiple.checks[0].necessaryConditionMet, true); assert.equal(multiple.checks[1].eligiblePixels, 0);
  assert.equal(multiple.necessaryConditionMet, false);
  assert.throws(() => requireMatteFeasibility(multiple), /second ROI/);
});

test('matte feasibility rejects hashes, dimensions and guessed fractional placement and rechecks snapshot sources after awaits', async () => {
  const base = await carrier(2, 2, [24, 24, 24, 24]), input = { ...base,
    sourceSize: { width: 100, height: 100 }, canvas: { width: 100, height: 100 },
    placementFrame: { x: 20, y: 20, width: 2, height: 2 }, checks: [check([20, 20, 2, 2])] };
  await assert.rejects(evaluateMatteFeasibility({ ...input, workingHash: '0'.repeat(64) }), /摘要已变化/);
  await assert.rejects(evaluateMatteFeasibility({ ...input, workingSize: { width: 1, height: 4 } }), /实际尺寸/);
  await assert.rejects(evaluateMatteFeasibility({ ...input, placementFrame: { ...input.placementFrame, x: 20.5 } }), /真实整数放置/);
  const read = fs.readFileSync; let fired = false;
  fs.readFileSync = ((p: any, ...args: any[]) => {
    const bytes = Reflect.apply(read, fs, [p, ...args]);
    if (!fired && p === input.workingPath) { fired = true; fs.appendFileSync(p, 'changed after actual snapshot read'); }
    return bytes;
  }) as typeof fs.readFileSync;
  try { await assert.rejects(evaluateMatteFeasibility(input), /期间真实工作文件已变化/); assert(fired); }
  finally { fs.readFileSync = read; }
});
