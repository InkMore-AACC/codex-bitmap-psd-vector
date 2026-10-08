import fs from 'node:fs';
import { validateNativeGeometryRecipe } from '../shared/native-geometry.js';
import { canvasBlend } from '../shared/blend.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { generationLayoutSchema, type GenerationAlphaCheck } from '../shared/generation.js';
import type { z } from 'zod';
import type { Job } from './types.js';
import { registeredGeneration, type GenerationRecord, type GenerationState } from './generation.js';
import { assetPath, dir, uid } from './store.js';
import { derivedWorkingSnapshot, assertNotGeneratedRoleAlias } from './generation-matte.js';
import {
  filePlacement,
  restoreGeneration,
  GENERATION_RENDER_VERSION,
} from './generation-placement.js';
import { layerFrame, unionFrames, scaledFrame } from '../shared/layer-frame.js';
import { validateAlphaCheckScope } from './generation-alpha-checks.js';
import { aspectError } from '../shared/generation-geometry.js';
import { validateBackgroundProtectionRoute } from './generation-background.js';
import { validateNativeTextRecipe } from './native-text-renderer.js';
import { validateOpticalParts } from '../shared/optical-parts.js';
import { ordinaryOpticalMembers } from './optical-parts.js';
import { contourSearchViewport } from '../shared/contour-search.js';
export type GenerationLayout = z.infer<typeof generationLayoutSchema>;
export const fileDigest = (p: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

type EvidenceFile = { path: string; hash: string };
export type CompositeEvidence = {
  path: string;
  hash: string;
  comparisonPath: string;
  comparisonHash: string;
  generationIds: string[];
  signature: string;
  referencePath?: string;
  referenceHash?: string;
  details?: {
    generationId: string;
    sourceLayerIds: string[];
    frame: { x: number; y: number; width: number; height: number };
    reference: EvidenceFile;
    result: EvidenceFile;
  }[];
  complete: boolean;
  missing: string[];
  relations: GenerationLayout['relations'];
  note: string;
};

function evidenceFilesUnchanged(c: CompositeEvidence) {
  const files = [
    { path: c.path, hash: c.hash },
    { path: c.comparisonPath, hash: c.comparisonHash },
    ...(c.details || []).flatMap((d) => [d.reference, d.result]),
  ];
  return files.every((f) => fs.existsSync(f.path) && fileDigest(f.path) === f.hash);
}

export function validateOpaqueCheckRoute(j: Job, ids: string[], blendMode: string | undefined,
  checks: GenerationAlphaCheck[] | undefined) {
  if (checks?.some(c => c.kind === 'occupied') && (j.reconstructionVersion !== 3 ||
      j.reconstructionWorkflowVersion !== 4 || !['layer', 'revise', 'photoshop'].includes(j.type) ||
      (blendMode || 'normal') !== 'normal' ||
      ids.some(id => j.snapshot.layers.find(l => l.id === id)?.role === 'background')))
    throw new Error('occupied内容覆盖下限仅支持新v4 normal透明前景，背景、screen及旧流程不支持');
  if (checks?.some(c => c.kind === 'opaque') && (j.reconstructionVersion !== 3 ||
      j.reconstructionWorkflowVersion !== 4 || !['layer', 'revise'].includes(j.type) ||
      (blendMode || 'normal') !== 'normal' ||
      ids.some(id => j.snapshot.layers.find(l => l.id === id)?.role === 'background')))
    throw new Error('opaque区域alpha下限仅支持新普通v4 normal透明前景，PS、screen、背景及旧流程不支持');
}
export function validateLayout(j: Job, layout: GenerationLayout) {
  validateOpticalParts(ordinaryOpticalMembers(j, layout), layout.relations);
  for(const l of layout.layers)if(l.contourSearch){
    if(j.reconstructionVersion!==3 || j.reconstructionWorkflowVersion!==4 || !['layer','revise'].includes(j.type) ||
      l.sourceLayerIds.length!==1 || l.opticalPart?.version!==2 || l.opticalPart.kind!=='opaque-structure' ||
      (l.blendMode||'normal')!=='normal' || l.nativeText || l.nativeGeometry || l.content || l.allowAuxMatte || l.sourceProtection)
      throw new Error('轮廓搜索范围仅支持新v4单层normal独立v2实体分件，不能用于文字原生、薄膜、背景或光效');
    const member=j.snapshot.layers.find(s=>s.id===l.sourceLayerIds[0]);if(!member)throw new Error('搜索来源层不存在');
    const frame=scaledFrame(layerFrame(member,j.snapshot),(layout.width||j.snapshot.width)/j.snapshot.width,(layout.height||j.snapshot.height)/j.snapshot.height);
    contourSearchViewport(l.contourSearch,frame,[frame.width,frame.height]);
  }
  for (const l of layout.layers) if (l.packedBackdrop) {
    if (!['layer', 'revise'].includes(j.type) || j.reconstructionVersion !== 3 ||
        j.reconstructionWorkflowVersion !== 4 || l.sourceLayerIds.length !== 1 ||
        (l.blendMode || 'normal') !== 'normal' || l.content || l.nativeText || l.sourceProtection ||
        l.allowAuxMatte || l.matteBackdrop ||
        j.snapshot.layers.find(s => s.id === l.sourceLayerIds[0])?.role === 'background' ||
        !l.alphaChecks?.some(c => c.kind === 'clear') || !l.alphaChecks.some(c => c.kind === 'transmissive') ||
        !l.alphaChecks.some(c => c.kind === 'occupied' || c.kind === 'opaque'))
      throw new Error('单次双板仅支持新普通v4单层normal透明前景；事前冻结clear/transmissive/occupied，不与旧matte/文字/背景/光效混用');
  }
  for (const l of layout.layers) if (l.matteBackdrop && (!l.allowAuxMatte || l.nativeText ||
      l.sourceProtection || l.content || (l.blendMode || 'normal') !== 'normal' || !l.alphaChecks?.some(c => c.kind === 'clear')))
    throw new Error('已知RGB底色实验须事前冻结allowAuxMatte、clear和transmissive区域；不与文字/背景/光效混用');
  for (const l of layout.layers) if (l.matteBackdrop?.version === 2 && !l.alphaChecks?.some(c => c.kind === 'occupied' || c.kind === 'opaque'))
    throw new Error('双背景实验须事前冻结固有深色印字/实体的occupied或opaque覆盖区域，不能以颜色亮度替代覆盖');
  for (const l of layout.layers) if (l.nativeText) {
    if (!['layer', 'revise'].includes(j.type) || j.reconstructionVersion !== 3 ||
        j.reconstructionWorkflowVersion !== 4 || l.sourceLayerIds.length !== 1 ||
        (l.blendMode || 'normal') !== 'normal' || l.content || l.allowAuxMatte || l.sourceProtection ||
        j.snapshot.layers.find(s => s.id === l.sourceLayerIds[0])?.role === 'background')
      throw new Error('原生字体实验仅支持新普通v4单层normal透明前景，不用于PS、背景、光效或辅助matte');
    const member = j.snapshot.layers.find(s => s.id === l.sourceLayerIds[0]);
    if (!member) throw new Error('原生文字来源层不存在');
    const canvas = { width: layout.width || j.snapshot.width, height: layout.height || j.snapshot.height };
    validateNativeTextRecipe(l.nativeText, scaledFrame(layerFrame(member, j.snapshot),
      canvas.width / j.snapshot.width, canvas.height / j.snapshot.height));
  }
  for (const l of layout.layers) if (l.nativeGeometry) {
    if (!['layer','revise'].includes(j.type) || j.reconstructionVersion!==3 || j.reconstructionWorkflowVersion!==4 ||
        l.sourceLayerIds.length!==1 || (l.blendMode||'normal')!=='normal' || l.opticalPart?.version!==2 ||
        l.opticalPart.kind!==(l.nativeGeometry.version>=2?'thin-film':'opaque-structure') ||
        l.nativeGeometry.version>=2 && (!l.alphaChecks?.some(c=>c.kind==='clear') || !l.alphaChecks.some(c=>c.kind==='transmissive')) ||
        l.nativeText || l.content || l.allowAuxMatte || l.matteBackdrop ||
        l.packedBackdrop || l.sourceProtection || l.contourSearch ||
        j.snapshot.layers.find(s=>s.id===l.sourceLayerIds[0])?.role!=='foreground')
      throw new Error('原生几何仅支持新普通v4单层normal独立v2光学分件：配方v1实体、v2/v3带clear/transmissive检查的连续薄膜；不与字体、背景、光效或辅助载体混用');
    const member=j.snapshot.layers.find(s=>s.id===l.sourceLayerIds[0])!;
    validateNativeGeometryRecipe(l.nativeGeometry,scaledFrame(layerFrame(member,j.snapshot),
      (layout.width||j.snapshot.width)/j.snapshot.width,(layout.height||j.snapshot.height)/j.snapshot.height));
  }
  if(layout.layers.filter(l=>l.sourceProtection).length>1)throw new Error('本任务仅允许一个满幅背景保护组');
  for(const l of layout.layers)if(l.sourceProtection) {
    if(l.allowAuxMatte || l.alphaChecks?.length || l.content)throw new Error('背景保护不能与透明matte、区域alpha或独立光效路线混用');
    validateBackgroundProtectionRoute(j,l.sourceLayerIds,l.sourceProtection,
      {width:layout.width||j.snapshot.width,height:layout.height||j.snapshot.height},
      unionFrames(l.sourceLayerIds.map(id=>layerFrame(j.snapshot.layers.find(s=>s.id===id)!,j.snapshot))),
      (l.blendMode||'normal')==='normal');
  }
  for (const l of layout.layers) validateOpaqueCheckRoute(j, l.sourceLayerIds, l.blendMode, l.alphaChecks);
  for (const l of layout.layers) {
    if (l.blendMode === 'screen' && l.content !== 'light-effect')
      throw new Error('screen仅适用于明确声明content=light-effect的独立光效');
    if (l.blendMode === 'screen' && l.sourceLayerIds.some(id => j.snapshot.layers.find(s => s.id === id)?.role === 'background'))
      throw new Error('背景层不能声明为screen光效');
  }
  const targets = j.snapshot.layers
    .filter((l) => !j.layerIds?.length || j.layerIds.includes(l.id))
    .map((l) => l.id);
  const ids = layout.layers.flatMap((l) => l.sourceLayerIds);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== targets.length ||
    targets.some((id) => !ids.includes(id))
  )
    throw new Error('元素归属计划须恰好覆盖本次目标层；合并列全来源ID，不重做保留层');
  if ((layout.width === undefined) !== (layout.height === undefined))
    throw new Error('总图尺寸须同时提供宽高');
  if (
    layout.width &&
    layout.height &&
    aspectError({ width: layout.width, height: layout.height }, j.snapshot) > 0.01
  )
    throw new Error('总图尺寸仅允许等比例换算，不能分别拉伸图层宽高');
  for (const l of layout.layers) if (l.alphaChecks?.length) {
    if (j.reconstructionWorkflowVersion !== 4 || j.type === 'photoshop' || l.blendMode === 'screen' ||
        l.sourceLayerIds.some(id => j.snapshot.layers.find(s => s.id === id)?.role === 'background'))
      throw new Error('区域alpha检查仅用于普通v4的normal透明前景，不能用于背景、screen或原生PS');
    const owner = unionFrames(l.sourceLayerIds.map(id => layerFrame(j.snapshot.layers.find(s => s.id === id)!, j.snapshot)));
    validateAlphaCheckScope(l.alphaChecks, j.snapshot, owner);
  }
  for (const l of layout.layers) if (l.allowAuxMatte) {
    if (j.reconstructionVersion !== 3 || j.reconstructionWorkflowVersion !== 4 || !['layer', 'revise'].includes(j.type) ||
      l.sourceLayerIds.length !== 1 || l.blendMode === 'screen' ||
      j.snapshot.layers.find(s => s.id === l.sourceLayerIds[0])?.role === 'background' ||
      !l.alphaChecks?.some(c => c.kind === 'transmissive'))
      throw new Error('aux-matte仅支持显式启用且有transmissive检查的普通v4单层normal透明材质；PS不支持');
  }
  const names = layout.layers.flatMap((l) => l.elements.map((e) => e.trim().toLowerCase()));
  if (new Set(names).size !== names.length)
    throw new Error('同一元素只能归属一个图层；重复外观请用位置命名，背景不得重复前景光效');
  if (new Set(layout.relations.map((r) => r.id)).size !== layout.relations.length)
    throw new Error('层间关系ID重复');
  for (const r of layout.relations)
    if (
      new Set(r.layerIds).size !== r.layerIds.length ||
      r.layerIds.some((id) => !j.snapshot.layers.some((l) => l.id === id))
    )
      throw new Error('接触/遮挡关系引用了未知图层');
  for (const l of layout.layers)
    if (new Set(l.anchors.map((a) => a.name)).size !== l.anchors.length)
      throw new Error('定位点名称重复');
  return layout;
}

