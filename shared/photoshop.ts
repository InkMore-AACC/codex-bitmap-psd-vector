import { z } from 'zod';
import { frameSchema } from './layer-frame.js';
import { layerReviewSchema } from './layer-review.js';
import { GENERATION_PIXEL_BUDGET, fitGeometry } from './generation-geometry.js';
import { generationAlphaCheckSchema, generationLayoutSchema } from './generation.js';
import { nativeFilmRecipeSchema } from './native-film.js';
import { nativeGeometryRecipeSchema } from './native-geometry.js';
import { nativeTextRecipeSchema } from './native-text.js';

export const photoshopTextPlaneSchema = z.object({
  version: z.literal(1),
  recipe: nativeTextRecipeSchema.refine(r => r.version === 2, 'PS平面文字须冻结v2平面配方'),
}).strict();

/** Opaque full backgrounds need a one-pixel bleed at the shortest edge: Photoshop's
 * smart-object resampler otherwise introduces a translucent outermost row/column.
 * Source-protected backgrounds instead require exact 1:1 pixel placement. */
export function photoshopMaterialTarget(
  size: { width: number; height: number },
  frame: { x: number; y: number; width: number; height: number },
  opaqueFullBackground = false,
  sourceProtected = false,
) {
  if (sourceProtected && (!opaqueFullBackground || frame.x !== 0 || frame.y !== 0 ||
    size.width !== frame.width || size.height !== frame.height))
    throw new Error('保护背景须为同尺寸满幅文件，不能缩放、平移或补边');
  const fit = fitGeometry(size, frame);
  const bleedScale = opaqueFullBackground && !sourceProtected ? 1 + 2 / Math.min(fit.width, fit.height) : 1;
  const width = fit.width * bleedScale,
    height = fit.height * bleedScale;
  return {
    x: frame.x + fit.offsetX - (width - fit.width) / 2,
    y: frame.y + fit.offsetY - (height - fit.height) / 2,
    width,
    height,
    bleedScale,
  };
}

/** Compare every full-file corner; protected pixels cannot use the ordinary
 * resampling tolerance. Reject non-finite coordinates as well as drift. */
export function photoshopMaterialQuadMatches(
  actual: number[],
  target: { x: number; y: number; width: number; height: number },
  sourceProtected = false,
) {
  const { x, y, width, height } = target;
  const expected = [x, y, x + width, y, x + width, y + height, x, y + height];
  const tolerance = sourceProtected ? 0.0001 : 1.1;
  return actual.length === 8 && actual.every((v, i) => Number.isFinite(v) && Math.abs(v - expected[i]) <= tolerance);
}

export function isPhotoshopFullBackground(
  entry: { surface: string; frame: { x: number; y: number; width: number; height: number } },
  canvas: { width: number; height: number },
) {
  return (
    entry.surface === 'opaque' &&
    entry.frame.x === 0 &&
    entry.frame.y === 0 &&
    entry.frame.width === canvas.width &&
    entry.frame.height === canvas.height
  );
}

