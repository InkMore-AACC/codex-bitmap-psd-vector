/** Local material repair replaces RGBA, including transparent holes. It never
 * source-over composites a new patch on top of stale translucent pixels. */
export type RepairFrame = { x: number; y: number; width: number; height: number };
export type RepairRgba = {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
};
export const MATERIAL_REPAIR_PIXEL_BUDGET = 1_500_000;

function checkImage(image: RepairRgba, name: string) {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > MATERIAL_REPAIR_PIXEL_BUDGET ||
    image.data.length !== image.width * image.height * 4
  )
    throw new Error(`${name} must be a complete RGBA carrier within the 1500000-pixel budget`);
}

function checkFrame(frame: RepairFrame) {
  if (
    ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) ||
    frame.width <= 0 ||
    frame.height <= 0
  )
    throw new Error('Invalid material repair frame');
}

/** No guessed inverse transforms: rotated, skewed or warped quads need a
 * separate, explicitly verified resampling path. */
export function axisAlignedRepairFrame(quad: number[]): RepairFrame {
  const equal = (a: number, b: number) => Math.abs(a - b) <= 0.000001;
  if (
    quad.length !== 8 ||
    !quad.every(Number.isFinite) ||
    !equal(quad[0], quad[6]) ||
    !equal(quad[1], quad[3]) ||
    !equal(quad[2], quad[4]) ||
    !equal(quad[5], quad[7])
  )
    throw new Error('Material repair requires a verified axis-aligned full-file quad');
  const frame = { x: quad[0], y: quad[1], width: quad[2] - quad[0], height: quad[7] - quad[1] };
  checkFrame(frame);
  return frame;
}

/** Sample in premultiplied space so RGB in transparent pixels cannot create a
 * colour fringe. File edges are retained; alpha bounds are never used. */
function sample(image: RepairRgba, u: number, v: number) {
  const x = Math.max(0, Math.min(image.width - 1, u));
  const y = Math.max(0, Math.min(image.height - 1, v));
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, image.width - 1),
    y1 = Math.min(y0 + 1, image.height - 1);
  const fx = x - x0,
    fy = y - y0;
  const points = [
    [x0, y0, (1 - fx) * (1 - fy)],
    [x1, y0, fx * (1 - fy)],
    [x0, y1, (1 - fx) * fy],
    [x1, y1, fx * fy],
  ];
  const out = [0, 0, 0, 0];
  for (const [px, py, weight] of points) {
    const k = (py * image.width + px) * 4;
    const a = (image.data[k + 3] / 255) * weight;
    out[3] += a;
    for (let c = 0; c < 3; c++) out[c] += image.data[k + c] * a;
  }
  return out;
}

/** The mask is explicit replacement coverage in the complete base carrier,
 * not inferred from patch alpha. Core mask=255 takes patch transparency too;
 * mask=0 preserves every original channel exactly. */
export function replaceLocalMaterialRgba(input: {
  base: RepairRgba;
  patch: RepairRgba;
  baseFrame: RepairFrame;
  patchFrame: RepairFrame;
  mask: Uint8Array | Uint8ClampedArray;
}) {
  const { base, patch, baseFrame, patchFrame, mask } = input;
  checkImage(base, 'Base');
  checkImage(patch, 'Patch');
  checkFrame(baseFrame);
  checkFrame(patchFrame);
  if (mask.length !== base.width * base.height)
    throw new Error('Replacement mask must cover the full base carrier');
  const data = new Uint8Array(base.data);
  const stats = {
    changedPixels: 0,
    coveredPixels: 0,
    corePixels: 0,
    featherPixels: 0,
    alphaDecreasedPixels: 0,
  };
  for (let y = 0; y < base.height; y++)
    for (let x = 0; x < base.width; x++) {
      const pixel = y * base.width + x,
        coverage = mask[pixel];
      if (!coverage) continue;
      const dx = baseFrame.x + ((x + 0.5) / base.width) * baseFrame.width;
      const dy = baseFrame.y + ((y + 0.5) / base.height) * baseFrame.height;
      if (
        dx < patchFrame.x ||
        dy < patchFrame.y ||
        dx >= patchFrame.x + patchFrame.width ||
        dy >= patchFrame.y + patchFrame.height
      )
        throw new Error('Replacement mask extends outside the verified patch carrier');
      const p = sample(
        patch,
        ((dx - patchFrame.x) / patchFrame.width) * patch.width - 0.5,
        ((dy - patchFrame.y) / patchFrame.height) * patch.height - 0.5,
      );
      const k = pixel * 4,
        w = coverage / 255,
        aBase = base.data[k + 3] / 255;
      const alpha = (1 - w) * aBase + w * p[3];
      data[k + 3] = Math.round(alpha * 255);
      for (let c = 0; c < 3; c++)
        data[k + c] =
          alpha > 0 ? Math.round(((1 - w) * base.data[k + c] * aBase + w * p[c]) / alpha) : 0;
      stats.coveredPixels++;
      if (coverage === 255) stats.corePixels++;
      else stats.featherPixels++;
      if (data[k + 3] < base.data[k + 3]) stats.alphaDecreasedPixels++;
      if ([0, 1, 2, 3].some((c) => data[k + c] !== base.data[k + c])) stats.changedPixels++;
    }
  return { image: { width: base.width, height: base.height, data }, stats };
}
