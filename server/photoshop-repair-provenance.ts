import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { readPsd } from 'ag-psd';
import { scopedAdobePath } from './adobe.js';
import type { PhotoshopExtractionBinding } from './photoshop-extraction-provenance.js';
import {
  axisAlignedRepairFrame,
  replaceLocalMaterialRgba,
  type RepairFrame,
} from './photoshop-material-repair.js';

const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = (file: string) => digest(fs.readFileSync(file));
function snapshot(file: string) {
  const bytes = fs.readFileSync(file);
  return { path: file, bytes, hash: digest(bytes) };
}
export const photoshopRepairError = (message: string) =>
  Object.assign(new Error(message), { status: 400 });
export type RepairGenerationBinding = {
  id: string;
  originalPath: string;
  originalHash: string;
  workingPath: string;
  workingHash: string;
  placementFrame: RepairFrame;
};
type RepairFile = { path: string; hash: string };
export type PhotoshopRepairRecord = {
  version: 1;
  planHash: string;
  base: RepairFile & {
    source: RepairFile;
    frame: RepairFrame;
    materialFrame: RepairFrame;
    generation?: RepairGenerationBinding;
    sourceKind?: 'generated' | 'extracted';
    extraction?: PhotoshopExtractionBinding;
    prior?: PhotoshopRepairRecord;
  };
  patch: RepairFile & {
    original: RepairFile;
    frame: RepairFrame;
    generation: RepairGenerationBinding;
  };
  mask: RepairFile & { source: RepairFile; width: number; height: number };
  artifact: RepairFile;
  output: RepairFile & { width: number; height: number };
  stats: ReturnType<typeof replaceLocalMaterialRgba>['stats'];
};

function assertFile(file: RepairFile) {
  if (!fs.existsSync(file.path) || hash(file.path) !== file.hash)
    throw new Error('局部修复来源或派生文件已变化，请重新material、place-material和inspect');
}

export function verifyPhotoshopRepair(
  record: PhotoshopRepairRecord,
  planHash: string,
  generation: (id: string) => RepairGenerationBinding,
  depth = 0,
  extraction?: (binding: PhotoshopExtractionBinding) => void,
) {
  if (depth > 8 || record.version !== 1 || record.planHash !== planHash)
    throw new Error('局部修复计划或来源链已改变，请重新material');
  if (
    record.base.hash !== record.base.source.hash ||
    record.mask.hash !== record.mask.source.hash ||
    record.patch.hash !== record.patch.generation.workingHash ||
    record.patch.original.path !== record.patch.generation.originalPath ||
    record.patch.original.hash !== record.patch.generation.originalHash
  )
    throw new Error('局部修复副本与实际使用来源的字节快照不一致，请重新material');
  for (const f of [
    record.base,
    record.base.source,
    record.patch,
    record.patch.original,
    record.mask,
    record.mask.source,
    record.artifact,
    record.output,
  ])
    assertFile(f);
  for (const binding of [record.base.generation, record.patch.generation])
    if (binding) {
      const current = generation(binding.id);
      if (
        current.originalPath !== binding.originalPath ||
        current.originalHash !== binding.originalHash ||
        current.workingPath !== binding.workingPath ||
        current.workingHash !== binding.workingHash ||
        JSON.stringify(current.placementFrame) !== JSON.stringify(binding.placementFrame)
      )
        throw new Error('局部修复来源定位或工作图已改变，请重新material、place-material和inspect');
    }
  if (record.base.sourceKind === 'extracted') {
    if (
      !record.base.extraction ||
      record.base.generation ||
      record.base.prior ||
      !extraction ||
      record.base.source.path !== record.base.extraction.working.path ||
      record.base.source.hash !== record.base.extraction.working.hash ||
      JSON.stringify(record.base.materialFrame) !==
        JSON.stringify(record.base.extraction.placementFrame)
    )
      throw new Error('局部修复提取来源或完整carrier绑定不一致，请重新material');
    extraction(record.base.extraction);
  } else if (
    record.base.extraction ||
    !record.base.generation ||
    (record.base.sourceKind && record.base.sourceKind !== 'generated')
  )
    throw new Error('局部修复来源kind与绑定不一致，请重新material');
  if (record.base.prior)
    verifyPhotoshopRepair(record.base.prior, planHash, generation, depth + 1, extraction);
}

