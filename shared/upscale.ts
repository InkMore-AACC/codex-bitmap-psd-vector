import { z } from 'zod';

// Migrate retired settings, never execute the retired engine.
export const upscaleSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const value = { ...raw } as Record<string, unknown>;
    if (value.model === 'vosr2' || value.model === undefined) value.model = 'seedvr2-7b-int8';
    for (const key of [
      'color',
      'tileSize',
      'tileOverlap',
      'vaeTileSize',
      'vaeOverlap',
      'precision',
    ])
      delete value[key];
    return value;
  },
  z
    .object({
      model: z.literal('seedvr2-7b-int8'),
      seedColor: z.enum(['lab', 'wavelet', 'adain', 'none']).default('lab'),
      seedDetail: z.number().min(0).max(1).default(1),
      seedVaeTile: z.union([z.literal(256), z.literal(512), z.literal(1024)]).default(512),
      seedVaeOverlap: z.number().int().min(32).max(256).multipleOf(32).default(128),
      seedMemory: z.enum(['normal', 'low']).default('normal'),
      scale: z.union([z.literal(2), z.literal(4)]).default(2),
      seed: z.number().int().min(0).max(4294967295).default(42),
      videoFrames: z.union([z.literal(5), z.literal(9), z.literal(17)]).default(9),
      videoOverlap: z.union([z.literal(1), z.literal(5), z.literal(9)]).default(5),
      videoQuality: z.union([z.literal(16), z.literal(18), z.literal(23)]).default(18),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.seedVaeOverlap > v.seedVaeTile / 4)
        ctx.addIssue({
          code: 'custom',
          path: ['seedVaeOverlap'],
          message: '编解码重叠不能超过分块边长的1/4',
        });
      if (v.videoOverlap >= v.videoFrames)
        ctx.addIssue({
          code: 'custom',
          path: ['videoOverlap'],
          message: '视频重叠帧数必须小于连续处理帧数',
        });
    }),
);
export type UpscaleSettings = z.infer<typeof upscaleSchema>;
export const DEFAULT_UPSCALE: UpscaleSettings = upscaleSchema.parse({});
export function upscaleModelName(_settings?: Pick<UpscaleSettings, 'model'>) {
  return 'SeedVR2 7B 标准版 INT8';
}
export function upscaleDimensions(width: number, height: number, settings: UpscaleSettings) {
  const w = width * settings.scale,
    h = height * settings.scale;
  if (w > 16384 || h > 16384 || w * h > 40_000_000)
    throw new Error('超分结果超过4000万像素或单边16384像素，请降低倍率或先裁切');
  return { width: w, height: h };
}
