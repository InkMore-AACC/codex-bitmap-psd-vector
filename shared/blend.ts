import { z } from 'zod';
export const blendModeSchema = z.enum(['normal', 'screen']);
export type BlendMode = z.infer<typeof blendModeSchema>;
export const canvasBlend = (mode?: BlendMode) => mode === 'screen' ? 'screen' as const : 'source-over' as const;
