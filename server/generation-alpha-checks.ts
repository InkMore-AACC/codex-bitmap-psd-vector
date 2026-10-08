import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { ordinaryGenerationAlphaCheckSchema, type GenerationAlphaCheck } from '../shared/generation.js';
import { restoreGeneration, GENERATION_RENDER_VERSION, type PlacementFrame } from './generation-placement.js';

type Size = { width: number; height: number };
type Box = [number, number, number, number];
export type AlphaCheckInput = {
  checks: GenerationAlphaCheck[];
  sourceSize: Size;
  canvas: Size;
  originalHash: string;
  workingHash: string;
  workingPath: string;
  placementFrame: PlacementFrame;
};
const digest = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');
export const GENERATION_ALPHA_DIAGNOSTIC_VERSION = 2;

export function validateAlphaCheckScope(checks: GenerationAlphaCheck[], image: Size, owner: PlacementFrame) {
  if (new Set(checks.map(c => c.name)).size !== checks.length) throw new Error('区域alpha检查名称重复');
  let pixels = 0;
  for (const raw of checks) {
    const c = ordinaryGenerationAlphaCheckSchema.parse(raw), [x, y, w, h] = c.box;
    if (x + w > image.width || y + h > image.height ||
        x < owner.x || y < owner.y || x + w > owner.x + owner.width || y + h > owner.y + owner.height)
      throw new Error(`区域alpha检查「${c.name}」须在当前图片及本组来源层冻结框内；不能使用屏幕或其他图层坐标`);
    pixels += w * h;
  }
  if (pixels > 40_000_000) throw new Error('区域alpha检查总采样范围超过4000万像素');
}

export function mappedAlphaChecks(checks: GenerationAlphaCheck[], sourceSize: Size, canvas: Size) {
  if (![sourceSize.width, sourceSize.height, canvas.width, canvas.height]
      .every(v => Number.isInteger(v) && v > 0)) throw new Error('区域alpha检查的图片及输出尺寸须为正整数');
  const sx = canvas.width / sourceSize.width, sy = canvas.height / sourceSize.height;
  return checks.map(c => {
    const [x, y, w, h] = c.box;
    // Sample every real raster pixel touched by the projected source rectangle.
    // Rounding a subpixel box to min1 must never invent an outside-canvas pixel.
    const left = Math.max(0, Math.min(canvas.width, Math.floor(x * sx)));
    const top = Math.max(0, Math.min(canvas.height, Math.floor(y * sy)));
    const right = Math.max(0, Math.min(canvas.width, Math.ceil((x + w) * sx)));
    const bottom = Math.max(0, Math.min(canvas.height, Math.ceil((y + h) * sy)));
    if (right <= left || bottom <= top) throw new Error(`区域alpha检查「${c.name}」没有真实输出像素`);
    return { ...c, canvasBox: [left, top, right - left, bottom - top] as Box };
  });
}

/** Source-image coordinates -> frozen output canvas -> requested generation file.
 * Keep fractional file coordinates; they are guidance, not marks to rasterize. */
export function generationAlphaCheckRegions(checks: GenerationAlphaCheck[], sourceSize: Size,
  canvas: Size, carrier: { frame: PlacementFrame; scale: number; offsetX: number; offsetY: number }) {
  return mappedAlphaChecks(checks, sourceSize, canvas).map(c => {
    const [x, y, w, h] = c.canvasBox;
    return { ...c, generationBox: [
      (x - carrier.frame.x) * carrier.scale + carrier.offsetX,
      (y - carrier.frame.y) * carrier.scale + carrier.offsetY,
      w * carrier.scale, h * carrier.scale,
    ] as Box };
  });
}

export function alphaDiagnosticSignature(input: Omit<AlphaCheckInput, 'workingPath'>) {
  return digest(JSON.stringify({ version: GENERATION_ALPHA_DIAGNOSTIC_VERSION, renderVersion: GENERATION_RENDER_VERSION,
    checks: input.checks, sourceSize: input.sourceSize, canvas: input.canvas,
    originalHash: input.originalHash, workingHash: input.workingHash, placementFrame: input.placementFrame }));
}

