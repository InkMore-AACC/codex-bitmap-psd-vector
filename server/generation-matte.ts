import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import type { Job } from './types.js';
import type { GenerationRecord, GenerationState } from './generation.js';
import { matteBackdropSchema, type MatteBackdrop, type MatteEncoding } from '../shared/generation.js';
import { assetPath } from './store.js';
import { originalReference } from './references.js';
import { aspectError, fitGeometry, GENERATION_PIXEL_BUDGET } from '../shared/generation-geometry.js';

export const MATTE_ALGORITHM = 'min-alpha-direct-gray-v1' as const;
export const BACKDROP_MATTE_ALGORITHM = 'known-backdrop-unmix-gray-v2' as const;
export const DUAL_BACKDROP_ALGORITHM = 'black-white-composite-unmix-v1' as const;
export const matteAlgorithm = (backdrop?: MatteBackdrop) => backdrop?.version === 2
  ? DUAL_BACKDROP_ALGORITHM : backdrop ? BACKDROP_MATTE_ALGORITHM : MATTE_ALGORITHM;
export const NEAR_NEUTRAL_LIMITS = Object.freeze({ maxSpread: 16, materialMinMaxRGB: 8,
  maxMeanMaterialSpread: 2, materialSpreadLimit: 8, maxMaterialOutlierPermille: 1 });
export const NEAR_NEUTRAL_V3_LIMITS = Object.freeze({ materialMinMaxRGB: 8,
  maxMeanMaterialSpread: 2, materialSpreadLimit: 8, maxMaterialOutlierPermille: 1 });
export const MATTE_LUMA_FORMULA = 'round((2126*R+7152*G+722*B)/10000)' as const;
export const matteDigest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
export const matteSignature = (value: unknown) => matteDigest(Buffer.from(JSON.stringify(value)));
const file = (p: string) => ({ path: path.resolve(p), hash: matteDigest(fs.readFileSync(p)) });
const fail = (message: string) => Object.assign(new Error(message), { status: 400 });
// Private process cache is populated only from a byte snapshot with a verified
// SHA. No persisted or caller-written "pixel identity" field is trusted.
const exactRGBAByFileSHA = new Map<string, string>();
type BackdropRawProof = { hash: string; minAlpha: 255; size: { width: number; height: number } };
const verifiedBackdropRaw = new Map<string, BackdropRawProof>();
export async function rememberExactRGBA(snapshot: Buffer) {
  const sha = matteDigest(snapshot), cached = exactRGBAByFileSHA.get(sha);
  if (cached) return cached;
  const meta = await sharp(snapshot).metadata();
  if (!meta.width || !meta.height || meta.width * meta.height > 40_000_000 || meta.format === 'svg' ||
      (meta.pages && meta.pages > 1)) throw fail('精确RGBA身份需要4000万像素以内单张完整位图');
  const { data, info } = await sharp(snapshot).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const identity = crypto.createHash('sha256').update(`${info.width},${info.height},RGBA8\0`).update(data).digest('hex');
  exactRGBAByFileSHA.set(sha, identity);
  return identity;
}
function roleIdentities(s: GenerationState) {
  return [
    ...(s.packedCarriers || []).map(c => ({ kind: 'packed-carrier',
      paths: [c.toolOutput.path, c.original.path, c.working.path], hashes: [c.original.hash, c.working.hash],
      snapshots: [c.original, c.working] })),
    ...(s.packedFailures || []).map(f => ({ kind: 'generated-panel', paths: [f.black.path, f.white.path],
      hashes: [f.black.hash, f.white.hash], snapshots: [f.black, f.white] })),
    ...s.outputs.filter(r => r.packedAlpha || r.kind === 'derived-packed-alpha' || r.receipt.tool === 'derived-packed-alpha')
      .flatMap(r => [{ kind: 'derived-packed-alpha', paths: [r.outputPath, r.originalPath, r.workingPath],
        hashes: [r.hash, r.workingHash], snapshots: [{ path: r.originalPath, hash: r.hash }, { path: r.workingPath, hash: r.workingHash }] },
        ...(r.packedAlpha ? [{ kind: 'generated-panel', paths: [r.packedAlpha.black.path, r.packedAlpha.white.path],
          hashes: [r.packedAlpha.black.hash, r.packedAlpha.white.hash], snapshots: [r.packedAlpha.black, r.packedAlpha.white] }] : [])]),
    ...s.outputs.filter(r => r.kind === 'matte-rgb-base' || !r.derivedAlpha && r.receipt.tool === 'image_gen' &&
      s.requests.find(q => q.id === r.requestId)?.matteBackdrop)
      .map(r => ({ kind: 'matte-rgb-base', paths: [r.outputPath, r.originalPath, r.workingPath],
        hashes: [r.hash, r.workingHash], snapshots: [
          { path: r.originalPath, hash: r.hash }, { path: r.workingPath, hash: r.workingHash }] })),
    ...s.outputs.filter(r => r.kind === 'native-text' || r.receipt.tool === 'native-font-renderer')
      .map(r => ({ kind: 'native-text', paths: [r.outputPath, r.originalPath, r.workingPath],
        hashes: [r.hash, r.workingHash], snapshots: [
          { path: r.originalPath, hash: r.hash }, { path: r.workingPath, hash: r.workingHash }] })),
    ...s.outputs.filter(r => r.kind === 'native-geometry' || r.receipt.tool === 'native-geometry-renderer')
      .map(r => ({ kind: 'native-geometry', paths: [r.outputPath,r.originalPath,r.workingPath], hashes: [r.hash,r.workingHash],
        snapshots: [{path:r.originalPath,hash:r.hash},{path:r.workingPath,hash:r.workingHash}] })),
    ...(s.auxiliaries || []).map(a => ({ kind: 'aux-matte', paths: [a.toolOutput.path, a.originalPath, a.workingPath],
      hashes: [a.hash, a.workingHash, a.toolOutput.hash], snapshots: [
        { path: a.originalPath, hash: a.hash }, { path: a.workingPath, hash: a.workingHash }] })),
    ...s.outputs.filter(r => r.kind === 'derived-alpha' || r.derivedAlpha || r.receipt.tool === 'derived-alpha')
      .map(r => ({ kind: 'derived-alpha', paths: [r.outputPath, r.originalPath, r.workingPath], hashes: [r.hash, r.workingHash],
        snapshots: [{ path: r.originalPath, hash: r.hash }, { path: r.workingPath, hash: r.workingHash }] })),
    ...s.outputs.filter(r=>r.kind==='derived-background'||r.derivedBackground||r.receipt.tool==='derived-background')
      .map(r=>({kind:'derived-background',paths:[r.outputPath,r.originalPath,r.workingPath],hashes:[r.hash,r.workingHash],
        snapshots:[{path:r.originalPath,hash:r.hash},{path:r.workingPath,hash:r.workingHash}]})),
  ];
}
export function hasGeneratedRoles(s: GenerationState) { return roleIdentities(s).length > 0; }
export async function primeGeneratedRoleIdentities(s: GenerationState, candidates: { path: string; hash: string }[] = []) {
  const known = roleIdentities(s);
  if (!known.length) return;
  const files = [...known.flatMap(r => r.snapshots), ...candidates];
  const seen = new Set<string>();
  for (const entry of files) {
    const key = `${path.resolve(entry.path).toLowerCase()}:${entry.hash}`;
    if (seen.has(key)) continue; seen.add(key);
    const snapshot = fs.readFileSync(entry.path);
    if (matteDigest(snapshot) !== entry.hash) throw fail('精确角色身份的真实来源字节摘要已变化');
    await rememberExactRGBA(snapshot);
  }
  // Revalidate after awaits; cached decoding never authorizes changed paths.
  for (const entry of files) if (file(entry.path).hash !== entry.hash)
    throw fail('精确角色身份操作期间来源文件已变化');
}

