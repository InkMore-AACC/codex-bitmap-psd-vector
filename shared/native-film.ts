import { z } from 'zod';
import type { LayerFrame } from './layer-frame.js';
import { opticalPartError } from './optical-parts.js';
import {filmCutoutsSchema,validateFilmCutouts} from './film-cutouts.js';

const knot = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
export const nativeFilmRecipeSchema = z.object({
  version: z.union([z.literal(1),z.literal(2)]),
  observation: z.string().trim().min(12).max(3000),
  cutouts:filmCutoutsSchema.optional().describe('显式椭圆透空窗；v1四个直线外结点，v2五至八点凸直线外沿；不取源mask。'),
  knots: z.array(knot).min(3).max(64).describe('闭合Bezier路径，最终PS画布像素[inX,inY,anchorX,anchorY,outX,outY]；人工观察冻结，不是图像提取。'),
  gradient: z.object({
    angle: z.number().finite().min(-180).max(180),
    stops: z.array(z.object({
      position: z.number().finite().min(0).max(1),
      color: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]),
      alpha: z.number().int().min(1).max(254),
    }).strict()).min(2).max(8),
  }).strict(),
}).strict();
export type NativeFilmRecipe = z.infer<typeof nativeFilmRecipeSchema>;

export function validateNativeFilmRecipe(recipe: NativeFilmRecipe, frame: LayerFrame) {
  nativeFilmRecipeSchema.parse(recipe);
  if(recipe.version===2 && !recipe.cutouts)throw opticalPartError('原生薄膜v2仅用于五至八点凸直线外沿及显式椭圆窗');
  if(recipe.cutouts){
    if((recipe.version===1 ? recipe.knots.length!==4 : recipe.knots.length<5||recipe.knots.length>8) || recipe.knots.some(k=>k[0]!==k[2]||k[1]!==k[3]||k[4]!==k[2]||k[5]!==k[3]))throw opticalPartError(recipe.version===2?'原生薄膜v2只支持五至八点凸直线外沿':'带圆窗原生膜只支持直线四边形外沿');
    validateFilmCutouts(recipe.cutouts,frame,recipe.knots.map(k=>[k[2],k[3]]),recipe.version===2?'clipped-polygon':'quad');
  }
  const stops = recipe.gradient.stops;
  if (stops[0].position !== 0 || stops.at(-1)!.position !== 1 ||
      stops.some((s, i) => i > 0 && s.position <= stops[i - 1].position))
    throw opticalPartError('原生薄膜渐变端点须为0/1且色标位置严格递增');
  if (recipe.knots.some(k => k.some((v, i) => i % 2 === 0
    ? v < frame.x || v > frame.x + frame.width : v < frame.y || v > frame.y + frame.height)))
    throw opticalPartError('原生薄膜Bezier锚点/控制点须在本件冻结画幅内');
  const xs = recipe.knots.map(k => k[2]), ys = recipe.knots.map(k => k[3]);
  if (Math.max(...xs) - Math.min(...xs) <= 1 || Math.max(...ys) - Math.min(...ys) <= 1)
    throw opticalPartError('原生薄膜路径不能是空线或1像素占位');
}
