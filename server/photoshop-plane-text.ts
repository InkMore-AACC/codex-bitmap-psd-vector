import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readPsd, type Layer as PsdLayer } from 'ag-psd';
import { photoshopGroupName, type PhotoshopPlan } from '../shared/photoshop.js';
import { nativeTextInkQuad, type NativeTextRecipe } from '../shared/native-text.js';
import { GENERATION_PIXEL_BUDGET } from '../shared/generation-geometry.js';
import { opticalPartError } from '../shared/optical-parts.js';
import { validateNativeTextRecipe, measureNativeTextSpan } from './native-text-renderer.js';
import type { AdobeConnector } from './adobe.js';
import { scopedAdobePath } from './adobe.js';
import { uid } from './store.js';

type Entry = PhotoshopPlan['layers'][number];
const digest = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const metadata = (b: Buffer) => readPsd(b, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });

/** Read the actual single SFNT's name ID 6. Never trust a caller-supplied font alias. */
export function fontPostscriptName(bytes: Buffer) {
  const check = (p: number, n: number) => {
    if (p < 0 || n < 0 || p + n > bytes.length) throw opticalPartError('字体name表边界无效');
  };
  check(0, 12);
  if (![0x00010000, 0x4f54544f].includes(bytes.readUInt32BE(0))) throw opticalPartError('仅支持单字体TTF/OTF');
  const n = bytes.readUInt16BE(4); check(12, n * 16);
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    if (bytes.toString('ascii', p, p + 4) !== 'name') continue;
    const start = bytes.readUInt32BE(p + 8), length = bytes.readUInt32BE(p + 12);
    check(start, length); if (length < 6) throw opticalPartError('字体name表截断');
    const t = bytes.subarray(start, start + length), count = t.readUInt16BE(2), storage = t.readUInt16BE(4);
    if (6 + count * 12 > t.length) throw opticalPartError('字体name记录截断');
    const names = new Set<string>();
    for (let k = 0; k < count; k++) {
      const a = 6 + k * 12, platform = t.readUInt16BE(a), id = t.readUInt16BE(a + 6);
      if (id !== 6 || ![0, 1, 3].includes(platform)) continue;
      const len = t.readUInt16BE(a + 8), offset = storage + t.readUInt16BE(a + 10);
      if (offset < storage || offset + len > t.length) throw opticalPartError('字体PostScript名字越界');
      let name = '';
      if (platform === 1) name = t.toString('ascii', offset, offset + len);
      else { if (len % 2) throw opticalPartError('字体PostScript名字编码无效');
        for (let j = offset; j < offset + len; j += 2) name += String.fromCharCode(t.readUInt16BE(j)); }
      if (!/^[\x21-\x7e]+$/.test(name) || /[\[\](){}<>\/%]/.test(name)) throw opticalPartError('字体PostScript名字无效');
      names.add(name);
    }
    if (names.size !== 1) throw opticalPartError('字体PostScript名字缺失或不唯一，不能静默替代');
    return [...names][0];
  }
  throw opticalPartError('字体缺少name表');
}

export function decomposeTextPlane(matrix: number[]) {
  const [a,b,c,d] = matrix, sx = Math.hypot(a,b), theta = Math.atan2(b,a), co = Math.cos(theta), sn = Math.sin(theta);
  const sy = -sn*c + co*d, k = co*c + sn*d;
  if (![sx,sy].every(v => Number.isFinite(v) && v > 0.000001) || a*d-b*c <= 0.000001)
    throw opticalPartError('平面文字变换须可逆且不镜像');
  return { sx, sy, rotation: theta*180/Math.PI, shear: Math.atan(k/sy)*180/Math.PI };
}