export function compositeSignature(j: Job, records: GenerationRecord[], state: GenerationState) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        renderVersion: GENERATION_RENDER_VERSION,
        layout: state.layout,
        version: j.version,
        layers: [...records]
          .sort(
            (a, b) =>
              j.snapshot.layers.findIndex((l) => a.sourceLayerIds.includes(l.id)) -
              j.snapshot.layers.findIndex((l) => b.sourceLayerIds.includes(l.id)),
          )
          .map((r) => ({
            id: r.id,
            hash: r.workingHash,
            // Preserve pre-screen normal review signatures; screen changes the rendered pixels.
            ...(r.blendMode === 'screen' ? { blendMode: 'screen' } : {}),
            placement: r.placementFrame || r.frame,
            ...(r.alphaDiagnostics ? { alphaDiagnosticsSignature: r.alphaDiagnostics.signature } : {}),
            ...(r.derivedAlpha ? { derivedAlpha: r.derivedAlpha, receipt: r.receipt } : {}),
            ...(r.derivedBackground ? { derivedBackground: r.derivedBackground, receipt:r.receipt } : {}),
            ...(r.kind === 'native-text' ? { kind: r.kind, nativeTextProof: r.nativeTextProof, receipt: r.receipt } : {}),
            ...(r.kind === 'native-geometry' ? { kind: r.kind, nativeGeometryProof: r.nativeGeometryProof, receipt: r.receipt } : {}),
            ...(r.backgroundPadding ? {
              backgroundPadding: r.backgroundPadding, backgroundOpacity: r.backgroundOpacity,
            } : {}),
          })),
        kept: j.snapshot.layers.filter((l) => j.layerIds?.length && !j.layerIds.includes(l.id)),
      }),
    )
    .digest('hex');
}

