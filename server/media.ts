import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import {
  initializeCanvas,
  readPsd,
  writePsdBuffer,
  type Psd,
  type Layer as PsdLayer,
} from 'ag-psd';
import { assetPath, writeAsset, uid } from './store.js';
import { cleanSvg, combineSvg, splitSvgLayers } from './svg.js';
import type { CanvasImage, Document, Layer } from './types.js';
initializeCanvas(
  (w, h) => createCanvas(w, h) as any,
  (w, h) => new ImageData(w, h) as any,
);
function colorHex(c: any) {
  if (c && 'r' in c)
    return '#' + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
  return '#000000';
}
function editableEffects(l: PsdLayer) {
  const result: any = {};
  const stroke = l.effects?.stroke?.[0],
    shadow = l.effects?.dropShadow?.[0];
  if (stroke && stroke.enabled !== false && stroke.fillType === 'color') {
    result.stroke = { color: colorHex(stroke.color), size: stroke.size?.value || 0 };
  }
  if (shadow && shadow.enabled !== false) {
    const distance = shadow.distance?.value || 0,
      angle = ((shadow.angle || 0) * Math.PI) / 180;
    result.shadow = {
      color: colorHex(shadow.color),
      blur: shadow.size?.value || 0,
      offsetX: -Math.cos(angle) * distance,
      offsetY: Math.sin(angle) * distance,
      opacity: shadow.opacity ?? 1,
    };
  }
  return Object.keys(result).length ? result : undefined;
}
export async function importImage(
  doc: Document,
  buffer: Buffer,
  name: string,
): Promise<CanvasImage> {
  const ext = path.extname(name).toLowerCase();
  let source = '',
    url = '',
    width = 0,
    height = 0;
  const layers: Layer[] = [];
  let psdSource: string | undefined;
  if (ext === '.psd') {
    const psd = readPsd(buffer, { useImageData: true });
    width = psd.width;
    height = psd.height;
    checkDimensions(width, height);
    psdSource = writeAsset(doc.id, buffer, '.psd');
    async function walk(children: PsdLayer[], indices: number[] = [], groups: string[] = []) {
      for (let i = 0; i < children.length; i++) {
        const l = children[i];
        if (l.children) {
          await walk(l.children, [...indices, i], [...groups, l.name || '图层组']);
          continue;
        }
        const d = l.imageData;
        if (!d) continue;
        const png = await sharp(Buffer.from(d.data), {
          raw: { width: d.width, height: d.height, channels: 4 },
        })
          .png()
          .toBuffer();
        const u = writeAsset(doc.id, png, '.png');
        layers.push({
          id: uid(),
          name: l.name || '图层',
          url: u,
          x: l.left || 0,
          y: l.top || 0,
          width: d.width,
          height: d.height,
          visible: !l.hidden,
          opacity: l.opacity ?? 1,
          opinion: '',
          disposition: 'keep',
          kind: l.text ? 'text' : 'raster',
          originalPsdIndex: [...indices, i],
          groupPath: groups,
          psdStyle: editableEffects(l),
          text: l.text
            ? {
                value: l.text.text,
                fontFamily: l.text.style?.font?.name || 'Arial',
                fontSize: l.text.style?.fontSize || 24,
                color: colorHex(l.text.style?.fillColor),
                x: l.text.transform?.[4] || 0,
                y: l.text.transform?.[5] || 0,
              }
            : undefined,
        });
      }
    }
    await walk(psd.children || []);
    for (const l of layers) {
      if (l.psdStyle)
        l.previewUrl = writeAsset(
          doc.id,
          await renderStyledLayer(doc.id, l, width, height),
          '.png',
        );
    }
    if (psd.imageData) {
      const d = psd.imageData;
      url = writeAsset(
        doc.id,
        await sharp(Buffer.from(d.data), { raw: { width: d.width, height: d.height, channels: 4 } })
          .png()
          .toBuffer(),
        '.png',
      );
    } else {
      const image = { width, height, layers } as CanvasImage;
      url = writeAsset(doc.id, await renderImage(doc.id, image), '.png');
    }
    source = url;
  } else if (ext === '.svg') {
    const svg = cleanSvg(buffer.toString('utf8'));
    const meta = await sharp(Buffer.from(svg)).metadata();
    width = meta.width || 512;
    height = meta.height || 512;
    checkDimensions(width, height);
    source = writeAsset(doc.id, Buffer.from(svg), '.svg');
    url = source;
    for (const vector of splitSvgLayers(svg)) {
      layers.push({
        id: uid(),
        name: vector.name,
        kind: 'vector',
        url: writeAsset(doc.id, Buffer.from(vector.svg), '.svg'),
        x: 0,
        y: 0,
        width,
        height,
        visible: true,
        opacity: 1,
        opinion: '',
        disposition: 'keep',
      });
    }
  } else {
    const input = sharp(buffer, { limitInputPixels: 64_000_000 });
    const m = await input.metadata();
    if (!['png', 'jpeg', 'webp'].includes(m.format || ''))
      throw new Error('支持 PNG、JPEG、WebP、PSD 和 SVG');
    const png = await input.rotate().png().toBuffer();
    const meta = await sharp(png).metadata();
    width = meta.width!;
    height = meta.height!;
    checkDimensions(width, height);
    source = writeAsset(doc.id, png, '.png');
    url = source;
  }
  const nextX = doc.images.length ? Math.max(...doc.images.map((i) => i.x + i.width)) + 80 : 70;
  return {
    id: uid(),
    name: path.basename(name),
    width,
    height,
    x: nextX,
    y: 80,
    source,
    url,
    layers,
    annotations: [],
    opinion: '',
    status: ext === '.psd' ? 'layered' : ext === '.svg' ? 'vector' : 'original',
    version: 1,
    psdSource,
    vectorUrl: ext === '.svg' ? source : undefined,
  };
}
export function checkDimensions(w: number, h: number) {
  if (
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    w < 1 ||
    h < 1 ||
    w * h > 64_000_000 ||
    w > 30000 ||
    h > 30000
  )
    throw new Error('图片尺寸超出范围（最多 6400 万像素，最长边 30000）');
}
export async function renderStyledLayer(docId: string, l: Layer, width: number, height: number) {
  if (l.kind === 'plan') throw new Error('规划框没有可渲染的图像效果');
  const png = await sharp(fs.readFileSync(assetPath(docId, l.url)))
    .png()
    .toBuffer();
  const s = l.psdStyle?.stroke,
    sh = l.psdStyle?.shadow;
  let filter = '';
  if (s && s.size > 0)
    filter += `<feMorphology in="SourceAlpha" operator="dilate" radius="${s.size}" result="outline"/><feFlood flood-color="${s.color}" result="color"/><feComposite in="color" in2="outline" operator="in" result="colored"/><feMerge><feMergeNode in="colored"/><feMergeNode in="SourceGraphic"/></feMerge>`;
  if (sh)
    filter += `<feDropShadow dx="${sh.offsetX}" dy="${sh.offsetY}" stdDeviation="${sh.blur / 2}" flood-color="${sh.color}" flood-opacity="${sh.opacity}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><filter id="effects" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">${filter}</filter></defs><image href="data:image/png;base64,${png.toString('base64')}" x="${l.x}" y="${l.y}" width="${l.width}" height="${l.height}" filter="url(#effects)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
export async function renderTextLayer(layer: Layer, effects = false) {
  const c = createCanvas(layer.width, layer.height);
  const ctx = c.getContext('2d');
  const t = layer.text!;
  ctx.font = `${t.fontSize}px "${t.fontFamily.replaceAll('"', '')}"`;
  ctx.fillStyle = t.color;
  const s = effects ? layer.psdStyle?.stroke : undefined,
    shadow = effects ? layer.psdStyle?.shadow : undefined;
  if (shadow) {
    ctx.shadowColor =
      shadow.color +
      Math.round(shadow.opacity * 255)
        .toString(16)
        .padStart(2, '0');
    ctx.shadowBlur = shadow.blur;
    ctx.shadowOffsetX = shadow.offsetX;
    ctx.shadowOffsetY = shadow.offsetY;
  }
  for (const [i, line] of t.value.split('\n').entries()) {
    if (s) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size * 2;
      ctx.strokeText(line, t.x - layer.x, t.y - layer.y + i * t.fontSize * 1.2);
    }
    ctx.fillText(line, t.x - layer.x, t.y - layer.y + i * t.fontSize * 1.2);
  }
  return c.toBuffer('image/png');
}
export async function renderImage(docId: string, image: CanvasImage) {
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  if (!image.layers.length) {
    return sharp(fs.readFileSync(assetPath(docId, image.source)))
      .png()
      .toBuffer();
  }
  if (image.layers.some((l) => l.kind === 'plan')) {
    const source = await loadImage(fs.readFileSync(assetPath(docId, image.source)));
    ctx.drawImage(source, 0, 0, image.width, image.height);
  }
  for (const layer of image.layers) {
    if (layer.kind === 'plan') continue;
    if (!layer.visible) continue;
    ctx.globalAlpha = layer.opacity;
    try {
      const img = await loadImage(fs.readFileSync(assetPath(docId, layer.previewUrl || layer.url)));
      ctx.drawImage(
        img,
        layer.previewUrl ? 0 : layer.x,
        layer.previewUrl ? 0 : layer.y,
        layer.previewUrl ? image.width : layer.width,
        layer.previewUrl ? image.height : layer.height,
      );
    } catch (e) {
      if (layer.kind === 'text' && layer.text) {
        ctx.fillStyle = layer.text.color;
        ctx.font = `${layer.text.fontSize}px "${layer.text.fontFamily}"`;
        ctx.fillText(layer.text.value, layer.text.x, layer.text.y);
      } else throw e;
    }
  }
  return canvas.toBuffer('image/png');
}
export function exportSvg(docId: string, image: CanvasImage) {
  return combineSvg(image.width, image.height, image.vectorLayers || image.layers, (u) =>
    fs.readFileSync(assetPath(docId, u), 'utf8'),
  );
}
export async function exportPsd(docId: string, image: CanvasImage) {
  if (image.layers.some((l) => l.kind === 'plan'))
    throw new Error('规划框尚未重建，不能导出分层 PSD');
  const original = image.psdSource
    ? readPsd(fs.readFileSync(assetPath(docId, image.psdSource)), { useImageData: true })
    : undefined;
  const psd: Psd = { ...(original || {}), width: image.width, height: image.height, children: [] };
  delete psd.canvas;
  const buffer = await renderImage(docId, image);
  const raw = await sharp(buffer).ensureAlpha().raw().toBuffer();
  psd.imageData = { width: image.width, height: image.height, data: new Uint8ClampedArray(raw) };
  const layers = image.layers.length
    ? image.layers
    : [
        {
          id: uid(),
          name: '原图',
          url: image.source,
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
          visible: true,
          opacity: 1,
          opinion: '',
          disposition: 'keep',
          kind: 'raster',
        } as Layer,
      ];
  for (const l of layers) {
    if (l.kind === 'plan') throw new Error('规划框尚未重建');
    let existing: PsdLayer | undefined;
    if (original && l.originalPsdIndex) {
      let children = original.children;
      for (const index of l.originalPsdIndex) {
        existing = children?.[index];
        children = existing?.children;
      }
    }
    const png = await sharp(fs.readFileSync(assetPath(docId, l.url)))
      .resize(Math.max(1, Math.round(l.width)), Math.max(1, Math.round(l.height)))
      .ensureAlpha()
      .raw()
      .toBuffer();
    const pl: PsdLayer = {
      ...(existing || {}),
      name: l.name,
      left: Math.round(l.x),
      top: Math.round(l.y),
      right: Math.round(l.x + l.width),
      bottom: Math.round(l.y + l.height),
      opacity: l.opacity,
      hidden: !l.visible,
      imageData: {
        width: Math.round(l.width),
        height: Math.round(l.height),
        data: new Uint8ClampedArray(png),
      },
    };
    delete pl.canvas;
    if (l.kind !== 'text') delete pl.text;
    if (l.kind === 'text' && l.text && (!existing?.text || l.textDirty)) {
      const c = l.text.color.match(/^#([0-9a-f]{6})$/i)?.[1] || 'ffffff';
      pl.text = {
        ...(existing?.text || {}),
        text: l.text.value,
        transform: [
          ...(existing?.text?.transform?.slice(0, 4) || [1, 0, 0, 1]),
          l.text.x,
          l.text.y,
        ] as [number, number, number, number, number, number],
        style: {
          ...(existing?.text?.style || {}),
          font: { name: l.text.fontFamily },
          fontSize: l.text.fontSize,
          fillColor: {
            r: parseInt(c.slice(0, 2), 16),
            g: parseInt(c.slice(2, 4), 16),
            b: parseInt(c.slice(4, 6), 16),
          },
        },
      };
      if (l.textDirty) {
        delete pl.text.styleRuns;
        delete pl.text.paragraphStyleRuns;
      }
    }
    if (l.psdStyle && (!existing || l.textDirty)) {
      const rgb = (hex: string) => ({
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
      });
      pl.effects = { ...(pl.effects || {}) };
      delete pl.effects.stroke;
      delete pl.effects.dropShadow;
      if (l.psdStyle.stroke) {
        const s = l.psdStyle.stroke;
        pl.effects.stroke = [
          {
            enabled: true,
            present: true,
            size: { units: 'Pixels', value: s.size },
            position: 'outside',
            fillType: 'color',
            color: rgb(s.color),
            opacity: 1,
            blendMode: 'normal',
          },
        ];
      }
      if (l.psdStyle.shadow) {
        const s = l.psdStyle.shadow;
        pl.effects.dropShadow = [
          {
            enabled: true,
            present: true,
            size: { units: 'Pixels', value: s.blur },
            distance: { units: 'Pixels', value: Math.hypot(s.offsetX, s.offsetY) },
            angle: (Math.atan2(s.offsetY, -s.offsetX) * 180) / Math.PI,
            color: rgb(s.color),
            opacity: s.opacity,
            blendMode: 'multiply',
            useGlobalLight: false,
          },
        ];
      }
    }
    let children = psd.children!;
    let originalChildren = original?.children;
    for (const group of l.groupPath || []) {
      const sourceGroup = originalChildren?.find((c) => c.name === group && c.children);
      let parent = children.find((c) => c.name === group && c.children);
      if (!parent) {
        parent = { ...(sourceGroup || {}), name: group, children: [], opened: true };
        children.push(parent);
      }
      children = parent.children!;
      originalChildren = sourceGroup?.children;
    }
    children.push(pl);
  }
  return writePsdBuffer(psd, { generateThumbnail: false });
}
