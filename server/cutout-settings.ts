import path from 'node:path';
import { DATA, atomic, json } from './store.js';
import { cutoutDefaultsSchema, DEFAULT_CUTOUT } from '../shared/cutout.js';
// Existing canvases keep their own choices; only new canvases inherit these defaults.
export function readCutoutDefaults() {
  return cutoutDefaultsSchema.parse(
    json(path.join(DATA, 'cutout-defaults.json'), { psdMode: 4, cutoutOptions: DEFAULT_CUTOUT }),
  );
}
export function saveCutoutDefaults(input: unknown) {
  const value = cutoutDefaultsSchema.parse(input);
  atomic(path.join(DATA, 'cutout-defaults.json'), value);
  return value;
}
