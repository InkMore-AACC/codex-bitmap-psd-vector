import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { PhotoshopPlan, PhotoshopEvidence } from '../shared/photoshop.js';
import type { Job } from './types.js';
import { assetPath, dir } from './store.js';
import { originalReference } from './references.js';
import { reconstructionInputs } from './reconstruction-inputs.js';
import { scaledFrame } from '../shared/layer-frame.js';

type Entry = PhotoshopPlan['layers'][number];
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const raw = (bytes: Buffer) =>
  sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

/** Preserve is a measured promise, not a way to skip the reconstruction route checks.
 * Compare premultiplied RGBA so hidden RGB in transparent pixels does not cause false failures.
 * Native thumbnails already contain group opacity; raster assets need their frozen opacity.
 */
export async function verifyPreservedLayers(
  j: Job,
  plan: PhotoshopPlan,
  thumbnails: Record<string, string>,
) {
  const reports: Record<string, { meanError: number; changedFraction: number }> = {};
  for (const entry of plan.layers.filter((l) => l.route === 'preserve')) {
    const prior = j.snapshot.layers.find((l) => l.id === entry.layerId);
    if (!prior || prior.preview) throw new Error(`「${entry.name}」没有可保留的完成层`);
    const size = plan.canvas || j.snapshot;
    // Never enlarge the comparison beyond the frozen input; resampling differences at enlarged
    // edges are not edits. Both sides are compared at the same source-space resolution.
    const ratio = Math.min(
      1,
      j.snapshot.width / size.width,
      j.snapshot.height / size.height,
      1536 / Math.max(size.width, size.height),
    );
    const width = Math.max(1, Math.round(size.width * ratio));
    const height = Math.max(1, Math.round(size.height * ratio));
    const canvas = createCanvas(width, height),
      context = canvas.getContext('2d');
    const image = await loadImage(
      fs.readFileSync(assetPath(j.documentId, prior.previewUrl || prior.url)),
    );
    const native = !!j.snapshot.nativePsd;
    context.globalAlpha = native ? 1 : prior.opacity;
    const sx = width / j.snapshot.width,
      sy = height / j.snapshot.height;
    context.drawImage(
      image,
      prior.previewUrl ? 0 : prior.x * sx,
      prior.previewUrl ? 0 : prior.y * sy,
      prior.previewUrl ? width : prior.width * sx,
      prior.previewUrl ? height : prior.height * sy,
    );
    const normalize = async (bytes: Buffer) =>
      raw(await sharp(bytes).resize(width, height, { fit: 'fill' }).blur(0.8).png().toBuffer());
    const expected = await normalize(canvas.toBuffer('image/png'));
    const actual = await normalize(fs.readFileSync(thumbnails[entry.layerId]));
    let error = 0,
      active = 0,
      changed = 0;
    for (let i = 0; i < expected.data.length; i += 4) {
      const a = expected.data[i + 3] / 255,
        b = actual.data[i + 3] / 255;
      if (Math.max(a, b) < 0.01) continue;
      active++;
      const delta = Math.max(
        Math.abs(a - b) * 255,
        ...[0, 1, 2].map((c) => Math.abs(expected.data[i + c] * a - actual.data[i + c] * b)),
      );
      error += delta;
      if (delta > 24) changed++;
    }
    const report = {
      meanError: error / Math.max(1, active),
      changedFraction: changed / Math.max(1, active),
    };
    reports[entry.layerId] = report;
    // This guards unchanged assets, not approximate generated candidates. The latter require review.
    const resampled = size.width !== j.snapshot.width || size.height !== j.snapshot.height;
    if (report.meanError > (resampled ? 8 : 3) || report.changedFraction > 0.025)
      throw new Error(
        `「${entry.name}」声明preserve但实际PS渲染已改变（平均差异${report.meanError.toFixed(1)}/255，明显差异${(report.changedFraction * 100).toFixed(1)}%）；请恢复原层，或显式改用重建路线并重新检查`,
      );
  }
  return reports;
}

