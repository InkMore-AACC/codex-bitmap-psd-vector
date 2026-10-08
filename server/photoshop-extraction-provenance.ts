import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Job } from './types.js';
import {
  photoshopSettingsSchema,
  type PhotoshopPlan,
  type PhotoshopEvidence,
} from '../shared/photoshop.js';
import type { RepairFrame } from './photoshop-material-repair.js';
import { assetPath } from './store.js';
import { originalReference } from './references.js';
import { scopedAdobePath } from './adobe.js';

type FileBinding = { path: string; hash: string };
export type PhotoshopExtractionBinding = {
  kind: 'extracted';
  taskId: string;
  jobId: string;
  documentId: string;
  layerId: string;
  planHash: string;
  original: FileBinding;
  materialOriginal: FileBinding;
  working: FileBinding & { width: number; height: number };
  source: FileBinding;
  auxiliaryOriginal: FileBinding;
  placementFrame: RepairFrame;
  evidence: NonNullable<PhotoshopEvidence['extraction']>;
};
const hash = (file: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const extractionPlanHash = (entry: PhotoshopPlan['layers'][number]) =>
  crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
export function extractionSources(j: Job) {
  return {
    source: assetPath(
      j.documentId,
      j.snapshot.status === 'preview' ? j.snapshot.source : j.snapshot.url || j.snapshot.source,
    ),
    auxiliaryOriginal: originalReference(j.documentId, j.snapshot).path,
  };
}

/** These are auditable extraction receipts, not host-signed Photoshop history. */
export function verifyPhotoshopExtraction(
  j: Job,
  entry: PhotoshopPlan['layers'][number],
  binding: PhotoshopExtractionBinding,
  folder: string,
) {
  const sources = extractionSources(j);
  if (
    !photoshopSettingsSchema.parse(j.photoshop || {}).allowExtraction ||
    j.reconstructionVersion !== 3 ||
    j.reconstructionWorkflowVersion !== 4 ||
    entry.route !== 'hybrid' ||
    entry.surface !== 'transparent' ||
    binding.kind !== 'extracted' ||
    !j.taskId ||
    binding.taskId !== j.taskId ||
    binding.jobId !== j.id ||
    binding.documentId !== j.documentId ||
    binding.layerId !== entry.layerId ||
    binding.planHash !== extractionPlanHash(entry) ||
    path.resolve(binding.source.path) !== path.resolve(sources.source) ||
    path.resolve(binding.auxiliaryOriginal.path) !== path.resolve(sources.auxiliaryOriginal) ||
    path.resolve(binding.evidence.sourcePath || '') !== path.resolve(sources.source) ||
    !binding.evidence.method ||
    !binding.evidence.occlusion ||
    binding.working.width * binding.working.height > 1_500_000 ||
    binding.working.width < 1 ||
    binding.working.height < 1
  )
    throw new Error('hybrid提取来源、计划或完整carrier预算已改变，请重新material');
  for (const file of [binding.original, binding.materialOriginal, binding.working])
    scopedAdobePath(folder, file.path, true);
  for (const file of [
    binding.original,
    binding.materialOriginal,
    binding.working,
    binding.source,
    binding.auxiliaryOriginal,
  ])
    if (!fs.existsSync(file.path) || hash(file.path) !== file.hash)
      throw new Error(
        'hybrid提取原件、工作图或干净来源已改变，请重新material、place-material和inspect',
      );
  if (
    !Object.values(binding.placementFrame).every(Number.isFinite) ||
    binding.placementFrame.width <= 0 ||
    binding.placementFrame.height <= 0
  )
    throw new Error('hybrid提取完整carrier定位无效，请重新material');
}