export async function renderGenerationComposite(
  j: Job,
  state: GenerationState,
  ids: string[],
  compare: (a: string, b: string, o: string) => Promise<{ path: string; hash: string }>,
  detailIds: string[] = [],
): Promise<CompositeEvidence> {
  if (j.type === 'photoshop') throw new Error('PS整图检查使用canvas_ps_rebuild inspect真实渲染');
  if (!state.layout) throw new Error('先提交元素归属与接触/遮挡计划');
  const records = ids.map((id) => state.outputs.find((r) => r.id === id));
  if (records.some((r) => !r) || new Set(ids).size !== ids.length)
    throw new Error('合成引用了不存在或重复的候选');
  if (detailIds.some((id) => !ids.includes(id)) || new Set(detailIds).size !== detailIds.length)
    throw new Error('局部检查只能引用本次合成中的候选，且不能重复');
  const rs = records as GenerationRecord[],
    used = rs.flatMap((r) => r.sourceLayerIds);
  if (new Set(used).size !== used.length) throw new Error('合成中同一来源层出现多个候选');
  for (const r of rs) {
    if (fileDigest(r.workingPath) !== r.workingHash) throw new Error('候选文件已改变');
    const entry = state.layout.layers.find(l => JSON.stringify(l.sourceLayerIds) === JSON.stringify(r.sourceLayerIds));
    if(entry?.sourceProtection && r.kind!=='derived-background')throw new Error('背景保护计划的合成必须使用明确派生结果，原始补全候选仅用于单层诊断');
    if ((entry?.blendMode || 'normal') !== (r.blendMode || 'normal'))
      throw new Error('候选混合模式与冻结layout不一致');
  }
  const reference = assetPath(
    j.documentId,
    j.snapshot.status === 'preview' ? j.snapshot.source : j.snapshot.url || j.snapshot.source,
  );
  const referenceHash = fileDigest(reference);
  const signature = compositeSignature(j, rs, state);
  // A repeated checkpoint with the same inputs is not new visual evidence. Keep
  // both existing files and approval rather than rendering and invalidating it.
  if (
    state.composite?.signature === signature &&
    state.composite.referenceHash === referenceHash &&
    detailIds.every((id) => state.composite!.details?.some((d) => d.generationId === id)) &&
    evidenceFilesUnchanged(state.composite)
  )
    return state.composite;
  const width = state.layout.width || j.snapshot.width,
    height = state.layout.height || j.snapshot.height;
  if (width * height > 40_000_000) throw new Error('合成超过4000万像素');
  // Keep the real canvas resolution for final inspection. The overview is only
  // navigation; shrinking all text to a 512px poster concealed visible defects.
  const scale = 1,
    c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  const drawn = new Set<string>();
  for (const l of j.snapshot.layers) {
    const r = rs.find((r) => r.sourceLayerIds.includes(l.id));
    if (r) {
      if (drawn.has(r.id)) continue;
      drawn.add(r.id);
      const frame = r.placementFrame || filePlacement(r.workingSize, r.frame);
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = canvasBlend(r.blendMode);
      if (l.visible) {
        const material = await restoreGeneration(derivedWorkingSnapshot(r), frame, r.backgroundPadding);
        ctx.drawImage(
          await loadImage(material.bytes),
          frame.x * scale,
          frame.y * scale,
          frame.width * scale,
          frame.height * scale,
        );
      }
    } else if (j.layerIds?.length && !j.layerIds.includes(l.id) && !l.preview && l.visible) {
      const f = l.previewUrl
        ? { x: 0, y: 0, width, height }
        : scaledFrame(l, width / j.snapshot.width, height / j.snapshot.height);
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = canvasBlend(l.blendMode);
      ctx.drawImage(
        await loadImage(fs.readFileSync(assetPath(j.documentId, l.previewUrl || l.url))),
        f.x * scale,
        f.y * scale,
        f.width * scale,
        f.height * scale,
      );
    }
  }
  const folder = path.join(dir(j.documentId), 'jobs', j.id, 'generation', 'composites');
  fs.mkdirSync(folder, { recursive: true });
  const p = path.join(folder, uid() + '.png');
  fs.writeFileSync(p, c.toBuffer('image/png'));
  const comparison = await compare(reference, p, path.join(folder, uid() + '-comparison.png'));
  const referenceImage = await loadImage(fs.readFileSync(reference));
  const details = [];
  for (const r of rs.filter((r) => detailIds.includes(r.id))) {
    // Inspect the assembled result, not a cutout preview. Clip inspection only
    // to the document viewport; the actual off-canvas layer remains intact.
    const x = Math.max(0, Math.floor(r.frame.x)),
      y = Math.max(0, Math.floor(r.frame.y));
    const w = Math.min(width, Math.ceil(r.frame.x + r.frame.width)) - x;
    const h = Math.min(height, Math.ceil(r.frame.y + r.frame.height)) - y;
    if (w <= 0 || h <= 0) continue;
    const crop = createCanvas(w, h),
      cx = crop.getContext('2d');
    cx.drawImage(
      referenceImage,
      0,
      0,
      referenceImage.width,
      referenceImage.height,
      -x,
      -y,
      width,
      height,
    );
    const referencePath = path.join(folder, uid() + '-reference-detail.png');
    fs.writeFileSync(referencePath, crop.toBuffer('image/png'));
    cx.clearRect(0, 0, w, h);
    cx.drawImage(c, -x, -y);
    const resultPath = path.join(folder, uid() + '-result-detail.png');
    fs.writeFileSync(resultPath, crop.toBuffer('image/png'));
    details.push({
      generationId: r.id,
      sourceLayerIds: r.sourceLayerIds,
      frame: { x, y, width: w, height: h },
      reference: { path: referencePath, hash: fileDigest(referencePath) },
      result: { path: resultPath, hash: fileDigest(resultPath) },
    });
  }
  const missing = state.layout.layers
    .filter((l) => !l.sourceLayerIds.every((id) => used.includes(id)))
    .flatMap((l) => l.sourceLayerIds);
  return {
    path: p,
    hash: fileDigest(p),
    comparisonPath: comparison.path,
    comparisonHash: comparison.hash,
    generationIds: ids,
    signature,
    referencePath: reference,
    referenceHash,
    details,
    complete: missing.length === 0,
    missing,
    relations: state.layout.relations,
    note: '这是实际坐标与原尺寸的当前合成；小字/细节可通过detailGenerationIds按需导出原尺寸参考与合成局部，不能只看缩略总览。相关层成组核对接触/遮挡；独立层可先执行。未生成层保持空白；差异图与文字自评不构成自动视觉评分。',
  };
}

