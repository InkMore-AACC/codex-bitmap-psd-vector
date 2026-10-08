import path from 'node:path';
import { DATA, atomic, json } from './store.js';
import { DEFAULT_MATTING, standaloneMattingSchema } from '../shared/standalone-matting.js';
export function readMattingDefaults() {
  return standaloneMattingSchema.parse(
    json(path.join(DATA, 'matting-defaults.json'), DEFAULT_MATTING),
  );
}
export function saveMattingDefaults(input: unknown) {
  const settings = standaloneMattingSchema.parse(input);
  settings.options.birefnet.padding = settings.options.lucida.padding = 0;
  atomic(path.join(DATA, 'matting-defaults.json'), settings);
  return settings;
}
