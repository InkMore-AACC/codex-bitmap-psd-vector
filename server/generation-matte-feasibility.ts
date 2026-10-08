import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import type { GenerationAlphaCheck } from '../shared/generation.js';
import type { MatteBackdrop } from '../shared/generation.js';
import { mappedAlphaChecks, validateAlphaCheckScope } from './generation-alpha-checks.js';
import { restoreGeneration, GENERATION_RENDER_VERSION, type PlacementFrame } from './generation-placement.js';

const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
type Size = { width: number; height: number };
export type MatteFeasibilityInput = {
  workingPath: string; workingHash: string; workingSize: Size;
  placementFrame: PlacementFrame; sourceSize: Size; canvas: Size;
  checks: GenerationAlphaCheck[];
  matteBackdrop?: MatteBackdrop;
  whiteComposite?: boolean;
};
/** min(baseA,M) cannot supply missing alpha. This is only a necessary lower
 * bound, measured in the same real integer placement as composition. It says
 * nothing about a future matte, RGB, upper alpha or visual acceptance. */
export async function evaluateMatteFeasibility(input: MatteFeasibilityInput) {
  const snapshot = fs.readFileSync(input.workingPath), actualHash = digest(snapshot);
  if (actualHash !== input.workingHash) throw new Error('辅助matte必要条件检查的真实工作文件摘要已变化');
  if (!Object.values(input.placementFrame).every(Number.isInteger))
    throw new Error('辅助matte必要条件须使用已登记的真实整数放置');
  validateAlphaCheckScope(input.checks, input.sourceSize, { x: 0, y: 0, ...input.sourceSize });
  const regions = mappedAlphaChecks(input.checks, input.sourceSize, input.canvas)
    .filter(c => c.kind === 'transmissive' || c.kind === 'opaque');
  if (!regions.length || regions.reduce((n, c) => n + c.canvasBox[2] * c.canvasBox[3], 0) > 40_000_000)
    throw new Error('辅助matte必要条件须有4000万采样像素以内的冻结transmissive/opaque区域');
  const meta = await sharp(snapshot).metadata();
  if (meta.width !== input.workingSize.width || meta.height !== input.workingSize.height)
    throw new Error('辅助matte必要条件的完整工作carrier实际尺寸与登记不一致');
  const material = await restoreGeneration(snapshot, input.placementFrame);
  const { data, info } = await sharp(material.bytes).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const checks = regions.map(c => {
    const [x, y, w, h] = c.canvasBox;
    let eligiblePixels = 0;
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const mx = col - input.placementFrame.x, my = row - input.placementFrame.y;
      const alpha = mx < 0 || my < 0 || mx >= info.width || my >= info.height ? 0
        : data[(my * info.width + mx) * 4 + 3];
      if (alpha >= c.minAlpha) eligiblePixels++;
    }
    const pixels = w * h, requiredPixels = Math.max(1, Math.ceil(pixels * c.minPassingFraction));
    return { name: c.name, sourceBox: c.box, canvasBox: c.canvasBox, minAlpha: c.minAlpha,
      minPassingFraction: c.minPassingFraction, pixels, eligiblePixels, requiredPixels,
      necessaryConditionMet: eligiblePixels >= requiredPixels };
  });
  const knownBackdrop = input.matteBackdrop ? {
    color: input.whiteComposite ? '#ffffff' : input.matteBackdrop.color, maxChannelError: 2,
    checks: mappedAlphaChecks(input.checks, input.sourceSize, input.canvas).filter(c => c.kind === 'clear').map(c => {
      const [x, y, w, h] = c.canvasBox; let matchingPixels = 0;
      for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
        const mx = col - input.placementFrame.x, my = row - input.placementFrame.y;
        if (mx < 0 || my < 0 || mx >= info.width || my >= info.height) continue;
        const i = (my * info.width + mx) * 4;
        const background = input.whiteComposite ? 255 : input.matteBackdrop!.version === 2 ? 0 : 128;
        if (data[i + 3] === 255 && Math.max(...data.subarray(i, i + 3).map(v => Math.abs(v - background))) <= 2) matchingPixels++;
      }
      const pixels = w * h, requiredPixels = Math.max(1, Math.ceil(pixels * c.minPassingFraction));
      return { name: c.name, canvasBox: c.canvasBox, pixels, matchingPixels, requiredPixels,
        necessaryConditionMet: matchingPixels >= requiredPixels };
    }),
  } : undefined;
  if (knownBackdrop && !knownBackdrop.checks.length) throw new Error('已知底色必要条件须有事前冻结clear区域');
  if (digest(fs.readFileSync(input.workingPath)) !== actualHash)
    throw new Error('辅助matte必要条件检查期间真实工作文件已变化');
  return { version: 1 as const, renderVersion: GENERATION_RENDER_VERSION,
    algorithm: 'min-alpha-direct-gray-v1' as const,
    binding: { workingHash: actualHash, workingSize: input.workingSize, sourceSize: input.sourceSize,
      canvas: input.canvas, placementFrame: input.placementFrame }, materialHash: digest(material.bytes), checks,
    ...(knownBackdrop ? { knownBackdrop } : {}),
    necessaryConditionMet: checks.every(c => c.necessaryConditionMet) && (!knownBackdrop || knownBackdrop.checks.every(c => c.necessaryConditionMet)),
    note: '只检查减alpha算法的minAlpha必要条件；不预测未来matte成功，不等于alpha上限/响应、RGB或视觉通过。' };
}
export function requireMatteFeasibility(result: Awaited<ReturnType<typeof evaluateMatteFeasibility>>) {
  const backdropFailed = result.knownBackdrop?.checks.filter(c => !c.necessaryConditionMet) || [];
  if (backdropFailed.length) throw Object.assign(new Error(`已知底色RGB基底必要条件失败：冻结clear区域中原位RGB未保持${result.knownBackdrop!.color}±2，` +
    backdropFailed.map(c => `「${c.name}」仅${c.matchingPixels}/${c.pixels}像素相容，至少需${c.requiredPixels}`).join('；') +
    '。未创建辅助matte请求；先修复底色/基底方法，不能在追加模型调用后靠放宽误差、补alpha或截断RGB兜底。'), { status: 400 });
  const failed = result.checks.filter(c => !c.necessaryConditionMet);
  if (failed.length) throw Object.assign(new Error('aux-matte必要条件失败：min(baseA,M)只能减alpha，不能补回已清空材质；' +
    failed.map(c => `「${c.name}」真实放置alpha>=${c.minAlpha}仅${c.eligiblePixels}/${c.pixels}像素，至少需${c.requiredPixels}`).join('；') +
    '。未创建辅助请求；请保留普通RGB失败审核或先修复RGB基底，不能降低冻结标准。'), { status: 400 });
}
