import { z } from 'zod';
import type { LayerFrame } from './layer-frame.js';
import { opticalPartError } from './optical-parts.js';
import {filmCutoutsSchema,validateFilmCutouts} from './film-cutouts.js';

const point = z.tuple([z.number().finite(), z.number().finite()]);
const quad = z.tuple([point, point, point, point]);
export const nativeGeometryRecipeSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  observation: z.string().trim().min(12).max(3000),
  shapes: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    color: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]),
    outer: z.union([quad,z.array(point).min(5).max(8)]).describe('v1/v2四角；显式v3连续膜可用五至八点凸直线轮廓表达截边。事前观察冻结，不取源mask或描摹像素。'),
    hole: quad.optional().describe('严格位于outer内的单一凸四边形透明孔；不输出源裁片。'),
    cutouts:filmCutoutsSchema.optional().describe('仅v2/v3薄膜：事前声明的独立椭圆透空窗，不是源mask。'),
    gradient: z.object({
      angle: z.number().finite().min(-180).max(180),
      stops: z.array(z.object({position:z.number().finite().min(0).max(1),alpha:z.number().int().min(1).max(254)}).strict()).min(2).max(8),
    }).strict().optional().describe('仅v2/v3连续薄膜：实色RGB独立于线性alpha渐变，事前观察冻结；不是物理透射率。'),
  }).strict()).min(1).max(8),
}).strict();
export type NativeGeometryRecipe = z.infer<typeof nativeGeometryRecipeSchema>;
type Quad = NativeGeometryRecipe['shapes'][number]['outer'];
const cross = (a: number[], b: number[], p: number[]) => (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
function orientation(points: Quad) {
  const n=points.length, signs = points.map((p,i) => cross(p,points[(i+1)%n],points[(i+2)%n]));
  if (signs.some(v => Math.abs(v)<0.01) || !signs.every(v => Math.sign(v)===Math.sign(signs[0])) ||
      points.some((a,i)=>points.some((p,k)=>k!==i&&k!==(i+1)%n&&Math.sign(signs[0])*cross(a,points[(i+1)%n],p)<=.01)))
    throw opticalPartError('原生实体几何仅允许非退化、无自交的凸四边形');
  if (Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0]))<=2 ||
      Math.max(...points.map(p=>p[1]))-Math.min(...points.map(p=>p[1]))<=2)
    throw opticalPartError('原生实体几何不能是空线或占位');
  return Math.sign(signs[0]);
}
export function validateNativeGeometryRecipe(recipe: NativeGeometryRecipe, frame: LayerFrame) {
  nativeGeometryRecipeSchema.parse(recipe);
  if (recipe.version===1 && recipe.shapes.some(s=>s.gradient || s.cutouts!==undefined) ||
      recipe.version>=2 && (recipe.shapes.length!==1 || recipe.shapes.some(s=>!s.gradient || s.hole)))
    throw opticalPartError('原生几何v1仅实体无渐变；v2仅单个连续薄膜，可显式椭圆圆窗但不混用四边形孔，必须冻结alpha渐变');
  if (new Set(recipe.shapes.map(s=>s.name)).size!==recipe.shapes.length)
    throw opticalPartError('原生实体几何形状名称须唯一');
  for (const s of recipe.shapes) {
    if(recipe.version===3 ? s.outer.length<5||s.outer.length>8 : s.outer.length!==4)
      throw opticalPartError('v1/v2原生几何只允许四角；v3仅单个五至八点凸轮廓连续膜');
    validateFilmCutouts(s.cutouts,frame,s.outer,recipe.version===3?'clipped-polygon':'quad');
    if(s.gradient) {
      const stops=s.gradient.stops;
      if(stops[0].position!==0 || stops.at(-1)!.position!==1 || stops.some((v,i)=>i>0 && v.position<=stops[i-1].position))
        throw opticalPartError('原生薄膜alpha渐变端点须0/1且位置严格递增');
    }
    const direction=orientation(s.outer);
    for (const points of [s.outer,s.hole].filter((p):p is Quad=>!!p)) {
      orientation(points);
      if (points.some(p=>p[0]<frame.x||p[0]>frame.x+frame.width||p[1]<frame.y||p[1]>frame.y+frame.height))
        throw opticalPartError('原生实体几何四角须在冻结画幅内');
    }
    if (s.hole?.some(p=>s.outer.some((a,i)=>direction*cross(a,s.outer[(i+1)%4],p)<=0.01)))
      throw opticalPartError('原生实体几何透明孔须严格位于外四边形内');
  }
}
