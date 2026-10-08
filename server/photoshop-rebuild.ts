import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { readPsd } from 'ag-psd';
import { z } from 'zod';
import {
  photoshopActionSchema,
  photoshopPlanSchema,
  photoshopSettingsSchema,
  photoshopGroupName,
  photoshopMaterialTarget,
  isPhotoshopFullBackground,
  type PhotoshopPlan,
} from '../shared/photoshop.js';
import type { LayerReview } from '../shared/layer-review.js';
import { layerFrame, scaledFrame } from '../shared/layer-frame.js';
import { aspectError, fitGeometry, generationPlan } from '../shared/generation-geometry.js';
import { upscaleSchema } from '../shared/upscale.js';
import type { Job, CanvasImage, Layer } from './types.js';
import { dir, json, atomic, assetPath, writeAsset, uid, getJob } from './store.js';
import { worker } from './models.js';
import { rejectPreviewReuse } from './reconstruction-inputs.js';
import { applyLayerReviews } from './layer-review.js';
import {
  renderNativePsd,
  validateNativeStructure,
  assertNotWholeOriginal,
  nativeTextReport,
  nativeProgressLayers,
  fileHash,
  taskPsd,
  verifyMaterialPlacement,
  type NativeRender,
} from './photoshop-native.js';
import type { AdobeConnector } from './adobe.js';
import { validateOpticalParts, opticalPartError } from '../shared/optical-parts.js';
import { contourSearchViewport } from '../shared/contour-search.js';
import { photoshopOpticalMembers } from './optical-parts.js';
import { renderNativeFilm, validateNativeFilmEntry, verifyNativeFilmGroup } from './photoshop-film.js';
import { renderNativeGeometry, validateNativeGeometryEntry, verifyNativeGeometryGroup } from './photoshop-geometry.js';
import { renderNativeTextPlane, validateNativeTextPlaneEntry, verifyNativeTextPlaneGroup } from './photoshop-plane-text.js';
import {
  alphaMetrics,
  requireIsolatedSurface,
  checkEvidence,
  rejectReferenceCrop,
  inspectRenderedIsolation,
  verifyPreservedLayers,
} from './photoshop-quality.js';
import { fitNativeText } from './photoshop-text.js';
import { placeNativeMaterial } from './photoshop-placement.js';
import {
  derivePhotoshopRepair,
  photoshopRepairError,
  verifyPhotoshopRepair,
  type PhotoshopRepairRecord,
} from './photoshop-repair-provenance.js';
import { registeredGeneration, budgetWorkingCopy, comparisonPanels, generationState, prepareGeneratedRoleConsumer } from './generation.js';
import { validateBackgroundProtectionRoute, preflightBackgroundSelection, requireDerivedBackgroundReview } from './generation-background.js';
import { originalReference } from './references.js';
import { reconstructionCrops } from './reconstruction-crops.js';
import { PHOTOSHOP_WORKFLOW } from '../shared/photoshop-policy.js';
import type { PlacementFrame } from './generation-placement.js';
import { scopedAdobePath } from './adobe.js';
import {
  extractionSources,
  extractionPlanHash,
  verifyPhotoshopExtraction,
  type PhotoshopExtractionBinding,
} from './photoshop-extraction-provenance.js';
import {
  capturePhotoshopAlphaContext,
  inspectPhotoshopAlphaChecks,
  verifyPhotoshopAlphaChecks,
  requirePhotoshopAlphaPassed,
  validatePhotoshopAlphaCheckScope,
  type PhotoshopAlphaDiagnostic,
} from './photoshop-alpha-checks.js';
import { mappedAlphaChecks } from './generation-alpha-checks.js';

type Material = {
  path: string;
  hash: string;
  provenance: string;
  observation: string;
  status: 'processing' | 'ready' | 'failed';
  originalPath: string;
  originalSize: { width: number; height: number };
  workingPath?: string;
  workingSize?: { width: number; height: number };
  generationId?: string;
  repair?: PhotoshopRepairRecord;
  extraction?: PhotoshopExtractionBinding;
  upscaledPath?: string;
  error?: string;
  warning?: string;
  placement?: ReturnType<typeof fitGeometry>;
  originalPlacement?: ReturnType<typeof fitGeometry>;
  choice?: 'upscaled' | 'original';
  receipt?: ReturnType<typeof checkEvidence>;
  isolation?: Awaited<ReturnType<typeof alphaMetrics>>;
  placementFrame?: PlacementFrame;
  upscaleApproved?: boolean;
  needsUpscale?: boolean;
  upscaleEvidence?: { workingHash: string; psdPath: string; psdHash: string };
};
type State = {
  version: 1 | 2;
  plan?: PhotoshopPlan;
  materials: Record<string, Material>;
  nativeFilms?: Record<string, Awaited<ReturnType<typeof renderNativeFilm>>>;
  nativeGeometries?: Record<string, Awaited<ReturnType<typeof renderNativeGeometry>>>;
  nativeTextPlanes?: Record<string, Awaited<ReturnType<typeof renderNativeTextPlane>>>;
  inspection?: NativeRender;
  reviews: Record<string, LayerReview>;
  compositeReview?: string;
  checks?: Record<
    string,
    Extract<z.infer<typeof photoshopActionSchema>, { action: 'review' }>['checks']
  >;
  quality?: {
    alphaDiagnostics?: Record<string, PhotoshopAlphaDiagnostic>;
    comparisons?: Record<string, { path: string; hash: string }>;
    isolation: Awaited<ReturnType<typeof inspectRenderedIsolation>>;
    texts: ReturnType<typeof nativeTextReport>;
    hashes: Record<string, string>;
  };
};
export const photoshopFolder = (j: Job) => path.join(dir(j.documentId), 'jobs', j.id);
const stateFile = (j: Job) => path.join(photoshopFolder(j), 'photoshop-rebuild.json');
export function photoshopState(j: Job): State {
  return json<State>(stateFile(j), { version: 2, materials: {}, reviews: {} });
}
const put = (j: Job, s: State, invalidationOnly=false) => {
  if(!invalidationOnly)try {
    for(const entry of s.plan?.layers||[]) {
      const m=s.materials[entry.layerId];
      if(m?.provenance!=='source-protected'||m.status==='failed')continue;
      const r=registeredGeneration(j,m.generationId,[entry.layerId],entry.frame),p=m.receipt?.declaration.backgroundProtection;
      // An external PS await may have outlived a direct seam-review rejection.
      // Check current approval at the synchronous commit, not only preflight.
      requireDerivedBackgroundReview(generationState(j),r);
      if(r.kind!=='derived-background'||m.path!==m.workingPath||!m.workingPath||fileHash(m.workingPath)!==r.workingHash||
        p?.generationId!==r.id||p?.baseGenerationId!==r.receipt.baseGenerationId||
        JSON.stringify(m.placementFrame)!==JSON.stringify(r.placementFrame))
        throw photoshopRepairError('PS提交前背景保护素材或凭证已变化');
    }
  }catch(e){
    const latest=photoshopState(j),protectedIds=Object.keys(s.materials).filter(id=>s.materials[id].provenance==='source-protected');
    if(JSON.stringify(latest.plan)===JSON.stringify(s.plan)&&protectedIds.every(id=>latest.materials[id]?.generationId===s.materials[id].generationId)) {
      latest.inspection=undefined;latest.reviews={};latest.checks={};latest.compositeReview=undefined;latest.quality=undefined;
      atomic(stateFile(j),latest);
    }
    throw e;
  }
  atomic(stateFile(j),s);
};
const settings = (j: Job) => photoshopSettingsSchema.parse(j.photoshop || {});
// Small budget normalization (e.g. 1000x1500 -> 1024x1536) needs only uniform interpolation.
// Generative SR is reserved for meaningful enlargement unless the caller explicitly requests it.
export const PS_AUTO_UPSCALE_MIN_RATIO = 1.15;
export function needsPhotoshopUpscale(ratio: number, enabled: boolean, preserved = false) {
  return enabled && !preserved && ratio > PS_AUTO_UPSCALE_MIN_RATIO;
}
const live = (j: Job) => {
  if (getJob(j.id).status !== 'running') throw new Error('任务已停止，保留文件但不继续写入结果');
};

