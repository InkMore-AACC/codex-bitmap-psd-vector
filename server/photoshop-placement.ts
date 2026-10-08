import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { photoshopGroupName, photoshopMaterialTarget } from '../shared/photoshop.js';
import { fitGeometry } from '../shared/generation-geometry.js';
import sharp from 'sharp';
import type { AdobeConnector } from './adobe.js';
import { taskPsd } from './photoshop-native.js';
import { uid } from './store.js';

type StackLayer = {
  id: number;
  name: string;
  move(target: unknown, placement: unknown): void;
  remove(): void;
};
/** Kept ES3-compatible because this same function executes inside Photoshop. */
export function replaceMaterialInGroup(
  layer: StackLayer,
  group: { layers: StackLayer[] },
  placement: { PLACEBEFORE: unknown; INSIDE: unknown },
) {
  var previous: StackLayer | null = null;
  var i = 0;
  for (i = 0; i < group.layers.length; i++)
    if (group.layers[i].name === 'LC_MATERIAL' && group.layers[i].id !== layer.id) {
      previous = group.layers[i];
      break;
    }
  if (previous) layer.move(previous, placement.PLACEBEFORE);
  else layer.move(group, placement.INSIDE);
  for (i = group.layers.length - 1; i >= 0; i--)
    if (group.layers[i].name === 'LC_MATERIAL' && group.layers[i].id !== layer.id)
      group.layers[i].remove();
}

/** Screen inside a Normal group blends against that group's transparent base,
 * leaving its black carrier opaque to the scene. Pass Through lets the genuine
 * Screen material blend with lower scene groups. Only its own logical group changes.
 * This exact ES3 function also executes inside Photoshop. */
export function configureScreenMaterialGroup(
  layer: { blendMode: unknown },
  group: { blendMode: unknown },
  modes: { SCREEN: unknown; PASSTHROUGH: unknown },
) {
  if (modes.SCREEN === undefined || modes.PASSTHROUGH === undefined)
    throw new Error('Photoshop Screen/Pass Through modes are unavailable');
  layer.blendMode = modes.SCREEN;
  group.blendMode = modes.PASSTHROUGH;
  if (layer.blendMode !== modes.SCREEN || group.blendMode !== modes.PASSTHROUGH)
    throw new Error('Screen material requires a Pass Through logical group');
}

/** Place the entire file as a smart object. Its quad includes transparent margins.
 * Never use layer.bounds, paste centering, alpha bounds, or guessed subject bounds. */
