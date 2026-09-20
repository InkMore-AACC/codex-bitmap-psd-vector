import { useState } from 'react';
import {
  DEFAULT_CUTOUT,
  PSD_MODES,
  cutoutDefaultsSchema,
  type CutoutOptions,
  type CutoutModel,
  type PsdMode,
} from '../shared/cutout';

const help: Record<string, string> = {
  resolution:
    '模型内部处理尺寸，不改变导出图片尺寸。增大可保留更多细节，但耗时与显存明显增加；减小更快，但细线可能丢失。BiRefNet 推荐 2048，Lucida v7 按 1024 训练；更大不保证更好。必须为 32 的倍数。',
  padding:
    '在 Codex 给出的物体框外增加原图上下文，单位：原图像素。增大可避免截断发丝、光晕，但可能带入邻近物体；减小更聚焦，过小可能裁掉效果。不会先用粗蒙版擦除像素。',
  feather:
    '轻微模糊透明度边缘，单位：原图像素。增大让边缘更柔和，但会模糊发丝和细节；减小更锐利。0 保留模型软透明度，建议先用 0。',
  offset:
    '沿边缘扩张或收缩透明度蒙版，单位：原图像素。正数扩张保留范围，可能带入背景；负数收缩去杂边，可能损失发丝和光晕。0 保留模型结果。',
  blackPoint:
    '透明点：低于此透明度的像素变为完全透明。增大能清除灰雾，但可能删除微弱光晕和烟雾；减小保留更多半透明细节，也可能留下背景。默认 0。',
  whitePoint:
    '不透明点：高于此透明度的像素变为完全不透明。减小可让发虚的实物更实，但可能破坏玻璃透明感；增大保留更多透明过渡。必须大于透明点，默认 1。',
  threads:
    'U2NetP 使用的 CPU 线程上限。增大可能加速，也会占用更多 CPU，过多不一定更快；减小更省资源但可能变慢。模型输入固定为 320×320，不提供无效的分辨率设置。',
  device:
    '自动：优先使用可用的 NVIDIA CUDA 显卡，否则使用 CPU。显卡通常更快；CPU 更通用但高分辨率较慢。指定 CUDA 而不可用时明确报错，不偷偷换模型。',
  precision:
    'FP32 全精度：兼容性与稳定性优先。FP16 半精度：CUDA 上通常更快、更省显存，但细微透明度可能有数值差异；CPU 使用 FP32。不是抠图质量等级。',
  decontaminate:
    '去除边缘残留的原背景颜色，改变前景 RGB，不改变透明度。开启适合换背景的发丝；关闭更保留原始色彩，适合彩色光晕、玻璃和特效。通用默认关闭，可按图片开启。',
};
const labels: Record<string, string> = {
  resolution: '处理分辨率',
  padding: '框外保留范围（px）',
  feather: '边缘柔化（px）',
  offset: '边缘扩缩（px）',
  blackPoint: '透明点（0–1）',
  whitePoint: '不透明点（0–1）',
  threads: 'CPU 线程上限',
};
const bounds: Record<string, [number, number, number]> = {
  resolution: [512, 3072, 32],
  padding: [0, 256, 1],
  feather: [0, 10, 0.1],
  offset: [-20, 20, 1],
  blackPoint: [0, 0.95, 0.01],
  whitePoint: [0.05, 1, 0.01],
  threads: [1, 16, 1],
};
export default function PsdSettings({
  mode,
  options,
  onSave,
}: {
  mode: PsdMode;
  options?: CutoutOptions;
  onSave: (mode: PsdMode, options: CutoutOptions) => Promise<void>;
}) {
  const [selected, setSelected] = useState(mode);
  const [draft, setDraft] = useState<CutoutOptions>(() =>
    structuredClone(options || DEFAULT_CUTOUT),
  );
  const [saving, setSaving] = useState(false),
    [message, setMessage] = useState('');
  const update = (model: CutoutModel, key: string, value: unknown) => {
    setDraft((v) => ({ ...v, [model]: { ...v[model], [key]: value } }));
    setMessage('尚未保存');
  };
  return (
    <div className="cutout-settings">
      <p className="settings-intro">
        先预分层、调整标注，再确认真实分层。粗抠与精抠只有预览清晰度不同；确认后只用干净原图与坐标意见由当前
        Codex 重建，抠图图片和蒙版不进入生图。
      </p>
      {PSD_MODES.map((m) => (
        <button
          key={m.id}
          className={`option-card ${selected === m.id ? 'selected' : ''}`}
          onClick={() => {
            setSelected(m.id);
            setMessage('尚未保存');
          }}
        >
          <span className="radio-dot" />
          <div>
            <b>{m.name}</b>
            <p>{m.detail}</p>
            <small>{m.cost}</small>
          </div>
        </button>
      ))}
      {(
        [
          ['birefnet', 'BiRefNet HR 精细抠图'],
          ['lucida', 'Lucida v7 精细抠图'],
          ['coarse', 'U2NetP 粗抠预览'],
        ] as const
      ).map(([model, name]) => (
        <details
          className="cutout-parameters"
          key={model}
          open={selected === (model === 'birefnet' ? 4 : model === 'lucida' ? 5 : 2)}
        >
          <summary>{name} · 参数设置</summary>
          <div className="parameter-grid">
            {Object.keys(labels)
              .filter((k) =>
                k === 'threads'
                  ? model === 'coarse'
                  : k === 'resolution'
                    ? model !== 'coarse'
                    : true,
              )
              .map((k) => (
                <label key={k} title={help[k]}>
                  {labels[k]} <span aria-hidden="true">ⓘ</span>
                  <input
                    aria-label={`${name} ${labels[k]}`}
                    title={help[k]}
                    type="number"
                    min={bounds[k][0]}
                    max={bounds[k][1]}
                    step={bounds[k][2]}
                    value={
                      Number.isFinite((draft[model] as any)[k]) ? (draft[model] as any)[k] : ''
                    }
                    onChange={(e) =>
                      update(model, k, e.target.value === '' ? NaN : Number(e.target.value))
                    }
                  />
                  <small>{help[k]}</small>
                </label>
              ))}
            {model !== 'coarse' && (
              <>
                {(['device', 'precision'] as const).map((k) => (
                  <label key={k} title={help[k]}>
                    {k === 'device' ? '运行设备' : '计算精度'} ⓘ
                    <select
                      aria-label={`${name} ${k === 'device' ? '运行设备' : '计算精度'}`}
                      title={help[k]}
                      value={draft[model][k]}
                      onChange={(e) => update(model, k, e.target.value)}
                    >
                      {(k === 'device'
                        ? [
                            ['auto', '自动（优先显卡）'],
                            ['cuda', 'NVIDIA 显卡'],
                            ['cpu', 'CPU'],
                          ]
                        : [
                            ['fp32', 'FP32 全精度'],
                            ['fp16', 'FP16 半精度'],
                          ]
                      ).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <small>{help[k]}</small>
                  </label>
                ))}
                <label className="cutout-check" title={help.decontaminate}>
                  <input
                    type="checkbox"
                    checked={draft[model].decontaminate}
                    aria-label={`${name} 去除边缘背景染色`}
                    onChange={(e) => update(model, 'decontaminate', e.target.checked)}
                  />
                  去除边缘背景染色 ⓘ<small>{help.decontaminate}</small>
                </label>
              </>
            )}
          </div>
          <button
            className="text-link"
            onClick={() => {
              setDraft((v) => ({ ...v, [model]: structuredClone(DEFAULT_CUTOUT[model]) }));
              setMessage('已恢复通用值，保存后生效');
            }}
          >
            恢复此模型通用值
          </button>
        </details>
      ))}
      <p className="settings-note">
        保存后用于当前画布的后续任务，并成为新对话画布的默认值。其他已有画布保留各自设置；已排队任务使用提交时的参数。模型之间的参数独立保存。
      </p>
      <div className="cutout-save">
        <button
          className="primary"
          disabled={saving}
          onClick={async () => {
            const parsed = cutoutDefaultsSchema.safeParse({
              psdMode: selected,
              cutoutOptions: draft,
            });
            if (!parsed.success) {
              setMessage('请检查参数范围：透明点必须小于不透明点，分辨率须为 32 的倍数。');
              return;
            }
            setSaving(true);
            try {
              await onSave(selected, draft);
              setMessage('已保存为默认');
            } catch (e) {
              setMessage(String(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? '保存中…' : '保存并设为默认'}
        </button>
        <span role="status">{message}</span>
      </div>
    </div>
  );
}