export function validatePhotoshopPlan(j: Job, input: unknown) {
  const p = photoshopPlanSchema.parse(input),
    ids = p.layers.map((l) => l.layerId);
  validateOpticalParts(photoshopOpticalMembers(j, p), p.relations);
  for(const l of p.layers)if(l.contourSearch){
    if(j.reconstructionVersion!==3 || j.reconstructionWorkflowVersion!==4 || l.opticalPart?.version!==2 ||
      l.opticalPart.kind!=='opaque-structure' || l.surface!=='transparent' || l.route!=='generate' ||
      !['bitmap','shape'].includes(l.content) || l.nativeFilm || l.nativeGeometry || l.nativeTextPlane || l.sourceProtection)
      throw new Error('PS轮廓搜索范围仅用于新v4生成的独立v2透明实体分件，不用于薄膜/原生文字/背景/光效');
    contourSearchViewport(l.contourSearch,l.frame,[l.frame.width,l.frame.height]);
  }
  p.canvas ??= { width: j.snapshot.width, height: j.snapshot.height };
  if (p.canvas.width * p.canvas.height > 40_000_000)
    throw new Error('PS重建校验支持4000万像素以内');
  if (aspectError(p.canvas, j.snapshot) > 0.01)
    throw new Error('PS画布改尺寸仅允许等比例缩放，不自动裁切或拉伸');
  if (
    j.layerIds?.length &&
    (p.canvas.width !== j.snapshot.width || p.canvas.height !== j.snapshot.height)
  )
    throw new Error('局部PS任务不能改变整图尺寸');
  if (new Set(ids).size !== ids.length) throw new Error('计划中图层 ID 重复');
  validatePhotoshopAlphaCheckScope(j, p);
  if (
    j.snapshot.layers.length &&
    JSON.stringify(ids) !== JSON.stringify(j.snapshot.layers.map((l) => l.id))
  )
    throw new Error('PS 计划必须逐一覆盖冻结图层并保持底到顶顺序；子元素可放在对应 PS 分组内');
  for (const l of p.layers) {
    validateNativeFilmEntry(l);
    validateNativeGeometryEntry(l);
    if (l.nativeGeometry && (j.reconstructionVersion !== 3 || j.reconstructionWorkflowVersion !== 4))
      throw opticalPartError('原生实体几何仅允许事前冻结的新v4任务');
    validateNativeTextPlaneEntry(l);
    if (l.opticalPart?.kind === 'thin-film' && l.route === 'native' && !l.nativeFilm)
      throw opticalPartError('原生薄膜分件须冻结nativeFilm闭合路径与透明渐变，不能只声明native-shape');
    if (j.reconstructionVersion === 3 && !l.elements.length)
      throw new Error('每层须列出elements元素清单，图标、装饰、轮廓和文字不能省略为泛称');
    if (
      j.reconstructionVersion === 3 &&
      l.textTargets.some(
        (t) =>
          !t.appearance ||
          !t.appearance.font ||
          !t.appearance.color ||
          t.appearance.rotation === undefined ||
          !t.appearance.warpStyle,
      )
    )
      throw new Error(
        '每个原生文字目标须记录appearance：实际字体/颜色/角度/斜切/变形/图层样式与观察依据',
      );
    const prior = j.snapshot.layers.find((s) => s.id === l.layerId);
    if (l.route === 'preserve' && j.reconstructionWorkflowVersion === 4) {
      const originalEditable =
        j.snapshot.nativePsd?.mappings.find((m) => m.layerId === l.layerId)?.editable ||
        (prior?.kind === 'text'
          ? 'native-text'
          : prior?.kind === 'vector'
            ? 'native-shape'
            : 'pixels');
      if (l.editable !== originalEditable || l.textTargets.length || l.nativeFallback)
        throw new Error(
          `「${l.name}」preserve只保留现有内容与编辑能力；重建文字或更换素材请明确改为native/generate路线`,
        );
    }
    if (
      prior &&
      JSON.stringify(l.frame) !==
        JSON.stringify(
          scaledFrame(
            layerFrame(prior, j.snapshot),
            p.canvas.width / j.snapshot.width,
            p.canvas.height / j.snapshot.height,
          ),
        )
    )
      throw new Error(`「${l.name}」画幅偏离冻结计划`);
    if (l.route === 'extract' && !settings(j).allowExtraction)
      throw new Error('当前设置不允许原图提取');
    if (l.route !== 'preserve') {
      if (l.surface === 'opaque' && l.content !== 'background')
        throw new Error(
          `「${l.name}」前景须为transparent；黑底滤色仅可用于light，不能用opaque矩形背景拼贴`,
        );
      if (l.surface === 'screen' && l.content !== 'light')
        throw new Error('screen黑底只允许独立光效');
      if (l.content === 'background' && l.route === 'extract')
        throw new Error('背景需移除前景并补全，使用generate/hybrid；不能以原图模糊清理或裁片代替');
      if (l.route === 'native' && l.editable === 'pixels')
        throw new Error(
          'native须有可见PS文字/路径；位图及复杂光效应使用generate/hybrid或真实extract',
        );
      if (l.route === 'native' && l.content === 'bitmap')
        throw new Error('位图物体默认生成，或允许时真实提取；不能用native绘制裁片冒充物体重建');
      if (
        l.content === 'text' &&
        (l.editable === 'native-text' || l.editable === 'mixed') &&
        !l.textTargets.length
      )
        throw new Error('原生文字须声明实际文字层名称、内容和参考字形box；隐藏文字不算完成');
      if (
        l.content === 'text' &&
        !['native-text', 'mixed'].includes(l.editable) &&
        !l.nativeFallback
      )
        throw new Error(
          '一致性优先：文字转像素须记录原生尝试，或基于原参考说明无法原生匹配的具体原因',
        );
      if (l.nativeFallback && !l.nativeFallback.attempts.length) {
        const assessment = l.nativeFallback.assessment;
        const reference = assessment && path.resolve(assessment.referencePath);
        const allowed = [
          assetPath(
            j.documentId,
            j.snapshot.status === 'preview'
              ? j.snapshot.source
              : j.snapshot.url || j.snapshot.source,
          ),
          originalReference(j.documentId, j.snapshot).path,
        ];
        const references = path.join(photoshopFolder(j), 'references');
        if (fs.existsSync(references))
          for (const name of fs.readdirSync(references)) allowed.push(path.join(references, name));
        if (
          !reference ||
          !allowed.some((p) => path.resolve(p).toLowerCase() === reference.toLowerCase()) ||
          !fs.existsSync(reference)
        )
          throw new Error(
            '无原生尝试时须提供本任务干净参考的assessment与具体限制，不能为了可编辑强做错误字体',
          );
      }
      for (const a of l.nativeFallback?.attempts || []) {
        const relative = path.relative(photoshopFolder(j), path.resolve(a.evidencePath));
        if (
          !path.isAbsolute(a.evidencePath) ||
          relative.startsWith('..') ||
          path.isAbsolute(relative) ||
          !fs.existsSync(a.evidencePath)
        )
          throw new Error('文字退回像素路线的尝试证据须为本任务已有文件');
      }
      if (new Set(l.textTargets.map((t) => t.layerName)).size !== l.textTargets.length)
        throw new Error('文字目标名称重复');
    }
    if (l.route === 'preserve' && (!prior || prior.preview || j.snapshot.status === 'preview'))
      throw new Error('抠图预览或规划层不能作为已完成层保留');
    if (prior && j.layerIds?.length && !j.layerIds.includes(prior.id) && l.route !== 'preserve')
      throw new Error(`「${l.name}」不在本次修改范围，不能自动重建`);
    if (
      prior &&
      !prior.preview &&
      ((prior.disposition === 'keep' && !j.layerIds?.includes(prior.id)) ||
        (j.layerIds?.length && !j.layerIds.includes(prior.id))) &&
      l.route !== 'preserve'
    )
      throw new Error(`「${l.name}」为保留层，不能自动重建`);
    if (l.dependencies.some((id) => id === l.layerId || !ids.includes(id)))
      throw new Error('依赖图层不存在或自引用');
  }
  const done = new Set<string>(),
    active = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) throw new Error('图层依赖成环');
    if (done.has(id)) return;
    active.add(id);
    p.layers.find((l) => l.layerId === id)!.dependencies.forEach(visit);
    active.delete(id);
    done.add(id);
  }
  ids.forEach(visit);
  if (j.reconstructionWorkflowVersion === 4) {
    const elements = p.layers.flatMap((l) => l.elements.map((e) => e.trim().toLowerCase()));
    if (new Set(elements).size !== elements.length)
      throw new Error('元素只能归属一个逻辑层；请区分位置并从背景排除独立光效');
    for (const r of p.relations)
      if (
        new Set(r.layerIds).size !== r.layerIds.length ||
        r.layerIds.some((id) => !ids.includes(id))
      )
        throw new Error('PS接触/遮挡关系引用无效图层');
    if (new Set(p.relations.map((r) => r.id)).size !== p.relations.length)
      throw new Error('PS层间关系ID重复');
  }
  return p;
}

export function photoshopPacket(j: Job) {
  const s = photoshopState(j);
  const regionInstruction = j.reconstructionVersion === 3 && j.reconstructionWorkflowVersion === 4
    ? ' 可在透明前景plan层显式冻结可选alphaChecks：box为原图片局部整数像素且在本层来源框内，clear要求环境孔隙，transmissive要求非空材质及底色响应；数值阈值全部必填，不从扁平图猜物理透射率。prepare继承并换算生成像素；inspect读取实际PS全画布透明组PNG，区域失败可needs-revision，但不能accepted或complete；inspect-progress仅提供已ready目标的中途诊断，无规则旧计划不补写字段。'
    : '';
  return {
    protocolVersion: j.reconstructionVersion === 3 ? 3 : 2,
    settings: settings(j),
    ...s,
    steps: [
      'plan',
      ...(s.plan?.layers.some(l => l.nativeFilm) ? ['render-native-film（空目标组中制作真实原生路径/透明渐变新副本）'] : []),
      ...(s.plan?.layers.some(l => l.nativeGeometry) ? ['render-native-geometry（事前观察的简单实体四边形/透明孔，空组原生PS新副本制作）'] : []),
      ...(s.plan?.layers.some(l => l.nativeTextPlane) ? ['render-native-plane-text（冻结真实字体/平面，空组新副本原生制作并回读；仍需inspect）'] : []),
      'material（需要位图时）',
      ...(j.reconstructionVersion === 3 ? ['place-material（完整画幅智能对象置入）'] : []),
      'fit-text（原生文字按实际字形边界匹配）',
      'inspect（逐层透明/深浅底与原生文字检查）',
      'review（每层）',
      'review-composite',
      'canvas_complete_request',
    ],
    layers: s.plan?.layers.map((l) => ({
      ...l,
      groupName: photoshopGroupName(l.layerId),
      generation: generationPlan(l.frame, settings(j).generationPixelBudget),
      ...(l.alphaChecks?.length ? { alphaCheckRegions: mappedAlphaChecks(l.alphaChecks, j.snapshot, s.plan!.canvas || j.snapshot) } : {}),
    })),
    instructions:
      (j.reconstructionVersion === 3
        ? PHOTOSHOP_WORKFLOW
        : '协议v2：局部参考只定位，不能作最终裁片。位图默认实际image_gen，前景transparent，复杂光效transparent或screen，背景生成补全。提取必须真实分离物体且说明补全。文字优先可见原生层+textTargets；不能匹配才以实际尝试证据nativeFallback改像素，不许隐藏参考冒充mixed。material须evidence，先检查分离再超分。fit-text按真实字形边界拟合，不代表颜色/字形审核通过。inspect导出PS整图、逐组透明及深浅底probes、文字报告；每层review须checks:{isolation,occlusion,appearance,text?}。仍漂移先换方法再标红，继续其他层；无效裁片不是可接受的漂移。任何改动均使旧检查失效，旧协议未完成任务需重提plan，不自动执行历史任务。') + regionInstruction,
  };
}

