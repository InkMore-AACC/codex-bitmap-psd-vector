import { z } from 'zod';

export const frameSchema = z
  .object({
    x: z.number().int().min(-100000).max(100000),
    y: z.number().int().min(-100000).max(100000),
    width: z.number().int().min(1).max(30000),
    height: z.number().int().min(1).max(30000),
  })
  .refine((f) => f.width * f.height <= 64_000_000, '图层画幅最多 6400 万像素');
export type LayerFrame = z.infer<typeof frameSchema>;
export type FrameHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' | 'move';
type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  frame?: LayerFrame;
  role?: string;
};

export function suggestedFrame(
  layer: Bounds,
  image: { width: number; height: number },
): LayerFrame {
  if (layer.role === 'background')
    return { x: 0, y: 0, width: Math.round(image.width), height: Math.round(image.height) };
  // Preview bitmaps already contain the model's context padding. Never infer bounds from alpha.
  const x = Math.floor(layer.x),
    y = Math.floor(layer.y);
  return {
    x,
    y,
    width: Math.max(1, Math.ceil(layer.x + layer.width) - x),
    height: Math.max(1, Math.ceil(layer.y + layer.height) - y),
  };
}
export function layerFrame(layer: Bounds, image: { width: number; height: number }): LayerFrame {
  return layer.frame ? { ...layer.frame } : suggestedFrame(layer, image);
}
export function unionFrames(frames: LayerFrame[]): LayerFrame {
  const x = Math.min(...frames.map((f) => f.x)),
    y = Math.min(...frames.map((f) => f.y));
  return frameSchema.parse({
    x,
    y,
    width: Math.max(...frames.map((f) => f.x + f.width)) - x,
    height: Math.max(...frames.map((f) => f.y + f.height)) - y,
  });
}
export function scaledFrame(f: LayerFrame, sx: number, sy: number): LayerFrame {
  const x = Math.round(f.x * sx),
    y = Math.round(f.y * sy);
  return frameSchema.parse({
    x,
    y,
    width: Math.max(1, Math.round((f.x + f.width) * sx) - x),
    height: Math.max(1, Math.round((f.y + f.height) * sy) - y),
  });
}
export function resizeFrame(
  start: LayerFrame,
  handle: FrameHandle,
  dx: number,
  dy: number,
): LayerFrame {
  const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
  dx = Math.round(dx);
  dy = Math.round(dy);
  if (handle === 'move')
    return {
      ...start,
      x: clamp(start.x + dx, -100000, 100000),
      y: clamp(start.y + dy, -100000, 100000),
    };
  let left = start.x,
    top = start.y,
    right = start.x + start.width,
    bottom = start.y + start.height;
  if (handle.includes('w'))
    left = clamp(left + dx, Math.max(-100000, right - 30000), Math.min(100000, right - 1));
  if (handle.includes('e')) right = clamp(right + dx, left + 1, left + 30000);
  if (handle.includes('n'))
    top = clamp(top + dy, Math.max(-100000, bottom - 30000), Math.min(100000, bottom - 1));
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + 1, top + 30000);
  const frame = { x: left, y: top, width: right - left, height: bottom - top };
  return frameSchema.safeParse(frame).success ? frame : start;
}
