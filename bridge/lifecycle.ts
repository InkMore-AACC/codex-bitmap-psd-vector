import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { desktopOwner, processSnapshot } from '../shared/process-owner.js';
import { ensureService } from './client.js';

export function startCanvasLifecycle() {
  process.env.LAYER_CANVAS_MANAGED = '1';
  const root = process.env.LAYER_CANVAS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(process.env.LAYER_CANVAS_DATA || path.join(root, 'data'), 'service-owners');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, crypto.randomUUID() + '.json');
  const lease: { pid: number; owner?: { pid: number; started: string } } = { pid: process.pid };
  const write = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(lease)); fs.renameSync(tmp, file); };
  write();
  let stopped = false, checking = false;
  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try { await ensureService(); }
    catch (error) { console.error('画布后台服务启动失败，将自动重试；也可调用打开画布工具。', String(error)); }
    finally { checking = false; }
  };
  // Starting the web service must not delay MCP initialization or load models.
  void check();
  if (process.platform === 'win32' && process.env.LAYER_CANVAS_HOST_TRACKING !== '0') {
    void processSnapshot().then((rows) => {
      if (stopped) return;
      lease.owner = desktopOwner(rows, process.pid);
      write();
    }).catch((error) => console.error('画布宿主识别失败，暂按插件连接管理生命周期。', String(error)));
  }
  const timer = setInterval(() => void check(), 10_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    // Keep a known desktop owner while other chats/windows still use the app.
    if (!lease.owner) try { fs.unlinkSync(file); } catch { /* already released */ }
  };
}