export function requireCompositeApproval(j: Job, generationIds: string[], state: GenerationState) {
  if (j.reconstructionWorkflowVersion !== 4) return;
  const c = state.composite,
    records = generationIds.map((id) => state.outputs.find((r) => r.id === id)!);
  for (const r of records) if (r && !r.kind && !r.derivedAlpha && !r.derivedBackground && r.receipt.tool === 'image_gen')
    assertNotGeneratedRoleAlias(state, [r.outputPath, r.originalPath, r.workingPath], [r.hash, r.workingHash]);
  for (const r of records) if (r?.kind === 'matte-rgb-base' || state.requests.find(q => q.id === r?.requestId)?.matteBackdrop ||
      state.layout?.layers.find(l => JSON.stringify(l.sourceLayerIds) === JSON.stringify(r?.sourceLayerIds))?.matteBackdrop ||
      r?.kind === 'derived-packed-alpha' || r?.packedAlpha || r?.kind === 'native-text' || r?.kind === 'native-geometry' || r?.nativeGeometryProof || r?.kind === 'derived-alpha' || r?.derivedAlpha || r?.kind==='derived-background' || r?.derivedBackground ||
      state.requests.find(q => q.id === r?.requestId)?.role === 'native-text')
    registeredGeneration(j, r.id, r.sourceLayerIds, r.frame);
  if (
    !c?.complete ||
    !c.review ||
    records.some((r) => !r) ||
    JSON.stringify([...c.generationIds].sort()) !== JSON.stringify([...generationIds].sort()) ||
    c.signature !== compositeSignature(j, records, state) ||
    records.some(
      (r) => !fs.existsSync(r.workingPath) || fileDigest(r.workingPath) !== r.workingHash,
    ) ||
    (c.referenceHash !== undefined &&
      (!c.referencePath || fileDigest(c.referencePath) !== c.referenceHash)) ||
    !evidenceFilesUnchanged(c)
  )
    throw new Error(
      '最终合成尚未核对或素材已改变；先composite及review-composite，不能仅凭逐层通过创建结果',
    );
}
