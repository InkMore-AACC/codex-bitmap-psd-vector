import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { GENERATION_PIXEL_BUDGET } from '../shared/generation-geometry.js';

type Frame = { x: number; y: number; width: number; height: number };
type Detail = { name: string; box: [number, number, number, number]; observation: string };
export const DETAIL_REFERENCE_PIXEL_BUDGET = 262144;
const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });

// One complete reference, for presentation only. Interpolation adds no source detail.
export async function prepareReferencePresentation(localPath: string, scale: number,
  folder: string, requestId: string) {
  if (!Number.isInteger(scale) || scale < 2 || scale > 4) throw invalid('完整参考呈现倍率须为2至4的整数');
  const input = fs.readFileSync(localPath), sourceHash = digest(input), meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw invalid('完整参考缺少真实尺寸');
  const size = { width: meta.width * scale, height: meta.height * scale };
  if (size.width * size.height > GENERATION_PIXEL_BUDGET)
    throw invalid('放大后的完整参考含留白不能超过150万像素；显式降低倍率，不自动裁边或改倍率');
  const bytes = await sharp(input).resize({ ...size, kernel: 'lanczos3' }).png().toBuffer();
  if (digest(fs.readFileSync(localPath)) !== sourceHash) throw invalid('放大呈现期间干净完整参考已变化');
  const file = path.join(folder, `${requestId}-whole-reference.png`);
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' });
  return { path: file, hash: digest(bytes), sourcePath: localPath, sourceHash,
    sourceSize: { width: meta.width, height: meta.height }, size, scale,
    kernel: 'lanczos3' as const, coordinateSpace: 'whole-local-file-normalized' as const };
}

// Clean reference packaging only. Never produces a material, mask or placement.
export async function prepareDetailReferences(
  localPath: string, frame: Frame, canvas: { width: number; height: number },
  details: Detail[], folder: string, requestId: string,
) {
  if (!details.length || details.length > 3 || new Set(details.map(d => d.name)).size !== details.length)
    throw invalid('细节参考须有1至3个不同名称');
  const input = fs.readFileSync(localPath), sourceHash = digest(input);
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw new Error('细节参考缺少真实干净构图文件');
  const crops = details.map(d => {
    const [x, y, width, height] = d.box;
    if (!d.box.every(Number.isSafeInteger) || width <= 0 || height <= 0 ||
      x < 0 || y < 0 || x + width > canvas.width || y + height > canvas.height ||
      x < frame.x || y < frame.y || x + width > frame.x + frame.width || y + height > frame.y + frame.height)
      throw invalid('细节参考box须在最终整图及冻结本层frame内，不能采样画外留白');
    const left = Math.floor((x - frame.x) * meta.width! / frame.width);
    const top = Math.floor((y - frame.y) * meta.height! / frame.height);
    const right = Math.ceil((x + width - frame.x) * meta.width! / frame.width);
    const bottom = Math.ceil((y + height - frame.y) * meta.height! / frame.height);
    return { ...d, crop: { left, top, width: right - left, height: bottom - top } };
  });
  const pixels = crops.reduce((n, d) => n + d.crop.width * d.crop.height, 0);
  if (pixels > DETAIL_REFERENCE_PIXEL_BUDGET)
    throw invalid('细节参考合计不能超过262144真实输入像素；缩小选择范围，不自动缩图');
  const encoded = await Promise.all(crops.map(d => sharp(input).extract(d.crop).png().toBuffer()));
  if (digest(fs.readFileSync(localPath)) !== sourceHash) throw new Error('准备细节期间干净构图参考已变化');
  const records = crops.map((d, index) => ({ ...d,
    path: path.join(folder, `${requestId}-detail-${index + 1}.png`),
    hash: digest(encoded[index]), sourcePath: localPath, sourceHash,
    coordinateSpace: 'final-canvas-pixels' as const,
  }));
  fs.mkdirSync(folder, { recursive: true });
  records.forEach((d, i) => fs.writeFileSync(d.path, encoded[i], { flag: 'wx' }));
  return records;
}

export async function assertNotDetailReferenceOutput(bytes: Buffer,
  details: { path: string; hash: string; kind?: 'context' | 'presentation' }[]) {
  if (!details.length) return;
  const byteHash = digest(bytes);
  const candidate = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const d of details) {
    const label = d.kind === 'context' ? '周边参考' : d.kind === 'presentation' ? '完整参考呈现' : '细节参考';
    if (byteHash === d.hash) throw invalid(`干净${label}不能登记为image_gen产物`);
    const reference = fs.readFileSync(d.path);
    if (digest(reference) !== d.hash) throw invalid(`本任务已冻结${label}发生变化`);
    const raw = await sharp(reference).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (candidate.info.width === raw.info.width && candidate.info.height === raw.info.height &&
      candidate.data.equals(raw.data)) throw invalid(`干净${label}重编码别名不能登记为image_gen产物`);
  }
}