/** Derive a new full carrier from verified task-owned files. No original is
 * overwritten and the result is explicitly a derivation, not an image_gen output. */
export async function derivePhotoshopRepair(input: {
  folder: string;
  outputFolder: string;
  layerId: string;
  planHash: string;
  baseWorkingPath: string;
  expectedBaseWorkingHash: string;
  baseArtifactPath: string;
  expectedBaseFrame: RepairFrame;
  baseMaterialFrame: RepairFrame;
  baseGeneration?: RepairGenerationBinding;
  baseExtraction?: PhotoshopExtractionBinding;
  baseRepair?: PhotoshopRepairRecord;
  patchWorkingPath: string;
  patchOriginal: RepairFile;
  patchGeneration: RepairGenerationBinding;
  patchFrame: RepairFrame;
  maskPath: string;
}) {
  const artifact = scopedAdobePath(input.folder, input.baseArtifactPath, true);
  const sourceMask = scopedAdobePath(input.folder, input.maskPath, true);
  // Read each computational input once and bind the actual bytes immediately.
  // Later path hashes must not endorse a calculation made from older bytes.
  const artifactSnapshot = snapshot(artifact),
    baseSnapshot = snapshot(input.baseWorkingPath),
    patchSnapshot = snapshot(input.patchWorkingPath),
    maskSnapshot = snapshot(sourceMask);
  if (baseSnapshot.hash !== input.expectedBaseWorkingHash)
    throw new Error('expectedBaseWorkingHash与当前ready基底不符');
  if (patchSnapshot.hash !== input.patchGeneration.workingHash)
    throw new Error('局部修复补丁工作快照与登记来源不符');
  const parsed = readPsd(artifactSnapshot.bytes, {
    useImageData: true,
    skipLayerImageData: true,
    skipCompositeImageData: true,
    skipThumbnail: true,
  });
  const group = parsed.children?.find((l) => l.name === 'LC_' + input.layerId);
  const leaves = (l: NonNullable<typeof group>): NonNullable<typeof group>[] =>
    l.hidden ? [] : l.children ? l.children.flatMap(leaves) : [l];
  const matches = group
    ? leaves({ ...group, hidden: false }).filter((l) => l.name === 'LC_MATERIAL')
    : [];
  const material = matches[0];
  if (
    matches.length !== 1 ||
    !material.placedLayer ||
    material.mask ||
    material.vectorMask ||
    material.effects ||
    (material.blendMode && material.blendMode !== 'normal') ||
    (material.fillOpacity ?? 1) !== 1 ||
    (material.opacity ?? 1) !== 1
  )
    throw new Error(
      '局部修复基底须为唯一普通LC_MATERIAL且无额外蒙版、透明度或自带效果；不能替换时删未知效果',
    );
  const embedded = parsed.linkedFiles?.find((f) => f.id === material.placedLayer!.id)?.data;
  if (!embedded || crypto.createHash('sha256').update(embedded).digest('hex') !== baseSnapshot.hash)
    throw new Error('PS基底与当前ready工作素材不符，请先place-material原工作版');
  const actualFrame = axisAlignedRepairFrame(
    material.placedLayer.nonAffineTransform || material.placedLayer.transform,
  );
  if (
    Object.keys(actualFrame).some(
      (k) =>
        Math.abs(
          actualFrame[k as keyof RepairFrame] - input.expectedBaseFrame[k as keyof RepairFrame],
        ) > 0.000001,
    )
  )
    throw new Error('PS基底完整carrier位置已改变，请先恢复登记位置');
  const baseMeta = await sharp(baseSnapshot.bytes).metadata();
  const patchMeta = await sharp(patchSnapshot.bytes).metadata();
  const maskMeta = await sharp(maskSnapshot.bytes).metadata();
  if (baseMeta.icc || patchMeta.icc)
    throw new Error('局部修复暂不处理带ICC的素材；不能为修复局部静默改全层色彩');
  if (maskMeta.width !== baseMeta.width || maskMeta.height !== baseMeta.height)
    throw new Error('replacement mask必须匹配完整基底工作carrier，不能按alpha框或浏览器坐标缩放');
  const rgba = async (bytes: Buffer) => {
    const r = await sharp(bytes)
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: r.info.width, height: r.info.height, data: r.data };
  };
  const base = await rgba(baseSnapshot.bytes),
    patch = await rgba(patchSnapshot.bytes);
  const maskRgba = await sharp(maskSnapshot.bytes)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer();
  const mask = new Uint8Array(base.width * base.height);
  for (let i = 0; i < mask.length; i++)
    mask[i] = Math.round(
      ((maskRgba[i * 4] * 0.2126 + maskRgba[i * 4 + 1] * 0.7152 + maskRgba[i * 4 + 2] * 0.0722) *
        maskRgba[i * 4 + 3]) /
        255,
    );
  if (!mask.some((v) => v > 0)) throw new Error('replacement mask没有明确修复区域');
  const repair = replaceLocalMaterialRgba({
    base,
    patch,
    baseFrame: actualFrame,
    patchFrame: input.patchFrame,
    mask,
  });
  const baseCopy = path.join(input.outputFolder, 'repair-base.png');
  const maskCopy = path.join(input.outputFolder, 'repair-mask.png');
  const output = path.join(input.outputFolder, 'repaired-working.png');
  for (const p of [baseCopy, maskCopy, output])
    if (fs.existsSync(p)) throw new Error('局部修复派生文件已存在，不能覆盖');
  fs.writeFileSync(baseCopy, baseSnapshot.bytes);
  fs.writeFileSync(maskCopy, maskSnapshot.bytes);
  const outputBytes = await sharp(Buffer.from(repair.image.data), {
    raw: { width: base.width, height: base.height, channels: 4 },
  })
    .png()
    .toBuffer();
  fs.writeFileSync(output, outputBytes);
  const record: PhotoshopRepairRecord = {
    version: 1,
    planHash: input.planHash,
    base: {
      path: baseCopy,
      hash: baseSnapshot.hash,
      source: { path: input.baseWorkingPath, hash: baseSnapshot.hash },
      frame: actualFrame,
      materialFrame: input.baseMaterialFrame,
      generation: input.baseGeneration,
      sourceKind: input.baseExtraction ? 'extracted' : 'generated',
      extraction: input.baseExtraction,
      prior: input.baseRepair,
    },
    patch: {
      path: input.patchWorkingPath,
      hash: patchSnapshot.hash,
      original: input.patchOriginal,
      frame: input.patchFrame,
      generation: input.patchGeneration,
    },
    mask: {
      path: maskCopy,
      hash: maskSnapshot.hash,
      source: { path: sourceMask, hash: maskSnapshot.hash },
      width: base.width,
      height: base.height,
    },
    artifact: { path: artifact, hash: artifactSnapshot.hash },
    output: { path: output, hash: digest(outputBytes), width: base.width, height: base.height },
    stats: repair.stats,
  };
  fs.writeFileSync(
    path.join(input.outputFolder, 'repair-provenance.json'),
    JSON.stringify(record, null, 2),
  );
  for (const source of [artifactSnapshot, baseSnapshot, patchSnapshot, maskSnapshot]) {
    if (!fs.existsSync(source.path) || hash(source.path) !== source.hash)
      throw new Error('局部修复来源快照已在推导期间变化；派生文件已保留，请重新material');
  }
  return record;
}
