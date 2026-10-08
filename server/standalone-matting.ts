import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Job, CanvasImage } from './types.js';
import { dir, atomic, assetPath, writeAsset, uid } from './store.js';
import { renderImage } from './media.js';
import { worker } from './models.js';
import { standaloneMattingSchema } from '../shared/standalone-matting.js';

export async function standaloneMatting(job: Job, runner: typeof worker, signal: AbortSignal) {
  const settings = standaloneMattingSchema.parse(job.matting);
  const im = job.snapshot;
  const out = path.join(dir(job.documentId), 'jobs', job.id);
  fs.mkdirSync(out, { recursive: true });
  // A preview is not an artwork result. Use its clean input; finished nodes use visible composition.
  const input =
    im.status === 'preview' || !im.layers.length
      ? fs.readFileSync(assetPath(job.documentId, im.source))
      : await renderImage(job.documentId, im);
  const inputPath = path.join(out, 'input.png');
  fs.writeFileSync(inputPath, await sharp(input).png().toBuffer());
  const optionsPath = path.join(out, 'options.json');
  atomic(optionsPath, { ...settings.options[settings.model], padding: 0 });
  signal.throwIfAborted();
  const result = await runner(
    [
      'matte',
      '--input',
      inputPath,
      '--output',
      out,
      '--model',
      settings.model,
      '--options',
      optionsPath,
    ],
    signal,
  );
  signal.throwIfAborted();
  const outputPath = path.join(out, 'cutout.png');
  if (typeof result.path !== 'string' || path.resolve(result.path) !== outputPath)
    throw new Error('抠图未返回本次任务的有效文件');
  const bytes = fs.readFileSync(outputPath);
  const meta = await sharp(bytes).metadata();
  if (
    meta.format !== 'png' ||
    !meta.hasAlpha ||
    meta.width !== im.width ||
    meta.height !== im.height
  )
    throw new Error('抠图文件尺寸或透明通道不符合原图，未创建结果节点');
  const stats = await sharp(bytes).stats();
  if (stats.channels.at(-1)?.max === 0) throw new Error('抠图结果全透明，未识别到前景');
  const url = writeAsset(job.documentId, bytes, '.png');
  const layerId = uid();
  const image: CanvasImage = {
    id: im.id,
    name: im.name,
    width: im.width,
    height: im.height,
    x: im.x,
    y: im.y,
    source: url,
    url,
    status: 'cutout',
    version: im.version,
    opinion: '',
    annotations: [],
    layers: [
      {
        id: layerId,
        name: '抠图主体',
        kind: 'raster',
        url,
        x: 0,
        y: 0,
        width: im.width,
        height: im.height,
        visible: true,
        opacity: 1,
        disposition: 'keep',
        opinion: '',
      },
    ],
  };
  atomic(path.join(out, 'matting-result.json'), result);
  return {
    image,
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
    execution: result.execution,
    seconds: result.seconds,
  };
}
