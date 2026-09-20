import fs from 'node:fs';
import { readCutoutDefaults } from './cutout-settings.js';
import { DEFAULT_CUTOUT } from '../shared/cutout.js';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Document, Job } from './types.js';
export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA = path.resolve(process.env.LAYER_CANVAS_DATA || path.join(ROOT, 'data'));
fs.mkdirSync(DATA, { recursive: true });
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export function atomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + uid() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
export function json<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
export function validId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw Object.assign(new Error('无效 ID'), { status: 400 });
  return id;
}
export function dir(id: string) {
  return path.join(DATA, 'documents', validId(id));
}
export function load(id: string): Document {
  const d = json<Document | null>(path.join(dir(id), 'document.json'), null);
  if (!d) throw Object.assign(new Error('画布不存在'), { status: 404 });
  if (Number(d.settings.psdMode) === 1) d.settings.psdMode = 2;
  if (
    !['vectorizerCom', 'recraft', 'vectorizer302', 'vectorizer'].includes(d.settings.vectorEngine)
  ) {
    d.settings.vectorEngine = 'vectorizerCom';
  }
  delete (d.settings as Document['settings'] & { vectorOptions?: unknown }).vectorOptions;
  d.settings.cutoutOptions ??= structuredClone(DEFAULT_CUTOUT);
  return d;
}
export function save(d: Document) {
  d.updatedAt = now();
  atomic(path.join(dir(d.id), 'document.json'), d);
  return d;
}
export function getByTask(taskId: string) {
  if (!taskId || taskId.length > 200)
    throw Object.assign(new Error('必须提供当前 Codex 对话 ID'), { status: 400 });
  const id = crypto.createHash('sha256').update(taskId).digest('hex').slice(0, 32);
  try {
    return load(id);
  } catch (e: any) {
    if (e.status !== 404) throw e;
    return save({
      id,
      taskId,
      revision: 0,
      images: [],
      settings: { ...readCutoutDefaults(), vectorEngine: 'vectorizerCom', theme: 'dark' },
      layout: { layersWidth: 200, opinionsWidth: 320, editorHeight: 320 },
      updatedAt: now(),
    });
  }
}
export function assetDir(id: string) {
  const p = path.join(dir(id), 'assets');
  fs.mkdirSync(p, { recursive: true });
  return p;
}
export function assetPath(id: string, url: string) {
  const prefix = `/assets/${validId(id)}/`;
  if (!url.startsWith(prefix)) throw new Error('素材不属于此画布');
  const name = url.slice(prefix.length);
  if (!name || path.basename(name) !== name || name.includes('..') || name.includes('\\'))
    throw new Error('素材路径无效');
  return path.join(assetDir(id), name);
}
export function writeAsset(id: string, buffer: Buffer, ext: string) {
  const name = uid() + ext;
  fs.writeFileSync(path.join(assetDir(id), name), buffer);
  return `/assets/${id}/${name}`;
}
export function history(d: Document) {
  atomic(path.join(dir(d.id), 'history', `${d.revision}-${Date.now()}.json`), d);
}
export function jobs(): Job[] {
  return json<Job[]>(path.join(DATA, 'jobs.json'), []);
}
export function saveJob(job: Job) {
  const list = jobs();
  const i = list.findIndex((j) => j.id === job.id);
  if (i < 0) list.push(job);
  else list[i] = job;
  atomic(path.join(DATA, 'jobs.json'), list);
  return job;
}
export function getJob(id: string) {
  const j = jobs().find((j) => j.id === id);
  if (!j) throw Object.assign(new Error('任务不存在'), { status: 404 });
  return j;
}
export function safeJob(j: Job) {
  const { snapshot, ...rest } = j;
  return rest;
}