/** Count actual alpha pixels, not the presence of an alpha channel or the canvas corners. */
export async function alphaMetrics(bytes: Buffer) {
  const { data, info } = await raw(bytes);
  let transparent = 0,
    soft = 0,
    opaque = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) transparent++;
    else if (data[i] === 255) opaque++;
    else soft++;
  }
  return {
    width: info.width,
    height: info.height,
    transparent,
    soft,
    opaque,
    total: info.width * info.height,
  };
}

export function requireIsolatedSurface(entry: Entry, m: Awaited<ReturnType<typeof alphaMetrics>>) {
  if (!m.opaque && !m.soft) throw new Error(`「${entry.name}」没有可见素材，不能用空图层占位`);
  if (entry.surface === 'opaque' && (m.transparent || m.soft))
    throw new Error(`「${entry.name}」声明为完整背景但仍有透明空洞；请补全而不是靠前景遮盖`);
  if (entry.surface === 'transparent' && !m.transparent && !(entry.content === 'light' && m.soft))
    throw new Error(
      `「${entry.name}」没有透明区域；矩形参考裁片不能作为已分离物体。请制作透明物体/文字素材，不要仅添加全白蒙版`,
    );
}

/** Source references are read-only. Receipts are auditable declarations, not host-signed proof of model identity. */
export function checkEvidence(
  j: Job,
  entry: Entry,
  inputPath: string,
  provenance: string,
  evidence: PhotoshopEvidence,
  outputBytes?: Buffer,
) {
  const folder = path.join(dir(j.documentId), 'jobs', j.id);
  const original = originalReference(j.documentId, j.snapshot);
  const clean = reconstructionInputs(j.documentId, j.snapshot, original.path).generationInputs
    .allowedImagePaths;
  const references = path.join(folder, 'references');
  if (fs.existsSync(references))
    for (const name of fs.readdirSync(references)) clean.push(path.join(references, name));
  const allowed = new Set(clean.map((p) => path.resolve(p).toLowerCase()));
  if(provenance==='source-protected' && (!evidence.backgroundProtection || evidence.generation || evidence.extraction))
    throw new Error('来源保护背景必须记录derived-background凭证，不能声明为image_gen原件或普通提取');
  if(provenance!=='source-protected' && evidence.backgroundProtection)
    throw new Error('背景派生凭证不能用于冒充其他素材来源');
  if (provenance === 'generated') {
    const g = evidence.generation;
    if (!g || path.resolve(g.outputPath) !== path.resolve(inputPath))
      throw new Error(
        '生成素材须记录 image_gen 的原始返回路径、实际提示词和干净参考；不能仅声明 generated',
      );
    if (
      g.referencePaths.some(
        (p) =>
          !path.isAbsolute(p) || !allowed.has(path.resolve(p).toLowerCase()) || !fs.existsSync(p),
      )
    )
      throw new Error('生成参考不在本任务允许的干净输入中；预抠图或其他任务的素材不能参与');
  }
  if (provenance === 'extracted' && !evidence.extraction)
    throw new Error('提取素材须说明实际物体选区/蒙版方法及遮挡补全，不接受按框裁切说明');
  return {
    declaration: evidence,
    outputHash: hash(outputBytes || fs.readFileSync(inputPath)),
    references:
      evidence.generation?.referencePaths.map((p) => ({
        path: p,
        hash: hash(fs.readFileSync(p)),
      })) ?? [],
    route: entry.route,
    toolHistoryVerified: false,
    ...(provenance==='source-protected'?{tool:'derived-background' as const}:{}),
  };
}