/** Known backend/auxiliary products cannot acquire an image_gen identity by re-registration. */
export function assertNotGeneratedRoleAlias(s: GenerationState, paths: string[], hashes: string[]) {
  const identities = roleIdentities(s);
  const resolved = paths.map(p => path.resolve(p).toLowerCase());
  for (const known of identities) {
    if (known.paths.some(p => resolved.includes(path.resolve(p).toLowerCase())) || known.hashes.some(h => hashes.includes(h)))
      throw fail(`已登记${known.kind}角色文件不能重登记或以别名冒充image_gen普通图层；必须保留辅助/派生双来源身份`);
    const expected = known.snapshots.map(p => exactRGBAByFileSHA.get(p.hash));
    const actual = hashes.map(h => exactRGBAByFileSHA.get(h));
    if (expected.some(p => !p) || actual.some(p => !p))
      throw fail('精确RGBA角色身份尚未从真实字节预检，不能使用未验证的缓存/后写字段放行');
    if (expected.some(p => actual.includes(p)))
      throw fail(`已登记${known.kind}角色文件的精确RGBA及尺寸别名不能冒充image_gen普通图层；必须保留双来源`);
  }
}

export function captureMatteBinding(j: Job, s: GenerationState, base: GenerationRecord, matteEncoding?: MatteEncoding) {
  const entry = s.layout?.layers.find(l => l.sourceLayerIds.length === 1 && l.sourceLayerIds[0] === base.sourceLayerIds[0]);
  if (!['layer', 'revise'].includes(j.type) || j.reconstructionVersion !== 3 || j.reconstructionWorkflowVersion !== 4 ||
    base.sourceLayerIds.length !== 1 || !entry?.allowAuxMatte || entry.blendMode === 'screen' ||
    !entry.alphaChecks?.some(c => c.kind === 'transmissive') || base.isolationProblem ||
    (base.blendMode || 'normal') !== 'normal' || base.kind === 'derived-alpha' || base.receipt.tool !== 'image_gen' ||
    base.receipt.toolHistoryVerified !== false ||
    j.snapshot.layers.find(l => l.id === base.sourceLayerIds[0])?.role === 'background')
    throw fail('aux-matte仅支持本任务显式opt-in的单层normal透明真实RGB候选及transmissive规则；PS/背景/派生基底不支持');
  const request = s.requests.find(r => r.id === base.requestId);
  if ((entry.matteBackdrop?.version === 2) !== (matteEncoding === 'white-composite-rgb8-v1'))
    throw fail('白底RGB编码仅用于事前冻结version2黑底配对；不能将灰阶matte或旧中灰任务改成双背景');
  if (request?.allowAuxMatte !== true || request.allowAuxMatte !== entry.allowAuxMatte)
    throw fail('辅助matte须在RGB实际生成前的prepare请求显式冻结allowAuxMatte=true；不能事后开启或迁移旧缺字段请求');
  if (JSON.stringify(request.matteBackdrop) !== JSON.stringify(entry.matteBackdrop) ||
      (!!entry.matteBackdrop !== (base.kind === 'matte-rgb-base')) || entry.matteBackdrop &&
      (base.matteBackdropRaw?.hash !== base.hash || base.matteBackdropRaw.minAlpha !== 255))
    throw fail('已知底色RGB基底身份、完整原件不透明证明或事前计划不匹配');
  if (!request || request.role || request.background || !request.localPath ||
    JSON.stringify(request.frame) !== JSON.stringify(base.frame) ||
    JSON.stringify(request.sourceLayerIds) !== JSON.stringify(entry.sourceLayerIds) ||
    JSON.stringify(request.alphaChecks) !== JSON.stringify(entry.alphaChecks))
    throw fail('aux-matte基底不匹配当前冻结来源/请求/规则或缺少合法clean local');
  if (base.workingSize.width * base.workingSize.height > GENERATION_PIXEL_BUDGET)
    throw fail('aux-matte完整基底工作carrier超过150万像素');
  if (request.referenceContext?.referenceMode === 'context-only' &&
      (!request.localReferenceHash || file(request.localPath).hash !== request.localReferenceHash))
    throw fail('单周边只读局部参考已改变，不能重新绑定辅助matte');
  const toolOutput = file(base.outputPath);
  if (toolOutput.hash !== base.hash) throw fail('aux-matte基底真实工具原件已变化');
  return {
    version: 1 as const, taskId: j.taskId, jobId: j.id, documentId: j.documentId,
    ...(entry.matteBackdrop ? { matteBackdrop: entry.matteBackdrop } : {}),
    ...(matteEncoding !== undefined ? { matteEncoding } : {}),
    jobBinding: { snapshotHash: matteSignature(j.snapshot), layerIds: j.layerIds,
      frameContractVersion: j.frameContractVersion, reconstructionVersion: j.reconstructionVersion,
      reconstructionWorkflowVersion: j.reconstructionWorkflowVersion },
    layoutHash: matteSignature(s.layout),
    source: file(assetPath(j.documentId, j.snapshot.status === 'preview' ? j.snapshot.source : j.snapshot.url || j.snapshot.source)),
    auxiliaryOriginal: file(originalReference(j.documentId, j.snapshot).path),
    base: { id: base.id, recordHash: matteSignature(base), toolOutput, original: file(base.originalPath),
      working: file(base.workingPath), size: base.workingSize, frame: base.frame,
      placement: base.placementFrame || base.frame, requestHash: matteSignature(request) },
    cleanLocal: file(request.localPath),
  };
}
export type MatteBinding = ReturnType<typeof captureMatteBinding>;
export type AuxiliaryMatte = {
  id: string; requestId: string; requestHash: string; role: 'aux-matte'; binding: MatteBinding;
  originalPath: string; hash: string; originalSize: { width: number; height: number };
  workingPath: string; workingHash: string; workingSize: { width: number; height: number };
  toolOutput: { path: string; hash: string };
  matteEncoding?: MatteEncoding; encodingProof?: NearNeutralProof;
  receipt: { tool: 'image_gen'; toolHistoryVerified: false; prompt: string; referencePaths: string[]; matteEncoding?: MatteEncoding };
};
export type DerivedAlpha = {
  algorithm: typeof MATTE_ALGORITHM | typeof BACKDROP_MATTE_ALGORITHM | typeof DUAL_BACKDROP_ALGORITHM; binding: MatteBinding; matteId: string; matteRecordHash: string;
  unmix?: { version: 1; maxRecompositionError: number; zeroAlphaPixels: number; clippedChannels: number; color: '#808080' | '#000000'; space: 'srgb-byte-v1' };
  baseSnapshotHash: string; matteSnapshotHash: string;
  mapping: ReturnType<typeof fitGeometry>;
  outputHash: string; outputSize: { width: number; height: number };
  matteEncoding?: MatteEncoding;
};
/** Consumer pixels must come from the same bytes whose digest was checked. */
export function derivedWorkingSnapshot(r: GenerationRecord) {
  if (r.kind !== 'derived-alpha' && r.kind!=='derived-background' && r.kind!=='derived-packed-alpha') return r.workingPath;
  const snapshot = fs.readFileSync(r.workingPath);
  if (matteDigest(snapshot) !== r.workingHash) throw fail('派生alpha消费的工作字节快照已变化');
  return snapshot;
}
export function verifyMatteBinding(j: Job, s: GenerationState, binding: MatteBinding,
  registered: (id: string) => GenerationRecord) {
  const base = registered(binding.base.id);
  if (matteSignature(captureMatteBinding(j, s, base, binding.matteEncoding)) !== matteSignature(binding))
    throw fail('aux-matte来源、完整基底登记、source/layout/位置已变化；请重新准备');
  return base;
}
export function verifyAuxiliaryMatte(j: Job, s: GenerationState, aux: AuxiliaryMatte,
  registered: (id: string) => GenerationRecord) {
  const base = verifyMatteBinding(j, s, aux.binding, registered);
  const request = s.requests.find(r => r.id === aux.requestId);
  if (!request || request.role !== 'aux-matte' || request.surface !== 'opaque' || aux.role !== 'aux-matte' ||
    request.matteEncoding !== aux.matteEncoding || request.matteEncoding !== aux.binding.matteEncoding ||
    aux.receipt.matteEncoding !== aux.matteEncoding ||
    matteSignature(request) !== aux.requestHash ||
    JSON.stringify(request.referencePaths) !== JSON.stringify([aux.binding.base.working.path, aux.binding.cleanLocal.path]) ||
    matteSignature(request.matteBinding) !== matteSignature(aux.binding) ||
    request.matteForGenerationId !== base.id || aux.receipt.tool !== 'image_gen' ||
    aux.receipt.toolHistoryVerified !== false || aux.receipt.prompt !== request.prompt ||
    JSON.stringify(aux.receipt.referencePaths) !== JSON.stringify(request.referencePaths) ||
    request.referencePaths.some((p, i) => file(p).hash !== request.referenceHashes[i]) ||
    file(aux.originalPath).hash !== aux.hash || file(aux.workingPath).hash !== aux.workingHash ||
    file(aux.toolOutput.path).hash !== aux.hash || aux.toolOutput.hash !== aux.hash ||
    aux.workingSize.width * aux.workingSize.height > GENERATION_PIXEL_BUDGET)
    throw fail('辅助matte登记、原件、工作件、引用或预算绑定已变化');
  assertAuxiliaryEncodingVerified(aux);
  return base;
}
export function verifyDerivedAlpha(j: Job, s: GenerationState, r: GenerationRecord,
  registered: (id: string) => GenerationRecord) {
  const proof = r.derivedAlpha;
  if (r.kind !== 'derived-alpha' || !proof || proof.algorithm !==
      matteAlgorithm(proof.binding.matteBackdrop) || r.receipt.tool !== 'derived-alpha' ||
    r.receipt.toolHistoryVerified !== false)
    throw fail('派生alpha缺少真实双来源或固定算法记录');
  if (proof.binding.matteBackdrop && (!proof.unmix || proof.unmix.version !== 1 ||
      proof.unmix.color !== proof.binding.matteBackdrop.color || proof.unmix.space !== 'srgb-byte-v1' ||
      !Number.isFinite(proof.unmix.maxRecompositionError) || proof.unmix.maxRecompositionError < 0 || proof.unmix.maxRecompositionError > 2 ||
      !Number.isSafeInteger(proof.unmix.zeroAlphaPixels) || proof.unmix.zeroAlphaPixels < 0 ||
      !Number.isSafeInteger(proof.unmix.clippedChannels) || proof.unmix.clippedChannels < 0) ||
      !proof.binding.matteBackdrop && proof.unmix)
    throw fail('前景RGB解混缺少固定底色/色域/实际再合成证明，旧派生不能伪装解混');
  const aux = s.auxiliaries?.find(a => a.id === proof.matteId);
  if (!aux || matteSignature(aux) !== proof.matteRecordHash ||
    proof.matteEncoding !== aux.matteEncoding || r.receipt.matteEncoding !== aux.matteEncoding ||
    matteSignature(aux.binding) !== matteSignature(proof.binding))
    throw fail('派生alpha辅助matte登记已变化或缺失');
  const base = verifyAuxiliaryMatte(j, s, aux, registered);
  const request = s.requests.find(q => q.id === base.requestId)!;
  if (proof.baseSnapshotHash !== base.workingHash || proof.matteSnapshotHash !== aux.workingHash ||
    r.hash !== proof.outputHash || r.workingHash !== proof.outputHash ||
    JSON.stringify(r.workingSize) !== JSON.stringify(proof.outputSize) ||
    JSON.stringify(r.originalSize) !== JSON.stringify(proof.outputSize) ||
    JSON.stringify(r.placementFrame) !== JSON.stringify(proof.binding.base.placement) ||
    JSON.stringify(proof.mapping) !== JSON.stringify(fitGeometry(aux.workingSize, base.workingSize)) ||
    r.requestId !== base.requestId || JSON.stringify(r.frame) !== JSON.stringify(base.frame) ||
    JSON.stringify(r.sourceLayerIds) !== JSON.stringify(base.sourceLayerIds) || (r.blendMode || 'normal') !== 'normal' ||
    r.receipt.prompt !== request.prompt || JSON.stringify(r.receipt.referencePaths) !== JSON.stringify(request.referencePaths) ||
    r.receipt.baseGenerationId !== base.id || r.receipt.matteId !== aux.id)
    throw fail('派生alpha输出、完整carrier/位置或双来源receipt已变化');
}

