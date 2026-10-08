import { useState } from 'react';
import {
  DEFAULT_MATTING,
  standaloneMattingSchema,
  type StandaloneMatting,
} from '../shared/standalone-matting';
import { help, labels, bounds } from './cutoutParameters';

export default function MattingSettings({
  value,
  onSave,
}: {
  value?: StandaloneMatting;
  onSave: (value: StandaloneMatting) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => structuredClone(value || DEFAULT_MATTING));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const model = draft.model,
    options = draft.options[model];
  const update = (key: string, value: unknown) => {
    setDraft((d) => ({
      ...d,
      options: { ...d.options, [model]: { ...d.options[model], [key]: value } },
    }));
    setMessage('尚未保存');
  };
  return (
    <div className="cutout-settings">
      <p className="settings-intro">
        独立去背景，保留原画幅与主体位置，输出透明图片新节点。全程本地，不消耗 Codex
        额度，不会自动分层、重建或矢量化。
      </p>
      {(
        [
          ['birefnet', 'BiRefNet HR-matting'],
          ['lucida', 'Lucida v7'],
        ] as const
      ).map(([id, name]) => (
        <button
          key={id}
          className={`option-card ${model === id ? 'selected' : ''}`}
          onClick={() => {
            setDraft((d) => ({ ...d, model: id }));
            setMessage('尚未保存');
          }}
        >
          <span className="radio-dot" />
          <div>
            <b>{name}</b>
            <p>本地精细抠图 · 保留柔和透明边缘</p>
          </div>
        </button>
      ))}
      <div className="parameter-grid">
        {['resolution', 'feather', 'offset', 'blackPoint', 'whitePoint'].map((k) => (
          <label key={k} title={help[k]}>
            {labels[k]} ⓘ
            <input
              type="number"
              aria-label={`独立抠图 ${labels[k]}`}
              title={help[k]}
              min={bounds[k][0]}
              max={bounds[k][1]}
              step={bounds[k][2]}
              value={Number.isFinite((options as any)[k]) ? (options as any)[k] : ''}
              onChange={(e) => update(k, e.target.value === '' ? NaN : Number(e.target.value))}
            />
            <small>{help[k]}</small>
          </label>
        ))}
        {(['device', 'precision'] as const).map((k) => (
          <label key={k} title={help[k]}>
            {k === 'device' ? '运行设备' : '计算精度'} ⓘ
            <select
              aria-label={`独立抠图 ${k === 'device' ? '运行设备' : '计算精度'}`}
              value={options[k]}
              title={help[k]}
              onChange={(e) => update(k, e.target.value)}
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
              ).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <small>{help[k]}</small>
          </label>
        ))}
        <label className="cutout-check" title={help.decontaminate}>
          <input
            type="checkbox"
            aria-label="独立抠图 去除边缘背景染色"
            checked={options.decontaminate}
            onChange={(e) => update('decontaminate', e.target.checked)}
          />
          去除边缘背景染色 ⓘ<small>{help.decontaminate}</small>
        </label>
      </div>
      <button
        className="text-link"
        onClick={() => {
          setDraft((d) => ({
            ...d,
            options: { ...d.options, [model]: structuredClone(DEFAULT_MATTING.options[model]) },
          }));
          setMessage('已恢复效果优先默认值，保存后生效');
        }}
      >
        恢复此模型默认值
      </button>
      <p className="settings-note">
        默认使用
        FP32，保留软透明度，不额外羽化或收缩边缘。分辨率更高不保证更好。保存仅影响独立抠图，成为当前画布后续任务与新画布的默认；不更改分层预览设置。
      </p>
      <div className="cutout-save">
        <button
          className="primary"
          disabled={saving}
          onClick={async () => {
            const parsed = standaloneMattingSchema.safeParse(draft);
            if (!parsed.success) {
              setMessage('请检查参数范围：透明点须小于不透明点，分辨率须为32的倍数。');
              return;
            }
            setSaving(true);
            try {
              await onSave(parsed.data);
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
