import fs from 'node:fs';
import { type NativeGeometryRecipe } from '../shared/native-geometry.js';
import { renderNativeGeometryRaster, verifyNativeGeometryRecord, nativeGeometrySignature } from './native-geometry-renderer.js';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {contourSearchViewport,type ContourSearch} from '../shared/contour-search.js';
import type { NativeTextRecipe } from '../shared/native-text.js';
import { opticalPartPrompts, opticalPartError, type OpticalPart } from '../shared/optical-parts.js';
import { ordinaryOpticalMembers, photoshopOpticalMembers, opticalPlanHash, verifyOpticalRequest } from './optical-parts.js';
import { renderNativeText, validateNativeTextRecipe, nativeTextSignature, NATIVE_TEXT_ALGORITHM, NATIVE_TEXT_PLANE_ALGORITHM,
  type NativeTextRenderProof } from './native-text-renderer.js';
import { generationActionSchema, type GenerationAction, type GenerationAlphaCheck, type MatteEncoding, type MatteBackdrop, type BackgroundSourceProtection } from '../shared/generation.js';
import { captureMatteBinding, verifyMatteBinding, verifyAuxiliaryMatte, verifyDerivedAlpha,
  decodeOpaqueGray, applyGeneratedMatte, validateBackdropRaw, primeBackdropRGBRecord, assertBackdropRGBRecord,
  matteSignature, matteAlgorithm,
  assertNotGeneratedRoleAlias, hasGeneratedRoles, primeGeneratedRoleIdentities, rememberExactRGBA,
  nearNeutralScalar, primeAuxiliaryEncoding, NEAR_NEUTRAL_LIMITS, NEAR_NEUTRAL_V3_LIMITS, MATTE_LUMA_FORMULA,
  type MatteBinding, type AuxiliaryMatte, type DerivedAlpha } from './generation-matte.js';
import {
  generationPlan,
  aspectError,
  ASPECT_TOLERANCE,
  generationCarrier,
  GENERATION_PIXEL_BUDGET,
} from '../shared/generation-geometry.js';
import type { PhotoshopPlan } from '../shared/photoshop.js';
import type { LayerReview } from '../shared/layer-review.js';
import { frameContract } from './layer-frames.js';
import { reconstructionCrops } from './reconstruction-crops.js';
import { prepareDetailReferences, prepareReferencePresentation, assertNotDetailReferenceOutput } from './generation-detail-references.js';
import { originalReference } from './references.js';
import { generationAnnotations } from '../shared/generation-annotations.js';
import { writeIsolationPreviews } from './generation-previews.js';
import { dir, json, atomic, uid, assetPath, getJob } from './store.js';
import type { Job } from './types.js';
import { alignGeneration } from './generation-alignment.js';
import { registrationProposal, registrationFitPoints, type RegistrationProposal } from './generation-registration.js';
import { evaluateGenerationAlphaChecks, alphaDiagnosticSignature, generationAlphaCheckRegions,
  GENERATION_ALPHA_DIAGNOSTIC_VERSION, type GenerationAlphaDiagnostics } from './generation-alpha-checks.js';
import { filePlacement, backgroundPlacement, placementPreview, restoreGeneration,
  type PlacementFrame, type BackgroundPadding } from './generation-placement.js';
import { evaluateMatteFeasibility, requireMatteFeasibility } from './generation-matte-feasibility.js';
import { PACKED_ALGORITHM, packedBinding, normalizePackedCarrier, splitPackedCarrier,
  verifyPackedCarrier, primePackedAlpha, verifyPackedAlpha,
  type PackedCarrier, type PackedAlphaProof } from './generation-packed.js';
import { applyDualBackdrop } from './generation-matte.js';
import { backgroundProtectionPlan, backgroundSignature, captureBackgroundBinding, verifyBackgroundRecord,
  primeBackgroundRecord, preflightBackgroundSelection, backgroundSelectionBinding, requireDerivedBackgroundReview } from './generation-background.js';
import { deriveProtectedBackgroundSnapshot } from './background-protection-snapshot.js';
import {
  validateLayout,
  validateOpaqueCheckRoute,
  renderGenerationComposite,
  compositeSignature,
  type GenerationLayout,
} from './generation-workflow.js';

const digest = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const hash = (p: string) => digest(fs.readFileSync(p));
export async function comparisonPanels(reference: string, result: string, output: string) {
  const thumb = async (p: string) =>
    sharp(fs.readFileSync(p))
      .resize({ width: 512, height: 512, fit: 'contain', background: '#808080' })
      .flatten({ background: '#808080' })
      .png()
      .toBuffer();
  const a = await thumb(reference),
    b = await thumb(result);
  const overlay = await sharp(a)
    .composite([{ input: await sharp(b).ensureAlpha(0.5).png().toBuffer() }])
    .png()
    .toBuffer();
  const diff = await sharp(a)
    .composite([{ input: b, blend: 'difference' }])
    .png()
    .toBuffer();
  fs.writeFileSync(
    output,
    await sharp({ create: { width: 2048, height: 512, channels: 4, background: '#808080' } })
      .composite([a, b, overlay, diff].map((input, i) => ({ input, left: i * 512, top: 0 })))
      .png()
      .toBuffer(),
  );
  return { path: output, hash: hash(output) };
}
const samePath = (a: string, b: string) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
type Frame = { x: number; y: number; width: number; height: number };
// Context anchors may leave the design frame, but never the real source canvas.
// Only a prepared request can freeze this wider region; callers cannot supply it at align.
function sourceAnchorFrame(frame: Frame, context: Frame | undefined, canvas: { width: number; height: number }): Frame {
  if (!context) return frame;
  const x = Math.max(0, context.x), y = Math.max(0, context.y);
  return { x, y, width: Math.max(0, Math.min(canvas.width, context.x + context.width) - x),
    height: Math.max(0, Math.min(canvas.height, context.y + context.height) - y) };
}
// Context references and the placed result must share the same complete viewport.
// The design frame remains the frozen task contract, not a review clipping mask.
function comparisonContract(request: Request) {
  return {
    comparisonFrame: request.referenceContext?.carrierFrame || request.frame,
    comparisonReferencePath: request.referenceContext?.path || request.localPath || request.referencePaths[0],
  };
}
type Request = {
  id: string;
  sourceLayerIds: string[];
  frame: Frame;
  canvas: { width: number; height: number };
  name: string;
  background: boolean;
  blendMode?: import('../shared/blend.js').BlendMode;
  surface?: 'transparent' | 'opaque' | 'screen';
  carrier?: ReturnType<typeof generationCarrier>;
  anchors?: { name: string; point: [number, number]; observation: string }[];
  alphaChecks?: GenerationAlphaCheck[];
  allowAuxMatte?: boolean;
  matteBackdrop?: MatteBackdrop;
  packedBackdrop?: import('../shared/generation.js').PackedBackdrop;
  opticalPart?: OpticalPart;
  opticalPlanHash?: string;
  sourceProtection?: BackgroundSourceProtection;
  sourceProtectionPlanHash?: string;
  elements: string[];
  referenceObservation: string;
  referencePaths: string[];
  referenceHashes: string[];
  localPath?: string;
  localReferenceHash?: string;
  prompt: string;
  promptStyle?: 'structured' | 'concise-edit';
  referenceStrategy?: 'local-and-global' | 'local-only';
  detailReferences?: Awaited<ReturnType<typeof prepareDetailReferences>>;
  referencePresentation?: Awaited<ReturnType<typeof prepareReferencePresentation>>;
  referenceContext?: {
    marginPixels: number;
    observation: string;
    referenceMode?: 'context-only';
    path: string;
    hash: string;
    cropPath: string;
    cropHash: string;
    sourcePath: string;
    sourceHash: string;
    role: 'original' | 'current';
    frame: Frame;
    carrierFrame: Frame;
    size: { width: number; height: number };
    coordinateSpace: 'input-image-pixels';
  };
  planHash?: string;
  role?: 'aux-matte' | 'native-text' | 'native-geometry';
  nativeText?: NativeTextRecipe;
  nativeGeometry?: NativeGeometryRecipe;
  contourSearch?:ContourSearch;
  matteForGenerationId?: string;
  matteBinding?: MatteBinding;
  matteEncoding?: MatteEncoding;
  matteFeasibility?: Awaited<ReturnType<typeof evaluateMatteFeasibility>>;
};
function requestReferencesChanged(request: Request) {
  if (request.referencePaths.some((p, i) => !fs.existsSync(p) || hash(p) !== request.referenceHashes[i])) return true;
  const presentation = request.referencePresentation;
  if (presentation && (!fs.existsSync(presentation.sourcePath) ||
      hash(presentation.sourcePath) !== presentation.sourceHash)) return true;
  if (request.referenceContext?.referenceMode !== 'context-only' && !request.referencePresentation) return false;
  // The old design crop is deliberately not a model input. It still owns
  // clean-local coordinates and matte provenance, so its prepare hash is frozen.
  return !request.localPath || !request.localReferenceHash || !fs.existsSync(request.localPath) ||
    hash(request.localPath) !== request.localReferenceHash;
}
export type GenerationRecord = {
  kind?: 'derived-alpha' | 'derived-background' | 'native-text' | 'native-geometry' | 'matte-rgb-base' | 'derived-packed-alpha';
  packedAlpha?: PackedAlphaProof;
  matteBackdropRaw?: Awaited<ReturnType<typeof validateBackdropRaw>>;
  nativeTextProof?: { path: string; hash: string };
  nativeGeometryProof?: { path: string; hash: string };
  derivedBackground?: import('./generation-background.js').DerivedBackground;
  derivedAlpha?: DerivedAlpha;
  blendMode?: import('../shared/blend.js').BlendMode;
  id: string;
  requestId: string;
  sourceLayerIds: string[];
  frame: Frame;
  originalPath: string;
  outputPath: string;
  hash: string;
  workingPath: string;
  workingHash: string;
  originalSize: { width: number; height: number };
  workingSize: { width: number; height: number };
  comparisonPath: string;
  comparisonHash: string;
  comparisonFrame?: Frame;
  comparisonReferencePath?: string;
  isolationPreviews?: {
    dark: { path: string; hash: string };
    light: { path: string; hash: string };
    surface: 'normal' | 'screen';
    workingHash: string;
  };
  aspectError: number;
  isolationProblem?: string;
  placementFrame?: PlacementFrame;
  backgroundPadding?: BackgroundPadding;
  backgroundOpacity?: { version: 1; sourceHash: string; minAlpha: number; opaqueAlpha: number };
  alphaDiagnostics?: GenerationAlphaDiagnostics;
  placedPreviewPath?: string;
  reviewEvidence?: Extract<GenerationAction, { action: 'review' }>['evidence'];
  alignment?: Omit<Awaited<ReturnType<typeof alignGeneration>>, 'bytes'> & { observation: string };
  autoAlignment?: {
    proposal: RegistrationProposal;
    sourceHash: string;
    referencePath: string;
    referenceHash: string;
    referenceToFrameScale: number;
    evidencePath: string;
    evidenceHash: string;
  };
  planHash?: string;
  review?: LayerReview;
  elements?: Extract<GenerationAction, { action: 'review' }>['elements'];
  receipt: {
    tool: 'image_gen' | 'derived-alpha' | 'derived-background' | 'native-font-renderer' | 'native-geometry-renderer' | 'derived-packed-alpha';
    packedId?: string;
    toolHistoryVerified: false;
    prompt: string;
    referencePaths: string[];
    baseGenerationId?: string;
    matteId?: string;
    matteEncoding?: MatteEncoding;
  };
};
export type GenerationState = {
  requests: Request[];
  outputs: GenerationRecord[];
  auxiliaries?: AuxiliaryMatte[];
  packedCarriers?: PackedCarrier[];
  packedFailures?: { packedId: string; carrierHash: string; bindingHash: string;
    reason: string; diagnosticPath: string; diagnosticHash: string;
    black: { path: string; hash: string }; white: { path: string; hash: string } }[];
  matteFailures?: { taskId: string; jobId: string; baseGenerationId: string; matteId: string;
    baseWorkingHash: string; matteWorkingHash: string; bindingHash: string;
    algorithm: 'black-white-composite-unmix-v1'; reason: string; diagnosticPath: string; diagnosticHash: string }[];
  layout?: GenerationLayout;
  composite?: Awaited<ReturnType<typeof renderGenerationComposite>> & {
    review?: Extract<GenerationAction, { action: 'review-composite' }>;
  };
};
const folder = (j: Job) => path.join(dir(j.documentId), 'jobs', j.id, 'generation');
const statePath = (j: Job) => path.join(folder(j), 'registry.json');
export const generationState = (j: Job) =>
  json<GenerationState>(statePath(j), { requests: [], outputs: [] });
type NativeRegistration = { kind?: 'native-geometry'; requestId: string; path: string; proof: { path: string; hash: string } };
function verifyNativeTextRecord(j: Job, state: GenerationState, r: GenerationRecord) {
  const q = state.requests.find(q => q.id === r.requestId),
    entry = state.layout?.layers.find(l => JSON.stringify(l.sourceLayerIds) === JSON.stringify(r.sourceLayerIds));
  if (r.kind !== 'native-text' || r.receipt.tool !== 'native-font-renderer' || q?.role !== 'native-text' ||
      !q.nativeText || !q.carrier || !entry?.nativeText || j.type === 'photoshop' ||
      q.background || q.surface !== 'transparent' || (q.blendMode || 'normal') !== 'normal' ||
      JSON.stringify(q.nativeText) !== JSON.stringify(entry.nativeText) ||
      !r.nativeTextProof || !fs.existsSync(r.nativeTextProof.path) || hash(r.nativeTextProof.path) !== r.nativeTextProof.hash)
    throw new Error('原生字体登记身份/冻结计划/渲染证明不匹配');
  validateNativeTextRecipe(q.nativeText, q.frame);
  const proof = JSON.parse(fs.readFileSync(r.nativeTextProof.path, 'utf8')) as NativeTextRenderProof &
    { taskId: string; jobId: string; requestId: string; requestHash: string };
  if (proof.algorithm !== (q.nativeText.version === 2 ? NATIVE_TEXT_PLANE_ALGORITHM : NATIVE_TEXT_ALGORITHM) ||
      (q.nativeText.version === 2 && JSON.stringify(proof.transform) !== JSON.stringify(q.nativeText.transform)) ||
      proof.taskId !== j.taskId || proof.jobId !== j.id ||
      proof.requestId !== q.id || proof.requestHash !== nativeTextSignature(q) ||
      proof.recipeHash !== nativeTextSignature(q.nativeText) || proof.outputHash !== r.hash ||
      JSON.stringify(proof.size) !== JSON.stringify(r.originalSize) ||
      JSON.stringify(proof.frame) !== JSON.stringify(q.carrier.frame) ||
      JSON.stringify(r.placementFrame) !== JSON.stringify(filePlacement(r.workingSize, q.carrier.frame)))
    throw new Error('原生字体渲染证明与当前任务/完整文件/冻结位置不一致');
}
export function generationSummary(j: Job) {
  const s = generationState(j);
  return {
    layout: s.layout,
    composite: s.composite,
    ...(s.auxiliaries ? { auxiliaries: s.auxiliaries } : {}),
    ...(s.packedCarriers ? { packedCarriers: s.packedCarriers } : {}),
    requests: s.requests.map(({ id, sourceLayerIds, frame, elements, blendMode, alphaChecks, role, nativeText }) => ({
      id,
      ...(role ? { role } : {}), ...(nativeText ? { nativeText } : {}),
      sourceLayerIds,
      frame,
      elements,
      blendMode,
      alphaChecks,
    })),
    outputs: s.outputs.map(
      ({
        id,
        kind,
        requestId,
        blendMode,
        sourceLayerIds,
        originalPath,
        workingPath,
        originalSize,
        workingSize,
        comparisonPath,
        comparisonHash,
        comparisonFrame,
        comparisonReferencePath,
        aspectError,
        alphaDiagnostics,
        review,
      }) => ({
        id,
        kind,
        requestId,
        blendMode,
        sourceLayerIds,
        originalPath,
        workingPath,
        originalSize,
        workingSize,
        comparisonPath,
        comparisonHash,
        comparisonFrame,
        comparisonReferencePath,
        aspectError,
        alphaDiagnostics,
        review,
      }),
    ),
  };
}

/** The untouched bytes are retained separately from budget normalization and final placement. */
export async function budgetWorkingCopy(input: Buffer) {
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height || meta.format === 'svg' || (meta.pages && meta.pages > 1))
    throw new Error('请登记生图工具返回的单张位图原文件，不能登记SVG、动图或适配后的替代文件');
  if (meta.width * meta.height > 40_000_000) throw new Error('原文件超过4000万像素处理上限');
  const originalSize = { width: meta.width, height: meta.height };
  const p = generationPlan({ x: 0, y: 0, ...originalSize });
  const bytes = p.exceedsBudget
    ? await sharp(input)
        .resize({ width: p.size.width, height: p.size.height, fit: 'inside' })
        .png()
        .toBuffer()
    : await sharp(input).png().toBuffer();
  const m = await sharp(bytes).metadata();
  if (!m.width || !m.height || m.width * m.height > GENERATION_PIXEL_BUDGET)
    throw new Error('工作副本未满足150万像素上限，未登记此副本；生成原件保持不变');
  return { bytes, originalSize, workingSize: { width: m.width!, height: m.height! } };
}

