import fs from 'node:fs';
import { assertPsdBlendSupported } from './psd-blend.js';
import { readPsd, type Psd, type Layer as NativeLayer } from 'ag-psd';
import type { CanvasImage } from './types.js';
import { assetPath } from './store.js';

/** Do not silently lose features the canvas compositor cannot reproduce. */
export function readUpscalePsd(docId: string, image: CanvasImage): Psd | undefined {
  if (!image.psdSource) return;
  const psd = readPsd(fs.readFileSync(assetPath(docId, image.psdSource)), { useImageData: true });
  assertPsdBlendSupported(psd);
  const reject = (name: string, feature: string): never => {
    throw new Error(
      `「${name}」含${feature}，当前分层超分无法无损保留；请在副本中转换该结构后重试。原 PSD 未修改`,
    );
  };
  if (psd.bitsPerChannel && psd.bitsPerChannel !== 8) reject(image.name, '非8位通道');
  if (psd.colorMode !== undefined && psd.colorMode !== 3) reject(image.name, '非RGB颜色模式');
  if (psd.artboards || psd.linkedFiles?.length) reject(image.name, '画板或链接智能对象');
  if ((psd.imageResources as any)?.slices || (psd.imageResources as any)?.pathSelectionState)
    reject(image.name, '切片或路径资源');
  function walk(nodes: NativeLayer[], path: number[] = []) {
    const groups = new Set<string>();
    for (const [i, n] of nodes.entries()) {
      const name = n.name || '图层';
      for (const [key, label] of Object.entries({
        mask: '独立蒙版',
        realMask: '独立蒙版',
        vectorMask: '矢量蒙版',
        vectorFill: '形状填充',
        vectorStroke: '矢量描边',
        placedLayer: '智能对象',
        adjustment: '调整层',
        artboard: '画板',
        animationFrames: '动画',
        filterEffects: '智能滤镜',
      }))
        if ((n as any)[key]) reject(name, label);
      if (
        n.clipping ||
        (n.blendMode && !(n.children ? ['normal', 'pass through'] : ['normal', 'screen']).includes(n.blendMode)) ||
        (n.fillOpacity !== undefined && n.fillOpacity !== 1)
      )
        reject(name, '剪贴、特殊混合模式或填充不透明度');
      if (n.children) {
        if (groups.has(name)) reject(name, '同级重名图层组');
        groups.add(name);
        if (n.hidden || (n.opacity !== undefined && n.opacity !== 1) || n.effects)
          reject(name, '组隐藏、组透明度或组效果');
        if (!n.children.length) reject(name, '空图层组');
        walk(n.children, [...path, i]);
      } else if (!n.imageData) reject(name, '没有像素预览的图层');
      if (n.text?.textPath || (n.text?.warp?.style && n.text.warp.style !== 'none'))
        reject(name, '路径文字或变形文字');
      if (n.effects && !n.effects.disabled) {
        for (const [key, value] of Object.entries(n.effects)) {
          if (!['disabled', 'scale', 'stroke', 'dropShadow'].includes(key) && value)
            reject(name, '暂不支持的原生图层效果');
        }
        if ((n.effects.stroke?.length || 0) > 1 || (n.effects.dropShadow?.length || 0) > 1)
          reject(name, '多重描边或阴影');
        const stroke = n.effects.stroke?.[0];
        if (
          stroke &&
          (stroke.fillType !== 'color' ||
            stroke.position !== 'outside' ||
            (stroke.blendMode && stroke.blendMode !== 'normal'))
        )
          reject(name, '复杂描边');
      }
    }
  }
  walk(psd.children || []);
  return psd;
}

