import { layerFrame } from '../shared/layer-frame.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import sharp from 'sharp';
import type { CanvasImage, Job, Layer } from './types.js';
import type { ImageLayer } from '../shared/canvas.js';
import { assetPath } from './store.js';

export const isPreviewLayer = (image: CanvasImage, layer: Layer) =>
  image.status === 'preview' || layer.preview === true;

/** Previews stay on the designer's canvas. Agents receive their semantic plan only. */
export function reconstructionInputs(documentId: string, image: CanvasImage, originalPath: string) {
  const describe = (layer: Layer) => ({
    id: layer.id,
    name: layer.name,
    role: layer.role,
    kind: layer.kind,
    x: layer.x,
    y: layer.y,
    width: layer.width,
    height: layer.height,
    visible: layer.visible,
    opacity: layer.opacity,
    opinion: layer.opinion,
    cutoutBox: layer.cutoutBox,
    frame: layerFrame(layer, image),
    preview: true,
    disposition: 'rebuild' as const,
    inputRole: 'annotation-only' as const,
  });
  const convert = (layer: Layer) =>
    layer.kind === 'plan' || isPreviewLayer(image, layer)
      ? describe(layer)
      : { ...layer, path: assetPath(documentId, layer.url) };
  const layers = image.layers.map(convert);
  const packetImage = {
    ...image,
    layers,
    vectorLayers: image.vectorLayers?.map(convert),
    ...(image.status === 'preview'
      ? { url: image.source, vectorUrl: undefined, artifactUrl: undefined }
      : {}),
  };
  const currentPath = assetPath(documentId, image.source);
  const actualLayers = [...image.layers, ...(image.vectorLayers || [])].filter(
    (l): l is ImageLayer => l.kind !== 'plan' && !isPreviewLayer(image, l),
  );
  return {
    image: packetImage,
    layers,
    generationInputs: {
      workflow: 'original-and-annotations',
      allowedImagePaths: [
        ...new Set([
          originalPath,
          currentPath,
          ...actualLayers.map((l) => assetPath(documentId, l.url)),
        ]),
      ],
      previewPixelsAllowed: false,
      previewMasksAllowed: false,
      instruction:
        '只允许干净原图、当前干净输入及已完成的真实图层作为生图图像输入。粗抠和精抠只有预览清晰度不同，均只提供对象归属、坐标、顺序及意见；不得读取抠图图片作为生图参考，不得复用其像素或蒙版。允许从上述干净图按明确坐标裁取局部参考，保留周边RGB，不套抠图蒙版，并记录来源路径与裁切框。实际输入必须显式选择这些有来源的干净素材，不能自动带入对话里的旧预览图。',
    },
  };
}

async function pixelDigest(file: string) {
  const { data, info } = await sharp(fs.readFileSync(file))
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return crypto
    .createHash('sha256')
    .update(`${info.width}x${info.height}:`)
    .update(data)
    .digest('hex');
}

/** Reject direct reuse even if a caller removes preview flags, renames or re-encodes PNGs. */
export async function rejectPreviewReuse(job: Job, results: Layer[]) {
  const previews = [...job.snapshot.layers, ...(job.snapshot.vectorLayers || [])].filter((l) =>
    isPreviewLayer(job.snapshot, l),
  );
  if (!previews.length) return;
  const fingerprints = new Set<string>();
  for (const l of previews) {
    for (const url of [l.url, l.previewUrl].filter(Boolean) as string[]) {
      fingerprints.add(await pixelDigest(assetPath(job.documentId, url)));
    }
  }
  for (const layer of results) {
    if (
      layer.preview ||
      fingerprints.has(await pixelDigest(assetPath(job.documentId, layer.url)))
    ) {
      throw Object.assign(
        new Error('检测到抠图预览或其像素副本，不能作为重建结果；请提交实际生成并核验的最终图层'),
        { status: 400 },
      );
    }
  }
}