export function registeredGeneration(
  j: Job,
  id: string | undefined,
  ids: string[],
  frame: Frame,
  bytes?: Buffer,
  allowMatteBase = false,
) {
  const initial = generationState(j), r = initial.outputs.find((r) => r.id === id);
  if (r) {
    const q = initial.requests.find(q => q.id === r.requestId), entry = initial.layout?.layers.find(l =>
      JSON.stringify(l.sourceLayerIds) === JSON.stringify(r.sourceLayerIds));
    if (r.kind === 'matte-rgb-base' || (q?.matteBackdrop || entry?.matteBackdrop) && r.kind !== 'derived-alpha') {
      if (r.kind !== 'matte-rgb-base' || !q?.matteBackdrop || !entry?.matteBackdrop ||
          JSON.stringify(q.matteBackdrop) !== JSON.stringify(entry.matteBackdrop) ||
          q.allowAuxMatte !== true || r.receipt.tool !== 'image_gen' ||
          r.matteBackdropRaw?.hash !== r.hash || r.matteBackdropRaw.minAlpha !== 255)
        throw new Error('已知底色RGB基底身份或原件证明与冻结请求不符');
      if (!allowMatteBase) throw new Error('已知底色RGB只是辅助基底，不是最终透明层；先生成matte并derive-alpha');
      assertBackdropRGBRecord(r);
    }
  }
  if (
    !r ||
    JSON.stringify(r.sourceLayerIds) !== JSON.stringify(ids) ||
    JSON.stringify(r.frame) !== JSON.stringify(frame)
  )
    throw new Error(
      '缺少与当前任务、来源图层及冻结画幅匹配的生图登记。请先canvas_generation prepare/register，不得临时改用SVG或预缩放裁片',
    );
  try {
  if((r.kind && !['derived-alpha','derived-background','native-text','native-geometry','matte-rgb-base','derived-packed-alpha'].includes(r.kind)) ||
    !['image_gen','derived-alpha','derived-background','native-font-renderer','native-geometry-renderer','derived-packed-alpha'].includes(r.receipt.tool))throw new Error('生成登记角色不合法，不能用未知角色绕过来源检查');
  if (r.kind === 'derived-packed-alpha' || r.packedAlpha || r.receipt.tool === 'derived-packed-alpha' ||
      initial.requests.find(q => q.id === r.requestId)?.packedBackdrop)
    verifyPackedAlpha(j, initial, r);
  if (r.kind === 'native-text' || r.receipt.tool === 'native-font-renderer' || r.nativeTextProof ||
      generationState(j).requests.find(q => q.id === r.requestId)?.role === 'native-text')
    verifyNativeTextRecord(j, generationState(j), r);
  if (r.kind === 'native-geometry' || r.receipt.tool === 'native-geometry-renderer' || r.nativeGeometryProof ||
      generationState(j).requests.find(q => q.id === r.requestId)?.role === 'native-geometry')
    verifyNativeGeometryRecord(j, generationState(j), r);
  if (!r.kind && !r.derivedAlpha && !r.derivedBackground && r.receipt.tool === 'image_gen')
    assertNotGeneratedRoleAlias(generationState(j), [r.outputPath, r.originalPath, r.workingPath], [r.hash, r.workingHash]);
  if (
    !fs.existsSync(r.originalPath) ||
    hash(r.originalPath) !== r.hash ||
    !fs.existsSync(r.workingPath) ||
    hash(r.workingPath) !== r.workingHash ||
    (bytes && digest(bytes) !== r.hash)
  )
    throw new Error('生成原文件已变化，或提交的是预先缩放的文件；请提交登记返回的originalPath');
  if (r.kind === 'derived-alpha' || r.derivedAlpha || r.receipt.tool === 'derived-alpha') {
    const current = generationState(j);
      verifyDerivedAlpha(j, current, r, baseId => {
        const base = current.outputs.find(o => o.id === baseId);
        if (!base || base.kind && base.kind !== 'matte-rgb-base' || base.derivedAlpha || base.receipt.tool !== 'image_gen')
          throw new Error('派生alpha不能引用派生基底或辅助ID冒充真实RGB登记');
        return registeredGeneration(j, baseId, r.sourceLayerIds, r.frame, undefined, true);
      });
  }
  if(r.kind==='derived-background' || r.derivedBackground || r.receipt.tool==='derived-background')
    verifyBackgroundRecord(j,generationState(j),r,baseId=> {
      const base=generationState(j).outputs.find(o=>o.id===baseId);
      if(!base || base.kind || base.derivedAlpha || base.derivedBackground || base.receipt.tool!=='image_gen')
        throw new Error('派生背景父件须为本job真实image_gen原件');
      return registeredGeneration(j,baseId,r.sourceLayerIds,r.frame);
    });
  if (
    r.isolationPreviews &&
    (r.isolationPreviews.workingHash !== r.workingHash ||
      [r.isolationPreviews.dark, r.isolationPreviews.light].some(
        (p) => !fs.existsSync(p.path) || hash(p.path) !== p.hash,
      ))
  )
    throw new Error('独立图层深浅底证据已变化，请恢复对应登记的证据文件再审核');
  const state = generationState(j);
  const request = state.requests.find((p) => p.id === r.requestId)!;
  verifyOpticalRequest(j, request, state.layout);
  validateOpaqueCheckRoute(j, r.sourceLayerIds, request.blendMode, request.alphaChecks);
  if (r.backgroundPadding &&
      (j.reconstructionWorkflowVersion !== 4 || j.type === 'photoshop' || !request?.background ||
       request.surface === 'screen' || r.isolationProblem ||
       r.backgroundOpacity?.version !== 1 || r.backgroundOpacity.sourceHash !== r.hash ||
       ![255, 65535].includes(r.backgroundOpacity.opaqueAlpha) ||
       r.backgroundOpacity.minAlpha !== r.backgroundOpacity.opaqueAlpha))
    throw new Error('背景补边缺少与完整原件摘要绑定的完全不透明检查；请重新登记并审核，不能沿用旧缓存');
  if ((r.blendMode || 'normal') !== (request.blendMode || 'normal'))
    throw new Error('登记混合模式与冻结请求不一致');
  if (j.type !== 'photoshop') {
    const entry = state.layout?.layers.find(l => JSON.stringify(l.sourceLayerIds) === JSON.stringify(ids));
    if ((r.blendMode || 'normal') !== (entry?.blendMode || 'normal'))
      throw new Error('登记混合模式与冻结layout不一致');
    const checks = entry?.alphaChecks || [];
    if (checks.length || request.alphaChecks?.length) {
      if (JSON.stringify(checks) !== JSON.stringify(request.alphaChecks || []))
        throw new Error('区域alpha约束与冻结准备记录不一致，请重新准备/登记');
      if (r.alphaDiagnostics?.version !== GENERATION_ALPHA_DIAGNOSTIC_VERSION || r.alphaDiagnostics.signature !== alphaDiagnosticSignature({
        checks, sourceSize: { width: j.snapshot.width, height: j.snapshot.height }, canvas: request.canvas,
        originalHash: r.hash, workingHash: r.workingHash, placementFrame: r.placementFrame || r.frame,
      }))
        throw new Error('区域alpha诊断已失效，不能沿用旧通过；请重新登记或定位并检查');
      if (r.review?.status === 'accepted' && !r.alphaDiagnostics.passed)
        throw new Error('区域alpha检查失败的候选不能沿用accepted');
    }
  }
  if (
    requestReferencesChanged(request)
  )
    throw new Error('登记后参考图已改变，请重新准备该层');
  return r;
  } catch (e) {
    const opticalEntry = initial.layout?.layers.find(l => JSON.stringify(l.sourceLayerIds) === JSON.stringify(r.sourceLayerIds));
    if (initial.requests.find(q => q.id === r.requestId)?.opticalPlanHash || opticalEntry?.opticalPart) {
      const current = generationState(j), record = current.outputs.find(o => o.id === r.id);
      if (record) { record.review = undefined; record.reviewEvidence = undefined; record.elements = undefined; }
      current.composite = undefined;
      atomic(statePath(j), current);
    }
    if (r.kind === 'derived-alpha' || r.derivedAlpha || r.receipt.tool === 'derived-alpha' ||
        r.kind==='derived-background' || r.derivedBackground || r.receipt.tool==='derived-background' || r.packedAlpha || r.kind==='derived-packed-alpha') {
      const current = generationState(j);
      invalidateMatteApprovals(current, r.derivedAlpha?.binding.base.id);
      if(r.derivedBackground) { const record=current.outputs.find(o=>o.id===r.id);
        if(record){record.review=undefined;record.reviewEvidence=undefined;record.elements=undefined;} }
      if (r.packedAlpha) { const record=current.outputs.find(o=>o.id===r.id);
        if(record){record.review=undefined;record.reviewEvidence=undefined;record.elements=undefined;record.alphaDiagnostics=undefined;} }
      atomic(statePath(j), current);
    }
    throw e;
  }
}

function invalidateMatteApprovals(s: GenerationState, baseId?: string) {
  for (const r of s.outputs) if (r.derivedAlpha && (!baseId || r.derivedAlpha.binding.base.id === baseId)) {
    r.review = undefined; r.reviewEvidence = undefined; r.elements = undefined; r.alphaDiagnostics = undefined;
  }
  s.composite = undefined;
}
function matteBase(j: Job, state: GenerationState, id: string) {
  const r = state.outputs.find(r => r.id === id);
  if (!r) throw new Error('辅助matte基底须为本任务真实RGB登记，不接受辅助ID/其他job');
  try { return registeredGeneration(j, id, r.sourceLayerIds, r.frame, undefined, true); }
  catch (e) {
    const current = generationState(j);
    if (current.outputs.some(o => o.derivedAlpha?.binding.base.id === id)) {
      invalidateMatteApprovals(current, id); atomic(statePath(j), current);
    }
    throw e;
  }
}
function matteCAS(j: Job, captured: string) {
  if (JSON.stringify(generationState(j)) !== captured || JSON.stringify(getJob(j.id)) !== JSON.stringify(j))
    throw Object.assign(new Error('辅助matte操作期间当前完整登记/计划已变化；输出文件已保留'), { status: 400 });
}
/** Async exact-pixel preflight for new roles and pre-fix records; no stored identity is trusted. */
export async function prepareGeneratedRoleConsumer(j: Job, ids: string[], options?: { backgroundReviewOnly?: boolean }) {
  const state = generationState(j);
  if (!hasGeneratedRoles(state)) return;
  const captured = JSON.stringify(state), wanted = new Set(ids);
  for (const r of state.outputs) if (wanted.has(r.id) && r.derivedAlpha) wanted.add(r.derivedAlpha.binding.base.id);
  for (const r of state.outputs) if (wanted.has(r.id) && r.derivedBackground) wanted.add(r.derivedBackground.binding.inputs.scope.parentGenerationId);
  const candidates = state.outputs.filter(r => wanted.has(r.id) && !r.kind && !r.derivedAlpha && r.receipt.tool === 'image_gen')
    .flatMap(r => [{ path: r.originalPath, hash: r.hash }, { path: r.workingPath, hash: r.workingHash }]);
  try {
    await primeGeneratedRoleIdentities(state, candidates);
    for (const r of state.outputs) if (wanted.has(r.id) && (r.kind === 'matte-rgb-base' ||
        !r.derivedAlpha && state.requests.find(q => q.id === r.requestId)?.matteBackdrop))
      await primeBackdropRGBRecord(r);
    for (const aux of state.auxiliaries || []) await primeAuxiliaryEncoding(aux, budgetWorkingCopy);
    for(const r of state.outputs)if(wanted.has(r.id) && (r.kind==='derived-background'||r.derivedBackground))
      await primeBackgroundRecord(j,state,r,id=>matteBase(j,state,id));
    for (const r of state.outputs) if (wanted.has(r.id) && (r.packedAlpha || r.kind === 'derived-packed-alpha'))
      await primePackedAlpha(j, state, r);
    matteCAS(j, captured);
  } catch (e) {
    // File failures invalidate pending derived checks, but never overwrite a
    // concurrently committed registry or a changed job with this old snapshot.
    if (JSON.stringify(generationState(j)) === captured && JSON.stringify(getJob(j.id)) === JSON.stringify(j)) {
      for (const r of state.outputs) if (wanted.has(r.id) && r.derivedAlpha)
        invalidateMatteApprovals(state, r.derivedAlpha.binding.base.id);
      for(const r of state.outputs)if(wanted.has(r.id) && r.derivedBackground) {
        r.review=undefined;r.reviewEvidence=undefined;r.elements=undefined;state.composite=undefined;
      }
      for (const r of state.outputs) if (wanted.has(r.id) && r.packedAlpha) {
        r.review=undefined;r.reviewEvidence=undefined;r.elements=undefined;r.alphaDiagnostics=undefined;state.composite=undefined;
      }
      if (state.outputs.some(r => wanted.has(r.id) && (r.derivedAlpha || r.derivedBackground || r.packedAlpha))) atomic(statePath(j), state);
    }
    throw e;
  }
  // A failed seam is an honest review result, not corrupt source identity: keep
  // that result intact. Only the direct review action may inspect an unapproved
  // child; all material/composite/apply consumers require its own current review.
  if(!options?.backgroundReviewOnly)
    for(const r of state.outputs)if(ids.includes(r.id))requireDerivedBackgroundReview(state,r);
}
/** Freeze only new derived consumers; legacy ordinary completion stays unchanged. */
export function captureDerivedConsumer(j: Job, ids: string[]) {
  const state = generationState(j);
  return state.outputs.some(r => ids.includes(r.id) && (r.kind === 'derived-packed-alpha'||r.packedAlpha||r.kind === 'native-text'||r.kind === 'derived-alpha'||r.kind==='derived-background' ||
    r.kind === 'matte-rgb-base' || state.requests.find(q => q.id === r.requestId)?.matteBackdrop ||
    state.requests.find(q => q.id === r.requestId)?.opticalPlanHash ||
    state.requests.find(q => q.id === r.requestId)?.role === 'native-text')) ? JSON.stringify(state) : undefined;
}
export function verifyDerivedConsumer(j: Job, captured: string | undefined, ids: string[]) {
  if (!captured) return;
  matteCAS(j, captured);
  validateRegisteredConstraints(j, generationState(j), ids);
}

function validateRegisteredConstraints(j: Job, state: GenerationState, ids: string[]) {
  // Old composites may already have an accepted status. Check their padded
  // candidates before either reusing the cached image or recording approval.
  for (const r of state.outputs) if (ids.includes(r.id)) {
    if (!r.kind && !r.derivedAlpha && !r.derivedBackground && r.receipt.tool === 'image_gen')
      assertNotGeneratedRoleAlias(state, [r.outputPath, r.originalPath, r.workingPath], [r.hash, r.workingHash]);
    if (r.kind === 'matte-rgb-base' || state.requests.find(q => q.id === r.requestId)?.matteBackdrop ||
        state.layout?.layers.find(l => JSON.stringify(l.sourceLayerIds) === JSON.stringify(r.sourceLayerIds))?.matteBackdrop ||
        r.kind === 'derived-packed-alpha' || r.packedAlpha || r.kind === 'native-text' || r.receipt.tool === 'native-font-renderer' || r.kind === 'derived-alpha' || r.derivedAlpha || r.kind==='derived-background' || r.derivedBackground || r.backgroundPadding || r.alphaDiagnostics ||
        state.requests.find(q => q.id === r.requestId)?.role === 'native-text' ||
        state.requests.find(q => q.id === r.requestId)?.opticalPlanHash ||
        state.requests.find(q => q.id === r.requestId)?.alphaChecks?.length ||
        state.layout?.layers.find(l => JSON.stringify(l.sourceLayerIds) === JSON.stringify(r.sourceLayerIds))?.alphaChecks?.length)
      registeredGeneration(j, r.id, r.sourceLayerIds, r.frame);
  }
}

