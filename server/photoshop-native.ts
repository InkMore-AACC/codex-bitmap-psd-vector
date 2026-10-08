import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { readPsd, type Layer as PsdLayer } from 'ag-psd';
import './media.js';
import type { AdobeConnector } from './adobe.js';
import { verifyNativeFilmGroup } from './photoshop-film.js';
import { verifyNativeGeometryGroup } from './photoshop-geometry.js';
import { verifyNativeTextPlaneGroup } from './photoshop-plane-text.js';
import { scopedAdobePath } from './adobe.js';
import {
  photoshopGroupName,
  photoshopMaterialTarget,
  photoshopMaterialQuadMatches,
  isPhotoshopFullBackground,
  type PhotoshopPlan,
} from '../shared/photoshop.js';
import { uid } from './store.js';

export const fileHash = (p: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** Native progress comes from actual visible owned PSD groups, never a material placeholder. */
export function nativeProgressLayers(bytes: Buffer, plan: PhotoshopPlan,
  size: { width: number; height: number }) {
  const native = plan.layers.filter(l => l.route === 'native');
  if (!native.length) return [];
  const psd = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  if (psd.width !== size.width || psd.height !== size.height) throw new Error('原生进度PSD画幅与冻结计划不一致');
  const liveLeaves = (l: PsdLayer): PsdLayer[] => l.hidden || l.opacity === 0 ? []
    : l.children ? l.children.flatMap(liveLeaves) : [l];
  return native.filter(entry => {
    const roots = (psd.children || []).filter(l => l.name === photoshopGroupName(entry.layerId));
    if (roots.length > 1) throw new Error('原生进度分组重复：' + entry.name);
    const root = roots[0];
    if (!root || root.hidden || root.opacity === 0 || !root.children?.length) return false;
    verifyNativeFilmGroup(root, entry);
    verifyNativeGeometryGroup(root, entry);
    verifyNativeTextPlaneGroup(root, entry);
    const leaves = liveLeaves(root).filter(l => (l.right || 0) - (l.left || 0) > 1 &&
      (l.bottom || 0) - (l.top || 0) > 1);
    if (!leaves.length) return false;
    if (entry.editable === 'native-text' && !leaves.some(l => l.text) ||
        entry.editable === 'native-shape' && !leaves.some(l => l.vectorMask) ||
        entry.editable === 'mixed' && !leaves.some(l => l.text || l.vectorMask))
      throw new Error('原生进度不能使用像素/占位冒充可编辑内容：' + entry.name);
    for (const target of entry.textTargets) {
      const matches = leaves.filter(l => l.name === target.layerName && !!l.text);
      if (matches.length !== 1 || matches[0].text!.text.trim() !== target.text.trim())
        throw new Error('原生进度缺少实际可见的匹配文字：' + target.layerName);
    }
    return true;
  });
}

export async function verifyMaterialPlacement(
  psd: ReturnType<typeof readPsd>,
  plan: PhotoshopPlan,
  materials: Record<
    string,
    {
      path: string;
      originalPath: string;
      workingPath?: string;
      upscaledPath?: string;
      choice?: string;
      provenance?: string;
      placementFrame?: { x: number; y: number; width: number; height: number };
    }
  >,
) {
  const reports: Record<string, number[]> = {};
  const leaves = (l: PsdLayer): PsdLayer[] =>
    l.hidden ? [] : l.children ? l.children.flatMap(leaves) : [l];
  for (const entry of plan.layers) {
    if (!['generate', 'hybrid', 'extract'].includes(entry.route)) continue;
    const m = materials[entry.layerId];
    const source = m?.choice === 'upscaled' ? m.upscaledPath : m?.workingPath || m?.originalPath;
    if (!source) throw new Error(`「${entry.name}」缺少已选素材`);
    const root = psd.children?.find((l) => l.name === photoshopGroupName(entry.layerId));
    const matches = root
      ? leaves({ ...root, hidden: false }).filter((l) => l.name === 'LC_MATERIAL')
      : [];
    if (matches.length !== 1 || !matches[0].placedLayer)
      throw new Error(
        `「${entry.name}」须使用place-material装入登记素材，不能paste后按物体轮廓居中或以栅格替身冒充`,
      );
    const meta = await sharp(fs.readFileSync(source)).metadata();
    const frame = m.placementFrame || entry.frame;
    const sourceProtected = m.provenance === 'source-protected';
    if (sourceProtected && !entry.sourceProtection)
      throw new Error(`「${entry.name}」保护素材缺少冻结的背景保护计划`);
    const fit = photoshopMaterialTarget(
      { width: meta.width!, height: meta.height! },
      frame,
      isPhotoshopFullBackground(entry, plan.canvas!),
      sourceProtected,
    );
    const placed = matches[0].placedLayer!,
      actual = placed.nonAffineTransform || placed.transform;
    if (!photoshopMaterialQuadMatches(actual, fit, sourceProtected))
      throw new Error(
        `「${entry.name}」完整素材画幅位置/比例已被改变，请用place-material恢复，不能对齐alpha包围盒`,
      );
    const embedded = psd.linkedFiles?.find((f) => f.id === placed.id)?.data;
    if (
      !embedded ||
      crypto.createHash('sha256').update(embedded).digest('hex') !== fileHash(source)
    )
      throw new Error(`「${entry.name}」智能对象内的素材与登记版本不符，请重新place-material`);
    reports[entry.layerId] = actual;
  }
  return reports;
}
export type NativeRender = {
  psdPath: string;
  previewPath: string;
  thumbnails: Record<string, string>;
  hash: string;
  textFacts?: Record<
    string,
    {
      layerName: string;
      font: string;
      color: { r: number; g: number; b: number };
      warp: { style: string; value: number };
      effects: string[];
    }[]
  >;
  textFactsPath?: string;
  probes?: Record<string, { lightPath: string; darkPath: string }>;
};

/** Always open a unique file copy; never use the user's active document as the edit target. */
export async function renderNativePsd(
  adobe: AdobeConnector,
  input: string,
  folder: string,
  mappings: {
    layerId: string;
    groupName: string;
    name?: string;
    visible?: boolean;
    opacity?: number;
  }[],
  update = false,
): Promise<NativeRender> {
  fs.mkdirSync(folder, { recursive: true });
  const tag = uid();
  const copy = path.join(folder, `native-${tag}.psd`);
  const preview = path.join(folder, `native-${tag}.png`);
  const textFactsPath = path.join(folder, `native-${tag}-text.json`);
  const thumbs = Object.fromEntries(
    mappings.map((m, i) => [m.layerId, path.join(folder, `native-${tag}-${i}.png`)]),
  );
  const probes = Object.fromEntries(
    mappings.map((m, i) => [
      m.layerId,
      {
        lightPath: path.join(folder, `native-${tag}-${i}-light.png`),
        darkPath: path.join(folder, `native-${tag}-${i}-dark.png`),
      },
    ]),
  );
  fs.copyFileSync(input, copy);
  const script = path.join(folder, `render-${tag}.jsx`);
  const q = (v: unknown) => JSON.stringify(v).replace(/\u2028|\u2029/g, ' ');
  fs.writeFileSync(
    script,
    `#target photoshop
(function(){
var prior=app.documents.length?app.activeDocument:null, dialogs=app.displayDialogs, d=null;
try {
app.displayDialogs=DialogModes.NO; d=app.open(new File(${q(copy)}));
var m=${q(mappings)}, t=${q(thumbs)}, probes=${q(probes)}, groups=[], i,j;
function find(name){for(var k=0;k<d.layers.length;k++)if(d.layers[k].name===name)return d.layers[k];throw Error('Missing logical group '+name);}
function png(file){var o=new PNGSaveOptions();d.saveAs(new File(file),o,true,Extension.LOWERCASE);}
for(i=0;i<m.length;i++){groups.push(find(m[i].groupName));}
for(i=0;i<d.layers.length;i++)if(d.layers[i].name.indexOf('LC_REFERENCE')===0)d.layers[i].visible=false;
${
  update
    ? `for(i=0;i<m.length;i++)groups[i].move(d,ElementPlacement.PLACEATBEGINNING);
for(i=0;i<m.length;i++){groups[i].opacity=m[i].opacity*100;groups[i].visible=m[i].visible;}`
    : ''
}
var visibility=[];for(i=0;i<d.layers.length;i++)visibility.push(d.layers[i].visible);
png(${q(preview)});
var qa=d.artLayers.add();qa.name='LC_QA_TEMP';qa.move(d,ElementPlacement.PLACEATEND);qa.visible=false;
function backdrop(value){d.activeLayer=qa;qa.visible=true;d.selection.selectAll();var col=new SolidColor();col.rgb.red=value;col.rgb.green=value;col.rgb.blue=value;d.selection.fill(col);d.selection.deselect();}
for(i=0;i<m.length;i++){
 for(j=0;j<d.layers.length;j++)d.layers[j].visible=false;
 groups[i].visible=true;png(t[m[i].layerId]);
 backdrop(238);png(probes[m[i].layerId].lightPath);backdrop(32);png(probes[m[i].layerId].darkPath);qa.visible=false;
}
qa.remove();
for(i=0;i<d.layers.length;i++)d.layers[i].visible=visibility[i];
var save=new PhotoshopSaveOptions();save.layers=true;save.embedColorProfile=true;d.saveAs(new File(${q(copy)}),save,true,Extension.LOWERCASE);
var facts={},s=stringIDToTypeID;
function encode(v){if(v===null)return 'null';if(typeof v==='number'||typeof v==='boolean')return String(v);if(typeof v==='string'){var out='"',bs=String.fromCharCode(92);for(var a=0;a<v.length;a++){var n=v.charCodeAt(a);out+=(n===34||n===92)?bs+v.charAt(a):n<32?bs+'u'+('0000'+n.toString(16)).slice(-4):v.charAt(a);}return out+'"';}var items=[];if(v instanceof Array){for(var b=0;b<v.length;b++)items.push(encode(v[b]));return '['+items.join(',')+']';}for(var k in v)if(v.hasOwnProperty(k))items.push(encode(k)+':'+encode(v[k]));return '{'+items.join(',')+'}';}
function readText(l,rows,hidden){if(hidden||!l.visible)return;if(l.typename==='LayerSet'){for(var k=0;k<l.layers.length;k++)readText(l.layers[k],rows,false);return;}if(l.kind!==LayerKind.TEXT)return;
var ref=new ActionReference();ref.putIdentifier(s('layer'),l.id);var desc=executeActionGet(ref),effects=[],map={frameFX:'stroke',dropShadow:'dropShadow',innerShadow:'innerShadow',outerGlow:'outerGlow',innerGlow:'innerGlow',bevelEmboss:'bevel',solidFill:'solidFill',gradientFill:'gradientOverlay'};
if(desc.hasKey(s('layerEffects'))&&(!desc.hasKey(s('layerFXVisible'))||desc.getBoolean(s('layerFXVisible')))){var fx=desc.getObjectValue(s('layerEffects'));for(var key in map){var ids=[s(key),s(key+'Multi')];for(var e=0;e<ids.length;e++)if(fx.hasKey(ids[e])){var values=[];if(e===0)values.push(fx.getObjectValue(ids[e]));else{var list=fx.getList(ids[e]);for(var z=0;z<list.count;z++)values.push(list.getObjectValue(z));}for(var z=0;z<values.length;z++)if(!values[z].hasKey(s('enabled'))||values[z].getBoolean(s('enabled'))){effects.push(map[key]);break;}}}}
var ti=l.textItem,col=ti.color.rgb;rows.push({layerName:l.name,font:ti.font,color:{r:col.red,g:col.green,b:col.blue},warp:{style:String(ti.warpStyle).replace('WarpStyle.','').toLowerCase(),value:ti.warpBend},effects:effects});}
for(i=0;i<m.length;i++){var rows=[];for(j=0;j<groups[i].layers.length;j++)readText(groups[i].layers[j],rows,false);facts[m[i].layerId]=rows;}
var factFile=new File(${q(textFactsPath)});factFile.encoding='UTF8';factFile.open('w');factFile.write(encode(facts));factFile.close();
}finally{if(d)d.close(SaveOptions.DONOTSAVECHANGES);app.displayDialogs=dialogs;if(prior)try{app.activeDocument=prior;}catch(e){}}
})();`,
    'utf8',
  );
  await adobe.executeScript('photoshop', script, folder, [
    preview,
    textFactsPath,
    ...Object.values(thumbs),
    ...Object.values(probes).flatMap((p) => [p.lightPath, p.darkPath]),
  ]);
  if (update) {
    const saved = readPsd(fs.readFileSync(copy), {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
    });
    for (const m of mappings) {
      const g = saved.children?.find((g) => g.name === m.groupName);
      if (
        !g ||
        !g.hidden !== m.visible ||
        Math.abs((g.opacity ?? 1) - (m.opacity ?? 1)) > 1 / 255 + 0.0001
      )
        throw new Error('PS图层显示状态回读不一致，已保留上一版预览');
    }
    const actual = saved.children
      ?.filter((g) => mappings.some((m) => m.groupName === g.name))
      .map((g) => g.name);
    if (JSON.stringify(actual) !== JSON.stringify(mappings.map((m) => m.groupName)))
      throw new Error('PS图层顺序回读不一致，已保留上一版');
  }
  return {
    psdPath: copy,
    previewPath: preview,
    thumbnails: thumbs,
    probes,
    hash: fileHash(copy),
    textFactsPath,
    textFacts: JSON.parse(fs.readFileSync(textFactsPath, 'utf8').replace(/^\uFEFF/, '')),
  };
}

/** Structural acceptance does not claim visual similarity. */
export function validateNativeStructure(
  bytes: Buffer,
  plan: PhotoshopPlan,
  size: { width: number; height: number; layers?: { id: string; visible: boolean }[] },
) {
  const psd = readPsd(bytes, {
    useImageData: true,
    skipCompositeImageData: true,
    skipLayerImageData: true,
    skipThumbnail: true,
  });
  if (psd.width !== size.width || psd.height !== size.height)
    throw new Error('PSD 总画幅与冻结计划不一致');
  const roots = psd.children || [];
  const names = plan.layers.map((l) => photoshopGroupName(l.layerId));
  if (
    roots.some(
      (l) => !names.includes(l.name || '') && !(l.hidden && l.name?.startsWith('LC_REFERENCE')),
    )
  )
    throw new Error('PSD 含未映射的顶层内容；原图只可作为隐藏的 LC_REFERENCE 参考层');
  const actual = roots.filter((l) => names.includes(l.name || '')).map((l) => l.name);
  if (JSON.stringify(actual) !== JSON.stringify(names))
    throw new Error('PSD 逻辑分组缺失、重复或上下顺序不符合建议分层');
  function leaves(layer: PsdLayer, hidden = false): PsdLayer[] {
    const off = hidden || !!layer.hidden;
    if (off) return [];
    return layer.children ? layer.children.flatMap((l) => leaves(l, off)) : [layer];
  }
  for (const entry of plan.layers) {
    const root = roots.find((l) => l.name === photoshopGroupName(entry.layerId))!;
    const expected = size.layers?.find((l) => l.id === entry.layerId);
    if (!root.hidden !== (expected?.visible ?? true))
      throw new Error(`「${entry.name}」PS可见性与冻结图层不一致`);
    if (!root.children?.length) throw new Error(`「${entry.name}」必须包含实际内容分组`);
    verifyNativeFilmGroup(root, entry);
    verifyNativeGeometryGroup(root, entry);
    const live = leaves({ ...root, hidden: false });
    verifyNativeTextPlaneGroup(root, entry);
    if (!live.some((l) => (l.right || 0) - (l.left || 0) > 1 && (l.bottom || 0) - (l.top || 0) > 1))
      throw new Error(`「${entry.name}」只有空层、隐藏占位或1像素占位`);
    if (entry.editable === 'native-text' && !live.some((l) => !!l.text))
      throw new Error(`「${entry.name}」未包含声明的原生文字`);
    if (entry.editable === 'native-shape' && !live.some((l) => !!l.vectorMask))
      throw new Error(`「${entry.name}」未包含声明的矢量路径`);
    if (entry.editable === 'mixed' && !live.some((l) => !!l.text || !!l.vectorMask))
      throw new Error(`「${entry.name}」只有像素或隐藏参考，不能声明可编辑混合成果`);
    for (const target of entry.textTargets || []) {
      const matches = live.filter((l) => l.name === target.layerName && !!l.text);
      if (matches.length !== 1 || matches[0].text!.text.trim() !== target.text.trim())
        throw new Error(
          `「${entry.name}」缺少实际可见的匹配文字「${target.layerName}」，隐藏备份不能算文字重建`,
        );
    }
  }
  return psd;
}

export function nativeTextReport(
  psd: ReturnType<typeof readPsd>,
  plan: PhotoshopPlan,
  actualFacts?: NativeRender['textFacts'],
) {
  const result: Record<
    string,
    {
      layerName: string;
      bounds: number[];
      target: number[];
      font?: string;
      color?: unknown;
      warp?: unknown;
      rotation: number;
      shear: number;
      effects: string[];
      appearanceMismatch: string[];
      severeGeometry: boolean;
    }[]
  > = {};
  function live(l: PsdLayer): PsdLayer[] {
    return l.hidden ? [] : l.children ? l.children.flatMap(live) : [l];
  }
  for (const entry of plan.layers) {
    const root = psd.children?.find((l) => l.name === photoshopGroupName(entry.layerId));
    if (!root) continue;
    const leaves = live({ ...root, hidden: false });
    result[entry.layerId] = (entry.textTargets || []).map((t) => {
      const l = leaves.find((l) => l.name === t.layerName && l.text)!;
      const fact = actualFacts?.[entry.layerId]?.find((f) => f.layerName === t.layerName);
      const bounds = [l.left ?? 0, l.top ?? 0, l.right ?? 0, l.bottom ?? 0];
      const target = [t.box.x, t.box.y, t.box.x + t.box.width, t.box.y + t.box.height];
      // Gross native placement errors only. Small glyph/style differences remain visual review, not a 1% gate.
      const severeGeometry = bounds.some(
        (n, i) =>
          Math.abs(n - target[i]) > Math.max(6, (i % 2 ? t.box.height : t.box.width) * 0.08),
      );
      const tr = l.text!.transform || [1, 0, 0, 1, 0, 0];
      const rotation = (Math.atan2(tr[1], tr[0]) * 180) / Math.PI;
      const denom = Math.hypot(tr[0], tr[1]) * Math.hypot(tr[2], tr[3]);
      const shear = denom
        ? (Math.asin(Math.max(-1, Math.min(1, (tr[0] * tr[2] + tr[1] * tr[3]) / denom))) * 180) /
          Math.PI
        : 0;
      const effects =
        fact?.effects ||
        Object.entries(l.effects || {})
          .filter(
            ([key, v]) =>
              !['disabled', 'scale'].includes(key) &&
              !l.effects?.disabled &&
              (Array.isArray(v)
                ? v.some((e) => e.enabled !== false)
                : typeof v === 'object' && v && !('enabled' in v && v.enabled === false)),
          )
          .map(([key]) => key);
      const a = t.appearance,
        appearanceMismatch: string[] = [];
      const font = fact?.font || l.text!.style?.font?.name,
        warp = fact?.warp || l.text!.warp;
      if (a?.font && font !== a.font) appearanceMismatch.push('字体不符');
      const color = fact?.color || l.text!.style?.fillColor;
      if (
        a?.color &&
        (!color ||
          !('r' in color) ||
          a.color.some((v, i) => Math.abs(v - [color.r, color.g, color.b][i]) > 30))
      )
        appearanceMismatch.push('填充颜色不符');
      if (a?.rotation !== undefined && Math.abs(((rotation - a.rotation + 540) % 360) - 180) > 3)
        appearanceMismatch.push('倾斜角度不符');
      if (a?.requiresShear && Math.abs(shear) < 1) appearanceMismatch.push('缺少斜切变形');
      if (a?.shear !== undefined && Math.abs(shear - a.shear) > 3)
        appearanceMismatch.push('斜切程度不符');
      if (a?.warpStyle && (warp?.style || 'none').toLowerCase() !== a.warpStyle.toLowerCase())
        appearanceMismatch.push('文字变形不符');
      if (a?.warpBend !== undefined && Math.abs((warp?.value || 0) - a.warpBend) > 3)
        appearanceMismatch.push('文字弯曲程度不符');
      for (const effect of a?.requiredEffects || [])
        if (!effects.includes(effect)) appearanceMismatch.push(`缺少原生样式:${effect}`);
      return {
        layerName: t.layerName,
        bounds,
        target,
        font,
        color,
        warp,
        rotation,
        shear,
        effects,
        appearanceMismatch,
        severeGeometry,
      };
    });
  }
  return result;
}

export async function assertNotWholeOriginal(
  render: NativeRender,
  cleanPaths: string[],
  plan: PhotoshopPlan,
) {
  const digest = async (p: string) => {
    const { data, info } = await sharp(fs.readFileSync(p))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return `${info.width}x${info.height}:` + crypto.createHash('sha256').update(data).digest('hex');
  };
  const originals = await Promise.all(cleanPaths.map(digest));
  for (const l of plan.layers) {
    const thumb = render.thumbnails[l.layerId];
    const rgba = await sharp(fs.readFileSync(thumb)).ensureAlpha().png().toBuffer();
    const stat = await sharp(rgba).stats();
    const f = l.frame,
      c = plan.canvas;
    const outside =
      c && (f.x + f.width <= 0 || f.y + f.height <= 0 || f.x >= c.width || f.y >= c.height);
    if (stat.channels[3].max === 0 && !outside)
      throw new Error(`「${l.name}」实际渲染为空，不能用空分组代替内容`);
    if (plan.layers.length > 1 && originals.includes(await digest(thumb)))
      throw new Error(`「${l.name}」仍承载整张输入图，不能用整图垫底代替分层`);
  }
}

export function taskPsd(folder: string, input: string) {
  const p = scopedAdobePath(folder, input, true);
  if (path.extname(p).toLowerCase() !== '.psd' || !fs.statSync(p).isFile())
    throw new Error('需要本次交接目录中的真实 PSD');
  return p;
}