export const photoshopSettingsSchema = z.object({
  allowExtraction: z.boolean().default(true),
  autoUpscale: z.boolean().default(true),
  maxAttempts: z.number().int().min(2).max(3).default(3),
  generationPixelBudget: z
    .number()
    .optional()
    .transform(() => GENERATION_PIXEL_BUDGET),
});
export type PhotoshopSettings = z.infer<typeof photoshopSettingsSchema>;
export const DEFAULT_PHOTOSHOP = photoshopSettingsSchema.parse({});
const attemptSchema = z.object({
  method: z.string().trim().min(1).max(1000),
  observation: z.string().trim().min(1).max(3000),
  evidencePath: z.string().min(1),
});
export const photoshopEvidenceSchema = z.object({
  backgroundProtection: z.object({ tool: z.literal('derived-background'), generationId: z.string().min(1),
    baseGenerationId: z.string().min(1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    keepMaskHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  generation: z
    .object({
      tool: z.literal('image_gen'),
      outputPath: z.string().min(1),
      referencePaths: z.array(z.string().min(1)).min(1).max(20),
      prompt: z.string().trim().min(1).max(30000),
    })
    .optional(),
  extraction: z
    .object({
      method: z.string().trim().min(1).max(1000),
      occlusion: z.string().trim().min(1).max(3000),
      sourcePath: z.string().min(1).optional(),
    })
    .optional(),
});
export type PhotoshopEvidence = z.infer<typeof photoshopEvidenceSchema>;
export const photoshopPlanSchema = z.object({
  relations: generationLayoutSchema.shape.relations,
  canvas: z
    .object({
      width: z.number().int().min(1).max(30000),
      height: z.number().int().min(1).max(30000),
    })
    .optional(),
  layers: z
    .array(
      z.object({
        layerId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        name: z.string().trim().min(1).max(200),
        frame: frameSchema,
        route: z.enum(['native', 'generate', 'hybrid', 'extract', 'preserve']),
        content: z.enum(['bitmap', 'text', 'shape', 'light', 'background']),
        surface: z.enum(['transparent', 'opaque', 'screen']),
        rationale: z.string().trim().min(1).max(2000),
        includes: z.string().trim().min(1).max(2000),
        excludes: z.string().max(2000),
        compositing: z.string().trim().min(1).max(3000),
        elements: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
        anchors: generationLayoutSchema.shape.layers.element.shape.anchors,
        // Absence must stay absent: existing material/repair plan hashes remain compatible.
        alphaChecks: z.array(generationAlphaCheckSchema).max(20).optional(),
        sourceProtection: generationLayoutSchema.shape.layers.element.shape.sourceProtection,
        opticalPart: generationLayoutSchema.shape.layers.element.shape.opticalPart,
        contourSearch: generationLayoutSchema.shape.layers.element.shape.contourSearch,
        nativeFilm: nativeFilmRecipeSchema.optional().describe('仅显式native thin-film：真实可编辑闭合路径与原生透明渐变，首次制作前冻结；不是image_gen或源裁片。'),
        nativeGeometry: nativeGeometryRecipeSchema.optional().describe('仅显式native独立实体简单凸四边形/方环：首次制作前冻结人工观察四角与实色，真实PS形状；不用源裁片，不代表外观已通过。'),
        nativeTextPlane: photoshopTextPlaneSchema.optional().describe('显式真实字体平面文字；与textTargets同序冻结字体文件摘要、字号、颜色与平面，原生PS新副本制作并读回，不裁片或拉伸拟合。'),
        dependencies: z.array(z.string()).max(300).default([]),
        editable: z.enum(['native-text', 'native-shape', 'mixed', 'pixels']),
        textTargets: z
          .array(
            z.object({
              layerName: z.string().trim().min(1).max(200),
              text: z.string().trim().min(1).max(5000),
              box: frameSchema,
              appearance: z
                .object({
                  font: z.string().optional(),
                  color: z
                    .tuple([
                      z.number().min(0).max(255),
                      z.number().min(0).max(255),
                      z.number().min(0).max(255),
                    ])
                    .optional(),
                  rotation: z.number().min(-180).max(180).optional(),
                  requiresShear: z.boolean().default(false),
                  warpStyle: z.string().optional(),
                  warpBend: z.number().min(-100).max(100).optional(),
                  shear: z.number().min(-60).max(60).optional(),
                  requiredEffects: z
                    .array(
                      z.enum([
                        'dropShadow',
                        'innerShadow',
                        'outerGlow',
                        'innerGlow',
                        'bevel',
                        'solidFill',
                        'gradientOverlay',
                        'stroke',
                      ]),
                    )
                    .default([]),
                  observation: z.string().trim().min(1).max(3000),
                })
                .optional(),
            }),
          )
          .max(100)
          .default([]),
        nativeFallback: z
          .object({
            reason: z.string().trim().min(1).max(3000),
            attempts: z.array(attemptSchema).max(3).default([]),
            assessment: z
              .object({
                referencePath: z.string().min(1),
                limitation: z.string().trim().min(12).max(3000),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(300),
});
export type PhotoshopPlan = z.infer<typeof photoshopPlanSchema>;
export const photoshopActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('render-native-geometry'), layerId: z.string().min(1), inputPsdPath: z.string().min(1),
    taskId: z.string().optional(), jobId: z.string().optional() }).strict(),
  z.object({ action: z.literal('render-native-plane-text'), layerId: z.string().min(1), inputPsdPath: z.string().min(1),
    taskId: z.string().optional(), jobId: z.string().optional() }).strict(),
  z.object({ action: z.literal('render-native-film'), layerId: z.string().min(1), inputPsdPath: z.string().min(1),
    taskId: z.string().optional(), jobId: z.string().optional() }).strict(),
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('plan'), plan: photoshopPlanSchema }),
  z.object({
    action: z.literal('material'),
    layerId: z.string(),
    path: z.string(),
    provenance: z.enum(['generated', 'source-protected', 'extracted', 'preserved']),
    observation: z.string().trim().min(1).max(3000),
    allowAspectFit: z.boolean().default(false),
    generationId: z.string().optional(),
    placementFrame: frameSchema.optional(),
    repair: z
      .object({
        maskPath: z.string().min(1),
        expectedBaseWorkingHash: z.string().regex(/^[a-f0-9]{64}$/),
        baseArtifactPath: z.string().min(1),
      })
      .optional(),
    evidence: photoshopEvidenceSchema,
  }),
  z.object({
    action: z.literal('place-material'),
    artifactPath: z.string(),
    layerId: z.string(),
    choice: z.enum(['upscaled', 'original']).default('original'),
  }),
  z.object({
    action: z.literal('fit-text'),
    artifactPath: z.string(),
    layerId: z.string(),
    layerName: z.string().min(1),
    targetBox: frameSchema,
    font: z.string().min(1).optional(),
    fontSize: z.number().finite().positive().max(5000).optional(),
    tracking: z.number().finite().min(-1000).max(10000).optional(),
    color: z
      .tuple([
        z.number().int().min(0).max(255),
        z.number().int().min(0).max(255),
        z.number().int().min(0).max(255),
      ])
      .optional(),
    rotation: z.number().finite().min(-180).max(180).optional(),
    fit: z.enum(['uniform', 'none']).default('uniform'),
    shear: z.number().finite().min(-60).max(60).default(0),
    styles: z
      .object({
        stroke: z
          .object({
            color: z.tuple([
              z.number().min(0).max(255),
              z.number().min(0).max(255),
              z.number().min(0).max(255),
            ]),
            size: z.number().min(0).max(250),
          })
          .optional(),
        shadow: z
          .object({
            color: z.tuple([
              z.number().min(0).max(255),
              z.number().min(0).max(255),
              z.number().min(0).max(255),
            ]),
            opacity: z.number().min(0).max(100),
            size: z.number().min(0).max(250),
            distance: z.number().min(0).max(250),
            angle: z.number().min(-180).max(180),
          })
          .optional(),
      })
      .optional(),
    warp: z
      .object({
        style: z.enum([
          'none',
          'arc',
          'arcLower',
          'arcUpper',
          'arch',
          'bulge',
          'flag',
          'wave',
          'rise',
          'fisheye',
          'inflate',
          'squeeze',
          'twist',
        ]),
        bend: z.number().min(-100).max(100).default(0),
        horizontal: z.number().min(-100).max(100).default(0),
        vertical: z.number().min(-100).max(100).default(0),
      })
      .optional(),
  }),
  z.object({ action: z.literal('inspect'), artifactPath: z.string() }),
  z.object({ action: z.literal('inspect-progress'), artifactPath: z.string() }),
  z.object({
    action: z.literal('upscale-material'),
    layerId: z.string(),
    force: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('review'),
    layerId: z.string(),
    review: layerReviewSchema,
    materialChoice: z.enum(['upscaled', 'original']).optional(),
    checks: z.object({
      isolation: z.string().trim().min(1).max(3000),
      occlusion: z.string().trim().min(1).max(3000),
      appearance: z.string().trim().min(1).max(3000),
      text: z.string().trim().min(1).max(3000).optional(),
      elements: z
        .array(
          z.object({
            name: z.string().min(1),
            status: z.enum(['matched', 'different', 'missing']),
            observation: z.string().trim().min(1).max(2000),
          }),
        )
        .optional(),
      comparisonHash: z.string().optional(),
      referenceComparison: z
        .object({
          geometry: z.string().trim().min(12).max(3000),
          appearance: z.string().trim().min(12).max(3000),
          typography: z.string().trim().min(12).max(3000).optional(),
        })
        .optional(),
    }),
  }),
  z.object({
    action: z.literal('review-composite'),
    observation: z.string().trim().min(1).max(5000),
    comparisonHash: z.string().optional(),
    relations: z
      .array(
        z.object({
          id: z.string(),
          status: z.enum(['matched', 'different']),
          observation: z.string().trim().min(12).max(3000),
        }),
      )
      .optional(),
  }),
]);
export const nativePsdSchema = z.object({
  version: z.literal(1),
  compositeUrl: z.string(),
  mappings: z
    .array(
      z.object({
        layerId: z.string(),
        groupName: z.string(),
        editable: z.enum(['native-text', 'native-shape', 'mixed', 'pixels']),
      }),
    )
    .max(300),
});
export type NativePsd = z.infer<typeof nativePsdSchema>;
export const photoshopGroupName = (id: string) => `LC_${id}`;
