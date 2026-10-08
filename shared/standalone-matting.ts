import { z } from 'zod';
import { cutoutOptionsSchema, DEFAULT_CUTOUT } from './cutout.js';

// Independent defaults: never inherit the preview pipeline's parameters.
export const standaloneMattingSchema = z
  .object({
    model: z.enum(['birefnet', 'lucida']),
    options: cutoutOptionsSchema.omit({ coarse: true }).strict(),
  })
  .strict();
export type StandaloneMatting = z.infer<typeof standaloneMattingSchema>;
export const DEFAULT_MATTING: StandaloneMatting = {
  model: 'birefnet',
  options: {
    birefnet: { ...DEFAULT_CUTOUT.birefnet, padding: 0 },
    lucida: { ...DEFAULT_CUTOUT.lucida, padding: 0 },
  },
};
