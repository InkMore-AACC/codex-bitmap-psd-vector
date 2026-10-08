import sharp from 'sharp';
import { generationPlan } from '../shared/generation-geometry.js';
type Pair = { source: [number, number]; target: [number, number] };
type Frame = { x: number; y: number; width: number; height: number };
/** Corresponding landmarks, never alpha-bounds recentering. Only one scale plus translation. */
export function landmarkTransform(points: Pair[], frame: { width: number; height: number }) {
  const mean = (side: 'source' | 'target', axis: number) =>
    points.reduce((s, p) => s + p[side][axis], 0) / points.length;
  const sx = mean('source', 0),
    sy = mean('source', 1),
    tx = mean('target', 0),
    ty = mean('target', 1);
  let xx = 0,
    yy = 0,
    numerator = 0;
  for (const p of points) {
    const x = p.source[0] - sx,
      y = p.source[1] - sy;
    xx += x * x;
    yy += y * y;
    numerator += x * (p.target[0] - tx) + y * (p.target[1] - ty);
  }
  if (points.length < 2 || xx + yy < 1)
    throw new Error('至少提供两个分散的对应定位点；水平文字允许共线，不能重复同一个点');
  const scale = numerator / (xx + yy),
    x = tx - scale * sx,
    y = ty - scale * sy;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('定位点不能形成有效等比变换');
  const residual = Math.max(
    ...points.map((p) =>
      Math.hypot(p.source[0] * scale + x - p.target[0], p.source[1] * scale + y - p.target[1]),
    ),
  );
  if (residual > Math.max(3, Math.min(frame.width, frame.height) * 0.02))
    throw new Error(
      '定位点误差无法由统一缩放和平移解释；疑似物体变形，需重新生成或标红，不能分别拉伸',
    );
  return { scale, x, y, residual };
}
export async function alignGeneration(
  bytes: Buffer,
  frame: Frame,
  points: Pair[],
  targetFrame: Frame = frame,
) {
  const meta = await sharp(bytes).metadata();
  if (
    !meta.width ||
    !meta.height ||
    points.some(
      (p) =>
        p.source[0] < 0 ||
        p.source[1] < 0 ||
        p.source[0] > meta.width! ||
        p.source[1] > meta.height! ||
        p.target[0] + frame.x < targetFrame.x ||
        p.target[1] + frame.y < targetFrame.y ||
        p.target[0] + frame.x > targetFrame.x + targetFrame.width ||
        p.target[1] + frame.y > targetFrame.y + targetFrame.height,
    )
  )
    throw new Error('定位点必须位于实际原始文件和冻结参考定位范围内');
  const transform = landmarkTransform(points, frame);
  // Retain the full file, including arbitrarily weak alpha outside the planned
  // frame. PSD pixel bounds may extend beyond the frozen design frame.
  const placementFrame = {
    x: Math.round(frame.x + transform.x),
    y: Math.round(frame.y + transform.y),
    width: Math.max(1, Math.round(meta.width * transform.scale)),
    height: Math.max(1, Math.round(meta.height * transform.scale)),
  };
  if (
    placementFrame.width * placementFrame.height > 40_000_000 ||
    Math.max(placementFrame.width, placementFrame.height) > 30000
  )
    throw new Error('定位后图层超过本地处理上限，请检查对应点单位');
  const target = generationPlan({ x: 0, y: 0, width: meta.width, height: meta.height });
  const output = await sharp(bytes)
    .resize({ width: target.size.width, height: target.size.height, fit: 'inside' })
    .ensureAlpha()
    .png()
    .toBuffer();
  const m = await sharp(output).metadata();
  return {
    bytes: output,
    transform,
    workingScale: target.scale,
    workingOffset: [0, 0],
    size: { width: m.width!, height: m.height! },
    placementFrame,
    points,
  };
}