/** Reject decoded copies of reference crops, including transparent padding outside the input image. */
export async function rejectReferenceCrop(
  j: Job,
  entry: Entry,
  canvas: NonNullable<PhotoshopPlan['canvas']>,
  bytes: Buffer,
) {
  if (entry.route === 'preserve') return;
  const candidate = await raw(bytes);
  const frame = scaledFrame(
    entry.frame,
    j.snapshot.width / canvas.width,
    j.snapshot.height / canvas.height,
  );
  const sources = new Set([
    assetPath(j.documentId, j.snapshot.source),
    assetPath(
      j.documentId,
      j.snapshot.status === 'preview' ? j.snapshot.source : j.snapshot.url || j.snapshot.source,
    ),
    originalReference(j.documentId, j.snapshot).path,
  ]);
  for (const source of sources) {
    const sourceBytes = fs.readFileSync(source),
      meta = await sharp(sourceBytes).metadata();
    const candidates: Buffer[] = [sourceBytes];
    if (meta.width === j.snapshot.width && meta.height === j.snapshot.height) {
      const x = Math.max(0, frame.x),
        y = Math.max(0, frame.y);
      const r = Math.min(meta.width!, frame.x + frame.width),
        b = Math.min(meta.height!, frame.y + frame.height);
      if (r > x && b > y)
        candidates.push(
          await sharp(sourceBytes)
            .extract({ left: x, top: y, width: r - x, height: b - y })
            .extend({
              left: x - frame.x,
              top: y - frame.y,
              right: frame.x + frame.width - r,
              bottom: frame.y + frame.height - b,
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer(),
        );
    }
    for (const ref of candidates) {
      const m = await sharp(ref).metadata();
      // Catch straightforward resized/recoded crops too. This is not a general semantic classifier.
      const comparison =
        m.width === candidate.info.width && m.height === candidate.info.height
          ? ref
          : await sharp(ref)
              .resize(candidate.info.width, candidate.info.height, { fit: 'fill' })
              .png()
              .toBuffer();
      if ((await raw(comparison)).data.equals(candidate.data))
        throw new Error(`「${entry.name}」仍是整图或矩形参考裁片；参考图不能注册为最终分层素材`);
    }
  }
}

export async function inspectRenderedIsolation(
  j: Job,
  plan: PhotoshopPlan,
  thumbnails: Record<string, string>,
  folder: string,
  probes?: Record<string, { lightPath: string; darkPath: string }>,
) {
  const result: Record<
    string,
    { lightPath: string; darkPath: string; metrics: Awaited<ReturnType<typeof alphaMetrics>> }
  > = {};
  const canvas = plan.canvas!;
  for (const l of plan.layers) {
    const bytes = fs.readFileSync(thumbnails[l.layerId]);
    const x = Math.max(0, l.frame.x),
      y = Math.max(0, l.frame.y);
    const r = Math.min(canvas.width, l.frame.x + l.frame.width),
      b = Math.min(canvas.height, l.frame.y + l.frame.height);
    if (r <= x || b <= y) continue; // PSD supports completely off-canvas content.
    const region = await sharp(bytes)
      .extract({ left: x, top: y, width: r - x, height: b - y })
      .png()
      .toBuffer();
    const metrics = await alphaMetrics(region);
    if (l.route !== 'preserve') {
      requireIsolatedSurface(l, metrics);
      await rejectReferenceCrop(j, l, canvas, region);
    }
    const stem = path.basename(thumbnails[l.layerId], '.png');
    const lightPath = probes?.[l.layerId]?.lightPath ?? path.join(folder, stem + '-light.png');
    const darkPath = probes?.[l.layerId]?.darkPath ?? path.join(folder, stem + '-dark.png');
    if (!probes) {
      fs.writeFileSync(
        lightPath,
        await sharp(bytes).flatten({ background: '#eeeeee' }).png().toBuffer(),
      );
      fs.writeFileSync(
        darkPath,
        await sharp(bytes).flatten({ background: '#202020' }).png().toBuffer(),
      );
    }
    result[l.layerId] = { lightPath, darkPath, metrics };
  }
  return result;
}
