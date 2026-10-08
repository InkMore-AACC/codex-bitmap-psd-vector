import { RECONSTRUCTION_POLICY } from '../shared/reconstruction-policy.js';
import { PHOTOSHOP_REFERENCE_POLICY } from '../shared/photoshop-policy.js';
import { photoshopSettingsSchema } from '../shared/photoshop.js';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CUTOUT, modelForMode } from '../shared/cutout.js';
import type { Job } from './types.js';
import { assetPath, atomic, getJob } from './store.js';
import { worker } from './models.js';

export function cutoutPacket(j: Job) {
  const packet = {
    model: j.mode === 3 ? 'codex' : modelForMode(j.mode),
    options: j.cutoutOptions || DEFAULT_CUTOUT,
    referencePolicy: RECONSTRUCTION_POLICY,
    policy:
      '所有方案的真实分层采用同一流程：只使用干净原图、当前干净输入和语义/坐标标注，由当前对话 image_gen 重建各层并补全遮挡。粗抠、精抠及生成预览仅供用户看清分层，不作为生图图像输入、像素来源或蒙版；真实分层不再调用本地抠图。不能从原图再次按颜色抠取像素或把原图像素拼回生成结果冒充重建。revise 仅保留已经确认正确的正式图层。',
  };
  if (j.type !== 'photoshop') return packet;
  const allowExtraction = photoshopSettingsSchema.parse(j.photoshop || {}).allowExtraction;
  const hybrid = j.reconstructionVersion === 3 && j.reconstructionWorkflowVersion === 4;
  const extractionPolicy = !allowExtraction
    ? '本任务allowExtraction=false，禁止提交extracted提取素材；不能通过hybrid或伪造generationId绕过设置。'
    : '本任务allowExtraction=true，真实物体提取仍须由当前冻结PS plan明确选择extract路线；不能用矩形原图裁片充数。' +
      (hybrid
        ? '新流程v4仅额外允许transparent hybrid层以当前干净输入的真实提取作为完整基底，再用本任务真实registered generated补片repair；原件、预算工作图、完整carrier定位、来源及计划绑定必须核验，提取不填写generationId。'
        : '旧流程hybrid仍须generated，不增加提取基底例外。');
  return {
    ...packet,
    referencePolicy: PHOTOSHOP_REFERENCE_POLICY + '\n' + extractionPolicy,
    policy: 'PS包中的cutout仅说明预分层规划与显示，不提供正式像素或蒙版。粗抠、精抠及生成预览不得作为生图输入、最终素材或蒙版，不能复用预抠像素；提取只按photoshop.settings和冻结plan执行。' +
      extractionPolicy + '生成部分仍须当前对话image_gen及真实prepare/register；只处理冻结taskId/jobId/imageId，当前节点与已确认修改优先，辅助原图只读。',
  };
}

export async function runLocalCutouts(
  j: Job,
  boxes: unknown[],
  out: string,
  runner: typeof worker = worker,
) {
  const model = modelForMode(j.mode);
  const options = (j.cutoutOptions || DEFAULT_CUTOUT)[model];
  fs.mkdirSync(out, { recursive: true });
  const boxesPath = path.join(out, 'boxes.json'),
    optionsPath = path.join(out, 'cutout-options.json');
  atomic(boxesPath, boxes);
  atomic(optionsPath, options);
  const result = await runner([
    'segment',
    '--input',
    assetPath(j.documentId, j.snapshot.source),
    '--output',
    out,
    '--boxes',
    boxesPath,
    '--model',
    model,
    '--options',
    optionsPath,
  ]);
  const fresh = getJob(j.id);
  if (fresh.status !== 'running')
    throw Object.assign(new Error('任务已结束，未应用抠图结果'), { status: 409 });
  if (!Array.isArray(result.layers) || result.layers.length !== boxes.length)
    throw new Error('抠图返回图层数量不符');
  return result;
}
/** Kept only to explain obsolete callers; reconstruction never reruns a cutout model. */
export async function prepareCutouts(
  _j: Job,
  _input: unknown,
  _runner: typeof worker = worker,
): Promise<never> {
  throw Object.assign(
    new Error(
      '真实分层已统一为原图与标注驱动的生成重建，不再提供精细抠图素材；请使用任务包 generationInputs 和图层坐标意见',
    ),
    { status: 409 },
  );
}
