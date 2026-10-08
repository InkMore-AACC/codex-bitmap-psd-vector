import type { CanvasImage, Layer } from './types.js';
import { uid } from './store.js';
import { layerFrame } from '../shared/layer-frame.js';

/** Apply review only to returned layers on the new result; never overwrite user annotations. */
export function applyLayerReviews(image: CanvasImage, returned: Layer[], before: CanvasImage) {
  const targetIds = new Set(returned.map((l) => l.id));
  for (const layer of image.layers) {
    if (!targetIds.has(layer.id)) continue;
    const reviewed = !!layer.review;
    if (reviewed)
      image.annotations = image.annotations.filter(
        (a) => !(a.origin === 'auto-review' && a.layerId === layer.id),
      );
    const sources = before.layers.filter((l) =>
      (layer.sourceLayerIds || [layer.id]).includes(l.id),
    );
    const oldReports = reviewed
      ? (sources.map((l) => l.autoReviewOpinion).filter(Boolean) as string[])
      : [];
    const opinions = [...sources.map((l) => l.opinion), layer.opinion]
      .map((s) => oldReports.reduce((text, report) => text.replace(report, ''), s).trim())
      .filter(Boolean);
    layer.opinion = opinions.reduce(
      (text, next) =>
        !text || next.includes(text) ? next : text.includes(next) ? text : `${text}\n${next}`,
      '',
    );
    layer.autoReviewOpinion = reviewed ? undefined : sources[0]?.autoReviewOpinion;
    layer.disposition = layer.review?.status === 'accepted' ? 'keep' : 'rebuild';
    if (layer.review?.status !== 'needs-revision') continue;
    const notes = layer.review.issues.map((i) => `自动检查：${i.message}`);
    const history = layer.review.attempts
      .map((a, i) => `${i + 1}. ${a.method}：${a.observation}`)
      .join('\n');
    const report = `${notes.join('\n')}\n已尝试（已选取最好的一版）：\n${history}`;
    layer.autoReviewOpinion = report;
    if (!layer.opinion.includes(report)) layer.opinion += `${layer.opinion ? '\n\n' : ''}${report}`;
    for (const issue of layer.review.issues) {
      const f = layerFrame(layer, image);
      const [x, y, width, height] = issue.box || [f.x, f.y, f.width, f.height];
      image.annotations.push({
        id: uid(),
        layerId: layer.id,
        origin: 'auto-review',
        type: 'box',
        points: [x, y, x + width, y + height],
        text: `自动检查 · 待修改：${issue.message}`,
        color: '#ff3b30',
        strokeWidth: 3,
        opacity: 1,
      });
    }
  }
  const pending = image.layers.filter((l) => l.review?.status === 'needs-revision').length;
  const unreviewed = image.layers.filter((l) => targetIds.has(l.id) && !l.review).length;
  return { pending, unreviewed };
}
