import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generationAnnotations } from '../shared/generation-annotations.js';
import { generationCarrier } from '../shared/generation-geometry.js';
import type { Annotation } from '../shared/canvas.js';

test('generation marks project resized image coordinates through padded budget carrier without clipping or UI-style contamination', () => {
  const marks: Annotation[] = [
    {
      id: 'arrow',
      layerId: 'layer',
      type: 'arrow',
      points: [-80, 25, 225, 350],
      text: '保持这里的耳环',
      color: '#ff0000',
      strokeWidth: 18,
      labelPosition: [-200, 0],
    },
    {
      id: 'paint',
      layerId: 'layer',
      type: 'pen',
      points: [220, 330, 250, 360],
      text: '只补此处遮挡',
      color: '#00ff00',
      brushSize: 20,
      opacity: 0.4,
    },
  ];
  const frozen = JSON.stringify(marks);
  const carrier = generationCarrier({ x: 200, y: 500, width: 3000, height: 300 });
  assert(carrier.expanded && carrier.exceedsBudget);
  const result = generationAnnotations(
    marks,
    { width: 1000, height: 800 },
    { width: 2000, height: 1600 },
    carrier,
  );
  const point = (x: number, y: number) => [
    Math.round(((x * 2 - carrier.frame.x) * carrier.scale + carrier.offsetX) * 1000) / 1000,
    Math.round(((y * 2 - carrier.frame.y) * carrier.scale + carrier.offsetY) * 1000) / 1000,
  ];
  assert.deepEqual(result.marks[0].target, point(225, 350));
  assert.deepEqual(result.marks[0].points.slice(0, 2), point(-80, 25));
  assert(result.marks[0].points[0] < 0);
  assert.equal(result.marks[1].brushSize, Math.round(40 * carrier.scale * 1000) / 1000);
  assert.equal(result.coordinateSpace, 'generation-file-pixels');
  assert.deepEqual(result.fileSize, carrier.size);
  assert.equal(JSON.stringify(marks), frozen);
  assert(!JSON.stringify(result).includes('#ff0000'));
  assert(!JSON.stringify(result).includes('labelPosition'));
});
