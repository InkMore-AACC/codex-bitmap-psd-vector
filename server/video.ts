import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { assetDir, assetPath, dir, uid, atomic } from './store.js';
import { worker } from './models.js';
import type { CanvasImage, Document, Job } from './types.js';
import { upscaleSchema, upscaleDimensions } from '../shared/upscale.js';

export const videoExtension = /\.(mp4|mov|mkv|webm|avi)$/i;
function copyAsset(documentId: string, source: string, extension: string) {
  const name = uid() + extension;
  fs.copyFileSync(source, path.join(assetDir(documentId), name));
  return `/assets/${documentId}/${name}`;
}
function metadata(result: any, previewUrl: string): NonNullable<CanvasImage['video']> {
  for (const key of ['duration', 'fpsNumerator', 'fpsDenominator', 'frameCount'])
    if (!Number.isFinite(result[key]) || result[key] <= 0) throw new Error('视频信息无效');
  if (!Number.isInteger(result.audioStreams) || result.audioStreams < 0)
    throw new Error('音轨信息无效');
  return {
    duration: result.duration,
    fpsNumerator: result.fpsNumerator,
    fpsDenominator: result.fpsDenominator,
    frameCount: result.frameCount,
    audioStreams: result.audioStreams,
    previewUrl,
  };
}
export async function importVideo(d: Document, input: string, name: string, runner = worker) {
  if (!videoExtension.test(name)) throw new Error('支持 MP4、MOV、MKV、WebM、AVI 视频');
  if (d.images.length >= 100) throw new Error('画布节点已达100个');
  const out = path.join(dir(d.id), 'imports', uid());
  fs.mkdirSync(out, { recursive: true });
  try {
    const result = await runner(['video-prepare', '--input', input, '--output', out]);
    const poster = path.join(out, 'poster.png'),
      preview = path.join(out, 'preview.mp4');
    if (result.poster !== poster || result.preview !== preview)
      throw new Error('视频导入返回路径无效');
    const info = await sharp(poster).metadata();
    if (info.width !== result.width || info.height !== result.height)
      throw new Error('视频预览尺寸无效');
    metadata(result, '');
    const source = copyAsset(d.id, input, path.extname(name).toLowerCase());
    const url = copyAsset(d.id, poster, '.png');
    const previewUrl = copyAsset(d.id, preview, '.mp4');
    return {
      id: uid(),
      name,
      width: result.width,
      height: result.height,
      x: d.images.reduce((max, im) => Math.max(max, im.x + im.width + 100), 0),
      y: 0,
      source,
      url,
      mediaType: 'video',
      video: metadata(result, previewUrl),
      layers: [],
      annotations: [],
      opinion: '',
      status: 'original',
      version: 0,
    } as CanvasImage;
  } finally {
    // Only this generated scratch directory; original input is owned by the caller.
    fs.rmSync(out, { recursive: true, force: true });
  }
}
export async function upscaleVideo(
  job: Job,
  runner: typeof worker,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const im = job.snapshot;
  if (!im.video) throw new Error('视频节点缺少媒体信息');
  const settings = upscaleSchema.parse(job.upscale);
  const expected = upscaleDimensions(im.width, im.height, settings);
  const out = path.join(dir(job.documentId), 'jobs', job.id);
  fs.mkdirSync(out, { recursive: true });
  const options = path.join(out, 'upscale-options.json');
  atomic(options, settings);
  let last = '';
  const timer = setInterval(() => {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(out, 'video-progress.json'), 'utf8'));
      if (typeof item.message === 'string' && item.message !== last) {
        last = item.message;
        progress(last);
      }
    } catch {
      /* writer may be replacing the progress file */
    }
  }, 750);
  try {
    signal.throwIfAborted();
    const result = await runner(
      [
        'video-upscale',
        '--input',
        assetPath(job.documentId, im.source),
        '--output',
        out,
        '--options',
        options,
      ],
      signal,
    );
    signal.throwIfAborted();
    if (
      result.path !== path.join(out, 'upscaled.mp4') ||
      result.poster !== path.join(out, 'poster.png')
    )
      throw new Error('视频结果不属于本任务');
    if (
      result.width !== expected.width ||
      result.height !== expected.height ||
      result.frameCount !== im.video.frameCount ||
      result.audioStreams !== im.video.audioStreams ||
      Math.abs(result.duration - im.video.duration) > 0.1
    )
      throw new Error('视频结果的尺寸、帧数、时长或音轨不符合输入');
    const poster = await sharp(result.poster).metadata();
    if (
      poster.width !== expected.width ||
      poster.height !== expected.height ||
      !fs.statSync(result.path).size
    )
      throw new Error('视频结果文件无效');
    metadata(result, '');
    const url = copyAsset(job.documentId, result.poster, '.png');
    const source = copyAsset(job.documentId, result.path, '.mp4');
    const image: CanvasImage = {
      id: im.id,
      name: im.name,
      ...expected,
      x: im.x,
      y: im.y,
      source,
      url,
      artifactUrl: source,
      mediaType: 'video',
      video: metadata(result, source),
      layers: [],
      annotations: [],
      opinion: '',
      version: im.version,
      status: 'upscaled',
    };
    atomic(path.join(out, 'upscale-result.json'), result);
    return {
      image,
      warnings: (result.warnings || []).map(String),
      execution: result.execution,
      seconds: result.seconds,
    };
  } finally {
    clearInterval(timer);
  }
}