export type GenerationAlphaDiagnostics = Awaited<ReturnType<typeof evaluateGenerationAlphaChecks>>;
/** Measure the same complete integer material used by ordinary composition.
 * Outside its placement is alpha0. An empty region can pass clear, never transmissive. */
export async function evaluateGenerationAlphaChecks(input: AlphaCheckInput) {
  const workingSnapshot = fs.readFileSync(input.workingPath), actualHash = digest(workingSnapshot);
  if (actualHash !== input.workingHash) throw new Error('区域alpha诊断的工作文件摘要已改变');
  validateAlphaCheckScope(input.checks, input.sourceSize, { x: 0, y: 0, ...input.sourceSize });
  const regions = mappedAlphaChecks(input.checks, input.sourceSize, input.canvas);
  if (regions.reduce((n, c) => n + c.canvasBox[2] * c.canvasBox[3], 0) > 40_000_000)
    throw new Error('输出区域alpha检查总采样范围超过4000万像素');
  const material = await restoreGeneration(workingSnapshot, input.placementFrame);
  const { data, info } = await sharp(material.bytes).toColourspace('srgb').ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const results = regions.map(c => {
    const [x, y, w, h] = c.canvasBox, histogram = new Array<number>(256).fill(0);
    let sum = 0, passingPixels = 0;
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const mx = col - input.placementFrame.x, my = row - input.placementFrame.y;
      const a = mx < 0 || my < 0 || mx >= info.width || my >= info.height ? 0
        : data[(my * info.width + mx) * 4 + 3];
      histogram[a]++; sum += a;
      // Standard source-over black/white RGB difference = 255-alpha. This is
      // a mathematical background response, not measured optical transmission.
      const response = 255 - a;
      if (c.kind === 'opaque' || c.kind === 'occupied' ? a >= c.minAlpha : a <= c.maxAlpha && (c.kind === 'clear' ||
          (a >= c.minAlpha && response >= c.minBackgroundResponse))) passingPixels++;
    }
    const pixels = w * h, nonzero = histogram.map((n, a) => n ? a : -1).filter(a => a >= 0);
    const min = nonzero[0], max = nonzero.at(-1)!;
    const quantile = (fraction: number) => {
      let count = 0;
      for (let a = 0; a <= 255; a++) if ((count += histogram[a]) >= Math.ceil(pixels * fraction)) return a;
      return 255;
    };
    const passingFraction = passingPixels / pixels;
    const requiredPassingPixels = Math.max(1, Math.ceil(pixels * c.minPassingFraction));
    return { ...c, materialBox: [x - input.placementFrame.x, y - input.placementFrame.y, w, h] as Box,
      pixels, alpha: { min, max, mean: sum / pixels, p05: quantile(0.05), median: quantile(0.5),
        p95: quantile(0.95), zeroFraction: histogram[0] / pixels, opaqueFraction: histogram[255] / pixels },
      backgroundResponse: { model: 'standard-source-over-black-white' as const, backgrounds: ['#000000', '#ffffff'],
        min: 255 - max, max: 255 - min, mean: 255 - sum / pixels },
      passingPixels, requiredPassingPixels, passingFraction, passed: passingPixels >= requiredPassingPixels };
  });
  if (digest(fs.readFileSync(input.workingPath)) !== input.workingHash)
    throw new Error('区域alpha诊断期间工作文件已改变，未保存检查；请使用当前文件重新登记');
  return { version: GENERATION_ALPHA_DIAGNOSTIC_VERSION, signature: alphaDiagnosticSignature(input),
    binding: { diagnosticVersion: GENERATION_ALPHA_DIAGNOSTIC_VERSION, renderVersion: GENERATION_RENDER_VERSION,
      originalHash: input.originalHash, workingHash: input.workingHash, workingSnapshotHash: actualHash,
      sourceSize: input.sourceSize, canvas: input.canvas,
      placementFrame: input.placementFrame }, materialHash: digest(material.bytes),
    checks: results, passed: results.every(c => c.passed),
    note: '标准黑白底响应由实际放置RGBA按source-over数学计算；不是从单张扁平原图推断的真实光学透射率。区域通过不证明纹理、外观或整体视觉一致。' };
}
