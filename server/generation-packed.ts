import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Job } from './types.js';
import type { GenerationRecord, GenerationState } from './generation.js';
import type { PackedBackdrop } from '../shared/generation.js';
import { packedBackdropSchema } from '../shared/generation.js';
import { assetPath } from './store.js';
import { originalReference } from './references.js';
import { aspectError, ASPECT_TOLERANCE, GENERATION_PIXEL_BUDGET } from '../shared/generation-geometry.js';
import { applyDualBackdrop, matteDigest, matteSignature, validateBackdropRaw } from './generation-matte.js';

export const PACKED_ALGORITHM = 'single-carrier-black-white-unmix-v1' as const;
const file = (p: string) => ({ path: path.resolve(p), hash: matteDigest(fs.readFileSync(p)) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fail = (message: string) => Object.assign(new Error(message), { status: 400 });
type Request = GenerationState['requests'][number];
export type PackedCarrier = {
  id: string; requestId: string; bindingHash: string; recipe: PackedBackdrop;
  toolOutput: { path: string; hash: string }; original: { path: string; hash: string };
  working: { path: string; hash: string }; originalSize: { width: number; height: number };
  workingSize: { width: number; height: number };
  receipt: { tool: 'image_gen'; toolHistoryVerified: false; modelCalls: 1; prompt: string; referencePaths: string[] };
};
export type PackedAlphaProof = {
  algorithm: typeof PACKED_ALGORITHM; packedId: string; carrierRecordHash: string;
  bindingHash: string; black: { path: string; hash: string }; white: { path: string; hash: string };
  outputHash: string; outputSize: { width: number; height: number };
  unmix: Awaited<ReturnType<typeof applyDualBackdrop>>['unmix'];
};
export function packedBinding(j: Job, s: GenerationState, q: Request) {
  const l = s.layout?.layers.find(l => same(l.sourceLayerIds, q.sourceLayerIds));
  if (!q.packedBackdrop || !l?.packedBackdrop || !same(q.packedBackdrop, l.packedBackdrop) ||
      !['layer', 'revise'].includes(j.type) || j.reconstructionWorkflowVersion !== 4 || j.reconstructionVersion !== 3 ||
      q.sourceLayerIds.length !== 1 || q.role || q.background || q.surface !== 'transparent' ||
      (q.blendMode || 'normal') !== 'normal' || q.matteBackdrop || q.allowAuxMatte || q.nativeText ||
      q.referenceContext || q.detailReferences || q.referencePresentation || q.sourceProtection ||
      !q.localPath || !q.carrier || q.carrier.expanded || !same(q.alphaChecks, l.alphaChecks) ||
      !q.alphaChecks?.some(c => c.kind === 'clear') || !q.alphaChecks.some(c => c.kind === 'transmissive') ||
      !q.alphaChecks.some(c => c.kind === 'occupied' || c.kind === 'opaque') ||
      q.referencePaths.some((p, i) => file(p).hash !== q.referenceHashes[i]))
    throw fail('单次双板的本任务/事前计划/完整干净参考绑定不符；不能追改旧请求或混入其他来源');
  packedBackdropSchema.parse(q.packedBackdrop);
  if (aspectError(q.packedBackdrop.panelSize, q.frame) > ASPECT_TOLERANCE)
    throw fail('双板panel比例必须匹配冻结完整frame，不能拉伸或添加承载');
  return matteSignature({ taskId: j.taskId, jobId: j.id, documentId: j.documentId,
    snapshot: j.snapshot, layerIds: j.layerIds, frameContractVersion: j.frameContractVersion,
    reconstructionVersion: j.reconstructionVersion, reconstructionWorkflowVersion: j.reconstructionWorkflowVersion,
    layout: s.layout, request: q,
    source: file(assetPath(j.documentId, j.snapshot.status === 'preview' ? j.snapshot.source : j.snapshot.url || j.snapshot.source)),
    original: file(originalReference(j.documentId, j.snapshot).path), cleanLocal: file(q.localPath) });
}
/** Normalize the WHOLE generated carrier once. The midpoint is fixed; never detect content, align panels or crop source pixels. */
export async function normalizePackedCarrier(raw: Buffer, recipe: PackedBackdrop) {
  packedBackdropSchema.parse(recipe);
  const proof = await validateBackdropRaw(raw), size = proof.size;
  if (size.width % 2 || aspectError(size, { width: recipe.panelSize.width * 2, height: recipe.panelSize.height }) > ASPECT_TOLERANCE)
    throw fail('真实双板carrier须偶数宽且匹配事前冻结完整比例；拒绝找边界、裁边、拼接或重配准');
  const scale = Math.min(1, Math.sqrt(GENERATION_PIXEL_BUDGET / (size.width * size.height)));
  const width = scale < 1 ? 2 * Math.floor(size.width * scale / 2) : size.width;
  const height = scale < 1 ? Math.floor(size.height * scale) : size.height;
  if (width < 2 || height < 1 || width * height > GENERATION_PIXEL_BUDGET)
    throw fail('完整双板carrier预算或尺寸无效');
  // Negative-lobe interpolation across unlike backing colors can create an
  // impossible pair even when the original pair is exact. V1 remains frozen;
  // only new explicit V2 requests use one nearest resample of the WHOLE file.
  let bytes = raw;
  if (scale < 1 && recipe.version === 1) bytes = await sharp(raw).resize(width, height, { kernel: 'lanczos3' }).png().toBuffer();
  if (scale < 1 && recipe.version === 2) {
    // Use ONE shared pixel-centre map for both halves. A library whole-image
    // nearest resize can still phase the two halves differently at exact
    // rounding boundaries; shared indices preserve a known physical pair.
    const pixels = await sharp(raw).toColourspace('srgb').ensureAlpha().raw().toBuffer();
    const output = Buffer.alloc(width * height * 4), oldHalf = size.width / 2, half = width / 2;
    const xs = Array.from({ length: half }, (_, x) => Math.min(oldHalf - 1, Math.floor((x + 0.5) * oldHalf / half)));
    for (let y = 0; y < height; y++) {
      const sy = Math.min(size.height - 1, Math.floor((y + 0.5) * size.height / height));
      for (let x = 0; x < half; x++) for (let side = 0; side < 2; side++) {
        const i = (sy * size.width + xs[x] + side * oldHalf) * 4;
        output.set(pixels.subarray(i, i + 4), (y * width + x + side * half) * 4);
      }
    }
    bytes = await sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
  }
  return { bytes, originalSize: size, workingSize: { width, height } };
}
export function verifyPackedCarrier(j: Job, s: GenerationState, c: PackedCarrier) {
  const q = s.requests.find(q => q.id === c.requestId);
  if (!q || packedBinding(j, s, q) !== c.bindingHash || !same(q.packedBackdrop, c.recipe) ||
      c.receipt.tool !== 'image_gen' || c.receipt.toolHistoryVerified !== false || c.receipt.modelCalls !== 1 ||
      c.receipt.prompt !== q.prompt || !same(c.receipt.referencePaths, q.referencePaths) ||
      file(c.toolOutput.path).hash !== c.toolOutput.hash || file(c.original.path).hash !== c.original.hash ||
      c.toolOutput.hash !== c.original.hash || file(c.working.path).hash !== c.working.hash ||
      c.workingSize.width % 2 || c.workingSize.width * c.workingSize.height > GENERATION_PIXEL_BUDGET)
    throw fail('真实单次carrier原件/工作件/请求/来源摘要已变化');
  return q;
}
export async function splitPackedCarrier(bytes: Buffer) {
  const proof = await validateBackdropRaw(bytes), { width, height } = proof.size;
  if (width % 2 || width * height > GENERATION_PIXEL_BUDGET) throw fail('完整双板工作carrier超过预算或无法按固定中线拆板');
  const half = width / 2;
  const black = await sharp(bytes).extract({ left: 0, top: 0, width: half, height }).png().toBuffer();
  const white = await sharp(bytes).extract({ left: half, top: 0, width: half, height }).png().toBuffer();
  return { black, white, size: { width: half, height } };
}
// Cache only from actual raw/whole-working/panels/fixed equation bytes, never a caller-written proof.
const verified = new Set<string>();
const key = (c: PackedCarrier, p: PackedAlphaProof) => matteSignature({ c, p });
export async function primePackedAlpha(j: Job, s: GenerationState, r: GenerationRecord) {
  const p = r.packedAlpha, c = s.packedCarriers?.find(c => c.id === p?.packedId);
  if (!p || !c) throw fail('双板派生缺少真实单次carrier身份');
  verifyPackedCarrier(j, s, c);
  for (const f of [p.black, p.white]) if (file(f.path).hash !== f.hash) throw fail('双板派生板件已变化');
  const bytes = fs.readFileSync(r.workingPath);
  if (matteDigest(bytes) !== p.outputHash) throw fail('双板派生输出字节已变化');
  if (!verified.has(key(c, p))) {
    const normalized = await normalizePackedCarrier(fs.readFileSync(c.original.path), c.recipe);
    if (matteDigest(normalized.bytes) !== c.working.hash || !same(normalized.originalSize, c.originalSize) ||
        !same(normalized.workingSize, c.workingSize)) throw fail('双板完整工作件不是完整真实carrier的固定预算结果');
    const panels = await splitPackedCarrier(normalized.bytes), result = await applyDualBackdrop(panels.black, panels.white);
    if (matteDigest(panels.black) !== p.black.hash || matteDigest(panels.white) !== p.white.hash ||
        matteDigest(result.bytes) !== p.outputHash || !same(result.size, p.outputSize) || !same(result.unmix, p.unmix))
      throw fail('双板派生不是从单次carrier固定中线及原方程得出；拒绝调alpha/颜色/位置');
    verified.add(key(c, p));
  }
  verifyPackedAlpha(j, s, r);
}
export function verifyPackedAlpha(j: Job, s: GenerationState, r: GenerationRecord) {
  const p = r.packedAlpha, c = s.packedCarriers?.find(c => c.id === p?.packedId);
  if (!p || !c || p.algorithm !== PACKED_ALGORITHM || r.kind !== 'derived-packed-alpha' ||
      r.receipt.tool !== 'derived-packed-alpha' || r.receipt.toolHistoryVerified !== false ||
      r.receipt.packedId !== c.id || p.carrierRecordHash !== matteSignature(c) || p.bindingHash !== c.bindingHash ||
      !verified.has(key(c, p))) throw fail('单次双板派生尚未从真实字节验证或来源角色不符');
  const q = verifyPackedCarrier(j, s, c);
  if (p.outputHash !== r.hash || p.outputHash !== r.workingHash || !same(p.outputSize, r.originalSize) ||
      !same(p.outputSize, r.workingSize) || !same(p.outputSize, { width: c.workingSize.width / 2, height: c.workingSize.height }) ||
      r.requestId !== q.id || !same(r.sourceLayerIds, q.sourceLayerIds) || !same(r.frame, q.frame) ||
      !same(r.placementFrame, q.frame) || (r.blendMode || 'normal') !== 'normal' ||
      file(r.originalPath).hash !== p.outputHash || file(r.workingPath).hash !== p.outputHash ||
      r.receipt.prompt !== q.prompt || !same(r.receipt.referencePaths, q.referencePaths) ||
      file(p.black.path).hash !== p.black.hash || file(p.white.path).hash !== p.white.hash)
    throw fail('双板派生尺寸/位置/来源/文件不符；完整板面不能独立裁切或重新定位');
}
