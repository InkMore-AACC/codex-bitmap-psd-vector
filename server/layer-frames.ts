import fs from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';
import {
  generationPlan,
  generationPoint,
  fitGeometry,
  aspectError,
  ASPECT_TOLERANCE,
} from '../shared/generation-geometry.js';
import { layerFrame, scaledFrame, unionFrames, frameSchema } from '../shared/layer-frame.js';
import type { Job, Layer } from './types.js';
import { assetPath, writeAsset, dir, atomic, json } from './store.js';
import { renderStyledLayer, renderTextLayer } from './media.js';

const reject = (message: string): never => {
  throw Object.assign(new Error(message), { status: 400 });
};

export function frameContract(
  job: Job,
  options?: { groups?: string[][]; width?: number; height?: number },
) {
  if (!job.frameContractVersion) return undefined;
  const output = frameSchema.parse({
    x: 0,
    y: 0,
    width: options?.width ?? job.snapshot.width,
    height: options?.height ?? job.snapshot.height,
  });
  if ((options?.width === undefined) !== (options?.height === undefined))
    reject('输出尺寸必须同时提供宽高');
  if (
    job.layerIds?.length &&
    (output.width !== job.snapshot.width || output.height !== job.snapshot.height)
  )
    reject('局部修改不能改变整图尺寸');
  const sx = output.width / job.snapshot.width,
    sy = output.height / job.snapshot.height;
  const allowed = job.snapshot.layers.filter(
    (l) => !job.layerIds?.length || job.layerIds.includes(l.id),
  );
  const groups = options?.groups ?? allowed.map((l) => [l.id]);
  if (!Array.isArray(groups) || groups.length > 300) reject('合并分组无效');
  const seen = new Set<string>();
  const grouped = groups.map((ids) => {
    if (!Array.isArray(ids) || !ids.length) return reject('合并分组不能为空');
    return ids.map((id) => {
      const l = allowed.find((l) => l.id === id);
      if (!l || seen.has(id)) return reject('来源图层不存在、重复或超出当前任务');
      seen.add(id);
      return l;
    });
  });
  return {
    version: 2,
    space: 'image-pixels',
    canvas: { width: output.width, height: output.height },
    layers: grouped.map((members) => {
      const l = members[0],
        ids = members.map((m) => m.id);
      const frame = scaledFrame(
        unionFrames(members.map((m) => layerFrame(m, job.snapshot))),
        sx,
        sy,
      );
      const generation = generationPlan(frame);
      return {
        layerId: l.id,
        sourceLayerIds: ids,
        name: members.map((m) => m.name).join(' + '),
        frame,
        generation,
        annotations: job.snapshot.annotations
          .filter((a) => a.layerId === null || ids.includes(a.layerId))
          .map((a) => ({
            ...a,
            points: a.points.flatMap((_, i) =>
              i % 2 ? [] : generationPoint(frame, a.points[i] * sx, a.points[i + 1] * sy),
            ),
            labelPosition: a.labelPosition
              ? generationPoint(frame, a.labelPosition[0] * sx, a.labelPosition[1] * sy)
              : undefined,
            brushSize:
              a.brushSize === undefined
                ? undefined
                : a.brushSize * Math.sqrt(sx * sy) * generation.scale,
            coordinateSpace: 'generation-pixels',
          })),
      };
    }),
    instruction:
      'frame 是最终图层位置与画幅；generation.size 才是生图目标，最多155万像素。透明留白计入完整画幅，不裁边、不居中物体、不铺满。生成坐标使用同一个scale和偏移，原图标注不变。输出即使约157万像素或比目标更小也不直接判失败；服务按实际尺寸以1%宽高比容差等比放大/缩小放回frame，严禁分别拉伸宽高。提交生图原始文件，x/y/width/height仍对应最终frame。逐层用stageOnly暂存并检查，再提交全部原始产物完成；暂存不代表视觉合格。合并先求全部sourceLayerIds的框并集，用canvas_get_request的generationPlan.groups获取合并/改尺寸后的生成计划。实际比例超过1%保留文件，不静默重试生图。只有确认多余留白且坐标相符时可声明sourceCrop，服务只允许裁掉全透明像素并记录偏移；禁止自动裁alpha包围盒、阈值删除弱alpha。背景少量补边复制边缘像素，必须检查接缝。提示词不能硬性保证工具尺寸，低分辨率允许等比放大但不得称为原生高清。',
  };
}