function verifyRegisteredMaterial(
  j: Job,
  s: State,
  entry: PhotoshopPlan['layers'][number],
  m: Material | undefined,
) {
  if (j.reconstructionVersion !== 3 || !['generate', 'hybrid'].includes(entry.route)) return;
  try {
    if (!m || m.status !== 'ready') throw new Error(`「${entry.name}」尚未完成素材处理`);
    if (m.repair) {
      verifyPhotoshopRepair(
        m.repair,
        crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex'),
        (id) => repairGenerationBinding(j, entry, id),
        0,
        (binding) => verifyPhotoshopExtraction(j, entry, binding, photoshopFolder(j)),
      );
      if (
        m.generationId !== m.repair.patch.generation.id ||
        m.workingPath !== m.repair.output.path ||
        fileHash(m.workingPath) !== m.repair.output.hash ||
        JSON.stringify(m.placementFrame) !== JSON.stringify(m.repair.base.materialFrame)
      )
        throw new Error('局部修复派生素材或完整carrier绑定已变化，请重新material');
    } else if (m.provenance === 'extracted') {
      if (
        !m.extraction ||
        m.generationId ||
        m.originalPath !== m.extraction.materialOriginal.path ||
        m.workingPath !== m.extraction.working.path ||
        JSON.stringify(m.workingSize) !==
          JSON.stringify({
            width: m.extraction.working.width,
            height: m.extraction.working.height,
          }) ||
        JSON.stringify(m.placementFrame) !== JSON.stringify(m.extraction.placementFrame) ||
        JSON.stringify(m.receipt?.declaration.extraction) !==
          JSON.stringify(m.extraction.evidence) ||
        m.receipt?.outputHash !== m.extraction.original.hash
      )
        throw new Error('hybrid提取素材与原件、receipt或完整carrier定位绑定不符，请重新material');
      verifyPhotoshopExtraction(j, entry, m.extraction, photoshopFolder(j));
    } else {
      const r = registeredGeneration(j, m.generationId, [entry.layerId], entry.frame);
      if(r.kind==='derived-background' || m.provenance==='source-protected') {
        requireDerivedBackgroundReview(generationState(j),r);
        const p=m.receipt?.declaration.backgroundProtection,b=r.derivedBackground?.binding.inputs;
        if(r.kind!=='derived-background'||m.provenance!=='source-protected'||!entry.sourceProtection||!p||!b||
          p.generationId!==r.id||p.baseGenerationId!==b.scope.parentGenerationId||
          p.sourceHash!==b.source.hash||p.keepMaskHash!==b.keepMask.hash||m.upscaledPath||
          JSON.stringify(m.placementFrame)!==JSON.stringify(r.placementFrame))
          throw photoshopRepairError('背景保护素材的派生身份、来源凭证或满幅定位已变化');
      } else if(entry.sourceProtection)throw photoshopRepairError('背景保护计划不能使用未派生的补全素材');
      if (!m.workingPath || fileHash(m.workingPath) !== r.workingHash)
        throw new Error(
          `「${entry.name}」定位修正后素材已改变，请重新material、place-material和inspect`,
        );
    }
  } catch (e) {
    s.inspection = undefined;
    s.reviews = {};
    s.compositeReview = undefined;
    s.quality = undefined;
    s.checks = {};
    for (const material of Object.values(s.materials)) material.upscaleEvidence = undefined;
    put(j, s, true);
    throw photoshopRepairError(e instanceof Error ? e.message : String(e));
  }
}

function repairGenerationBinding(j: Job, entry: PhotoshopPlan['layers'][number], id: string) {
  const r = registeredGeneration(j, id, [entry.layerId], entry.frame);
  return {
    id: r.id,
    originalPath: r.originalPath,
    originalHash: r.hash,
    workingPath: r.workingPath,
    workingHash: r.workingHash,
    placementFrame: r.placementFrame || entry.frame,
  };
}

function verifyRegisteredMaterials(j: Job, s: State) {
  for (const entry of s.plan?.layers || [])
    verifyRegisteredMaterial(j, s, entry, s.materials[entry.layerId]);
}

function verifyCurrentAlphaDiagnostics(j: Job, s: State) {
  try {
    const context = s.plan && capturePhotoshopAlphaContext(j, s.plan, s.materials);
    if (!context) return;
    if (!s.inspection) throw new Error('PS区域alpha诊断尚未由完整inspect输出');
    verifyPhotoshopAlphaChecks(context, s.inspection, s.quality?.alphaDiagnostics);
  } catch (e) {
    s.inspection = undefined;
    s.quality = undefined;
    s.reviews = {};
    s.checks = {};
    s.compositeReview = undefined;
    for (const material of Object.values(s.materials)) material.upscaleEvidence = undefined;
    put(j, s);
    throw photoshopRepairError(e instanceof Error ? e.message : String(e));
  }
}

