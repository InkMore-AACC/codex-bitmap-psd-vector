import crypto from 'node:crypto';
import path from 'node:path';
import { generationLayoutSchema } from '../shared/generation.js';
import { photoshopPlanSchema, type PhotoshopPlan } from '../shared/photoshop.js';
import { type OpticalMember, type OpticalPart, validateOpticalParts, opticalPartError } from '../shared/optical-parts.js';
import type { GenerationLayout } from './generation-workflow.js';
import type { Job } from './types.js';
import { dir, json } from './store.js';

export function ordinaryOpticalMembers(j: Job, layout: GenerationLayout): OpticalMember[] {
  return layout.layers.map(l => ({ ids: l.sourceLayerIds, elements: l.elements, part: l.opticalPart, checks: l.alphaChecks, anchors: l.anchors,
    allowed: ['layer', 'revise'].includes(j.type) && j.reconstructionVersion === 3 && j.reconstructionWorkflowVersion === 4 &&
      (l.blendMode || 'normal') === 'normal' && !l.content &&
      (!l.nativeText || l.nativeText.version === 2 && l.opticalPart?.version === 2 && l.opticalPart.kind === 'opaque-structure') &&
      !l.sourceProtection &&
      !l.allowAuxMatte && !l.matteBackdrop && !l.packedBackdrop &&
      l.sourceLayerIds.every(id => j.snapshot.layers.find(s => s.id === id)?.role === 'foreground'),
  }));
}
export function photoshopOpticalMembers(j: Job, plan: PhotoshopPlan): OpticalMember[] {
  return plan.layers.map(l => ({ ids: [l.layerId], elements: l.elements, part: l.opticalPart, checks: l.alphaChecks, anchors: l.anchors,
    allowed: j.type === 'photoshop' && j.reconstructionVersion === 3 && j.reconstructionWorkflowVersion === 4 &&
      l.surface === 'transparent' && ['native', 'generate'].includes(l.route) && !l.sourceProtection &&
      ['bitmap', 'shape', 'text'].includes(l.content) &&
      j.snapshot.layers.find(s => s.id === l.layerId)?.role === 'foreground',
  }));
}
export function opticalPlanHash(j: Job, plan: GenerationLayout | PhotoshopPlan) {
  return crypto.createHash('sha256').update(JSON.stringify({ taskId: j.taskId, jobId: j.id, version: j.version, plan })).digest('hex');
}
type OpticalRequest = { sourceLayerIds: string[]; opticalPart?: OpticalPart; opticalPlanHash?: string };
/** Read the current task's public backend plan, not any private Codex history. */
export function verifyOpticalRequest(j: Job, request: OpticalRequest, layout?: GenerationLayout) {
  const psPlan = j.type === 'photoshop'
    ? json<{ plan?: PhotoshopPlan }>(path.join(dir(j.documentId), 'jobs', j.id, 'photoshop-rebuild.json'), {}).plan : undefined;
  const current = j.type === 'photoshop' ? psPlan : layout;
  const declared = j.type === 'photoshop'
    ? psPlan?.layers.find(l => request.sourceLayerIds.length === 1 && l.layerId === request.sourceLayerIds[0])?.opticalPart
    : layout?.layers.find(l => JSON.stringify(l.sourceLayerIds) === JSON.stringify(request.sourceLayerIds))?.opticalPart;
  if (!declared && !request.opticalPart && !request.opticalPlanHash) return;
  if (!current) throw opticalPartError('光学分件冻结计划丢失');
  const parsed = j.type === 'photoshop' ? photoshopPlanSchema.parse(current) : generationLayoutSchema.parse(current);
  const members = j.type === 'photoshop' ? photoshopOpticalMembers(j, parsed as PhotoshopPlan)
    : ordinaryOpticalMembers(j, parsed as GenerationLayout);
  validateOpticalParts(members, parsed.relations);
  const owner = members.find(m => JSON.stringify(m.ids) === JSON.stringify(request.sourceLayerIds));
  // A part binds the full plan: sibling ownership, exclusions and relations cannot drift.
  if (request.opticalPlanHash !== opticalPlanHash(j, parsed) || JSON.stringify(request.opticalPart) !== JSON.stringify(owner?.part))
    throw opticalPartError('光学分件/元素排除/关系或完整计划与首次prepare冻结记录不符');
}
