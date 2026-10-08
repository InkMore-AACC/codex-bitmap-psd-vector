import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import sharp from 'sharp';
import { fitGeometry } from '../shared/generation-geometry.js';

export type PlacementFrame = { x: number; y: number; width: number; height: number };
export type BackgroundPadding = { left: number; top: number; right: number; bottom: number };
/** Display only: clipping the review viewport never clips the stored material. */
export async function placementPreview(
  bytes: Buffer,
  placement: PlacementFrame,
  viewport: PlacementFrame,
  outputSize?: { width: number; height: number },
) {
  const defaultScale = Math.min(1, 1536 / Math.max(viewport.width, viewport.height));
  const size = outputSize || {
    width: Math.max(1, Math.round(viewport.width * defaultScale)),
    height: Math.max(1, Math.round(viewport.height * defaultScale)),
  };
  const { scale, offsetX, offsetY } = fitGeometry(viewport, size);
  const c = createCanvas(size.width, size.height);
  const ctx = c.getContext('2d'),
    image = await loadImage(bytes);
  ctx.drawImage(
    image,
    (placement.x - viewport.x) * scale + offsetX,
    (placement.y - viewport.y) * scale + offsetY,
    placement.width * scale,
    placement.height * scale,
  );
  return c.toBuffer('image/png');
}
export function filePlacement(size: { width: number; height: number }, frame: PlacementFrame) {
  const fit = fitGeometry(size, frame);
  return {
    x: frame.x + fit.offsetX,
    y: frame.y + fit.offsetY,
    width: fit.width,
    height: fit.height,
  };
}
/** Only compensate a one-pixel budget-rounding gap when the untouched native
 * file already fills the same integer frame with a uniform contain projection.
 * Native ratio gaps are content problems, not permission to stretch or crop. */
export function backgroundPlacement(
  size: { width: number; height: number },
  originalSize: { width: number; height: number },
  frame: PlacementFrame,
): { placementFrame: PlacementFrame; backgroundPadding?: BackgroundPadding; problem?: string } {
  const placementFrame = filePlacement(size, frame);
  const dw = frame.width - placementFrame.width, dh = frame.height - placementFrame.height;
  const native = filePlacement(originalSize, frame);
  if (!dw && !dh && native.width === frame.width && native.height === frame.height)
    return { placementFrame };
  if (native.width === frame.width && native.height === frame.height && dw + dh === 1) {
    const left = placementFrame.x - frame.x, top = placementFrame.y - frame.y;
    return {
      placementFrame: { ...frame },
      backgroundPadding: { left, top, right: dw - left, bottom: dh - top },
    };
  }
  return {
    placementFrame,
    problem: native.width !== frame.width || native.height !== frame.height
      ? '背景原件等比投影未铺满冻结画幅；工作图取整不能掩盖真实比例缺口，请重新生成补全'
      : '背景工作图等比投影未铺满冻结画幅；缺口超过单像素取整补偿范围，请重新生成补全',
  };
}
// Bump when materialization changes: approvals made with another renderer must
// not silently authorize different final pixels.
export const GENERATION_RENDER_VERSION = 3;
/** Materialize the already approved integer projection exactly once. Width and
 * height are the rounded result of a uniform transform, not another fit target.
 * Repeating contain here can lose a pixel after the working-file budget resize.
 * Both composite review and delivery consume these same rasterized bytes. */
export async function restoreGeneration(
  workingInput: string | Buffer, placement: PlacementFrame, backgroundPadding?: BackgroundPadding,
) {
  const input = typeof workingInput === 'string' ? fs.readFileSync(workingInput) : workingInput,
    image = await loadImage(input);
  const { width, height } = placement;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 40_000_000 ||
    Math.max(width, height) > 30000
  )
    throw new Error('最终生成素材的整数画幅超出范围');
  if (backgroundPadding) {
    const { left, top, right, bottom } = backgroundPadding;
    if (Object.values(backgroundPadding).some(v => !Number.isInteger(v) || v < 0) ||
        left + top + right + bottom !== 1)
      throw new Error('背景补边仅允许已登记的单行或单列整数取整缺口');
    const contentWidth = width - left - right, contentHeight = height - top - bottom;
    if (contentWidth < 1 || contentHeight < 1) throw new Error('背景补边内容画幅无效');
    // Specify only the limiting edge: this is one uniform resize, never fill.
    const content = await sharp(input)
      .resize(left || right ? { height: contentHeight } : { width: contentWidth })
      .ensureAlpha().png().toBuffer();
    const meta = await sharp(content).metadata(), stats = await sharp(content).stats();
    if (meta.width !== contentWidth || meta.height !== contentHeight || stats.channels[3].min !== 255)
      throw new Error('背景补边等比尺寸或不透明度已改变，请重新登记并审核');
    return {
      bytes: await sharp(content).extend({ ...backgroundPadding, extendWith: 'copy' }).png().toBuffer(),
      bounds: { ...placement },
      scale: left || right ? contentHeight / image.height : contentWidth / image.width,
    };
  }
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  return {
    bytes: image.width === width && image.height === height ? input : canvas.toBuffer('image/png'),
    bounds: { ...placement },
    // Descriptive nominal factor only; do not use it for a second resampling.
    scale:
      (image.width * width + image.height * height) /
      (image.width * image.width + image.height * image.height),
  };
}
