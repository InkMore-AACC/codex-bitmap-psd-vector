import { generationPlan } from '../shared/generation-geometry';
import type { LayerFrame } from '../shared/layer-frame';
export function GenerationHint({ frame }: { frame: LayerFrame }) {
  const plan = generationPlan(frame);
  return (
    <small className="generation-hint" role="note">
      {plan.exceedsBudget && (
        <span className="generation-warning">
          画幅超过155万像素：生成时将等比例缩小，完成后放大回原画幅，清晰度可能降低。
          <br />
        </span>
      )}
      预计生成 {plan.size.width} × {plan.size.height}
      {plan.exceedsBudget ? ` · 预计放大 ${plan.restoreScale.toFixed(2)}×` : ''} ·
      实际返回后重新核算
    </small>
  );
}
