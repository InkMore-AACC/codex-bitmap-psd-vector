import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import type { PhotoshopPlan } from '../shared/photoshop.js';
import { generationAlphaCheckSchema } from '../shared/generation.js';
import { layerFrame } from '../shared/layer-frame.js';
import type { Job } from './types.js';
import { extractionSources } from './photoshop-extraction-provenance.js';
import type { NativeRender } from './photoshop-native.js';
import {
  alphaDiagnosticSignature,
  evaluateGenerationAlphaChecks,
  GENERATION_ALPHA_DIAGNOSTIC_VERSION,
  validateAlphaCheckScope,
  type GenerationAlphaDiagnostics,
} from './generation-alpha-checks.js';

const digest = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');
const signature = (value: unknown) => digest(JSON.stringify(value));
const fail = (message: string) => Object.assign(new Error(message), { status: 400 });
const fileBinding = (file: string) => ({ path: path.resolve(file), hash: digest(fs.readFileSync(file)) });
export const PHOTOSHOP_ALPHA_DIAGNOSTIC_VERSION = 1;
type Entry = PhotoshopPlan['layers'][number];
type AlphaMaterial = {
  provenance: string;
  status: string;
  originalPath: string;
  workingPath?: string;
  upscaledPath?: string;
  choice?: 'original' | 'upscaled';
  generationId?: string;
  placementFrame?: Entry['frame'];
  originalSize: { width: number; height: number };
  workingSize?: { width: number; height: number };
  repair?: unknown;
  extraction?: unknown;
  receipt?: unknown;
};
function sourceOwner(j: Job, plan: PhotoshopPlan, entry: Entry) {
  const prior = j.snapshot.layers.find(l => l.id === entry.layerId), canvas = plan.canvas || j.snapshot;
  return prior ? layerFrame(prior, j.snapshot) : {
    x: entry.frame.x * j.snapshot.width / canvas.width,
    y: entry.frame.y * j.snapshot.height / canvas.height,
    width: entry.frame.width * j.snapshot.width / canvas.width,
    height: entry.frame.height * j.snapshot.height / canvas.height,
  };
}

/** The checks own source-image pixels; the plan frame already lives on the PS canvas. */
export function validatePhotoshopAlphaCheckScope(j: Job, plan: PhotoshopPlan) {
  for (const entry of plan.layers.filter(l => l.alphaChecks?.length)) {
    // Even an unparsed persisted plan cannot acquire ordinary-only opaque rules.
    for (const check of entry.alphaChecks!) generationAlphaCheckSchema.parse(check);
    if (j.reconstructionVersion !== 3 || j.reconstructionWorkflowVersion !== 4 ||
        entry.surface !== 'transparent' || entry.content === 'background')
      throw fail('PS区域alpha约束仅支持新v4透明前景计划；背景、screen及旧协议不能声明');
    if (j.layerIds?.length && !j.layerIds.includes(entry.layerId))
      throw fail('PS区域alpha约束不能扩大本任务冻结图层范围');
    validateAlphaCheckScope(entry.alphaChecks!, j.snapshot, sourceOwner(j, plan, entry));
  }
}

