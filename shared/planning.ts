import type { PlanningLayer } from './canvas.js';
import type { LayerFrame } from './layer-frame.js';

export function planningLayer(
  id: string,
  name: string,
  frame: LayerFrame,
  role: 'foreground' | 'background' = 'foreground',
  opinion = '',
): PlanningLayer {
  return {
    id,
    name,
    kind: 'plan',
    preview: true,
    frame: { ...frame },
    ...frame,
    role,
    visible: true,
    opacity: 1,
    opinion,
    disposition: 'rebuild',
  };
}
