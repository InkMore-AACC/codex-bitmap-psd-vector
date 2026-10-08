import { importVideo, videoExtension } from './video.js';
import { PHOTOSHOP_REFERENCE_POLICY } from '../shared/photoshop-policy.js';
import {
  photoshopAction,
  photoshopPacket,
  processPhotoshopMaterial,
  completePhotoshop,
  photoshopState,
  photoshopFolder,
  validatePhotoshopPlan,
} from './photoshop-rebuild.js';
import { readPhotoshopDefaults, savePhotoshopDefaults } from './photoshop-settings.js';
import { renderNativePsd, nativeProgressLayers, taskPsd, fileHash } from './photoshop-native.js';
import { layerFromFile } from './layer-import.js';
import { planningLayer } from '../shared/planning.js';
import { frameSchema } from '../shared/layer-frame.js';
import { frameContract, normalizeFramedResults } from './layer-frames.js';
import { layerFrame, scaledFrame } from '../shared/layer-frame.js';
import { reconstructionInputs, rejectPreviewReuse } from './reconstruction-inputs.js';
import { RECONSTRUCTION_POLICY } from '../shared/reconstruction-policy.js';
import { RECONSTRUCTION_REVIEW_POLICY } from '../shared/layer-review.js';
import { applyLayerReviews } from './layer-review.js';
import { reconstructionCrops } from './reconstruction-crops.js';
import { generationAction, generationSummary, generationState, captureDerivedConsumer, verifyDerivedConsumer, prepareGeneratedRoleConsumer } from './generation.js';
import { requireCompositeApproval } from './generation-workflow.js';
import { serviceIdentity } from '../shared/service-identity.js';
import { hasCanvasOwners, lifecycleGuard } from './lifecycle.js';
import { acquireServiceLock } from './service-lock.js';
import express from 'express';
import { originalReference } from './references.js';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  ROOT,
  DATA,
  uid,
  now,
  atomic,
  json,
  dir,
  load,
  save,
  getByTask,
  assetPath,
  writeAsset,
  history,
  jobs,
  getJob,
  saveJob,
  safeJob,
} from './store.js';
import { documentSchema, jobSchema, viewStateSchema } from './validation.js';
import {
  importImage,
  renderImage,
  exportPsd,
  exportSvg,
  checkDimensions,
  renderTextLayer,
  renderStyledLayer,
} from './media.js';
import { cleanSvg } from './svg.js';
import { modelStatus, worker } from './models.js';
import { DEFAULT_CUTOUT } from '../shared/cutout.js';
import { readCutoutDefaults, saveCutoutDefaults } from './cutout-settings.js';
import { readMattingDefaults, saveMattingDefaults } from './matting-settings.js';
import { readUpscaleDefaults, saveUpscaleDefaults } from './upscale-settings.js';
import { upscaleImage } from './upscale.js';
import { upscaleDimensions, upscaleModelName } from '../shared/upscale.js';
import { standaloneMatting } from './standalone-matting.js';
import { cutoutPacket, runLocalCutouts, prepareCutouts } from './cutouts.js';
import { keyStatus, updateKeys } from './credentials.js';
import { vectorize } from './providers.js';
import {
  externalVectorRoutes,
  isCodexWeb,
  webVectorPacket,
  codexWebAction,
} from './external-vector.js';
import { VectorizerBrowser } from './vectorizer-browser.js';
import type { Job, Layer, CanvasImage } from './types.js';
import { commitImage, preserveLayerIdentity } from './results.js';
import { AdobeConnector } from './adobe.js';
import { annotationPacket } from './annotations.js';
import {
  dispatchStatus,
  notifyRequests,
  waitRequests,
  connectDesktop,
  prepareDispatch,
  dispatchJob,
  needsCodex,
  dispatchBusy,
} from './dispatch.js';
import { buildHandoffPrompt } from '../bridge/handoff.js';
const previous = json<any>(path.join(DATA, 'service.json'), {});
export let PORT = Number(process.env.LAYER_CANVAS_PORT || previous.port || 18774);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535)
  throw new Error('画布端口必须为 1024–65535 的整数');
