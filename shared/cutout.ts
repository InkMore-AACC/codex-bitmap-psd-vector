import { z } from 'zod';

export const psdModeSchema = z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
export type PsdMode = z.infer<typeof psdModeSchema>;
export type CutoutModel = 'coarse' | 'birefnet' | 'lucida';
const common = {
  padding: z.number().int().min(0).max(256),
  feather: z.number().min(0).max(10),
  offset: z.number().int().min(-20).max(20),
  blackPoint: z.number().min(0).max(0.95),
  whitePoint: z.number().min(0.05).max(1),
};
const levelsValid = (v: { blackPoint: number; whitePoint: number }) => v.whitePoint > v.blackPoint;
const fine = z
  .object({
    ...common,
    resolution: z.number().int().min(512).max(3072).multipleOf(32),
    device: z.enum(['auto', 'cuda', 'cpu']),
    precision: z.enum(['fp32', 'fp16']),
    decontaminate: z.boolean(),
  })
  .strict()
  .refine(levelsValid, '不透明点必须大于透明点');
export const cutoutOptionsSchema = z
  .object({
    coarse: z
      .object({ ...common, threads: z.number().int().min(1).max(16) })
      .strict()
      .refine(levelsValid, '不透明点必须大于透明点'),
    birefnet: fine,
    lucida: fine,
  })
  .strict();
export type CutoutOptions = z.infer<typeof cutoutOptionsSchema>;
export const DEFAULT_CUTOUT: CutoutOptions = {
  coarse: { padding: 0, feather: 0, offset: 0, blackPoint: 0, whitePoint: 1, threads: 8 },
  birefnet: {
    padding: 32,
    feather: 0,
    offset: 0,
    blackPoint: 0,
    whitePoint: 1,
    resolution: 2048,
    device: 'auto',
    precision: 'fp32',
    decontaminate: false,
  },
  lucida: {
    padding: 32,
    feather: 0,
    offset: 0,
    blackPoint: 0,
    whitePoint: 1,
    resolution: 1024,
    device: 'auto',
    precision: 'fp32',
    decontaminate: false,
  },
};
export const cutoutDefaultsSchema = z
  .object({ psdMode: psdModeSchema, cutoutOptions: cutoutOptionsSchema })
  .strict();
export const modelForMode = (mode: number): CutoutModel =>
  mode === 4 ? 'birefnet' : mode === 5 ? 'lucida' : 'coarse';
export const PSD_MODES = [
  {
    id: 4 as const,
    name: 'BiRefNet HR 精细预览 + Codex 重建',
    detail:
      '精细抠图仅让预览图层更清晰；确认后只用原图与坐标意见由 Codex 重建，不传入抠图图片或蒙版。',
    cost: '本地抠图不消耗额度 · 规划与逐层重建消耗 Codex 额度',
  },
  {
    id: 5 as const,
    name: 'Lucida v7 精细预览 + Codex 重建',
    detail: '精细抠图仅让预览图层更清晰；重建流程与粗抠相同，不传入抠图图片、不保留其像素。',
    cost: '本地抠图不消耗额度 · 规划与逐层重建消耗 Codex 额度',
  },
  {
    id: 2 as const,
    name: '本地粗抠 + 生成重建',
    detail: 'U2NetP 快速预览与标注；Codex 按原图重新生成各层。',
    cost: '本地预览不消耗额度 · 规划与逐层重建消耗 Codex 额度',
  },
  {
    id: 3 as const,
    name: 'Codex 框规划 + 生成重建',
    detail: 'Codex 只识别对象、命名和规划画幅框；预分层不抠图、不生图，确认后才逐层重建。',
    cost: '规划消耗推理额度 · 确认后才消耗生图额度',
  },
];
