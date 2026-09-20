import { RECONSTRUCTION_POLICY } from '../shared/reconstruction-policy.js';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CUTOUT, modelForMode } from '../shared/cutout.js';
import type { Job } from './types.js';
import { assetPath, atomic, getJob } from './store.js';
import { worker } from './models.js';

export function cutoutPacket(j: Job) {
  return {
    model: j.mode === 3 ? 'codex' : modelForMode(j.mode),
    options: j.cutoutOptions || DEFAULT_CUTOUT,
    referencePolicy: RECONSTRUCTION_POLICY,
    policy:
      '所有方案的真实分层采用同一流程：只使用干净原图、当前干净输入和语义/坐标标注，由当前对话 image_gen 重建各层并补全遮挡。粗抠、精抠及生成预览仅供用户看清分层，不作为生图图像输入、像素来源或蒙版；真实分层不再调用本地抠图。不能从原图再次按颜色抠取像素或把原图像素拼回生成结果冒充重建。revise 仅保留已经确认正确的正式图层。',
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
