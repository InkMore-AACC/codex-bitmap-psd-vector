import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { deriveProtectedBackgroundSnapshot, verifyProtectedBackgroundSnapshot,
  type BackgroundProtectionInputs } from '../server/background-protection-snapshot.js';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const sourcePixels = Buffer.from([255,0,0,255, 11,22,33,255, 0,0,0,255, 8,7,6,255]);
const fillPixels = Buffer.from([0,200,100,255, 91,82,73,255, 41,42,43,255, 80,70,60,255]);
async function png(pixels: Buffer, width = 2) {
  return sharp(pixels, { raw: { width, height: pixels.length / (width * 4), channels: 4 } }).png().toBuffer();
}
async function fixture(t: TestContext) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bg-snapshot-'));
  // Only remove this test's freshly created temporary directory, never a project asset.
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const files = { source: await png(sourcePixels), generated: await png(fillPixels),
    keepMask: await png(Buffer.from([255,255,255,255, 0,0,0,255, 255,255,255,255, 0,0,0,255])) };
  const entries = Object.fromEntries(Object.entries(files).map(([role, bytes]) => {
    const file = path.join(folder, role + '.png'); fs.writeFileSync(file, bytes);
    return [role, { path: file, hash: sha(bytes) }];
  })) as Pick<BackgroundProtectionInputs, 'source'|'generated'|'keepMask'>;
  return { input: { ...entries, scope: { taskId: 'current-task', jobId: 'current-job', documentId: 'current-document',
    imageId: 'current-image', parentGenerationId: 'real-imagegen-parent', planHash: 'a'.repeat(64), requestHash: 'b'.repeat(64) } }, files };
}

test('immutable snapshots retain exact source RGB and use real fill pixels for every unknown pixel', async t => {
  const { input, files } = await fixture(t);
  const result = await deriveProtectedBackgroundSnapshot(input);
  const decoded = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  assert.deepEqual(decoded, Buffer.from([255,0,0,255, 91,82,73,255, 0,0,0,255, 80,70,60,255]));
  assert.equal(result.proof.tool, 'derived-background'); assert.equal(result.proof.keptPixels, 2);
  assert.equal(result.proof.generatedFillPixels, 2);
  assert.deepEqual(await verifyProtectedBackgroundSnapshot(input, result.proof, result.bytes), result.bytes);
  for (const role of ['source','generated','keepMask'] as const) assert.deepEqual(fs.readFileSync(input[role].path), files[role]);
});

test('each source file is independently checked before use and again by a warm consumer', async t => {
  for (const role of ['source','generated','keepMask'] as const) {
    const { input } = await fixture(t), result = await deriveProtectedBackgroundSnapshot(input);
    fs.appendFileSync(input[role].path, 'changed');
    await assert.rejects(deriveProtectedBackgroundSnapshot(input), /bytes changed/);
    await assert.rejects(verifyProtectedBackgroundSnapshot(input, result.proof, result.bytes), /bytes changed/);
  }
});

test('a source change during image decoding cannot commit a result made from stale bytes', async t => {
  const { input } = await fixture(t);
  const operation = deriveProtectedBackgroundSnapshot(input); // snapshots read synchronously before its first await
  fs.appendFileSync(input.generated.path, 'changed-during-await');
  await assert.rejects(operation, /bytes changed/);
});

test('task, parent, plan and request identities cannot be changed on an existing proof', async t => {
  const { input } = await fixture(t), result = await deriveProtectedBackgroundSnapshot(input);
  for (const key of ['taskId','jobId','imageId','documentId','parentGenerationId','planHash','requestHash'] as const) {
    const changed = structuredClone(input); changed.scope[key] = key.endsWith('Hash') ? 'c'.repeat(64) : 'other';
    await assert.rejects(verifyProtectedBackgroundSnapshot(changed, result.proof, result.bytes), /source chain differs/);
  }
  const mutable = structuredClone(input), operation = deriveProtectedBackgroundSnapshot(mutable);
  mutable.scope.jobId = 'changed-during-await';
  await assert.rejects(operation, /caller binding changed/);
});

test('forging the stored output hash and pixel hash cannot replace the source-or-fill mapping', async t => {
  const { input } = await fixture(t), result = await deriveProtectedBackgroundSnapshot(input);
  const fakeProof = structuredClone(result.proof), wrongBytes = await png(fillPixels);
  fakeProof.outputHash = sha(wrongBytes);
  fakeProof.outputPixelHash = sha(Buffer.concat([Buffer.from('2,2,RGBA8\0'), fillPixels]));
  await assert.rejects(verifyProtectedBackgroundSnapshot(input, fakeProof, wrongBytes), /do not reproduce/);
  const wrongKind = { ...result.proof, tool: 'image_gen' } as unknown as typeof result.proof;
  await assert.rejects(verifyProtectedBackgroundSnapshot(input, wrongKind, result.bytes), /derived identity/);
});

test('binary mask semantics, full canvas and opaque source are enforced without implicit repair', async t => {
  for (const change of ['feather','color','alpha','mask-size','source-alpha','fill-size'] as const) {
    const { input } = await fixture(t);
    let role: 'source'|'generated'|'keepMask' = 'keepMask', bytes: Buffer;
    const mask = Buffer.from([255,255,255,255, 0,0,0,255, 255,255,255,255, 0,0,0,255]);
    if (change === 'feather') mask.set([127,127,127,255], 4);
    if (change === 'color') mask.set([0,255,0,255], 4);
    if (change === 'alpha') mask[3] = 254;
    if (change === 'source-alpha') { role='source'; const v=Buffer.from(sourcePixels); v[3]=254; bytes=await png(v); }
    else if (change === 'fill-size') { role='generated'; bytes=await png(fillPixels, 1); }
    else bytes = await png(mask, change === 'mask-size' ? 1 : 2);
    fs.writeFileSync(input[role].path, bytes); input[role].hash=sha(bytes);
    await assert.rejects(deriveProtectedBackgroundSnapshot(input), /binary|opaque|full source canvas|identical full-file/);
  }
});

test('re-encoding cannot convert a derived background into a tool original', async t => {
  const { input } = await fixture(t), result = await deriveProtectedBackgroundSnapshot(input);
  const reencoded = await sharp(result.bytes).png({ compressionLevel: 0 }).toBuffer();
  assert.notEqual(sha(reencoded), result.proof.outputHash);
  const proof = { ...result.proof, outputHash: sha(reencoded) };
  assert.deepEqual(await verifyProtectedBackgroundSnapshot(input, proof, reencoded), reencoded);
  assert.equal(proof.tool, 'derived-background');
});

test('an RGB PNG carrying an ICC profile cannot silently change protected source channels', async t => {
  for (const role of ['source','generated','keepMask'] as const) {
    const { input, files } = await fixture(t);
    const profiled = await sharp(files[role]).withIccProfile('p3').png().toBuffer();
    const meta = await sharp(profiled).metadata();
    assert.equal(meta.space, 'srgb'); assert.ok(meta.icc?.length);
    fs.writeFileSync(input[role].path, profiled); input[role].hash = sha(profiled);
    await assert.rejects(deriveProtectedBackgroundSnapshot(input), /without an embedded ICC profile/);
  }
  const { input } = await fixture(t), result = await deriveProtectedBackgroundSnapshot(input);
  const output = await sharp(result.bytes).withIccProfile('p3').png().toBuffer();
  const proof = { ...result.proof, outputHash: sha(output) };
  await assert.rejects(verifyProtectedBackgroundSnapshot(input, proof, output), /without an embedded ICC profile/);
});
