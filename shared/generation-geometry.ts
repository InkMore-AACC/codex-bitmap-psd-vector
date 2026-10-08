import type { LayerFrame } from './layer-frame.js';

export const GENERATION_PIXEL_BUDGET = 1_500_000;
export const ASPECT_TOLERANCE = 0.01;

/** Aspect caps are packaging choices, not claimed image model limits.
 * Transparent artwork keeps 3:1; screen light requests may use 2.5:1. */
export function generationCarrier(frame: LayerFrame, enabled = true, maxAspect: 2.5 | 3 = 3,
  contextMargin = 0) {
  if (!Number.isSafeInteger(contextMargin) || contextMargin < 0 || contextMargin > 128 ||
      (!enabled && contextMargin)) throw new Error('周边参考须在启用承载时显式指定1至128像素边距');
  const contextWidth = frame.width + contextMargin * 2;
  const contextHeight = frame.height + contextMargin * 2;
  // Never turn a very thin, huge frame into an unbounded restoration canvas.
  if (
    Math.max(contextWidth, Math.ceil(contextHeight / maxAspect)) *
      Math.max(contextHeight, Math.ceil(contextWidth / maxAspect)) >
    40_000_000
  ) {
    if (contextMargin) throw new Error('周边参考承载超出4000万设计像素范围');
    enabled = false;
  }
  const width = enabled ? Math.max(contextWidth, Math.ceil(contextHeight / maxAspect)) : frame.width;
  const height = enabled ? Math.max(contextHeight, Math.ceil(contextWidth / maxAspect)) : frame.height;
  const carrierFrame = {
    x: frame.x - Math.floor((width - frame.width) / 2),
    y: frame.y - Math.floor((height - frame.height) / 2),
    width,
    height,
  };
  return {
    ...generationPlan(carrierFrame),
    frame: carrierFrame,
    artwork: {
      x: frame.x - carrierFrame.x,
      y: frame.y - carrierFrame.y,
      width: frame.width,
      height: frame.height,
    },
    expanded: width !== frame.width || height !== frame.height,
  };
}

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
export function generationPlan(frame: LayerFrame, _legacyBudget = GENERATION_PIXEL_BUDGET) {
  // A single project contract, including transparent pixels. Old saved budgets
  // must never silently change the budget of new or resumed reconstruction jobs.
  const pixelBudget = GENERATION_PIXEL_BUDGET;
  const scale = Math.min(1, Math.sqrt(pixelBudget / (frame.width * frame.height)));
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
  if (size.width * size.height > pixelBudget)
    throw new Error(
      '画幅比例过于狭长，无法同时保持整数等比尺寸与150万像素上限；请使用带留白的承载画幅，原件保持不变',
    );
  const fit = fitGeometry(frame, size);
  return {
    pixelBudget,
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
export function generationPoint(
  frame: LayerFrame,
  x: number,
  y: number,
  pixelBudget = GENERATION_PIXEL_BUDGET,
) {
  const p = generationPlan(frame, pixelBudget);
  return [(x - frame.x) * p.scale + p.offsetX, (y - frame.y) * p.scale + p.offsetY];
}
export function aspectError(
  actual: { width: number; height: number },
  target: { width: number; height: number },
) {
  return Math.abs(actual.width / actual.height / (target.width / target.height) - 1);
}