/** Direct encoded 8-bit gray is a scalar alpha estimate, never physical transmission. */
export async function decodeOpaqueGray(bytes: Buffer) {
  const meta = await sharp(bytes).metadata();
  if (meta.format !== 'png' || meta.depth !== 'uchar' || !meta.width || !meta.height ||
    (meta.pages && meta.pages > 1) || meta.width * meta.height > 40_000_000)
    throw fail('辅助matte必须为4000万像素以内单张8位灰阶PNG原件');
  const { data, info } = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4)
    if (data[i] !== data[i + 1] || data[i] !== data[i + 2] || data[i + 3] !== 255)
      throw fail('辅助matte必须是自身完全不透明的灰阶标量场；不能以彩色或PNG alpha替代灰值');
  return { data, width: info.width, height: info.height };
}

export type NearNeutralProof = {
  encoding: 'near-neutral-luma8-v2' | 'near-neutral-luma8-v3'; formula: typeof MATTE_LUMA_FORMULA;
  limits: typeof NEAR_NEUTRAL_LIMITS | typeof NEAR_NEUTRAL_V3_LIMITS; rawHash: string; rawSize: { width: number; height: number };
  scalarRawHash: string; workingHash: string; workingSize: { width: number; height: number };
  statistics: { pixels: number; maxSpread: number; materialPixels: number;
    materialSpreadSum: number; materialOutliers: number };
};
/** Authenticate all untouched raw pixels before any budget resize can hide chroma. */
export async function nearNeutralScalar(bytes: Buffer, encoding: NearNeutralProof['encoding'] = 'near-neutral-luma8-v2') {
  if (encoding !== 'near-neutral-luma8-v2' && encoding !== 'near-neutral-luma8-v3')
    throw fail('近中性matte编码版本非法');
  const limits = encoding === 'near-neutral-luma8-v2' ? NEAR_NEUTRAL_LIMITS : NEAR_NEUTRAL_V3_LIMITS;
  const rawHash = matteDigest(bytes), meta = await sharp(bytes).metadata();
  if (meta.format !== 'png' || meta.depth !== 'uchar' || !meta.width || !meta.height ||
      (meta.pages && meta.pages > 1) || meta.width * meta.height > 40_000_000)
    throw fail(`${encoding}仅支持4000万像素以内单张不透明8位PNG原件`);
  const { data, info } = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const scalar = Buffer.alloc(data.length), statistics = { pixels: info.width * info.height,
    maxSpread: 0, materialPixels: 0, materialSpreadSum: 0, materialOutliers: 0 };
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 255) throw fail(`${encoding}原件每个alpha必须255，不能用PNG alpha承载matte`);
    const max = Math.max(data[i], data[i + 1], data[i + 2]), spread = max - Math.min(data[i], data[i + 1], data[i + 2]);
    statistics.maxSpread = Math.max(statistics.maxSpread, spread);
    if (max > NEAR_NEUTRAL_LIMITS.materialMinMaxRGB) {
      statistics.materialPixels++; statistics.materialSpreadSum += spread;
      if (spread > NEAR_NEUTRAL_LIMITS.materialSpreadLimit) statistics.materialOutliers++;
    }
    const m = Math.floor((2126 * data[i] + 7152 * data[i + 1] + 722 * data[i + 2] + 5000) / 10000);
    scalar.set([m, m, m, 255], i);
  }
  if (encoding === 'near-neutral-luma8-v2' && statistics.maxSpread > NEAR_NEUTRAL_LIMITS.maxSpread)
    throw fail('near-neutral-luma8-v2原件全图通道spread超过固定16边界');
  if (!statistics.materialPixels || statistics.materialSpreadSum > NEAR_NEUTRAL_LIMITS.maxMeanMaterialSpread * statistics.materialPixels)
    throw fail(`${encoding}原件maxRGB>8材质区平均spread超过固定2边界或材质为空`);
  if (statistics.materialOutliers * 1000 > NEAR_NEUTRAL_LIMITS.maxMaterialOutlierPermille * statistics.materialPixels)
    throw fail(`${encoding}原件材质区spread<=8未达到固定99.9%边界`);
  const scalarBytes = await sharp(scalar, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return { scalarBytes, proof: { encoding, formula: MATTE_LUMA_FORMULA,
    limits, rawHash, rawSize: { width: info.width, height: info.height },
    scalarRawHash: matteDigest(scalarBytes), statistics } };
}
const verifiedEncodingSnapshots = new Set<string>();
const encodingCacheKey = (aux: AuxiliaryMatte) => matteSignature({ encoding: aux.matteEncoding,
  rawHash: aux.hash, workingHash: aux.workingHash, rawSize: aux.originalSize, workingSize: aux.workingSize, proof: aux.encodingProof });