/** Capture before Adobe/render awaits. Review/upscale approvals are deliberately excluded. */
export function capturePhotoshopAlphaContext(j: Job, plan: PhotoshopPlan,
  materials: Record<string, AlphaMaterial>, selectedIds?: string[]) {
  const entries = plan.layers.filter(l => l.alphaChecks?.length && (!selectedIds || selectedIds.includes(l.layerId)));
  if (!entries.length) return undefined;
  validatePhotoshopAlphaCheckScope(j, plan);
  const sources = extractionSources(j);
  return {
    version: PHOTOSHOP_ALPHA_DIAGNOSTIC_VERSION,
    samplingVersion: GENERATION_ALPHA_DIAGNOSTIC_VERSION,
    taskId: j.taskId, jobId: j.id, documentId: j.documentId,
    sourceSize: { width: j.snapshot.width, height: j.snapshot.height },
    canvas: plan.canvas || { width: j.snapshot.width, height: j.snapshot.height },
    planHash: signature(plan),
    source: fileBinding(sources.source), auxiliaryOriginal: fileBinding(sources.auxiliaryOriginal),
    layers: Object.fromEntries(entries.map(entry => {
      const m = materials[entry.layerId];
      const material = m ? {
        provenance: m.provenance, status: m.status, generationId: m.generationId,
        original: fileBinding(m.originalPath), working: fileBinding(m.workingPath || m.originalPath),
        choice: m.choice || 'original',
        selected: fileBinding(m.choice === 'upscaled' ? m.upscaledPath || '' : m.workingPath || m.originalPath),
        placementFrame: m.placementFrame || entry.frame,
        originalSize: m.originalSize, workingSize: m.workingSize,
        repairHash: m.repair ? signature(m.repair) : undefined,
        extractionHash: m.extraction ? signature(m.extraction) : undefined,
        receiptHash: m.receipt ? signature(m.receipt) : undefined,
      } : undefined;
      return [entry.layerId, { checks: entry.alphaChecks!, sourceOwner: sourceOwner(j, plan, entry), material }];
    })),
  };
}
export type PhotoshopAlphaContext = NonNullable<ReturnType<typeof capturePhotoshopAlphaContext>>;
function provenance(context: PhotoshopAlphaContext, render: NativeRender, layerId: string) {
  return { context, layerId, psd: fileBinding(render.psdPath), group: fileBinding(render.thumbnails[layerId]) };
}
function samplingInput(context: PhotoshopAlphaContext, group: { path: string; hash: string }, layerId: string) {
  return { checks: context.layers[layerId].checks, sourceSize: context.sourceSize, canvas: context.canvas,
    originalHash: context.source.hash, workingHash: group.hash, workingPath: group.path,
    placementFrame: { x: 0, y: 0, ...context.canvas } };
}
export type PhotoshopAlphaDiagnostic = {
  version: typeof PHOTOSHOP_ALPHA_DIAGNOSTIC_VERSION;
  signature: string;
  provenance: ReturnType<typeof provenance>;
  sampling: GenerationAlphaDiagnostics;
  passed: boolean;
};

/** Sample real per-group transparent, full-canvas PS exports, never generation carriers. */
export async function inspectPhotoshopAlphaChecks(context: PhotoshopAlphaContext | undefined, render: NativeRender) {
  if (!context) return undefined;
  const results: Record<string, PhotoshopAlphaDiagnostic> = {};
  for (const layerId of Object.keys(context.layers)) {
    const binding = provenance(context, render, layerId);
    if (binding.psd.hash !== render.hash) throw fail('PS区域检查期间PSD已变化，请重新inspect');
    const snapshot = fs.readFileSync(binding.group.path);
    if (digest(snapshot) !== binding.group.hash) throw fail('PS区域检查的组PNG已变化');
    const meta = await sharp(snapshot).metadata();
    if (meta.width !== context.canvas.width || meta.height !== context.canvas.height)
      throw fail('PS区域检查需要真实完整画布透明组PNG，不能缩放局部素材冒充PS结果');
    const sampling = await evaluateGenerationAlphaChecks(samplingInput(context, binding.group, layerId));
    results[layerId] = { version: PHOTOSHOP_ALPHA_DIAGNOSTIC_VERSION,
      signature: signature(binding), provenance: binding, sampling, passed: sampling.passed };
  }
  return results;
}

/** Missing/old diagnostics cannot grant acceptance. File digests are re-read at every consumer. */
export function verifyPhotoshopAlphaChecks(context: PhotoshopAlphaContext | undefined, render: NativeRender,
  diagnostics: Record<string, PhotoshopAlphaDiagnostic> | undefined) {
  if (!context) return;
  for (const layerId of Object.keys(context.layers)) {
    const expected = provenance(context, render, layerId), d = diagnostics?.[layerId];
    if (!d || d.version !== PHOTOSHOP_ALPHA_DIAGNOSTIC_VERSION ||
        expected.psd.hash !== render.hash || d.signature !== signature(expected) ||
        signature(d.provenance) !== d.signature ||
        d.sampling?.version !== GENERATION_ALPHA_DIAGNOSTIC_VERSION ||
        d.sampling.signature !== alphaDiagnosticSignature(samplingInput(context, expected.group, layerId)) ||
        d.sampling.binding.workingSnapshotHash !== expected.group.hash ||
        d.passed !== d.sampling.passed ||
        d.sampling.checks.length !== context.layers[layerId].checks.length ||
        d.passed !== d.sampling.checks.every(c => c.passed))
      throw fail('PS区域alpha诊断缺失、版本旧或来源/计划/素材/位置/PSD/组PNG已变化，请重新inspect');
  }
}

export function requirePhotoshopAlphaPassed(diagnostics: Record<string, PhotoshopAlphaDiagnostic> | undefined, layerId?: string) {
  const failures = Object.entries(diagnostics || {}).filter(([id]) => !layerId || id === layerId)
    .flatMap(([id, d]) => d.sampling.checks.filter(c => !c.passed).map(c => `${id}/${c.name}`));
  if (failures.length) throw fail(`PS区域alpha检查未通过：${failures.join('、')}；可如实needs-revision，不能accepted或完成`);
}
