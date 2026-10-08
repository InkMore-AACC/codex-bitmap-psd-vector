import { useEffect, useState, useRef } from 'react';
import { api } from './api';
import type { CanvasImage } from '../shared/canvas';
import {
  DEFAULT_UPSCALE,
  upscaleSchema,
  upscaleDimensions,
  type UpscaleSettings as Options,
} from '../shared/upscale';

const help: Record<keyof Options, string> = {
  model: '固定使用本地 SeedVR2 7B 标准版 INT8 ConvRot，不消耗 Codex 额度。',
  scale: '宽高各放大2倍或4倍，总像素增加到4倍或16倍。4倍更耗时和显存，不保证恢复真实丢失细节。',
  seedColor: 'Lab推荐设计稿；小波校正低频颜色；整体匹配调整均值和对比度；关闭保留模型色彩。',
  seedDetail:
    '超分结果与原图等比放大的混合比例。降低可缓和假纹理，但细节变弱；100%为模型完整效果。不是采样强度。',
  seedVaeTile:
    '编解码块边长，以输出像素计。增大更占显存、块数减少；减小省显存但更依赖重叠融合，不代表更清晰。',
  seedVaeOverlap:
    '块边缘共同计算的像素宽度。增加可减轻接缝但更慢；减少较快但接缝风险增加。不得超过块边长的1/4。',
  seedMemory: '标准适合24GB显卡；省显存更积极卸载模型，可能更慢。不更换权重或降低输出分辨率。',
  seed: '固定便于比较参数。改变数值会改变生成细节，数值大小不代表质量高低。',
  videoFrames:
    '每次联合处理的连续帧数。增加提供更长时间上下文但显存明显上升；减少省显存但分段增多。默认9，显存不足选5。不是分帧独立超分。',
  videoOverlap:
    '前后时间段共同处理的帧数，按同一时间戳融合。增加可缓和段间变化，但重复计算更多；减少更快。必须小于连续处理帧数，不增加或删除帧。',
  videoQuality:
    'MP4编码质量（CRF）。数值越小压缩越少、文件越大；越大文件越小但细节损失增加。只影响输出编码，不影响模型推理。默认18。',
};