export async function primeAuxiliaryEncoding(aux: AuxiliaryMatte,
  budget: (bytes: Buffer) => Promise<{ bytes: Buffer; workingSize: { width: number; height: number } }>) {
  if (aux.matteEncoding !== 'near-neutral-luma8-v2' && aux.matteEncoding !== 'near-neutral-luma8-v3') {
    if (aux.matteEncoding !== undefined && !['exact-gray8-v1', 'white-composite-rgb8-v1'].includes(aux.matteEncoding) || aux.encodingProof)
      throw fail('辅助matte未知编码或旧严格请求不能带近中性解析证明');
  }
  const raw = fs.readFileSync(aux.originalPath), working = fs.readFileSync(aux.workingPath);
  if (matteDigest(raw) !== aux.hash || matteDigest(working) !== aux.workingHash)
    throw fail('辅助matte编码验证的原件/标量工作字节快照已变化');
  const key = encodingCacheKey(aux);
  if (verifiedEncodingSnapshots.has(key)) return;
  if (aux.matteEncoding === 'near-neutral-luma8-v2' || aux.matteEncoding === 'near-neutral-luma8-v3') {
    const parsed = await nearNeutralScalar(raw, aux.matteEncoding), normalized = await budget(parsed.scalarBytes);
    const expected: NearNeutralProof = { ...parsed.proof, workingHash: matteDigest(normalized.bytes), workingSize: normalized.workingSize };
    if (matteSignature(expected) !== matteSignature(aux.encodingProof) || expected.rawHash !== aux.hash ||
        expected.workingHash !== aux.workingHash || JSON.stringify(expected.rawSize) !== JSON.stringify(aux.originalSize) ||
        JSON.stringify(expected.workingSize) !== JSON.stringify(aux.workingSize))
      throw fail('辅助matte固定luma公式、原件统计、编码版本或标量工作证明不一致');
  } else if (aux.matteEncoding === 'white-composite-rgb8-v1') {
    if (aux.binding.matteBackdrop?.version !== 2) throw fail('白底RGB缺少事前冻结的双背景身份');
    const decoded = await validateBackdropRaw(raw), normalized = await budget(raw);
    await validateBackdropRaw(normalized.bytes);
    if (matteDigest(normalized.bytes) !== aux.workingHash ||
        JSON.stringify(decoded.size) !== JSON.stringify(aux.originalSize) ||
        JSON.stringify(normalized.workingSize) !== JSON.stringify(aux.workingSize))
      throw fail('白底RGB真实raw/工作快照不一致，不能转灰或删除颜色通道');
  } else {
    // A deleted v2 field cannot turn colored raw into a legacy strict record.
    // Absence remains strict; nothing is added or migrated on disk.
    const decoded = await decodeOpaqueGray(raw), normalized = await budget(raw);
    if (matteDigest(normalized.bytes) !== aux.workingHash ||
        JSON.stringify({ width: decoded.width, height: decoded.height }) !== JSON.stringify(aux.originalSize) ||
        JSON.stringify(normalized.workingSize) !== JSON.stringify(aux.workingSize))
      throw fail('旧严格matte原件/完整工作carrier归一证明不一致');
  }
  if (file(aux.originalPath).hash !== aux.hash || file(aux.workingPath).hash !== aux.workingHash)
    throw fail('辅助matte固定编码验证期间来源文件已变化');
  verifiedEncodingSnapshots.add(key);
}
function assertAuxiliaryEncodingVerified(aux: AuxiliaryMatte) {
  if (aux.matteEncoding === 'near-neutral-luma8-v2' || aux.matteEncoding === 'near-neutral-luma8-v3' ||
      aux.matteEncoding === 'white-composite-rgb8-v1' && aux.binding.matteBackdrop?.version === 2 && !aux.encodingProof) {
    if (!verifiedEncodingSnapshots.has(encodingCacheKey(aux)))
      throw fail('近中性matte编码尚未从实际raw快照重算验证，不能使用后写字段放行');
  } else if (aux.matteEncoding !== undefined && aux.matteEncoding !== 'exact-gray8-v1' || aux.encodingProof)
    throw fail('辅助matte编码版本非法，不能追溯放宽旧严格请求');
  else if (!verifiedEncodingSnapshots.has(encodingCacheKey(aux)))
    throw fail('严格灰阶matte尚未从实际raw快照验证，不能删除新编码身份来放行');
}

