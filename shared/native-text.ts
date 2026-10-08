import { z } from 'zod';
import { frameSchema } from './layer-frame.js';

// Explicit observed text only; no inferred OCR, source glyph tracing or silent font fallback.
const fields = {
  observation: z.string().trim().min(12).max(3000),
  spans: z.array(z.object({
    text: z.string().min(1).max(1000).refine(t => t.trim().length > 0 &&
      !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufe00-\ufe0f]/u.test(t),
      '原生文字仅支持显式单行可见文字，不支持控制符、换行或变体选择符'),
    fontPath: z.string().min(1),
    fontHash: z.string().regex(/^[a-f0-9]{64}$/),
    fontSize: z.number().finite().positive().max(1000),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    // v1: final canvas ink bounds. v2: local ink bounds before the frozen plane transform.
    box: frameSchema,
  }).strict()).min(1).max(100),
};
export const nativeTextSpanSchema = fields.spans.element;
export const nativeTextTransformSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(),
  z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(([a,b,c,d]) => a*d-b*c > 0.000001, '平面文字变换须可逆且不镜像');
export const nativeTextRecipeSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...fields }).strict(),
  z.object({ version: z.literal(2), ...fields,
    transform: nativeTextTransformSchema,
    transformObservation: z.string().trim().min(12).max(3000),
  }).strict(),
]);
export type NativeTextRecipe = z.infer<typeof nativeTextRecipeSchema>;

export function nativeTextInkQuad(recipe: NativeTextRecipe, box: {x:number;y:number;width:number;height:number}) {
  const points: [number,number][] = [[box.x,box.y],[box.x+box.width,box.y],
    [box.x+box.width,box.y+box.height],[box.x,box.y+box.height]];
  if (recipe.version === 1) return points;
  const [a,b,c,d,e,f] = recipe.transform;
  return points.map(([x,y]): [number,number] => [a*x+c*y+e,b*x+d*y+f]);
}
