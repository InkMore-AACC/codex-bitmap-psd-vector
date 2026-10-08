import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Job, CanvasImage } from './types.js';
import { dir, atomic, assetPath, writeAsset, uid } from './store.js';
import { renderImage } from './media.js';
import { worker } from './models.js';
import { upscaleSchema, upscaleDimensions } from '../shared/upscale.js';
import { keepsUpscaleLayers, upscaleLayers } from './upscale-layers.js';
import { upscaleVideo } from './video.js';

export async function upscaleImage(
  job: Job,
  runner: typeof worker,
  signal: AbortSignal,
  progress: (message: string) => void = () => {},
) {
  if (job.snapshot.mediaType === 'video') return upscaleVideo(job, runner, signal, progress);
  if(job.snapshot.nativePsd)throw new Error('此节点含PS原生分组和效果。请通过交接PS调整目标尺寸，避免普通逐层超分丢失原生结构；PS重建生成素材可自动SeedVR2超分。');
  const settings = upscaleSchema.parse(job.upscale);
  const im = job.snapshot;
  const size = upscaleDimensions(im.width, im.height, settings);
  const out = path.join(dir(job.documentId), 'jobs', job.id);
  fs.mkdirSync(out, { recursive: true });
  const raster = async (
    input: Buffer,
    folder: string,
    target: { width: number; height: number },
  ) => {
    fs.mkdirSync(folder, { recursive: true });
    const inputPath = path.join(folder, 'input.png');
    fs.writeFileSync(inputPath, await sharp(input).png().toBuffer());
    const optionsPath = path.join(folder, 'upscale-options.json');
    atomic(optionsPath, settings);
    signal.throwIfAborted();
    const result = await runner(
      ['upscale', '--input', inputPath, '--output', folder, '--options', optionsPath],
      signal,
    );
    signal.throwIfAborted();
    const output = path.join(folder, 'upscaled.png');
    if (typeof result.path !== 'string' || path.resolve(result.path) !== output)
      throw new Error('超分未返回本次任务的有效文件');
    let bytes = fs.readFileSync(output);
    const meta = await sharp(bytes).metadata();
    if (meta.format !== 'png' || meta.width !== target.width || meta.height !== target.height)
      throw new Error('超分文件格式或尺寸不符合请求，未创建结果节点');
    // Always restore source alpha independently, including soft transparency.
    const alpha = await sharp(input)
      .ensureAlpha()
      .extractChannel('alpha')
      .resize(target.width, target.height, { kernel: 'lanczos3' })
      .raw()
      .toBuffer();
    const rgb = await sharp(bytes).removeAlpha().png().toBuffer();
    bytes = await sharp(rgb)
      .joinChannel(alpha, { raw: { ...target, channels: 1 } })
      .png()
      .toBuffer();
    atomic(path.join(folder, 'upscale-result.json'), result);
    return {
      bytes,
      warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
      execution: result.execution,
      seconds: result.seconds,
    };
  };
  if (keepsUpscaleLayers(im)) return upscaleLayers(job, settings, out, raster, signal, progress);
  const input =
    im.status === 'preview' || !im.layers.length
      ? fs.readFileSync(assetPath(job.documentId, im.source))
      : await renderImage(
          job.documentId,
          im.status === 'vector' && im.vectorLayers ? { ...im, layers: im.vectorLayers } : im,
        );
  const inputMeta = await sharp(input).metadata();
  if (inputMeta.width !== im.width || inputMeta.height !== im.height)
    throw new Error('当前节点尺寸与实际输入不一致，未开始超分');
  const result = await raster(input, out, size);
  const bytes = result.bytes;
  signal.throwIfAborted();
  const url = writeAsset(job.documentId, bytes, '.png');
  const image: CanvasImage = {
    id: im.id,
    name: im.name,
    ...size,
    x: im.x,
    y: im.y,
    source: url,
    url,
    status: 'upscaled',
    version: im.version,
    opinion: '',
    annotations: [],
    layers: [
      {
        id: uid(),
        name: '超分结果',
        kind: 'raster',
        url,
        x: 0,
        y: 0,
        ...size,
        visible: true,
        opacity: 1,
        disposition: 'keep',
        opinion: '',
      },
    ],
  };
  return {
    image,
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
    execution: result.execution,
    seconds: result.seconds,
  };
}