/** Normalize actual output bytes centrally; never trim alpha, recolor, or stretch to fit. */
export async function normalizeFramedResults(
  job: Job,
  layers: Layer[],
  width: number,
  height: number,
  allowIncomplete = false,
) {
  if (!job.frameContractVersion) return layers;
  const before = job.snapshot;
  const candidates = before.layers.filter(
    (l) => !job.layerIds?.length || job.layerIds.includes(l.id),
  );
  const consumed = new Set<string>();
  const normalized: Layer[] = [];
  for (const result of layers) {
    if (result.kind === 'plan') return reject('规划框不是实际图层产物，请先完成重建');
    const matching = candidates.filter((l) => l.id === result.id);
    const names = candidates.filter((l) => l.name === result.name);
    const ids =
      result.sourceLayerIds ||
      (matching.length ? [matching[0].id] : names.length === 1 ? [names[0].id] : []);
    if (!ids.length || new Set(ids).size !== ids.length)
      reject(`「${result.name}」缺少明确的来源图层 ID；合并时请提供 sourceLayerIds`);
    const sources = ids.map((id) => {
      const l = candidates.find((l) => l.id === id);
      if (!l || consumed.has(id)) return reject('来源图层不存在、超出当前任务或被重复提交');
      consumed.add(id);
      return l;
    });
    const frame = scaledFrame(
      unionFrames(sources.map((l) => layerFrame(l, before))),
      width / before.width,
      height / before.height,
    );
    if (
      ['x', 'y', 'width', 'height'].some(
        (k) => result[k as keyof typeof frame] !== frame[k as keyof typeof frame],
      )
    ) {
      reject(
        `「${result.name}」未遵循已确认画幅：应为 (${frame.x}, ${frame.y})，${frame.width} × ${frame.height}。请使用冻结画幅，不要重新估计位置或拉伸。`,
      );
    }
    const l: Layer = {
      ...result,
      ...frame,
      frame,
      id: sources[0].id,
      sourceLayerIds: ids,
      opinion:
        result.opinion ||
        sources
          .map((s) => s.opinion)
          .filter(Boolean)
          .join('\n'),
      preview: false,
      role:
        result.role ||
        (sources.every((s) => s.role === 'background') ? 'background' : 'foreground'),
    };
    if (l.kind === 'text' && l.text) {
      l.url = writeAsset(job.documentId, await renderTextLayer(l), '.png');
      l.generationSize = undefined;
    } else {
      let bytes: Buffer = fs.readFileSync(assetPath(job.documentId, l.url));
      const meta = await sharp(bytes).metadata();
      const w = meta.width!,
        h = meta.height!;
      if (!w || !h) reject(`「${l.name}」没有可读取的实际尺寸`);
      l.generationSourceUrl = l.url;
      const crop = l.sourceCrop;
      if (crop) {
        if (l.kind !== 'raster' || crop.x + crop.width > w || crop.y + crop.height > h)
          reject('裁切范围超出原始生成文件');
        const raw = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            if (
              (x < crop.x || x >= crop.x + crop.width || y < crop.y || y >= crop.y + crop.height) &&
              raw.data[(y * w + x) * raw.info.channels + raw.info.channels - 1] !== 0
            )
              reject('裁切会删除可见或弱透明内容，已保留原文件；只能移除已确认的全透明留白');
          }
        bytes = await sharp(bytes)
          .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
          .png()
          .toBuffer();
      }
      const content = crop || { width: w, height: h };
      const error = aspectError(content, frame);
      if (error > ASPECT_TOLERANCE + 1e-12) {
        reject(
          `「${l.name}」实际生成 ${w} × ${h}，与画幅 ${frame.width} × ${frame.height} 宽高比偏差 ${(error * 100).toFixed(2)}%，超过1%。已保留文件，未强行拉伸；请检查构图后再提交。`,
        );
      }
      l.generationSize = { width: w, height: h };
      if (l.kind === 'raster') {
        const fit = fitGeometry(content, frame);
        const background = l.role === 'background';
        if (background && (fit.width !== frame.width || fit.height !== frame.height)) {
          const stats = meta.hasAlpha ? await sharp(bytes).stats() : undefined;
          if (stats && stats.channels.at(-1)?.min !== 255)
            reject('背景比例适配需要补边，但背景含透明区域；请检查并补全背景，不自动生成透明接缝');
        }
        const resized = await sharp(bytes)
          .resize(
            content.width / frame.width >= content.height / frame.height
              ? { width: fit.width }
              : { height: fit.height },
          )
          .png()
          .toBuffer();
        const m = await sharp(resized).metadata();
        const left = Math.floor((frame.width - m.width!) / 2),
          top = Math.floor((frame.height - m.height!) / 2);
        const padding = {
          left,
          top,
          right: frame.width - m.width! - left,
          bottom: frame.height - m.height! - top,
        };
        l.url = writeAsset(
          job.documentId,
          await sharp(resized)
            .extend({
              ...padding,
              ...(background
                ? { extendWith: 'copy' as const }
                : { background: { r: 0, g: 0, b: 0, alpha: 0 } }),
            })
            .png()
            .toBuffer(),
          '.png',
        );
        l.generationAdaptation = {
          scale: fit.scale,
          offsetX: left,
          offsetY: top,
          contentWidth: m.width!,
          contentHeight: m.height!,
          aspectError: error,
          padding: background ? 'edge-copy' : 'transparent',
          crop,
        };
      }
    }
    l.previewUrl = l.psdStyle
      ? writeAsset(
          job.documentId,
          await renderStyledLayer(job.documentId, l, width, height),
          '.png',
        )
      : undefined;
    normalized.push(l);
    const stagePath = path.join(dir(job.documentId), 'jobs', job.id, 'staged-layers.json');
    const prior = json<Layer[]>(stagePath, []);
    atomic(stagePath, [
      ...prior.filter((p) => !(p.sourceLayerIds || [p.id]).some((id) => ids.includes(id))),
      l,
    ]);
  }
  if (!allowIncomplete && candidates.some((l) => !consumed.has(l.id)))
    reject(
      '重建结果缺少已确认的图层；请返回全部目标图层，合并时明确 sourceLayerIds，不能用空图代替。',
    );
  return normalized;
}