/** Complete raw validation happens before budget resizing can hide weak alpha. */
export async function validateBackdropRaw(bytes: Buffer): Promise<BackdropRawProof> {
  const sha = matteDigest(bytes), cached = verifiedBackdropRaw.get(sha);
  if (cached) return cached;
  const m = await sharp(bytes).metadata();
  if (m.format !== 'png' || m.depth !== 'uchar' || m.space !== 'srgb' || !m.width || !m.height ||
      (m.pages && m.pages > 1) || m.width * m.height > 40_000_000)
    throw fail('已知底色基底须为单张8位sRGB PNG完整原件');
  const data = await sharp(bytes).ensureAlpha().raw().toBuffer();
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255)
    throw fail('已知底色RGB完整原件须自身每像素alpha255，不能缩小后掩盖弱透明');
  const proof = { hash: sha, minAlpha: 255 as const, size: { width: m.width, height: m.height } };
  verifiedBackdropRaw.set(sha, proof);
  return proof;
}
export async function primeBackdropRGBRecord(r: GenerationRecord) {
  const snapshot = fs.readFileSync(r.originalPath);
  if (matteDigest(snapshot) !== r.hash) throw fail('中灰RGB原件摘要已变化');
  const actual = await validateBackdropRaw(snapshot);
  if (JSON.stringify(actual) !== JSON.stringify(r.matteBackdropRaw)) throw fail('中灰基底不透明证明与实际完整原件不符');
  if (file(r.originalPath).hash !== r.hash) throw fail('中灰RGB原件检查期间变化');
}
export function assertBackdropRGBRecord(r: GenerationRecord) {
  const actual = verifiedBackdropRaw.get(r.hash);
  if (!actual || JSON.stringify(actual) !== JSON.stringify(r.matteBackdropRaw))
    throw fail('中灰基底须从完整原件重算不透明证明，不能使用后写证明字段');
}
/** Necessary source-over feasibility, not a semantic/material quality score.
 * Report every incompatible pixel before rejecting; never change the matte. */
