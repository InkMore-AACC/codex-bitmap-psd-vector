import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { protectKnownBackgroundRgba } from './background-source-protection.js';
import { MATERIAL_REPAIR_PIXEL_BUDGET } from './photoshop-material-repair.js';

type EvidenceFile = { path: string; hash: string };
export type BackgroundProtectionScope = {
  taskId: string; documentId: string; imageId: string; jobId: string;
  parentGenerationId: string; planHash: string; requestHash: string;
};
export type BackgroundProtectionInputs = {
  scope: BackgroundProtectionScope;
  source: EvidenceFile; generated: EvidenceFile; keepMask: EvidenceFile;
};
export type ProtectedBackgroundProof = BackgroundProtectionInputs & {
  algorithm: 'binary-source-or-generated-rgba8-v1';
  tool: 'derived-background';
  outputHash: string; outputPixelHash: string;
  size: { width: number; height: number };
  keptPixels: number; generatedFillPixels: number;
};
const digest = (b: Buffer | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
const signature = (value: unknown) => digest(Buffer.from(JSON.stringify(stable(value))));
const fail = (message: string) => new Error(`Background protection: ${message}`);
const normalized = (p: string) => path.resolve(p).toLowerCase();
const roles = ['source', 'generated', 'keepMask'] as const;

function validateInputs(input: BackgroundProtectionInputs) {
  if (['taskId', 'documentId', 'imageId', 'jobId', 'parentGenerationId', 'planHash', 'requestHash']
      .some(key => typeof input.scope[key as keyof BackgroundProtectionScope] !== 'string' ||
        !input.scope[key as keyof BackgroundProtectionScope].trim()) ||
      !/^[a-f0-9]{64}$/.test(input.scope.planHash) || !/^[a-f0-9]{64}$/.test(input.scope.requestHash))
    throw fail('complete current task/job/parent/plan/request binding is required');
  for (const role of roles) if (!path.isAbsolute(input[role].path) || !/^[a-f0-9]{64}$/.test(input[role].hash))
    throw fail('each input needs an absolute path and frozen SHA256');
  if (new Set(roles.map(role => normalized(input[role].path))).size !== roles.length)
    throw fail('source, real generated fill and independent keep mask must have distinct paths');
}
function readInputs(input: BackgroundProtectionInputs) {
  validateInputs(input);
  const snapshots = Object.fromEntries(roles.map(role => {
    const bytes = fs.readFileSync(input[role].path);
    if (digest(bytes) !== input[role].hash) throw fail(`${role} bytes changed from the frozen binding`);
    return [role, bytes];
  })) as Record<typeof roles[number], Buffer>;
  // Byte aliases cannot acquire a different role just by being copied elsewhere.
  if (new Set(roles.map(role => digest(snapshots[role]))).size !== roles.length)
    throw fail('input roles cannot be byte aliases');
  return snapshots;
}
export function verifyBackgroundProtectionFiles(input: BackgroundProtectionInputs) {
  readInputs(input);
}
async function rgba(bytes: Buffer, role: string) {
  const meta = await sharp(bytes).metadata();
  if (meta.format !== 'png' || meta.depth !== 'uchar' || !meta.width || !meta.height ||
      meta.width * meta.height > MATERIAL_REPAIR_PIXEL_BUDGET || (meta.pages && meta.pages > 1))
    throw fail(`${role} must be a complete single PNG8 canvas within 1500000 pixels`);
  // Sharp reports space=srgb for some RGB PNGs carrying a Display-P3 ICC.
  // toColourspace would then change encoded RGB. Canonicalization belongs to
  // the caller's explicit source chain, never to this exact-pixel kernel.
  if (meta.icc?.length)
    throw fail(`${role} must be the canonical working PNG without an embedded ICC profile; implicit conversion is forbidden`);
  if (role !== 'keepMask' && meta.space !== 'srgb')
    throw fail(`${role} must already be the canonical sRGB working file; no implicit color conversion`);
  const { data, info } = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
async function render(snapshots: Record<typeof roles[number], Buffer>) {
  const [source, generated, mask] = await Promise.all([
    rgba(snapshots.source, 'source'), rgba(snapshots.generated, 'generated'), rgba(snapshots.keepMask, 'keepMask'),
  ]);
  if (mask.width !== source.width || mask.height !== source.height)
    throw fail('keep mask must use the full source canvas without crop or resize');
  const keepMask = new Uint8Array(mask.width * mask.height);
  for (let p = 0; p < keepMask.length; p++) {
    const k = p * 4, v = mask.data[k];
    if (mask.data[k + 3] !== 255 || mask.data[k + 1] !== v || mask.data[k + 2] !== v || (v !== 0 && v !== 255))
      throw fail('keep mask must be opaque exact binary gray; alpha, feather or color is not selection');
    keepMask[p] = v;
  }
  return protectKnownBackgroundRgba({ source, generated, keepMask });
}
/** Reject unusable selection/source before preparing a real generated parent.
 * Semantic approval remains an independent source-and-mask review. */
export async function validateBackgroundSelectionSnapshot(sourceBytes: Buffer, maskBytes: Buffer,
  size: { width: number; height: number }) {
  const [source, mask] = await Promise.all([rgba(sourceBytes, 'source'), rgba(maskBytes, 'keepMask')]);
  if (source.width !== size.width || source.height !== size.height || mask.width !== size.width || mask.height !== size.height)
    throw fail('source and selection must already use the full frozen canvas without resize');
  let kept=0, filled=0;
  for(let p=0;p<size.width*size.height;p++) {
    const k=p*4, v=mask.data[k];
    if(source.data[k+3]!==255)throw fail('clean background source canvas must be opaque');
    if(mask.data[k+3]!==255 || mask.data[k+1]!==v || mask.data[k+2]!==v || (v!==0 && v!==255))
      throw fail('selection must be opaque exact binary gray');
    if(v===255)kept++;else filled++;
  }
  if(!kept || !filled)throw fail('selection needs both confirmed background and generated fill');
  return {keptPixels:kept,generatedFillPixels:filled};
}
const pixelHash = (image: { data: Uint8Array; width: number; height: number }) =>
  digest(Buffer.concat([Buffer.from(`${image.width},${image.height},RGBA8\0`), Buffer.from(image.data)]));

/** Snapshot/provenance core only: it does not authorize a route, identify clean
 * background, approve a mask, or register a material. The integration caller
 * must first verify the actual parent registration and the pre-prepare opt-in,
 * then compare the complete job/registry/plan after every await before commit.
 * No files or registry entries are written here. */
export async function deriveProtectedBackgroundSnapshot(input: BackgroundProtectionInputs) {
  const captured = structuredClone(input), inputSignature = signature(captured);
  const snapshots = readInputs(captured), result = await render(snapshots);
  const bytes = await sharp(Buffer.from(result.image.data), {
    raw: { width: result.image.width, height: result.image.height, channels: 4 },
  }).png().toBuffer();
  if (signature(input) !== inputSignature) throw fail('caller binding changed during derivation');
  verifyBackgroundProtectionFiles(captured);
  const proof: ProtectedBackgroundProof = { ...captured,
    algorithm: 'binary-source-or-generated-rgba8-v1', tool: 'derived-background',
    outputHash: digest(bytes), outputPixelHash: pixelHash(result.image),
    size: { width: result.image.width, height: result.image.height },
    keptPixels: result.keptPixels, generatedFillPixels: result.generatedFillPixels,
  };
  return { bytes, proof };
}

/** Rebuild the promised pixel identity from verified input snapshots. A valid
 * stored digest alone cannot bless a tampered product or a new source chain.
 * Re-encoded pixels remain a derived-background; this never grants image_gen. */
export async function verifyProtectedBackgroundSnapshot(input: BackgroundProtectionInputs,
  proof: ProtectedBackgroundProof, outputBytes: Buffer) {
  const frozenInput = structuredClone(input), frozenProof = structuredClone(proof);
  if (proof.algorithm !== 'binary-source-or-generated-rgba8-v1' || proof.tool !== 'derived-background' ||
      signature({ scope: proof.scope, source: proof.source, generated: proof.generated, keepMask: proof.keepMask }) !== signature(input))
    throw fail('derived identity or complete source chain differs from the authoritative binding');
  const snapshot = Buffer.from(outputBytes), snapshots = readInputs(frozenInput);
  const expected = await render(snapshots), actual = await rgba(snapshot, 'derived output');
  if (digest(snapshot) !== frozenProof.outputHash || pixelHash(actual) !== frozenProof.outputPixelHash ||
      pixelHash(actual) !== pixelHash(expected.image) ||
      signature(frozenProof.size) !== signature({ width: expected.image.width, height: expected.image.height }) ||
      frozenProof.keptPixels !== expected.keptPixels || frozenProof.generatedFillPixels !== expected.generatedFillPixels)
    throw fail('derived pixels/counts/dimensions do not reproduce the frozen source-or-fill mapping');
  if (signature(input) !== signature(frozenInput) || signature(proof) !== signature(frozenProof))
    throw fail('consumer binding changed during verification');
  verifyBackgroundProtectionFiles(frozenInput);
  return snapshot;
}