export function validateNativeTextPlaneEntry(entry: Entry) {
  if (!entry.nativeTextPlane) return;
  const r = entry.nativeTextPlane.recipe;
  if (r.version !== 2 || entry.route !== 'native' || entry.content !== 'text' || entry.editable !== 'native-text' ||
      entry.surface !== 'transparent' || entry.nativeFallback || entry.nativeFilm || entry.sourceProtection ||
      entry.opticalPart && (entry.opticalPart.version !== 2 || entry.opticalPart.kind !== 'opaque-structure') ||
      entry.textTargets.length !== r.spans.length || new Set(entry.textTargets.map(t=>t.layerName)).size !== r.spans.length)
    throw opticalPartError('原生平面文字须为透明native-text，冻结逐行目标；不能替代薄膜/光效/位图或fallback');
  validateNativeTextRecipe(r, entry.frame);
  const plane = decomposeTextPlane(r.transform);
  for (let i = 0; i < r.spans.length; i++) {
    const span = r.spans[i], target = entry.textTargets[i], a = target.appearance;
    const font = fontPostscriptName(fs.readFileSync(span.fontPath)), rgb = [1,3,5].map(n=>parseInt(span.color.slice(n,n+2),16));
    const points = nativeTextInkQuad(r, span.box), xs = points.map(p=>p[0]), ys = points.map(p=>p[1]);
    const expected = [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],
      actual = [target.box.x,target.box.y,target.box.x+target.box.width,target.box.y+target.box.height];
    const measured = measureNativeTextSpan(span);
    if (target.text !== span.text || a?.font !== font || a?.warpStyle !== 'none' || a.requiredEffects.length ||
        !a.color || a.color.some((v,k)=>v !== rgb[k]) || a.rotation === undefined || Math.abs(a.rotation-plane.rotation)>0.0001 ||
        a.shear !== undefined && Math.abs(a.shear-plane.shear)>0.0001 ||
        a.warpBend !== undefined && a.warpBend !== 0 ||
        actual.some((v,k)=>Math.abs(v-expected[k])>3) || measured.width > span.box.width+.01 || measured.height > span.box.height+.01)
      throw opticalPartError('PS文字目标须与真实字体及冻结平面配方一致；不能拉伸、裁切或临时改变字形');
  }
}

/** Check the PS-saved file, not a generated script/report or a raster cache. */
export function verifyNativeTextPlaneGroup(group: PsdLayer | undefined, entry: Entry) {
  if (!entry.nativeTextPlane) return;
  validateNativeTextPlaneEntry(entry);
  const recipe = entry.nativeTextPlane.recipe as Extract<NativeTextRecipe,{version:2}>;
  const geometry = [];
  const fail = () => { throw opticalPartError(`「${entry.name}」实际原生平面文字与冻结字体/变换/位置不符`); };
  if (!group || group.hidden || (group.opacity ?? 1) !== 1 || group.mask || group.effects ||
      group.blendMode && !['normal','pass through'].includes(group.blendMode) || group.children?.length !== recipe.spans.length) return fail();
  for (let i = 0; i < recipe.spans.length; i++) {
    const s = recipe.spans[i], target = entry.textTargets[i], matches = group.children.filter(l=>l.name===target.layerName);
    if (matches.length !== 1) return fail();
    const l = matches[0], t = l.text, style = t?.style, col = style?.fillColor;
    const rgb = [1,3,5].map(n=>parseInt(s.color.slice(n,n+2),16));
    const styles = [style, ...(t?.styleRuns || []).map(r=>r.style)];
    if (l.hidden || (l.opacity ?? 1) !== 1 || l.children || l.effects || l.mask || l.vectorMask || l.placedLayer || l.clipping ||
        l.blendMode && l.blendMode !== 'normal' || !t || t.text.replace(/\r$/, '') !== s.text ||
        !style || style.font?.name !== target.appearance!.font || style.font?.synthetic ||
        Math.abs((style.fontSize ?? 0)-s.fontSize)>.01 || !col || !('r' in col) || [col.r,col.g,col.b].some((v,k)=>Math.abs(v-rgb[k])>.01) ||
        styles.some(st=>st?.fauxBold || st?.fauxItalic || st?.tracking || st?.baselineShift || st?.underline || st?.strikethrough ||
          st?.horizontalScale !== undefined && st.horizontalScale !== 1 || st?.verticalScale !== undefined && st.verticalScale !== 1 ||
          st?.font?.name !== undefined && st.font.name !== style.font!.name || st?.fontSize !== undefined && Math.abs(st.fontSize-s.fontSize)>.01 ||
          st?.fillColor && (!('r' in st.fillColor) || [st.fillColor.r,st.fillColor.g,st.fillColor.b].some((v,k)=>Math.abs(v-rgb[k])>.01))) ||
        t.warp?.style && t.warp.style !== 'none' || t.warp?.value || !t.transform || t.transform.length !== 6 ||
        t.transform.slice(0,4).some((v,k)=>!Number.isFinite(v) || Math.abs(v-recipe.transform[k])>.0001) ||
        !t.transform.every(Number.isFinite)) return fail();
    const b = [l.left,l.top,l.right,l.bottom];
    if (b.some(v=>v===undefined || !Number.isFinite(v))) return fail();
    const [left,top,right,bottom] = b as number[], measured = measureNativeTextSpan(s);
    const [a,c1,c,d] = recipe.transform;
    // Source observations describe the desired ink, not this real font's intrinsic metrics.
    // Keep the placement gate; compare size to the frozen font/plane, never fit/stretch to source.
    const fontWidth = Math.abs(a)*measured.width+Math.abs(c)*measured.height,
      fontHeight = Math.abs(c1)*measured.width+Math.abs(d)*measured.height;
    if (Math.abs(left-target.box.x)>1.1 || Math.abs(top-target.box.y)>1.1 ||
        Math.abs(right-left-fontWidth)>2 || Math.abs(bottom-top-fontHeight)>2 ||
        left<entry.frame.x || top<entry.frame.y || right>entry.frame.x+entry.frame.width || bottom>entry.frame.y+entry.frame.height) return fail();
    // PS point-text local bounds also tie the baseline translation to the saved visible ink.
    // Their transformed rectangle must contain the ink (glyph extrema need not occupy its corners).
    if (t.boundingBox) {
      const bb=t.boundingBox, local=[bb.left,bb.top,bb.right,bb.bottom];
      if(local.some(v=>v.units!=='Points' || !Number.isFinite(v.value))) return fail();
      const q=nativeTextInkQuad({...recipe,transform:t.transform as typeof recipe.transform},
        {x:bb.left.value,y:bb.top.value,width:bb.right.value-bb.left.value,height:bb.bottom.value-bb.top.value});
      const xs=q.map(p=>p[0]),ys=q.map(p=>p[1]);
      if(left<Math.min(...xs)-2 || top<Math.min(...ys)-2 || right>Math.max(...xs)+2 || bottom>Math.max(...ys)+2 ||
        left>Math.max(...xs) || top>Math.max(...ys) || right<Math.min(...xs) || bottom<Math.min(...ys)) return fail();
    }
    geometry.push({layerName:target.layerName,actualBounds:[left,top,right,bottom],fontPlaneSize:[fontWidth,fontHeight],
      sourceSizeDelta:[right-left-target.box.width,bottom-top-target.box.height],sourceVisualAccepted:false});
  }
  return geometry;
}

