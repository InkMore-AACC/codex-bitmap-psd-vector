import { z } from 'zod';

/** Visual judgement is made by the current agent, not inferred from image dimensions. */
export const layerReviewSchema = z
  .object({
    status: z.enum(['accepted', 'needs-revision']),
    attempts: z
      .array(
        z.object({
          method: z.string().trim().min(1).max(1000),
          observation: z.string().trim().min(1).max(2000),
        }),
      )
      .min(1)
      .max(3),
    issues: z
      .array(
        z.object({
          message: z.string().trim().min(1).max(2000),
          box: z
            .tuple([
              z.number().finite().min(-100000).max(100000),
              z.number().finite().min(-100000).max(100000),
              z.number().finite().positive().max(30000),
              z.number().finite().positive().max(30000),
            ])
            .optional(),
        }),
      )
      .max(10)
      .default([]),
  })
  .superRefine((review, ctx) => {
    if (review.status === 'accepted' && review.issues.length)
      ctx.addIssue({ code: 'custom', message: '通过检查的图层不能同时携带未解决问题' });
    if (
      review.status === 'needs-revision' &&
      !review.issues.length
    )
      ctx.addIssue({
        code: 'custom',
        message: '标红须至少记录一次真实已检查尝试，并说明未解决问题；不强制追加尝试',
      });
  });
export type LayerReview = z.infer<typeof layerReviewSchema>;

export const RECONSTRUCTION_REVIEW_POLICY = {
  maxAttemptsPerLayer: 3,
  retryBeforeMarking: false,
  visualThreshold:
    '以放回整图后是否明显影响效果为准；轻微纹理、发丝、边缘和位置差异可接受。不设1%的视觉漂移阈值。重点检查文字错误、缺失物体、明显变形、比例错位、遮挡与接缝。',
  instructions:
    '每层先真实生成并检查；已确认失败可立即回传review.status=needs-revision，至少记录一次真实已检查尝试及未解决issues（box为最终图片局部像素，可省略）。最多三次是上限，不要求为凑次数追加制作或不同方法；API报错不算真实已检查尝试。保留真实原件和候选，不重复相同提示词盲试。遇到系统性原因应先修改、替换或删除导致失效的插件实现及循环规则；下一轮插件验证必须用新的复杂图针对前轮失败，旧图仅补充回归。继续下一层，不调用fail中止整单。可接受结果回传accepted且不得同时有未解决issues。全部完成后检查合成再提交各层review；服务添加红色自动标注并将问题层设为重建、通过层设为保留。不得假称存在自动数值视觉评分。缺文件/损坏文件不能伪造结果：继续其他层并暂存，最终如实报告缺失。文件比例、真实候选和摘要校验独立，不以视觉标红绕过无效文件检查。',
} as const;