export async function beginPhotoshopMaterial(
  j: Job,
  input: Extract<z.infer<typeof photoshopActionSchema>, { action: 'material' }>,
) {
  const s = photoshopState(j),
    entry = s.plan?.layers.find((l) => l.layerId === input.layerId);
  if (!entry) throw new Error('先提交此图层的重建计划');
  if (s.materials[input.layerId]?.status === 'processing')
    throw new Error('该层素材仍在处理，请读取status');
  if (!path.isAbsolute(input.path) || !fs.statSync(input.path).isFile())
    throw new Error('素材路径无效');
  if (entry.route === 'native') throw new Error('原生路线不接收位图素材，请先更正计划');
  if (input.provenance === 'extracted' && !settings(j).allowExtraction)
    throw photoshopRepairError('提取路线未启用');
  const hybridExtraction =
    input.provenance === 'extracted' &&
    entry.route === 'hybrid' &&
    entry.surface === 'transparent' &&
    j.reconstructionVersion === 3 &&
    j.reconstructionWorkflowVersion === 4 &&
    settings(j).allowExtraction;
  const sourceProtected=input.provenance==='source-protected';
  if(sourceProtected && (!entry.sourceProtection||entry.content!=='background'||entry.surface!=='opaque'||
    !settings(j).allowExtraction||input.repair))throw photoshopRepairError('source-protected仅用于事前冻结的允许提取满幅背景派生，不能用于前景/光效/局部repair');
  if(entry.sourceProtection && !sourceProtected)throw photoshopRepairError('背景保护计划须提交明确source-protected派生素材，不能绕过保护选项');
  if (
    (['generate', 'hybrid'].includes(entry.route) &&
      input.provenance !== 'generated' &&
      !sourceProtected &&
      !hybridExtraction) ||
    (entry.route === 'extract' && input.provenance !== 'extracted') ||
    (entry.route === 'preserve' && input.provenance !== 'preserved')
  )
    throw photoshopRepairError('素材来源与计划路线不一致');
  if (input.placementFrame && !hybridExtraction)
    throw photoshopRepairError(
      'placementFrame仅用于允许提取的透明hybrid完整carrier；生成素材使用登记定位',
    );
  if (hybridExtraction && input.generationId)
    throw photoshopRepairError('真实提取基底不能填写generationId冒充生成');
  const extractedSources = hybridExtraction ? extractionSources(j) : undefined;
  if (hybridExtraction) {
    try {
      scopedAdobePath(photoshopFolder(j), input.path, true);
    } catch (e) {
      throw photoshopRepairError(String(e));
    }
    if (
      !input.evidence.extraction?.sourcePath ||
      path.resolve(input.evidence.extraction.sourcePath) !== path.resolve(extractedSources!.source)
    )
      throw photoshopRepairError(
        'hybrid提取sourcePath须为本任务当前干净输入，不允许预抠或其他任务来源',
      );
  }
  const extractionSourceFiles =
    extractedSources &&
    (Object.fromEntries(
      Object.entries(extractedSources).map(([key, p]) => [key, { path: p, hash: fileHash(p) }]),
    ) as
      | {
          source: { path: string; hash: string };
          auxiliaryOriginal: { path: string; hash: string };
        }
      | undefined);
  const rawBytes = fs.readFileSync(input.path);
  const rawHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
  const registration =
    j.reconstructionVersion === 3 && (input.provenance === 'generated'||sourceProtected)
      ? registeredGeneration(j, input.generationId, [entry.layerId], entry.frame, rawBytes)
      : undefined;
  if(sourceProtected) {
    const b=registration?.derivedBackground?.binding.inputs,p=input.evidence.backgroundProtection;
    if(registration?.kind!=='derived-background'||!b||!p||p.generationId!==registration.id||
      p.baseGenerationId!==b.scope.parentGenerationId||p.sourceHash!==b.source.hash||p.keepMaskHash!==b.keepMask.hash)
      throw photoshopRepairError('source-protected必须引用本任务匹配的派生背景及双来源凭证');
  } else if(registration?.kind==='derived-background')throw photoshopRepairError('派生背景不能声明为generated/image_gen原件');
  const protectedPSState=sourceProtected?JSON.stringify(s):undefined;
  const protectedGenerationState=sourceProtected?JSON.stringify(generationState(j)):undefined;
  const baseMaterial = input.repair ? s.materials[input.layerId] : undefined;
  if (input.repair) {
    if (!registration || input.provenance !== 'generated' || entry.surface !== 'transparent')
      throw photoshopRepairError('局部repair须使用当前任务真实登记image_gen补丁及transparent图层');
    if (!baseMaterial || baseMaterial.status !== 'ready' || !baseMaterial.workingPath)
      throw photoshopRepairError('局部repair须有当前任务ready的完整基底工作素材');
    verifyRegisteredMaterial(j, s, entry, baseMaterial);
    if (fileHash(baseMaterial.workingPath) !== input.repair.expectedBaseWorkingHash)
      throw photoshopRepairError('expectedBaseWorkingHash与当前ready基底不符');
  }
  // Capture the entire ready record, including selected files, generation,
  // placement and any prior repair chain, before any asynchronous derivation.
  const capturedBase = baseMaterial ? JSON.stringify(baseMaterial) : undefined;
  if (
    registration &&
    registration.planHash !==
      crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex')
  )
    throw new Error('该层PS计划已改变，请按新计划重新prepare；不能复用旧语义计划的登记');
  const bytes = await sharp(rawBytes).ensureAlpha().png().toBuffer();
  const meta = await sharp(bytes).metadata();
  const actual = { width: meta.width!, height: meta.height! };
  if (actual.width * actual.height > 40_000_000)
    throw new Error('素材超过本地处理的4000万像素上限');
  const receipt = checkEvidence(j, entry, input.path, input.provenance, input.evidence, rawBytes);
  let isolation = await alphaMetrics(bytes);
  if (entry.route !== 'preserve') {
    requireIsolatedSurface(entry, isolation);
    if (
      j.reconstructionVersion === 3 &&
      entry.surface === 'transparent' &&
      isolation.transparent < isolation.total * 0.005 &&
      isolation.soft < isolation.total * 0.01
    )
      throw new Error(
        '透明区域仅占极少像素，疑似矩形裁片挖角；请检查真实物体分离，不能靠角落透明绕过验收',
      );
    await rejectReferenceCrop(j, entry, s.plan!.canvas!, bytes);
  }
  // A larger aspect mismatch requires an explicit, visually checked contain decision, not an anamorphic resize.
  const error = aspectError(actual, input.placementFrame || entry.frame);
  if (error > 0.01 && !input.allowAspectFit && !registration)
    throw new Error(
      `比例偏差${(error * 100).toFixed(2)}%。保留原文件；确认留白适配可接受后以allowAspectFit继续，不能分别拉伸宽高`,
    );
  const folder = path.join(photoshopFolder(j), 'materials', uid());
  fs.mkdirSync(folder, { recursive: true });
  const originalPath = path.join(folder, 'original.png');
  fs.writeFileSync(originalPath, bytes);
  const working = registration
    ? { bytes: fs.readFileSync(registration.workingPath), workingSize: registration.workingSize }
    : input.provenance === 'generated' || hybridExtraction
      ? await budgetWorkingCopy(bytes)
      : { bytes, workingSize: actual };
  let workingPath = path.join(folder, 'working.png');
  fs.writeFileSync(workingPath, working.bytes);
  let repair: PhotoshopRepairRecord | undefined;
  let workingSize = working.workingSize;
  let placementFrame =
    registration?.placementFrame ||
    (hybridExtraction ? input.placementFrame || entry.frame : undefined);
  const extraction: PhotoshopExtractionBinding | undefined = hybridExtraction
    ? {
        kind: 'extracted',
        taskId: j.taskId!,
        jobId: j.id,
        documentId: j.documentId,
        layerId: entry.layerId,
        planHash: extractionPlanHash(entry),
        original: { path: input.path, hash: rawHash },
        materialOriginal: { path: originalPath, hash: fileHash(originalPath) },
        working: { path: workingPath, hash: fileHash(workingPath), ...working.workingSize },
        ...extractionSourceFiles!,
        placementFrame: placementFrame!,
        evidence: input.evidence.extraction!,
      }
    : undefined;
  if (input.repair && baseMaterial?.workingPath && registration) {
    const metaBase = await sharp(fs.readFileSync(baseMaterial.workingPath)).metadata();
    const materialFrame = baseMaterial.placementFrame || entry.frame;
    const target = photoshopMaterialTarget(
      { width: metaBase.width!, height: metaBase.height! },
      materialFrame,
    );
    const patchTarget = photoshopMaterialTarget(
      working.workingSize,
      registration.placementFrame || entry.frame,
    );
    const baseRegistration = baseMaterial.generationId
      ? registeredGeneration(j, baseMaterial.generationId, [entry.layerId], entry.frame)
      : undefined;
    repair = await derivePhotoshopRepair({
      folder: photoshopFolder(j),
      outputFolder: folder,
      layerId: entry.layerId,
      planHash: crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex'),
      baseWorkingPath: baseMaterial.workingPath,
      expectedBaseWorkingHash: input.repair.expectedBaseWorkingHash,
      baseArtifactPath: input.repair.baseArtifactPath,
      expectedBaseFrame: target,
      baseMaterialFrame: materialFrame,
      baseGeneration: baseRegistration
        ? {
            id: baseRegistration.id,
            originalPath: baseRegistration.originalPath,
            originalHash: baseRegistration.hash,
            workingPath: baseRegistration.workingPath,
            workingHash: baseRegistration.workingHash,
            placementFrame: baseRegistration.placementFrame || entry.frame,
          }
        : undefined,
      baseExtraction: baseMaterial.extraction,
      baseRepair: baseMaterial.repair,
      patchWorkingPath: workingPath,
      patchOriginal: { path: registration.originalPath, hash: registration.hash },
      patchGeneration: {
        id: registration.id,
        originalPath: registration.originalPath,
        originalHash: registration.hash,
        workingPath: registration.workingPath,
        workingHash: registration.workingHash,
        placementFrame: registration.placementFrame || entry.frame,
      },
      patchFrame: patchTarget,
      maskPath: input.repair.maskPath,
    }).catch((e) => {
      throw photoshopRepairError(e instanceof Error ? e.message : String(e));
    });
    workingPath = repair.output.path;
    workingSize = { width: repair.output.width, height: repair.output.height };
    placementFrame = materialFrame;
    isolation = await alphaMetrics(fs.readFileSync(workingPath));
    requireIsolatedSurface(entry, isolation);
  }
  const url = writeAsset(j.documentId, bytes, '.png');
  await rejectPreviewReuse(j, [
    {
      id: entry.layerId,
      name: entry.name,
      url,
      kind: 'raster',
      ...entry.frame,
      visible: true,
      opacity: 1,
      opinion: '',
      disposition: 'rebuild',
    },
  ]);
  live(j);
  const latest = photoshopState(j);
  if(sourceProtected) {
    if(JSON.stringify(latest)!==protectedPSState||JSON.stringify(generationState(j))!==protectedGenerationState||
      JSON.stringify(getJob(j.id))!==JSON.stringify(j))throw photoshopRepairError('背景素材处理期间完整任务/计划/登记已变化；生成文件保留');
    registeredGeneration(j,registration!.id,[entry.layerId],entry.frame);
  }
  if (JSON.stringify(latest.plan) !== JSON.stringify(s.plan))
    throw new Error('素材处理期间计划已变更，请按新计划重新提交');
  if (extraction) {
    try {
      if (receipt.outputHash !== rawHash) throw Error('提取receipt与实际读取原件快照不一致');
      verifyPhotoshopExtraction(j, entry, extraction, photoshopFolder(j));
    } catch (e) {
      throw photoshopRepairError(String(e));
    }
  }
  if (input.repair && repair) {
    const currentBase = latest.materials[input.layerId];
    if (
      JSON.stringify(currentBase) !== capturedBase ||
      currentBase?.status !== 'ready' ||
      !currentBase.workingPath ||
      !fs.existsSync(currentBase.workingPath) ||
      fileHash(currentBase.workingPath) !== input.repair.expectedBaseWorkingHash
    ) {
      // A genuinely newer ready material may retain its own checks. A changed
      // source/position of the current material must still invalidate old checks.
      if (currentBase?.status === 'ready') {
        try {
          verifyRegisteredMaterial(j, latest, entry, currentBase);
        } catch {
          /* invalidation persisted by verifier */
        }
      }
      throw photoshopRepairError(
        '修复推导期间完整基底绑定已改变；派生文件已保留，请按当前ready基底重新material',
      );
    }
    try {
      verifyRegisteredMaterial(j, latest, entry, currentBase);
      verifyPhotoshopRepair(
        repair,
        crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex'),
        (id) => repairGenerationBinding(j, entry, id),
        0,
        (binding) => verifyPhotoshopExtraction(j, entry, binding, photoshopFolder(j)),
      );
    } catch (e) {
      throw photoshopRepairError(
        `修复推导期间来源或定位已改变；派生文件已保留：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // No awaits between the compare/revalidation above and this state write.
  if (latest.materials[input.layerId]?.status === 'processing')
    throw new Error('该层已由另一个请求开始处理');
  latest.materials[input.layerId] = {
    path: workingPath,
    hash: fileHash(workingPath),
    originalPath,
    originalSize: actual,
    workingPath,
    workingSize,
    generationId: registration?.id,
    placementFrame,
    repair,
    extraction,
    provenance: input.provenance,
    observation: input.observation,
    status: 'processing',
    receipt,
    isolation,
  };
  latest.inspection = undefined;
  latest.reviews = {};
  latest.compositeReview = undefined;
  latest.quality = undefined;
  latest.checks = {};
  for (const material of Object.values(latest.materials)) material.upscaleEvidence = undefined;
  put(j, latest);
  return { layerId: input.layerId, status: 'processing', originalPath };
}

export async function processPhotoshopMaterial(
  j: Job,
  id: string,
  signal: AbortSignal,
  runner = worker,
) {
  const s = photoshopState(j),
    m = s.materials[id],
    entry = s.plan!.layers.find((l) => l.layerId === id)!;
  if (!m || m.status !== 'processing') return;
  const protectedMaterialBefore=m.provenance==='source-protected'?JSON.stringify(m):undefined;
  const ratio = Math.min(
    (m.placementFrame || entry.frame).width / (m.workingSize || m.originalSize).width,
    (m.placementFrame || entry.frame).height / (m.workingSize || m.originalSize).height,
  );
  try {
    const workingPath = m.workingPath || m.originalPath;
    let candidate = workingPath;
    m.needsUpscale = needsPhotoshopUpscale(
      ratio,
      settings(j).autoUpscale,
      m.provenance === 'preserved'||m.provenance==='source-protected',
    );
    if (
      (m.needsUpscale || m.upscaleApproved) &&
      (j.reconstructionWorkflowVersion !== 4 || m.upscaleApproved)
    ) {
      const folder = path.dirname(m.originalPath),
        opts = upscaleSchema.parse({ ...j.upscale, scale: ratio <= 2 ? 2 : 4 });
      const op = path.join(folder, 'options.json');
      atomic(op, opts);
      const size = {
        width: (m.workingSize || m.originalSize).width * opts.scale,
        height: (m.workingSize || m.originalSize).height * opts.scale,
      };
      if (size.width * size.height > 40_000_000)
        throw new Error('超分尺寸超过4000万像素，使用原始素材等比缩放');
      const result = await runner(
        ['upscale', '--input', workingPath, '--output', folder, '--options', op],
        signal,
      );
      signal.throwIfAborted();
      if (path.resolve(result.path || '') !== path.join(folder, 'upscaled.png'))
        throw new Error('超分返回路径无效');
      const generated = await sharp(fs.readFileSync(result.path)).metadata();
      if (generated.width !== size.width || generated.height !== size.height)
        throw new Error('超分尺寸错误');
      const alpha = await sharp(fs.readFileSync(workingPath))
        .ensureAlpha()
        .extractChannel('alpha')
        .resize(size.width, size.height)
        .raw()
        .toBuffer();
      const rgb = await sharp(fs.readFileSync(result.path)).removeAlpha().png().toBuffer();
      candidate = path.join(folder, 'upscaled-alpha.png');
      fs.writeFileSync(
        candidate,
        await sharp(rgb)
          .joinChannel(alpha, { raw: { ...size, channels: 1 } })
          .png()
          .toBuffer(),
      );
      m.upscaledPath = candidate;
    }
    m.path = candidate;
  } catch (e) {
    if (signal.aborted) throw e;
    m.warning = `超分未完成：${String(e)}；原始文件已保留，允许等比缩放并在审查中说明`;
  }
  live(j);
  const meta = await sharp(fs.readFileSync(m.path)).metadata();
  m.placement = fitGeometry(
    { width: meta.width!, height: meta.height! },
    m.placementFrame || entry.frame,
  );
  m.status = 'ready';
  m.originalPlacement = fitGeometry(m.originalSize, entry.frame);
  m.hash = fileHash(m.path);
  const latest = photoshopState(j);
  if(m.provenance==='source-protected') {
    const captured=JSON.stringify(latest);
    await prepareGeneratedRoleConsumer(j,[m.generationId!]);
    const r=registeredGeneration(j,m.generationId,[entry.layerId],entry.frame);
    if(JSON.stringify(photoshopState(j))!==captured||JSON.stringify(latest.plan)!==JSON.stringify(s.plan)||
      JSON.stringify(latest.materials[id])!==protectedMaterialBefore||m.path!==m.workingPath||fileHash(m.path)!==r.workingHash)
      throw photoshopRepairError('背景保护处理结束前素材/计划/来源已变化，不能写入ready');
  }
  latest.materials[id] = m;
  put(j, latest);
}

export async function photoshopAction(j: Job, raw: unknown, adobe: AdobeConnector) {
  const input = photoshopActionSchema.parse(raw),
    s = photoshopState(j);
  if (input.action === 'status') return photoshopPacket(j);
  live(j);
  if (input.action === 'plan') {
    if (Object.values(s.materials).some((m) => m.status === 'processing'))
      throw new Error('素材处理完成后才能修改计划');
    const plan = validatePhotoshopPlan(j, input.plan);
    const oldProtected=s.plan?.layers.some(l=>l.sourceProtection),newProtected=plan.layers.some(l=>l.sourceProtection);
    const generations=generationState(j);
    const resumedNative = json<{ nativePrepared?: unknown }[]>(path.join(photoshopFolder(j), 'resume-history.json'), [])
      .some(entry => !!entry.nativePrepared);
    if ((s.plan?.layers.some(l => l.opticalPart || l.nativeTextPlane || l.nativeGeometry) || plan.layers.some(l => l.opticalPart || l.nativeTextPlane || l.nativeGeometry)) &&
        (generations.requests.length || generations.outputs.length || Object.keys(s.materials).length || Object.keys(s.nativeFilms || {}).length || Object.keys(s.nativeGeometries || {}).length || Object.keys(s.nativeTextPlanes || {}).length || resumedNative || s.inspection) &&
        JSON.stringify(plan) !== JSON.stringify(s.plan))
      throw opticalPartError('光学分件/原生平面文字须在首次prepare/素材/原生检查前冻结完整PS计划，不能追改或删除分件归属');
    if((oldProtected||newProtected)&&(generations.requests.length||generations.outputs.length)&&JSON.stringify(plan)!==JSON.stringify(s.plan))
      throw photoshopRepairError('背景保护须在首次prepare之前冻结完整计划，不能追开旧任务或改变已生成计划');
    if(plan.layers.filter(l=>l.sourceProtection).length>1)throw photoshopRepairError('本任务仅允许一个满幅背景保护层');
    const captured=JSON.stringify(s),jobCaptured=JSON.stringify(j),generationCaptured=JSON.stringify(generations);
    for(const entry of plan.layers)if(entry.sourceProtection) {
      if(entry.surface!=='opaque'||!['generate','hybrid'].includes(entry.route)||entry.alphaChecks?.length)
        throw photoshopRepairError('背景保护只允许opaque generate/hybrid，不能透明、光效或原生');
      validateBackgroundProtectionRoute(j,[entry.layerId],entry.sourceProtection,plan.canvas!,entry.frame,true,entry.content==='background');
      await preflightBackgroundSelection(j,entry.sourceProtection,plan.canvas!);
    }
    if(newProtected&&(JSON.stringify(photoshopState(j))!==captured||JSON.stringify(getJob(j.id))!==jobCaptured||
      JSON.stringify(generationState(j))!==generationCaptured))
      throw photoshopRepairError('背景计划准备期间任务、PS状态或生成登记已改变');
    // Idempotent replay preserves costly material work; semantic changes invalidate only changed material entries.
    for (const id of Object.keys(s.materials))
      if (
        JSON.stringify(plan.layers.find((l) => l.layerId === id)) !==
        JSON.stringify(s.plan?.layers.find((l) => l.layerId === id))
      )
        delete s.materials[id];
    if (JSON.stringify(plan) !== JSON.stringify(s.plan)) {
      s.inspection = undefined;
      s.reviews = {};
      s.compositeReview = undefined;
      s.quality = undefined;
      s.checks = {};
      for (const material of Object.values(s.materials)) material.upscaleEvidence = undefined;
    }
    s.version = 2;
    s.plan = plan;
    put(j, s);
    return photoshopPacket(j);
  }
  if (!s.plan) throw new Error('先提交逐层重建计划');
  const consumerIds=[...new Set([...Object.values(s.materials).map(m=>m.generationId),
    input.action==='material'?input.generationId:undefined].filter((id):id is string=>!!id))];
  const protectedConsumer=generationState(j).outputs.some(r=>consumerIds.includes(r.id)&&r.kind==='derived-background');
  const capturedConsumer=JSON.stringify(s);
  try {
    await prepareGeneratedRoleConsumer(j,consumerIds);
    if(protectedConsumer && JSON.stringify(photoshopState(j))!==capturedConsumer)
      throw photoshopRepairError('PS消费预检期间完整素材/计划状态已改变');
  } catch(e) {
    if(protectedConsumer && JSON.stringify(photoshopState(j))===capturedConsumer) {
      s.inspection=undefined;s.reviews={};s.compositeReview=undefined;s.quality=undefined;s.checks={};put(j,s,true);
    }
    throw e;
  }
  if (s.version !== 2) throw new Error('旧重建协议尚未验收，请按v2重提plan；已有文件保留');
  if (input.action === 'render-native-geometry') {
    if ((input.taskId && input.taskId !== j.taskId) || (input.jobId && input.jobId !== j.id))
      throw opticalPartError('原生实体几何须使用当前真实task/job');
    validatePhotoshopPlan(j, s.plan);
    const prior = s.nativeGeometries?.[input.layerId];
    if (prior) {
      const requested = taskPsd(photoshopFolder(j), input.inputPsdPath);
      if (prior.planHash !== crypto.createHash('sha256').update(JSON.stringify(s.plan)).digest('hex') ||
          fileHash(prior.artifactPath) !== prior.artifactHash || fileHash(prior.inputPath) !== prior.inputHash ||
          ![prior.inputPath, prior.artifactPath].some(p => path.resolve(p) === path.resolve(requested)))
        throw opticalPartError('原生实体几何收据的计划/输入/输出变化；保留文件，不能重复制作');
      const entry = s.plan.layers.find(l => l.layerId === input.layerId)!;
      const actual = readPsd(fs.readFileSync(prior.artifactPath), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
      const groups = actual.children?.filter(g => g.name === photoshopGroupName(input.layerId));
      if (groups?.length !== 1) throw opticalPartError('原生实体几何收据分组缺失或重复');
      verifyNativeGeometryGroup(groups[0], entry);
      return { ...prior, reused: true };
    }
    const captured = JSON.stringify(s);
    const result = await renderNativeGeometry(adobe, photoshopFolder(j), taskPsd(photoshopFolder(j), input.inputPsdPath), s.plan, input.layerId);
    live(j);
    if (JSON.stringify(photoshopState(j)) !== captured)
      throw opticalPartError('原生实体几何制作期间状态变化；新副本保留，不写入旧状态');
    s.nativeGeometries = { ...s.nativeGeometries, [input.layerId]: result };
    s.inspection = undefined; s.reviews = {}; s.compositeReview = undefined; s.quality = undefined; s.checks = {};
    put(j, s);
    return result;
  }
  if (input.action === 'render-native-plane-text') {
    if ((input.taskId && input.taskId !== j.taskId) || (input.jobId && input.jobId !== j.id))
      throw opticalPartError('原生平面文字须使用当前真实task/job');
    validatePhotoshopPlan(j, s.plan);
    const prior = s.nativeTextPlanes?.[input.layerId];
    if (prior) {
      const requested = taskPsd(photoshopFolder(j), input.inputPsdPath);
      if (prior.planHash !== crypto.createHash('sha256').update(JSON.stringify(s.plan)).digest('hex') ||
          fileHash(prior.artifactPath) !== prior.artifactHash || fileHash(prior.inputPath) !== prior.inputHash ||
          ![prior.inputPath, prior.artifactPath].some(p => path.resolve(p) === path.resolve(requested)))
        throw opticalPartError('原生平面文字收据的计划/输入/输出变化；保留文件，不能盲目重复制作');
      const entry = s.plan.layers.find(l => l.layerId === input.layerId)!;
      const actual = readPsd(fs.readFileSync(prior.artifactPath), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
      const groups = actual.children?.filter(g => g.name === photoshopGroupName(input.layerId));
      if (groups?.length !== 1) throw opticalPartError('原生平面文字收据分组缺失或重复');
      verifyNativeTextPlaneGroup(groups[0], entry);
      return { ...prior, reused: true };
    }
    const captured = JSON.stringify(s);
    const result = await renderNativeTextPlane(adobe, photoshopFolder(j), taskPsd(photoshopFolder(j), input.inputPsdPath), s.plan, input.layerId);
    if (JSON.stringify(photoshopState(j)) !== captured)
      throw opticalPartError('原生文字制作期间任务状态变化；新副本保留，不写入旧状态');
    s.nativeTextPlanes = { ...s.nativeTextPlanes, [input.layerId]: result };
    s.inspection = undefined; s.reviews = {}; s.compositeReview = undefined; s.quality = undefined; s.checks = {};
    put(j, s);
    return result;
  }
  if (input.action === 'render-native-film') {
    if ((input.taskId && input.taskId !== j.taskId) || (input.jobId && input.jobId !== j.id))
      throw opticalPartError('原生薄膜须使用当前真实task/job');
    validatePhotoshopPlan(j, s.plan);
    const prior = s.nativeFilms?.[input.layerId];
    if (prior) {
      const requested = taskPsd(photoshopFolder(j), input.inputPsdPath);
      if (prior.planHash !== crypto.createHash('sha256').update(JSON.stringify(s.plan)).digest('hex') ||
          fileHash(prior.artifactPath) !== prior.artifactHash || fileHash(prior.inputPath) !== prior.inputHash ||
          ![prior.inputPath, prior.artifactPath].some(p => path.resolve(p) === path.resolve(requested)))
        throw opticalPartError('已有原生薄膜收据的计划/输入/实际输出变化；保留文件，不能盲目重复制作');
      const entry = s.plan.layers.find(l => l.layerId === input.layerId)!;
      const actual = readPsd(fs.readFileSync(prior.artifactPath), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
      verifyNativeFilmGroup(actual.children?.find(g => g.name === photoshopGroupName(input.layerId)), entry);
      return { ...prior, reused: true };
    }
    const captured = JSON.stringify(s), planHash = JSON.stringify(s.plan);
    const result = await renderNativeFilm(adobe, photoshopFolder(j), taskPsd(photoshopFolder(j), input.inputPsdPath), s.plan, input.layerId);
    if (JSON.stringify(photoshopState(j)) !== captured || JSON.stringify(photoshopState(j).plan) !== planHash)
      throw opticalPartError('原生薄膜制作期间计划或素材状态变化；新副本保留，不写入旧状态');
    // The saved native file is only a preparation result. inspect-progress/inspect
    // must still render it and evaluate real group alpha and visible appearance.
    s.nativeFilms = { ...s.nativeFilms, [input.layerId]: result };
    s.inspection = undefined; s.reviews = {}; s.compositeReview = undefined; s.quality = undefined; s.checks = {};
    put(j, s);
    return result;
  }
  if (input.action === 'material') return beginPhotoshopMaterial(j, input);
  if (input.action === 'inspect-progress') {
    const inputPsd = taskPsd(photoshopFolder(j), input.artifactPath), inputHash = fileHash(inputPsd);
    const readyNative = j.reconstructionWorkflowVersion === 4
      ? nativeProgressLayers(fs.readFileSync(inputPsd), s.plan, s.plan.canvas || j.snapshot) : [];
    const readyMaterials = s.plan.layers.filter(l => s.materials[l.layerId]?.status === 'ready');
    const readyLayers = s.plan.layers.filter(l => readyNative.includes(l) || readyMaterials.includes(l));
    for (const entry of readyMaterials)
      verifyRegisteredMaterial(j, s, entry, s.materials[entry.layerId]);
    const captured = JSON.stringify({ plan: s.plan, materials: s.materials });
    const alphaIds = readyLayers.filter(l => l.alphaChecks?.length).map(l => l.layerId);
    const alphaContext = capturePhotoshopAlphaContext(j, s.plan, s.materials, alphaIds);
    const render = await renderNativePsd(
      adobe,
      inputPsd,
      photoshopFolder(j),
      readyLayers.map(l => ({ layerId: l.layerId, groupName: photoshopGroupName(l.layerId) })),
    );
    const alphaDiagnostics = await inspectPhotoshopAlphaChecks(alphaContext, render);
    if (fileHash(inputPsd) !== inputHash || j.reconstructionWorkflowVersion === 4 &&
        JSON.stringify(nativeProgressLayers(fs.readFileSync(render.psdPath), s.plan, s.plan.canvas || j.snapshot).map(l => l.layerId)) !==
        JSON.stringify(readyNative.map(l => l.layerId)))
      throw photoshopRepairError('原生进度检查期间实际PSD或可见文字分组发生变化；输出已保留，不沿用旧进度');
    const reference = assetPath(
      j.documentId,
      j.snapshot.status === 'preview' ? j.snapshot.source : j.snapshot.url || j.snapshot.source,
    );
    const comparison = await comparisonPanels(
      reference,
      render.previewPath,
      path.join(photoshopFolder(j), `progress-${uid()}.png`),
    );
    const latest = photoshopState(j);
    if (JSON.stringify({ plan: latest.plan, materials: latest.materials }) !== captured)
      throw photoshopRepairError('预览期间完整素材绑定已变更；渲染文件已保留');
    for (const entry of latest.plan!.layers)
      if (latest.materials[entry.layerId]?.status === 'ready')
        verifyRegisteredMaterial(j, latest, entry, latest.materials[entry.layerId]);
    verifyPhotoshopAlphaChecks(capturePhotoshopAlphaContext(j, latest.plan!, latest.materials, alphaIds),
      render, alphaDiagnostics);
    return {
      previewOnly: true,
      ...render,
      ...(readyNative.length ? { nativeReadyLayerIds: readyNative.map(l => l.layerId),
        nativeTexts: nativeTextReport(readPsd(fs.readFileSync(render.psdPath), {
          skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true,
        }), { ...s.plan, layers: readyNative }, render.textFacts) } : {}),
      comparison,
      ...(alphaDiagnostics ? { alphaDiagnostics } : {}),
      note: '检查当前真实PS合成的接触、遮挡和外观；此预览不替代最终inspect与逐层审核，不改变验收状态。',
    };
  }
  if (input.action === 'upscale-material') {
    verifyCurrentAlphaDiagnostics(j, s);
    requirePhotoshopAlphaPassed(s.quality?.alphaDiagnostics, input.layerId);
    const entry = s.plan.layers.find((l) => l.layerId === input.layerId);
    const m = s.materials[input.layerId];
    if (entry) verifyRegisteredMaterial(j, s, entry, m);
    if (
      !m ||
      m.status !== 'ready' ||
      !m.upscaleEvidence ||
      fileHash(m.upscaleEvidence.psdPath) !== m.upscaleEvidence.psdHash ||
      fileHash(m.workingPath || m.originalPath) !== m.upscaleEvidence.workingHash
    )
      throw new Error('先以原工作图完成PS合成、inspect及本层通过，再超分；漂移素材不先花时间超分');
    if (!input.force && (!m.needsUpscale || !settings(j).autoUpscale))
      throw new Error('该素材仅需小幅等比插值或设置已关闭；确需超分可显式force:true');
    if (m.provenance === 'preserved') throw new Error('保留层不能强制超分改写');
    if(m.provenance==='source-protected')throw photoshopRepairError('满幅背景保护素材不能超分改变受保护像素；使用已登记的完整工作文件');
    if (m.upscaledPath)
      return {
        status: 'ready',
        layerId: input.layerId,
        note: '已审核素材的超分版本已存在，直接选择置入，不重复超分',
      };
    m.upscaleApproved = true;
    m.status = 'processing';
    s.inspection = undefined;
    s.quality = undefined;
    s.reviews = {};
    s.checks = {};
    s.compositeReview = undefined;
    put(j, s);
    return { status: 'processing', layerId: input.layerId };
  }
  if (input.action === 'place-material') {
    const entry = s.plan.layers.find((l) => l.layerId === input.layerId),
      m = s.materials[input.layerId];
    if (!entry || !m || m.status !== 'ready') throw new Error('先完成该层素材登记与处理');
    verifyRegisteredMaterial(j, s, entry, m);
    const captured = JSON.stringify({ plan: s.plan, material: m });
    const candidate =
      input.choice === 'upscaled' ? m.upscaledPath : m.workingPath || m.originalPath;
    if (!candidate) throw new Error('未生成可用超分版本');
    const result = await placeNativeMaterial(
      adobe,
      photoshopFolder(j),
      input.artifactPath,
      input.layerId,
      candidate,
      m.placementFrame || entry.frame,
      entry.surface === 'screen',
      isPhotoshopFullBackground(entry, s.plan.canvas!),
      m.provenance === 'source-protected',
    );
    live(j);
    const latest = photoshopState(j);
    if (
      JSON.stringify({ plan: latest.plan, material: latest.materials[input.layerId] }) !== captured
    )
      throw photoshopRepairError(
        '置入期间完整素材绑定已变更；新PSD已保留，请按当前ready素材重新置入',
      );
    verifyRegisteredMaterial(j, latest, entry, latest.materials[input.layerId]);
    latest.inspection = undefined;
    latest.quality = undefined;
    latest.reviews = {};
    latest.checks = {};
    latest.compositeReview = undefined;
    latest.materials[input.layerId].choice = input.choice;
    for (const material of Object.values(latest.materials)) material.upscaleEvidence = undefined;
    put(j, latest);
    return result;
  }
  if (input.action === 'fit-text') {
    const entry = s.plan.layers.find((l) => l.layerId === input.layerId);
    if (entry?.nativeTextPlane)
      throw opticalPartError('冻结平面文字不能另行fit-text拉伸或累加斜切；须按冻结配方制作并审查');
    if (entry?.route === 'preserve')
      throw new Error('preserve层不能重建或拟合文字；请先显式更改该层计划路线');
    const target = entry?.textTargets.find((t) => t.layerName === input.layerName);
    if (!target || JSON.stringify(target.box) !== JSON.stringify(input.targetBox))
      throw new Error('文字拟合必须使用本次计划的文字目标box');
    const result = await fitNativeText(adobe, photoshopFolder(j), input);
    live(j);
    const latest = photoshopState(j);
    latest.inspection = undefined;
    latest.quality = undefined;
    latest.reviews = {};
    latest.checks = {};
    latest.compositeReview = undefined;
    for (const material of Object.values(latest.materials)) material.upscaleEvidence = undefined;
    put(j, latest);
    return result;
  }
  if (input.action === 'inspect') {
    verifyRegisteredMaterials(j, s);
    const inspectedPlan = JSON.stringify(s.plan),
      inspectedMaterials = JSON.stringify(s.materials);
    const alphaContext = capturePhotoshopAlphaContext(j, s.plan, s.materials);
    const p = taskPsd(photoshopFolder(j), input.artifactPath);
    validateNativeStructure(fs.readFileSync(p), s.plan, { ...j.snapshot, ...s.plan.canvas });
    for (const l of s.plan.layers) {
      if (
        ['generate', 'hybrid', 'extract'].includes(l.route) &&
        s.materials[l.layerId]?.status !== 'ready'
      )
        throw new Error(`「${l.name}」尚未提交并处理真实位图素材`);
    }
    const render = await renderNativePsd(
      adobe,
      p,
      photoshopFolder(j),
      s.plan.layers.map((l) => ({ layerId: l.layerId, groupName: photoshopGroupName(l.layerId) })),
    );
    const parsed = validateNativeStructure(fs.readFileSync(render.psdPath), s.plan, {
      ...j.snapshot,
      ...s.plan.canvas,
    });
    if (j.reconstructionVersion === 3) await verifyMaterialPlacement(parsed, s.plan, s.materials);
    if (j.reconstructionWorkflowVersion === 4)
      await verifyPreservedLayers(j, s.plan, render.thumbnails);
    await assertNotWholeOriginal(render, [assetPath(j.documentId, j.snapshot.source)], s.plan);
    const isolation = await inspectRenderedIsolation(
      j,
      s.plan,
      render.thumbnails,
      photoshopFolder(j),
      render.probes,
    );
    const alphaDiagnostics = await inspectPhotoshopAlphaChecks(alphaContext, render);
    live(j);
    s.inspection = render;
    s.quality = {
      ...(alphaDiagnostics ? { alphaDiagnostics } : {}),
      isolation,
      texts: nativeTextReport(parsed, s.plan, render.textFacts),
      hashes: Object.fromEntries(
        [
          render.previewPath,
          ...(render.textFactsPath ? [render.textFactsPath] : []),
          ...Object.values(render.thumbnails),
          ...Object.values(render.probes || {}).flatMap((p) => [p.lightPath, p.darkPath]),
        ].map((p) => [p, fileHash(p)]),
      ),
    };
    if (j.reconstructionVersion === 3) {
      const original = originalReference(j.documentId, j.snapshot).path;
      const reference = assetPath(
        j.documentId,
        j.snapshot.status === 'preview' ? j.snapshot.source : j.snapshot.url || j.snapshot.source,
      );
      const canvas = s.plan.canvas || j.snapshot;
      const local = await reconstructionCrops(
        j,
        {
          version: 2,
          space: 'image-pixels',
          canvas,
          instruction: '',
          layers: s.plan.layers.map((l) => ({
            layerId: l.layerId,
            sourceLayerIds: [l.layerId],
            name: l.name,
            frame: l.frame,
            generation: generationPlan(l.frame),
            annotations: [],
          })),
        },
        original,
        reference,
      );
      s.quality.comparisons = {};
      for (const [id, output] of Object.entries({
        composite: render.previewPath,
        ...render.thumbnails,
      })) {
        let refPath = reference,
          resultPath = output;
        const entry = s.plan.layers.find((l) => l.layerId === id);
        const cropRef = (
          local.find((r) => r.layerId === id && r.role === 'current' && r.path) ||
          local.find((r) => r.layerId === id && r.path)
        )?.path;
        if (entry && cropRef) {
          const f = entry.frame,
            x = Math.max(0, f.x),
            y = Math.max(0, f.y),
            right = Math.min(canvas.width, f.x + f.width),
            bottom = Math.min(canvas.height, f.y + f.height);
          if (right > x && bottom > y) {
            const crop = await sharp(fs.readFileSync(output))
              .extract({ left: x, top: y, width: right - x, height: bottom - y })
              .extend({
                left: x - f.x,
                top: y - f.y,
                right: f.x + f.width - right,
                bottom: f.y + f.height - bottom,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
              })
              .png()
              .toBuffer();
            resultPath = path.join(photoshopFolder(j), `actual-frame-${uid()}.png`);
            fs.writeFileSync(resultPath, crop);
            refPath = cropRef;
            s.quality.hashes[resultPath] = fileHash(resultPath);
            s.quality.hashes[refPath] = fileHash(refPath);
          }
        }
        const comparison = await comparisonPanels(
          refPath,
          resultPath,
          path.join(photoshopFolder(j), `compare-${uid()}.png`),
        );
        s.quality.comparisons[id] = comparison;
        s.quality.hashes[comparison.path] = comparison.hash;
      }
    }
    live(j);
    const latest = photoshopState(j);
    if (
      JSON.stringify(latest.plan) !== inspectedPlan ||
      JSON.stringify(latest.materials) !== inspectedMaterials
    )
      throw photoshopRepairError('渲染期间计划或完整素材绑定已变更；渲染文件已保留，请重新inspect');
    verifyRegisteredMaterials(j, latest);
    verifyPhotoshopAlphaChecks(capturePhotoshopAlphaContext(j, latest.plan!, latest.materials),
      render, s.quality.alphaDiagnostics);
    // Commit only inspection fields to the current state after all render and
    // comparison awaits. Never write the old material snapshot back to disk.
    latest.inspection = render;
    latest.quality = s.quality;
    latest.reviews = {};
    latest.checks = {};
    latest.compositeReview = undefined;
    for (const material of Object.values(latest.materials)) material.upscaleEvidence = undefined;
    put(j, latest);
    return {
      ...render,
      quality: latest.quality,
      note: '已验证结构并从PS输出。请查看合成与各层预览、局部参考，再提交逐层视觉检查。',
    };
  }
  verifyRegisteredMaterials(j, s);
  verifyCurrentAlphaDiagnostics(j, s);
  if (!s.inspection || fileHash(s.inspection.psdPath) !== s.inspection.hash)
    throw new Error('PSD 尚未检查或检查后已变化，请重新inspect');
  if (
    !s.quality ||
    Object.entries(s.quality.hashes).some(([p, h]) => !fs.existsSync(p) || fileHash(p) !== h)
  )
    throw new Error('实际渲染检查缺失或文件已变化，请重新inspect');
  if (input.action === 'review') {
    const l = s.plan.layers.find((l) => l.layerId === input.layerId);
    if (!l) throw new Error('图层不存在');
    if (input.review.status === 'accepted')
      requirePhotoshopAlphaPassed(s.quality.alphaDiagnostics, input.layerId);
    if (input.review.attempts.length > settings(j).maxAttempts)
      throw new Error('检查尝试次数超出设置');
    const m = s.materials[input.layerId];
    if (m?.upscaledPath && !input.materialChoice)
      throw new Error('请对比超分与原素材后声明实际使用upscaled或original');
    if (l.alphaChecks?.length && m && input.materialChoice && input.materialChoice !== (m.choice || 'original'))
      throw photoshopRepairError('区域诊断绑定实际置入版本，请先place-material及重新inspect，不能只修改审查版本');
    if (m && input.materialChoice && m.choice && m.choice !== input.materialChoice)
      throw new Error(
        '检查选择与实际置入版本不同，请先place-material再inspect，不能只更改审查声明',
      );
    if (m && input.materialChoice) m.choice = input.materialChoice;
    if (j.reconstructionWorkflowVersion === 4) {
      const r = input.checks.referenceComparison;
      if (!r || (l.textTargets.length && !r.typography))
        throw new Error(
          '需对原参考记录实际位置/占比、外观和文字字形变形比较；PS参数与自己的计划相同不代表匹配原图',
        );
      if (r.geometry === r.appearance) throw new Error('位置与外观检查不能复制同一模板');
      const elements = input.checks.elements || [];
      if (
        elements.length > 1 &&
        new Set(elements.map((e) => e.observation)).size !== elements.length
      )
        throw new Error('PS元素检查不能为所有对象复制同一句模板');
    }
    if ((l.content === 'text' || l.textTargets.length) && !input.checks.text)
      throw new Error('文字需记录实际字形、位置、颜色、变形及样式的检查，不能只看整图');
    if (
      input.review.status === 'accepted' &&
      s.quality.texts[input.layerId]?.some((t) => t.severeGeometry || t.appearanceMismatch?.length)
    )
      throw new Error('原生文字仍有明显几何错位；先调整或按不同方法尝试后标红，不可声明通过');
    if (j.reconstructionVersion === 3) {
      if (m?.generationId && input.review.status === 'accepted') {
        const r = registeredGeneration(j, m.generationId, [l.layerId], l.frame);
        if (!r.alignment && r.aspectError > 0.01 + 1e-12)
          throw new Error('生成原件比例偏差超过1%，请实际纠正定位或尝试后标红，不能直接声明通过');
      }
      const elements = input.checks.elements || [];
      if (
        input.checks.comparisonHash !== s.quality.comparisons?.[input.layerId]?.hash ||
        elements.length !== l.elements.length ||
        new Set(elements.map((e) => e.name)).size !== l.elements.length ||
        l.elements.some((name) => !elements.some((e) => e.name === name))
      )
        throw new Error(
          '请查看实际对比图并逐一检查计划中的全部元素，提交comparisonHash及完整elements',
        );
      if (input.review.status === 'accepted' && elements.some((e) => e.status !== 'matched'))
        throw new Error('存在缺失或明显不同元素，不能用笼统通过代替纠正或标红');
    }
    s.checks ??= {};
    s.checks[input.layerId] = input.checks;
    s.reviews[input.layerId] = input.review;
    if (m)
      m.upscaleEvidence =
        input.review.status === 'accepted'
          ? {
              workingHash: fileHash(m.workingPath || m.originalPath),
              psdPath: s.inspection.psdPath,
              psdHash: s.inspection.hash,
            }
          : undefined;
    s.compositeReview = undefined;
    put(j, s);
    return { saved: true };
  }
  if (input.action === 'review-composite') {
    if (j.reconstructionWorkflowVersion === 4) {
      const relations = input.relations || [];
      if (
        relations.length !== s.plan.relations.length ||
        new Set(relations.map((r) => r.id)).size !== relations.length ||
        s.plan.relations.some((r) => !relations.some((c) => c.id === r.id))
      )
        throw new Error('整图检查须覆盖计划中的接触、遮挡与光效归属关系');
      for (const r of relations.filter((r) => r.status === 'different')) {
        const plan = s.plan.relations.find((p) => p.id === r.id)!;
        if (!plan.layerIds.some((id) => s.reviews[id]?.status === 'needs-revision'))
          throw new Error('层间关系仍有问题，请将相关层标红后再回传');
      }
    }
    if (
      j.reconstructionVersion === 3 &&
      input.comparisonHash !== s.quality.comparisons?.composite.hash
    )
      throw new Error('请查看实际整图对比后提交其comparisonHash');
    if (s.plan.layers.some((l) => !s.reviews[l.layerId])) throw new Error('先完成所有图层检查');
    s.compositeReview = input.observation;
    put(j, s);
    return { saved: true };
  }
}

export async function completePhotoshop(j: Job, artifactPath: string) {
  const s = photoshopState(j);
  if(s.plan?.layers.some(l=>l.sourceProtection)) {
    const captured=JSON.stringify(s);
    await prepareGeneratedRoleConsumer(j,Object.values(s.materials).map(m=>m.generationId).filter((id):id is string=>!!id));
    if(JSON.stringify(photoshopState(j))!==captured)throw photoshopRepairError('PS完成预检期间完整计划/素材已变化');
  }
  if (
    j.reconstructionWorkflowVersion === 4 &&
    Object.entries(s.materials).some(
      ([id, m]) => m.needsUpscale && !m.upscaleApproved && s.reviews[id]?.status === 'accepted',
    )
  )
    throw new Error(
      '设置启用了按需超分：已通过的低分辨率素材请upscale-material、选择版本并重新置入/检查；问题层先保留待修改',
    );
  verifyRegisteredMaterials(j, s);
  verifyCurrentAlphaDiagnostics(j, s);
  requirePhotoshopAlphaPassed(s.quality?.alphaDiagnostics);
  if (
    !s.plan ||
    !s.inspection ||
    !s.compositeReview ||
    !s.quality ||
    s.version !== 2 ||
    s.plan.layers.some((l) => !s.reviews[l.layerId] || !s.checks?.[l.layerId])
  )
    throw new Error('PS 重建必须完成逐层计划、PS实际渲染、逐层检查和整图检查');
  if (
    path.resolve(artifactPath) !== s.inspection.psdPath ||
    fileHash(artifactPath) !== s.inspection.hash
  )
    throw new Error('回传必须使用最后一次inspect返回且未经修改的PSD副本');
  const size = s.plan.canvas || j.snapshot;
  if (Object.entries(s.quality.hashes).some(([p, h]) => !fs.existsSync(p) || fileHash(p) !== h))
    throw new Error('实际渲染证据已变化，请重新inspect');
  const parsed = validateNativeStructure(fs.readFileSync(artifactPath), s.plan, {
    ...j.snapshot,
    ...size,
  });
  const completedState = JSON.stringify(s);
  if (j.reconstructionVersion === 3) await verifyMaterialPlacement(parsed, s.plan, s.materials);
  if (j.reconstructionWorkflowVersion === 4)
    await verifyPreservedLayers(j, s.plan, s.inspection.thumbnails);
  if (s.plan.layers.some(l => l.alphaChecks?.length || l.sourceProtection)) {
    live(j);
    const latest = photoshopState(j);
    if (JSON.stringify(latest) !== completedState)
      throw new Error('完成校验期间PS计划、素材或审核已变化，请重新inspect及审核');
    verifyRegisteredMaterials(j, latest);
    verifyCurrentAlphaDiagnostics(j, latest);
    requirePhotoshopAlphaPassed(latest.quality?.alphaDiagnostics);
    if (Object.entries(latest.quality!.hashes).some(([p, h]) => !fs.existsSync(p) || fileHash(p) !== h))
      throw new Error('完成校验期间实际渲染证据已变化，请重新inspect');
  }
  const url = writeAsset(j.documentId, fs.readFileSync(s.inspection.previewPath), '.png');
  const psd = writeAsset(j.documentId, fs.readFileSync(artifactPath), '.psd');
  const layers: Layer[] = [];
  for (const l of s.plan.layers) {
    const prior = j.snapshot.layers.find((p) => p.id === l.layerId);
    const thumbnail = writeAsset(
      j.documentId,
      fs.readFileSync(s.inspection.thumbnails[l.layerId]),
      '.png',
    );
    layers.push({
      id: l.layerId,
      name: l.name,
      url: thumbnail,
      kind: 'raster',
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      frame: l.frame,
      visible: prior?.visible ?? true,
      opacity: parsed.children?.find((g) => g.name === photoshopGroupName(l.layerId))?.opacity ?? 1,
      opinion: prior?.opinion || '',
      disposition: 'rebuild',
      review: s.reviews[l.layerId],
    });
  }
  const image: CanvasImage = {
    ...structuredClone(j.snapshot),
    width: size.width,
    height: size.height,
    url,
    source: url,
    psdSource: psd,
    artifactUrl: psd,
    status: 'layered',
    layers,
    vectorLayers: undefined,
    vectorUrl: undefined,
    nativePsd: {
      version: 1,
      compositeUrl: url,
      mappings: s.plan.layers.map((l) => ({
        layerId: l.layerId,
        groupName: photoshopGroupName(l.layerId),
        editable: l.editable,
      })),
    },
  };
  const sx = size.width / j.snapshot.width,
    sy = size.height / j.snapshot.height;
  image.annotations = image.annotations.map((a) => ({
    ...a,
    points: a.points.map((n, i) => n * (i % 2 ? sy : sx)),
    labelPosition: a.labelPosition ? [a.labelPosition[0] * sx, a.labelPosition[1] * sy] : undefined,
    brushSize: a.brushSize === undefined ? undefined : a.brushSize * Math.sqrt(sx * sy),
  }));
  const review = applyLayerReviews(image, layers, j.snapshot);
  return { image, review };
}
