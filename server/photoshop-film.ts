import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { readPsd, writePsdBuffer, type Layer as PsdLayer, type Psd } from 'ag-psd';
import './media.js';
import { type PhotoshopPlan, photoshopGroupName } from '../shared/photoshop.js';
import { validateNativeFilmRecipe } from '../shared/native-film.js';
import {filmCutoutKnots} from '../shared/film-cutouts.js';
import { opticalPartError } from '../shared/optical-parts.js';
import { GENERATION_PIXEL_BUDGET } from '../shared/generation-geometry.js';
import type { AdobeConnector } from './adobe.js';
import { scopedAdobePath } from './adobe.js';
import { uid } from './store.js';

const metadata = (bytes: Buffer) => readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
type Entry = PhotoshopPlan['layers'][number];
export function validateNativeFilmEntry(entry: Entry) {
  if (!entry.nativeFilm) return;
  if (entry.route !== 'native' || entry.content !== 'shape' || entry.editable !== 'native-shape' ||
      entry.surface !== 'transparent' || entry.opticalPart?.kind !== 'thin-film' || entry.textTargets.length || entry.nativeFallback)
    throw opticalPartError('原生薄膜配方仅用于native/shape/native-shape透明薄膜分件，不用于文字、位图或fallback');
  validateNativeFilmRecipe(entry.nativeFilm, entry.frame);
}
function filmShape(entry: Entry): PsdLayer {
  validateNativeFilmEntry(entry);
  const recipe = entry.nativeFilm!;
  const f = entry.frame, canvas = createCanvas(f.width, f.height), ctx = canvas.getContext('2d');
  const knots = recipe.knots;
  ctx.beginPath(); ctx.moveTo(knots[0][2] - f.x, knots[0][3] - f.y);
  for (let i = 1; i <= knots.length; i++) {
    const a = knots[(i - 1) % knots.length], b = knots[i % knots.length];
    ctx.bezierCurveTo(a[4] - f.x, a[5] - f.y, b[0] - f.x, b[1] - f.y, b[2] - f.x, b[3] - f.y);
  }
  ctx.closePath();
  for(const c of recipe.cutouts||[]) {ctx.moveTo(c.center[0]-f.x+c.radiusX*Math.cos(c.angle*Math.PI/180),c.center[1]-f.y+c.radiusX*Math.sin(c.angle*Math.PI/180));ctx.ellipse(c.center[0]-f.x,c.center[1]-f.y,c.radiusX,c.radiusY,c.angle*Math.PI/180,0,2*Math.PI);ctx.closePath();}
  const angle = -recipe.gradient.angle * Math.PI / 180, dx = Math.cos(angle), dy = Math.sin(angle);
  const radius = (Math.abs(dx) * f.width + Math.abs(dy) * f.height) / 2;
  const gradient = ctx.createLinearGradient(f.width / 2 - dx * radius, f.height / 2 - dy * radius,
    f.width / 2 + dx * radius, f.height / 2 + dy * radius);
  for (const stop of recipe.gradient.stops) gradient.addColorStop(stop.position, `rgba(${stop.color.join(',')},${stop.alpha / 255})`);
  ctx.fillStyle = gradient; ctx.fill('evenodd');
  return { name: 'LC_NATIVE_FILM', left: f.x, top: f.y, right: f.x + f.width, bottom: f.y + f.height,
    opacity: 1, blendMode: 'normal', canvas: canvas as any,
    vectorMask: { fillStartsWithAllPixels: false, paths: [{ open: false, fillRule: 'non-zero', operation: 'combine',
      knots: knots.map(points => ({ linked: false, points: [...points] })) },
      ...(recipe.cutouts||[]).map(c=>({open:false,fillRule:'non-zero' as const,operation:'subtract' as const,knots:filmCutoutKnots(c).map(points=>({linked:false,points}))}))] },
    vectorFill: { type: 'solid', name: 'LC_NATIVE_FILM', smoothness: 1, style: 'linear', angle: recipe.gradient.angle,
      scale: 1, align: true, reverse: false, dither: false, interpolationMethod: 'classic',
      colorStops: recipe.gradient.stops.map(s => ({ color: { r: s.color[0], g: s.color[1], b: s.color[2] }, location: s.position, midpoint: 0.5 })),
      opacityStops: recipe.gradient.stops.map(s => ({ opacity: s.alpha / 255, location: s.position, midpoint: 0.5 })),
    },
  };
}

