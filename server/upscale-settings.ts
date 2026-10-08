import path from 'node:path';
import { DATA, atomic, json } from './store.js';
import { DEFAULT_UPSCALE, upscaleSchema } from '../shared/upscale.js';
export function readUpscaleDefaults() {
  return upscaleSchema.parse(json(path.join(DATA, 'upscale-defaults.json'), DEFAULT_UPSCALE));
}
export function saveUpscaleDefaults(input: unknown) {
  const value = upscaleSchema.parse(input);
  atomic(path.join(DATA, 'upscale-defaults.json'), value);
  return value;
}
