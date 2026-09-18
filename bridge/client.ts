import { readFile, mkdir, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Service = { port: number; token: string; bridgeToken?: string; root?: string; pid?: number };
export type Job = { id: string; taskId: string; documentId: string; status: string; type: string; [key: string]: unknown };
const root = process.env.LAYER_CANVAS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = process.env.LAYER_CANVAS_DATA || path.join(root, 'data');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let starting: Promise<Service> | undefined;

async function readService(): Promise<Service | undefined> {
  try {
    const info = JSON.parse(await readFile(path.join(data, 'service.json'), 'utf8')) as Service;
    if (!Number.isInteger(info.port) || info.port < 1024 || info.port > 65535 || typeof info.token !== 'string' || info.token.length < 16) return;
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(1200) });
    if (response.ok && (await response.json() as { name?: string }).name === 'layer-canvas') return info;
  } catch { /* stale service metadata is common after shutdown */ }
}

export async function ensureService(): Promise<Service> {
  const current = await readService();
  if (current) return current;
  if (!starting) starting = (async () => {
    await mkdir(data, { recursive: true });
    const log = await open(path.join(data, 'service.log'), 'a');
    try {
      const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'server', 'index.ts')], {
        cwd: root, detached: true, windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, LAYER_CANVAS_DATA: data },
      });
      let launchError: Error | undefined;
      child.once('error', error => { launchError = error; });
      child.unref();
      for (let i = 0; i < 40; i++) {
        await pause(250);
        if (launchError) throw launchError;
        const service = await readService();
        if (service) return service;
      }
      throw new Error(`画布本地服务未能启动，请查看 ${path.join(data, 'service.log')}`);
    } finally { await log.close(); }
  })().finally(() => { starting = undefined; });
  return starting;
}

export function validateTask(taskId: string, currentTask = process.env.CODEX_THREAD_ID): string {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(taskId)) throw new Error('必须使用当前真实 Codex 任务 ID，不得使用名称或虚构 ID。');
  if (currentTask && taskId !== currentTask) throw new Error('此工具只允许操作当前 Codex 对话绑定的画布。');
  return taskId;
}

export class CanvasClient {
  constructor(private serviceProvider: () => Promise<Service> = ensureService) {}
  async request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    const service = await this.serviceProvider();
    const response = await fetch(`http://127.0.0.1:${service.port}${route}`, {
      method, headers: { 'X-Canvas-Token': service.token, ...(service.bridgeToken ? { 'X-Canvas-Bridge': service.bridgeToken } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300_000),
    });
    const text = await response.text();
    let value: any;
    try { value = JSON.parse(text); } catch { throw new Error(`画布服务返回非 JSON 响应 (${response.status})`); }
    if (!response.ok) throw new Error(`画布请求失败 (${response.status}): ${value.error || value.message || '未知错误'}`);
    return value as T;
  }
  async document(taskId: string): Promise<any> {
    validateTask(taskId);
    const doc = await this.request<any>(`/api/document?taskId=${encodeURIComponent(taskId)}`);
    if (doc.taskId !== taskId) throw new Error('服务返回了其他任务的画布，已停止。');
    return doc;
  }
  async open(taskId: string): Promise<unknown> {
    const doc = await this.document(taskId);
    const service = await this.serviceProvider();
    const dispatch = await this.request('/api/dispatch/connect', 'POST', {taskId, pipePath:process.env.CODEX_APP_TOOLS_PIPE_PATH});
    return {
      documentId: doc.id, taskId,
      url: `http://127.0.0.1:${service.port}/?taskId=${encodeURIComponent(taskId)}#token=${encodeURIComponent(service.token)}`,
      next: '用 open_in_codex 在当前任务右侧打开此网址。',
      dispatch,
    };
  }
  async jobs(taskId: string): Promise<Job[]> {
    validateTask(taskId);
    const result = await this.request<Job[]>(`/api/jobs?taskId=${encodeURIComponent(taskId)}`);
    if (!Array.isArray(result) || result.some(job => job.taskId !== taskId)) throw new Error('队列任务归属校验失败。');
    return result;
  }
  async packet(taskId: string, jobId: string): Promise<any> {
    validateTask(taskId);
    const jobs = await this.jobs(taskId);
    if (!jobs.some(job => job.id === jobId)) throw new Error('此请求不属于当前对话。');
    return this.request(`/api/jobs/${encodeURIComponent(jobId)}/packet?taskId=${encodeURIComponent(taskId)}`);
  }
  async mutateJob(taskId: string, jobId: string, action: string, input: object = {}): Promise<unknown> {
    await this.packet(taskId, jobId);
    return this.request(`/api/jobs/${encodeURIComponent(jobId)}/${action}`, 'POST', { ...input, taskId });
  }
  async wait(taskId: string, timeoutMs: number, excludeJobIds: string[] = []): Promise<unknown> {
    validateTask(taskId);
    const result = await this.request<any>('/api/dispatch/wait', 'POST', {taskId, timeoutMs: Math.max(0, Math.min(timeoutMs, 50_000)), excludeJobIds});
    if (result.taskId !== taskId || !Array.isArray(result.jobs) || result.jobs.some((j:Job)=>j.taskId!==taskId)) throw new Error('接单结果不属于当前对话');
    return result;
  }
}
