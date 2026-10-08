import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { CanvasImage, Job, Layer } from './types.js';
import { assetPath, writeAsset, atomic } from './store.js';
import { renderImage, renderStyledLayer, exportPsd } from './media.js';
import { upscaleDimensions, upscaleModelName, type UpscaleSettings } from '../shared/upscale.js';
import { scaledFrame } from '../shared/layer-frame.js';
import { imageSchema } from './validation.js';
import { readUpscalePsd, scalePsdMetadata, verifyUpscaledPsd } from './upscale-psd.js';

export const keepsUpscaleLayers = (im: CanvasImage) =>
  im.status !== 'preview' && im.status !== 'vector' && im.layers.length > 0;

function scaleLayer(source: Layer, scale: number): Layer {
  if (source.kind === 'plan' || source.preview)
    throw new Error('预览图层不是正式分层结果，请先完成重建');
  const l = structuredClone(source);
  const x = Math.round(l.x * scale),
    y = Math.round(l.y * scale);
  l.width = Math.max(1, Math.round((l.x + l.width) * scale) - x);
  l.height = Math.max(1, Math.round((l.y + l.height) * scale) - y);
  l.x = x;
  l.y = y;
  if (l.frame) l.frame = scaledFrame(l.frame, scale, scale);
  if (l.text) {
    l.text.x *= scale;
    l.text.y *= scale;
    l.text.fontSize *= scale;
  }
  if (l.psdStyle?.stroke) l.psdStyle.stroke.size *= scale;
  if (l.psdStyle?.shadow) {
    l.psdStyle.shadow.blur *= scale;
    l.psdStyle.shadow.offsetX *= scale;
    l.psdStyle.shadow.offsetY *= scale;
  }
  // Generation provenance remains in the frozen parent/job. It does not describe the new pixels.
  for (const key of [
    'previewUrl',
    'generationSize',
    'generationSourceUrl',
    'generationAdaptation',
    'sourceCrop',
    'cutoutBox',
    'review',
  ] as const)
    delete l[key];
  return l;
}

export function prepareLayerUpscale(job: Job, settings: UpscaleSettings) {
  const im = job.snapshot,
    scale = settings.scale;
  const size = upscaleDimensions(im.width, im.height, settings);
  const layers = im.layers.map((l) => {
    upscaleDimensions(Math.ceil(l.width), Math.ceil(l.height), settings);
    if (l.kind === 'vector')
      throw new Error('分层超分暂不处理混合矢量图层，请保留原节点并在副本中转换为位图');
    return scaleLayer(l, scale);
  });
  if (layers.reduce((sum, l) => sum + l.width * l.height, 0) > 160_000_000)
    throw new Error('放大后所有图层合计超过1.6亿像素，可能耗尽内存；请降低倍率或拆分文档');
  const annotations = im.annotations.map((a) => ({
    ...structuredClone(a),
    points: a.points.map((p) => p * scale),
    labelPosition: a.labelPosition?.map((p) => p * scale) as [number, number] | undefined,
    brushSize: a.brushSize === undefined ? undefined : a.brushSize * scale,
  }));
  const image = imageSchema.parse({
    ...structuredClone(im),
    ...size,
    layers,
    annotations,
    status: 'upscaled',
    vectorLayers: undefined,
    vectorUrl: undefined,
    artifactUrl: undefined,
  });
  const native = scalePsdMetadata(readUpscalePsd(job.documentId, im), scale);
  return { image, native };
}

export type UpscaleRaster = (
  input: Buffer,
  out: string,
  size: { width: number; height: number },
) => Promise<{ bytes: Buffer; warnings: string[]; execution?: unknown; seconds?: number }>;

export async function upscaleLayers(
  job: Job,
  settings: UpscaleSettings,
  out: string,
  raster: UpscaleRaster,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const { image, native } = prepareLayerUpscale(job, settings);
  const records: any[] = [],
    warnings: string[] = [];
  let seconds = 0;
  for (let i = 0; i < image.layers.length; i++) {
    signal.throwIfAborted();
    const source = job.snapshot.layers[i],
      layer = image.layers[i];
    if (source.kind === 'plan' || layer.kind === 'plan') throw new Error('未完成的规划层不能超分');
    progress(
      `正在超分第 ${i + 1}/${image.layers.length} 层：${layer.name}${layer.visible ? '' : '（隐藏层）'}`,
    );
    const input = fs.readFileSync(assetPath(job.documentId, source.url));
    let bytes: Buffer, result: any;
    const alpha = await sharp(input).ensureAlpha().extractChannel('alpha').raw().toBuffer();
    // Text is scaled structurally, never sent to the generative model. Empty layers stay empty.
    if (layer.kind === 'text' || !alpha.some((v) => v !== 0)) {
      bytes = await sharp(input)
        .resize(layer.width, layer.height, { fit: 'fill', kernel: 'lanczos3' })
        .png()
        .toBuffer();
      result = {
        method: layer.kind === 'text' ? 'editable-text-scale' : 'empty-alpha-scale',
        seconds: 0,
      };
    } else {
      const w = Math.max(1, Math.round(source.width)),
        h = Math.max(1, Math.round(source.height));
      const normal = await sharp(input).resize(w, h, { fit: 'fill' }).png().toBuffer();
      result = await raster(normal, path.join(out, `layer-${i + 1}`), {
        width: w * settings.scale,
        height: h * settings.scale,
      });
      bytes = result.bytes;
      if (layer.width !== w * settings.scale || layer.height !== h * settings.scale)
        bytes = await sharp(bytes)
          .resize(layer.width, layer.height, { fit: 'fill' })
          .png()
          .toBuffer();
      seconds += result.seconds || 0;
      warnings.push(...result.warnings.map((v: string) => `${layer.name}：${v}`));
    }
    signal.throwIfAborted();
    layer.url = writeAsset(job.documentId, bytes, '.png');
    if (layer.psdStyle)
      layer.previewUrl = writeAsset(
        job.documentId,
        await renderStyledLayer(job.documentId, layer, image.width, image.height),
        '.png',
      );
    records.push({
      layerId: layer.id,
      name: layer.name,
      input: { x: source.x, y: source.y, width: source.width, height: source.height },
      output: { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
      method: result.method || upscaleModelName(settings),
      execution: result.execution,
      seconds: result.seconds,
    });
    atomic(path.join(out, 'upscale-layers-progress.json'), records);
  }
  signal.throwIfAborted();
  progress('正在合成并校验分层 PSD 的画幅、图层位置与文字信息');
  image.source = image.url = writeAsset(
    job.documentId,
    await renderImage(job.documentId, image),
    '.png',
  );
  const psd = await exportPsd(job.documentId, image, native);
  verifyUpscaledPsd(psd, image);
  signal.throwIfAborted();
  image.psdSource = image.artifactUrl = writeAsset(job.documentId, psd, '.psd');
  imageSchema.parse(image);
  const execution = {
    model: upscaleModelName(settings),
    mode: 'preserve-layers',
    scale: settings.scale,
    layers: records,
  };
  atomic(path.join(out, 'upscale-result.json'), { execution, seconds, warnings });
  return { image, warnings, execution, seconds };
}
