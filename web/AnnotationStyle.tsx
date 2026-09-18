import type { Annotation } from './types';

export type MarkStyle = Pick<Annotation, 'color' | 'strokeWidth' | 'brushSize' | 'fontWeight' | 'fontSize' | 'opacity'>;
export const defaultStyle = (type: Annotation['type']): MarkStyle => ({ color: '#c4a0ff', strokeWidth: type === 'arrow' ? 3 : 2, brushSize: 24, opacity: .42, fontWeight: 400, fontSize: 12 });

export default function AnnotationStyle({ type, value, onChange, prefix }: { type: Annotation['type']; value: MarkStyle; onChange: (patch: Partial<MarkStyle>) => void; prefix: string }) {
  const text = type === 'text', pen = type === 'pen';
  const key = text ? 'fontWeight' : pen ? 'brushSize' : 'strokeWidth';
  const width = value[key] ?? (text ? 400 : pen ? 24 : type === 'arrow' ? 3 : 2);
  const hint = text ? '文字笔画粗细：调大更粗，调小更细；可用字重取决于字体。' : pen ? '涂抹宽度，以原图像素计算。调大会扩大实际选区，调小适合细节；缩放画布时一起缩放。' : '标注线宽，以屏幕像素显示。调大更醒目，调小更精细；不改变圈选或框选的范围。';
  return <div className="annotation-style">
    <label title="标注与说明文字的显示颜色；不会修改原图或改变选区含义。">颜色<input type="color" aria-label={`${prefix}颜色`} value={/^#[0-9a-f]{6}$/i.test(value.color) ? value.color : '#c4a0ff'} onChange={e => onChange({ color: e.target.value })}/></label>
    <label title={hint}>{text ? '字重' : pen ? '笔刷' : '粗细'}<input type="range" aria-label={`${prefix}${text ? '字重' : pen ? '笔刷大小' : '粗细'}`} min={text ? 100 : 1} max={text ? 900 : pen ? 2000 : 20} step={text ? 100 : 1} value={width} onChange={e => onChange({ [key]: Number(e.target.value) })}/><output>{width}{text ? '' : ' px'}</output></label>
    {pen && <label title="仅控制涂抹标记的显示透明度；调大更透明，调小更醒目，不改变交给 Codex 的选区范围。">透明度<input type="range" aria-label={`${prefix}透明度`} min={0} max={100} step={1} value={Math.round((1-(value.opacity ?? .42))*100)} onChange={e=>onChange({opacity:1-Number(e.target.value)/100})}/><output>{Math.round((1-(value.opacity ?? .42))*100)}%</output></label>}
    {text && <label title="文字的屏幕字号；调大更易读，调小更节省空间，不受画布缩放影响。">字号<input type="number" aria-label={`${prefix}字号`} min={8} max={72} value={value.fontSize ?? 12} onChange={e => { if (e.target.value) onChange({ fontSize: Math.max(8, Math.min(72, Number(e.target.value))) }); }}/></label>}
  </div>;
}
