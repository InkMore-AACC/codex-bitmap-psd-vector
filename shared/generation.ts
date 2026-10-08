import { z } from 'zod';
import { blendModeSchema } from './blend.js';
import { layerReviewSchema } from './layer-review.js';
import { nativeTextRecipeSchema } from './native-text.js';
import { nativeGeometryRecipeSchema } from './native-geometry.js';
import { opticalPartSchema } from './optical-parts.js';
import { contourSearchSchema } from './contour-search.js';

const point = z.tuple([z.number().finite(), z.number().finite()]);
const alphaCheckBase = {
  name: z.string().trim().min(1).max(200),
  box: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(),
    z.number().int().positive(), z.number().int().positive()])
    .describe('当前图片局部像素[x,y,width,height]，不是屏幕坐标或生图文件坐标。'),
  maxAlpha: z.number().int().min(0).max(254),
  minPassingFraction: z.number().finite().gt(0).max(1),
};
export const generationAlphaCheckSchema = z.discriminatedUnion('kind', [
  z.object({ ...alphaCheckBase, kind: z.literal('clear') }).strict(),
  z.object({
    ...alphaCheckBase, kind: z.literal('transmissive'),
    minAlpha: z.number().int().min(1).max(254),
    minBackgroundResponse: z.number().finite().gt(0).max(255)
      .describe('标准黑白底数学合成的8位RGB响应下限，不是从扁平原图推断的真实光学透射率。'),
  }).strict(),
  // Explicit presence floor for sparse owned content (for example printed rows).
  // A nonempty patch is not proof of correct glyphs or material separation.
  z.object({
    name: alphaCheckBase.name, box: alphaCheckBase.box,
    minPassingFraction: alphaCheckBase.minPassingFraction,
    kind: z.literal('occupied'), minAlpha: z.number().int().min(1).max(255),
  }).strict(),
]).refine(c => c.kind !== 'transmissive' || c.minAlpha <= c.maxAlpha,
  'transmissive的minAlpha不能大于maxAlpha');
// PS adds explicit occupied bands without acquiring ordinary-only opaque rules.
// Opaque remains an ordinary-only,
// explicitly frozen lower bound, with no upper/response constraint or default.
export const ordinaryGenerationAlphaCheckSchema = z.union([generationAlphaCheckSchema,
  z.object({ name: alphaCheckBase.name, box: alphaCheckBase.box,
    minPassingFraction: alphaCheckBase.minPassingFraction, kind: z.literal('opaque'),
    minAlpha: z.number().int().min(1).max(255) }).strict()]);
export type GenerationAlphaCheck = z.infer<typeof ordinaryGenerationAlphaCheckSchema>;
export const matteEncodingSchema = z.enum(['exact-gray8-v1', 'near-neutral-luma8-v2', 'near-neutral-luma8-v3', 'white-composite-rgb8-v1']);
export type MatteEncoding = z.infer<typeof matteEncodingSchema>;
export const matteBackdropSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), color: z.literal('#808080'), space: z.literal('srgb-byte-v1') }).strict(),
  z.object({ version: z.literal(2), color: z.literal('#000000'), space: z.literal('srgb-byte-v1') }).strict(),
]);
export type MatteBackdrop = z.infer<typeof matteBackdropSchema>;
const packedBackdropFields = {
  arrangement: z.literal('black-left-white-right'),
  panelSize: z.object({ width: z.number().int().positive().max(1500), height: z.number().int().positive().max(1500) }).strict(),
};
export const packedBackdropSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...packedBackdropFields }).strict(),
  z.object({ version: z.literal(2), ...packedBackdropFields, normalization: z.literal('whole-carrier-nearest-v1') }).strict(),
]).refine(p => 2 * p.panelSize.width * p.panelSize.height <= 1500000,
  '双板完整carrier含留白合计不得超过150万像素');
