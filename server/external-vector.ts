import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { getJob, saveJob, assetPath, writeAsset, dir, load } from './store.js';
import { cleanSvg } from './svg.js';
import { exportSvg, renderImage } from './media.js';
import { commitImage } from './results.js';
import type { Job, Layer } from './types.js';
import { receiveWebVectors, reviewAddress, VerificationRequired } from './web-vector-download.js';

export function vectorInputs(j: Job): Layer[] {
  const im = j.snapshot;
  const base = j.useVectorLayers ? im.vectorLayers || im.layers : im.layers;
  const layers =
    !j.useOriginal && base.length
      ? base
      : [
          {
            id: 'original',
            name: im.name,
            url: im.source,
            x: 0,
            y: 0,
            width: im.width,
            height: im.height,
            visible: true,
            opacity: 1,
            opinion: '',
            disposition: 'keep',
            kind: 'raster',
          } as Layer,
        ];
  return layers.filter((l) => !j.layerIds?.length || j.layerIds.includes(l.id));
}
function externalJob(id: string) {
  const j = getJob(id);
  if (j.type !== 'vectorize' || j.engine !== 'vectorizerCom')
    throw new Error('不是免费网页转换任务');
  return j;
}
const needsFile = (l: Layer) => l.kind !== 'vector' && !(l.kind === 'text' && l.text);
export function externalVectorRoutes(app: Express) {
  app.get('/api/jobs/:id/external-inputs', (req, res) => {
    const j = externalJob(String(req.params.id));
    res.json({
      jobId: j.id,
      status: j.status,
      inputs: vectorInputs(j).map((l) => ({ id: l.id, name: l.name, needsFile: needsFile(l) })),
    });
  });
  app.get('/api/jobs/:id/external-input/:layerId', async (req, res) => {
    const j = externalJob(String(req.params.id));
    const l = vectorInputs(j).find((l) => l.id === req.params.layerId);
    if (!l) throw new Error('图层不属于此任务');
    if (l.kind === 'plan') throw new Error('规划框尚未重建，不能矢量化');
    res.type('png').send(
      await sharp(fs.readFileSync(assetPath(j.documentId, l.previewUrl || l.url)))
        .png()
        .toBuffer(),
    );
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 300, fileSize: 40 * 1024 * 1024 },
  });
  const completing = new Set<string>();
  app.post('/api/jobs/:id/external-complete', upload.any(), async (req, res) => {
    const j = externalJob(String(req.params.id));
    if (j.status !== 'queued' || completing.has(j.id))
      return res.status(409).json({ error: '任务已结束或正在导入' });
    completing.add(j.id);
    try {
      const inputs = vectorInputs(j);
      const files = req.files as Express.Multer.File[];
      const required = inputs.filter(needsFile);
      if (
        files.length !== required.length ||
        new Set(files.map((f) => f.fieldname)).size !== files.length ||
        files.some((f) => !required.some((l) => l.id === f.fieldname))
      )
        throw new Error('请为每个待转换图层分别选择一个 SVG 文件');
      const parsed = new Map(files.map((f) => [f.fieldname, cleanSvg(f.buffer.toString('utf8'))]));
      res.json(await completeSvgLayers(j, parsed));
    } finally {
      completing.delete(j.id);
    }
  });
}