export const TOKEN = previous.token || crypto.randomBytes(32).toString('hex');
export const BRIDGE_TOKEN = previous.bridgeToken || crypto.randomBytes(32).toString('hex');
export const adobe = new AdobeConnector(ROOT, DATA);
const aborters = new Map<string, AbortController>();
let activeRequests = 0;
let queuedLocalWork = 0;
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
export const app = express();
app.use((req, res, next) => {
  if (req.path !== '/api/health') {
    activeRequests++;
    let done = false;
    const release = () => {
      if (!done) {
        done = true;
        activeRequests--;
      }
    };
    res.once('finish', release);
    res.once('close', release);
  }
  next();
});
app.disable('x-powered-by');
app.use((req, res, next) => {
  const host = req.hostname;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host))
    return res.status(403).json({ error: '仅允许本机访问' });
  const origin = req.get('Origin');
  if (origin) {
    try {
      const u = new URL(origin);
      if (
        !['127.0.0.1', 'localhost'].includes(u.hostname) ||
        ![String(PORT), '5173'].includes(u.port)
      )
        throw 0;
    } catch {
      return res.status(403).json({ error: '不允许跨站访问' });
    }
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
  );
  next();
});
app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    name: 'layer-canvas',
    version: '0.1.0',
    reconstructionWorkflowVersion: 4,
    instanceId: serviceIdentity(ROOT, DATA),
  }),
);
app.use(['/api', '/assets'], (req, res, next) => {
  const cookie = (req.get('Cookie') || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('layer_canvas='))
    ?.slice(13);
  const headerValid = req.get('X-Canvas-Token') === TOKEN;
  const cookieValid = cookie === TOKEN;
  if (!headerValid && !cookieValid)
    return res.status(401).json({ error: '请从当前 Codex 对话打开画布' });
  res.setHeader(
    'Set-Cookie',
    `layer_canvas=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
  );
  next();
});
app.use(express.json({ limit: '48mb' }));
const internal = (req: express.Request, res: express.Response, next: express.NextFunction) =>
  req.get('X-Canvas-Bridge') === BRIDGE_TOKEN
    ? next()
    : res.status(403).json({ error: '此操作仅供 Codex 插件使用' });
function boundJob(req: express.Request, allowCompleted = false) {
  const j = getJob(String(req.params.id));
  if (req.body.taskId !== j.taskId) throw fail('任务与当前对话不匹配', 403);
  if (j.status === 'cancelled' || (j.status === 'completed' && !allowCompleted))
    throw fail('任务已经结束', 409);
  return j;
}
function imageFor(j: Job) {
  const d = load(j.documentId);
  const im = d.images.find((i) => i.id === j.imageId);
  if (!im) throw fail('图片已被移除', 409);
  return { d, im: structuredClone(j.snapshot) };
}
function changed(a: CanvasImage, b: CanvasImage) {
  const pick = (im: CanvasImage) => ({
    layers: im.layers.map(({ visible, ...l }) => l),
    vectorLayers: im.vectorLayers?.map(({ visible, ...l }) => l),
    annotations: im.annotations,
    opinion: im.opinion,
    width: im.width,
    height: im.height,
    status: im.status,
  });
  return !isDeepStrictEqual(pick(a), pick(b));
}
function assertAssets(docId: string, im: CanvasImage) {
  for (const u of [
    im.source,
    im.url,
    im.vectorUrl,
    im.psdSource,
    im.artifactUrl,
    im.video?.previewUrl,
    im.nativePsd?.compositeUrl,
    ...[...im.layers, ...(im.vectorLayers || [])].flatMap((l) => [
      l.url,
      l.previewUrl,
      l.generationSourceUrl,
    ]),
  ].filter(Boolean) as string[]) {
    if (!fs.existsSync(assetPath(docId, u))) throw fail('素材文件不存在');
  }
  for (const l of [...im.layers, ...(im.vectorLayers || [])]) if (l.svg) cleanSvg(l.svg);
}
app.get('/api/document', (req, res) => res.json(getByTask(String(req.query.taskId || ''))));
app.get('/api/document/:id/view-state', (req, res) => {
  const d = load(String(req.params.id));
  const file = path.join(dir(d.id), 'view-state.json');
  const raw = json<unknown>(file, null);
  if (raw === null) return res.json(null);
  const state = viewStateSchema.parse(raw);
  res.json({
    ...state,
    selectedImageId:
      state.selectedImageId && d.images.some((i) => i.id === state.selectedImageId)
        ? state.selectedImageId
        : null,
  });
});
app.put('/api/document/:id/view-state', (req, res) => {
  const d = load(String(req.params.id));
  const state = viewStateSchema.parse(req.body);
  if (state.selectedImageId && !d.images.some((i) => i.id === state.selectedImageId))
    throw fail('选中的图片已不存在');
  atomic(path.join(dir(d.id), 'view-state.json'), state);
  res.json(state);
});
app.get('/api/document/:id/images/:imageId/reference', (req, res) => {
  const d = load(String(req.params.id));
  const image = d.images.find((i) => i.id === req.params.imageId);
  if (!image) throw fail('图片不存在', 404);
  const { path: localPath, ...reference } = originalReference(d.id, image);
  res.json(reference);
});
app.put('/api/document/:id', async (req, res) => {
  const current = load(String(req.params.id));
  if (req.body.expectedRevision !== current.revision) throw fail('画布已更新，请刷新后重试', 409);
  const d = documentSchema.parse(req.body.document);
  const deletedFile = path.join(dir(current.id), 'deleted-images.json');
  const deleted = json<Record<string, CanvasImage>>(deletedFile, {});
  if (d.id !== current.id || d.taskId !== current.taskId) throw fail('画布绑定不可更改', 403);
  for (const im of d.images) {
    const old = current.images.find((i) => i.id === im.id) || deleted[im.id];
    if (!old) throw fail('请通过导入入口添加图片');
    if (
      im.mediaType !== old.mediaType ||
      !isDeepStrictEqual(im.video, old.video) ||
      (old.mediaType === 'video' &&
        (im.width !== old.width || im.height !== old.height || im.url !== old.url))
    )
      throw fail('视频素材与媒体信息不可更改');
    if (im.source !== old.source || im.psdSource !== old.psdSource) throw fail('原始素材不可替换');
    for (const key of [
      'parentId',
      'sourceJobId',
      'sourceVersion',
      'basedOnOlderVersion',
      'artifactUrl',
    ] as const)
      if (im[key] !== old[key]) throw fail('结果来源不可更改');
    if (!isDeepStrictEqual(im.nativePsd, old.nativePsd)) throw fail('原生PSD映射不可改写');
    if (old.nativePsd) {
      if (im.width !== old.width || im.height !== old.height)
        throw fail('原生PSD尺寸请通过交接PS修改');
      if (
        im.layers.length !== old.layers.length ||
        im.layers.some((l) => !old.layers.some((o) => o.id === l.id))
      )
        throw fail('原生PSD增删图层请通过交接PS修改');
      for (const l of im.layers) {
        const prior = old.layers.find((o) => o.id === l.id)!;
        const pixels = (v: Layer) => [
          v.url,
          v.previewUrl,
          v.kind,
          v.x,
          v.y,
          v.width,
          v.height,
          v.text,
          v.psdStyle,
          v.blendMode,
        ];
        if (!isDeepStrictEqual(pixels(l), pixels(prior)))
          throw fail('原生文字、形状与效果请通过交接PS修改，避免丢失PS属性');
      }
      const state = (i: CanvasImage) => i.layers.map((l) => [l.id, l.visible, l.opacity]);
      if (!isDeepStrictEqual(state(im), state(old))) {
        const mappings = im.layers.map((l) => ({
          ...old.nativePsd!.mappings.find((m) => m.layerId === l.id)!,
          visible: l.visible,
          opacity: l.opacity,
        }));
        const rendered = await renderNativePsd(
          adobe,
          assetPath(d.id, old.psdSource!),
          path.join(dir(d.id), 'native-previews', uid()),
          mappings,
          true,
        );
        im.url = writeAsset(d.id, fs.readFileSync(rendered.previewPath), '.png');
        im.psdSource = writeAsset(d.id, fs.readFileSync(rendered.psdPath), '.psd');
        im.artifactUrl = im.psdSource;
        im.nativePsd = {
          ...old.nativePsd,
          mappings: mappings.map(({ layerId, groupName, editable }) => ({
            layerId,
            groupName,
            editable,
          })),
          compositeUrl: im.url,
        };
      }
    }
    assertAssets(d.id, im);
    for (const [collection, oldCollection] of [
      [im.layers, old.layers],
      [im.vectorLayers || [], old.vectorLayers || []],
    ])
      for (const l of collection) {
        const prior = oldCollection.find((v) => v.id === l.id);
        if (
          l.kind === 'text' &&
          l.text &&
          prior &&
          !isDeepStrictEqual([l.text, l.psdStyle], [prior.text, prior.psdStyle])
        ) {
          l.textDirty = true;
          l.x = 0;
          l.y = 0;
          l.width = im.width;
          l.height = im.height;
          l.url = writeAsset(d.id, await renderTextLayer(l), '.png');
          l.previewUrl = l.psdStyle
            ? writeAsset(d.id, await renderStyledLayer(d.id, l, im.width, im.height), '.png')
            : undefined;
        }
      }
    im.version = old.version + (changed(im, old) ? 1 : 0);
  }
  if (load(current.id).revision !== current.revision) throw fail('保存期间画布已更新，请重试', 409);
  history(current);
  const removed = current.images.filter((i) => !d.images.some((x) => x.id === i.id));
  for (const im of removed) deleted[im.id] = im;
  atomic(deletedFile, deleted);
  d.revision = current.revision + 1;
  const saved = save(d);
  for (const j of jobs())
    if (
      j.documentId === d.id &&
      removed.some((i) => i.id === j.imageId) &&
      ['queued', 'waiting_codex', 'running'].includes(j.status)
    ) {
      aborters.get(j.id)?.abort();
      j.status = 'cancelled';
      j.message = '来源图片已从画布删除，任务已取消；其他节点保留';
      saveJob(j);
    }
  res.json(saved);
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 160 * 1024 * 1024, files: 20 },
});
app.post('/api/document/:id/import', upload.array('files', 20), async (req, res) => {
  const before = load(String(req.params.id));
  const files = req.files as Express.Multer.File[];
  if (!files?.length) throw fail('没有文件');
  const added: CanvasImage[] = [];
  for (const file of files)
    added.push(
      await importImage(
        { ...before, images: [...before.images, ...added] },
        file.buffer,
        Buffer.from(file.originalname, 'latin1').toString('utf8'),
      ),
    );
  const current = load(before.id);
  if (current.revision !== before.revision) throw fail('导入期间画布已变化，请重试', 409);
  history(current);
  current.images.push(...added);
  current.revision++;
  res.json(save(current));
});
const videoScratch = path.join(DATA, 'video-uploads');
fs.mkdirSync(videoScratch, { recursive: true });
const videoUpload = multer({ dest: videoScratch, limits: { fileSize: 2 * 1024 ** 3, files: 1 } });
app.post('/api/document/:id/import-video', videoUpload.single('files'), async (req, res) => {
  if (!req.file) throw fail('请选择视频');
  queuedLocalWork++;
  try {
    const d = load(String(req.params.id));
    const im = await importVideo(
      d,
      req.file.path,
      Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      app.locals.videoWorker || worker,
    );
    const fresh = load(d.id);
    if (fresh.images.length >= 100) throw fail('画布节点已达100个');
    history(fresh);
    fresh.images.push(im);
    fresh.revision++;
    res.json(save(fresh));
  } finally {
    queuedLocalWork--;
    fs.rmSync(req.file.path, { force: true });
  }
});
app.post('/api/document/:id/import-path', internal, async (req, res) => {
  const d = load(String(req.params.id));
  if (req.body.taskId !== d.taskId) throw fail('对话不匹配', 403);
  const input = String(req.body.path || '');
  if (!path.isAbsolute(input)) throw fail('需要本地绝对路径');
  const stat = fs.statSync(input);
  const isVideo = videoExtension.test(input);
  if (!stat.isFile() || stat.size > (isVideo ? 2 * 1024 ** 3 : 160 * 1024 ** 2))
    throw fail('文件超出大小限制');
  queuedLocalWork++;
  let image: CanvasImage;
  try {
    image = isVideo
      ? await importVideo(d, input, path.basename(input), app.locals.videoWorker || worker)
      : await importImage(d, fs.readFileSync(input), path.basename(input));
  } finally {
    queuedLocalWork--;
  }
  const fresh = load(d.id);
  if (fresh.images.length >= 100) throw fail('画布节点已达100个');
  history(fresh);
  fresh.images.push(image);
  fresh.revision++;
  res.json(save(fresh));
});
externalVectorRoutes(app);
app.get('/api/cutout-defaults', (_req, res) => res.json(readCutoutDefaults()));
app.get('/api/upscale-status', async (_req, res) =>
  res.json(
    await worker(['upscale-status', '--model', 'seedvr2-7b-int8']).catch((e: Error) => ({
      available: false,
      message: e.message,
    })),
  ),
);
app.get('/api/upscale-defaults', (_req, res) => res.json(readUpscaleDefaults()));
app.put('/api/upscale-defaults', (req, res) => res.json(saveUpscaleDefaults(req.body)));
app.get('/api/matting-defaults', (_req, res) => res.json(readMattingDefaults()));
app.put('/api/matting-defaults', (req, res) => res.json(saveMattingDefaults(req.body)));
app.put('/api/cutout-defaults', (req, res) => res.json(saveCutoutDefaults(req.body)));
app.get('/api/settings', async (_req, res) =>
  res.json({ ...keyStatus(), models: await modelStatus() }),
);
app.put('/api/settings', async (req, res) => res.json(await updateKeys(req.body)));
app.get('/api/adobe', (_req, res) => res.json(adobe.publicSettings()));
app.get('/api/photoshop-defaults', (_req, res) => res.json(readPhotoshopDefaults()));
app.put('/api/photoshop-defaults', (req, res) => res.json(savePhotoshopDefaults(req.body)));
app.post('/api/jobs/:id/generation', internal, async (req, res) => {
  const j = boundJob(req);
  if (!['layer', 'revise', 'photoshop'].includes(j.type)) throw fail('此任务不使用图层生成');
  if (j.status !== 'running' && req.body.action !== 'status') throw fail('请先领取任务，已停止任务不能继续写入', 409);
  res.json(await generationAction(j, req.body, j.type === 'photoshop' ? photoshopState(j).plan : undefined));
});
app.post('/api/jobs/:id/ps-rebuild', internal, async (req, res) => {
  const j = boundJob(req);
  if (j.type !== 'photoshop') throw fail('此操作仅用于PS重建');
  const result = await photoshopAction(j, req.body, adobe);
  if (req.body.action !== 'status') {
    const fresh = getJob(j.id);
    fresh.message =
      (
        {
          plan: '逐层重建计划已保存',
          material: '正在检查素材，准备按原始细节合成',
          'upscale-material':'已确认构图，正在超分素材',
          inspect: 'PS实际渲染已就绪，等待视觉检查',
          review: '正在逐层检查一致性',
          'review-composite': '整图检查已记录，等待回传',
        } as Record<string, string>
      )[req.body.action] || fresh.message;
    saveJob(fresh);
  }
  res.json(result);
  if (['material','upscale-material'].includes(req.body.action)) {
    queuedLocalWork++;
    mattingQueue = mattingQueue
      .then(async () => {
        if (getJob(j.id).status !== 'running') return;
        const controller = new AbortController();
        aborters.set(j.id, controller);
        try {
          await processPhotoshopMaterial(getJob(j.id), req.body.layerId, controller.signal);
          const updated = getJob(j.id);
          if (updated.status === 'running') {
            updated.message = '素材已准备，继续PS合成与检查';
            saveJob(updated);
          }
        } catch (e) {
          const state = photoshopState(j);
          if (state.materials[req.body.layerId]) {
            state.materials[req.body.layerId].status = 'failed';
            state.materials[req.body.layerId].error = String(e);
            atomic(path.join(photoshopFolder(j), 'photoshop-rebuild.json'), state);
          }
        } finally {
          aborters.delete(j.id);
        }
      })
      .finally(() => {
        queuedLocalWork--;
      });
  }
});
app.patch('/api/adobe', async (req, res) => res.json(await adobe.configure(req.body)));
app.post('/api/adobe/probe', async (req, res) => {
  if (!['photoshop', 'illustrator'].includes(req.body.app)) throw fail('未知 Adobe 应用');
  res.json(await adobe.probe(req.body.app));
});
app.post('/api/jobs/:id/adobe', internal, async (req, res) => {
  const j = boundJob(req);
  if (j.type !== 'photoshop' && j.type !== 'illustrator') throw fail('此任务不是 Adobe 交接');
  if (req.body.action === 'inspect')
    return res.json({
      status: await adobe.probe(j.type),
      tools: await adobe.listTools(j.type).catch((e: any) => ({ unavailable: e.message })),
      scriptRoute: 'native_script',
    });
  if (j.status !== 'running') throw fail('先领取交接任务再执行 Adobe 操作', 409);
  if (req.body.action === 'call')
    return res.json(
      await adobe.callTool(j.type, String(req.body.tool || ''), req.body.arguments || {}),
    );
  if (req.body.action === 'native_script') {
    const folder = path.join(dir(j.documentId), 'jobs', j.id);
    fs.mkdirSync(folder, { recursive: true });
    if (
      !Array.isArray(req.body.expectedOutputs) ||
      req.body.expectedOutputs.some((v: any) => typeof v !== 'string')
    )
      throw fail('需要声明输出文件');
    return res.json(
      await adobe.executeScript(
        j.type,
        String(req.body.scriptPath || ''),
        folder,
        req.body.expectedOutputs,
      ),
    );
  }
  throw fail('未知 Adobe 操作');
});
app.get('/assets/:docId/:name', (req, res) => {
  const p = assetPath(req.params.docId, `/assets/${req.params.docId}/${req.params.name}`);
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.sendFile(p);
});
app.get('/api/document/:id/jobs', (req, res) => {
  load(String(req.params.id));
  res.json(
    jobs()
      .filter((j) => j.documentId === String(req.params.id))
      .map(safeJob),
  );
});
app.get('/api/document/:id/dispatch', (req, res) =>
  res.json(dispatchStatus(load(String(req.params.id)).taskId)),
);
app.post('/api/dispatch/connect', internal, (req, res) => {
  const taskId = String(req.body.taskId || '');
  getByTask(taskId);
  res.json(connectDesktop(taskId, req.body.pipePath));
});
app.post('/api/dispatch/wait', internal, async (req, res) => {
  const taskId = String(req.body.taskId || '');
  getByTask(taskId);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  res.json(
    await waitRequests(
      taskId,
      Number(req.body.timeoutMs) || 0,
      Array.isArray(req.body.excludeJobIds) ? req.body.excludeJobIds : [],
      abort.signal,
    ),
  );
});
app.get('/api/jobs', internal, (req, res) =>
  res.json(
    jobs()
      .filter((j) => j.taskId === String(req.query.taskId || ''))
      .map(safeJob),
  ),
);
app.post('/api/document/:id/jobs', async (req, res) => {
  const d = load(String(req.params.id));
  const input = jobSchema.parse(req.body);
  const im = d.images.find((i) => i.id === input.imageId);
  if (!im) throw fail('请选择图片或视频');
  if (im.nativePsd && ['revise', 'layer'].includes(input.type)) input.type = 'photoshop';
  if (
    input.type === 'photoshop' &&
    input.layerIds?.length &&
    im.layers.some((l) => !input.layerIds!.includes(l.id) && l.preview)
  )
    throw fail(
      '其他建议图层尚未重建，不能在局部PS任务中把它们当成完成图层。请取消图层选择，交接整张预分层图片。',
    );
  if (im.mediaType === 'video' && input.type !== 'upscale')
    throw fail('视频当前支持超分，请使用超分按钮');
  if (
    ['cutout', 'upscale'].includes(input.type) &&
    (input.layerIds?.length || input.useOriginal || input.useVectorLayers)
  )
    throw fail('独立抠图和超分只处理当前图片节点的实际画面，请选择图片后提交');
  if (input.type === 'upscale') {
    try {
      upscaleDimensions(im.width, im.height, d.settings.upscale || readUpscaleDefaults());
    } catch (e: any) {
      throw fail(e.message);
    }
  }
  if (
    jobs().some(
      (j) =>
        j.imageId === im.id &&
        j.documentId === d.id &&
        ['running', 'queued', 'waiting_codex'].includes(j.status),
    )
  )
    throw fail('此图片已有待处理任务，请完成或取消后再提交', 409);
  if (
    input.layerIds?.some(
      (id) =>
        !(input.useVectorLayers ? im.vectorLayers || im.layers : im.layers).some(
          (l) => l.id === id,
        ),
    )
  )
    throw fail('选中图层不存在');
  if (input.type === 'vectorize' && im.status === 'preview' && !input.useOriginal)
    throw fail('预分层尚未确认。请先完成分层，或选中原图节点直接矢量化');
  if (['layer', 'revise'].includes(input.type) && im.status === 'preview' && !im.layers.length)
    throw fail('请先添加或规划至少一个图层');
  const job: Job = {
    id: uid(),
    documentId: d.id,
    taskId: d.taskId,
    imageId: im.id,
    type: input.type,
    status: ['vectorize', 'cutout', 'upscale'].includes(input.type) ? 'queued' : 'waiting_codex',
    message:
      input.type === 'upscale'
        ? `等待本地 ${upscaleModelName(d.settings.upscale)} 超分 · 不消耗 Codex 额度`
        : input.type === 'cutout'
          ? '等待本地精细抠图 · 不消耗 Codex 额度'
          : input.type === 'vectorize'
            ? '等待矢量化'
            : '等待当前 Codex 对话领取并执行',
    createdAt: now(),
    version: im.version,
    mode: input.mode || d.settings.psdMode,
    cutoutOptions: structuredClone(d.settings.cutoutOptions || DEFAULT_CUTOUT),
    upscale: ['upscale', 'photoshop'].includes(input.type)
      ? structuredClone(d.settings.upscale || readUpscaleDefaults())
      : undefined,
    matting:
      input.type === 'cutout'
        ? structuredClone(d.settings.matting || readMattingDefaults())
        : undefined,
    photoshop:
      input.type === 'photoshop'
        ? structuredClone(d.settings.photoshop || readPhotoshopDefaults())
        : undefined,
    engine: input.engine || d.settings.vectorEngine,
    webMode: d.settings.vectorizerComMode || 'auto',
    layerIds: input.useOriginal ? undefined : input.layerIds,
    useOriginal: input.useOriginal,
    useVectorLayers: input.useVectorLayers,
    snapshot: structuredClone(
      input.useVectorLayers ? { ...im, layers: im.vectorLayers || im.layers } : im,
    ),
  };
  if (job.snapshot.nativePsd) job.snapshot.source = job.snapshot.url;
  if (
    ['layer', 'revise', 'photoshop'].includes(job.type) &&
    job.snapshot.layers.length &&
    !job.useOriginal
  ) {
    // Explicitly selected layers are an intentional edit; whole-node revisions skip kept results.
    if (job.type === 'revise' && im.status !== 'preview' && !job.layerIds?.length) {
      const targets = job.snapshot.layers.filter((l) => l.disposition === 'rebuild' || l.preview);
      if (!targets.length)
        throw fail('所有图层均标记为保留。请把需要修改的层设为重建，或选中该层再提交。');
      if (targets.length < job.snapshot.layers.length) {
        job.layerIds = targets.map((l) => l.id);
        job.preserveKeptLayers = true;
      }
    }
    job.frameContractVersion = 1;
    job.reconstructionVersion = 3;
    job.reconstructionWorkflowVersion = 4;
    job.snapshot.layers = job.snapshot.layers.map((l) => ({
      ...l,
      frame: layerFrame(l, job.snapshot),
    }));
  }
  if (job.type === 'vectorize' && job.engine === 'vectorizerCom') {
    job.message = isCodexWeb(job) ? '等待当前 Codex 对话操作网页' : '等待自动网页转换';
    if (isCodexWeb(job)) job.status = 'waiting_codex';
  }
  if (job.type === 'photoshop') {
    job.reconstructionVersion = 3;
    job.reconstructionWorkflowVersion = 4;
  }
  prepareDispatch(job);
  saveJob(job);
  notifyRequests(job.taskId);
  res.status(202).json(safeJob(job));
  if (needsCodex(job)) setImmediate(() => void dispatchJob(job.id, app.locals.codexSender));
  if (job.type === 'vectorize' && !isCodexWeb(job)) setImmediate(() => enqueueVectorJob(job.id));
  if (['cutout', 'upscale'].includes(job.type)) setImmediate(() => enqueueMattingJob(job.id));
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  const j = getJob(String(req.params.id));
  if (['completed', 'failed', 'cancelled'].includes(j.status)) return res.json(safeJob(j));
  aborters.get(j.id)?.abort();
  j.status = 'cancelled';
  j.message = '已取消；已发出的 API 请求可能仍计费';
  res.json(safeJob(saveJob(j)));
});
app.post('/api/jobs/:id/claim', internal, (req, res) => {
  const j = boundJob(req);
  if (['cutout', 'upscale'].includes(j.type))
    throw fail('本地图片任务由模型自动执行，无需 Codex 领取', 409);
  if (j.type === 'vectorize' && !isCodexWeb(j))
    throw fail('矢量化由所选引擎或网页文件导回完成，不由 Codex 领取', 409);
  if (j.mode === 1) throw fail('方案1已移除，请取消历史任务后选择方案2或3重新提交', 409);
  if (!['waiting_codex', 'queued'].includes(j.status)) throw fail('任务已被领取或结束', 409);
  j.status = 'running';
  j.dispatch = { state: 'received', updatedAt: now() };
  j.message = '当前 Codex 正在处理';
  if (isCodexWeb(j)) j.webProgress = { phase: 'working', updatedAt: now() };
  res.json(safeJob(saveJob(j)));
});
app.post('/api/jobs/:id/fail', internal, (req, res) => {
  const j = boundJob(req);
  j.status = 'failed';
  j.message = String(req.body.message || '执行失败').slice(0, 2000);
  res.json(safeJob(saveJob(j)));
});
app.post('/api/jobs/:id/resume', internal, (req, res) => {
  // An explicit same-job continuation preserves candidate/prompt provenance.
  // Never silently undo a cancellation or dispatch a new inference request.
  const j = getJob(String(req.params.id));
  if (req.body.taskId !== j.taskId) throw fail('任务与当前对话不匹配', 403);
  if (!['layer', 'revise', 'photoshop'].includes(j.type))
    throw fail('只有分层、修改和PS重建任务支持从检查点恢复', 409);
  if (!['failed', 'cancelled'].includes(j.status))
    throw fail('只能恢复已失败任务；已完成或执行中的任务不能重复恢复', 409);
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 2000) throw fail('请说明恢复原因（1至2000字）');
  if (j.status === 'cancelled' && req.body.confirmCancelled !== true)
    throw fail('该任务已明确取消；只有用户重新授权并显式确认后才能恢复', 409);
  if (aborters.has(j.id) || (j.type === 'photoshop' && queuedLocalWork > 0))
    throw fail('后台仍有操作尚未退出，请等待后再恢复，避免重复执行', 409);
  const d = load(j.documentId);
  if (d.taskId !== j.taskId) throw fail('画布与任务对话不匹配', 403);
  const source = d.images.find(image => image.id === j.imageId);
  if (!source || source.version !== j.version)
    throw fail('原节点已移除或修改，不能把旧检查点用于新版本', 409);
  if (d.images.some(image => image.sourceJobId === j.id))
    throw fail('该任务已有结果节点，不能再次恢复并重复回传', 409);
  if (jobs().some(other => other.id !== j.id && other.documentId === j.documentId &&
      other.imageId === j.imageId && ['running', 'queued', 'waiting_codex'].includes(other.status)))
    throw fail('该节点已有其他待处理任务，请先完成或取消后再恢复', 409);
  const folder = path.join(dir(j.documentId), 'jobs', j.id);
  const fileExists = (file: unknown) => {
    try { return typeof file === 'string' && fs.statSync(file).isFile(); } catch { return false; }
  };
  const generation = generationState(j);
  const registered = generation.outputs.filter(output =>
    fileExists(output.originalPath) && fileExists(output.workingPath) &&
    generation.requests.some(request => request.id === output.requestId));
  const staged = json<Layer[]>(path.join(folder, 'staged-layers.json'), []).filter(layer => {
    try { return !layer.preview && !!layer.url && fileExists(assetPath(j.documentId, layer.url)); }
    catch { return false; }
  });
  const ps = j.type === 'photoshop' ? photoshopState(j) : undefined;
  const psMaterials = Object.values(ps?.materials || {}).filter(material => fileExists(material.path));
  const psInspection = !!ps?.inspection && fileExists(ps.inspection.psdPath);
  let nativePrepared: { path: string; hash: string; layerIds: string[]; plan: unknown } | undefined;
  if (req.body.nativeArtifactPath !== undefined) {
    if (j.type !== 'photoshop' || j.reconstructionVersion !== 3 || j.reconstructionWorkflowVersion !== 4 ||
        typeof req.body.nativeArtifactPath !== 'string' || !req.body.nativeArtifactPath.trim() || !ps?.plan)
      throw fail('nativeArtifactPath仅用于本次新v4 PS原生薄膜/实体几何准备文件恢复', 400);
    const plan = validatePhotoshopPlan(j, ps.plan), canvas = plan.canvas!;
    if (canvas.width * canvas.height > 1_500_000) throw fail('原生薄膜恢复工作画布不得超过150万像素', 400);
    const artifact = taskPsd(folder, req.body.nativeArtifactPath);
    const ready = nativeProgressLayers(fs.readFileSync(artifact), plan, canvas).filter(l => l.nativeFilm || l.nativeGeometry);
    if (!ready.length) throw fail('原生薄膜准备文件缺少匹配冻结配方的实际可编辑内容', 409);
    nativePrepared = { path: artifact, hash: fileHash(artifact), layerIds: ready.map(l => l.layerId), plan };
  }
  if (!registered.length && !staged.length && !psMaterials.length && !psInspection && !nativePrepared)
    throw fail('没有可恢复的登记原件、暂存图层或PS检查点；请重新发起任务', 409);
  const checkpoints = { registered: registered.length, staged: staged.length, psMaterials: psMaterials.length, psInspection,
    ...(nativePrepared ? { psNativePrepared: nativePrepared.layerIds.length } : {}) };
  const historyFile = path.join(folder, 'resume-history.json');
  const history = json<unknown[]>(historyFile, []);
  atomic(historyFile, [...history, { at: now(), from: j.status, reason, confirmedCancellation: j.status === 'cancelled', checkpoints,
    ...(nativePrepared ? { nativePrepared } : {}) }]);
  j.status = 'running';
  j.dispatch = { state: 'received', updatedAt: now() };
  j.message = '已从原任务检查点恢复；复用登记原件，继续检查和未完成步骤';
  res.json({ job: safeJob(saveJob(j)), checkpoints });
});
app.get('/api/jobs/:id/packet', internal, async (req, res) => {
  const j = getJob(String(req.params.id));
  if (String(req.query.taskId || '') !== j.taskId) throw fail('对话不匹配', 403);
  const sourcePath = assetPath(j.documentId, j.snapshot.status==='preview'?j.snapshot.source:j.snapshot.url||j.snapshot.source);
  const original = originalReference(j.documentId, j.snapshot);
  const originalSourcePath = original.path;
  const inputs = reconstructionInputs(j.documentId, j.snapshot, originalSourcePath);
  const layers = inputs.layers;
  const psPlan = j.type === 'photoshop' ? photoshopState(j).plan : undefined;
  const contract = frameContract(
    psPlan && !j.snapshot.layers.length
      ? {
          ...j,
          frameContractVersion: 1,
          snapshot: {
            ...j.snapshot,
            layers: psPlan.layers.map((l) => ({
              id: l.layerId,
              name: l.name,
              kind: 'plan' as const,
              preview: true as const,
              frame: scaledFrame(
                l.frame,
                j.snapshot.width / (psPlan.canvas?.width || j.snapshot.width),
                j.snapshot.height / (psPlan.canvas?.height || j.snapshot.height),
              ),
              ...l.frame,
              visible: true,
              opacity: 1,
              opinion: l.includes,
              disposition: 'rebuild' as const,
            })),
          },
        }
      : j,
    psPlan?.canvas ||
      (req.query.generationPlan ? JSON.parse(String(req.query.generationPlan)) : undefined),
  );
  const localReferences = await reconstructionCrops(j, contract, originalSourcePath, sourcePath);
  inputs.generationInputs.allowedImagePaths.push(
    ...localReferences.flatMap((r) => (r.path ? [r.path] : [])),
  );
  const packet = {
    cutout: cutoutPacket(j),
    executionScope: {
      imageId: j.imageId,
      nodeOnly: true,
      traverseAncestors: false,
      traverseDescendants: false,
      targetLayerIds: j.layerIds || layers.map((l) => l.id),
      preservedLayerIds: j.layerIds
        ? layers.filter((l) => !j.layerIds!.includes(l.id)).map((l) => l.id)
        : [],
    },
    webVector: await webVectorPacket(j),
    prompt: ['photoshop', 'illustrator'].includes(j.type)
      ? buildHandoffPrompt(j.type as 'photoshop' | 'illustrator')
      : undefined,
    job: safeJob(j),
    image: inputs.image,
    generationInputs: inputs.generationInputs,
    localReferences,
    generationProtocol: j.reconstructionVersion === 3 ? {
      version: j.reconstructionWorkflowVersion||3, pixelBudget: 1500000, tool: 'canvas_generation',
      instruction: j.reconstructionWorkflowVersion===4 ? '先读RECONSTRUCTION.md。普通任务先layout列出全部目标层元素唯一归属、排除项、参考anchors和接触/遮挡relations；PS在plan内填写。独立层可分别prepare和生成，返回立即register保存检查点；有遮挡/接触关系的层按组composite检查，最终统一review及整图验收。不要为每个独立层重复读取完整项目或编写临时脚本。150万预算含承载画幅留白；frame是设计边界，placementFrame是完整素材实际放置边界。align只能引用冻结anchorNames，不能迁就输出改参考目标。review须evidence三项具体观察和真实candidateIds；错误API不算纠正。最后composite及review-composite覆盖所有层和relations再complete。PS先原素材合成并inspect/review通过，再upscale-material、重新置入和审核。' : '每层prepare→image_gen→register原件→检查→review→complete；旧任务保持兼容。',
      state: generationSummary(j),
    } : undefined,
    reviewPolicy: ['layer', 'revise', 'photoshop'].includes(j.type)
      ? RECONSTRUCTION_REVIEW_POLICY
      : undefined,
    photoshop: j.type === 'photoshop' ? photoshopPacket(j) : undefined,
    frameContract: contract,
    stagedLayers: json<Layer[]>(
      path.join(dir(j.documentId), 'jobs', j.id, 'staged-layers.json'),
      [],
    ).map((l) => ({
      ...l,
      originalPath: l.generationSourceUrl
        ? assetPath(j.documentId, l.generationSourceUrl)
        : undefined,
      adaptedPath: l.url ? assetPath(j.documentId, l.url) : undefined,
      note: '仅文件与几何检查通过，未证明视觉一致性；完成时提交originalPath、sourceCrop和sourceLayerIds，不把已适配文件当原始生成文件',
    })),
    sourcePath,
    originalSourcePath,
    originalReference: original,
    referencePolicy: j.type === 'photoshop' ? PHOTOSHOP_REFERENCE_POLICY : RECONSTRUCTION_POLICY,
    nativePsdPath:
      j.snapshot.nativePsd && j.snapshot.psdSource
        ? assetPath(j.documentId, j.snapshot.psdSource)
        : undefined,
    layers,
    annotations: j.snapshot.annotations,
    coordinateAnnotations: await annotationPacket(
      j.snapshot,
      path.join(dir(j.documentId), 'jobs', j.id),
    ),
    annotationContract: {
      space: 'image-pixels',
      origin: 'top-left',
      artworkContainsMarks: false,
      maskSupport: '独立选区；生成工具不支持蒙版时只能作为定位参考，不能宣称硬约束',
    },
    globalOpinion: j.snapshot.opinion,
    outputDirectory: path.join(dir(j.documentId), 'jobs', j.id),
    planningContract:
      j.type === 'plan'
        ? {
            mode: j.mode === 3 ? 'bounds-only' : 'local-cutout',
            generationAllowed: false,
            occlusionPolicy:
              '按真实遮挡关系规划，不只按语义类别分组。远景与遮挡人物/产品的前景桌面不能同放最底层；同一类内容若分别位于某物体前后，应拆开。检查台面接触、人物/衣物下沿、反射、细弧线和独立光效，避免漏层形成直线截断。',
            instruction:
              j.mode === 3
                ? '只查看干净图片并提交名称、box、role、意见和底到顶顺序。严禁调用 image_gen 或生成任何预览图片；用户确认后才真实重建。'
                : '提交名称、box、role；服务运行所选本地模型。不要调用生图工具。',
          }
        : undefined,
    localTools:
      j.type === 'plan' && j.mode !== 3
        ? { worker: path.join(ROOT, 'python', 'worker.py') }
        : undefined,
    requirements: [
      '每次调用 Codex 生图/编辑或 Adobe 重建时，将 referencePolicy 的一致性原则与本次作用域意见一起传入，并引用实际原图和当前节点/图层素材',
      '仅处理当前 imageId 节点；允许只读 originalSourcePath 辅助参考，不执行上下游节点任务，不继承上游标注或修改意见',
      '以当前节点及已确认修改为基准，本次意见优先；最初原图只辅助保持未改内容一致，禁止因此撤回已确认修改',
      '已确认正确的最终保留图层保持像素或原生结构；粗抠和精细抠图预览都只作参考，不锁定其像素或蒙版；所有意见和标注须逐项处理',
      '使用干净原图和图片局部坐标/独立选区理解修改位置；箭头文字不烧录进原图，不把标注截图作为实际编辑素材',
      '预分层不调用生图：方案3只提交无像素的对象规划框；方案2/4/5由本地模型提供透明预览，不以矩形截图冒充抠图。手动新建层也只有规划框。确认后才执行真实重建',
      '真实分层须补全被遮挡区域；原图文字能重建时保留可编辑文字与原生效果',
      '最终矢量图不得嵌入位图；不得将 SVG 改扩展名伪装成 AI',
      '操作 PS/AI 前验证当前环境的真实桌面控制能力；输出后核验可导入文件',
      '不要另开 Codex 对话或调用单独 OpenAI API；在当前对话使用可用 image_gen 工具',
    ],
  };
  fs.mkdirSync(packet.outputDirectory, { recursive: true });
  atomic(path.join(packet.outputDirectory, 'handoff.json'), packet);
  res.json(packet);
});
async function trackedCutout<T>(
  j: Job,
  operation: (runner: typeof worker) => Promise<T>,
): Promise<T> {
  if (aborters.has(j.id)) throw fail('此任务正在处理，请等待结果', 409);
  const controller = new AbortController();
  aborters.set(j.id, controller);
  try {
    return await operation((args) => (app.locals.cutoutWorker || worker)(args, controller.signal));
  } finally {
    aborters.delete(j.id);
  }
}
app.post('/api/jobs/:id/cutouts', internal, async (req, res) => {
  const j = boundJob(req);
  imageFor(j);
  res.json(await trackedCutout(j, (runner) => prepareCutouts(j, req.body, runner)));
});
app.post('/api/jobs/:id/web-vector', internal, async (req, res) => {
  const j = boundJob(req, req.body.action === 'download');
  res.json(await codexWebAction(j, req.body));
});
app.post('/api/jobs/:id/plan', internal, async (req, res) => {
  const j = boundJob(req);
  if (j.type !== 'plan') throw fail('不是预分层任务');
  if (j.status !== 'running') throw fail('请先领取预分层任务', 409);
  imageFor(j);
  if (req.body.baseVersion !== j.version) throw fail('版本不匹配', 409);
  const items = req.body.layers;
  if (!Array.isArray(items) || !items.length || items.length > 100)
    throw fail('请提供建议图层列表');
  const out = path.join(dir(j.documentId), 'jobs', j.id);
  fs.mkdirSync(out, { recursive: true });
  let result: any;
  if (j.mode === 3) {
    if (items.some((l: any) => l.path || l.url || l.svg || l.previewUrl))
      throw fail('Codex 预分层只接收对象名称和画幅框，不能提交生成预览图片；请在确认重建后生成');
    const planned = items.map((l: any) => {
      if (!Array.isArray(l.box) || l.box.length !== 4)
        throw fail('需要图片像素坐标的 x,y,width,height');
      const frame = frameSchema.parse({
        x: l.box[0],
        y: l.box[1],
        width: l.box[2],
        height: l.box[3],
      });
      if (typeof l.name !== 'string' || !l.name.trim() || l.name.length > 300)
        throw fail('请为规划图层填写对象名称（最多300字）');
      if (l.role && !['foreground', 'background'].includes(l.role)) throw fail('图层角色无效');
      return planningLayer(
        uid(),
        l.name.trim(),
        frame,
        l.role || 'foreground',
        String(l.opinion || '').slice(0, 20000),
      );
    });
    result = { layers: planned };
  } else {
    const boxes = items.map((l: any) => ({
      name: String(l.name || '图层'),
      box: l.box,
      kind: l.role === 'background' ? 'background' : undefined,
    }));
    for (const b of boxes)
      if (
        !Array.isArray(b.box) ||
        b.box.length !== 4 ||
        b.box.some((n: any) => !Number.isFinite(n)) ||
        b.box[2] <= 0 ||
        b.box[3] <= 0
      )
        throw fail('需要原图坐标的 x,y,width,height');
    const boxFile = path.join(out, 'boxes.json');
    atomic(boxFile, boxes);
    j.message = '本地模型正在生成透明预分层缩略图';
    saveJob(j);
    result = await trackedCutout(j, (runner) => runLocalCutouts(j, boxes, out, runner));
  }
  if (getJob(j.id).status === 'cancelled') return res.json(safeJob(getJob(j.id)));
  const { d, im } = imageFor(j);
  const newLayers = [];
  for (const [index, l] of result.layers.entries())
    newLayers.push(
      j.mode === 3
        ? l
        : await layerFromFile(
            d.id,
            {
              ...l,
              name: items[index]?.name || l.name,
              role: items[index]?.role || 'foreground',
              cutoutBox: items[index]?.box,
              opinion: items[index]?.opinion || '',
              disposition: 'rebuild',
              preview: true,
            },
            im,
          ),
    );
  im.layers = preserveLayerIdentity(im, newLayers).map((l) => ({ ...l, frame: layerFrame(l, im) }));
  im.status = 'preview';
  const committed = commitImage(j, im);
  j.status = 'completed';
  j.message =
    j.mode === 3
      ? '图层框规划已完成，未生成图片；请调整后确认重建'
      : '预分层已生成，请检查图层归属和顺序后确认分层';
  j.result = { ...((j.result as object) || {}), warnings: result.warnings || [] };
  saveJob(j);
  res.json({ job: safeJob(j), document: committed });
});
app.post('/api/jobs/:id/apply', internal, async (req, res) => {
  const j = boundJob(req);
  const derivedIds = Array.isArray(req.body.layers) ? req.body.layers.map((l: { generationId?: string }) => l.generationId).filter(Boolean) : [];
  await prepareGeneratedRoleConsumer(j, derivedIds);
  const derivedConsumer = captureDerivedConsumer(j, derivedIds);
  if (['cutout', 'upscale'].includes(j.type))
    throw fail('本地图片任务由模型回传，不能作为生成分层任务提交', 409);
  if (req.body.stageOnly !== undefined && typeof req.body.stageOnly !== 'boolean')
    throw fail('暂存标记必须是布尔值');
  if (j.type === 'plan')
    throw fail('预分层只接收图层规划，请通过 canvas_apply_plan 提交；确认重建后才能回传真实产物');
  if (
    req.body.stageOnly &&
    (!j.frameContractVersion ||
      !Array.isArray(req.body.layers) ||
      req.body.artifactPath ||
      req.body.vectorSvg)
  )
    throw fail('暂存仅适用于有冻结画幅的真实图层文件');
  if (isCodexWeb(j)) throw fail('网页矢量任务请通过 canvas_web_vector 回传，以保持图层对应关系');
  if (req.body.baseVersion !== j.version) throw fail('版本不匹配', 409);
  imageFor(j);
  if (j.type === 'photoshop') {
    if (j.status !== 'running' || req.body.stageOnly) throw fail('PS重建需运行中的完整结果回传');
    const { image, review } = await completePhotoshop(j, String(req.body.artifactPath || ''));
    const document = commitImage(j, image);
    j.status = 'completed';
    j.message = review.pending
      ? `PS结果已返回；${review.pending}个图层已标红待修改`
      : 'PS分层重建与检查已完成，结果已返回画布';
    j.result = { ...((j.result as object) || {}), artifactUrl: image.psdSource, review };
    saveJob(j);
    return res.json({ job: safeJob(j), document });
  }
  let resultLayers: Layer[] | undefined;
  let reviewSummary: { pending: number; unreviewed: number } | undefined;
  let artifactUrl: string | undefined;
  let outputWidth = req.body.width,
    outputHeight = req.body.height;
  if (req.body.artifactPath) {
    const p = String(req.body.artifactPath);
    if (!path.isAbsolute(p) || !fs.statSync(p).isFile()) throw fail('产物路径无效');
    const ext = path.extname(p).toLowerCase();
    if (ext === '.ai') {
      const bytes = fs.readFileSync(p);
      if (
        !bytes
          .subarray(0, 1024)
          .toString()
          .match(/%PDF|%!PS-Adobe/) ||
        !bytes
          .toString('latin1')
          .match(/\/AIPrivateData|%%Creator:[^\r\n]*Illustrator|%AI\d+_CreatorVersion/)
      )
        throw fail('AI 文件不是有效的 PDF/PS 兼容 Illustrator 文件');
      artifactUrl = writeAsset(j.documentId, bytes, '.ai');
    } else if (['.psd', '.svg'].includes(ext)) {
      const imported = await importImage(load(j.documentId), fs.readFileSync(p), path.basename(p));
      resultLayers = imported.layers;
      outputWidth = imported.width;
      outputHeight = imported.height;
      if (imported.psdSource) req.body.psdSource = imported.psdSource;
    } else throw fail('外部交接需要 PSD、SVG 或真实 AI 文件');
  }
  if (req.body.layers) {
    if (!Array.isArray(req.body.layers) || !req.body.layers.length || req.body.layers.length > 300)
      throw fail('没有有效的图层产物');
    if (req.body.layers.some((l: any) => l?.preview === true || l?.kind === 'plan'))
      throw fail('抠图预览仅供分层与标注参考，请先重建并验证最终图层');
    resultLayers = [];
    for (const l of req.body.layers)
      resultLayers.push(
        await layerFromFile(
          j.documentId,
          j.frameContractVersion
            ? { ...l, frame: { x: l.x ?? 0, y: l.y ?? 0, width: l.width, height: l.height } }
            : l,
          {
            ...j.snapshot,
            width: req.body.width || j.snapshot.width,
            height: req.body.height || j.snapshot.height,
          },
        ),
      );
  }
  if (req.body.vectorSvg) {
    resultLayers = [
      await layerFromFile(j.documentId, { name: '矢量图', svg: req.body.vectorSvg }, j.snapshot),
    ];
    outputWidth ??= resultLayers[0].width;
    outputHeight ??= resultLayers[0].height;
  }
  if (outputWidth !== undefined || outputHeight !== undefined)
    checkDimensions(outputWidth, outputHeight);
  if (
    j.layerIds?.length &&
    !j.preserveKeptLayers &&
    ((outputWidth !== undefined && outputWidth !== j.snapshot.width) ||
      (outputHeight !== undefined && outputHeight !== j.snapshot.height))
  )
    throw fail('局部修改不能改变整图尺寸；请对总图提交尺寸修改以保持全部图层同步');
  if (resultLayers) {
    await rejectPreviewReuse(j, resultLayers);
    resultLayers = await normalizeFramedResults(
      j,
      resultLayers,
      outputWidth ?? j.snapshot.width,
      outputHeight ?? j.snapshot.height,
      req.body.stageOnly === true,
    );
  }
  if (resultLayers && new Set(resultLayers.map((l) => l.id)).size !== resultLayers.length)
    throw fail('图层 ID 不可重复');
  if (!resultLayers)
    throw fail(
      artifactUrl
        ? '原生 AI 文件还需同时提供 SVG 或矢量图层，才能验证并返回画布节点'
        : '完成任务必须提交实际产物',
    );
  if (req.body.stageOnly === true) {
    imageFor(j);
    verifyDerivedConsumer(j, derivedConsumer, derivedIds);
    return res.json({
      staged: true,
      completed: false,
      layers: resultLayers,
      message: '图层已暂存；请检查适配图与整体对齐，全部完成后再正式回传',
    });
  }
  if(j.reconstructionWorkflowVersion===4&&['layer','revise'].includes(j.type))
    requireCompositeApproval(j,resultLayers.map(l=>l.generationId!),generationState(j));
  let { d, im } = imageFor(j);
  if (resultLayers) {
    const toVector = j.useVectorLayers || j.type === 'illustrator' || !!req.body.vectorSvg;
    if (toVector) im.layers = im.vectorLayers || im.layers;
    if (outputWidth !== undefined || outputHeight !== undefined) {
      checkDimensions(outputWidth, outputHeight);
      const sx = outputWidth / im.width,
        sy = outputHeight / im.height;
      if (j.preserveKeptLayers) {
        im.layers = im.layers.map((l) => {
          if (j.layerIds!.includes(l.id)) return l;
          const next = {
            ...l,
            ...scaledFrame(l, sx, sy),
            frame: scaledFrame(layerFrame(l, im), sx, sy),
          };
          if (next.text)
            next.text = {
              ...next.text,
              x: next.text.x * sx,
              y: next.text.y * sy,
              fontSize: next.text.fontSize * Math.sqrt(sx * sy),
            };
          return next;
        });
      }
      im.annotations = im.annotations.map((a) => ({
        ...a,
        points: a.points.map((v, i) => v * (i % 2 ? sy : sx)),
        labelPosition: a.labelPosition
          ? [a.labelPosition[0] * sx, a.labelPosition[1] * sy]
          : undefined,
        brushSize: a.brushSize ? a.brushSize * Math.sqrt(sx * sy) : undefined,
      }));
      im.width = outputWidth;
      im.height = outputHeight;
    }
    const mergedSources = new Map(
      j.frameContractVersion
        ? resultLayers.flatMap((l) => (l.sourceLayerIds || [l.id]).map((id) => [id, l.id] as const))
        : [],
    );
    if (j.frameContractVersion) {
      im.annotations = im.annotations.map((a) => ({
        ...a,
        layerId: a.layerId ? mergedSources.get(a.layerId) || a.layerId : null,
      }));
    }
    if (j.layerIds?.length) {
      const replacements = new Map(resultLayers.map((l) => [l.id, l]));
      if (resultLayers.some((l) => !j.layerIds!.includes(l.id)))
        throw fail('局部修改必须保持选中图层 ID');
      im.layers = im.layers.flatMap((l) =>
        replacements.has(l.id)
          ? [{ ...replacements.get(l.id)!, opinion: replacements.get(l.id)!.opinion || l.opinion }]
          : mergedSources.has(l.id)
            ? []
            : [l],
      );
    } else if (j.frameContractVersion) {
      im.layers = resultLayers;
    } else im.layers = preserveLayerIdentity(im, resultLayers);
    im.layers.forEach((l) => {
      if (!j.frameContractVersion || resultLayers!.some((r) => r.id === l.id)) l.preview = false;
    });
    if (toVector) {
      if (im.layers.some((l) => l.kind !== 'vector' && l.kind !== 'text'))
        throw fail('矢量结果必须全部为矢量或可编辑文字，不接受混合位图');
      im.vectorLayers = im.layers;
      im.layers = im.vectorLayers;
    } else {
      im.vectorLayers = undefined;
      im.vectorUrl = undefined;
    }
    im.status = im.layers.some((l) => l.preview)
      ? 'preview'
      : (toVector ? im.vectorLayers! : im.layers).every(
            (l) => l.kind === 'vector' || l.kind === 'text',
          )
        ? 'vector'
        : 'layered';
    im.psdSource = req.body.psdSource;
    if (['layer', 'revise'].includes(j.type))
      reviewSummary = applyLayerReviews(im, resultLayers, j.snapshot);
    im.artifactUrl = artifactUrl;
    if (im.status === 'vector')
      im.vectorUrl = writeAsset(d.id, Buffer.from(exportSvg(d.id, im)), '.svg');
    else im.vectorUrl = undefined;
    im.url = writeAsset(
      d.id,
      await renderImage(d.id, toVector ? { ...im, layers: im.vectorLayers! } : im),
      '.png',
    );
    if (im.status !== 'preview') im.source = im.url;
    verifyDerivedConsumer(j, derivedConsumer, derivedIds);
    d = commitImage(j, im);
  }
  if (getJob(j.id).status === 'cancelled') throw fail('请求已取消', 409);
  j.status = 'completed';
  j.message = String(req.body.message || '产物已返回画布');
  if (reviewSummary) {
    j.message += reviewSummary.pending ? `；${reviewSummary.pending} 个图层已标红待修改` : '';
    j.message += reviewSummary.unreviewed
      ? `；${reviewSummary.unreviewed} 个图层未提交视觉检查，保持重建状态`
      : '';
  }
  j.result = { ...((j.result as object) || {}), artifactUrl };
  saveJob(j);
  res.json({ job: safeJob(j), document: d });
});
let mattingQueue: Promise<void> = Promise.resolve();
function enqueueMattingJob(id: string) {
  queuedLocalWork++;
  mattingQueue = mattingQueue
    .then(() => (getJob(id).type === 'upscale' ? runUpscaleJob(id) : runMattingJob(id)))
    .catch(() => {})
    .finally(() => {
      queuedLocalWork--;
    });
}
export async function runMattingJob(id: string) {
  const j = getJob(id);
  if (j.type !== 'cutout' || j.status !== 'queued') return;
  const controller = new AbortController();
  aborters.set(id, controller);
  try {
    j.status = 'running';
    j.message = `正在使用 ${j.matting?.model === 'lucida' ? 'Lucida v7' : 'BiRefNet HR-matting'} 本地精细抠图 · 不消耗 Codex 额度`;
    saveJob(j);
    const result = await standaloneMatting(
      j,
      app.locals.mattingWorker || worker,
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (getJob(id).status !== 'running') return;
    commitImage(j, result.image);
    j.status = 'completed';
    j.message = `精细抠图已返回画布 · 不消耗 Codex 额度${result.warnings.length ? '；' + result.warnings.join('；') : ''}`;
    j.result = {
      ...(j.result as object),
      model: j.matting?.model,
      execution: result.execution,
      seconds: result.seconds,
    };
    saveJob(j);
  } catch (e: any) {
    if (getJob(id).status !== 'cancelled') {
      j.status = 'failed';
      j.message = `精细抠图失败：${String(e.message).slice(0, 1800)}。原图片已保留；可检查模型安装、尝试另一模型或切换 CPU。`;
      saveJob(j);
    }
  } finally {
    aborters.delete(id);
  }
}
export async function runUpscaleJob(id: string) {
  const j = getJob(id);
  if (j.type !== 'upscale' || j.status !== 'queued') return;
  const controller = new AbortController();
  aborters.set(id, controller);
  try {
    j.status = 'running';
    j.message = `正在使用 ${upscaleModelName(j.upscale)} 本地超分 · 不消耗 Codex 额度`;
    saveJob(j);
    const result = await upscaleImage(
      j,
      app.locals.upscaleWorker || worker,
      controller.signal,
      (message) => {
        if (getJob(id).status === 'running') {
          j.message = message + ' · 本地执行，不消耗 Codex 额度';
          saveJob(j);
        }
      },
    );
    controller.signal.throwIfAborted();
    if (getJob(id).status !== 'running') return;
    commitImage(j, result.image);
    j.status = 'completed';
    j.message = `超分已返回画布 · 不消耗 Codex 额度${result.warnings.length ? '；' + result.warnings.join('；') : ''}`;
    j.result = {
      ...(j.result as object),
      model: upscaleModelName(j.upscale),
      execution: result.execution,
      seconds: result.seconds,
    };
    saveJob(j);
  } catch (e: any) {
    if (getJob(id).status !== 'cancelled') {
      j.status = 'failed';
      j.message = `超分失败：${String(e.message).slice(0, 1800)}。原图片已保留；可检查模型安装、减小编解码分块或降低倍率。`;
      saveJob(j);
    }
  } finally {
    aborters.delete(id);
  }
}
let browserQueue: Promise<void> = Promise.resolve();
function enqueueVectorJob(id: string) {
  queuedLocalWork++;
  const execute = () =>
    runVectorJob(id).finally(() => {
      queuedLocalWork--;
    });
  if (getJob(id).engine === 'vectorizerCom') {
    browserQueue = browserQueue.then(execute).catch(() => {});
  } else void execute().catch(() => {});
}
export async function runVectorJob(id: string, browserFactory = () => new VectorizerBrowser()) {
  let browser: VectorizerBrowser | undefined;
  const controller = new AbortController();
  aborters.set(id, controller);
  let j = getJob(id);
  try {
    if (j.status !== 'queued') return;
    j.status = 'running';
    j.message = '正在逐层矢量化';
    saveJob(j);
    if (j.engine === 'vectorizerCom') {
      browser = browserFactory();
      await browser.open();
    }
    const { im } = imageFor(j);
    const baseLayers = j.useVectorLayers ? im.vectorLayers || im.layers : im.layers;
    const inputLayers =
      !j.useOriginal && baseLayers.length
        ? baseLayers
        : [
            {
              id: uid(),
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
    const output = path.join(dir(j.documentId), 'jobs', j.id);
    fs.mkdirSync(output, { recursive: true });
    const result: Layer[] = [];
    for (const [index, l] of inputLayers.entries()) {
      if (controller.signal.aborted) throw new Error('已取消');
      if (l.kind === 'plan') throw fail('规划框尚未重建，不能矢量化');
      if (j.layerIds?.length && !j.layerIds.includes(l.id)) continue;
      if (l.kind === 'vector' || (l.kind === 'text' && l.text)) {
        result.push(l);
        continue;
      }
      j.message = `正在矢量化 ${index + 1}/${inputLayers.length}：${l.name}`;
      saveJob(j);
      const input = path.join(output, `${index}.png`);
      fs.writeFileSync(
        input,
        await sharp(fs.readFileSync(assetPath(j.documentId, l.previewUrl || l.url)))
          .png()
          .toBuffer(),
      );
      const svg = browser
        ? await browser.convert(fs.readFileSync(input), controller.signal, (text) => {
            if (!controller.signal.aborted) {
              j.message = `${index + 1}/${inputLayers.length}：${l.name} · ${text}`;
              saveJob(j);
            }
          })
        : await vectorize(input, j.engine, controller.signal);
      controller.signal.throwIfAborted();
      fs.writeFileSync(path.join(output, `${index}.svg`), svg);
      const url = writeAsset(j.documentId, Buffer.from(svg), '.svg');
      result.push({
        ...l,
        url,
        svg: undefined,
        text: undefined,
        psdStyle: undefined,
        previewUrl: undefined,
        x: l.previewUrl ? 0 : l.x,
        y: l.previewUrl ? 0 : l.y,
        width: l.previewUrl ? im.width : l.width,
        height: l.previewUrl ? im.height : l.height,
        kind: 'vector',
        preview: false,
      });
    }
    if (controller.signal.aborted) return;
    const fresh = imageFor(j);
    fresh.im.vectorLayers = result;
    fresh.im.layers = result;
    fresh.im.annotations = fresh.im.annotations.filter(
      (a) => !a.layerId || result.some((l) => l.id === a.layerId),
    );
    const allVector = result.every((l) => l.kind === 'vector' || l.kind === 'text');
    fresh.im.status = allVector ? 'vector' : fresh.im.status;
    if (allVector)
      fresh.im.vectorUrl = writeAsset(
        j.documentId,
        Buffer.from(exportSvg(j.documentId, fresh.im)),
        '.svg',
      );
    fresh.im.url = writeAsset(
      j.documentId,
      await renderImage(j.documentId, { ...fresh.im, layers: result }),
      '.png',
    );
    fresh.im.source = fresh.im.url;
    fresh.im.psdSource = undefined;
    fresh.im.artifactUrl = undefined;
    commitImage(j, fresh.im);
    j.status = 'completed';
    j.message = '矢量化完成，已保留图层名称、位置和顺序';
    saveJob(j);
  } catch (e: any) {
    j = getJob(id);
    if (j.status !== 'cancelled') {
      j.status = 'failed';
      j.message = e.message;
      saveJob(j);
    }
  } finally {
    await browser?.close();
    aborters.delete(id);
  }
}
app.get('/api/document/:id/export', async (req, res) => {
  queuedLocalWork++;
  try {
    const d = load(String(req.params.id));
    const im = d.images.find((i) => i.id === req.query.imageId);
    const format = String(req.query.format);
    if (!im) throw fail('图片不存在');
    const filename = im.name.replace(/\.[^.]+$/, '').replace(/[\x00-\x1f"\\/]/g, '_');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename + '.' + (format === 'project' ? 'json' : format))}`,
    );
    if (im.mediaType === 'video' && !['mp4', 'project'].includes(format))
      throw fail('视频支持导出 MP4 或项目 JSON');
    if (format === 'mp4') {
      if (im.mediaType !== 'video' || !im.video || !im.artifactUrl)
        throw fail('请选择超分视频结果；原视频请使用原文件下载');
      res.type('video/mp4').sendFile(assetPath(d.id, im.artifactUrl));
    } else if (format === 'psd') {
      if (im.status === 'preview' || im.layers.some((l) => l.preview))
        throw fail('预分层不是真实分层，请先确认完成分层');
      if (!im.nativePsd && im.layers.some((l) => l.kind === 'vector'))
        res.setHeader('X-Canvas-Export-Notice', 'SVG layers are rasterized in this PSD; export SVG for editable vectors.');
      res.type('application/octet-stream').send(await exportPsd(d.id, im));
    } else if (format === 'png')
      res.type('png').send(
        req.query.view === 'original'
          ? await sharp(fs.readFileSync(assetPath(d.id, im.source)))
              .png()
              .toBuffer()
          : await renderImage(
              d.id,
              req.query.view === 'vector' ? { ...im, layers: im.vectorLayers || im.layers } : im,
            ),
      );
    else if (format === 'svg') res.type('image/svg+xml').send(exportSvg(d.id, im));
    else if (format === 'project') res.json(d);
    else throw fail('支持 PSD、SVG、PNG、项目 JSON；原生 AI 请交接 Illustrator');
  } finally {
    queuedLocalWork--;
  }
});
app.use(express.static(path.join(ROOT, 'dist')));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'dist', 'index.html')));
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status || (err.name === 'ZodError' ? 400 : 500);
  res
    .status(status)
    .json({ error: err.name === 'ZodError' ? '输入格式不正确' : err.message || '操作失败' });
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const releaseLock = acquireServiceLock(DATA);
  if (!releaseLock) {
    console.log('已有画布服务正在启动或运行，将复用该服务。');
  } else {
    process.once('exit', releaseLock);
    let attempts = 0;
    const listen = () => {
      const listener = app.listen(PORT, '127.0.0.1', () => {
        atomic(path.join(DATA, 'service.json'), {
          port: PORT,
          token: TOKEN,
          bridgeToken: BRIDGE_TOKEN,
          root: ROOT,
          pid: process.pid,
        });
        for (const j of jobs()) {
          if (j.status === 'waiting_codex' && !j.dispatch) {
            j.status = 'failed';
            j.message = '旧版请求未自动发送到对话；请重新点击功能按钮，原图及意见已保留';
            saveJob(j);
          }
          if (j.status === 'waiting_codex' && j.dispatch?.state === 'sending') {
            j.dispatch = {
              state: 'uncertain',
              updatedAt: now(),
              detail: '发送过程中服务重启，无法确认回执；不会自动重复发送',
            };
            j.message = '发送回执暂未确认';
            saveJob(j);
          }
          if (j.status === 'running' && isCodexWeb(j)) {
            j.webProgress = { ...j.webProgress, phase: 'blocked', updatedAt: now() };
            j.message = '服务已恢复；等待当前对话继续接收已有网页结果，已下载文件保留';
            saveJob(j);
            continue;
          }
          if (['running', 'queued'].includes(j.status)) {
            j.status = 'failed';
            j.message = '服务重启，任务未完成，请重试';
            saveJob(j);
          }
        }
        console.log(`Layer Canvas listening on http://127.0.0.1:${PORT}`);
        const tick = lifecycleGuard({
          owners: () => hasCanvasOwners(DATA),
          busy: () =>
            activeRequests > 0 || aborters.size > 0 || queuedLocalWork > 0 || dispatchBusy(),
          managed: process.env.LAYER_CANVAS_MANAGED === '1',
          stop: () => {
            clearInterval(timer);
            console.log('Codex 已退出，当前本地任务及请求已完成，画布服务安全停止。');
            // Keep service.json (port/token) and every document for the next launch.
            listener.close(() => process.exit(0));
            listener.closeIdleConnections();
          },
        });
        const timer = setInterval(() => void tick(), 5000);
        timer.unref();
        void tick();
      });
      listener.on('error', async (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          try {
            const response = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
              signal: AbortSignal.timeout(5000),
            });
            const health = await response.json();
            if (response.ok && health.instanceId === serviceIdentity(ROOT, DATA)) return;
          } catch {
            /* a different app may occupy this port */
          }
        }
        if (
          error.code === 'EADDRINUSE' &&
          !process.env.LAYER_CANVAS_PORT &&
          attempts++ < 20 &&
          PORT < 65535
        ) {
          PORT++;
          listen();
        } else {
          console.error(
            error.code === 'EADDRINUSE'
              ? '指定画布端口已被占用，请更换 LAYER_CANVAS_PORT；未停止其他程序。'
              : error.message,
          );
          process.exitCode = 1;
        }
      });
    };
    listen();
  }
}
