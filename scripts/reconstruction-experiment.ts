/** Isolated production-API experiment driver. No inference, automatic dispatch, or production fallback. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CanvasClient, validateTask, type Service } from '../bridge/client.js';
import { serviceIdentity } from '../shared/service-identity.js';
import { captureParentSource } from './experimental-parent-source.js';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
function option(name: string) { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; }
function required(name: string) { const value = option(name); if (!value || value.startsWith('--')) throw new Error(`缺少 --${name}`); return value; }
function json(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function write(file: string, value: unknown) { const temp = `${file}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file); }
function hash(file: string) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function inside(base: string, child: string) { const relative = path.relative(base, child); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
const now = () => new Date().toISOString();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type State = { schema: 1; taskId: string; root: string; data: string; createdAt: string; documentId?: string; imageId?: string; jobId?: string; launchedPid?: number; parentSource?: { imageId?: string; jobId: string; proofPath: string; proofHash: string }; inputs: { path: string; sha256: string; importedAt: string; imageId: string }[] };
const commands = new Set(['start', 'import', 'import-parent', 'plan', 'create', 'claim', 'packet', 'call', 'status', 'snapshot', 'stop']);
// Set only after validating ownership. Invalid/cross-task invocations cannot alter a receipt.
let latestAttempt: { output: string; taskId: string; startedAt: string; record?: string } | undefined;
let ownedLock: { file: string; nonce: string } | undefined;

async function main() {
  if (!command || command === 'help') {
    console.log('node --import tsx scripts/reconstruction-experiment.ts <init|start|import|import-parent|plan|create|claim|packet|call|status|snapshot|stop> --data <独立目录>\n输入选项见 docs/RECONSTRUCTION_EXPERIMENTS.md。必须继承真实 CODEX_THREAD_ID；不会调用模型。');
    return;
  }
  const taskId = process.env.CODEX_THREAD_ID;
  if (!taskId) throw new Error('缺少真实 CODEX_THREAD_ID；不能用编造或历史 ID 替代。');
  validateTask(taskId);
  const data = path.resolve(required('data'));
  const bases = [path.join(root, 'test-output'), path.join(os.tmpdir(), 'layer-canvas-experiments')];
  if (!bases.some(base => inside(base, data))) throw new Error('实验目录必须是 test-output 或系统临时目录/layer-canvas-experiments 的子目录，禁止使用生产 data。');
  fs.mkdirSync(data, { recursive: true });
  // Resolve junctions too: a test directory must not secretly point at production data.
  const realData = fs.realpathSync(data);
  if (!bases.some(base => fs.existsSync(base) && inside(fs.realpathSync(base), realData))) throw new Error('实验目录链接越界。');
  const production = path.join(root, 'data');
  if (fs.existsSync(production)) {
    const realProduction = fs.realpathSync(production);
    if (path.relative(realProduction, realData) === '' || inside(realProduction, realData)) throw new Error('实验目录不能指向生产数据或其子目录。');
  }
  const marker = path.join(data, 'experiment.json');
  if (command === 'init') {
    if (fs.readdirSync(data).length) throw new Error('init 需要空实验目录；已有实验直接使用 start/status。');
    const state: State = { schema: 1, taskId, root, data, createdAt: now(), inputs: [] };
    write(marker, state);
    console.log(JSON.stringify({ data, taskId, initialized: true }));
    return;
  }
  const state = json(marker) as State;
  if (state.schema !== 1 || state.taskId !== taskId || path.resolve(state.data) !== data || path.resolve(state.root) !== root) throw new Error('实验标记不匹配当前任务/仓库/目录；不会跨对话续写。');
  if (!commands.has(command)) throw new Error(`未知命令 ${command}`);
  const lockFile = path.join(data, `last-${command}.lock.json`);
  const nonce = crypto.randomUUID();
  let descriptor: number;
  try { descriptor = fs.openSync(lockFile, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`同一实验的 ${command} 命令已有执行锁；不会覆盖其回执。若上次进程中断，先检查 ${lockFile} 的PID和服务实际状态，再显式清理已终止进程的锁。`);
    throw error;
  }
  ownedLock = { file: lockFile, nonce };
  try { fs.writeFileSync(descriptor, JSON.stringify({ command, taskId, pid: process.pid, nonce, startedAt: now() })); }
  finally { fs.closeSync(descriptor); }
  latestAttempt = { output: path.join(data, `last-${command}.json`), taskId, startedAt: now() };
  write(latestAttempt.output, { command, taskId, startedAt: latestAttempt.startedAt, status: 'pending' });
  const events = path.join(data, 'experiment-events.jsonl');
  const records = path.join(data, 'experiment-calls');
  fs.mkdirSync(records, { recursive: true });
  const log = (event: object) => fs.appendFileSync(events, JSON.stringify({ at: now(), ...event }) + '\n');
  async function service(): Promise<Service> {
    const info = json(path.join(data, 'service.json')) as Service;
    if (!Number.isInteger(info.port) || info.port < 1024 || info.port > 65535 || !info.token || !info.bridgeToken) throw new Error('实验服务凭证无效。');
    const health = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(1500) }).then(r => r.json());
    if (health.name !== 'layer-canvas' || health.instanceId !== serviceIdentity(root, data)) throw new Error('服务不是本实验实例；已拒绝连接。');
    return info;
  }
  const client = new CanvasClient(service);
  async function request(route: string, method = 'GET', body?: unknown) {
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const started = performance.now();
    const file = path.join(records, id + '.json');
    latestAttempt!.record = file;
    write(file, { route, method, body, startedAt: now(), status: 'pending' });
    try {
      const result = await client.request<any>(route, method, body);
      const elapsedMs = Math.round(performance.now() - started);
      write(file, { route, method, body, result, elapsedMs, completedAt: now(), status: 'success' });
      log({ callId: id, route, method, elapsedMs, status: 'success', record: file });
      return result;
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - started);
      const message = error instanceof Error ? error.message : String(error);
      write(file, { route, method, body, error: message, elapsedMs, completedAt: now(), status: 'failed' });
      log({ callId: id, route, method, elapsedMs, status: 'failed', error: message, record: file });
      throw error;
    }
  }
  async function document() {
    const doc = await request(`/api/document?taskId=${encodeURIComponent(taskId!)}`);
    if (doc.taskId !== taskId) throw new Error('服务文档归属不匹配。');
    state.documentId = doc.id;
    write(marker, state);
    return doc;
  }
  async function job() {
    const id = option('job') || state.jobId;
    if (!id) throw new Error('未选择任务；使用 create 或 --job。');
    const all = await request(`/api/jobs?taskId=${encodeURIComponent(taskId!)}`);
    const found = all.find((item: any) => item.id === id && item.taskId === taskId && item.documentId === state.documentId);
    if (!found) throw new Error('任务不属于当前实验文档。');
    return found;
  }
  let result: any;
  switch (command) {
    case 'start': {
      try { const existing = await service(); result = { running: true, port: existing.port, pid: existing.pid }; break; } catch { /* explicit start only */ }
      const port = Number(required('port'));
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 18774) throw new Error('请指定非生产端口（1024–65535，不能为18774）。');
      const descriptor = fs.openSync(path.join(data, 'service.log'), 'a');
      const env: NodeJS.ProcessEnv = { ...process.env, LAYER_CANVAS_DATA: data, LAYER_CANVAS_PORT: String(port), LAYER_CANVAS_MANAGED: '0' };
      delete env.CODEX_APP_TOOLS_PIPE_PATH;
      const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'server/index.ts')], { cwd: root, env, windowsHide: true, detached: true, stdio: ['ignore', descriptor, descriptor] });
      fs.closeSync(descriptor);
      let launchError: Error | undefined;
      child.on('error', error => { launchError = error; });
      child.unref();
      for (let attempt = 0; attempt < 60; attempt++) {
        if (launchError) throw launchError;
        await pause(250);
        try {
          const info = await service();
          if (info.pid !== child.pid) throw new Error('启动 PID 不匹配。');
          state.launchedPid = child.pid;
          write(marker, state);
          result = { running: true, port: info.port, pid: info.pid };
          break;
        } catch { /* bounded startup wait */ }
      }
      if (!result) throw new Error('实验服务启动失败，查看该实验 service.log；不会尝试生产服务。');
      break;
    }
    case 'import-parent': {
      if (state.parentSource) throw new Error('本实验已导入父素材；不要重复创建子层参考节点。');
      const parentJob = await job();
      const scope = json(path.resolve(required('input')));
      if (parentJob.status !== 'running' || scope.taskId !== taskId || scope.jobId !== parentJob.id ||
          scope.imageId !== parentJob.imageId)
        throw new Error('父素材须来自当前已领取的同一实验任务；不能引用历史或其他对话。');
      const generation = await request(`/api/jobs/${parentJob.id}/generation`, 'POST', { taskId, action: 'status' });
      // packet GET rewrites handoff.json. Read the already-frozen public experiment packet instead.
      const packet = json(path.join(data, 'documents', parentJob.documentId, 'jobs', parentJob.id, 'handoff.json'));
      if (packet.job?.id !== parentJob.id || packet.job?.taskId !== taskId || packet.job?.imageId !== parentJob.imageId)
        throw new Error('父素材原冻结任务包不匹配，不能重写缓存以继续。');
      const capture = await captureParentSource(data, parentJob, generation, packet.sourcePath, scope, taskId);
      const file = path.join(records, `parent-reference-${crypto.randomUUID()}.png`);
      fs.writeFileSync(file, capture.bytes, { flag: 'wx' });
      const freshJob = await job();
      const freshGeneration = await request(`/api/jobs/${parentJob.id}/generation`, 'POST', { taskId, action: 'status' });
      capture.assertUnchanged(freshJob, freshGeneration);
      const doc = await document(), before = new Set(doc.images.map((image: any) => image.id));
      const proofPath = path.join(records, `parent-source-${crypto.randomUUID()}.json`);
      write(proofPath, { ...capture.binding, importPath: file, priorImageId: parentJob.imageId,
        status: 'import-pending', startedAt: now() });
      state.parentSource = { jobId: parentJob.id, proofPath, proofHash: hash(proofPath) };
      write(marker, state);
      const imported = await request(`/api/document/${doc.id}/import-path`, 'POST', { taskId, path: file });
      const image = imported.images.find((image: any) => !before.has(image.id));
      if (!image) throw new Error('父素材参考导入没有返回实际节点。');
      state.parentSource.imageId = image.id;
      write(marker, state);
      const importedSourcePath = path.join(data, 'documents', doc.id, 'assets', path.basename(image.source));
      const importedSourceHash = hash(importedSourcePath);
      write(proofPath, { ...capture.binding, importPath: file, importedImageId: image.id,
        importedSourcePath, importedSourceHash,
        priorImageId: parentJob.imageId, importedAt: now(), status: 'pending-recheck' });
      // Save the recovery identity before checking again; a failed recheck must not duplicate an import.
      state.parentSource = { imageId: image.id, jobId: parentJob.id, proofPath, proofHash: hash(proofPath) };
      write(marker, state);
      const afterJob = await job();
      const afterGeneration = await request(`/api/jobs/${parentJob.id}/generation`, 'POST', { taskId, action: 'status' });
      capture.assertUnchanged(afterJob, afterGeneration);
      if (hash(file) !== capture.binding.referenceHash) throw new Error('父参考导入期间变化。');
      if (image.width !== capture.binding.referenceSize.width || image.height !== capture.binding.referenceSize.height ||
          !(await sharp(fs.readFileSync(importedSourcePath)).ensureAlpha().raw().toBuffer()).equals(
            await sharp(capture.bytes).ensureAlpha().raw().toBuffer()))
        throw new Error('新实验参考节点导入像素/尺寸不匹配；保留节点，不创建子层任务。');
      write(proofPath, { ...json(proofPath), status: 'reference-ready' });
      state.parentSource.proofHash = hash(proofPath);
      state.imageId = image.id;
      state.inputs.push({ path: file, sha256: hash(file), importedAt: now(), imageId: image.id });
      delete state.jobId;
      result = { imageId: image.id, proofPath, referenceOnly: true, finalMaterial: false, wholeGoalAccepted: false };
      break;
    }
    case 'import': {
      const input = path.resolve(required('file'));
      const digest = hash(input);
      const doc = await document();
      const before = new Set(doc.images.map((image: any) => image.id));
      result = await request(`/api/document/${doc.id}/import-path`, 'POST', { taskId, path: input });
      const image = result.images.find((image: any) => !before.has(image.id));
      if (!image) throw new Error('导入未产生图片节点。');
      state.imageId = image.id;
      state.inputs.push({ path: input, sha256: digest, importedAt: now(), imageId: image.id });
      delete state.jobId;
      break;
    }
    case 'create': {
      if (state.parentSource) {
        const p = state.parentSource;
        if (hash(p.proofPath) !== p.proofHash || json(p.proofPath).status !== 'reference-ready' ||
            state.imageId !== p.imageId || option('image') && option('image') !== p.imageId)
          throw new Error('父参考来源尚未核验；不能自动创建子层任务。');
        const proof = json(p.proofPath);
        const parents = await request(`/api/jobs?taskId=${encodeURIComponent(taskId)}`);
        const parent = parents.find((j: any) => j.id === p.jobId && j.taskId === taskId && j.documentId === state.documentId);
        if (!parent) throw new Error('父参考任务不属于当前实验文档。');
        const generation = await request(`/api/jobs/${p.jobId}/generation`, 'POST', { taskId, action: 'status' });
        const capture = await captureParentSource(data, parent, generation, proof.sourcePath,
          Object.fromEntries(['taskId','jobId','imageId','generationId','expectedWorkingHash','expectedSourceHash'].map(k => [k, proof[k]])), taskId);
        if (capture.binding.stateHash !== proof.stateHash || capture.binding.jobHash !== proof.jobHash ||
            capture.binding.referenceHash !== proof.referenceHash || hash(proof.importPath) !== proof.referenceHash ||
            hash(proof.importedSourcePath) !== proof.importedSourceHash)
          throw new Error('父参考任务/来源或原位参考变化，须重新实验，不能继承旧批准。');
      }
      const doc = await document();
      const type = required('type');
      if (!['plan', 'layer', 'revise', 'photoshop', 'cutout', 'upscale'].includes(type)) throw new Error('仅支持分层实验类型。');
      if (['cutout', 'upscale'].includes(type) && !args.includes('--allow-local-model')) throw new Error('本地模型任务需要显式 --allow-local-model。');
      const body = option('input') ? json(path.resolve(required('input'))) : {};
      result = await request(`/api/document/${doc.id}/jobs`, 'POST', { ...body, type, imageId: option('image') || state.imageId, mode: Number(option('mode') || 3) });
      state.jobId = result.id;
      break;
    }
    case 'claim': {
      const j = await job();
      if (j.status === 'running') result = { resumed: true, jobId: j.id };
      else if (['waiting_codex', 'queued'].includes(j.status)) result = await request(`/api/jobs/${j.id}/claim`, 'POST', { taskId });
      else throw new Error(`任务已 ${j.status}；若有检查点，使用 call --action resume 显式恢复原任务，不复制旧登记到新任务。`);
      break;
    }
    case 'packet': {
      const j = await job();
      result = await request(`/api/jobs/${j.id}/packet?taskId=${encodeURIComponent(taskId)}`);
      break;
    }
    case 'plan':
    case 'call': {
      const j = await job();
      const action = command === 'plan' ? 'plan' : required('action');
      if (!['plan', 'generation', 'ps-rebuild', 'adobe', 'apply', 'fail', 'cancel', 'resume'].includes(action)) throw new Error('不支持的任务接口。');
      if (action === 'plan' && j.mode !== 3 && !args.includes('--allow-local-model')) throw new Error('非 Codex 框规划会实际执行本地模型，需要 --allow-local-model。');
      if (['ps-rebuild', 'adobe'].includes(action) && !args.includes('--allow-adobe')) throw new Error('Adobe 调用需要显式 --allow-adobe，且仅允许操作实验新文档。');
      const body = json(path.resolve(required('input')));
      result = await request(`/api/jobs/${j.id}/${action}`, 'POST', { ...body, taskId, ...(command === 'plan' ? { baseVersion: j.version } : {}) });
      break;
    }
    case 'status':
    case 'snapshot': {
      const doc = await document();
      const jobs = await request(`/api/jobs?taskId=${encodeURIComponent(taskId)}`);
      result = { document: doc, jobs };
      if (command === 'snapshot') {
        const files: { path: string; bytes: number; sha256: string }[] = [];
        function scan(dir: string) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) scan(file);
            else files.push({ path: path.relative(data, file), bytes: fs.statSync(file).size, sha256: hash(file) });
          }
        }
        const docs = path.join(data, 'documents');
        if (fs.existsSync(docs)) scan(docs);
        result.files = files;
      }
      break;
    }
    case 'stop': {
      const info = await service();
      if (!state.launchedPid || info.pid !== state.launchedPid) throw new Error('该服务不是由本实验记录启动，拒绝停止。');
      const all = await request(`/api/jobs?taskId=${encodeURIComponent(taskId)}`);
      if (all.some((j: any) => ['running', 'queued'].includes(j.status))) throw new Error('仍有执行任务，先完成或明确取消；停止会令生产恢复规则将任务标为失败。');
      process.kill(state.launchedPid);
      delete state.launchedPid;
      result = { stopped: true, dataPreserved: true };
      break;
    }
    default: throw new Error(`未知命令 ${command}`);
  }
  write(marker, state);
  const output = path.join(data, `last-${command}.json`);
  write(output, result);
  log({ command, imageId: state.imageId, jobId: state.jobId, output });
  console.log(JSON.stringify({ command, data, taskId, documentId: state.documentId, imageId: state.imageId, jobId: state.jobId, output, ...(args.includes('--full') ? { result } : {}) }, null, 2));
}
main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (latestAttempt) {
    try {
      write(latestAttempt.output, { command, taskId: latestAttempt.taskId, startedAt: latestAttempt.startedAt,
        completedAt: now(), status: 'failed', error: message, record: latestAttempt.record });
    } catch (receiptError) {
      console.error(`失败回执写入失败：${receiptError instanceof Error ? receiptError.message : String(receiptError)}`);
    }
  }
  console.error(message);
  process.exitCode = 1;
}).finally(() => {
  if (!ownedLock) return;
  try {
    if (json(ownedLock.file).nonce !== ownedLock.nonce) throw new Error('命令锁身份改变，保留锁文件。');
    fs.unlinkSync(ownedLock.file);
  } catch (error) {
    console.error(`命令锁释放失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
});