function scaleFields(obj: any, keys: string[], factor: number) {
  if (!obj) return;
  for (const k of keys) if (typeof obj[k] === 'number') obj[k] *= factor;
}
function scaleUnits(obj: any, factor: number) {
  if (!obj || typeof obj !== 'object') return;
  if (['Pixels', 'Points'].includes(obj.units) && typeof obj.value === 'number')
    obj.value *= factor;
  else for (const child of Object.values(obj)) scaleUnits(child, factor);
}
export function scalePsdMetadata(psd: Psd | undefined, factor: number): Psd | undefined {
  if (!psd) return;
  // readUpscalePsd returns a fresh object; never mutate a saved source or cached document.
  psd.width *= factor;
  psd.height *= factor;
  delete psd.canvas;
  delete psd.imageData;
  const guides = (psd.imageResources as any)?.gridAndGuidesInformation;
  for (const g of guides?.guides || []) if (typeof g.location === 'number') g.location *= factor;
  function walk(nodes: NativeLayer[]) {
    for (const n of nodes) {
      scaleFields(n, ['left', 'right', 'top', 'bottom'], factor);
      scaleFields(n.referencePoint, ['x', 'y'], factor);
      scaleUnits(n.effects, factor);
      const t = n.text;
      if (t) {
        scaleFields(t, ['left', 'right', 'top', 'bottom'], factor);
        // Enlarge glyph/layout units, retain rotation/shear; scale translation once.
        if (t.transform) {
          t.transform[4] *= factor;
          t.transform[5] *= factor;
        }
        const style = (s: any) =>
          scaleFields(s, ['fontSize', 'leading', 'baselineShift', 'outlineWidth'], factor);
        const paragraph = (s: any) =>
          scaleFields(
            s,
            ['firstLineIndent', 'startIndent', 'endIndent', 'spaceBefore', 'spaceAfter', 'zone'],
            factor,
          );
        style(t.style);
        t.styleRuns?.forEach((r) => style(r.style));
        paragraph(t.paragraphStyle);
        t.paragraphStyleRuns?.forEach((r) => paragraph(r.style));
        for (const k of ['boxBounds', 'pointBase'] as const)
          if (t[k]) t[k] = t[k]!.map((v) => v * factor);
        scaleUnits(t.bounds, factor);
        scaleUnits(t.boundingBox, factor);
        scaleFields(t.gridInfo, ['size', 'leading'], factor);
      }
      if (n.children) walk(n.children);
    }
  }
  walk(psd.children || []);
  return psd;
}

/** Rebind native indices after export can reorganise groups; verify every layer survived. */
export function verifyUpscaledPsd(bytes: Buffer, image: CanvasImage) {
  const psd = readPsd(bytes, { useImageData: true });
  if (psd.width !== image.width || psd.height !== image.height)
    throw new Error('PSD总画幅校验失败');
  const entries = new Map<string, { node: NativeLayer; index: number[] }[]>();
  const order: string[] = [];
  let count = 0;
  function walk(nodes: NativeLayer[], groups: string[] = [], prefix: number[] = []) {
    nodes.forEach((node, i) => {
      if (node.children) walk(node.children, [...groups, node.name || '图层组'], [...prefix, i]);
      else {
        const key = JSON.stringify([...groups, node.name]);
        order.push(key);
        entries.set(key, [...(entries.get(key) || []), { node, index: [...prefix, i] }]);
        count++;
      }
    });
  }
  walk(psd.children || []);
  if (count !== image.layers.length) throw new Error('PSD图层数量校验失败');
  for (const [i, l] of image.layers.entries()) {
    if (order[i] !== JSON.stringify([...(l.groupPath || []), l.name]))
      throw new Error('图层组内外的顺序无法一致导出，请先整理图层组，未提交结果');
    const entry = entries.get(JSON.stringify([...(l.groupPath || []), l.name]))?.shift();
    if (
      !entry ||
      entry.node.left !== l.x ||
      entry.node.top !== l.y ||
      entry.node.imageData?.width !== l.width ||
      entry.node.imageData?.height !== l.height
    )
      throw new Error(`「${l.name}」PSD位置或尺寸校验失败`);
    if (l.kind === 'text' && entry.node.text?.text !== l.text?.value)
      throw new Error(`「${l.name}」可编辑文字校验失败`);
    if (
      !!entry.node.hidden !== !l.visible ||
      Math.abs((entry.node.opacity ?? 1) - l.opacity) > 1 / 255 + 1e-8
    )
      throw new Error(`「${l.name}」显隐或透明度校验失败`);
    if ((entry.node.blendMode || 'normal') !== (l.blendMode || 'normal'))
      throw new Error(`「${l.name}」混合模式校验失败`);
    l.originalPsdIndex = entry.index;
  }
}