async function completeSvgLayers(j: Job, parsed: Map<string, string>) {
  const inputs = vectorInputs(j);
  const im = structuredClone(j.snapshot);
  const layers = inputs.map((l) =>
    needsFile(l)
      ? {
          ...l,
          svg: undefined,
          text: undefined,
          psdStyle: undefined,
          url: writeAsset(j.documentId, Buffer.from(parsed.get(l.id)!), '.svg'),
          previewUrl: undefined,
          kind: 'vector' as const,
          preview: false,
          x: l.previewUrl ? 0 : l.x,
          y: l.previewUrl ? 0 : l.y,
          width: l.previewUrl ? im.width : l.width,
          height: l.previewUrl ? im.height : l.height,
        }
      : l,
  );
  im.layers = layers;
  im.vectorLayers = layers;
  im.status = 'vector';
  im.psdSource = undefined;
  im.artifactUrl = undefined;
  im.annotations = im.annotations.filter(
    (a) => !a.layerId || layers.some((l) => l.id === a.layerId),
  );
  im.vectorUrl = writeAsset(j.documentId, Buffer.from(exportSvg(j.documentId, im)), '.svg');
  im.url = writeAsset(j.documentId, await renderImage(j.documentId, im), '.png');
  im.source = im.url;
  const document = commitImage(j, im);
  j.result = { ...((j.result as object) || {}), artifactUrl: im.vectorUrl };
  j.status = 'completed';
  j.message = '网页 SVG 已导回，保留图层位置与顺序并创建关联节点';
  saveJob(j);
  return { document };
}

export const isCodexWeb = (j: Job) =>
  j.type === 'vectorize' && j.engine === 'vectorizerCom' && j.webMode === 'codex';