/** A PSD source with genuine editable shape metadata. Its cache is not native Photoshop evidence. */
export function prepareNativeFilmPsd(plan: PhotoshopPlan, layerId: string) {
  const entry = plan.layers.find(l => l.layerId === layerId);
  if (!entry?.nativeFilm || !plan.canvas) throw opticalPartError('缺少冻结原生薄膜配方或PS画布');
  if (plan.canvas.width * plan.canvas.height > GENERATION_PIXEL_BUDGET)
    throw opticalPartError('原生薄膜制作工作画布含留白不得超过150万像素；不能临时缩放冻结路径');
  const psd: Psd = { ...plan.canvas, channels: 4, bitsPerChannel: 8, colorMode: 3,
    children: [{ name: photoshopGroupName(layerId), children: [filmShape(entry)], opacity: 1, blendMode: 'normal' }] };
  return writePsdBuffer(psd);
}

/** Frozen path and gradient metadata, checked again on the actual PS-saved file. */
export function verifyNativeFilmGroup(group: PsdLayer | undefined, entry: Entry) {
  if (!entry.nativeFilm) return;
  validateNativeFilmEntry(entry);
  const fail = () => { throw opticalPartError(`「${entry.name}」原生薄膜路径/透明渐变与冻结配方不符`); };
  if (!group || group.hidden || Math.abs((group.opacity ?? 1) - 1) > 1e-6 ||
      group.blendMode && group.blendMode !== 'normal' || group.children?.length !== 1) return fail();
  const shape = group.children[0], mask = shape.vectorMask, fill = shape.vectorFill;
  if (shape.hidden || Math.abs((shape.opacity ?? 1) - 1) > 1e-6 || shape.children || shape.text || shape.effects || shape.mask ||
      shape.vectorStroke?.strokeEnabled || shape.vectorStroke?.fillEnabled === false ||
      shape.blendMode && shape.blendMode !== 'normal' || !mask || mask.disable || mask.invert || mask.paths.length !== 1+(entry.nativeFilm.cutouts?.length||0) ||
      mask.fillStartsWithAllPixels || !fill || fill.type !== 'solid') return fail();
  const actual = mask.paths[0], recipe = entry.nativeFilm;
  if (actual.open || actual.fillRule !== 'non-zero' || actual.operation && actual.operation !== 'combine' || actual.knots.length !== recipe.knots.length ||
      actual.knots.some((k, i) => k.points.length !== 6 || k.points.some((v, n) => Math.abs(v - recipe.knots[i][n]) > 0.01)) ||
      fill.style !== 'linear' || Math.abs((fill.angle ?? 0) - recipe.gradient.angle) > 0.01 ||
      // PS 27.6 omits default gradient fields on save. The native-fill recipe
      // fixes alignment to the layer; an explicit false remains incompatible.
      // Geometry/stop metadata and actual PS group-alpha/visual checks are still required.
      Math.abs((fill.scale ?? 1) - 1) > 0.0001 || (fill.align ?? true) !== true || fill.reverse ||
      fill.offset && (Math.abs(fill.offset.x) > 0.0001 || Math.abs(fill.offset.y) > 0.0001) ||
      fill.colorStops.length !== recipe.gradient.stops.length || fill.opacityStops.length !== recipe.gradient.stops.length) return fail();
  for(const [i,c] of (recipe.cutouts||[]).entries()) {
    const p=mask.paths[i+1],expected=filmCutoutKnots(c);
    if(p.open||p.fillRule!=='non-zero'||p.operation!=='subtract'||p.knots.length!==expected.length||
        p.knots.some((k,n)=>k.points.length!==6||k.points.some((v,q)=>Math.abs(v-expected[n][q])>.01)))return fail();
  }
  for (let i = 0; i < recipe.gradient.stops.length; i++) {
    const s = recipe.gradient.stops[i], c = fill.colorStops[i], a = fill.opacityStops[i];
    if (!('r' in c.color) || [c.color.r, c.color.g, c.color.b].some((v, k) => Math.abs(v - s.color[k]) > 0.01) ||
        Math.abs(c.location - s.position) > 1 / 4096 || Math.abs(a.location - s.position) > 1 / 4096 ||
        Math.abs(a.opacity - s.alpha / 255) > 1 / 255 + 0.00001 ||
        Math.abs(c.midpoint - 0.5) > 0.0001 || Math.abs(a.midpoint - 0.5) > 0.0001) return fail();
  }
}