const pending = new Map<string, Promise<unknown>>();
export async function generationAction(j: Job, raw: unknown, psPlan?: PhotoshopPlan) {
  const key = statePath(j),
    prior = pending.get(key) || Promise.resolve();
  const next = prior.catch(() => {}).then(() => runGenerationAction(j, raw, psPlan));
  pending.set(key, next);
  try {
    return await next;
  } finally {
    if (pending.get(key) === next) pending.delete(key);
  }
}
async function runGenerationAction(j: Job, raw: unknown, psPlan?: PhotoshopPlan, nativeRegistration?: NativeRegistration) {
  if(raw && typeof raw==='object' && 'nativeGeometry' in raw)
    throw new Error('原生实体几何只能在首次prepare前layout冻结，不接受执行阶段覆盖');
  if(raw && typeof raw==='object' && 'contourSearch' in raw)
    throw opticalPartError('轮廓搜索范围只能在首次prepare前的layout/PS plan冻结，执行阶段不能覆盖');
  if (raw && typeof raw === 'object' && ('opticalPart' in raw || 'opticalPlanHash' in raw))
    throw opticalPartError('光学分件只能在首次prepare前的layout/PS plan冻结，prepare/register不能覆盖');
  if (raw && typeof raw === 'object' && 'packedBackdrop' in raw)
    throw new Error('单次双板只能首次prepare前在layout冻结，不能追改登记或派生');
  if (raw && typeof raw === 'object' && 'matteBackdrop' in raw)
    throw new Error('中灰RGB基底只能在首次prepare前的layout冻结，不能从prepare/register/derive覆盖');
  if (raw && typeof raw === 'object' && 'blendMode' in raw)
    throw new Error('混合模式只能在冻结layout中声明，prepare/register不能覆盖');
  if (raw && typeof raw === 'object' && 'alphaChecks' in raw)
    throw new Error('区域alpha约束只能在冻结layout或PS plan中声明，prepare/register不能覆盖');
  if(raw && typeof raw==='object' && 'sourceProtection' in raw)
    throw new Error('背景保护只能在首次prepare前的layout或PS plan中冻结，不能从prepare/register/derive覆盖');
  if (raw && typeof raw === 'object' && 'matteEncoding' in raw &&
      (!('action' in raw) || raw.action !== 'prepare' || !('matteForGenerationId' in raw) || !raw.matteForGenerationId))
    throw new Error('matteEncoding只能在aux prepare中显式冻结，非aux/登记/派生不能覆盖编码版本');
  const input = generationActionSchema.parse(raw),
    state = generationState(j);
  if (input.action === 'derive-alpha' && raw && typeof raw === 'object' &&
    Object.keys(raw).some(k => !['action', 'taskId', 'jobId', 'baseGenerationId', 'matteId',
      'expectedBaseWorkingHash', 'expectedMatteWorkingHash'].includes(k)))
    throw new Error('derive-alpha固定min(oldA,M)直接8位灰映射，不接受曲线、阈值或opacity参数');
  if (j.type === 'photoshop' && (input.action === 'derive-alpha' ||
    (input.action === 'prepare' && input.matteForGenerationId)))
    throw Object.assign(new Error('PS aux-matte/derive-alpha unsupported；本次仅普通v4实验'), { status: 400 });
  if (input.action === 'prepare' && input.matteForGenerationId && (input.detailReferences || input.referenceContext || input.referenceScale))
    throw new Error('辅助matte只能引用冻结RGB与干净局部，不能追加细节或周边参考');
  if (input.action === 'status') return state;
  if (input.action === 'layout') {
    const layout = validateLayout(j, input.layout);
    if ((state.requests.length || state.outputs.length) && JSON.stringify(state.layout) !== JSON.stringify(layout) &&
        (layout.layers.some(l => l.opticalPart) || state.layout?.layers.some(l => l.opticalPart)))
      throw opticalPartError('光学分件须在首次prepare前冻结完整layout，不能追改或删除分件归属');
    if (state.requests.length && JSON.stringify(state.layout) !== JSON.stringify(layout) &&
        (layout.layers.some(l => l.packedBackdrop) || state.layout?.layers.some(l => l.packedBackdrop)))
      throw new Error('单次双板计划必须在首次prepare前冻结，不能追改旧请求');
    if (state.requests.length && JSON.stringify(state.layout) !== JSON.stringify(layout) &&
        (layout.layers.some(l => l.matteBackdrop) || state.layout?.layers.some(l => l.matteBackdrop)))
      throw new Error('中灰RGB基底必须在首次prepare前冻结，不能追改旧请求');
    if (state.requests.length && JSON.stringify(state.layout) !== JSON.stringify(layout) &&
        (layout.layers.some(l => l.nativeText) || state.layout?.layers.some(l => l.nativeText)))
      throw new Error('原生文字内容/字体/位置必须在首次prepare前冻结，不能追改旧请求');
    if((state.requests.length || state.outputs.length) && (layout.layers.some(l=>l.sourceProtection) || state.layout?.layers.some(l=>l.sourceProtection)) &&
      JSON.stringify(state.layout)!==JSON.stringify(layout))throw new Error('背景保护计划必须在首次prepare前冻结；旧任务不能事后开启或改变');
    if (state.outputs.length && JSON.stringify(state.layout) !== JSON.stringify(layout))
      throw new Error(
        '已有真实候选，不能事后改变元素归属或参考定位点来让错误结果通过；修改需求应发起新任务',
      );
    // Validate merged geometry before any generation calls.
    if (j.frameContractVersion)
      frameContract(j, {
        groups: layout.layers.map((l) => l.sourceLayerIds),
        width: layout.width,
        height: layout.height,
      });
    const captured=JSON.stringify(state);
    for(const entry of layout.layers)if(entry.sourceProtection)
      await preflightBackgroundSelection(j,entry.sourceProtection,{width:layout.width||j.snapshot.width,height:layout.height||j.snapshot.height});
    if(layout.layers.some(l=>l.sourceProtection))matteCAS(j,captured);
    state.layout = layout;
    atomic(statePath(j), state);
    return { saved: true, layout };
  }
  const consumerIds = input.action === 'prepare' ? [input.matteForGenerationId].filter((id): id is string => !!id)
    : input.action === 'render-native-text' || input.action === 'render-native-geometry' || input.action === 'derive-packed-alpha' ? []
    : input.action === 'register' ? [state.requests.find(q => q.id === input.requestId)?.matteBinding?.base.id].filter((id): id is string => !!id)
    : input.action === 'derive-alpha' || input.action==='derive-background' ? [input.baseGenerationId]
    : input.action === 'composite' ? input.generationIds
    : input.action === 'review-composite' ? state.composite?.generationIds || [] : [input.generationId];
  await prepareGeneratedRoleConsumer(j, consumerIds, input.action==='review'?{backgroundReviewOnly:true}:undefined);
  const roleSnapshot = hasGeneratedRoles(state) ? JSON.stringify(state) : undefined;
  if (input.action === 'composite') {
    const matteConsumer = captureDerivedConsumer(j, input.generationIds);
    validateRegisteredConstraints(j, state, input.generationIds);
    state.composite = await renderGenerationComposite(
      j,
      state,
      input.generationIds,
      comparisonPanels,
      input.detailGenerationIds,
    );
    verifyDerivedConsumer(j, matteConsumer, input.generationIds);
    atomic(statePath(j), state);
    return state.composite;
  }
  if (input.action === 'review-composite') {
    const c = state.composite;
    validateRegisteredConstraints(j, state, c?.generationIds || []);
    if (
      !c?.complete ||
      c.comparisonHash !== input.comparisonHash ||
      hash(c.path) !== c.hash ||
      hash(c.comparisonPath) !== c.comparisonHash ||
      c.signature !==
        compositeSignature(
          j,
          c.generationIds.map((id) => state.outputs.find((r) => r.id === id)!),
          state,
        )
    )
      throw new Error('请先检查全部实际候选的最新合成与对比图');
    if (
      input.layers.length !== c.generationIds.length ||
      new Set(input.layers.map((l) => l.generationId)).size !== input.layers.length ||
      c.generationIds.some((id) => !input.layers.some((l) => l.generationId === id))
    )
      throw new Error('整图检查必须覆盖所有候选层');
    if (
      input.relations.length !== state.layout!.relations.length ||
      new Set(input.relations.map((r) => r.id)).size !== input.relations.length ||
      state.layout!.relations.some((r) => !input.relations.some((i) => i.id === r.id))
    )
      throw new Error('接触、遮挡与共同光效关系尚未逐项核对');
    for (const item of input.layers) {
      const r = state.outputs.find((r) => r.id === item.generationId)!;
      if (!r.review) throw new Error('先逐层review；最终整图不能代替本层检查');
      if (item.status === 'different' && r.review.status === 'accepted')
        throw new Error('合成中不同的层不能继续标为通过；请更新本层红色修改意见');
    }
    for (const item of input.relations.filter((r) => r.status === 'different')) {
      const relation = state.layout!.relations.find((r) => r.id === item.id)!;
      if (
        !c.generationIds.some((id) => {
          const r = state.outputs.find((r) => r.id === id)!;
          return (
            r.sourceLayerIds.some((id) => relation.layerIds.includes(id)) &&
            r.review?.status === 'needs-revision'
          );
        })
      )
        throw new Error(
          '层间关系仍有问题，请至少将相关目标层标红，不能把问题留在整图文字中却全部锁定保留',
        );
    }
    c.review = input;
    atomic(statePath(j), state);
    return { saved: true };
  }
  if (input.action === 'prepare') {
    const layoutEntry = state.layout?.layers.find(
      (l) => JSON.stringify(l.sourceLayerIds) === JSON.stringify(input.sourceLayerIds),
    );
    const contourSearch=layoutEntry?.contourSearch || psPlan?.layers.find(l=>l.layerId===input.sourceLayerIds[0])?.contourSearch;
    if(contourSearch && (input.matteForGenerationId || input.referenceContext || input.referenceScale || input.detailReferences))
      throw new Error('事前轮廓搜索范围使用冻结干净局部参考；不与辅助matte或参考扩展混用');
    if (layoutEntry?.nativeGeometry && (input.matteForGenerationId || input.referenceContext || input.referenceScale || input.detailReferences))
      throw opticalPartError('原生实体几何使用冻结完整承载与四角配方，不接受辅助matte、参考扩展或模型呈现选项');
    if (layoutEntry?.nativeText && (input.matteForGenerationId || input.referenceContext || input.referenceScale || input.detailReferences))
      throw new Error('原生文字使用冻结完整承载与字体计划，不接受辅助matte、参考扩展或模型呈现选项');
    validateOpaqueCheckRoute(j, input.sourceLayerIds, layoutEntry?.blendMode,
      j.type === 'photoshop' ? psPlan?.layers.find(l => l.layerId === input.sourceLayerIds[0])?.alphaChecks : layoutEntry?.alphaChecks);
    if (j.reconstructionWorkflowVersion === 4 && j.type !== 'photoshop') {
      if (!layoutEntry) throw new Error('先layout规划全部元素唯一归属、排除项和接触/遮挡关系');
      if (JSON.stringify(layoutEntry.elements) !== JSON.stringify(input.elements))
        throw new Error('本层元素须与已冻结归属计划一致');
      if (
        (input.width !== undefined && input.width !== (state.layout!.width || j.snapshot.width)) ||
        (input.height !== undefined && input.height !== (state.layout!.height || j.snapshot.height))
      )
        throw new Error('准备尺寸与已确认归属计划不一致');
      // Independent layers may be prepared before another layer's review. Visual
      // checkpoints belong at related groups and final composition, not a global
      // serial lock; final approval still binds every selected candidate.
    }
    if (input.matteForGenerationId) {
      const captured = JSON.stringify(state);
      const base = matteBase(j, state, input.matteForGenerationId);
      const binding = captureMatteBinding(j, state, base, input.matteEncoding), baseRequest = state.requests.find(q => q.id === base.requestId)!;
      if (binding.matteBackdrop?.version === 2 && state.matteFailures?.some(f => f.taskId === j.taskId &&
          f.jobId === j.id && f.baseGenerationId === base.id && f.baseWorkingHash === base.workingHash &&
          f.bindingHash === matteSignature(binding)))
        throw new Error('同一黑底基底的双背景方法已有真实不相容失败记录；未创建新白底请求。先改变前景表示/联合生成方法，不重复同样的白底调用。');
      if (JSON.stringify(input.sourceLayerIds) !== JSON.stringify(base.sourceLayerIds) ||
        (input.anchors.length && JSON.stringify(input.anchors) !== JSON.stringify(baseRequest.anchors)))
        throw new Error('辅助matte必须保持基底来源和生成前冻结定位点');
      const matteFeasibility = await evaluateMatteFeasibility({ workingPath: base.workingPath,
        workingHash: base.workingHash, workingSize: base.workingSize,
        placementFrame: base.placementFrame || base.frame, sourceSize: { width: j.snapshot.width, height: j.snapshot.height },
        canvas: baseRequest.canvas, checks: baseRequest.alphaChecks || [],
        ...(binding.matteBackdrop ? { matteBackdrop: binding.matteBackdrop } : {}) });
      matteCAS(j, captured);
      // CAS proved the record is unchanged. Recheck files without invoking the
      // consumer's approval invalidation: a rejected prepare must not write an
      // older family's registry as an incidental side effect.
      verifyMatteBinding(j, generationState(j), binding, id => {
        if (id !== base.id || baseRequest.referencePaths.some((p, i) => hash(p) !== baseRequest.referenceHashes[i]))
          throw new Error('辅助matte必要条件检查后基底或冻结引用已变化');
        return base;
      });
      requireMatteFeasibility(matteFeasibility);
      const references = [base.workingPath, binding.cleanLocal.path];
      const prompt = binding.matteBackdrop?.version === 2 ? [
        `双背景实验白底RGB，完整文件${base.workingSize.width}×${base.workingSize.height}，150万预算包括全部外沿。`,
        '第一张是实际已登记的黑底完整carrier，第二张是该请求的干净局部，仅核对材质归属。完整边界、前景轮廓、滴水、印字、每个笔画和位置必须与第一张完全相同；不能居中、裁切、旋转、调亮前景或重设计。',
        '只将黑色后景换为精确#ffffff白色后景。输出8位sRGB PNG，自身全部alpha255；保留前景原来的颜色、透明度与空间变化。薄材质通过白色后景显示，固有黑墨/黑刻度仍是原位深色实体，不变成白色，不省略。移除原环境，仅保留本层元素。',
        '这是一张彩色白底合成图，不是覆盖图、灰阶matte或高亮副本。后台固定用黑白两次RGB差计算alpha和前景RGB，必须能逐像素重新合成这两张实际输出；不相容则拒绝，不后调阈值。',
        `原图观察：${input.referenceObservation}；实验说明：${input.purpose}。保持用户未改主体、构图、形状、位置比例、透视、材质、光照、色彩、文字外观及透明细节；不把中间失真当设计意图。`,
      ].join('\n') : [
        `实验辅助alpha-matte，完整文件${base.workingSize.width}×${base.workingSize.height}，150万预算包括所有外沿。`,
        '第一张是本任务真实已登记RGB完整carrier，第二张是该基底请求的clean local，仅核对材质语义；严格保持第一张完整文件几何/留白，不裁边、不居中、不拉伸。',
        '只输出自身完全不透明的8位灰阶PNG标量场：黑0是无材质，白255是高覆盖，薄内区为有结构的中灰，折边/叠层与薄内区保留空间差异。数值是alpha估计，不是照明亮度或物理透明度真值。',
        input.matteEncoding === 'near-neutral-luma8-v2' || input.matteEncoding === 'near-neutral-luma8-v3'
          ? `输入编码明确冻结${input.matteEncoding}：以中性灰为目标；全部原件alpha=255。服务先在完整raw检查固定中性边界${JSON.stringify(input.matteEncoding === 'near-neutral-luma8-v2' ? NEAR_NEUTRAL_LIMITS : NEAR_NEUTRAL_V3_LIMITS)}，其中材质为maxRGB>8，平均spread<=2且99.9%材质像素spread<=8${input.matteEncoding === 'near-neutral-luma8-v2' ? '，全图spread<=16' : '；全图maxSpread只记录，不设单点上限'}。然后M=${MATTE_LUMA_FORMULA}固定转标量，再全carrier预算等比；不按审核通过率调颜色或公式。`
          : '输入编码为exact-gray8-v1：完整原件每像素必须R=G=B且alpha255，不允许近中性色差。',
        '灰值表示材质覆盖率，不按实体颜色明暗、固有黑墨或照明亮度判透明。冻结opaque区域及本材质的固有印字/深色实体须保持实际覆盖形状与高覆盖；薄透内区仍按材质结构。不得新增额外背景、树、人物、文字内容或复制RGB纹理，不得整片统一灰冒充透明，不使用PNG透明度承载matte；不根据审核阈值后调灰曲线。' +
          (binding.matteBackdrop ? '服务使用冻结中灰RGB基底和此matte固定解混前景RGB及alpha，基底本身不能作为正式图层。' : '真实纹理由基底RGB保留。'),
        `原图观察：${input.referenceObservation}；实验说明：${input.purpose}。不得改变用户冻结意见。`,
      ].join('\n');
      const request: Request = { ...baseRequest, id: uid(), role: 'aux-matte', matteForGenerationId: base.id,
        ...(input.matteEncoding !== undefined ? { matteEncoding: input.matteEncoding } : {}),
        matteBinding: binding, matteFeasibility, surface: 'opaque', carrier: undefined, prompt, referencePaths: references,
        referenceHashes: references.map(hash), localPath: binding.cleanLocal.path,
        promptStyle: input.promptStyle, referenceStrategy: input.referenceStrategy };
      state.requests.push(request); atomic(statePath(j), state);
      return { ...request, generation: generationPlan({ x: 0, y: 0, ...base.workingSize }),
        matteCarrier: { size: base.workingSize, placementFrame: binding.base.placement },
        transparent_background: false,
        instruction: binding.matteBackdrop?.version === 2
          ? '使用当前对话真实image_gen，输出完全不透明彩色白底PNG；保持黑底前景几何/颜色，原样使用prompt和有序referencePaths，原件立即register。'
          : '使用当前对话真实image_gen，输出完全不透明中性灰PNG；按冻结matteEncoding，原样使用prompt和有序referencePaths，原件立即register。',
        allowedReferencePaths: references, note: '辅助登记不是图层候选；必要条件不预测生成成功，不批准RGB污染/几何或视觉。真实image_gen返回后register原件，再显式derive-alpha。version2保留彩色白底RGB，以双背景方程取代灰度覆盖预测；方法未视觉接受。' };
    }
    const detailState = input.detailReferences || input.referenceContext || input.referenceScale ? JSON.stringify(state) : undefined;
    const contract = frameContract(j, {
      groups: [input.sourceLayerIds],
      width: input.width ?? state.layout?.width,
      height: input.height ?? state.layout?.height,
    });
    let layer = contract?.layers[0];
    let canvas = contract?.canvas;
    if (j.type === 'photoshop') {
      const entry = psPlan?.layers.find(
        (l) => input.sourceLayerIds.length === 1 && l.layerId === input.sourceLayerIds[0],
      );
      if (!entry || !['generate', 'hybrid'].includes(entry.route))
        throw new Error('该PS计划层不是生图路线，请先完成逐层路线计划');
      if (
        entry.elements.length &&
        JSON.stringify(entry.elements) !== JSON.stringify(input.elements)
      )
        throw new Error('生成元素清单必须与PS计划该层一致');
      canvas = psPlan!.canvas || j.snapshot;
      layer = {
        layerId: entry.layerId,
        sourceLayerIds: input.sourceLayerIds,
        name: entry.name,
        frame: entry.frame,
        generation: generationPlan(entry.frame),
        annotations: [],
      };
    }
    if (!layer || !canvas) throw new Error('请先确认分层画幅，再准备逐层生成');
    const detailPlanSnapshot = (input.detailReferences || input.referenceContext || input.referenceScale) && j.type === 'photoshop' && psPlan
      ? backgroundSignature(psPlan) : undefined;
    const background =
      psPlan?.layers.find((l) => l.layerId === layer!.layerId)?.content === 'background' ||
      input.sourceLayerIds.every(
        (id) => j.snapshot.layers.find((l) => l.id === id)?.role === 'background',
      );
    const psEntry = psPlan?.layers.find((l) => l.layerId === layer!.layerId);
    const opticalPart = j.type === 'photoshop' ? psEntry?.opticalPart : layoutEntry?.opticalPart;
    const opticalPrompts = opticalPart ? opticalPartPrompts(j.type === 'photoshop'
      ? photoshopOpticalMembers(j, psPlan!) : ordinaryOpticalMembers(j, state.layout!), input.sourceLayerIds) : [];
    const matteBackdrop = layoutEntry?.matteBackdrop;
    const packedBackdrop = layoutEntry?.packedBackdrop;
    if (packedBackdrop && state.requests.some(q => q.packedBackdrop &&
        JSON.stringify(q.sourceLayerIds) === JSON.stringify(input.sourceLayerIds)))
      throw new Error('本冻结单次双板已经准备；恢复原请求/登记/诊断，不重复同一方法生图');
    if (packedBackdrop && (input.referenceContext || input.referenceScale || input.detailReferences))
      throw new Error('单次双板仅使用完整clean local及可选全图，不与周边/缩放/细节混用');
    if (matteBackdrop && (input.referenceContext || input.referenceScale || input.detailReferences))
      throw new Error('已知底色RGB实验使用完整clean local，不混用周边/缩放/细节参考');
    const backdropAppearance = matteBackdrop?.version === 2
      ? '这是双背景实验的黑底彩色RGB辅助基底，不是最终透明图层。完整PNG自身每像素alpha255，物体之外、环境空隙以及透见的组外结构都替换为精确#000000黑色后景，无渐变、无环境残留。保持本层形状、比例、印字、滴水、固有反射与颜色，薄材质按自身透明度显示黑色后景。黑色固有墨迹与刻度完整保留，不能按暗色删除。后台另生成同一前景的白底RGB，通过颜色差恢复alpha与前景RGB；不绘制mask、不生成统一透明度或任意灰底。'
      : '这是已知底色RGB辅助基底，不是最终透明图层。完整PNG自身每像素alpha255，物体之外和环境孔隙使用精确#808080中灰，不能渐变或带源环境。薄透材质显示在该中灰底上的外观；保留本材质固有反射、印字和纹理，移除透见的组外结构/RGB。后台另生成matte并同时解混前景RGB与alpha，不在本图绘制灰阶mask或改成黑白底。';
    const blendMode = j.type === 'photoshop' ? (psEntry?.surface === 'screen' ? 'screen' : 'normal') : (layoutEntry?.blendMode || 'normal');
    const surface = psEntry?.surface || (blendMode === 'screen' ? 'screen' : background ? 'opaque' : 'transparent');
    const sourceProtection=j.type==='photoshop'?psEntry?.sourceProtection:layoutEntry?.sourceProtection;
    const independentScreen = surface === 'screen' && blendMode === 'screen' &&
      (j.type === 'photoshop' ? psEntry?.content === 'light' : layoutEntry?.content === 'light-effect');
    if (input.referenceContext && (j.reconstructionWorkflowVersion !== 4 ||
        !(surface === 'transparent' && blendMode === 'normal' || independentScreen) || background || sourceProtection))
      throw Object.assign(new Error('周边参考仅支持新prepare的v4普通透明前景或已声明独立screen光效；背景或源保护不支持'), { status: 400 });
    const contextOnly = input.referenceContext?.referenceMode === 'context-only';
    if (contextOnly && (input.referenceStrategy !== 'local-only' || input.detailReferences))
      throw Object.assign(new Error('单周边参考须显式local-only，不能同时提供全图或细节参考'), { status: 400 });
    const id = uid(),
      f = layer.frame,
      carrier = generationCarrier(
        f,
        j.reconstructionWorkflowVersion === 4 && surface !== 'opaque',
        surface === 'screen' ? 2.5 : 3,
        input.referenceContext?.marginPixels,
      ),
      p = carrier;
    if (input.referenceScale && (j.reconstructionWorkflowVersion !== 4 || background || sourceProtection ||
        surface !== 'transparent' || blendMode !== 'normal' || input.sourceLayerIds.length !== 1 ||
        input.referenceStrategy !== 'local-only' || input.referenceContext || input.detailReferences))
      throw Object.assign(new Error('完整参考放大呈现仅支持新v4单层normal透明前景、local-only且无周边/细节参考'), { status: 400 });
    const original = originalReference(j.documentId, j.snapshot);
    const current = assetPath(
      j.documentId,
      j.snapshot.status === 'preview' ? j.snapshot.source : j.snapshot.url || j.snapshot.source,
    );
    const refs = await reconstructionCrops(
      j,
      { version: 2, space: 'image-pixels', canvas, layers: [layer], instruction: '' },
      original.path,
      current,
    );
    const localPath = (refs.find((r) => r.role === 'current' && r.path) || refs.find((r) => r.path))
      ?.path;
    // Current confirmed edits have precedence. The imported original remains the appearance anchor.
    // A scene is context, not another composition target. New independent
    // model layers use their frozen local carrier unless global context was
    // explicitly requested. Stored requests and auxiliary/native contracts
    // retain their original ordered references.
    const referenceStrategy = input.referenceStrategy ||
      (j.reconstructionWorkflowVersion === 4 && input.sourceLayerIds.length === 1 && localPath &&
        !background && !sourceProtection && !matteBackdrop && !packedBackdrop &&
        !layoutEntry?.nativeGeometry && !layoutEntry?.nativeText &&
        (surface === 'transparent' || independentScreen) ? 'local-only' : 'local-and-global');
    if (referenceStrategy === 'local-only' && !localPath)
      throw new Error('纯局部引用需要可用的干净局部裁片；不能静默改为全图参考');
    const referencePaths =
      referenceStrategy === 'local-only'
        ? [localPath!]
        : [
            ...new Set(
              [localPath, ...refs.map((r) => r.path), original.path, current].filter(
                (p): p is string => !!p,
              ),
            ),
          ];
    const anchors = layoutEntry?.anchors?.length ? layoutEntry.anchors
      : psEntry?.anchors?.length ? psEntry.anchors : input.anchors;
    const alphaChecks = j.type === 'photoshop' ? psEntry?.alphaChecks : layoutEntry?.alphaChecks;
    const protectionPlanHash=sourceProtection?backgroundSignature(j.type==='photoshop'?psPlan:state.layout):undefined;
    const protectionState=sourceProtection?JSON.stringify(state):undefined;
    if(sourceProtection)await preflightBackgroundSelection(j,sourceProtection,canvas);
    // Material ownership is semantic; absence of numeric alpha ROIs must not preserve mixed backdrop RGB.
    // Only newly prepared v4 foreground prompts change; stored requests and legacy prompts stay frozen.
    // Declared optical parts already have exclusive ownership prompts. A mixed-material
    // template would instruct the film to keep the ink/rim/droplets assigned to siblings.
    const transmissionAware = !opticalPart && !matteBackdrop && surface === 'transparent' &&
      (j.reconstructionWorkflowVersion === 4 || alphaChecks?.some(c => c.kind === 'transmissive'));
    const declaredTransmission = alphaChecks?.some(c => c.kind === 'transmissive') === true;
    const transmissionAppearance = '只保留本层元素清单所列物体自身的字形、纹理、颜色与固有反射；排除项和其他层物体不因参考中可见而属于本层。' +
      (declaredTransmission
        ? '本层已冻结薄透材质区域：保留该材质自身水滴/刻痕。'
        : '输出透明只要求物体之外的区域透明，不意味着本层实体是薄透材料，不降低不透明实体覆盖率。若本层含薄透材质，仅对属于本层的薄透区域执行以下分离规则；不得借此保留明确排除的透光附件。') +
      '若本组同时包含薄透件及其后方实体，同组元素清单内的可见实体RGB仍归本组；例如面罩后同组脸部皮肤，不挖成透明后景。没有同组实体承接的薄透窗口须以局部alpha透见组外后景，仅保留该材质自身反射、水滴和印字；不能因本组含不透明实体就使该窗口继承近不透明alpha。以下后层分离仅指组外后景，不扩大元素清单或保留明确排除的附件。' +
      '薄透区域的参考像素已经混合后层；排除项与关系中明确属于后层的结构及颜色不属于本层RGB，不能原样复制成近不透明纹理。去除这些后景RGB同时重建该处材质alpha，不能只降低整层opacity。后层分离只改变材质归属，不改变源中本层已经可见的轮廓、曲率、端部和边缘截断；不能撑宽、拉直、增加翻卷尖端或将画外端部搬回框内。必要遮挡补全不得改画已可见边界。' +
      (declaredTransmission
        ? '保持本层实框、铰链、固有印字和未受分离影响的实体覆盖率，不把整个对象重新设计。'
        : '本层固有印字和未受分离影响的实体覆盖率仍保留，不添加其他层物体或额外光晕。');
    const alphaRegions = generationAlphaCheckRegions(alphaChecks || [], j.snapshot, canvas, carrier);
    const alphaPromptRegions = alphaRegions.map(({ canvasBox: _canvasBox, generationBox, ...check }) =>
      ({ ...check, box: generationBox }));
    const alphaPrompts = !matteBackdrop && alphaRegions.length ? [
      ...(alphaChecks?.some(c => c.kind === 'clear') ? ['冻结区域隔离约束：clear区域是原图可见环境孔隙，属于背景，不能当作被遮挡的人物/衣料补全；此清空规则不用于transmissive或opaque区域。'] : []),
      ...(declaredTransmission ? ['冻结区域隔离约束：transmissive区域要求连续的非空薄透材质覆盖，主要像素须处于本项冻结minAlpha至maxAlpha范围并满足minPassingFraction；不能只剩零散水滴/细边、将窗内大部分清空或近乎透明来通过。保留材质自身纹理和底色响应，移除透见的组外栏杆/格线等后景纹理，不另造这些后景纹理作为材质反射；不降低同组实体或整层opacity。'] : []),
      ...(alphaChecks?.some(c => c.kind === 'opaque') ? ['冻结opaque区域要求实体覆盖率alpha下限；黑色实体或本材质固有印字仍保留实际覆盖形状，不能按RGB明暗/墨色把它们当透明孔隙。'] : []),
      ...(alphaChecks?.some(c => c.kind === 'occupied') ? ['冻结occupied区域是本层已声明文字或细线所在的内容区域：按参考保留该区域内的完整内容和原位分布，不允许只保留大标题/主图而省略正文、参数表、公式或注脚。minAlpha与minPassingFraction仅检查内容没有整段消失，不证明字形或文字正确；不能新增实色矩形、纸底或扩大字形来凑覆盖率，不把字符间留白填满。'] : []),
      `以下box已由当前图片局部像素换算到本次完整生成文件像素；按区域修改对象，不绘制边框/坐标/名字：${JSON.stringify(alphaPromptRegions)}`,
      '数值是本任务明确记录的审核标准；标准黑白底数学响应不是单张原图可推断的真实光学透射率。',
    ] : [];
    const anchorFrame = sourceAnchorFrame(f, input.referenceContext ? carrier.frame : undefined, canvas);
    for (const a of anchors)
      if (
        a.point[0] < anchorFrame.x ||
        a.point[0] > anchorFrame.x + anchorFrame.width ||
        a.point[1] < anchorFrame.y ||
        a.point[1] > anchorFrame.y + anchorFrame.height
      )
        throw input.referenceContext
          ? Object.assign(new Error('周边参考定位点须在冻结carrier与真实整图的交集内，使用最终整图像素坐标'), { status: 400 })
          : new Error('参考定位点须在最终图层框内，使用最终整图像素坐标');
    // Pad a clean reference to the carrier before generation; this is reference
    // packaging, never an extracted object or a final layer substitute.
    const contextPrimaryPaths = input.referenceContext ? [...referencePaths] : undefined;
    const contextPrimaryHashes = contextPrimaryPaths?.map(hash);
    const presentationLocalHash = input.referenceScale ? hash(localPath!) : undefined;
    let referenceContext: Request['referenceContext'];
    if (input.referenceContext) {
      const contextRefs = await reconstructionCrops(j,
        { version: 2, space: 'image-pixels', canvas,
          layers: [{ ...layer, frame: carrier.frame, generation: p }], instruction: '' },
        original.path, current);
      // Never silently substitute an older original for confirmed current edits.
      const role = current === original.path ? 'original' : 'current';
      const context = contextRefs.find(r => r.role === role);
      if (!context?.path || !context.frame)
        throw Object.assign(new Error('周边参考缺少当前干净源的已确认尺寸映射，不能退回旧原图'), { status: 400 });
      if (contextRefs.some(r => !refs.some(old => old.role === r.role && old.sourceHash === r.sourceHash)))
        throw Object.assign(new Error('准备周边期间干净源参考已变化；不保存旧请求'), { status: 409 });
      const inputBytes = fs.readFileSync(context.path), meta = await sharp(inputBytes).metadata();
      const packaged = meta.width === p.size.width && meta.height === p.size.height
        ? inputBytes : await placementPreview(inputBytes, carrier.frame, carrier.frame, p.size);
      // Source crops remain immutable and unmasked. Only off-canvas transparent
      // packaging becomes neutral black for the explicitly frozen screen route.
      const bytes = independentScreen ? await sharp(packaged).flatten({ background: '#000000' }).png().toBuffer() : packaged;
      const contextPath = path.join(dir(j.documentId), 'jobs', j.id, 'references', `${id}-context-reference.png`);
      fs.writeFileSync(contextPath, bytes, { flag: 'wx' });
      referenceContext = { ...input.referenceContext, path: contextPath, hash: digest(bytes),
        cropPath: context.path, cropHash: digest(inputBytes), sourcePath: context.sourcePath,
        sourceHash: context.sourceHash, role, frame: context.frame, carrierFrame: carrier.frame,
        size: p.size, coordinateSpace: 'input-image-pixels' };
      if (contextOnly) referencePaths.splice(0, referencePaths.length, contextPath);
      else referencePaths.unshift(contextPath);
    } else if (carrier.expanded && localPath) {
      const cf = carrier.frame;
      const carrierRef = path.join(
        dir(j.documentId),
        'jobs',
        j.id,
        'references',
        `${id}-carrier-reference.png`,
      );
      const padded = await placementPreview(fs.readFileSync(localPath), f, cf, p.size);
      fs.writeFileSync(
        carrierRef,
        surface === 'screen' ? await sharp(padded).flatten({ background: '#000000' }).png().toBuffer() : padded,
      );
      referencePaths.unshift(carrierRef);
    }
    const referencePresentation = input.referenceScale
      ? await prepareReferencePresentation(carrier.expanded ? referencePaths[0] : localPath!, input.referenceScale,
          path.join(dir(j.documentId), 'jobs', j.id, 'references'), id) : undefined;
    if (referencePresentation) referencePaths.splice(0, referencePaths.length, referencePresentation.path);
    const presentationPrompts = referencePresentation ? [
      `唯一参考是${carrier.expanded ? '干净局部及其完整透明承载留白' : '干净完整局部'}的${referencePresentation.scale}倍等比呈现（${referencePresentation.size.width}×${referencePresentation.size.height}）；插值不增加真实细节。以整个参考边界的相对位置为准，不把倍率当作对象放大要求，不重排印字或细线。冻结输出画幅、定位点及生成像素预算不变。`,
    ] : [];
    const detailPrimaryHashes = input.detailReferences ? referencePaths.map(hash) : undefined;
    const detailReferences = input.detailReferences
      ? localPath
        ? await prepareDetailReferences(localPath, f, canvas, input.detailReferences,
            path.join(dir(j.documentId), 'jobs', j.id, 'references'), id)
        : (() => { throw new Error('细节参考需要可用的干净局部构图文件'); })()
      : undefined;
    const detailPrompts = detailReferences ? [
      '追加细节参考从本层干净局部原样裁取，不含新增承载外沿，未分离物体，不是补丁、蒙版或新构图；输出仍按第一张完整文件边界，不把细节放大铺满、不粘贴裁片。',
      ...detailReferences.map((d, i) => `第${referencePaths.length + i + 1}张参考「${d.name}」对应最终整图box${JSON.stringify(d.box)}，本次生成文件box${JSON.stringify([
        (d.box[0] - carrier.frame.x) * p.scale + p.offsetX,
        (d.box[1] - carrier.frame.y) * p.scale + p.offsetY, d.box[2] * p.scale, d.box[3] * p.scale,
      ])}；实际观察：${d.observation}。坐标仅供指认，不绘制标记；其他层内容仍须排除。`),
    ] : [];
    if (detailReferences) referencePaths.push(...detailReferences.map(d => d.path));
    if (referenceContext && (contextPrimaryHashes!.some((h, i) => hash(contextPrimaryPaths![i]) !== h) ||
        refs.some(r => hash(r.sourcePath) !== r.sourceHash)))
      throw Object.assign(new Error('准备周边期间干净源或构图参考已变化；不保存旧请求'), { status: 409 });
    if (detailPrimaryHashes && detailPrimaryHashes.some((h, i) => hash(referencePaths[i]) !== h))
      throw new Error('准备细节期间已选构图参考发生变化');
    if (referencePaths.length > 20) throw new Error('完整有序参考清单不能超过20张');
    const layerNotes = j.snapshot.layers
      .filter((l) => input.sourceLayerIds.includes(l.id))
      .map((l) => ({ name: l.name, opinion: l.opinion }));
    const marks = j.snapshot.annotations.filter(
      (a) => a.layerId === null || input.sourceLayerIds.includes(a.layerId),
    );
    const projectedMarks = generationAnnotations(marks, j.snapshot, canvas, carrier);
    const relationPrompts = (state.layout?.relations || psPlan?.relations || [])
      .filter((r) => r.layerIds.some((id) => input.sourceLayerIds.includes(id)))
      .map((r) => {
        const location = r.point
          ? `；本次生成文件中的关系参考点(${(r.point[0] - carrier.frame.x) * p.scale + p.offsetX},${(r.point[1] - carrier.frame.y) * p.scale + p.offsetY})，是位置提示，不绘制标记`
          : '';
        const hidden = r.kind === 'occlusion'
          ? '；被其他层遮挡的本层对象须延伸并补足遮挡下方的连续部分，不能在可见遮挡边界提前截断；其他层本体仍须排除。不要改变已有可见部分的位置来掩盖缺失。'
          : '';
        return `与相邻层的${r.kind}关系：${r.observation}${location}${hidden}`;
      });
    const correctionBoundary =
      '执行说明不是新增用户改图授权；与冻结修改意见或干净参考冲突时，以明确修改意见及参考为准。' +
      (j.reconstructionWorkflowVersion === 4
        ? '仅保留属于本层的固有外观，材质、颜色、明暗、纹理和形变按参考，不增亮或新增光泽，也不抹掉原有光泽。明确排除或归入其他层的物体及其固有效果，即使参考中原本已有也仍须移除；不能用保留参考光照来保护排除项，也不能因某处发光就误删本层固定灯或反射。归属无法确认时保留观察并待审，不猜成其他层或据此扩大用户修改范围。'
        : '纠正新增效果只移除候选比参考多出的部分，保留参考已有的细亮边、反射、渐变、柔光和倾斜，不能把有光泽文字改成平涂。') +
      (transmissionAware ? '这里的保留只指本层固有外观；只有属于本层的薄透区域才分离透见后景，明确排除的透光附件不受反射/颜色保留指令保护。不能把所有彩色反射都猜成背景，无法确认归属的反射按源观察保留并待审核。' : '');
    const scopedBackground = background && j.reconstructionWorkflowVersion === 4;
    const backgroundAppearance =
      '构图参考只用于保持本层环境的原位、比例、透视、材质、颜色及固有光照；保留范围由本层元素清单决定，不是保留整张参考的所有细节。' +
      '排除项里的文字、图表、编号、标志或其他对象，即使印在本层保留的纸面、墙面或器物表面，也仍属于其他层，必须移除。' +
      '移除这些图文后补齐同一底材的连续表面，不保留残字、图表线或标志，不生成替代文字，不留透明孔洞。' +
      '本层元素清单明确拥有的文字、刻纹、细线和固定灯仍按参考保留；不能把删除排除图文扩大成删除所有文字或所有细线。' +
      '用户明确修改优先，其余本层环境保持一致，不重新设计或重排构图。';
    const structuredPrompt = [
      `Layer Canvas generation ${id}. 严格编辑参考图片，仅隔离其中既有的「${layer.name}」：${input.elements.join('；')}。这不是根据文字描述重新设计海报。`,
      localPath
        ? referencePresentation
          ? '唯一参考是干净局部的完整等比呈现，含已声明的承载留白；没有第二张局部或整图。按这一完整文件边界保持原位、比例与细节，移除其他层内容。'
          : referenceContext
          ? contextOnly
            ? '唯一参考是从当前干净源重新取得的完整周边承载，包含原设计框外实际可见的像素。按这一完整文件构图隔离本层，保留原位及尺寸；参考不是抠图，其他层内容必须移除。'
            : '第一张是从当前干净源重新取得的完整周边承载参考，包含原设计框外实际可见的像素；第二张是旧设计框局部用于对照，不能按第二张边缘截去第一张可见笔画。局部不是抠图，其他层内容必须移除。'
          : carrier.expanded
          ? `第一张参考是干净局部放入生成承载画幅的构图依据，第二张是未补外沿的局部细节；${referenceStrategy === 'local-only' ? '未附整图。' : '后续整图提供语境。'}局部不是抠图结果，必须移除其他层内容。`
          : `第一张参考是完整虚线框对应的干净原图局部，优先保持其中元素的位置、占比、倾斜、轮廓和细节；${referenceStrategy === 'local-only' ? '未附整图。' : '整图仅辅助语境。'}局部裁片不是抠图结果，须移除不属于该层的内容。`
        : '本框没有可用局部裁片，不得假称已有精确局部参考；按整图及已确认坐标补全。',
      `最终图层设计画幅(${f.x},${f.y},${f.width},${f.height})；生成文件承载范围(${carrier.frame.x},${carrier.frame.y},${carrier.frame.width},${carrier.frame.height})。请求完整文件${p.size.width}×${p.size.height}，总像素不得超过1500000，${matteBackdrop ? '中灰外沿' : '透明留白'}也计入。`,
      referencePresentation
        ? '保持唯一参考中的元素占比与完整文件边界，不铺满透明留白，不重新居中。'
        : referenceContext
        ? `周边参考扩展依据：${referenceContext.observation}；显式边距${referenceContext.marginPixels}最终整图像素。冻结设计frame与定位点保持不变；只在承载中保留原图已可见的本层完整笔画或轮廓，不重画或搬回旧框内。承载到整图之外的${independentScreen ? '纯黑中性区' : '透明区'}不能编造画外内容，也不授权纳入排除项。`
        : carrier.expanded
        ? `第一张参考已增加${surface === 'screen' ? '纯黑中性' : '透明'}外沿来承载狭长画面；第二张保留原局部细节。按照第一张的完整文件构图生成，元素保留在原局部对应区域，不能放大铺满新增留白。`
        : '完整局部参考与输出文件边界一一对应。',
      scopedBackground ? backgroundAppearance : transmissionAware ? transmissionAppearance + '文字描述只用于指认对象，不能取代视觉参考。不重排、居中或放大主体，用户明确修改优先。' : '保留参考中实际可见的字形、倾斜、变形、纹理、颜色和效果；文字描述只用于指认对象，不能取代视觉参考。不重排、居中或放大主体，不添加留白、描边、浮雕等参考没有的效果。仅补全被其他物体遮挡的必要区域。用户明确修改优先，其余外观与参考保持一致。',
      matteBackdrop ? backdropAppearance : surface === 'screen'
        ? `只生成独立光效，纯黑底用于滤色（screen），不能画入人物/产品/背景；叠加要求：${psEntry?.compositing || '按冻结layout滤色叠加，黑色为中性底，不重复其他层内容'}。`
        : background
          ? '生成移除前景并补全遮挡后的连续不透明背景。'
          : '只生成本层物体及必需的遮挡补全部分，其他区域真透明；不能携带原图矩形背景。',
      `已观察的参考特征：${input.referenceObservation}`,
      ...presentationPrompts,
      ...detailPrompts,
      `冻结定位参照（由执行者观察，不是自动测量，不得为了通过校验修改目标点）：${JSON.stringify(anchors.map((a) => ({ ...a, generationPoint: [(a.point[0] - carrier.frame.x) * p.scale + p.offsetX, (a.point[1] - carrier.frame.y) * p.scale + p.offsetY] })))}。`,
      `排除项：${layoutEntry?.excludes || psEntry?.excludes || '其他图层的所有元素'}。`,
      ...opticalPrompts,
      ...alphaPrompts,
      ...relationPrompts,
      `执行说明（隔离与纠错）：${input.purpose}`,
      correctionBoundary,
      ...(j.snapshot.opinion ? [`总图修改意见：${j.snapshot.opinion}`] : []),
      ...layerNotes.filter((l) => l.opinion).map((l) => `${l.name}修改意见：${l.opinion}`),
      ...(marks.length
        ? [
            `标注已换算到本次生成文件坐标，箭头target是所指位置；选区brushSize是该文件像素直径。画外坐标可以为负数。标注仅是位置和修改意见，不绘制标记：${JSON.stringify(projectedMarks)}。`,
          ]
        : []),
      '不要绘制标注、框线、坐标或其他图层。不应为了变清晰而重新设计文字、图标或物体。',
      j.type === 'photoshop'
        ? 'PS素材按计划混合方式制作，避免把同一效果同时烘焙并再次加样式。'
        : background && j.reconstructionWorkflowVersion === 4 ? '本层为连续不透明背景；自然补齐排除对象后的环境，不留透明孔洞。'
        : blendMode === 'screen' ? '本层已冻结为独立光效滤色合成，纯黑底合法；不要同时烘焙背景或重复发光。' : '本层以正常透明度合成；使用真透明素材，不携带黑色矩形底。',
    ].join('\n');
    const prompt =
      input.promptStyle === 'concise-edit'
        ? [
            `Layer Canvas generation ${id}. 编辑所附参考，仅隔离原有「${layer.name}」：${input.elements.join('；')}。不要重新设计、重新排版或美化。`,
            scopedBackground ? backgroundAppearance : localPath
              ? contextOnly
                ? '唯一参考就是完整输出画幅。保留既有对象的原位、大小、字形、倾斜、颜色、纹理及固有光照，只删除排除项。' + (transmissionAware ? transmissionAppearance : '')
                : (referenceStrategy === 'local-only'
                    ? '第一张干净局部就是完整输出画幅的构图依据，保留原有可见位置、比例、字形、姿势、倾斜、颜色、纹理与光照；只移除排除项，不把主体重新居中，不从整图另排构图。'
                    : '第一张是输出构图依据，严格保持对象在完整文件中的位置、占比、字形、倾斜、变形、颜色、纹理与光照；其余参考仅补充细节和语境。') + (transmissionAware ? transmissionAppearance : '')
              : '按干净整图及确认的局部坐标编辑；没有精确局部参考，不得自行假定物体居中。',
            contextOnly
              ? `完整文件${p.size.width}×${p.size.height}，含留白总像素不超过1500000。保留原有完整文件边界，不裁边、不居中或放大对象。`
              : `输出完整文件${p.size.width}×${p.size.height}，含${matteBackdrop ? '中灰外沿' : '透明留白'}总像素不超过1500000。以第一张参考的整个文件边界为准，保持对象在其中的相对位置和大小；插件负责将这一整张结果放回原图，不需要重新安排总图构图。`,
            ...(referencePresentation
              ? ['仅附一张完整等比呈现参考，没有第二张原始局部。保持其中的元素占比和透明留白，不铺满留白或重新居中。']
              : referenceContext
              ? [contextOnly
                  ? `周边源观察：${referenceContext.observation}。参考中已可见的本层${independentScreen ? '完整光迹、亮点、弱晕' : '笔画'}不得按旧框截断；整图之外${independentScreen ? '仅保留纯黑中性区' : '仍透明'}，不编造画外内容。`
                  : `第一张包含从当前干净源取得的周边真实像素；第二张为旧框局部对照，不按旧框截笔。观察依据：${referenceContext.observation}。冻结设计frame和定位点不变；保留第一张可见的本层${independentScreen ? '完整光迹、亮点、弱晕' : '笔画'}与原位，删除周边其他层；整图之外${independentScreen ? '仅保留纯黑中性区' : '仍透明'}，不编造画外内容。`]
              : carrier.expanded
              ? [`第一张已补${surface === 'screen' ? '纯黑中性' : '透明'}外沿，第二张是原始局部。保持第一张中的元素占比，不铺满新增留白。`]
              : []),
            matteBackdrop ? backdropAppearance : surface === 'screen'
              ? `独立光效放纯黑底，以滤色合成：${psEntry?.compositing || '按冻结layout滤色叠加，黑色为中性底，不重复其他层内容'}。`
              : background
                ? '移除排除项，沿原有环境自然补齐遮挡处；输出连续不透明背景。'
                : '只保留本层对象，其他区域真透明；不保留矩形背景。不改变画面边缘原有截断，不把画外部分移回框内。仅补全必要遮挡部分。',
            `排除：${layoutEntry?.excludes || psEntry?.excludes || '其他层对象'}。${contextOnly ? '' : '排除项决定本层归属，参考中的其他物体不能带入结果。'}`,
            ...opticalPrompts,
            ...alphaPrompts,
            `${contextOnly ? '源观察（只用于识别；若采用整图坐标，不能直接当作参考文件坐标）' : '参考观察（只用于识别已有对象，不取代参考图）'}：${input.referenceObservation}`,
            ...presentationPrompts,
            ...detailPrompts,
            ...(anchors.length && localPath
              ? [`${contextOnly ? '本参考文件中的冻结位置（相对文件左上角，横向/纵向百分比；不绘制标记、不移动目标）' : '冻结位置参照（相对第一张完整文件左上角，横向/纵向百分比；只指认已有特征，不绘制标记，不移动对象来重新居中）'}：${JSON.stringify(anchors.map(a => ({ name: a.name, positionPercent: [
                  Math.round(((a.point[0] - carrier.frame.x) * p.scale + p.offsetX) / p.size.width * 10000) / 100,
                  Math.round(((a.point[1] - carrier.frame.y) * p.scale + p.offsetY) / p.size.height * 10000) / 100,
                ] })))}。${contextOnly ? '' : '这些是生成前人工观察的参照，误差和未拟合形状仍须生成后核对，不是自动精确定位保证。'}`]
              : []),
            ...relationPrompts,
            `执行说明（隔离与纠错）：${input.purpose}`,
            correctionBoundary,
            ...(j.snapshot.opinion ? [`总图意见：${j.snapshot.opinion}`] : []),
            ...layerNotes.filter((l) => l.opinion).map((l) => `${l.name}意见：${l.opinion}`),
            ...(marks.length
              ? [
                  `标注已换算到当前生成文件坐标，箭头target是所指位置，brushSize是选区直径；画外坐标不裁到边缘。只按意见修改对象，不绘制标记：${JSON.stringify(projectedMarks)}`,
                ]
              : []),
            '用户明确修改优先；其余与最初原图保持一致，不撤销已确认修改。不绘制标注或坐标。',
            ...(j.type !== 'photoshop' && !background && blendMode !== 'screen'
              ? ['以正常透明度合成，不使用黑底或另外添加重复发光效果。']
              : []),
          ].join('\n')
        : structuredPrompt;
    const r: Request = {
      id,
      ...(contourSearch?{contourSearch}:{}),
      ...(layoutEntry?.nativeText ? { role: 'native-text' as const, nativeText: layoutEntry.nativeText } : {}),
      ...(layoutEntry?.nativeGeometry ? { role: 'native-geometry' as const, nativeGeometry: layoutEntry.nativeGeometry } : {}),
      sourceLayerIds: input.sourceLayerIds,
      frame: f,
      canvas,
      name: layer.name,
      background,
      surface,
      blendMode,
      carrier,
      anchors,
      alphaChecks,
      ...(layoutEntry?.allowAuxMatte !== undefined ? { allowAuxMatte: layoutEntry.allowAuxMatte } : {}),
      ...(matteBackdrop ? { matteBackdrop } : {}),
      ...(packedBackdrop ? { packedBackdrop } : {}),
      ...(opticalPart ? { opticalPart, opticalPlanHash: opticalPlanHash(j, j.type === 'photoshop' ? psPlan! : state.layout!) } : {}),
      ...(sourceProtection?{sourceProtection,sourceProtectionPlanHash:protectionPlanHash}:{}),
      elements: input.elements,
      referenceObservation: input.referenceObservation,
      referencePaths,
      referenceHashes: referencePaths.map(hash),
      localPath,
      ...(contextOnly ? { localReferenceHash: contextPrimaryHashes![contextPrimaryPaths!.indexOf(localPath!)] }
        : referencePresentation ? { localReferenceHash: presentationLocalHash } : {}),
      prompt: layoutEntry?.nativeGeometry ? [
        `Layer Canvas native-geometry-renderer ${id}：仅按事前冻结的${layoutEntry.nativeGeometry.version===3?'连续薄膜凸多边形/实色/alpha渐变':layoutEntry.nativeGeometry.version===2?'连续薄膜四角/实色/alpha渐变':'简单实体四角/孔/实色'}制作透明位图，不调用image_gen。`,
        `元素：${input.elements.join('；')}。排除：${layoutEntry.excludes}。实际观察：${input.referenceObservation}。`,
        '用户明确修改优先；其余对照最初原图和已确认内容。完整承载含留白不超过150万像素，不从源像素描摹，不是PS可编辑形状。',
        JSON.stringify(layoutEntry.nativeGeometry),
      ].join('\n') : layoutEntry?.nativeText ? [
        `Layer Canvas native-font-renderer ${id}：仅按冻结字体计划填充单色字形${layoutEntry.nativeText.version === 2 ? '并应用事前观察的平面倾斜/斜切' : '，保持水平'}，不调用image_gen。`,
        `元素：${input.elements.join('；')}。排除：${layoutEntry.excludes}。`,
        `实际观察：${input.referenceObservation}。执行目的：${input.purpose}。`,
        '用户明确修改优先；其余对照最初原图和当前已确认内容，不自行排版或改字。',
        '计划中的文字、字体文件摘要、字号和字形观察框为实际渲染参数；完整承载透明，工作预算150万像素。',
        JSON.stringify(layoutEntry.nativeText),
      ].join('\n') : packedBackdrop ? [
        `Layer Canvas single-carrier ${id}。一次编辑所附参考，仅隔离既有「${layer.name}」：${input.elements.join('；')}。不要重新设计、排版或美化。`,
        '第一张为冻结frame的完整干净局部，按其整个文件边界保持对象原位、大小、比例、字形、印字、水滴、纹理、反射和固有颜色；其余参考只补充语境。原图裁片仅作参考，组外物体不属于本层。',
        `输出一张完全不透明彩色PNG，完整文件${packedBackdrop.panelSize.width * 2}×${packedBackdrop.panelSize.height}，左半${packedBackdrop.panelSize.width}×${packedBackdrop.panelSize.height}精确#000000黑后景，右半同尺寸精确#ffffff白后景。两板合计含留白不超过1500000像素。固定垂直中线，无间隔、标签、边框、标题或第三板。`,
        `本次完整carrier预算规范版本${packedBackdrop.version}：原件不改，只在超预算时统一缩小完整文件；${packedBackdrop.version === 2 ? '使用事前冻结whole-carrier-nearest-v1，避免跨黑白中线插值串色，不改变每板边界或做单板配准' : '沿用原版本完整文件Lanczos3缩小'}。这不授权调整透明度、颜色或错误前景。`,
        '在同一文件中共同生成两板完全相同的前景，只更换后景黑/白：对应轮廓、位置、印字、水滴、颜色、反射逐像素一致；右板不能重新设计或重新曝光。透明孔隙显示各自纯底色；连续薄材质按同一覆盖率响应底色，不把材质挖成碎孔。固有黑墨与实体不因颜色深而删除，透见的组外栏杆/景物须移除。PNG自身所有alpha=255；不要绘制灰阶mask或棋盘格。',
        `每板完整边界映射到原图冻结frame${JSON.stringify(f)}。冻结原图定位点${JSON.stringify(anchors)}，冻结原图区域规则${JSON.stringify(alphaChecks)}；这些坐标不是整张双板坐标，不绘制标记。`,
        `实际观察：${input.referenceObservation}。排除：${layoutEntry?.excludes}。执行说明：${input.purpose}。`,
        ...relationPrompts, correctionBoundary,
        ...(j.snapshot.opinion ? [`总图修改意见：${j.snapshot.opinion}`] : []),
        ...layerNotes.filter(l => l.opinion).map(l => `${l.name}修改意见：${l.opinion}`),
        ...(marks.length ? [`原图局部像素标注仅为位置和修改意见，分别映射到每板，不画入图像：${JSON.stringify(marks)}`] : []),
        '用户明确修改优先；其余对照最初干净原图及当前已确认内容，保留未修改的可见外观。只补全必要遮挡，不擅自增加效果。两板同一前景只是本次生成要求，后台还须固定解混和视觉审核，不能声称已一致。',
      ].join('\n') : prompt,
      promptStyle: input.promptStyle,
      referenceStrategy,
      ...(detailReferences ? { detailReferences } : {}),
      ...(referencePresentation ? { referencePresentation } : {}),
      ...(referenceContext ? { referenceContext } : {}),
      planHash: psPlan
        ? digest(
            Buffer.from(JSON.stringify(psPlan.layers.find((l) => l.layerId === layer!.layerId))),
          )
        : undefined,
    };
    verifyOpticalRequest(j, r, generationState(j).layout);
    if(protectionState) {
      matteCAS(j,protectionState);
      backgroundSelectionBinding(j,sourceProtection!);
      if(backgroundSignature(backgroundProtectionPlan(j,state,input.sourceLayerIds).plan)!==protectionPlanHash)
        throw new Error('prepare期间冻结的背景保护计划已变化');
    }
    if (detailState) matteCAS(j, detailState);
    if (packedBackdrop) packedBinding(j, state, r);
    if (referencePresentation && (hash(localPath!) !== presentationLocalHash ||
        hash(referencePresentation.sourcePath) !== referencePresentation.sourceHash ||
        hash(referencePresentation.path) !== referencePresentation.hash))
      throw Object.assign(new Error('保存前完整参考呈现或干净定位参考已变化'), { status: 409 });
    if (detailPlanSnapshot && backgroundSignature(backgroundProtectionPlan(j, state, input.sourceLayerIds).plan) !== detailPlanSnapshot)
      throw Object.assign(new Error('准备细节或周边期间PS完整计划已变化；不保存旧请求'), { status: 409 });
    state.requests.push(r);
    atomic(statePath(j), state);
    return {
      ...r,
      generation: packedBackdrop ? { ...p, size: { width: packedBackdrop.panelSize.width * 2, height: packedBackdrop.panelSize.height }, pixelBudget: GENERATION_PIXEL_BUDGET } : p,
      ...(alphaRegions.length ? { alphaCheckRegions: alphaRegions } : {}),
      transparent_background: !packedBackdrop && !matteBackdrop && surface === 'transparent',
      instruction:
        r.role === 'native-geometry'
          ? '核对源四角、实体孔或连续膜alpha渐变与冻结配方后调用render-native-geometry(requestId)。真实来源为native-geometry-renderer，不调用image_gen/register，不是物理透射率；仍须实际alpha与逐层/整图视觉审核。'
          : r.role === 'native-text'
          ? '先查看实际干净源并核对冻结文字/字体/字形框；调用render-native-text(requestId)。本层不调用image_gen或register，后台记录实际字体渲染来源，透明位图仍须逐层和整图审核。'
          : '先查看所有参考图。使用当前对话image_gen，prompt原样包含上文，引用referencePaths，返回后立即登记原始文件，不先改尺寸/裁切/描摹。此登记不能验证宿主内部模型身份。',
    };
  }
  if (input.action === 'render-native-geometry') {
    const q=state.requests.find(q=>q.id===input.requestId),entry=state.layout?.layers.find(l=>JSON.stringify(l.sourceLayerIds)===JSON.stringify(q?.sourceLayerIds));
    if(j.type==='photoshop'||q?.role!=='native-geometry'||!q.nativeGeometry||!q.carrier||
        !entry?.nativeGeometry||JSON.stringify(entry.nativeGeometry)!==JSON.stringify(q.nativeGeometry)||requestReferencesChanged(q))
      throw new Error('原生实体几何须使用本任务显式事前冻结的普通请求，计划/参考不得变化');
    validateLayout(j,state.layout!);
    const previous=state.outputs.find(r=>r.requestId===q.id);
    if(previous){registeredGeneration(j,previous.id,previous.sourceLayerIds,previous.frame);return {...previous,generationId:previous.id,elements:q.elements,reused:true};}
    const captured=JSON.stringify(state),result=renderNativeGeometryRaster(q.nativeGeometry,q.carrier.frame,q.carrier.size),
      out=path.join(folder(j),'native-geometry-'+uid());fs.mkdirSync(out,{recursive:true});
    const outputPath=path.join(out,'native-geometry.png'),proofPath=path.join(out,'native-geometry-proof.json');
    fs.writeFileSync(outputPath,result.bytes,{flag:'wx'});
    fs.writeFileSync(proofPath,JSON.stringify({...result.proof,taskId:j.taskId,jobId:j.id,requestId:q.id,requestHash:nativeGeometrySignature(q)},null,2),{flag:'wx'});
    matteCAS(j,captured);
    return runGenerationAction(j,{action:'register',requestId:q.id,path:outputPath,prompt:q.prompt,referencePaths:q.referencePaths},psPlan,
      {kind:'native-geometry',requestId:q.id,path:outputPath,proof:{path:proofPath,hash:hash(proofPath)}});
  }
  if (input.action === 'render-native-text') {
    const q = state.requests.find(q => q.id === input.requestId);
    if (j.type === 'photoshop' || q?.role !== 'native-text' || !q.nativeText || !q.carrier)
      throw new Error('render-native-text须使用本任务显式冻结的普通原生文字请求');
    const entry = state.layout?.layers.find(l => JSON.stringify(l.sourceLayerIds) === JSON.stringify(q.sourceLayerIds));
    if (!entry || JSON.stringify(entry.nativeText) !== JSON.stringify(q.nativeText) || requestReferencesChanged(q))
      throw new Error('原生文字冻结计划/参考已变化');
    validateLayout(j, state.layout!);
    const previous = state.outputs.find(r => r.requestId === q.id);
    if (previous) {
      registeredGeneration(j, previous.id, previous.sourceLayerIds, previous.frame);
      return { ...previous, generationId: previous.id, elements: q.elements, reused: true };
    }
    const captured = JSON.stringify(state);
    const result = renderNativeText(q.nativeText, q.carrier.frame, q.carrier.size);
    const out = path.join(folder(j), 'native-render-' + uid()); fs.mkdirSync(out, { recursive: true });
    const outputPath = path.join(out, 'native-text.png'), proofPath = path.join(out, 'native-text-proof.json');
    fs.writeFileSync(outputPath, result.bytes, { flag: 'wx' });
    fs.writeFileSync(proofPath, JSON.stringify({ ...result.proof, taskId: j.taskId, jobId: j.id,
      requestId: q.id, requestHash: nativeTextSignature(q) }, null, 2), { flag: 'wx' });
    matteCAS(j, captured);
    return runGenerationAction(j, { action: 'register', requestId: q.id, path: outputPath,
      prompt: q.prompt, referencePaths: q.referencePaths }, psPlan,
      { requestId: q.id, path: outputPath, proof: { path: proofPath, hash: hash(proofPath) } });
  }
  if (input.action === 'register') {
    const request = state.requests.find((r) => r.id === input.requestId);
    if (!request) throw new Error('生成准备记录不存在');
    verifyOpticalRequest(j, request, state.layout);
    if (request.packedBackdrop) {
      const captured = JSON.stringify(state), bindingHash = packedBinding(j, state, request);
      if (input.prompt !== request.prompt || JSON.stringify(input.referencePaths) !== JSON.stringify(request.referencePaths))
        throw new Error('单次双板真实提示词/有序参考须匹配本次冻结请求');
      if (!path.isAbsolute(input.path) || !fs.statSync(input.path).isFile()) throw new Error('真实carrier原件路径无效');
      if (state.packedCarriers?.some(c => c.requestId === request.id)) throw new Error('本次单次carrier已经登记；恢复原登记，不追加同请求生成');
      const bytes = fs.readFileSync(input.path), rawHash = digest(bytes);
      const rawPixels = await rememberExactRGBA(bytes);
      const sourceFiles = [...request.referencePaths, request.localPath!,
        assetPath(j.documentId, j.snapshot.status === 'preview' ? j.snapshot.source : j.snapshot.url || j.snapshot.source),
        originalReference(j.documentId, j.snapshot).path];
      for (const p of sourceFiles) if (samePath(p, input.path) || await rememberExactRGBA(fs.readFileSync(p)) === rawPixels)
        throw new Error('干净源/参考不能冒充真实单次生成carrier');
      await rememberExactRGBA(bytes); await primeGeneratedRoleIdentities(state);
      assertNotGeneratedRoleAlias(state, [input.path], [rawHash]);
      const normalized = await normalizePackedCarrier(bytes, request.packedBackdrop), id = uid();
      const out = path.join(folder(j), 'packed-' + id); fs.mkdirSync(out, { recursive: true });
      const originalPath = path.join(out, 'original.png'), workingPath = path.join(out, 'working.png');
      fs.writeFileSync(originalPath, bytes, { flag: 'wx' });fs.writeFileSync(workingPath, normalized.bytes, { flag: 'wx' });
      const c: PackedCarrier = { id, requestId: request.id, bindingHash, recipe: request.packedBackdrop,
        toolOutput: { path: path.resolve(input.path), hash: rawHash }, original: { path: originalPath, hash: rawHash },
        working: { path: workingPath, hash: digest(normalized.bytes) }, originalSize: normalized.originalSize,
        workingSize: normalized.workingSize,
        receipt: { tool: 'image_gen', toolHistoryVerified: false, modelCalls: 1, prompt: request.prompt, referencePaths: request.referencePaths } };
      matteCAS(j, captured); verifyPackedCarrier(j, state, c);
      (state.packedCarriers ??= []).push(c); atomic(statePath(j), state);
      return { ...c, packedId: id, intermediateOnly: true, formalLayer: false,
        note: '真实单次carrier已登记，不是最终层；调用derive-packed-alpha固定中线拆板和方程验证。板件不冒称两次image_gen。' };
    }
    if (['native-text','native-geometry'].includes(request.role || '') && (!nativeRegistration || nativeRegistration.requestId !== request.id ||
        nativeRegistration.path !== input.path) || nativeRegistration && request.role !== (nativeRegistration.kind || 'native-text')) {
      if(request.role==='native-geometry')throw opticalPartError('原生实体几何只允许后台render-native-geometry登记，不接受外部路径或image_gen身份');
      throw new Error('原生文字只允许后台render-native-text登记，不接受外部路径或image_gen身份');
    }
    const nativeState = nativeRegistration ? JSON.stringify(state) : undefined;
    if (request.role === 'aux-matte') {
      if (j.type === 'photoshop') throw new Error('PS辅助matte登记unsupported');
      const captured = JSON.stringify(state);
      if (!request.matteBinding) throw new Error('辅助matte请求缺少基底绑定');
      verifyMatteBinding(j, state, request.matteBinding, id => matteBase(j, state, id));
      if (input.prompt !== request.prompt || JSON.stringify(input.referencePaths) !== JSON.stringify(request.referencePaths) ||
        request.referencePaths.some((p, i) => hash(p) !== request.referenceHashes[i]))
        throw new Error('辅助matte真实提示/有序引用必须匹配冻结请求');
      if (!path.isAbsolute(input.path) || !fs.statSync(input.path).isFile()) throw new Error('辅助matte原件路径无效');
      const snapshot = fs.readFileSync(input.path), snapshotHash = digest(snapshot), id = uid();
      const out = path.join(folder(j), 'aux-' + id); fs.mkdirSync(out, { recursive: true });
      const originalPath = path.join(out, 'original.png'), workingPath = path.join(out, 'working.png');
      fs.writeFileSync(originalPath, snapshot);
      const parsed = request.matteEncoding === 'near-neutral-luma8-v2' || request.matteEncoding === 'near-neutral-luma8-v3'
        ? await nearNeutralScalar(snapshot, request.matteEncoding) : undefined;
      const whiteComposite = request.matteEncoding === 'white-composite-rgb8-v1';
      if (!parsed) { if (whiteComposite) await validateBackdropRaw(snapshot); else await decodeOpaqueGray(snapshot); }
      const working = await budgetWorkingCopy(parsed?.scalarBytes || snapshot); fs.writeFileSync(workingPath, working.bytes);
      if (whiteComposite) await validateBackdropRaw(working.bytes); else await decodeOpaqueGray(working.bytes);
      if (aspectError(working.workingSize, request.matteBinding.base.size) > ASPECT_TOLERANCE)
        throw new Error('辅助matte完整carrier比例不符，不能裁边或拉伸');
      const aux: AuxiliaryMatte = { id, requestId: request.id, requestHash: matteSignature(request), role: 'aux-matte', binding: request.matteBinding,
        originalPath, hash: snapshotHash, originalSize: working.originalSize,
        workingPath, workingHash: digest(working.bytes), workingSize: working.workingSize,
        toolOutput: { path: path.resolve(input.path), hash: snapshotHash },
        ...(request.matteEncoding !== undefined ? { matteEncoding: request.matteEncoding } : {}),
        ...(parsed ? { encodingProof: { ...parsed.proof, workingHash: digest(working.bytes), workingSize: working.workingSize } } : {}),
        receipt: { tool: 'image_gen', toolHistoryVerified: false, prompt: input.prompt, referencePaths: input.referencePaths,
          ...(request.matteEncoding !== undefined ? { matteEncoding: request.matteEncoding } : {}) } };
      // Establish real raw/work identities before this role becomes visible,
      // including the first auxiliary in a process with no role cache yet.
      await primeGeneratedRoleIdentities({ ...state, auxiliaries: [...(state.auxiliaries || []), aux] }, [
        request.matteBinding.base.original, request.matteBinding.base.working]);
      await primeAuxiliaryEncoding(aux, budgetWorkingCopy);
      matteCAS(j, captured);
      verifyAuxiliaryMatte(j, generationState(j), aux, id => matteBase(j, generationState(j), id));
      (state.auxiliaries ??= []).push(aux); atomic(statePath(j), state);
      return { ...aux, auxiliaryId: aux.id, note: parsed
        ? '真实近中性PNG原件已保留；working是按固定luma内部生成的标量场，包含解析证明，不是image_gen原件或layer generationId，未通过视觉。'
        : '真实辅助灰阶matte原件已保留；不是layer generationId，未通过视觉。' };
    }
    const currentChecks = (j.type === 'photoshop'
      ? psPlan?.layers.find(l => request.sourceLayerIds.length === 1 && l.layerId === request.sourceLayerIds[0])?.alphaChecks
      : state.layout?.layers.find(l =>
        JSON.stringify(l.sourceLayerIds) === JSON.stringify(request.sourceLayerIds))?.alphaChecks) || [];
    if (JSON.stringify(currentChecks) !== JSON.stringify(request.alphaChecks || []))
      throw new Error('区域alpha约束与冻结准备记录不一致，请重新prepare');
    const backdropState = request.matteBackdrop ? JSON.stringify(state) : undefined;
    const currentBackdrop = state.layout?.layers.find(l =>
      JSON.stringify(l.sourceLayerIds) === JSON.stringify(request.sourceLayerIds))?.matteBackdrop;
    if (request.matteBackdrop && (j.type === 'photoshop' || nativeRegistration) ||
        JSON.stringify(currentBackdrop) !== JSON.stringify(request.matteBackdrop))
      throw new Error('已知底色只能由普通v4冻结layout准备，登记期间不能改变基底身份');
    validateOpaqueCheckRoute(j, request.sourceLayerIds, request.blendMode, request.alphaChecks);
    if (
      !input.prompt.includes(request.prompt) ||
      input.referencePaths.length !== request.referencePaths.length ||
      input.referencePaths.some((p, i) => !samePath(p, request.referencePaths[i]))
    )
      throw new Error('实际提示词/参考图与本层准备记录不符；不能省略局部裁片或替换冻结构图');
    if (requestReferencesChanged(request))
      throw new Error('参考已变更');
    if (!path.isAbsolute(input.path) || !fs.statSync(input.path).isFile())
      throw new Error('生成原文件路径无效');
    const bytes = fs.readFileSync(input.path);
    const matteBackdropRaw = request.matteBackdrop ? await validateBackdropRaw(bytes) : undefined;
    const detailRecords = state.requests.flatMap(q => [ ...(q.detailReferences || []),
      ...(q.referencePresentation ? [
        { path: q.referencePresentation.path, hash: q.referencePresentation.hash, kind: 'presentation' as const },
        { path: q.referencePresentation.sourcePath, hash: q.referencePresentation.sourceHash, kind: 'presentation' as const },
        ...(q.localPath && q.localReferenceHash
          ? [{ path: q.localPath, hash: q.localReferenceHash, kind: 'presentation' as const }] : []),
      ] : []),
      ...(q.referenceContext ? [
        { path: q.referenceContext.path, hash: q.referenceContext.hash, kind: 'context' as const },
        { path: q.referenceContext.cropPath, hash: q.referenceContext.cropHash, kind: 'context' as const },
        ...(q.referenceContext.referenceMode === 'context-only' && q.localPath && q.localReferenceHash
          ? [{ path: q.localPath, hash: q.localReferenceHash, kind: 'context' as const }] : []),
      ] : []),
    ]);
    const detailRegistrationState = detailRecords.length ? JSON.stringify(state) : undefined;
    const detailRegistrationPlan = detailRecords.length && j.type === 'photoshop' && psPlan
      ? backgroundSignature(psPlan) : undefined;
    await assertNotDetailReferenceOutput(bytes, detailRecords);
    const originalHash = digest(bytes);
    if (hasGeneratedRoles(state)) await rememberExactRGBA(bytes);
    if (!nativeRegistration) assertNotGeneratedRoleAlias(state, [input.path], [originalHash]);
    const working = await budgetWorkingCopy(bytes);
    if (hasGeneratedRoles(state)) await rememberExactRGBA(working.bytes);
    if (!nativeRegistration) assertNotGeneratedRoleAlias(state, [input.path], [originalHash, digest(working.bytes)]);
    // stats() observes the input image, not lazy pipeline transforms. Materialize
    // alpha first so ordinary RGB backgrounds have a real fourth channel.
    const alpha = await sharp(
      await sharp(working.bytes).toColourspace('srgb').ensureAlpha().png().toBuffer(),
    ).stats();
    if (alpha.channels[3].max === 0) throw new Error('生成文件没有可见内容，不能用空层占位');
    let isolationProblem =
      request.matteBackdrop || request.surface === 'screen'
        ? undefined
        : request.background
          ? alpha.channels[3].min < 255
            ? '背景仍有透明空洞'
            : undefined
          : alpha.channels[3].min === 255
            ? '前景没有透明区域，可能仍是带背景的矩形裁片'
            : undefined;
    const ordinaryBackground = j.reconstructionWorkflowVersion === 4 && j.type !== 'photoshop' &&
      request.background && request.surface !== 'screen';
    let backgroundOpacity: GenerationRecord['backgroundOpacity'];
    if (ordinaryBackground) {
      const nativeMeta = await sharp(bytes).metadata();
      const opaqueAlpha = !nativeMeta.hasAlpha || nativeMeta.depth === 'uchar' ? 255
        : nativeMeta.depth === 'ushort' ? 65535 : undefined;
      if (opaqueAlpha === undefined) {
        isolationProblem ||= '背景原件的alpha位深无法可靠验证，不能按完全不透明背景补边';
      } else {
        // Inspect untouched native pixels. Budget downsampling can erase even
        // one alpha254 pixel, and converting 16-bit alpha to 8-bit can too.
        const minAlpha = nativeMeta.hasAlpha ? (await sharp(bytes).stats()).channels.at(-1)!.min : 255;
        backgroundOpacity = { version: 1, sourceHash: originalHash, minAlpha, opaqueAlpha };
        if (minAlpha !== opaqueAlpha)
          isolationProblem ||= '背景原件含透明或弱alpha像素，不能用预算缩小后的不透明结果掩盖并补边';
      }
    }
    const id = uid(),
      out = path.join(folder(j), id);
    fs.mkdirSync(out, { recursive: true });
    const originalPath = path.join(out, 'original' + path.extname(input.path).toLowerCase());
    const workingPath = path.join(out, 'working.png');
    fs.writeFileSync(originalPath, bytes);
    fs.writeFileSync(workingPath, working.bytes);
    const isolationPreviews = await writeIsolationPreviews(
      working.bytes,
      out,
      request.surface === 'screen' ? 'screen' : 'normal',
    );
    const targetFrame = request.carrier?.frame || request.frame;
    const projection = ordinaryBackground && !isolationProblem
      ? backgroundPlacement(working.workingSize, working.originalSize, targetFrame)
      : { placementFrame: filePlacement(working.workingSize, targetFrame) };
    const { placementFrame, backgroundPadding } = projection;
    if (projection.problem) isolationProblem = projection.problem;
    const placedBytes = backgroundPadding
      ? (await restoreGeneration(workingPath, placementFrame, backgroundPadding)).bytes
      : working.bytes;
    const placedPreviewPath = path.join(out, 'placed-preview.png');
    const comparison = comparisonContract(request);
    fs.writeFileSync(
      placedPreviewPath,
      await placementPreview(placedBytes, placementFrame, comparison.comparisonFrame),
    );
    const comparisonPath = path.join(out, 'compare-reference-result-overlay-difference.png');
    await comparisonPanels(
      comparison.comparisonReferencePath,
      placedPreviewPath,
      comparisonPath,
    );
    const record: GenerationRecord = {
      id,
      ...(matteBackdropRaw ? { kind: 'matte-rgb-base' as const, matteBackdropRaw } : {}),
      ...(nativeRegistration?.kind==='native-geometry' ? {kind:'native-geometry' as const,nativeGeometryProof:nativeRegistration.proof}
        : nativeRegistration ? { kind: 'native-text' as const, nativeTextProof: nativeRegistration.proof } : {}),
      requestId: request.id,
      blendMode: request.blendMode || 'normal',
      sourceLayerIds: request.sourceLayerIds,
      frame: request.frame,
      originalPath,
      outputPath: input.path,
      hash: originalHash,
      workingPath,
      workingHash: hash(workingPath),
      originalSize: working.originalSize,
      workingSize: working.workingSize,
      comparisonPath,
      comparisonHash: hash(comparisonPath),
      ...comparison,
      isolationPreviews,
      aspectError: aspectError(working.originalSize, request.carrier?.frame || request.frame),
      placementFrame,
      backgroundPadding,
      backgroundOpacity,
      placedPreviewPath,
      isolationProblem,
      planHash: request.planHash,
      receipt: {
        tool: nativeRegistration?.kind==='native-geometry' ? 'native-geometry-renderer' : nativeRegistration ? 'native-font-renderer' : 'image_gen',
        toolHistoryVerified: false,
        prompt: input.prompt,
        referencePaths: input.referencePaths,
      },
    };
    if (request.alphaChecks?.length) record.alphaDiagnostics = await evaluateGenerationAlphaChecks({
      checks: request.alphaChecks, sourceSize: { width: j.snapshot.width, height: j.snapshot.height },
      canvas: request.canvas, originalHash: record.hash, workingHash: record.workingHash,
      workingPath: record.workingPath, placementFrame,
    });
    if (roleSnapshot) {
      await primeGeneratedRoleIdentities(state, [{ path: originalPath, hash: originalHash },
        { path: workingPath, hash: digest(working.bytes) }]);
      matteCAS(j, roleSnapshot);
      if (hash(input.path) !== originalHash) throw new Error('角色身份预检后真实登记原件已变化；输出文件保留');
      if (!nativeRegistration) assertNotGeneratedRoleAlias(state, [input.path, originalPath, workingPath], [originalHash, digest(working.bytes)]);
    }
    if (detailRegistrationState) {
      matteCAS(j, detailRegistrationState);
      if (hash(input.path) !== originalHash || requestReferencesChanged(request))
        throw new Error('细节登记期间原件或冻结参考发生变化；文件保留，不提交旧登记');
      if (detailRecords.some(d => hash(d.path) !== d.hash))
        throw new Error('细节登记期间本任务已冻结的其他细节参考变化；不提交旧登记');
      if (detailRegistrationPlan && backgroundSignature(backgroundProtectionPlan(j, state, request.sourceLayerIds).plan) !== detailRegistrationPlan)
        throw Object.assign(new Error('细节登记期间PS完整计划已变化；不保存旧登记'), { status: 409 });
    }
    if (nativeState) {
      matteCAS(j, nativeState);
      if(nativeRegistration?.kind==='native-geometry')verifyNativeGeometryRecord(j,state,record);
      else verifyNativeTextRecord(j, state, record);
    }
    if (backdropState) {
      matteCAS(j, backdropState);
      if (hash(input.path) !== originalHash || requestReferencesChanged(request))
        throw new Error('中灰基底登记期间原件或冻结参考已变化；文件保留，不提交旧登记');
    }
    verifyOpticalRequest(j, request, generationState(j).layout);
    state.outputs.push(record);
    atomic(statePath(j), state);
    return {
      ...record,
      generationId: id,
      placement: placementFrame,
      elements: request.elements,
      note: '先查看isolationPreviews深浅底完整独立层，检查残留其他物体、矩形补片、文字/人物挖空负形及遮挡补全；这些证据仅供查看，不能当素材回传。对比图从左到右：局部参考、按真实放置坐标显示的输出、半透明叠加、差异。原件与弱alpha完整保留，比例/定位通过不等于内容一致；随后合成检查接触/遮挡。',
    };
  }
  if (input.action === 'derive-packed-alpha') {
    const captured = JSON.stringify(state), c = state.packedCarriers?.find(c => c.id === input.packedId);
    if (!c || c.working.hash !== input.expectedCarrierHash) throw new Error('须引用本job真实单次carrier及匹配工作摘要');
    const q = verifyPackedCarrier(j, state, c);
    if (state.packedFailures?.some(f => f.packedId === c.id && f.carrierHash === c.working.hash && f.bindingHash === c.bindingHash))
      throw new Error('相同单次carrier已保存不相容失败；不重复派生或调参');
    if (state.outputs.some(r => r.packedAlpha?.packedId === c.id)) throw new Error('单次carrier已派生；恢复既有登记');
    const normalized = await normalizePackedCarrier(fs.readFileSync(c.original.path), c.recipe);
    if (digest(normalized.bytes) !== c.working.hash || JSON.stringify(normalized.workingSize) !== JSON.stringify(c.workingSize) ||
        JSON.stringify(normalized.originalSize) !== JSON.stringify(c.originalSize)) throw new Error('完整carrier固定预算来源不符');
    const panels = await splitPackedCarrier(normalized.bytes), id = uid(), out = path.join(folder(j), 'packed-derived-' + id);
    fs.mkdirSync(out, { recursive: true });
    const blackPath = path.join(out, 'black.png'), whitePath = path.join(out, 'white.png');
    fs.writeFileSync(blackPath, panels.black, { flag: 'wx' });fs.writeFileSync(whitePath, panels.white, { flag: 'wx' });
    let result;
    try {
      for (const [workingPath, whiteComposite] of [[blackPath, false], [whitePath, true]] as const)
        requireMatteFeasibility(await evaluateMatteFeasibility({ workingPath, workingHash: hash(workingPath), workingSize: panels.size,
          placementFrame: q.frame, sourceSize: { width: j.snapshot.width, height: j.snapshot.height }, canvas: q.canvas, checks: q.alphaChecks!,
          matteBackdrop: { version: 2, color: '#000000', space: 'srgb-byte-v1' }, whiteComposite }));
      result = await applyDualBackdrop(panels.black, panels.white);
    } catch (error) {
      matteCAS(j, captured); verifyPackedCarrier(j, state, c);
      const diagnosticPath = path.join(out, 'failure.json'), reason = error instanceof Error ? error.message : String(error);
      const bytes = Buffer.from(JSON.stringify({ taskId: j.taskId, jobId: j.id, packedId: c.id, carrierHash: c.working.hash,
        bindingHash: c.bindingHash, algorithm: PACKED_ALGORITHM, reason,
        diagnostic: error instanceof Error && 'diagnostic' in error ? error.diagnostic : null,
        black: { path: blackPath, hash: hash(blackPath) }, white: { path: whitePath, hash: hash(whitePath) },
        generatedRGBA: false, wholeGoalAccepted: false }, null, 2));
      fs.writeFileSync(diagnosticPath, bytes, { flag: 'wx' });
      (state.packedFailures ??= []).push({ packedId: c.id, carrierHash: c.working.hash, bindingHash: c.bindingHash,
        reason, diagnosticPath, diagnosticHash: digest(bytes),
        black: { path: blackPath, hash: hash(blackPath) }, white: { path: whitePath, hash: hash(whitePath) } });atomic(statePath(j), state);throw error;
    }
    const originalPath = path.join(out, 'derived.png'), workingPath = path.join(out, 'working.png'), outputHash = digest(result.bytes);
    fs.writeFileSync(originalPath, result.bytes, { flag: 'wx' });fs.writeFileSync(workingPath, result.bytes, { flag: 'wx' });
    const previews = await writeIsolationPreviews(result.bytes, out, 'normal'), placedPreviewPath = path.join(out, 'placed-preview.png');
    const view = comparisonContract(q);
    fs.writeFileSync(placedPreviewPath, await placementPreview(result.bytes, q.frame, view.comparisonFrame));
    const comparison = await comparisonPanels(view.comparisonReferencePath, placedPreviewPath, path.join(out, 'comparison.png'));
    const record: GenerationRecord = { id, kind: 'derived-packed-alpha', requestId: q.id, sourceLayerIds: q.sourceLayerIds,
      frame: q.frame, blendMode: 'normal', originalPath, outputPath: originalPath, hash: outputHash,
      workingPath, workingHash: outputHash, originalSize: result.size, workingSize: result.size,
      placementFrame: q.frame, comparisonPath: comparison.path, comparisonHash: comparison.hash,
      isolationPreviews: previews, ...view, placedPreviewPath, aspectError: aspectError(result.size, q.frame),
      packedAlpha: { algorithm: PACKED_ALGORITHM, packedId: c.id, carrierRecordHash: matteSignature(c), bindingHash: c.bindingHash,
        black: { path: blackPath, hash: hash(blackPath) }, white: { path: whitePath, hash: hash(whitePath) },
        outputHash, outputSize: result.size, unmix: result.unmix },
      receipt: { tool: 'derived-packed-alpha', toolHistoryVerified: false, packedId: c.id, prompt: q.prompt, referencePaths: q.referencePaths } };
    record.alphaDiagnostics = await evaluateGenerationAlphaChecks({ checks: q.alphaChecks!, sourceSize: { width: j.snapshot.width, height: j.snapshot.height },
      canvas: q.canvas, originalHash: outputHash, workingHash: outputHash, workingPath, placementFrame: q.frame });
    await primePackedAlpha(j, state, record);matteCAS(j, captured);verifyPackedAlpha(j, state, record);
    state.outputs.push(record);state.composite=undefined;atomic(statePath(j), state);
    return { ...record, generationId: id, note: '一份真实carrier派生两板再固定解混；不是两次image_gen，也不等于实际前景/整体视觉一致。继续逐层和完整合成审核。' };
  }
  if (input.action === 'derive-alpha') {
    const captured = JSON.stringify(state), aux = state.auxiliaries?.find(a => a.id === input.matteId);
    if (!aux || aux.binding.base.id !== input.baseGenerationId) throw new Error('派生必须引用本job匹配的真实RGB与辅助matte两登记');
    const base = verifyAuxiliaryMatte(j, state, aux, id => matteBase(j, state, id));
    if (base.workingHash !== input.expectedBaseWorkingHash || aux.workingHash !== input.expectedMatteWorkingHash)
      throw new Error('派生的expected工作hash与冻结双来源不符');
    const baseBytes = fs.readFileSync(base.workingPath), maskBytes = fs.readFileSync(aux.workingPath);
    if (digest(baseBytes) !== base.workingHash || digest(maskBytes) !== aux.workingHash) throw new Error('派生字节快照hash不匹配');
    if (state.matteFailures?.some(f => f.taskId === j.taskId && f.jobId === j.id &&
        f.baseGenerationId === base.id && f.matteId === aux.id && f.baseWorkingHash === base.workingHash &&
        f.matteWorkingHash === aux.workingHash && f.bindingHash === matteSignature(aux.binding)))
      throw new Error('相同双输入已保存不相容失败，不能重复派生伪装新尝试；原件与诊断保持。');
    if (aux.binding.matteBackdrop?.version === 2) {
      const baseRequest = state.requests.find(q => q.id === base.requestId)!;
      requireMatteFeasibility(await evaluateMatteFeasibility({ workingPath: aux.workingPath,
        workingHash: aux.workingHash, workingSize: aux.workingSize, placementFrame: aux.binding.base.placement,
        sourceSize: { width: j.snapshot.width, height: j.snapshot.height }, canvas: baseRequest.canvas,
        checks: baseRequest.alphaChecks || [], matteBackdrop: aux.binding.matteBackdrop, whiteComposite: true }));
      matteCAS(j, captured);
    }
    const id = uid(), out = path.join(folder(j), id); fs.mkdirSync(out, { recursive: true });
    let result;
    try { result = await applyGeneratedMatte(baseBytes, maskBytes, aux.binding.matteBackdrop); }
    catch (error) {
      if (aux.binding.matteBackdrop?.version === 2 && error instanceof Error && 'diagnostic' in error) {
        matteCAS(j, captured);
        verifyAuxiliaryMatte(j, generationState(j), aux, id => matteBase(j, generationState(j), id));
        const diagnosticPath = path.join(out, 'failure.json');
        const bytes = Buffer.from(JSON.stringify({ taskId: j.taskId, jobId: j.id, baseGenerationId: base.id,
          matteId: aux.id, baseWorkingHash: base.workingHash, matteWorkingHash: aux.workingHash,
          algorithm: matteAlgorithm(aux.binding.matteBackdrop), reason: error.message,
          diagnostic: error.diagnostic, generatedRGBA: false, wholeGoalAccepted: false }, null, 2));
        fs.writeFileSync(diagnosticPath, bytes, { flag: 'wx' });
        (state.matteFailures ??= []).push({ taskId: j.taskId, jobId: j.id, baseGenerationId: base.id, matteId: aux.id,
          baseWorkingHash: base.workingHash, matteWorkingHash: aux.workingHash, bindingHash: matteSignature(aux.binding),
          algorithm: 'black-white-composite-unmix-v1', reason: error.message, diagnosticPath, diagnosticHash: digest(bytes) });
        atomic(statePath(j), state);
      }
      throw error;
    }
    if (JSON.stringify(result.size) !== JSON.stringify(base.workingSize)) throw new Error('基底工作件实际尺寸不匹配登记');
    const originalPath = path.join(out, 'derived.png'), workingPath = path.join(out, 'working.png');
    fs.writeFileSync(originalPath, result.bytes); fs.writeFileSync(workingPath, result.bytes);
    await rememberExactRGBA(result.bytes);
    const request = state.requests.find(q => q.id === base.requestId)!, placementFrame = aux.binding.base.placement;
    const previews = await writeIsolationPreviews(result.bytes, out, 'normal');
    const placedPreviewPath = path.join(out, 'placed-preview.png');
    const comparisonView = comparisonContract(request);
    fs.writeFileSync(placedPreviewPath, await placementPreview(result.bytes, placementFrame, comparisonView.comparisonFrame));
    const comparison = await comparisonPanels(comparisonView.comparisonReferencePath, placedPreviewPath, path.join(out, 'comparison.png'));
    const outputHash = digest(result.bytes);
    const record: GenerationRecord = { id, kind: 'derived-alpha', requestId: base.requestId, sourceLayerIds: base.sourceLayerIds,
      frame: base.frame, blendMode: 'normal', originalPath, outputPath: originalPath, hash: outputHash,
      workingPath, workingHash: outputHash, originalSize: result.size, workingSize: result.size,
      placementFrame, comparisonPath: comparison.path, comparisonHash: comparison.hash, isolationPreviews: previews,
      ...comparisonView,
      aspectError: base.aspectError, placedPreviewPath,
      derivedAlpha: { algorithm: matteAlgorithm(aux.binding.matteBackdrop),
        ...(result.unmix ? { unmix: result.unmix } : {}),
        binding: aux.binding, matteId: aux.id, matteRecordHash: matteSignature(aux),
        ...(aux.matteEncoding !== undefined ? { matteEncoding: aux.matteEncoding } : {}),
        baseSnapshotHash: digest(baseBytes), matteSnapshotHash: digest(maskBytes), mapping: result.mapping,
        outputHash, outputSize: result.size },
      receipt: { tool: 'derived-alpha', toolHistoryVerified: false, prompt: request.prompt, referencePaths: request.referencePaths,
        baseGenerationId: base.id, matteId: aux.id,
        ...(aux.matteEncoding !== undefined ? { matteEncoding: aux.matteEncoding } : {}) } };
    record.alphaDiagnostics = await evaluateGenerationAlphaChecks({ checks: request.alphaChecks!, sourceSize: { width: j.snapshot.width, height: j.snapshot.height },
      canvas: request.canvas, originalHash: outputHash, workingHash: outputHash, workingPath, placementFrame });
    matteCAS(j, captured);
    verifyDerivedAlpha(j, generationState(j), record, id => matteBase(j, generationState(j), id));
    state.outputs.push(record); state.composite = undefined; atomic(statePath(j), state);
    return { ...record, generationId: id, decreased: result.decreased,
      note: aux.binding.matteBackdrop
        ? '后台以冻结#808080/sRGB字节式和真实matte同时解混RGB与alpha，再合成最大误差<=2；不是物理玻璃透射或image_gen原件，仍须实际源位/纹理/深浅底/完整合成审核。'
        : '后台双来源派生，RGB不变且alpha=min(oldA,M)；不是image_gen原件。必须真实深浅底、纹理和几何审核，数值通过不自动accepted。' };
  }
  if(input.action==='derive-background') {
    const captured=JSON.stringify(state),base=matteBase(j,state,input.baseGenerationId);
    if(base.workingHash!==input.expectedBaseWorkingHash)throw new Error('背景补全expected工作摘要与真实登记不匹配');
    if(state.outputs.some(r=>r.derivedBackground?.binding.inputs.scope.parentGenerationId===base.id))
      throw new Error('该背景基底已有派生结果；不能无依据重复合成同一来源');
    const binding=captureBackgroundBinding(j,state,base),result=await deriveProtectedBackgroundSnapshot(binding.inputs);
    const id=uid(),out=path.join(folder(j),id);fs.mkdirSync(out,{recursive:true});
    const originalPath=path.join(out,'derived-background.png'),workingPath=path.join(out,'working.png');
    fs.writeFileSync(originalPath,result.bytes);fs.writeFileSync(workingPath,result.bytes);
    await rememberExactRGBA(result.bytes);
    const previews=await writeIsolationPreviews(result.bytes,out,'normal'),request=state.requests.find(q=>q.id===base.requestId)!;
    const placedPreviewPath=path.join(out,'placed-preview.png');fs.writeFileSync(placedPreviewPath,result.bytes);
    const comparison=await comparisonPanels(request.localPath!,placedPreviewPath,path.join(out,'comparison.png'));
    const record:GenerationRecord={id,kind:'derived-background',derivedBackground:{binding,proof:result.proof},
      requestId:base.requestId,sourceLayerIds:base.sourceLayerIds,frame:base.frame,blendMode:'normal',
      originalPath,outputPath:originalPath,hash:result.proof.outputHash,workingPath,workingHash:result.proof.outputHash,
      originalSize:result.proof.size,workingSize:result.proof.size,placementFrame:base.frame,planHash:base.planHash,
      comparisonPath:comparison.path,comparisonHash:comparison.hash,isolationPreviews:previews,
      placedPreviewPath,aspectError:0,receipt:{tool:'derived-background',toolHistoryVerified:false,
        prompt:request.prompt,referencePaths:request.referencePaths,baseGenerationId:base.id}};
    await primeBackgroundRecord(j,state,record,id=>matteBase(j,state,id));
    matteCAS(j,captured);
    verifyBackgroundRecord(j,generationState(j),record,id=>matteBase(j,generationState(j),id));
    state.outputs.push(record);state.composite=undefined;atomic(statePath(j),state);
    return {...record,generationId:id,note:'明确派生背景：独立确认的可见背景像素保留，其余来自本job真实生成补全。保证仅文件空间，不自动证明选区语义、接缝、PS放置或整图一致性。'};
  }
  const r = state.outputs.find((r) => r.id === input.generationId);
  if (!r) throw new Error('生成登记不存在');
  registeredGeneration(j, r.id, r.sourceLayerIds, r.frame);
  if (input.action === 'align' || input.action === 'auto-align') {
    if (r.kind === 'native-geometry') throw opticalPartError('原生实体几何已在事前冻结位置渲染，不能用生图定位重写证明；修正须新任务冻结计划');
    if (r.kind === 'derived-packed-alpha') throw new Error('双板派生保持完整板面冻结位置；不能重新裁切、配准或改alpha');
    if (r.kind === 'native-text') throw new Error('原生文字位置已按冻结字形框渲染，不能用生图定位重写字体证明；修正须新任务冻结计划');
    if(r.kind==='derived-background')throw new Error('派生背景必须保持完整原位置；不能align/retarget丢弃像素保护绑定');
    if (r.kind === 'derived-alpha') throw new Error('派生matte不能align/retarget后丢弃蒙版；请先定位RGB基底，再重新prepare/register/derive');
    const request = state.requests.find((q) => q.id === r.requestId)!;
    // Black is neutral in screen compositing, so its complete opaque carrier
    // can use measured frozen landmarks. Automatic matching is still limited
    // to transparent foregrounds until screen reference matching is validated.
    if (request.background || r.isolationProblem ||
        (input.action === 'auto-align' && request.surface === 'screen'))
      if (input.action === 'auto-align')
        return {
          applied: false,
          reason: request.surface === 'screen'
            ? 'screen光效暂不自动匹配；请使用原参考中的冻结定位点手工校正。'
            : '自动定位仅用于已分离的透明前景；当前层保持原位置。',
          record: r,
        };
      else throw new Error('定位点修正仅用于已分离的透明前景或独立screen光效，背景须重新生成补全');
    let points: { source: [number, number]; target: [number, number] }[];
    let observation: string;
    let automatic: GenerationRecord['autoAlignment'];
    if (input.action === 'auto-align') {
      if (!request.localPath)
        return {
          applied: false,
          reason: '没有可验证坐标的干净局部参考，不猜测对应关系。',
          record: r,
        };
      const evidencePath = path.join(path.dirname(r.originalPath), `registration-${uid()}.json`);
      let searchBox:[number,number,number,number]|undefined;
      if(request.contourSearch){
        const entry=j.type==='photoshop'?psPlan?.layers.find(l=>l.layerId===r.sourceLayerIds[0]):state.layout?.layers.find(l=>JSON.stringify(l.sourceLayerIds)===JSON.stringify(r.sourceLayerIds));
        if(JSON.stringify(entry?.contourSearch)!==JSON.stringify(request.contourSearch))throw new Error('事前轮廓搜索范围已变化，不能按输出重新选择目标');
        const meta=await sharp(fs.readFileSync(request.localPath)).metadata();
        searchBox=contourSearchViewport(request.contourSearch,r.frame,[meta.width!,meta.height!]);
      }
      const outcome = await registrationProposal(r.originalPath, request.localPath, evidencePath,searchBox);
      if (!outcome.available) return { applied: false, ...outcome, record: r };
      const proposal = outcome.proposal;
      if (
        hash(r.originalPath) !== r.hash ||
        hash(request.localPath) !==
          (request.localReferenceHash || request.referenceHashes[request.referencePaths.indexOf(request.localPath)])
      )
        throw new Error('自动定位期间原件或参考发生改变，未应用测量结果');
      if (!proposal.accepted || !proposal.points?.length)
        return { applied: false, reason: proposal.reason, proposal, evidencePath, record: r };
      // Clean local crops use input-image pixels. Restore the frozen output
      // canvas scale, allowing only integer crop rounding, never anisotropic fit.
      const [rw, rh] = proposal.referenceSize;
      if (rw <= 0 || rh <= 0 || aspectError({ width: rw, height: rh }, r.frame) > 0.01)
        return {
          applied: false,
          reason: '参考画幅比例与冻结框不一致，不自动换算。',
          proposal,
          record: r,
        };
      const factor = (rw * r.frame.width + rh * r.frame.height) / (rw * rw + rh * rh);
      let fitPoints;
      try { fitPoints = registrationFitPoints(proposal); }
      catch (error) { return { applied: false, reason: error instanceof Error ? error.message : String(error),
        proposal, evidencePath, record: r }; }
      points = fitPoints.map((p) => ({
          source: p.source,
          target: [p.target[0] * factor, p.target[1] * factor],
        }));
      automatic = {
        proposal,
        sourceHash: r.hash,
        referencePath: request.localPath,
        referenceHash: hash(request.localPath),
        referenceToFrameScale: factor,
        evidencePath,
        evidenceHash: hash(evidencePath),
      };
      observation =
        '基于干净参考和生成原件的互相唯一特征对应，仅统一正比例与平移；几何置信不代表语义或外观通过。';
    } else {
      points = input.points;
      observation = input.observation;
    }
    if (input.action === 'align' && j.reconstructionWorkflowVersion === 4) {
      if (
        !input.anchorNames ||
        input.anchorNames.length !== input.points.length ||
        new Set(input.anchorNames).size !== input.anchorNames.length
      )
        throw new Error('定位须逐一引用生成前冻结的anchorNames，不能临时移动参考目标来满足限制');
      for (let i = 0; i < input.points.length; i++) {
        const a = request.anchors?.find((a) => a.name === input.anchorNames![i]);
        if (
          !a ||
          Math.hypot(
            input.points[i].target[0] - (a.point[0] - r.frame.x),
            input.points[i].target[1] - (a.point[1] - r.frame.y),
          ) > 1
        )
          throw new Error('目标点必须等于原参考中的冻结坐标；需要新目标应修改画布后发起新任务');
      }
    }
    let aligned;
    try {
      aligned = await alignGeneration(fs.readFileSync(r.originalPath), r.frame, points,
        request.referenceContext ? sourceAnchorFrame(r.frame, request.referenceContext.carrierFrame, request.canvas) : undefined);
    } catch (error) {
      if (input.action === 'auto-align')
        return {
          applied: false,
          reason: error instanceof Error ? error.message : String(error),
          proposal: automatic?.proposal,
          record: r,
        };
      throw error;
    }
    const work = path.join(path.dirname(r.originalPath), `aligned-${uid()}.png`);
    fs.writeFileSync(work, aligned.bytes);
    r.workingPath = work;
    r.workingHash = hash(work);
    r.workingSize = aligned.size;
    r.isolationPreviews = await writeIsolationPreviews(
      aligned.bytes, path.dirname(work), request.surface === 'screen' ? 'screen' : 'normal',
    );
    const { bytes, ...geometry } = aligned;
    r.alignment = { ...geometry, observation };
    r.autoAlignment = automatic;
    r.placementFrame = aligned.placementFrame;
    if (request.alphaChecks?.length) r.alphaDiagnostics = await evaluateGenerationAlphaChecks({
      checks: request.alphaChecks, sourceSize: { width: j.snapshot.width, height: j.snapshot.height },
      canvas: request.canvas, originalHash: r.hash, workingHash: r.workingHash,
      workingPath: r.workingPath, placementFrame: r.placementFrame,
    });
    r.placedPreviewPath = path.join(path.dirname(work), `placed-${uid()}.png`);
    const comparisonView = comparisonContract(request);
    fs.writeFileSync(
      r.placedPreviewPath,
      await placementPreview(aligned.bytes, r.placementFrame, comparisonView.comparisonFrame),
    );
    const compare = await comparisonPanels(
      comparisonView.comparisonReferencePath,
      r.placedPreviewPath,
      path.join(path.dirname(work), `compare-${uid()}.png`),
    );
    r.comparisonPath = compare.path;
    r.comparisonHash = compare.hash;
    r.comparisonFrame = comparisonView.comparisonFrame;
    r.comparisonReferencePath = comparisonView.comparisonReferencePath;
    r.review = undefined;
    r.elements = undefined;
    r.reviewEvidence = undefined;
    invalidateMatteApprovals(state, r.id);
    state.composite = undefined;
    atomic(statePath(j), state);
    return input.action === 'auto-align' ? { applied: true, ...r } : r;
  }
  if (input.comparisonHash !== r.comparisonHash || hash(r.comparisonPath) !== r.comparisonHash)
    throw new Error('对比证据已变化');
  const request = state.requests.find((q) => q.id === r.requestId)!;
  const priorReview = JSON.stringify([r.review, r.elements, r.reviewEvidence]);
  if (j.reconstructionWorkflowVersion === 4) {
    const evidence = input.evidence;
    if (!evidence)
      throw new Error(
        '需分别记录位置/大小、外观、物体分离的实测观察及真实candidateIds，不能使用一句模板通过',
      );
    if (new Set([evidence.geometry, evidence.appearance, evidence.isolation]).size !== 3)
      throw new Error('三项检查不能复制同一句话；分别描述本层实际差异');
    if (
      !evidence.candidateIds.includes(r.id) ||
      new Set(evidence.candidateIds).size !== evidence.candidateIds.length ||
      evidence.candidateIds.some(
        (id) =>
          !state.outputs.some(
            (o) =>
              o.id === id &&
              JSON.stringify(o.sourceLayerIds) === JSON.stringify(r.sourceLayerIds) &&
              JSON.stringify(o.frame) === JSON.stringify(r.frame),
          ),
      )
    )
      throw new Error('candidateIds须引用同层真实登记候选，包含当前选择；API失败不能计作纠正结果');
    // A failed correction must not force a paid regeneration merely to satisfy
    // a candidate-count gate. Keep the real selected file and honest issues;
    // candidate IDs still cannot refer to nonexistent or unrelated outputs.
    if (
      input.review.status === 'needs-revision' &&
      !r.isolationProblem &&
      (!r.alphaDiagnostics || r.alphaDiagnostics.passed) &&
      input.elements.every((e) => e.status === 'matched')
    )
      throw new Error(
        '仍有外观或位置问题时，应在对应元素注明different/missing，不能全部填写matched',
      );
    const generic = /逐项核对参考.*无明显|内容与目标一致.*未见缺失|测试夹具一致/;
    if (
      input.elements.some((e) => generic.test(e.observation)) ||
      (input.elements.length > 1 &&
        new Set(input.elements.map((e) => e.observation)).size !== input.elements.length)
    )
      throw Object.assign(new Error('元素检查存在重复模板，请描述每个实际元素的形状、相对位置或差异'), { status: 400 });
    r.reviewEvidence = evidence;
  }
  if (
    input.elements.length !== request.elements.length ||
    new Set(input.elements.map((e) => e.name)).size !== request.elements.length ||
    request.elements.some((e) => !input.elements.some((v) => v.name === e))
  )
    throw new Error('逐项检查必须覆盖准备时的全部元素，不能遗漏图标、文字或装饰');
  if (
    input.review.status === 'accepted' &&
    (r.isolationProblem ||
      (!r.alignment && r.aspectError > ASPECT_TOLERANCE + 1e-12) ||
      input.elements.some((e) => e.status !== 'matched'))
  )
    throw new Error('比例明显偏离、缺失或不同的元素不能标为通过；先纠正，仍不理想时标红并继续');
  if (input.review.status === 'accepted' && r.alphaDiagnostics && !r.alphaDiagnostics.passed)
    throw new Error(`区域alpha检查未通过，不能标为accepted：${r.alphaDiagnostics.checks.filter(c => !c.passed).map(c => c.name).join('；')}；可继续定位或如实needs-revision`);
  r.review = input.review;
  r.elements = input.elements;
  if (state.composite && priorReview !== JSON.stringify([r.review, r.elements, r.reviewEvidence]))
    state.composite.review = undefined;
  atomic(statePath(j), state);
  return r;
}