export function analyzeKnownBackdropRGBA(rgb: Buffer, mask: Buffer, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width * height > GENERATION_PIXEL_BUDGET || rgb.length !== width * height * 4 || mask.length !== rgb.length)
    throw fail('已知底色相容诊断须使用150万以内同尺寸完整RGBA carrier');
  let zeroAlphaPixels = 0, incompatibleZeroAlpha = 0, incompatibleMaterial = 0, maxRecompositionError = 0;
  const examples: { x: number; y: number; rgb: number[]; matte: number; minimumFeasibleAlpha: number; error: number }[] = [];
  for (let i = 0; i < rgb.length; i += 4) {
    if (rgb[i + 3] !== 255 || mask[i + 3] !== 255 || mask[i] !== mask[i + 1] || mask[i] !== mask[i + 2])
      throw fail('已知底色相容诊断必须使用不透明RGB和严格不透明标量matte');
    const m = mask[i], a = m / 255; let error = 0, required = 0;
    if (!m) zeroAlphaPixels++;
    for (let c = 0; c < 3; c++) {
      const recovered = m ? Math.max(0, Math.min(255, Math.round((rgb[i + c] - (1 - a) * 128) / a))) : 0;
      error = Math.max(error, Math.abs(a * recovered + (1 - a) * 128 - rgb[i + c]));
      required = Math.max(required, rgb[i + c] >= 128 ? (rgb[i + c] - 128) / 127 * 255 : (128 - rgb[i + c]) / 128 * 255);
    }
    maxRecompositionError = Math.max(maxRecompositionError, error);
    if (error > 2) {
      if (m) incompatibleMaterial++; else incompatibleZeroAlpha++;
      if (examples.length < 12) examples.push({ x: i / 4 % width, y: Math.floor(i / 4 / width),
        rgb: [...rgb.subarray(i, i + 3)], matte: m, minimumFeasibleAlpha: Math.ceil(required), error });
    }
  }
  return { version: 1 as const, pixels: width * height, zeroAlphaPixels, incompatibleZeroAlpha,
    incompatibleMaterial, maxRecompositionError, compatible: !incompatibleZeroAlpha && !incompatibleMaterial, examples,
    note: '固定#808080与8位source-over的必要条件；minimumFeasibleAlpha只作诊断，不调高matte、改变RGB或自动视觉接受。' };
}
/** Fixed byte-space experiment. Two generated composites, never source pixels
 * or brightness-as-coverage. A pair that cannot recompose both inputs is refused. */