export type PackedBackdrop = z.infer<typeof packedBackdropSchema>;
// This is a new-job opt-in, never populated from a pre-layer preview.
export const backgroundSourceProtectionSchema = z.object({
  version: z.literal(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  keepMask: z.object({ path: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  review: z.object({ path: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();
export type BackgroundSourceProtection = z.infer<typeof backgroundSourceProtectionSchema>;
export const generationLayoutSchema = z.object({
  width: z.number().int().positive().max(30000).optional(),
  height: z.number().int().positive().max(30000).optional(),
  layers: z
    .array(
      z.object({
        sourceLayerIds: z.array(z.string()).min(1).max(300),
        elements: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
        blendMode: blendModeSchema.optional(),
        content: z.literal('light-effect').optional().describe('screen必须明确声明为独立光效；不能用于普通物体绕过透明检查。'),
        excludes: z.string().trim().min(1).max(3000),
        alphaChecks: z.array(ordinaryGenerationAlphaCheckSchema).max(20).optional()
          .describe('可选冻结区域alpha约束；仅普通v4正常透明前景。所有数值阈值必须显式提供。'),
        allowAuxMatte: z.boolean().optional().describe('实验性显式启用独立生成灰阶matte；仅普通v4单层normal透明材质且已有transmissive检查。不是视觉接受。'),
        matteBackdrop: matteBackdropSchema.optional().describe('首次prepare前冻结底色实验；v1中灰RGB+独立matte，v2黑底RGB+同几何彩色白底RGB。中间件不可直接当最终层，固定解混且不从源图取像素。'),
        packedBackdrop: packedBackdropSchema.optional().describe('新普通v4单次生成双板实验；完整carrier左黑右白，首次prepare前冻结布局和请求尺寸。只从同一真实生成carrier拆板，固定解混；不保证同一前景或视觉一致性。'),
        sourceProtection: backgroundSourceProtectionSchema.optional(),
        opticalPart: opticalPartSchema.optional().describe('新v4光学组件分件归属：连续薄膜、实体印字/边框和可选表面细节独立；v2要求各件至少三个共同非共线源anchors，首次prepare前冻结。不是实际分层验收。'),
        contourSearch: contourSearchSchema.optional().describe('新v4独立实体分件可事前冻结最终画布像素搜索框及源观察；仅限制自动配准测量目标，不改变完整素材/参考/模型请求，不放宽置信门槛。'),
        nativeText: nativeTextRecipeSchema.optional().describe('显式普通v4单层原生字体渲染实验；v1水平字形，v2事前观察的可逆非镜像平面倾斜/斜切。冻结实际文字、字体摘要和墨迹位置，不是image_gen，输出是透明位图文字。'),
        nativeGeometry: nativeGeometryRecipeSchema.optional().describe('显式新v4几何渲染：v1实体四角/孔/实色；v2连续膜四角，v3连续膜五至八点凸直线外沿；薄膜实色/alpha渐变及可选cutouts椭圆窗，要求clear/transmissive。事前冻结，透明位图，真实native-geometry-renderer身份，不是image_gen或PS原生形状。'),
        anchors: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200),
              point,
              observation: z.string().trim().min(1).max(1000),
            }),
          )
          .max(50)
          .default([]),
      }),
    )
    .min(1)
    .max(300),
  relations: z
    .array(
      z.object({
        id: z.string().min(1),
        layerIds: z.array(z.string()).min(2).max(10),
        kind: z.enum(['contact', 'occlusion', 'alignment', 'shared-effect']),
        observation: z.string().trim().min(1).max(3000),
        point: point.optional(),
      }),
    )
    .max(300)
    .default([]),
});

export const generationActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('derive-packed-alpha'), packedId: z.string().min(1),
    expectedCarrierHash: z.string().regex(/^[a-f0-9]{64}$/),
    taskId: z.string().optional(), jobId: z.string().optional() }).strict(),
  z.object({ action: z.literal('render-native-text'), requestId: z.string().min(1),
    taskId: z.string().optional(), jobId: z.string().optional() }).strict(),
  z.object({ action: z.literal('render-native-geometry'), requestId: z.string().min(1),
    taskId: z.string().optional(), jobId: z.string().optional() }).strict(),
  z.object({ action: z.literal('derive-background'), taskId: z.string().optional(), jobId: z.string().optional(), baseGenerationId: z.string().min(1),
    expectedBaseWorkingHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal('layout'), layout: generationLayoutSchema }),
  z.object({
    action: z.literal('composite'),
    generationIds: z.array(z.string()).min(1).max(300),
    detailGenerationIds: z
      .array(z.string())
      .max(300)
      .default([])
      .describe(
        '按需导出这些候选所在区域的原尺寸参考与最终合成局部，用于小字、发丝、光效等检查。省略时只输出原尺寸整图和总览对比。',
      ),
  }),
  z.object({
    action: z.literal('review-composite'),
    comparisonHash: z.string(),
    layers: z
      .array(
        z.object({
          generationId: z.string(),
          status: z.enum(['matched', 'different']),
          observation: z.string().trim().min(12).max(3000),
        }),
      )
      .min(1)
      .max(300),
    relations: z
      .array(
        z.object({
          id: z.string(),
          status: z.enum(['matched', 'different']),
          observation: z.string().trim().min(12).max(3000),
        }),
      )
      .max(300)
      .default([]),
  }),
  z.object({
    action: z.literal('prepare'),
    sourceLayerIds: z.array(z.string()).min(1).max(300),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    purpose: z.string().trim().min(1).max(6000),
    elements: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
    referenceObservation: z.string().trim().min(1).max(6000),
    referenceContext: z.object({
      marginPixels: z.number().int().min(1).max(128),
      observation: z.string().trim().min(12).max(1000),
      referenceMode: z.literal('context-only').optional(),
    }).strict().optional().describe(
      '仅新prepare的v4普通透明前景或已声明独立screen光效：观察局部框截到真实可见笔画或弱光尾迹后，显式扩展干净源参考及完整承载。边距为最终整图像素，冻结frame和定位点不变；screen画外留白为纯黑中性底，不分离或裁弱光。不是蒙版或最终素材。背景、源保护、辅助matte及旧流程不支持。',
    ),
    detailReferences: z.array(z.object({
      name: z.string().trim().min(1).max(200),
      box: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(),
        z.number().int().positive(), z.number().int().positive()]),
      observation: z.string().trim().min(12).max(1000),
    }).strict()).min(1).max(3).optional().describe(
      '可选干净细节参考，box为最终整图像素且须在本层frame及canvas内；后台从构图参考生成，不接收路径。最多3处、合计262144像素，不缩放或作为最终素材。辅助matte不支持。',
    ),
    referenceScale: z.number().int().min(2).max(4).optional().describe(
      '新v4单层normal透明前景可显式将唯一完整局部参考等比放大2–4倍呈现，放大文件含留白不得超过150万像素；仅local-only、无承载扩展/周边/细节参考。插值不新增真实细节，不改变设计frame、源定位点或输出预算；旧请求不追改。',
    ),
    matteForGenerationId: z.string().min(1).optional().describe('为本任务已登记真实RGB候选准备辅助灰阶matte；不作为普通图层候选。'),
    matteEncoding: matteEncodingSchema.optional().describe('仅aux prepare显式冻结；缺字段严格exact-gray8-v1。near-neutral v2/v3固定luma及完整raw统计；white-composite-rgb8-v1仅用于事前冻结version2黑底配对，保留白底RGB全彩通道，不转换为matte。不追溯旧请求。'),
    promptStyle: z
      .enum(['structured', 'concise-edit'])
      .default('structured')
      .describe(
        'concise-edit用于严格参考编辑实验：精简系统描述，保留归属、尺寸、150万预算、排除项和全部用户意见；不省略登记或审核。',
      ),
    referenceStrategy: z
      .enum(['local-and-global', 'local-only'])
      .optional()
      .describe(
        '在准备阶段决定引用范围。新v4独立模型前景/光效有干净局部时默认local-only；背景、旧流程及辅助实验默认local-and-global。可显式选择整图语境；登记仍必须引用准备返回的完整有序referencePaths。',
      ),
    anchors: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(200),
          point: z.tuple([z.number().finite(), z.number().finite()]),
          observation: z.string().trim().min(1).max(1000),
        }),
      )
      .max(50)
      .default([])
      .describe('人工查看参考后记录的定位点，坐标是最终整图像素；不以估计值冒充自动测量。'),
  }),
  z.object({
    action: z.literal('register'),
    requestId: z.string(),
    path: z.string(),
    referencePaths: z.array(z.string()).min(1).max(20),
    prompt: z.string().min(1).max(40000),
  }),
  z.object({
    action: z.literal('derive-alpha'),
    baseGenerationId: z.string().min(1),
    matteId: z.string().min(1),
    expectedBaseWorkingHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedMatteWorkingHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    action: z.literal('auto-align'),
    generationId: z.string(),
  }),
  z.object({
    action: z.literal('align'),
    generationId: z.string(),
    points: z
      .array(
        z.object({
          source: z.tuple([z.number().finite(), z.number().finite()]),
          target: z.tuple([z.number().finite(), z.number().finite()]),
        }),
      )
      .min(2)
      .max(20),
    anchorNames: z.array(z.string()).min(2).max(20).optional(),
    observation: z.string().trim().min(1).max(3000),
  }),
  z.object({
    action: z.literal('review'),
    generationId: z.string(),
    review: layerReviewSchema,
    elements: z
      .array(
        z.object({
          name: z.string(),
          status: z.enum(['matched', 'different', 'missing']),
          observation: z.string().trim().min(1).max(3000),
        }),
      )
      .min(1)
      .max(100),
    comparisonHash: z.string().min(1),
    evidence: z
      .object({
        geometry: z.string().trim().min(12).max(3000),
        appearance: z.string().trim().min(12).max(3000),
        isolation: z.string().trim().min(12).max(3000),
        // IDs must resolve to actual registered candidates, not failed API calls.
        candidateIds: z.array(z.string()).min(1).max(3),
      })
      .optional(),
  }),
  z.object({ action: z.literal('status') }),
]);
export type GenerationAction = z.infer<typeof generationActionSchema>;
