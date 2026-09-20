import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { writeAsset, assetPath, uid } from './store.js';
import { layerSchema } from './validation.js';
import { cleanSvg } from './svg.js';
import { checkDimensions, renderTextLayer, renderStyledLayer } from './media.js';
import type { CanvasImage, Layer } from './types.js';
const fail = (message: string) => Object.assign(new Error(message), { status: 400 });

export async function layerFromFile(docId: string, value: any, image: CanvasImage): Promise<Layer> {
  const name = String(value.name || '图层').slice(0, 300);
  let url = '',
    width = value.width,
    height = value.height;
  let kind = value.kind || 'raster';
  if (value.svg) {
    const svg = cleanSvg(String(value.svg));
    url = writeAsset(docId, Buffer.from(svg), '.svg');
    kind = 'vector';
    const m = await sharp(Buffer.from(svg)).metadata();
    width ??= m.width;
    height ??= m.height;
  } else if (value.path) {
    if (!path.isAbsolute(value.path)) throw fail('产物必须使用绝对路径');
    const stat = fs.statSync(value.path);
    if (!stat.isFile() || stat.size > 160 * 1024 * 1024) throw fail('产物文件不合法');
    const ext = path.extname(value.path).toLowerCase();
    const source = fs.readFileSync(value.path);
    if (ext === '.svg') {
      const svg = cleanSvg(source.toString('utf8'));
      url = writeAsset(docId, Buffer.from(svg), '.svg');
      kind = 'vector';
      const m = await sharp(Buffer.from(svg)).metadata();
      width ??= m.width;
      height ??= m.height;
    } else {
      const m = await sharp(source).metadata();
      width ??= m.width;
      height ??= m.height;
      url = writeAsset(
        docId,
        m.format === 'png' ? source : await sharp(source).png().toBuffer(),
        '.png',
      );
    }
  } else if (value.url) {
    assetPath(docId, value.url);
    url = value.url;
  } else throw fail('图层没有真实图像产物');
  checkDimensions(width, height);
  const layer = layerSchema.parse({
    id: value.id || uid(),
    name,
    url,
    x: value.x ?? 0,
    y: value.y ?? 0,
    width,
    height,
    visible: value.visible ?? true,
    opacity: value.opacity ?? 1,
    opinion: value.opinion || '',
    disposition: value.disposition || 'keep',
    kind,
    preview: value.preview || false,
    cutoutBox: value.cutoutBox,
    sourceCrop: value.sourceCrop,
    frame: value.frame,
    sourceLayerIds: value.sourceLayerIds,
    text: value.text,
    psdStyle: value.psdStyle,
    role: value.role,
    textDirty: value.textDirty,
    originalPsdIndex: value.originalPsdIndex,
    groupPath: value.groupPath,
  });
  if (layer.kind === 'text' && layer.text) {
    if (!layer.frame) {
      layer.x = 0;
      layer.y = 0;
      layer.width = image.width;
      layer.height = image.height;
    }
    layer.url = writeAsset(docId, await renderTextLayer(layer), '.png');
  }
  if (layer.psdStyle)
    layer.previewUrl = writeAsset(
      docId,
      await renderStyledLayer(docId, layer, image.width, image.height),
      '.png',
    );
  return layer;
}