export async function placeNativeMaterial(
  adobe: AdobeConnector,
  folder: string,
  artifactPath: string,
  layerId: string,
  materialPath: string,
  frame: { x: number; y: number; width: number; height: number },
  screen = false,
  opaqueFullBackground = false,
  sourceProtected = false,
) {
  const source = taskPsd(folder, artifactPath),
    tag = uid();
  // ExtendScript can report a real Windows file as missing at MAX_PATH.
  // Keep all native paths inside this job, with compact independent leaf names.
  const copy = path.join(folder, `pi-${tag}.psd`),
    output = path.join(folder, `p-${tag}.psd`);
  const report = path.join(folder, `p-${tag}.json`),
    script = path.join(folder, `p-${tag}.jsx`);
  const materialBytes = fs.readFileSync(materialPath);
  const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
  const materialHash = digest(materialBytes);
  const nativeMaterial = materialPath.length >= 260 ? path.join(folder, `m-${tag}.png`) : materialPath;
  if ([copy, output, report, script, nativeMaterial].some(p => p.length >= 260))
    throw new Error('Photoshop文件路径仍超过可读取范围；已保留原件，请使用较短的项目/任务目录，未执行置入');
  if (nativeMaterial !== materialPath) fs.writeFileSync(nativeMaterial, materialBytes, { flag: 'wx' });
  fs.copyFileSync(source, copy);
  const meta = await sharp(materialBytes).metadata();
  const fit = fitGeometry({ width: meta.width!, height: meta.height! }, frame);
  const target = photoshopMaterialTarget(
    { width: meta.width!, height: meta.height! },
    frame,
    opaqueFullBackground,
    sourceProtected,
  );
  const q = (v: unknown) => JSON.stringify(v).replace(/\u2028|\u2029/g, ' ');
  fs.writeFileSync(
    script,
    `#target photoshop
(function(){var prior=app.documents.length?app.activeDocument:null,dialogs=app.displayDialogs,d=null;
try{app.displayDialogs=DialogModes.NO;d=app.open(new File(${q(copy)}));var s=stringIDToTypeID,c=charIDToTypeID,group=null,i;
for(i=0;i<d.layers.length;i++)if(d.layers[i].name===${q(photoshopGroupName(layerId))})group=d.layers[i];
if(!group||group.typename!=='LayerSet')throw Error('Missing logical group');
var a=new ActionDescriptor();a.putPath(c('null'),new File(${q(nativeMaterial)}));a.putEnumerated(c('FTcs'),c('QCSt'),c('Qcsa'));executeAction(c('Plc '),a,DialogModes.NO);
var l=d.activeLayer;l.name='LC_MATERIAL';
function quad(){var r=new ActionReference();r.putProperty(s('property'),s('smartObjectMore'));r.putIdentifier(s('layer'),l.id);var o=executeActionGet(r).getObjectValue(s('smartObjectMore'));var t=o.getList(s('transform')),v=[];for(var k=0;k<8;k++)v.push(t.getDouble(k));return v;}
var f=${q(target)},v=quad(),w=Math.sqrt(Math.pow(v[2]-v[0],2)+Math.pow(v[3]-v[1],2));if(w<=0)throw Error('Invalid file quad');
var scale=f.width/w*100;l.resize(scale,scale,AnchorPosition.MIDDLECENTER);v=quad();l.translate(UnitValue(f.x-v[0],'px'),UnitValue(f.y-v[1],'px'));v=quad();
var expected=[f.x,f.y,f.x+f.width,f.y,f.x+f.width,f.y+f.height,f.x,f.y+f.height],tolerance=${sourceProtected ? '0.0001' : '1.1'};
for(i=0;i<8;i++)if(!isFinite(v[i])||Math.abs(v[i]-expected[i])>tolerance)throw Error('Full-file quad placement mismatch');
(${replaceMaterialInGroup.toString()})(l,group,ElementPlacement);
${screen ? `(${configureScreenMaterialGroup.toString()})(l,group,BlendMode);` : ''}
var opt=new PhotoshopSaveOptions();opt.layers=true;opt.embedColorProfile=true;d.saveAs(new File(${q(output)}),opt,true,Extension.LOWERCASE);
var file=new File(${q(report)});file.encoding='UTF8';file.open('w');file.write('{"transform":['+v.join(',')+']}');file.close();
}finally{if(d)d.close(SaveOptions.DONOTSAVECHANGES);app.displayDialogs=dialogs;if(prior)try{app.activeDocument=prior;}catch(e){}}})();`,
    'utf8',
  );
  await adobe.executeScript('photoshop', script, folder, [output, report]);
  if (digest(fs.readFileSync(materialPath)) !== materialHash || digest(fs.readFileSync(nativeMaterial)) !== materialHash)
    throw new Error('PS置入期间原素材或短路径副本发生变化；新文件保留，不能声明置入已验证');
  return {
    artifactPath: output,
    placement: fit,
    target,
    metrics: JSON.parse(fs.readFileSync(report, 'utf8').replace(/^\uFEFF/, '')),
    materialSource: { path: materialPath, hash: materialHash,
      ...(nativeMaterial !== materialPath ? { stagedPath: nativeMaterial, stagedHash: materialHash } : {}) },
    note: '完整文件画幅以智能对象装入，透明边保留；已回读变换坐标。仍需inspect检查物体外观和整图叠加。',
  };
}
