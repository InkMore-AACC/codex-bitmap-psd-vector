import type { LayerFrame } from './layer-frame.js';

export const GENERATION_PIXEL_BUDGET = 1_550_000;
export const ASPECT_TOLERANCE = 0.01;

/** File-canvas mapping, never an alpha bounding box or a subject detector. */
export function fitGeometry(
  source: { width: number; height: number },
  target: { width: number; height: number },
) {
  const scale = Math.min(target.width / source.width, target.height / source.height);
  const width = Math.min(target.width, Math.max(1, Math.round(source.width * scale)));
  const height = Math.min(target.height, Math.max(1, Math.round(source.height * scale)));
  return {
    scale,
    width,
    height,
    offsetX: Math.floor((target.width - width) / 2),
    offsetY: Math.floor((target.height - height) / 2),
  };
}
export function generationPlan(frame: LayerFrame) {
  const scale = Math.min(1, Math.sqrt(GENERATION_PIXEL_BUDGET / (frame.width * frame.height)));
  const size = {
    width: Math.max(1, Math.floor(frame.width * scale)),
    height: Math.max(1, Math.floor(frame.height * scale)),
  };
  // Anchor the shorter integer edge, then recompute the long edge. Rounding both
  // independently can itself exceed 1% for very narrow frames.
  if (scale < 1) {
    if (frame.width <= frame.height)
      size.height = Math.max(1, Math.floor((size.width * frame.height) / frame.width));
    else size.width = Math.max(1, Math.floor((size.height * frame.width) / frame.height));
  }
  const fit = fitGeometry(frame, size);
  return {
    pixelBudget: GENERATION_PIXEL_BUDGET,
    exceedsBudget: scale < 1,
    size,
    aspectRatio: frame.width / frame.height,
    scale: fit.scale,
    offsetX: fit.offsetX,
    offsetY: fit.offsetY,
    restoreScale: 1 / fit.scale,
    imageToGeneration: [
      fit.scale,
      0,
      0,
      fit.scale,
      fit.offsetX - frame.x * fit.scale,
      fit.offsetY - frame.y * fit.scale,
    ],
    instruction:
      '生成整个文件画幅，包括透明留白；不能裁透明边缘、按物体轮廓居中或铺满。坐标换算 u=(x-frame.x)*scale+offsetX，v=(y-frame.y)*scale+offsetY。最终按实际文件尺寸重新适配，预计倍率不是实际倍率。',
  };
}
export function generationPoint(frame: LayerFrame, x: number, y: number) {
  const p = generationPlan(frame);
  return [(x - frame.x) * p.scale + p.offsetX, (y - frame.y) * p.scale + p.offsetY];
}
export function aspectError(
  actual: { width: number; height: number },
  target: { width: number; height: number },
) {
  return Math.abs(actual.width / actual.height / (target.width / target.height) - 1);
}
