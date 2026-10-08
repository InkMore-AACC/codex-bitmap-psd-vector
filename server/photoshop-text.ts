import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { photoshopActionSchema, photoshopGroupName } from '../shared/photoshop.js';
import type { AdobeConnector } from './adobe.js';
import { uid } from './store.js';
import { taskPsd } from './photoshop-native.js';

/** Uses Photoshop's measured glyph bounds, never an estimated baseline or frame centre. */
export async function fitNativeText(
  adobe: AdobeConnector,
  folder: string,
  input: Extract<z.infer<typeof photoshopActionSchema>, { action: 'fit-text' }>,
) {
  const original = taskPsd(folder, input.artifactPath);
  const tag = uid(),
    output = path.join(folder, `text-fit-${tag}.psd`);
  const copy = path.join(folder, `text-input-${tag}.psd`);
  const report = path.join(folder, `text-fit-${tag}.json`),
    script = path.join(folder, `text-fit-${tag}.jsx`);
  fs.copyFileSync(original, copy);
  const q = (v: unknown) => JSON.stringify(v).replace(/\u2028|\u2029/g, ' ');
  const warpNames = {
    none: 'NONE',
    arc: 'ARC',
    arcLower: 'ARCLOWER',
    arcUpper: 'ARCUPPER',
    arch: 'ARCH',
    bulge: 'BULGE',
    flag: 'FLAG',
    wave: 'WAVE',
    rise: 'RISE',
    fisheye: 'FISHEYE',
    inflate: 'INFLATE',
    squeeze: 'SQUEEZE',
    twist: 'TWIST',
  };
  fs.writeFileSync(
    script,
    `#target photoshop
(function(){var prior=app.documents.length?app.activeDocument:null,dialogs=app.displayDialogs,d=null;
try{app.displayDialogs=DialogModes.NO;d=app.open(new File(${q(copy)}));
var v=${q(input)},group=null,matches=[],i;
for(i=0;i<d.layers.length;i++)if(d.layers[i].name===${q(photoshopGroupName(input.layerId))})group=d.layers[i];
if(!group)throw Error('Missing logical group');
function search(l,off){off=off||!l.visible;if(l.typename==='LayerSet'){for(var k=0;k<l.layers.length;k++)search(l.layers[k],off);}else if(!off&&l.name===v.layerName&&l.kind===LayerKind.TEXT)matches.push(l);}
for(i=0;i<group.layers.length;i++)search(group.layers[i],false);
if(matches.length!==1)throw Error('Expected exactly one visible text layer');
var l=matches[0],t=l.textItem;d.activeLayer=l;
if(v.font)t.font=v.font;if(v.fontSize)t.size=UnitValue(v.fontSize,'pt');if(v.tracking!==undefined)t.tracking=v.tracking;
if(v.color){var col=new SolidColor();col.rgb.red=v.color[0];col.rgb.green=v.color[1];col.rgb.blue=v.color[2];t.color=col;}
var wn=${q(warpNames)},savedWarp={style:t.warpStyle,bend:t.warpBend,horizontal:t.warpHorizontalDistortion,vertical:t.warpVerticalDistortion};
function applyWarp(){t=l.textItem;t.warpStyle=v.warp?WarpStyle[wn[v.warp.style]]:savedWarp.style;t.warpBend=v.warp?v.warp.bend:savedWarp.bend;t.warpHorizontalDistortion=v.warp?v.warp.horizontal:savedWarp.horizontal;t.warpVerticalDistortion=v.warp?v.warp.vertical:savedWarp.vertical;}
var s=stringIDToTypeID,c=charIDToTypeID;
if(v.rotation!==undefined){var ref=new ActionReference();ref.putIdentifier(s('layer'),l.id);var ld=executeActionGet(ref),angle=0;
if(ld.hasKey(s('textKey'))){var tk=ld.getObjectValue(s('textKey'));if(tk.hasKey(s('transform'))){var tr=tk.getObjectValue(s('transform'));angle=Math.atan2(tr.getDouble(s('xy')),tr.getDouble(s('xx')))*180/Math.PI;}}
l.rotate(v.rotation-angle,AnchorPosition.MIDDLECENTER);}
if(v.shear){var trd=new ActionDescriptor(),trr=new ActionReference();trr.putIdentifier(s('layer'),l.id);trd.putReference(c('null'),trr);var sk=new ActionDescriptor();sk.putUnitDouble(c('Hrzn'),c('#Ang'),v.shear);sk.putUnitDouble(c('Vrtc'),c('#Ang'),0);trd.putObject(c('Skew'),c('Pnt '),sk);executeAction(c('Trnf'),trd,DialogModes.NO);}
if(v.styles){var er=new ActionReference();er.putIdentifier(s('layer'),l.id);var ed=executeActionGet(er),fx=ed.hasKey(s('layerEffects'))?ed.getObjectValue(s('layerEffects')):new ActionDescriptor();
function color(rgb){var cd=new ActionDescriptor();cd.putDouble(c('Rd  '),rgb[0]);cd.putDouble(c('Grn '),rgb[1]);cd.putDouble(c('Bl  '),rgb[2]);return cd;}
if(v.styles.stroke){var st=v.styles.stroke,sd=new ActionDescriptor();sd.putBoolean(c('enab'),true);sd.putEnumerated(c('Styl'),c('FStl'),c('OutF'));sd.putEnumerated(c('PntT'),c('FrFl'),c('SClr'));sd.putEnumerated(c('Md  '),c('BlnM'),c('Nrml'));sd.putUnitDouble(c('Opct'),c('#Prc'),100);sd.putUnitDouble(c('Sz  '),c('#Pxl'),st.size);sd.putObject(c('Clr '),c('RGBC'),color(st.color));fx.putObject(c('FrFX'),c('FrFX'),sd);}
if(v.styles.shadow){var sh=v.styles.shadow,dd=new ActionDescriptor();dd.putBoolean(c('enab'),true);dd.putEnumerated(c('Md  '),c('BlnM'),c('Mltp'));dd.putObject(c('Clr '),c('RGBC'),color(sh.color));dd.putUnitDouble(c('Opct'),c('#Prc'),sh.opacity);dd.putBoolean(c('uglg'),false);dd.putUnitDouble(c('lagl'),c('#Ang'),sh.angle);dd.putUnitDouble(c('Dstn'),c('#Pxl'),sh.distance);dd.putUnitDouble(c('Ckmt'),c('#Pxl'),0);dd.putUnitDouble(c('blur'),c('#Pxl'),sh.size);fx.putObject(c('DrSh'),c('DrSh'),dd);}
var set=new ActionDescriptor(),fr=new ActionReference();fr.putProperty(c('Prpr'),c('Lefx'));fr.putIdentifier(c('Lyr '),l.id);set.putReference(c('null'),fr);set.putObject(c('T   '),c('Lefx'),fx);executeAction(c('setd'),set,DialogModes.NO);}
function bounds(){var b;try{b=l.boundsNoEffects;}catch(e){b=l.bounds;}return [b[0].as('px'),b[1].as('px'),b[2].as('px'),b[3].as('px')];}
var f=v.targetBox,b;
applyWarp();
b=bounds();var w=b[2]-b[0],h=b[3]-b[1];if(w<=0||h<=0)throw Error('Empty text glyph bounds');
if(v.fit==='uniform'){var ratio=Math.min(f.width/w,f.height/h);l.resize(ratio*100,ratio*100,AnchorPosition.TOPLEFT);applyWarp();}
b=bounds();l.translate(UnitValue(f.x-b[0],'px'),UnitValue(f.y-b[1],'px'));
b=bounds();var save=new PhotoshopSaveOptions();save.layers=true;save.embedColorProfile=true;d.saveAs(new File(${q(output)}),save,true,Extension.LOWERCASE);
var out=new File(${q(report)});out.encoding='UTF8';out.open('w');out.write('{"bounds":['+b.join(',')+'],"width":'+(b[2]-b[0])+',"height":'+(b[3]-b[1])+'}');out.close();
}finally{if(d)d.close(SaveOptions.DONOTSAVECHANGES);app.displayDialogs=dialogs;if(prior)try{app.activeDocument=prior;}catch(e){}}})();`,
    'utf8',
  );
  await adobe.executeScript('photoshop', script, folder, [output, report]);
  return {
    artifactPath: output,
    metrics: JSON.parse(fs.readFileSync(report, 'utf8').replace(/^\uFEFF/, '')),
    note: '默认按PS实际字形等比拟合，不强拉宽高。rotation为目标角度，shear为本次追加斜切；未给rotation保留现有角度。支持文字变形及原生描边/投影，保留其他效果。尺寸符合不代表字体形状正确，仍须inspect对照原图。',
  };
}
