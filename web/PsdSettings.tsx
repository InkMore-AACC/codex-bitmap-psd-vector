import { useState } from 'react';
import {
  DEFAULT_CUTOUT,
  PSD_MODES,
  cutoutDefaultsSchema,
  type CutoutOptions,
  type CutoutModel,
  type PsdMode,
} from '../shared/cutout';

import { help, labels, bounds } from './cutoutParameters';
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