export async function webVectorPacket(j: Job) {
  if (!isCodexWeb(j)) return undefined;
  const output = path.join(dir(j.documentId), 'jobs', j.id);
  fs.mkdirSync(output, { recursive: true });
  const inputs = [];
  for (const [index, l] of vectorInputs(j).entries()) {
    if (l.kind === 'plan') throw new Error('规划框尚未重建，不能矢量化');
    if (!needsFile(l)) continue;
    const legacy = path.join(output, `web-input-${index}.png`);
    const uploadPath = fs.existsSync(legacy)
      ? legacy
      : path.join(output, `web-input-${j.id.slice(0, 8)}-${index}.png`);
    if (!fs.existsSync(uploadPath))
      fs.writeFileSync(
        uploadPath,
        await sharp(fs.readFileSync(assetPath(j.documentId, l.previewUrl || l.url)))
          .png()
          .toBuffer(),
      );
    inputs.push({ layerId: l.id, name: l.name, uploadPath });
  }
  return {
    website: 'https://vectorizer.com/',
    inputs,
    outputDirectory: output,
    completionTool: 'canvas_web_vector',
    reviewUrl: j.webProgress?.reviewUrl,
    instructions:
      '在当前对话使用可见浏览器工具上传每个 uploadPath，等待全部转换完成，点击 REVIEW AND DOWNLOAD 进入公开结果页。读取该可见页面完整地址，然后调用 canvas_web_vector action=download,reviewUrl,baseVersion：本地接收器只下载已有结果，不重新上传或转换，并校验逐层文件后创建画布节点。已下载文件可用 complete 回传。遇到验证用 status phase=verification 告知用户接管，保留页面和任务，不绕过验证。下载受阻用 status phase=blocked，必须说明具体原因，不把网站已转换当作画布完成。',
  };
}
const webCompleting = new Set<string>();
export async function codexWebAction(
  j: Job,
  input: {
    action?: string;
    message?: string;
    baseVersion?: number;
    reviewUrl?: string;
    phase?: 'working' | 'verification' | 'blocked';
    files?: { layerId: string; path: string }[];
  },
  receiver = receiveWebVectors,
) {
  if (
    isCodexWeb(j) &&
    j.status === 'completed' &&
    input.action === 'download' &&
    input.baseVersion === j.version &&
    reviewAddress(input.reviewUrl || '') === j.webProgress?.reviewUrl
  ) {
    const document = load(j.documentId);
    const result = document.images.find((i) => i.sourceJobId === j.id);
    if (!result?.vectorUrl) throw new Error('任务已结束，但结果节点不可用');
    j.result = { ...((j.result as object) || {}), artifactUrl: result.vectorUrl };
    saveJob(j);
    return { document, alreadyCompleted: true };
  }
  if (!isCodexWeb(j) || j.status !== 'running')
    throw new Error('需要领取当前对话的 Codex 网页转换任务');
  if (input.action === 'status') {
    j.message = String(input.message || 'Codex 正在操作网页').slice(0, 2000);
    j.webProgress = { phase: input.phase || 'working', updatedAt: new Date().toISOString() };
    saveJob(j);
    return { status: j.status, message: j.message };
  }
  if (input.action === 'download') {
    if (input.baseVersion !== j.version) throw new Error('输入版本不匹配');
    const address = reviewAddress(input.reviewUrl || '');
    if (j.webProgress?.reviewUrl && j.webProgress.reviewUrl !== address)
      throw new Error('结果页与已绑定任务不一致');
    if (webCompleting.has(j.id)) throw new Error('正在接收文件，请勿重复提交');
    webCompleting.add(j.id);
    const update = (
      message: string,
      completed = 0,
      phase: 'working' | 'verification' | 'blocked' = 'working',
    ) => {
      const current = getJob(j.id);
      if (current.status !== 'running') throw new Error('任务已取消或结束，停止接收');
      j = current;
      j.message = message;
      j.webProgress = { phase, completed, updatedAt: new Date().toISOString(), reviewUrl: address };
      saveJob(j);
    };
    const controller = new AbortController();
    const cancelled = setInterval(() => {
      if (getJob(j.id).status !== 'running') controller.abort();
    }, 500);
    const deadline = setTimeout(() => controller.abort(), 240000);
    try {
      update('网站转换已完成，正在接收 SVG 文件');
      const packet = await webVectorPacket(j);
      const files = await receiver(
        address,
        packet!.inputs,
        packet!.outputDirectory,
        controller.signal,
        (message, count) => update(message, count),
      );
      update('已接收全部 SVG，正在创建画布矢量节点', files.length);
      const parsed = new Map(
        files.map((f) => [f.layerId, cleanSvg(fs.readFileSync(f.path, 'utf8'))]),
      );
      return await completeSvgLayers(j, parsed);
    } catch (error) {
      if (getJob(j.id).status === 'running') {
        const detail = error instanceof Error ? error.message : '接收失败';
        const message =
          error instanceof VerificationRequired
            ? detail
            : /下载文件名称|文件名称或数量|下载文件无效|不允许/.test(detail)
              ? detail
              : '网站下载超时或页面发生变化；已接收文件保留，可以继续接收';
        update(
          message,
          j.webProgress?.completed || 0,
          error instanceof VerificationRequired ? 'verification' : 'blocked',
        );
        j.webProgress!.detail = detail.slice(0, 2000);
        saveJob(j);
      }
      throw error;
    } finally {
      clearInterval(cancelled);
      clearTimeout(deadline);
      webCompleting.delete(j.id);
    }
  }
  if (input.action !== 'complete' || input.baseVersion !== j.version)
    throw new Error('操作或输入版本不匹配');
  if (webCompleting.has(j.id)) throw new Error('正在回传，请勿重复提交');
  const required = vectorInputs(j).filter(needsFile),
    files = input.files;
  if (
    !Array.isArray(files) ||
    files.length !== required.length ||
    new Set(files.map((f) => f.layerId)).size !== files.length ||
    files.some((f) => !required.some((l) => l.id === f.layerId))
  )
    throw new Error('须回传每个待转换图层对应的 SVG，不可遗漏或重复');
  webCompleting.add(j.id);
  try {
    const parsed = new Map<string, string>();
    for (const f of files) {
      if (
        typeof f.path !== 'string' ||
        !path.isAbsolute(f.path) ||
        path.extname(f.path).toLowerCase() !== '.svg'
      )
        throw new Error('需要实际下载的 SVG 绝对路径');
      const stat = fs.statSync(f.path);
      if (!stat.isFile() || stat.size > 40 * 1024 * 1024) throw new Error('SVG 文件无效或过大');
      parsed.set(f.layerId, cleanSvg(fs.readFileSync(f.path, 'utf8')));
    }
    return await completeSvgLayers(j, parsed);
  } finally {
    webCompleting.delete(j.id);
  }
}
