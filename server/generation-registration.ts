import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { pythonPath } from './models.js';
import { ROOT } from './store.js';
import { landmarkTransform } from './generation-alignment.js';

const point = z.tuple([z.number().finite(), z.number().finite()]);
const proposalSchema = z.object({
  accepted: z.boolean(),
  method: z.enum(['sift', 'orb', 'edge']),
  reason: z.string(),
  sourceSize: point,
  referenceSize: point,
  featureCounts: point,
  matchCount: z.number().int().nonnegative(),
  scope: z.string(),
  measurementSearchBox:z.tuple([z.number().finite().nonnegative(),z.number().finite().nonnegative(),z.number().finite().positive(),z.number().finite().positive()]).optional(),
  scale: z.number().finite().positive().optional(),
  translation: point.optional(),
  inlierCount: z.number().int().nonnegative().optional(),
  inlierRatio: z.number().min(0).max(1).optional(),
  sourceCoverage: point.optional(),
  sourceHullCoverage: z.number().finite().nonnegative().optional(),
  residualMedian: z.number().finite().nonnegative().optional(),
  residualP95: z.number().finite().nonnegative().optional(),
  residualThreshold: z.number().finite().positive().optional(),
  contourEvidence: z
    .object({
      meanDistance: z.number().finite().nonnegative(),
      coverage: z.number().min(0).max(1),
      minimumStripeCoverage: z.number().min(0).max(1),
      alternativeGap: z.number().finite().nonnegative(),
      orientationAgreement: z.number().min(0).max(1),
      targetAnalysisScale: z.number().positive().max(1),
      distinctPlacementPixels:z.number().positive().optional(),
      bestBounds:z.tuple([z.number(),z.number(),z.number().positive(),z.number().positive()]).optional(),
      alternativeBounds:z.tuple([z.number(),z.number(),z.number().positive(),z.number().positive()]).nullable().optional(),
    })
    .optional(),
  holdout: z.object({
    version: z.literal(1), split: z.literal('source-x-y-order-quarter-before-fit'),
    trainingCount: z.number().int().positive(), validationCount: z.number().int().positive(),
    passingCount: z.number().int().nonnegative(), passingRatio: z.number().min(0).max(1),
    sourceExtent: point, sourceCoverage: point, residualThreshold: z.number().finite().positive(),
    minimumPassingCount: z.literal(4), minimumPassingRatio: z.literal(0.6),
    minimumCoverage: z.literal(0.2), usedForFit: z.literal(false),
  }).optional(),
  attempts: z
    .array(
      z
        .object({
          method: z.enum(['sift', 'orb', 'edge']),
          accepted: z.boolean(),
          reason: z.string(),
        })
        .passthrough(),
    )
    .max(2)
    .optional(),
  points: z
    .array(
      z.object({
        source: point,
        target: point,
        inlier: z.boolean(),
        residual: z.number().finite().nonnegative(),
        role: z.enum(['fit', 'validation']).optional(),
      }),
    )
    .max(7000)
    .optional(),
});
export type RegistrationProposal = z.infer<typeof proposalSchema>;

/** Recheck actual held-out pairs and keep them out of the consumer's refit. */
export function registrationFitPoints(proposal: RegistrationProposal) {
  if (!proposal.accepted || !proposal.points?.length) throw new Error('自动定位提案未通过');
  if (proposal.method === 'edge') return proposal.points.filter(p => p.inlier);
  const check = proposal.holdout;
  const fit = proposal.points.filter(p => p.role === 'fit' && p.inlier);
  const reserved = proposal.points.filter(p => p.role === 'validation');
  if (!check || check.usedForFit !== false || fit.length < 12 ||
      reserved.length !== check.validationCount ||
      proposal.points.some(p => !p.role) ||
      proposal.points.filter(p => p.role === 'fit').length !== check.trainingCount)
    throw new Error('自动特征定位缺少拟合前保留的检验点；不以旧提案冒充交叉验证');
  const expected = [...proposal.points].sort((a, b) => a.source[0] - b.source[0] || a.source[1] - b.source[1]);
  if (expected.some((p, i) => p.role !== (i % 4 === 1 ? 'validation' : 'fit')))
    throw new Error('自动检验点划分不符合冻结测量规则');
  const transform = landmarkTransform(fit, { width: proposal.referenceSize[0], height: proposal.referenceSize[1] });
  const passing = reserved.filter(p => Math.hypot(
    p.source[0] * transform.scale + transform.x - p.target[0],
    p.source[1] * transform.scale + transform.y - p.target[1]) <= check.residualThreshold);
  const span = (axis: number) => passing.length < 2 ? 0 :
    (Math.max(...passing.map(p => p.source[axis])) - Math.min(...passing.map(p => p.source[axis]))) / check.sourceExtent[axis];
  const threshold = Math.max(2, Math.min(...proposal.referenceSize) * 0.003);
  if (check.residualThreshold !== threshold || check.sourceExtent.some(n => n <= 0) ||
      passing.length < 4 || passing.length / reserved.length < 0.6 || Math.min(span(0), span(1)) < 0.2)
    throw new Error('未参与拟合的特征不支持统一定位；保留原素材，不能用轮廓兜底掩盖内部偏差');
  return fit;
}

/** Optional local measurement. Unavailable dependencies never break generation. */
export async function registrationProposal(generated: string, reference: string, output: string,searchBox?:[number,number,number,number]) {
  const python = pythonPath();
  if (!python)
    return {
      available: false as const,
      reason: '未安装本地Python运行环境；保留现有位置，可使用人工定位。',
    };
  try {
    await promisify(execFile)(
      python,
      [
        '-X',
        'utf8',
        path.join(ROOT, 'python', 'generation_registration.py'),
        '--generated',
        generated,
        '--reference',
        reference,
        '--output',
        output,
        '--no-diagnostic',
        '--method',
        'auto',
        ...(searchBox?['--search-box',JSON.stringify(searchBox)]:[]),
      ],
      {
        cwd: ROOT,
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      },
    );
    const proposal=proposalSchema.parse(JSON.parse(fs.readFileSync(output, 'utf8')));
    if(JSON.stringify(proposal.measurementSearchBox)!==JSON.stringify(searchBox))throw new Error('测量搜索范围与冻结请求不一致');
    return {
      available: true as const,
      proposal,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      available: false as const,
      reason: /No module named ['"](?:cv2|numpy)/.test(message)
        ? '本地定位依赖未安装（OpenCV/NumPy）；可修复本地运行环境，当前素材和人工定位不受影响。'
        : '本地特征定位未完成；保留现有位置，可继续人工定位或标注待修。',
      detail: message.slice(0, 3000),
    };
  }
}
