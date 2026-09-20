import { frameSchema } from '../shared/layer-frame.js';
import { z } from 'zod';
import { cutoutOptionsSchema, psdModeSchema } from '../shared/cutout.js';
const finite = z.number().finite();
const coord = finite.min(-100000).max(100000);
const dimension = finite.min(1).max(30000);
const str = z.string().max(20000);
const id = z.string().min(1).max(200);
const url = z.string().max(500);
const text = z.object({
  value: str,
  fontFamily: z.string().max(200),
  fontSize: finite.min(1).max(5000),
  color: z.string().max(100),
  x: coord,
  y: coord,
});
const effects = z.object({
  stroke: z
    .object({ color: z.string().regex(/^#[0-9a-f]{6}$/i), size: finite.min(0).max(500) })
    .optional(),
  shadow: z
    .object({
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
      blur: finite.min(0).max(500),
      offsetX: coord,
      offsetY: coord,
      opacity: finite.min(0).max(1),
    })
    .optional(),
});
const imageLayerSchema = z.object({
  id,
  name: z.string().max(300),
  url: url.min(1),
  previewUrl: url.optional(),
  x: coord,
  y: coord,
  width: dimension,
  height: dimension,
  visible: z.boolean(),
  opacity: finite.min(0).max(1),
  opinion: str,
  disposition: z.enum(['keep', 'rebuild']),
  kind: z.enum(['raster', 'text', 'vector']),
  svg: z.string().max(40000000).optional(),
  text: text.optional(),
  textDirty: z.boolean().optional(),
  psdStyle: effects.optional(),
  role: z.enum(['background', 'foreground']).optional(),
  preview: z.boolean().optional(),
  frame: frameSchema.optional(),
  sourceLayerIds: z.array(id).min(1).max(300).optional(),
  generationSize: z.object({ width: dimension, height: dimension }).optional(),
  generationSourceUrl: url.optional(),
  sourceCrop: z
    .object({
      x: finite.int().nonnegative(),
      y: finite.int().nonnegative(),
      width: dimension.int(),
      height: dimension.int(),
    })
    .optional(),
  generationAdaptation: z
    .object({
      scale: finite.positive(),
      offsetX: finite.nonnegative(),
      offsetY: finite.nonnegative(),
      contentWidth: dimension,
      contentHeight: dimension,
      aspectError: finite.nonnegative(),
      padding: z.enum(['transparent', 'edge-copy']),
      crop: z
        .object({
          x: finite.int().nonnegative(),
          y: finite.int().nonnegative(),
          width: dimension.int(),
          height: dimension.int(),
        })
        .optional(),
    })
    .optional(),
  cutoutBox: z.tuple([coord, coord, dimension, dimension]).optional(),
  originalPsdIndex: z.array(z.number().int().nonnegative()).max(30).optional(),
  groupPath: z.array(z.string().max(200)).max(30).optional(),
});
const planningLayerSchema = imageLayerSchema.extend({
  kind: z.literal('plan'),
  preview: z.literal(true),
  frame: frameSchema,
  url: z.never().optional(),
  previewUrl: z.never().optional(),
  svg: z.never().optional(),
  text: z.never().optional(),
  psdStyle: z.never().optional(),
  generationSourceUrl: z.never().optional(),
  generationAdaptation: z.never().optional(),
  sourceCrop: z.never().optional(),
  disposition: z.literal('rebuild'),
});
export const layerSchema = z.union([imageLayerSchema, planningLayerSchema]);
const annotation = z.object({
  id,
  layerId: id.nullable(),
  type: z.enum(['arrow', 'ellipse', 'box', 'pen', 'text']),
  points: z
    .array(coord)
    .min(2)
    .max(20000)
    .refine((p) => p.length % 2 === 0),
  text: str,
  color: z.string().regex(/^#[0-9a-f]{3,8}$/i),
  opacity: finite.min(0).max(1).optional(),
  brushSize: finite.min(1).max(2000).optional(),
  strokeWidth: finite.min(1).max(20).optional(),
  fontWeight: finite.int().min(100).max(900).optional(),
  fontSize: finite.min(8).max(72).optional(),
  labelPosition: z.tuple([coord, coord]).optional(),
});
export const imageSchema = z
  .object({
    id,
    name: z.string().max(300),
    width: dimension,
    height: dimension,
    x: coord,
    y: coord,
    source: url,
    url,
    layers: z
      .array(layerSchema)
      .max(300)
      .refine((ls) => new Set(ls.map((l) => l.id)).size === ls.length, '图层 ID 不可重复'),
    vectorLayers: z
      .array(layerSchema)
      .max(300)
      .refine((ls) => new Set(ls.map((l) => l.id)).size === ls.length, '图层 ID 不可重复')
      .optional(),
    annotations: z.array(annotation).max(2000),
    opinion: str,
    status: z.enum(['original', 'preview', 'layered', 'vector']),
    version: z.number().int().nonnegative(),
    vectorUrl: url.optional(),
    psdSource: url.optional(),
    parentId: id.optional(),
    sourceJobId: id.optional(),
    sourceVersion: z.number().int().nonnegative().optional(),
    basedOnOlderVersion: z.boolean().optional(),
    artifactUrl: url.optional(),
  })
  .superRefine((image, ctx) => {
    if (image.layers.some((l) => l.kind === 'plan') && image.status !== 'preview')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '规划图层尚未重建，图片必须处于预分层阶段',
      });
    if (image.vectorLayers?.some((l) => l.kind === 'plan'))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '规划框不能作为矢量结果' });
  });
export const documentSchema = z.object({
  id,
  taskId: id,
  revision: z.number().int().nonnegative(),
  images: z
    .array(imageSchema)
    .max(100)
    .refine(
      (images) => new Set(images.map((i) => i.id)).size === images.length,
      '节点 ID 不可重复',
    ),
  settings: z.object({
    psdMode: psdModeSchema,
    cutoutOptions: cutoutOptionsSchema.optional(),
    vectorEngine: z.enum(['vectorizerCom', 'recraft', 'vectorizer302', 'vectorizer']),
    vectorizerComMode: z.enum(['auto', 'codex']).optional(),
    theme: z.enum(['dark', 'light']),
  }),
  layout: z.object({
    layersWidth: finite.min(120).max(1000),
    opinionsWidth: finite.min(180).max(1400),
    editorHeight: finite.min(100).max(2000),
  }),
  updatedAt: z.string(),
});
export const viewStateSchema = z
  .object({
    x: finite.min(-10000000).max(10000000),
    y: finite.min(-10000000).max(10000000),
    scale: finite.min(0.025).max(5),
    selectedImageId: id.nullable(),
  })
  .strict();
export const jobSchema = z.object({
  imageId: id,
  useOriginal: z.boolean().optional(),
  useVectorLayers: z.boolean().optional(),
  layerIds: z.array(id).max(300).optional(),
  type: z.enum(['plan', 'layer', 'revise', 'vectorize', 'photoshop', 'illustrator']),
  mode: psdModeSchema.optional(),
  engine: z.enum(['vectorizerCom', 'recraft', 'vectorizer302', 'vectorizer']).optional(),
});