/** Only new files, only the task's empty target group. Unrelated content is copied by native PS. */
export async function renderNativeFilm(adobe: AdobeConnector, folder: string, input: string, plan: PhotoshopPlan, layerId: string) {
  scopedAdobePath(folder, input, true);
  if (path.extname(input).toLowerCase() !== '.psd') throw opticalPartError('原生薄膜输入须为本job PSD');
  const bytes = fs.readFileSync(input), psd = metadata(bytes), entry = plan.layers.find(l => l.layerId === layerId);
  if (!entry?.nativeFilm || !plan.canvas || psd.width !== plan.canvas.width || psd.height !== plan.canvas.height)
    throw opticalPartError('原生薄膜输入画布须匹配冻结计划');
  const groups = psd.children?.filter(g => g.name === photoshopGroupName(layerId));
  if (groups?.length !== 1 || groups[0].children?.length !== 0)
    throw opticalPartError('原生薄膜只写入本任务空的目标组；已有内容须保留，不能隐式替换');
  const tag = uid(), source = path.join(folder, `film-source-${tag}.psd`), output = path.join(folder, `film-native-${tag}.psd`);
  const working = path.join(folder, `film-work-${tag}.psd`);
  const report = path.join(folder, `film-native-${tag}.json`), script = path.join(folder, `film-native-${tag}.jsx`);
  fs.writeFileSync(source, prepareNativeFilmPsd(plan, layerId), { flag: 'wx' });
  fs.copyFileSync(input, working, fs.constants.COPYFILE_EXCL);
  const q = (v: unknown) => JSON.stringify(v).replace(/\u2028|\u2029/g, ' ');
  fs.writeFileSync(script, `#target photoshop
(function(){var before=app.documents.length, prior=before?app.activeDocument:null, dialogs=app.displayDialogs,d=null,src=null;
try{app.displayDialogs=DialogModes.NO;src=app.open(new File(${q(source)}));d=app.open(new File(${q(working)}));
var target=null;for(var i=0;i<d.layerSets.length;i++)if(d.layerSets[i].name===${q(photoshopGroupName(layerId))}){if(target)throw Error('Duplicate target');target=d.layerSets[i];}
if(!target||target.layers.length)throw Error('Target must be empty');target.blendMode=BlendMode.NORMAL;target.opacity=100;target.visible=true;
app.activeDocument=src;src.layerSets[0].layers[0].duplicate(target,ElementPlacement.PLACEATBEGINNING);app.activeDocument=d;
var save=new PhotoshopSaveOptions();save.layers=true;save.embedColorProfile=true;d.saveAs(new File(${q(output)}),save,true,Extension.LOWERCASE);
d.close(SaveOptions.DONOTSAVECHANGES);d=null;src.close(SaveOptions.DONOTSAVECHANGES);src=null;
var f=new File(${q(report)});f.encoding='UTF8';f.open('w');f.write('{"nativePhotoshopVersion":"'+app.version+'","before":'+before+',"after":'+app.documents.length+'}');f.close();
}finally{if(d)d.close(SaveOptions.DONOTSAVECHANGES);if(src)src.close(SaveOptions.DONOTSAVECHANGES);app.displayDialogs=dialogs;if(prior)try{app.activeDocument=prior;}catch(e){}}})();`, { flag: 'wx' });
  await adobe.executeScript('photoshop', script, folder, [output, report]);
  if (digest(fs.readFileSync(input)) !== digest(bytes)) throw opticalPartError('原生薄膜制作期间输入PSD变化；新输出保留但不提交');
  const actual = metadata(fs.readFileSync(output));
  if (actual.width !== psd.width || actual.height !== psd.height) throw opticalPartError('实际PS薄膜总画布变化');
  verifyNativeFilmGroup(actual.children?.find(g => g.name === photoshopGroupName(layerId)), entry);
  const facts = JSON.parse(fs.readFileSync(report, 'utf8').replace(/^\uFEFF/, ''));
  if (facts.before !== facts.after || !facts.nativePhotoshopVersion) throw opticalPartError('原生薄膜未保持已有PS文档状态');
  return { artifactPath: output, inputPath: input, inputHash: digest(bytes), artifactHash: digest(fs.readFileSync(output)),
    sourcePath: source, sourceHash: digest(fs.readFileSync(source)), reportPath: report, facts,
    planHash: digest(Buffer.from(JSON.stringify(plan))),
    recipeHash: digest(Buffer.from(JSON.stringify(entry.nativeFilm))),
    note: '真实PS已在新副本中制作可编辑路径及透明渐变；尚未inspect实际alpha、原图外观或整图验收，不是image_gen。' };
}