export default function UpscaleSettings({
  value,
  image,
  onSave,
}: {
  value?: Options;
  image?: Pick<CanvasImage, 'width' | 'height' | 'status' | 'layers'>;
  onSave: (v: Options) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => ({ ...DEFAULT_UPSCALE, ...value }));
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('正在检查模型…');

  const statusRequest = useRef(0);
  const refresh = () => {
    const request = ++statusRequest.current;
    setStatus('正在检查模型…');
    return api<{ message: string }>('/api/upscale-status?model=' + draft.model)
      .then((v) => {
        if (request === statusRequest.current) setStatus(v.message);
      })
      .catch((e) => {
        if (request === statusRequest.current) setStatus(String(e));
      });
  };
  useEffect(() => {
    void refresh();
    return () => {
      statusRequest.current++;
    };
  }, [draft.model]);
  function update(k: keyof Options, v: string | number) {
    setDraft((d) => {
      const next = { ...d, [k]: v };
      if (k === 'seedVaeTile') next.seedVaeOverlap = Math.min(Number(v) / 4, d.seedVaeOverlap);
      if (k === 'videoFrames' && next.videoOverlap >= Number(v))
        next.videoOverlap = Number(v) === 5 ? 1 : 5;
      return next;
    });
    setMessage('尚未保存');
  }
  function select(k: keyof Options, label: string, items: [string | number, string][]) {
    return (
      <label title={help[k]}>
        {label} ⓘ
        <select
          aria-label={`超分 ${label}`}
          title={help[k]}
          value={draft[k]}
          onChange={(e) =>
            update(k, typeof draft[k] === 'number' ? Number(e.target.value) : e.target.value)
          }
        >
          {items.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
        <small>{help[k]}</small>
      </label>
    );
  }
  function number(k: 'seed' | 'seedVaeOverlap', label: string) {
    return (
      <label title={help[k]}>
        {label} ⓘ
        <input
          type="number"
          aria-label={`超分 ${label}`}
          title={help[k]}
          min={k === 'seed' ? 0 : 32}
          max={k === 'seed' ? 4294967295 : draft.seedVaeTile / 4}
          step={k === 'seed' ? 1 : 32}
          value={Number.isFinite(draft[k]) ? draft[k] : ''}
          onChange={(e) => update(k, e.target.value === '' ? NaN : Number(e.target.value))}
        />
        <small>{help[k]}</small>
      </label>
    );
  }
  let output = '先在画布选择一张图片';
  if (image) {
    try {
      const s = upscaleDimensions(image.width, image.height, draft);
      output = `${image.width} × ${image.height} → ${s.width} × ${s.height} 像素`;
    } catch (e) {
      output = (e as Error).message;
    }
  }
  return (
    <div className="cutout-settings">
      <p className="settings-intro">
        本地超分 · 不消耗 Codex 额度。正式分层节点逐层超分并保留分层
        PSD；单张图片独立超分；视频按连续帧超分并保留音轨。完成后创建关联新节点，不覆盖来源。需要
        NVIDIA CUDA 显卡。
      </p>
      {select('model', '超分模型', [['seedvr2-7b-int8', 'SeedVR2 · 7B 标准版 INT8']])}
      <p role="status">
        {status}{' '}
        <button className="text-link" onClick={refresh}>
          重新检查
        </button>
      </p>
      <div className="parameter-grid">
        {select('scale', '放大倍率', [
          [2, '2倍（推荐）'],
          [4, '4倍'],
        ])}
        {select('seedColor', '颜色保持', [
          ['lab', 'Lab 保色（推荐）'],
          ['wavelet', '小波保色'],
          ['adain', '整体色彩匹配'],
          ['none', '关闭'],
        ])}
        <label title={help.seedDetail}>
          超分结果混合比例 ⓘ
          <input
            aria-label="超分 结果混合比例"
            title={help.seedDetail}
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={draft.seedDetail}
            onChange={(e) => update('seedDetail', Number(e.target.value))}
          />
          <span>{Math.round(draft.seedDetail * 100)}%</span>
          <small>{help.seedDetail}</small>
        </label>
      </div>
      <p className="settings-note">
        {output}
        。透明度单独等比放大，宽高比和相对位置不变。模型会重建位图细节，文字、标志、人脸需与原图对比检查。
      </p>
      <p className="settings-note">
        分层节点会处理全部位图层（含隐藏层），同步缩放坐标、画幅和标注；可编辑文字保留文字信息，不交给模型重画。预分层使用干净输入，矢量节点输出位图。独立蒙版、特殊混合、智能对象等暂不支持的
        PSD 结构会明确报错，不悄悄合并或丢弃。
      </p>
      <details open>
        <summary>视频设置</summary>
        <div className="parameter-grid">
          {select('videoFrames', '连续处理帧数', [
            [5, '5（省显存）'],
            [9, '9（推荐）'],
            [17, '17（高显存）'],
          ])}
          {select(
            'videoOverlap',
            '时间段重叠',
            ([1, 5, 9] as const).filter((v) => v < draft.videoFrames).map((v) => [v, `${v} 帧`]),
          )}
          {select('videoQuality', '视频编码质量', [
            [16, '16（大文件）'],
            [18, '18（推荐）'],
            [23, '23（小文件）'],
          ])}
        </div>
        <p className="settings-note">
          支持 MP4 / MOV / MKV / WebM / AVI，单文件2GB、10分钟以内、8位 SDR。导出 MP4（H.264 +
          AAC），保留帧数、时间戳和音轨，不补帧；有声视频会重新编码音频。HDR、高位深及透明视频暂不支持。视频比图片更耗显存与时间，分段交界和细节仍需预览检查。
        </p>
      </details>
      <details>
        <summary>高级设置：分块、显存与随机种子</summary>
        <div className="parameter-grid">
          {select('seedVaeTile', '编解码分块', [
            [256, '256（省显存）'],
            [512, '512（推荐）'],
            [1024, '1024'],
          ])}
          {number('seedVaeOverlap', '编解码重叠')}
          {select('seedMemory', '显存模式', [
            ['normal', '标准'],
            ['low', '省显存'],
          ])}
          {number('seed', '随机种子')}
        </div>
      </details>
      <p className="settings-note">
        显存不足时会有限次减小工作分块重试，并在任务结果中说明；不降低输出倍率。输出限制为4000万像素、单边16384像素，与
        Codex 生图尺寸限制无关。
      </p>
      <div className="cutout-save">
        <button
          className="primary"
          disabled={saving}
          onClick={async () => {
            const parsed = upscaleSchema.safeParse(draft);
            if (!parsed.success) {
              setMessage(parsed.error.issues.map((i) => i.message).join('；'));
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
        <button
          className="text-link"
          onClick={() => {
            setDraft({ ...DEFAULT_UPSCALE, model: draft.model });
            setMessage('已恢复通用值，保存后生效');
          }}
        >
          恢复通用默认值
        </button>
        <span role="status">{message}</span>
      </div>
      <p className="settings-note">
        保存影响当前画布后续任务和新画布；不修改正在执行的任务或其他已有画布。
        <a href={'https://github.com/ByteDance-Seed/SeedVR'} target="_blank" rel="noreferrer">
          模型与技术来源
        </a>
      </p>
    </div>
  );
}
