import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import type { Job } from './types.js';
import { dir } from './store.js';
import { frameContract } from './layer-frames.js';

/** Clean, unmasked local references; transparent extension is context, never a cutout mask. */
export async function reconstructionCrops(
  job: Job,
  contract: ReturnType<typeof frameContract>,
  originalPath: string,
  currentPath: string,
) {
  if (!contract || !['layer', 'revise', 'photoshop'].includes(job.type)) return [];
  const refs = [];
  const folder = path.join(dir(job.documentId), 'jobs', job.id, 'references');
  fs.mkdirSync(folder, { recursive: true });
  // Metadata and pixels must come from the same captured bytes. A path is not
  // an image identity: confirmed edits may replace its contents in place.
  const sources = [
    { role: 'original' as const, source: originalPath },
    ...(currentPath === originalPath ? [] : [{ role: 'current' as const, source: currentPath }]),
  ].map(({ role, source }) => {
    const bytes = fs.readFileSync(source);
    return { role, source, bytes, sourceHash: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  for (const layer of contract.layers) {
    const sx = job.snapshot.width / contract.canvas.width;
    const sy = job.snapshot.height / contract.canvas.height;
    const frame = {
      x: Math.round(layer.frame.x * sx),
      y: Math.round(layer.frame.y * sy),
      width: Math.max(1, Math.round(layer.frame.width * sx)),
      height: Math.max(1, Math.round(layer.frame.height * sy)),
    };
    for (const { role, source, bytes: input, sourceHash } of sources) {
      const meta = await sharp(input).metadata();
      // Do not invent a coordinate transform after a crop or an arbitrary upstream edit.
      if (meta.width !== job.snapshot.width || meta.height !== job.snapshot.height) {
        refs.push({
          layerId: layer.layerId,
          role,
          sourcePath: source,
          sourceHash,
          warning:
            '参考图与当前节点尺寸不同，未自动猜测裁片坐标；请核对已确认的尺寸/裁切变换后再裁取。',
        });
        continue;
      }
      const x = Math.max(0, frame.x),
        y = Math.max(0, frame.y);
      const right = Math.min(meta.width!, frame.x + frame.width);
      const bottom = Math.min(meta.height!, frame.y + frame.height);
      if (right <= x || bottom <= y) {
        refs.push({
          layerId: layer.layerId,
          role,
          sourcePath: source,
          sourceHash,
          warning: '该画幅完全位于输入图外，没有可用局部参考；使用整图理解补全。',
        });
        continue;
      }
      const key = crypto
        .createHash('sha256')
        .update(JSON.stringify([source, sourceHash, frame]))
        .digest('hex')
        .slice(0, 24);
      const file = path.join(folder, `${key}.png`);
      const bytes = await sharp(input)
        .extract({ left: x, top: y, width: right - x, height: bottom - y })
        .extend({
          left: x - frame.x,
          top: y - frame.y,
          right: frame.x + frame.width - right,
          bottom: frame.y + frame.height - bottom,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      // A content-addressed name alone does not authenticate a mutable file.
      // Do not bless changed cache bytes as the source of a new frozen request,
      // or overwrite a file still referenced by an earlier prepared request.
      if (fs.existsSync(file)) {
        if (!fs.readFileSync(file).equals(bytes))
          throw Object.assign(new Error('干净局部缓存与当前源裁片不一致；保留旧文件并拒绝作为参考'), { status: 400 });
      } else fs.writeFileSync(file, bytes, { flag: 'wx' });
      refs.push({
        layerId: layer.layerId,
        sourceLayerIds: layer.sourceLayerIds,
        role,
        sourcePath: source,
        sourceHash,
        path: file,
        frame,
        coordinateSpace: 'input-image-pixels',
        instruction:
          '首轮即引用本干净局部裁片帮助细节和布局；整图辅助语境。不含抠图蒙版，不代表已分离目标；保留已确认修改。无数值参考权重保证。',
      });
    }
  }
  return refs;
}