/** Only new task-scoped copies, preserving all existing documents and groups. */
export async function renderNativeTextPlane(adobe: AdobeConnector, folder: string, input: string, plan: PhotoshopPlan, layerId: string) {
  scopedAdobePath(folder,input,true);
  const bytes = fs.readFileSync(input), psd = metadata(bytes), entry = plan.layers.find(l=>l.layerId===layerId);
  if (path.extname(input).toLowerCase()!=='.psd' || !entry?.nativeTextPlane || !plan.canvas ||
      psd.width!==plan.canvas.width || psd.height!==plan.canvas.height || psd.width*psd.height>GENERATION_PIXEL_BUDGET)
    throw opticalPartError('原生平面文字须使用本job匹配冻结计划且不超过150万像素的PSD');
  validateNativeTextPlaneEntry(entry);
  const roots = psd.children?.filter(g=>g.name===photoshopGroupName(layerId));
  if (roots?.length!==1 || roots[0].children?.length!==0) throw opticalPartError('原生平面文字只制作空目标组；已有内容保留，不能隐式替换');
  const tag=uid(),working=path.join(folder,`text-plane-work-${tag}.psd`),output=path.join(folder,`text-plane-native-${tag}.psd`),
    report=path.join(folder,`text-plane-native-${tag}.json`),script=path.join(folder,`text-plane-native-${tag}.jsx`),
    progress=path.join(folder,`text-plane-progress-${tag}.json`);
  const recipe=entry.nativeTextPlane.recipe as Extract<NativeTextRecipe,{version:2}>, plane=decomposeTextPlane(recipe.transform);
  const spans=recipe.spans.map((s,i)=>({text:s.text,name:entry.textTargets[i].layerName,font:entry.textTargets[i].appearance!.font,
    size:s.fontSize,color:[1,3,5].map(n=>parseInt(s.color.slice(n,n+2),16)),target:entry.textTargets[i].box}));
  const q=(v:unknown)=>JSON.stringify(v).replace(/\u2028|\u2029/g,' ');
  fs.copyFileSync(input,working,fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(script,`#target photoshop
(function(){var before=app.documents.length,prior=before?app.activeDocument:null,dialogs=app.displayDialogs,d=null;
function phase(stage,index){var f=new File(${q(progress)});f.encoding='UTF8';if(!f.open('w'))throw Error('Cannot write owned execution trace');f.write('{"stage":"'+stage+'","spanIndex":'+index+',"nativePhotoshopVersion":"'+app.version+'"}');f.close();}
try{phase('started',-1);app.displayDialogs=DialogModes.NO;var spans=${q(spans)},plane=${q(plane)};
for(var i=0;i<spans.length;i++){var found=0;for(var k=0;k<app.fonts.length;k++)if(app.fonts[k].postScriptName===spans[i].font)found++;if(found!==1)throw Error('Actual Photoshop font missing or ambiguous; no fallback');}
phase('opening-copy',-1);d=app.open(new File(${q(working)}));phase('copy-opened',-1);if(Math.abs(d.resolution-72)>.0001)throw Error('Planar text requires frozen 72dpi pixel/point scale');
var group=null;for(i=0;i<d.layerSets.length;i++)if(d.layerSets[i].name===${q(photoshopGroupName(layerId))}){if(group)throw Error('Duplicate target');group=d.layerSets[i];}
if(!group||group.layers.length)throw Error('Target must be empty');group.visible=true;group.opacity=100;group.blendMode=BlendMode.NORMAL;
var ci=charIDToTypeID,si=stringIDToTypeID;
for(i=0;i<spans.length;i++){phase('adding-layer',i);var v=spans[i],l=group.artLayers.add();phase('setting-text-kind',i);l.kind=LayerKind.TEXT;phase('setting-text-content',i);l.name=v.name;l.visible=true;l.textItem.contents=v.text;phase('setting-frozen-font',i);l.textItem.font=v.font;l.textItem.size=UnitValue(v.size,'pt');l.textItem.position=[UnitValue(10,'px'),UnitValue(60,'px')];l.textItem.antiAliasMethod=AntiAlias.SHARP;l.textItem.tracking=0;l.textItem.fauxBold=false;l.textItem.fauxItalic=false;
var col=new SolidColor();col.rgb.red=v.color[0];col.rgb.green=v.color[1];col.rgb.blue=v.color[2];l.textItem.color=col;if(l.textItem.font!==v.font)throw Error('Photoshop replaced frozen font');d.activeLayer=l;
phase('transforming-frozen-plane',i);l.resize(plane.sx*100,plane.sy*100,AnchorPosition.TOPLEFT);var skd=new ActionDescriptor(),skr=new ActionReference();skr.putIdentifier(si('layer'),l.id);skd.putReference(ci('null'),skr);var sk=new ActionDescriptor();sk.putUnitDouble(ci('Hrzn'),ci('#Ang'),plane.shear);sk.putUnitDouble(ci('Vrtc'),ci('#Ang'),0);skd.putObject(ci('Skew'),ci('Pnt '),sk);executeAction(ci('Trnf'),skd,DialogModes.NO);l.rotate(plane.rotation,AnchorPosition.TOPLEFT);
var b=l.boundsNoEffects;l.translate(UnitValue(v.target.x-b[0].as('px'),'px'),UnitValue(v.target.y-b[1].as('px'),'px'));}
phase('saving-native-output',-1);var save=new PhotoshopSaveOptions();save.layers=true;save.embedColorProfile=true;d.saveAs(new File(${q(output)}),save,true,Extension.LOWERCASE);d.close(SaveOptions.DONOTSAVECHANGES);d=null;if(prior)app.activeDocument=prior;
var f=new File(${q(report)});f.encoding='UTF8';f.open('w');f.write('{"nativePhotoshopVersion":"'+app.version+'","before":'+before+',"after":'+app.documents.length+'}');f.close();phase('finished',-1);
}finally{if(d)d.close(SaveOptions.DONOTSAVECHANGES);app.displayDialogs=dialogs;if(prior)try{app.activeDocument=prior;}catch(e){}}})();`,{flag:'wx'});
  await adobe.executeScript('photoshop',script,folder,[output,report]);
  if (digest(fs.readFileSync(input))!==digest(bytes)) throw opticalPartError('制作期间输入PSD变化；保留新输出但不提交');
  validateNativeTextPlaneEntry(entry); // Re-read actual font bytes after Adobe, not just the cached typeface.
  const actual=metadata(fs.readFileSync(output)), groups=actual.children?.filter(g=>g.name===photoshopGroupName(layerId));
  if (actual.width!==psd.width || actual.height!==psd.height || groups?.length!==1) throw opticalPartError('实际PS文字画幅/分组变化');
  const geometry=verifyNativeTextPlaneGroup(groups[0],entry);
  const facts=JSON.parse(fs.readFileSync(report,'utf8').replace(/^\uFEFF/,''));
  if(facts.before!==facts.after || !facts.nativePhotoshopVersion) throw opticalPartError('原生文字未保持已有PS文档状态');
  return {artifactPath:output,inputPath:input,inputHash:digest(bytes),artifactHash:digest(fs.readFileSync(output)),reportPath:report,executionTracePath:progress,facts,geometry,
    planHash:digest(Buffer.from(JSON.stringify(plan))),recipeHash:digest(Buffer.from(JSON.stringify(entry.nativeTextPlane))),
    note:'真实PS新副本原生文字与冻结字体/字号/颜色/平面已回读；还需实际alpha、源字形外观及整图独立验收，非image_gen。'};
}
