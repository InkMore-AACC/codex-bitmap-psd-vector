import type { Annotation } from './canvas.js';
import type { generationCarrier } from './generation-geometry.js';

/** Prompt-only projection. Frozen marks remain in image pixels, including
 * off-image labels. Marker styles are UI decoration, not artwork instructions. */
export function generationAnnotations(
  marks: Annotation[],
  input: { width: number; height: number },
  canvas: { width: number; height: number },
  carrier: ReturnType<typeof generationCarrier>,
) {
  const sx = canvas.width / input.width;
  const sy = canvas.height / input.height;
  const project = (points: number[]) =>
    points.map((value, i) => {
      const local =
        i % 2
          ? (value * sy - carrier.frame.y) * carrier.scale + carrier.offsetY
          : (value * sx - carrier.frame.x) * carrier.scale + carrier.offsetX;
      return Math.round(local * 1000) / 1000;
    });
  return {
    coordinateSpace: 'generation-file-pixels' as const,
    fileSize: carrier.size,
    marks: marks.map((mark) => {
      const points = project(mark.points);
      return {
        id: mark.id,
        layerId: mark.layerId,
        type: mark.type,
        points,
        target: mark.type === 'arrow' ? points.slice(-2) : undefined,
        instruction: mark.text,
        brushSize:
          mark.type === 'pen'
            ? Math.round((mark.brushSize || 12) * sx * carrier.scale * 1000) / 1000
            : undefined,
      };
    }),
  };
}
