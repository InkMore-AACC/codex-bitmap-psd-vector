import type { Annotation } from './types';

export type CanvasView = { x: number; y: number; scale: number };
type Position = { x: number; y: number };
type NodeBounds = Position & { width: number; height: number };

// Coordinates belong to the image, even when an arrow or its label sits outside it.
export function imagePoint(client: Position, bounds: { left: number; top: number }, view: CanvasView, image: Position): [number, number] {
  return [(client.x - bounds.left - view.x) / view.scale - image.x, (client.y - bounds.top - view.y) / view.scale - image.y];
}

export function labelPoint(mark: Annotation): [number, number] {
  if (mark.labelPosition) return mark.labelPosition;
  const index = mark.type === 'arrow' ? 0 : Math.max(0, mark.points.length - 2);
  return [mark.points[index] + 10, mark.points[index + 1] - 12];
}

export function connectionPath(parent: NodeBounds, child: NodeBounds): string {
  const right = child.x + child.width / 2 >= parent.x + parent.width / 2;
  const start = [right ? parent.x + parent.width : parent.x, parent.y + parent.height / 2];
  const end = [right ? child.x : child.x + child.width, child.y + child.height / 2];
  const bend = Math.max(80, Math.abs(end[0] - start[0]) * .45) * (right ? 1 : -1);
  return `M ${start[0]} ${start[1]} C ${start[0] + bend} ${start[1]}, ${end[0] - bend} ${end[1]}, ${end[0]} ${end[1]}`;
}