export async function applyDualBackdrop(blackBytes: Buffer, whiteBytes: Buffer) {
  const [blackProof, whiteProof] = await Promise.all([validateBackdropRaw(blackBytes), validateBackdropRaw(whiteBytes)]);
  const size = blackProof.size;
  if (size.width * size.height > GENERATION_PIXEL_BUDGET ||
      JSON.stringify(size) !== JSON.stringify(whiteProof.size))
    throw fail('双背景须完整同尺寸150万像素carrier；不拉伸、自动配准或补边伪造同一前景');
  const [black, white] = await Promise.all([sharp(blackBytes).ensureAlpha().raw().toBuffer(), sharp(whiteBytes).ensureAlpha().raw().toBuffer()]);
  const output = Buffer.alloc(black.length);
  let maxRecompositionError = 0, zeroAlphaPixels = 0, clippedChannels = 0, incompatiblePixels = 0, decreased = 0, min = 255, max = 0;
  const examples: { x: number; y: number; black: number[]; white: number[]; alpha: number; error: number }[] = [];
  for (let i = 0; i < black.length; i += 4) {
    const delta = [0, 1, 2].map(c => white[i + c] - black[i + c]);
    const alpha = Math.round(255 - (delta[0] + delta[1] + delta[2]) / 3);
    // Clamping here only makes diagnostics finite. It cannot authorize an
    // incompatible pair: both actual composites must satisfy the fixed error.
    const m = Math.max(0, Math.min(255, alpha)), a = m / 255;
    output[i + 3] = m; min = Math.min(min, m); max = Math.max(max, m);
    if (!m) zeroAlphaPixels++; if (m < 255) decreased++;
    let error = 0;
    for (let c = 0; c < 3; c++) {
      const recovered = m ? black[i + c] / a : 0;
      if (m && recovered > 255) clippedChannels++;
      output[i + c] = m ? Math.max(0, Math.min(255, Math.round(recovered))) : 0;
      error = Math.max(error, Math.abs(a * output[i + c] - black[i + c]),
        Math.abs(a * output[i + c] + 255 - m - white[i + c]));
    }
    maxRecompositionError = Math.max(maxRecompositionError, error);
    if (alpha < 0 || alpha > 255 || error > 2) {
      incompatiblePixels++;
      if (examples.length < 12) examples.push({ x: (i / 4) % size.width, y: Math.floor(i / 4 / size.width),
        black: Array.from(black.subarray(i, i + 3)), white: Array.from(white.subarray(i, i + 3)), alpha, error });
    }
  }
  const diagnostic = { algorithm: DUAL_BACKDROP_ALGORITHM, pixels: size.width * size.height, incompatiblePixels, maxRecompositionError, examples };
  if (incompatiblePixels) throw Object.assign(fail(`双背景颜色/几何不相容：${incompatiblePixels}像素，最大再合成误差${maxRecompositionError.toFixed(3)}；拒绝颜色截断、调alpha或重配准`), { diagnostic });
  if (max === 0 || max - min <= 2 || !decreased) throw fail('双背景拒绝全空/统一alpha伪层；仍须冻结区域及真实视觉检查');
  const bytes = await sharp(output, { raw: { ...size, channels: 4 } }).png().toBuffer();
  if (!(await sharp(bytes).ensureAlpha().raw().toBuffer()).equals(output)) throw fail('双背景RGBA编码不一致');
  return { bytes, size, mapping: fitGeometry(size, size), decreased, grayRangeOnMaterial: [min, max],
    unmix: { version: 1 as const, color: '#000000' as const, space: 'srgb-byte-v1' as const, maxRecompositionError, zeroAlphaPixels, clippedChannels } };
}
export async function applyGeneratedMatte(baseBytes: Buffer, matteBytes: Buffer, backdrop?: MatteBackdrop) {
  if (backdrop) { matteBackdropSchema.parse(backdrop); await validateBackdropRaw(baseBytes); }
  if (backdrop?.version === 2) return applyDualBackdrop(baseBytes, matteBytes);
  const meta = await sharp(baseBytes).metadata();
  if (meta.depth !== 'uchar' || meta.space !== 'srgb' || !meta.width || !meta.height || meta.width * meta.height > GENERATION_PIXEL_BUDGET)
    throw fail('完整RGB基底必须为150万像素以内8位carrier');
  const gray = await decodeOpaqueGray(matteBytes), size = { width: meta.width, height: meta.height };
  if (gray.width * gray.height > GENERATION_PIXEL_BUDGET || aspectError(gray, size) > 0.01)
    throw fail('辅助matte预算或完整carrier比例不符，禁止拉伸/裁边');
  const mapping = fitGeometry(gray, size);
  const fitted = await sharp(matteBytes).resize({ width: mapping.width, height: mapping.height, fit: 'fill' })
    .extend({ top: mapping.offsetY, left: mapping.offsetX,
      bottom: size.height - mapping.height - mapping.offsetY, right: size.width - mapping.width - mapping.offsetX,
      background: '#000000' }).png().toBuffer();
  const mask = await decodeOpaqueGray(fitted);
  const { data, info } = await sharp(baseBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (backdrop) {
    const diagnostic = analyzeKnownBackdropRGBA(data, mask.data, info.width, info.height);
    if (!diagnostic.compatible) throw Object.assign(fail(`RGB与matte/已知中灰背景不相容：` +
      `空alpha区域${diagnostic.incompatibleZeroAlpha}/${diagnostic.zeroAlphaPixels}像素底色偏差超过固定2，` +
      `非空材质${diagnostic.incompatibleMaterial}像素覆盖不足或几何不符，最大再合成误差${diagnostic.maxRecompositionError.toFixed(3)}；` +
      '不以颜色截断、补alpha或降低标准伪修，保留原件并修方法。'), { diagnostic });
  }
  const output = Buffer.from(data);
  let maxRecompositionError = 0, zeroAlphaPixels = 0, clippedChannels = 0;
  let min = 255, max = 0, visible = 0, decreased = 0;
  for (let i = 0; i < data.length; i += 4) {
    const m = mask.data[i];
    if (data[i + 3] > 0) { visible++; min = Math.min(min, m); max = Math.max(max, m); }
    output[i + 3] = Math.min(data[i + 3], m);
    if (output[i + 3] < data[i + 3]) decreased++;
    if (backdrop) {
      const a = m / 255;
      if (!m) zeroAlphaPixels++;
      for (let c = 0; c < 3; c++) {
        const recovered = m ? (data[i + c] - (1 - a) * 128) / a : 0;
        if (m && (recovered < 0 || recovered > 255)) clippedChannels++;
        output[i + c] = m ? Math.max(0, Math.min(255, Math.round(recovered))) : 0;
        const error = Math.abs(a * output[i + c] + (1 - a) * 128 - data[i + c]);
        maxRecompositionError = Math.max(maxRecompositionError, error);
        if (error > 2) throw fail('RGB与matte/已知中灰背景不相容，拒绝靠截断颜色伪解混；保留原件并检查几何/灰值/底色');
      }
    }
  }
  if (!visible || max === 0 || max - min <= 2 || !decreased)
    throw fail('拒绝全空/全白/可见材质整体统一灰matte伪修；不能等价全层opacity');
  const bytes = await sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  const encoded = await sharp(bytes).ensureAlpha().raw().toBuffer();
  if (!encoded.equals(output)) throw fail('派生PNG未保留计算出的逐像素RGBA，未提交');
  for (let i = 0; i < data.length; i += 4)
    if (!backdrop && (encoded[i] !== data[i] || encoded[i + 1] !== data[i + 1] || encoded[i + 2] !== data[i + 2]))
      throw fail('派生编码改变了RGB通道，未提交');
  return { bytes, size, mapping, decreased, grayRangeOnMaterial: [min, max],
    ...(backdrop ? { unmix: { version: 1 as const, color: backdrop.color, space: backdrop.space,
      maxRecompositionError, zeroAlphaPixels, clippedChannels } } : {}) };
}
