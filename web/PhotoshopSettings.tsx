import { useState } from 'react';
import {
  DEFAULT_PHOTOSHOP,
  photoshopSettingsSchema,
  type PhotoshopSettings as Settings,
} from '../shared/photoshop';
export default function PhotoshopSettings({
  value,
  onSave,
}: {
  value?: Settings;
  onSave: (s: Settings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value || DEFAULT_PHOTOSHOP),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <section className="ps-rebuild-settings">
      <h4>PS 重建</h4>
      <p className="settings-intro">
        按建议图层逐层重建。位图默认生成透明物体并补全背景，再交给 PS
        合成；文字和形状优先原生重建并匹配外观。与原图一致性优先。
      </p>
      <label title="可选路线：沿物体轮廓准确提取，其他区域透明，再补全遮挡。位图默认仍使用生图；按框裁切、模糊背景、预分层粗抠或精抠像素都不能作为完成素材。关闭后需生成或使用PS原生工具重建。">
        <input
          type="checkbox"
          checked={draft.allowExtraction}
          onChange={(e) => setDraft({ ...draft, allowExtraction: e.target.checked })}
        />
        允许从原图准确提取元素
      </label>
      <label title="先把原素材放入PS确认位置、外观和遮挡，通过后才用本地SeedVR2补足像素，并再次置入检查。无需另建画布任务；保留原始版本，超分改变细节时可退回等比缩放。文字与形状不参与位图超分。">
        <input
          type="checkbox"
          checked={draft.autoUpscale}
          onChange={(e) => setDraft({ ...draft, autoUpscale: e.target.checked })}
        />
        位图像素不足时自动超分
      </label>
      <label title="包含首轮制作。更多尝试可能提高一致性，但增加时间与Codex额度；达到次数仍有明显问题时标红并继续其他层。">
        每层最多尝试{' '}
        <select
          value={draft.maxAttempts}
          onChange={(e) => setDraft({ ...draft, maxAttempts: Number(e.target.value) })}
        >
          <option value={2}>2 次</option>
          <option value={3}>3 次（推荐）</option>
        </select>
      </label>
      <p title="普通重建与PS重建统一使用150万像素预算，包含透明留白。原始返回文件会单独保存；若超过预算，先等比生成工作副本，再按最终图层画幅计算倍率和位置。该预算不能强制控制上游模型实际输出尺寸。">
        生图预算：150 万像素（固定）
      </p>
      <small>
        超分沿用“超分”页的 SeedVR2 参数。PS／生图操作消耗 Codex 额度，本地超分不消耗额度。
      </small>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onSave(photoshopSettingsSchema.parse(draft));
            setMessage('已保存为当前画布和新画布的默认设置');
          } catch (e) {
            setMessage(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        保存 PS 重建设置
      </button>
      <small>{message}</small>
    </section>
  );
}
