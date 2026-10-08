import path from 'node:path';
import { DATA, atomic, json } from './store.js';
import { photoshopSettingsSchema } from '../shared/photoshop.js';
export const readPhotoshopDefaults = () =>
  photoshopSettingsSchema.parse(json(path.join(DATA, 'photoshop-defaults.json'), {}));
export function savePhotoshopDefaults(input: unknown) {
  const value = photoshopSettingsSchema.parse(input);
  atomic(path.join(DATA, 'photoshop-defaults.json'), value);
  return value;
}
