import { Mark, ToolIcon, type Tool } from './CanvasMarks';
import { planningLayer } from '../shared/planning';
import { LayerFrame } from './LayerFrame';
import { GenerationHint } from './GenerationHint';
import {
  layerFrame,
  suggestedFrame,
  resizeFrame,
  type LayerFrame as Frame,
  type FrameHandle,
} from '../shared/layer-frame';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { api, ApiError, download } from './api';
import TextProperties from './TextProperties';
import ModelStatus from './ModelStatus';
import { mergeConcurrent, reconcileSaved } from './reconcile';
import { connectionPath, imagePoint, labelPoint } from './canvasGeometry';
import { engines } from './vectorProviders';

import AdobeSettings from './AdobeSettings';
import PsdSettings from './PsdSettings';
import { PSD_MODES as modes, type PsdMode, type CutoutOptions } from '../shared/cutout';
import AnnotationStyle, { defaultStyle, type MarkStyle } from './AnnotationStyle';
import type { Annotation, CanvasDocument, CanvasImage, Job, ServiceSettings } from './types';

const clone = <T,>(value: T): T => structuredClone(value);
const uid = () => crypto.randomUUID();
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const statusText = { original: '原图', preview: '预分层', layered: '已分层', vector: '矢量' };
const jobNames: Record<Job['type'], string> = {
  plan: '预分层',
  layer: '确认分层',
  revise: '修改',
  vectorize: '矢量化',
  photoshop: '交接 Photoshop',
  illustrator: '交接 Illustrator',
};
const jobStatus: Record<Job['status'], string> = {
  queued: '排队中',
  waiting_codex: '等待当前 Codex 对话',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
const jobLabel = (j: Job) =>
  j.status === 'running' &&
  j.webProgress?.phase === 'working' &&
  Date.now() - Date.parse(j.webProgress.updatedAt) > 300000
    ? '暂未更新'
    : j.status === 'running' && j.webProgress?.phase === 'verification'
      ? '等待网页验证'
      : j.status === 'running' && j.webProgress?.phase === 'blocked'
        ? '下载受阻'
        : j.status === 'waiting_codex' && j.dispatch
          ? {
              sending: '正在发送',
              sent: '已发送',
              received: '已接收',
              failed: '发送失败',
              uncertain: '回执未确认',
            }[j.dispatch.state]
          : jobStatus[j.status];
type View = { x: number; y: number; scale: number };
type CanvasViewState = View & { selectedImageId: string | null };
type Gesture =
  | {
      kind: 'frame';
      imageId: string;
      layerId: string;
      frame: Frame;
      handle: FrameHandle;
      start: number[];
      scale: number;
    }
  | { kind: 'pan'; start: number[]; view: View }
  | { kind: 'marquee'; start: number[]; base: string[] }
  | {
      kind: 'move';
      origins: { id: string; x: number; y: number }[];
      start: number[];
      scale: number;
    }
  | { kind: 'label'; imageId: string; markId: string; offset: [number, number] }
  | { kind: 'annotation'; imageId: string; item: Annotation };

export default function App() {
  const taskId = new URLSearchParams(location.search).get('taskId') || '';
  const [doc, setDoc] = useState<CanvasDocument | null>(null);
  const docRef = useRef<CanvasDocument | null>(null);
  const serverBase = useRef<CanvasDocument | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState('已保存');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const setSelectedId = (id: string | null) => setSelectedIds(id ? [id] : []);
  const [marquee, setMarquee] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [selectionModifier, setSelectionModifier] = useState(false);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const [layerId, setLayerId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [toolStyles, setToolStyles] = useState<Record<Annotation['type'], MarkStyle>>(
    () =>
      Object.fromEntries(
        (['arrow', 'ellipse', 'box', 'pen', 'text'] as const).map((type) => [
          type,
          defaultStyle(type),
        ]),
      ) as Record<Annotation['type'], MarkStyle>,
  );
  const [showOriginal, setShowOriginal] = useState(false);
  const [original, setOriginal] = useState<{
    imageId: string;
    url: string;
    complete: boolean;
  } | null>(null);
  const [view, setView] = useState<View>({ x: 80, y: 80, scale: 0.6 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [viewHydrated, setViewHydrated] = useState(false);
  const [draft, setDraft] = useState<{ imageId: string; item: Annotation } | null>(null);
  const [selectedMarkId, setSelectedMarkId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const previousJobStates = useRef(new Map<string, Job['status']>());
  const pendingResultFocus = useRef<
    { sourceId: string; imageId: string; mode: 'vector' | 'layers' } | undefined
  >(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('psd');
  const [settings, setSettings] = useState<ServiceSettings | null>(null);
  const [credentials, setCredentials] = useState({
    recraftKey: '',
    api302Key: '',
    vectorizerId: '',
    vectorizerSecret: '',
  });
  const [jobListOpen, setJobListOpen] = useState(false);

  const [draggingFiles, setDraggingFiles] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const dragLayer = useRef<string | null>(null);
  const pending = useRef(false);
  const editSerial = useRef(0);
  const savePromise = useRef<Promise<void> | null>(null);
  const undoStack = useRef<CanvasDocument[]>([]);
  const redoStack = useRef<CanvasDocument[]>([]);
  const editingGroup = useRef('');
  const space = useRef(false);
  const layersFor = (i: CanvasImage) =>
    i.status === 'vector' && i.vectorLayers ? i.vectorLayers : i.layers;
  const image = doc?.images.find((x) => x.id === selectedId);
  const viewMode = image?.status === 'vector' ? 'vector' : 'layers';
  useEffect(() => {
    setShowOriginal(false);
    setOriginal(null);
    if (!doc?.id || !selectedId) return;
    let active = true;
    api<{ url: string; complete: boolean }>(
      `/api/document/${doc.id}/images/${selectedId}/reference`,
    )
      .then((r) => {
        if (active) setOriginal({ ...r, imageId: selectedId });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [doc?.id, selectedId]);
  const displayedLayers = image ? layersFor(image) : [];
  const selectedLayer = displayedLayers.find((x) => x.id === layerId);
  const activeJobs = jobs.filter((j) => ['queued', 'waiting_codex', 'running'].includes(j.status));
  const selectedAnnotation = image?.annotations.find(
    (a) => a.id === selectedMarkId && a.layerId === layerId,
  );
  const annotationTags = image?.annotations.filter((a) => !layerId || a.layerId === layerId) || [];

  const accept = useCallback((value: CanvasDocument) => {
    docRef.current = value;
    setDoc(value);
  }, []);
  const checkpoint = () => {
    if (docRef.current) {
      undoStack.current.push(clone(docRef.current));
      if (undoStack.current.length > 60) undoStack.current.shift();
      redoStack.current = [];
      setUndoCount(undoStack.current.length);
      setRedoCount(0);
    }
  };
  const change = (fn: (d: CanvasDocument) => void, history = true) => {
    if (busy || !docRef.current) return;
    if (history) {
      checkpoint();
      editingGroup.current = '';
    }
    const next = clone(docRef.current);
    fn(next);
    editSerial.current++;
    pending.current = true;
    accept(next);
    setSaveState('待保存');
  };
  const changeImage = (fn: (i: CanvasImage) => void, history = true) =>
    change((d) => {
      const i = d.images.find((i) => i.id === selectedId);
      if (i) fn(i);
    }, history);
  const deleteImages = () => {
    if (busy || !selectedIds.length) return;
    const removed = new Set(selectedIds);
    change((d) => {
      d.images = d.images.filter((i) => !removed.has(i.id));
    });
    setSelectedIds([]);
    setSelectedMarkId(null);
    setLayerId(null);
    setNotice(`已删除 ${removed.size} 张图片，可撤销；其他节点保留`);
  };
  const deleteAnnotation = (id: string) => {
    changeImage((i) => {
      i.annotations = i.annotations.filter((a) => a.id !== id);
    });
    if (selectedMarkId === id) setSelectedMarkId(null);
  };
  const flush = useCallback(async (): Promise<void> => {
    if (savePromise.current) {
      await savePromise.current;
      if (pending.current) await flush();
      return;
    }
    if (!pending.current || !docRef.current) return;
    let snapshot = clone(docRef.current);
    const originalSnapshot = clone(snapshot);
    const serial = editSerial.current;
    const work = (async () => {
      setSaveState('保存中…');
      let result: CanvasDocument;
      try {
        result = await api<CanvasDocument>(`/api/document/${snapshot.id}`, {
          method: 'PUT',
          body: JSON.stringify({ document: snapshot, expectedRevision: snapshot.revision }),
        });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || !serverBase.current)
          throw error;
        const latest = await api<CanvasDocument>(
          `/api/document?taskId=${encodeURIComponent(snapshot.taskId)}`,
        );
        const merged = mergeConcurrent(serverBase.current, snapshot, latest);
        if (merged.conflicts.length)
          throw new Error(
            `有同时修改的内容，已保留本地草稿，尚未覆盖：${merged.conflicts.join('、')}。请先下载未保存草稿。`,
          );
        snapshot = { ...merged.value, revision: latest.revision };
        result = await api<CanvasDocument>(`/api/document/${snapshot.id}`, {
          method: 'PUT',
          body: JSON.stringify({ document: snapshot, expectedRevision: latest.revision }),
        });
      }
      serverBase.current = clone(result);
      if (editSerial.current === serial) {
        accept(result);
        pending.current = false;
        setSaveState('已保存');
      } else {
        if (docRef.current)
          accept({
            ...reconcileSaved(originalSnapshot, docRef.current, result),
            revision: result.revision,
          });
        setSaveState('待保存');
      }
    })();
    savePromise.current = work;
    try {
      await work;
    } catch (e) {
      setSaveState('保存失败');
      setError(String(e));
      throw e;
    } finally {
      savePromise.current = null;
    }
  }, [accept]);

  useEffect(() => {
    if (!taskId) {
      setLoadError('画布尚未绑定当前 Codex 对话。请在 Codex 中打开分层画布。');
      return;
    }
    setViewHydrated(false);
    api<CanvasDocument>(`/api/document?taskId=${encodeURIComponent(taskId)}`)
      .then(async (d) => {
        serverBase.current = clone(d);
        accept(d);
        const restored = await api<CanvasViewState | null>(
          `/api/document/${d.id}/view-state`,
        ).catch(() => null);
        const selected =
          restored?.selectedImageId && d.images.some((i) => i.id === restored.selectedImageId)
            ? restored.selectedImageId
            : null;
        setSelectedId(selected);
        setLayerId(null);
        setSelectedMarkId(null);
        if (restored) {
          setView({ x: restored.x, y: restored.y, scale: restored.scale });
          setViewHydrated(true);
        } else
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              fit();
              setViewHydrated(true);
            }),
          );
        setNotice(d.images.length ? `已恢复 ${d.images.length} 个节点` : '已打开当前对话画布');
      })
      .catch((e) =>
        setLoadError(
          e instanceof ApiError && e.status === 401
            ? '画布访问凭证已失效。请回到当前 Codex 对话说“打开分层画布”以重新连接，历史不会丢失。'
            : String(e),
        ),
      );
    api<ServiceSettings>('/api/settings')
      .then(setSettings)
      .catch(() => {});
  }, [taskId, accept]);
  useEffect(() => {
    if (!doc?.id || !viewHydrated) return;
    const timer = setTimeout(() => {
      api<CanvasViewState>(`/api/document/${doc.id}/view-state`, {
        method: 'PUT',
        body: JSON.stringify({ ...view, selectedImageId: selectedId }),
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [doc?.id, view.x, view.y, view.scale, selectedId, viewHydrated]);
  useEffect(() => {
    if (!pending.current) return;
    const timer = setTimeout(() => {
      if (!gesture.current) flush().catch(() => {});
    }, 650);
    return () => clearTimeout(timer);
  }, [doc, flush]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (pending.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  useEffect(() => {
    if (!doc?.id) return;
    let stopped = false;
    const poll = async () => {
      try {
        const list = await api<Job[]>(`/api/document/${doc.id}/jobs`);
        if (stopped) return;
        setJobs(list);
        for (const job of list) {
          const prev = previousJobStates.current.get(job.id);
          if (
            job.status === 'completed' &&
            prev &&
            prev !== 'completed' &&
            job.imageId === selectedIdRef.current &&
            typeof job.result?.imageId === 'string'
          )
            pendingResultFocus.current = {
              sourceId: job.imageId,
              imageId: job.result.imageId,
              mode: job.type === 'vectorize' ? 'vector' : 'layers',
            };
          previousJobStates.current.set(job.id, job.status);
        }
        if (!pending.current && !savePromise.current && !gesture.current) {
          const d = await api<CanvasDocument>(`/api/document?taskId=${encodeURIComponent(taskId)}`);
          if (!stopped && !pending.current && !savePromise.current) {
            if (d.revision > (docRef.current?.revision ?? -1)) {
              serverBase.current = clone(d);
              accept(d);
              undoStack.current = [];
              redoStack.current = [];
              setUndoCount(0);
              setRedoCount(0);
            }
            const focus = pendingResultFocus.current;
            if (focus) {
              const result = d.images.find((i) => i.id === focus.imageId);
              if (selectedIdRef.current !== focus.sourceId) pendingResultFocus.current = undefined;
              else if (result) {
                setSelectedId(result.id);
                setShowOriginal(false);
                setLayerId(null);
                fit(result);
                pendingResultFocus.current = undefined;
              }
            }
          }
        }
      } catch (e) {
        if (!stopped) setNotice(`服务连接暂不可用：${String(e)}`);
      }
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [doc?.id, taskId, accept]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    editingGroup.current = '';
  }, [selectedId, layerId]);
  useEffect(() => {
    if (image && layerId && !layersFor(image).some((l) => l.id === layerId)) setLayerId(null);
  }, [image, layerId, viewMode]);

  const undo = () => {
    if (!docRef.current || !undoStack.current.length) return;
    redoStack.current.push(clone(docRef.current));
    const prev = undoStack.current.pop()!;
    prev.revision = docRef.current.revision;
    accept(prev);
    editSerial.current++;
    pending.current = true;
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
    setSaveState('待保存');
  };
  const redo = () => {
    if (!docRef.current || !redoStack.current.length) return;
    undoStack.current.push(clone(docRef.current));
    const next = redoStack.current.pop()!;
    next.revision = docRef.current.revision;
    accept(next);
    editSerial.current++;
    pending.current = true;
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
    setSaveState('待保存');
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      setSelectionModifier(e.shiftKey || e.ctrlKey || e.metaKey);
      const tag = (e.target as HTMLElement).tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      if (e.code === 'Space') {
        space.current = true;
        e.preventDefault();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
      if (e.key === 'Escape') {
        setSelectedId(null);
        setLayerId(null);
        setSelectedMarkId(null);
        setSettingsOpen(false);
        setTool('select');
      }
      if (e.key === 'Delete') {
        e.preventDefault();
        if (selectedAnnotation) deleteAnnotation(selectedAnnotation.id);
        else deleteImages();
      }
      if (!e.ctrlKey && !e.metaKey) {
        const shortcuts: Record<string, Tool> = {
          v: 'select',
          h: 'hand',
          a: 'arrow',
          o: 'ellipse',
          r: 'box',
          b: 'pen',
          t: 'text',
        };
        if (shortcuts[e.key.toLowerCase()]) setTool(shortcuts[e.key.toLowerCase()]);
      }
    };
    const up = (e: KeyboardEvent) => {
      setSelectionModifier(e.shiftKey || e.ctrlKey || e.metaKey);
      if (e.code === 'Space') space.current = false;
    };
    const blur = () => {
      setSelectionModifier(false);
      space.current = false;
      gesture.current = null;
      setDraft(null);
      setMarquee(null);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  });

  const chooseImage = (id: string) => {
    setSelectedId(id);
    setLayerId(null);
    setSelectedMarkId(null);
  };
  const fit = (target?: CanvasImage) => {
    if (!canvasRef.current || !docRef.current?.images.length) return;
    const selected = target || docRef.current.images.find((i) => i.id === selectedIdRef.current);
    const items = selected ? [selected] : docRef.current.images;
    canvasRef.current.scrollTop = 0;
    canvasRef.current.scrollLeft = 0;
    const minX = Math.min(...items.map((i) => i.x)),
      minY = Math.min(...items.map((i) => i.y));
    const maxX = Math.max(...items.map((i) => i.x + i.width)),
      maxY = Math.max(...items.map((i) => i.y + i.height));
    const { width, height } = canvasRef.current.getBoundingClientRect();
    const scale = clamp(
      Math.min((width - 100) / (maxX - minX), (height - 120) / (maxY - minY)),
      0.03,
      3,
    );
    setView({
      scale,
      x: (width - (maxX - minX) * scale) / 2 - minX * scale,
      y: (height - (maxY - minY) * scale) / 2 - minY * scale,
    });
  };
  const zoom = (factor: number, cx?: number, cy?: number) => {
    if (gesture.current) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setView((v) => {
      const x = cx ?? rect.width / 2,
        y = cy ?? rect.height / 2;
      const scale = clamp(v.scale * factor, 0.025, 5);
      return { scale, x: x - ((x - v.x) * scale) / v.scale, y: y - ((y - v.y) * scale) / v.scale };
    });
  };
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || !e.shiftKey)
        zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
      else setView((v) => ({ ...v, x: v.x - e.deltaY, y: v.y - e.deltaX }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [doc?.id]);

  const importFiles = async (files: FileList | File[]) => {
    if (!docRef.current || !files.length) return;
    setBusy(true);
    setError('');
    try {
      await flush();
      const form = new FormData();
      Array.from(files).forEach((file) => form.append('files', file));
      const d = await api<CanvasDocument>(`/api/document/${docRef.current.id}/import`, {
        method: 'POST',
        body: form,
      });
      serverBase.current = clone(d);
      accept(d);
      pending.current = false;
      chooseImage(d.images.at(-1)?.id || '');
      undoStack.current = [];
      redoStack.current = [];
      setUndoCount(0);
      setRedoCount(0);
      setTimeout(() => fit(), 40);
      setNotice(`已导入 ${files.length} 个文件`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const queue = async (type: Job['type']) => {
    if (!image || !docRef.current) return;
    setBusy(true);
    setError('');
    try {
      await flush();
      const job = await api<Job>(`/api/document/${docRef.current.id}/jobs`, {
        method: 'POST',
        body: JSON.stringify({
          imageId: image.id,
          ...(layerId && !['plan', 'layer', 'photoshop', 'illustrator'].includes(type)
            ? { layerIds: [layerId] }
            : {}),
          ...(viewMode === 'vector' ? { useVectorLayers: true } : {}),
          type,
          mode: docRef.current.settings.psdMode,
          engine: docRef.current.settings.vectorEngine,
        }),
      });
      previousJobStates.current.set(job.id, job.status);
      setJobs((j) => [job, ...j.filter((x) => x.id !== job.id)]);
      setJobListOpen(true);
      setNotice(job.message || '任务已提交');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const exportFile = async (format: string) => {
    if (!docRef.current || !image) return;
    setBusy(true);
    setError('');
    try {
      await flush();
      if (format === 'ai-artifact' && image.artifactUrl) {
        await download(image.artifactUrl, `${image.name.replace(/\.[^.]+$/, '')}.ai`);
        return;
      }
      await download(
        `/api/document/${docRef.current.id}/export?imageId=${encodeURIComponent(image.id)}&format=${format}&view=${viewMode}`,
        `${image.name.replace(/\.[^.]+$/, '')}.${format === 'project' ? 'json' : format}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const downloadDraft = () => {
    if (!docRef.current) return;
    const href = URL.createObjectURL(
      new Blob([JSON.stringify(docRef.current, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = href;
    link.download = '分层画布-未保存草稿.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };
  const downloadArtifact = async (job: Job) => {
    const url = job.result?.artifactUrl;
    if (!url) return;
    const original = docRef.current?.images.find((i) => i.id === job.imageId)?.name || '画布产物';
    const extension = url.split('.').at(-1)?.split(/[?#]/)[0] || 'bin';
    try {
      await download(
        url,
        `${original.replace(/\.[^.]+$/, '')}-${job.type === 'illustrator' ? 'Illustrator' : job.type === 'photoshop' ? 'Photoshop' : '完成'}.${extension}`,
      );
    } catch (e) {
      setError(String(e));
    }
  };

  const resize = (e: ReactPointerEvent, key: 'layersWidth' | 'opinionsWidth' | 'editorHeight') => {
    if (!docRef.current) return;
    e.preventDefault();
    checkpoint();
    const start = key === 'editorHeight' ? e.clientY : e.clientX;
    const old = docRef.current.layout[key];
    const move = (p: PointerEvent) => {
      const delta = key === 'editorHeight' ? p.clientY - start : start - p.clientX;
      change((d) => {
        d.layout[key] = clamp(
          old + delta,
          key === 'editorHeight' ? 120 : key === 'layersWidth' ? 150 : 230,
          key === 'editorHeight'
            ? Math.max(220, innerHeight - 310)
            : key === 'layersWidth'
              ? 420
              : 640,
        );
      }, false);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = key === 'editorHeight' ? 'ns-resize' : 'ew-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };
  const point = (e: { clientX: number; clientY: number }, img: CanvasImage) => {
    return imagePoint(
      { x: e.clientX, y: e.clientY },
      canvasRef.current!.getBoundingClientRect(),
      viewRef.current,
      img,
    );
  };
  const capture = (e: ReactPointerEvent) => {
    canvasRef.current?.focus({ preventScroll: true });
    canvasRef.current?.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const beginFrame = (e: ReactPointerEvent, img: CanvasImage, handle: FrameHandle) => {
    e.stopPropagation();
    if (space.current || e.button === 1) {
      beginPan(e);
      return;
    }
    if (busy || e.button !== 0 || !selectedLayer) return;
    capture(e);
    checkpoint();
    setSelectedMarkId(null);
    editingGroup.current = '';
    gesture.current = {
      kind: 'frame',
      imageId: img.id,
      layerId: selectedLayer.id,
      frame: layerFrame(selectedLayer, img),
      handle,
      start: [e.clientX, e.clientY],
      scale: viewRef.current.scale,
    };
  };
  const beginPan = (e: ReactPointerEvent) => {
    capture(e);
    gesture.current = { kind: 'pan', start: [e.clientX, e.clientY], view: viewRef.current };
  };
  const beginMove = (e: ReactPointerEvent, img: CanvasImage) => {
    if (busy) return;
    capture(e);
    checkpoint();
    const ids = selectedIds.includes(img.id) ? selectedIds : [img.id];
    gesture.current = {
      kind: 'move',
      origins: docRef
        .current!.images.filter((i) => ids.includes(i.id))
        .map((i) => ({ id: i.id, x: i.x, y: i.y })),
      start: [e.clientX, e.clientY],
      scale: viewRef.current.scale,
    };
  };
  const worldPoint = (e: { clientX: number; clientY: number }) =>
    imagePoint(
      { x: e.clientX, y: e.clientY },
      canvasRef.current!.getBoundingClientRect(),
      viewRef.current,
      { x: 0, y: 0 },
    );
  const beginMarquee = (e: ReactPointerEvent) => {
    if (busy) return;
    capture(e);
    const start = worldPoint(e);
    const base = e.shiftKey || e.ctrlKey || e.metaKey ? selectedIds : [];
    gesture.current = { kind: 'marquee', start, base };
    setMarquee({ x: start[0], y: start[1], width: 0, height: 0 });
    setSelectedIds(base);
    setLayerId(null);
    setSelectedMarkId(null);
  };
  const selectMark = (
    e: ReactPointerEvent,
    img: CanvasImage,
    mark: Annotation,
    moveLabel = false,
  ) => {
    if (tool === 'select' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      imagePointer(e, img);
      return;
    }
    if (space.current || e.button === 1) {
      e.stopPropagation();
      beginPan(e);
      return;
    }
    if (e.button !== 0 || busy) return;
    e.stopPropagation();
    canvasRef.current?.focus({ preventScroll: true });
    setSelectedId(img.id);
    setLayerId(mark.layerId);
    setSelectedMarkId(mark.id);
    if (moveLabel) {
      const p = point(e, img),
        label = labelPoint(mark);
      checkpoint();
      capture(e);
      gesture.current = {
        kind: 'label',
        imageId: img.id,
        markId: mark.id,
        offset: [p[0] - label[0], p[1] - label[1]],
      };
    }
  };
  const imagePointer = (e: ReactPointerEvent, img: CanvasImage) => {
    if (busy || (e.button !== 0 && e.button !== 1)) return;
    e.stopPropagation();
    canvasRef.current?.focus({ preventScroll: true });
    if (space.current || tool === 'hand' || e.button === 1) {
      beginPan(e);
      return;
    }
    if (tool === 'select') {
      setSelectedMarkId(null);
      setLayerId(null);
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        setSelectedIds((ids) =>
          ids.includes(img.id) ? ids.filter((id) => id !== img.id) : [...ids, img.id],
        );
        return;
      }
      if (!selectedIds.includes(img.id)) setSelectedId(img.id);
      beginMove(e, img);
      return;
    }
    if (showOriginal && selectedId === img.id) {
      setNotice('请关闭显示原图后，在当前结果上标注');
      return;
    }
    if (selectedId !== img.id) {
      setSelectedId(img.id);
      setLayerId(null);
    }
    setSelectedMarkId(null);
    const p = point(e, img);
    const item: Annotation = {
      id: uid(),
      layerId: selectedId === img.id ? layerId : null,
      type: tool,
      points: [...p, ...p],
      text: '',
      ...toolStyles[tool],
    };
    if (tool === 'text') {
      item.text = '输入标注';
      change((d) => {
        d.images.find((i) => i.id === img.id)!.annotations.push(item);
      });
      setSelectedMarkId(item.id);
      return;
    }
    capture(e);
    gesture.current = { kind: 'annotation', imageId: img.id, item };
    setDraft({ imageId: img.id, item });
  };
  const pointerMove = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan')
      setView({
        ...g.view,
        x: g.view.x + e.clientX - g.start[0],
        y: g.view.y + e.clientY - g.start[1],
      });
    else if (g.kind === 'marquee') {
      const p = worldPoint(e);
      const box = {
        x: Math.min(p[0], g.start[0]),
        y: Math.min(p[1], g.start[1]),
        width: Math.abs(p[0] - g.start[0]),
        height: Math.abs(p[1] - g.start[1]),
      };
      setMarquee(box);
      const hits = docRef
        .current!.images.filter(
          (i) =>
            i.x < box.x + box.width &&
            i.x + i.width > box.x &&
            i.y < box.y + box.height &&
            i.y + i.height > box.y,
        )
        .map((i) => i.id);
      setSelectedIds([...new Set([...g.base, ...hits])]);
    } else if (g.kind === 'move') {
      change((d) => {
        for (const origin of g.origins) {
          const i = d.images.find((x) => x.id === origin.id);
          if (!i) continue;
          i.x = origin.x + (e.clientX - g.start[0]) / g.scale;
          i.y = origin.y + (e.clientY - g.start[1]) / g.scale;
        }
      }, false);
    } else if (g.kind === 'frame') {
      const frame = resizeFrame(
        g.frame,
        g.handle,
        (e.clientX - g.start[0]) / g.scale,
        (e.clientY - g.start[1]) / g.scale,
      );
      change((d) => {
        const l = d.images.find((i) => i.id === g.imageId)?.layers.find((l) => l.id === g.layerId);
        if (l) l.frame = frame;
      }, false);
    } else if (g.kind === 'label') {
      const img = docRef.current?.images.find((i) => i.id === g.imageId);
      if (!img) return;
      const p = point(e, img);
      change((d) => {
        const mark = d.images
          .find((i) => i.id === g.imageId)
          ?.annotations.find((a) => a.id === g.markId);
        if (mark) mark.labelPosition = [p[0] - g.offset[0], p[1] - g.offset[1]];
      }, false);
    } else {
      const img = docRef.current!.images.find((i) => i.id === g.imageId)!;
      const p = point(e, img);
      g.item.points =
        g.item.type === 'pen' ? [...g.item.points, ...p] : [...g.item.points.slice(0, 2), ...p];
      setDraft({ imageId: g.imageId, item: { ...g.item } });
    }
  };
  const pointerUp = () => {
    const g = gesture.current;
    if (g?.kind === 'annotation') {
      const p = g.item.points;
      if (Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]) > 2 || p.length > 8) {
        change((d) => {
          d.images.find((i) => i.id === g.imageId)!.annotations.push(g.item);
        });
        setSelectedMarkId(g.item.id);
      }
    }
    gesture.current = null;
    setDraft(null);
    setMarquee(null);
    if (g?.kind === 'frame') void flush().catch(() => {});
  };
  const opinionChange = (value: string) => {
    const group = `${selectedId}/${viewMode}/${layerId || 'global'}`;
    if (editingGroup.current !== group) {
      checkpoint();
      editingGroup.current = group;
    }
    changeImage((i) => {
      if (layerId) {
        const l = layersFor(i).find((l) => l.id === layerId);
        if (l) l.opinion = value;
      } else i.opinion = value;
    }, false);
  };
  const addPlanningLayer = () => {
    if (!image || image.status !== 'preview' || busy) return;
    const id = uid();
    const width = Math.max(1, Math.round(image.width * 0.4)),
      height = Math.max(1, Math.round(image.height * 0.4));
    const frame = {
      x: Math.round((image.width - width) / 2),
      y: Math.round((image.height - height) / 2),
      width,
      height,
    };
    changeImage((i) => {
      i.layers.push(planningLayer(id, `新图层 ${i.layers.length + 1}`, frame));
    });
    setLayerId(id);
    setSelectedMarkId(null);
    setTool('select');
    setShowOriginal(false);
  };
  const deletePlanLayer = () => {
    if (!image || image.status !== 'preview' || !selectedLayer || busy) return;
    const id = selectedLayer.id;
    changeImage((i) => {
      i.layers = i.layers.filter((l) => l.id !== id);
      i.annotations = i.annotations.filter((a) => a.layerId !== id);
    });
    setLayerId(null);
    setSelectedMarkId(null);
  };
  const openSettings = (tab: string) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    api<ServiceSettings>('/api/settings')
      .then(setSettings)
      .catch((e) => setError(String(e)));
  };

  if (!doc)
    return (
      <div className="boot">
        <div className="brand-symbol">▱</div>
        <h1>分层画布</h1>
        <p>{loadError || '正在打开当前对话的画布…'}</p>
        {loadError && <button onClick={() => location.reload()}>重新连接</button>}
      </div>
    );

  return (
    <div className={`app ${doc.settings.theme}`}>
      <input
        hidden
        ref={fileRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.psd,.svg"
        multiple
        onChange={(e) => e.target.files && void importFiles(e.target.files)}
      />
      <header className="topbar">
        <div className="brand">
          <span className="brand-symbol">▱</span>
          <b>分层画布</b>
          <span className="version">BETA</span>
        </div>
        <span className="header-sep" />
        <button className="import-btn" onClick={() => fileRef.current?.click()} disabled={busy}>
          ＋ 导入
        </button>
        <button
          className="delete-images"
          aria-label="删除选中图片"
          title="删除选中图片 · Delete · 可撤销"
          disabled={!selectedIds.length || busy}
          onClick={deleteImages}
        >
          删除{selectedIds.length > 1 ? ` (${selectedIds.length})` : ''}
        </button>
        <div className="split-action">
          <button onClick={() => queue('plan')} disabled={!image || busy}>
            ▧ 预分层
          </button>
          <button
            aria-label="PSD 分层方案设置"
            title="选择 PSD 分层流程与抠图参数"
            onClick={() => openSettings('psd')}
          >
            ⌄
          </button>
        </div>
        <div className="split-action">
          <button onClick={() => queue('vectorize')} disabled={!image || busy}>
            ◇ 矢量化
          </button>
          <button
            aria-label="矢量化引擎设置"
            title="选择矢量化引擎"
            onClick={() => openSettings('vector')}
          >
            ⌄
          </button>
        </div>
        <select
          className="export-select"
          aria-label="导出格式"
          value=""
          onChange={(e) => {
            if (e.target.value) void exportFile(e.target.value);
          }}
          disabled={!image || busy}
        >
          <option value="" disabled>
            导出 ⌄
          </option>
          <option value="psd">位图分层 PSD</option>
          <option value="svg">纯矢量 SVG</option>
          <option value="png">合成 PNG</option>
          {image?.artifactUrl?.toLowerCase().endsWith('.ai') && (
            <option value="ai-artifact">Illustrator AI 文件</option>
          )}
          <option value="project">画布项目 JSON</option>
        </select>
        <span className="grow" />
        <span className="task-badge" title={`当前对话：${doc.taskId}`}>
          ● 当前对话画布
        </span>
        <span className={`save-state ${saveState === '保存失败' ? 'bad' : ''}`}>{saveState}</span>
        <button
          className="icon-button"
          title="撤销 Ctrl+Z"
          aria-label="撤销"
          disabled={!undoCount}
          onClick={undo}
        >
          ↶
        </button>
        <button
          className="icon-button"
          title="重做 Ctrl+Shift+Z"
          aria-label="重做"
          disabled={!redoCount}
          onClick={redo}
        >
          ↷
        </button>
        <button
          className="theme-toggle"
          onClick={() =>
            change((d) => {
              d.settings.theme = d.settings.theme === 'dark' ? 'light' : 'dark';
            })
          }
          title="切换亮色与暗色主题"
        >
          {doc.settings.theme === 'dark' ? '☾ 暗色' : '☀ 亮色'}
        </button>
        <button
          className="icon-button"
          title="设置"
          aria-label="设置"
          onClick={() => openSettings('psd')}
        >
          ⚙
        </button>
      </header>
      <div className="contextbar">
        <span className="crumb">
          画布 <span>/</span> {image?.name || '所有图片'}
        </span>
        <span className="context-count">{doc.images.length} 张图片</span>
        <span className="grow" />
        <button className="engine-label" onClick={() => openSettings('psd')}>
          PSD 方案 {doc.settings.psdMode} ·{' '}
          {(modes.find((m) => m.id === doc.settings.psdMode) || modes[0]).name}
        </button>
        <span className="subtle-dot">·</span>
        <button className="engine-label" onClick={() => openSettings('vector')}>
          {engines.find((e) => e.id === doc.settings.vectorEngine)?.name}{' '}
          <span>
            {doc.settings.vectorEngine === 'vectorizerCom' &&
            doc.settings.vectorizerComMode === 'codex'
              ? 'Codex 操作网页 · 消耗额度'
              : engines.find((e) => e.id === doc.settings.vectorEngine)?.cost}
          </span>
        </button>
      </div>
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          {saveState === '保存失败' && <button onClick={downloadDraft}>下载未保存草稿</button>}
          <button onClick={() => setError('')}>关闭</button>
        </div>
      )}
      <main className="workspace">
        <div
          className={`canvas ${tool} ${draggingFiles ? 'file-hover' : ''}`}
          ref={canvasRef}
          tabIndex={0}
          aria-label="图片画布"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDraggingFiles(true);
            }
          }}
          onDragLeave={() => setDraggingFiles(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDraggingFiles(false);
            if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 && e.button !== 1) return;
            if (!space.current && e.button === 0 && !['select', 'hand'].includes(tool) && image) {
              imagePointer(e, image);
              return;
            }
            setSelectedMarkId(null);
            if (!space.current && tool === 'select' && e.button === 0) {
              beginMarquee(e);
              return;
            }
            beginPan(e);
          }}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={() => {
            gesture.current = null;
            setDraft(null);
            setMarquee(null);
          }}
        >
          <div
            className="canvas-dots"
            style={{
              backgroundPosition: `${view.x}px ${view.y}px`,
              backgroundSize: `${Math.max(12, 26 * view.scale)}px ${Math.max(12, 26 * view.scale)}px`,
            }}
          />
          <div className="tool-rail" onPointerDown={(e) => e.stopPropagation()}>
            {(
              [
                ['select', '选择 V'],
                ['hand', '平移 H / 空格'],
                ['arrow', '箭头 A'],
                ['ellipse', '圈选 O'],
                ['box', '框选 R'],
                ['pen', '涂抹选择 B'],
                ['text', '文字 T'],
              ] as [Tool, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                className={tool === id ? 'active' : ''}
                title={id === 'select' ? '选择 V · 空白处拖框选图 · Shift / Ctrl 多选' : label}
                aria-label={label}
                onClick={() => setTool(id)}
              >
                <ToolIcon tool={id} />
              </button>
            ))}
          </div>
          {tool !== 'select' && tool !== 'hand' && (
            <div className="brush-controls" onPointerDown={(e) => e.stopPropagation()}>
              <AnnotationStyle
                type={tool}
                value={toolStyles[tool]}
                prefix="新标注"
                onChange={(patch) =>
                  setToolStyles((previous) => ({
                    ...previous,
                    [tool]: { ...previous[tool], ...patch },
                  }))
                }
              />
            </div>
          )}
          {!doc.images.length && (
            <div className="empty-canvas" onPointerDown={(e) => e.stopPropagation()}>
              <div className="empty-icon">
                ▧<span>＋</span>
              </div>
              <h1>让每个元素，都能独立编辑</h1>
              <p>
                拖入多张图片，或从当前 Codex 对话导入。
                <br />
                先预览分层，再按你的标注完成修改。
              </p>
              <button className="primary" onClick={() => fileRef.current?.click()}>
                ＋ 导入图片或 PSD
              </button>
              <small>PNG · JPG · WEBP · PSD · SVG</small>
            </div>
          )}
          <div
            className="world"
            style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})` }}
          >
            <svg className="node-connections" aria-label="图片来源连接">
              <defs>
                <marker
                  id="node-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerUnits="userSpaceOnUse"
                  markerWidth="16"
                  markerHeight="16"
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {doc.images
                .filter((i) => i.parentId)
                .map((child) => {
                  const parent = doc.images.find((i) => i.id === child.parentId);
                  return parent ? (
                    <path
                      key={child.id}
                      data-parent={parent.id}
                      data-child={child.id}
                      d={connectionPath(parent, child)}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="9"
                      vectorEffect="non-scaling-stroke"
                      markerEnd="url(#node-arrow)"
                    />
                  ) : null;
                })}
            </svg>
            {doc.images.map((img) => (
              <div
                key={img.id}
                data-image-id={img.id}
                className={`image-board ${selectedIds.includes(img.id) ? 'selected' : ''}`}
                style={{ left: img.x, top: img.y, width: img.width, height: img.height }}
                onPointerDown={(e) => imagePointer(e, img)}
                onDoubleClick={() => fit(img)}
              >
                <div
                  className="board-caption"
                  style={{
                    transform: `scale(${1 / view.scale})`,
                    transformOrigin: 'left bottom',
                    width: img.width * view.scale,
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    canvasRef.current?.focus({ preventScroll: true });
                    if (space.current || tool === 'hand' || e.button === 1) {
                      beginPan(e);
                      return;
                    }
                    if (e.button !== 0) return;
                    if (tool === 'select') imagePointer(e, img);
                    else chooseImage(img.id);
                  }}
                >
                  <span>{img.name}</span>
                  <small>
                    {statusText[img.status]}
                    {img.basedOnOlderVersion ? ' · 基于旧版' : ''}
                  </small>
                </div>
                <div className="image-content checker">
                  {showOriginal && selectedId === img.id && original?.imageId === img.id ? (
                    <img
                      className="original-comparison"
                      draggable={false}
                      src={original.url}
                      alt="原图对比"
                      style={{ width: img.width, height: img.height, objectFit: 'contain' }}
                    />
                  ) : img.status === 'vector' && img.vectorUrl && !img.vectorLayers?.length ? (
                    <img draggable={false} src={img.vectorUrl} alt={img.name} />
                  ) : img.status === 'preview' && img.layers.some((l) => l.kind === 'plan') ? (
                    <>
                      <img
                        draggable={false}
                        className="planning-source"
                        src={img.source}
                        alt={`${img.name} · 干净参考图`}
                      />
                      {img.layers
                        .filter((l) => l.kind !== 'plan' && l.visible)
                        .map((l) => (
                          <img
                            key={l.id}
                            draggable={false}
                            src={l.previewUrl || l.url}
                            alt={l.name}
                            style={{
                              left: l.previewUrl ? 0 : l.x,
                              top: l.previewUrl ? 0 : l.y,
                              width: l.previewUrl ? img.width : l.width,
                              height: l.previewUrl ? img.height : l.height,
                              opacity: l.opacity,
                            }}
                          />
                        ))}
                    </>
                  ) : !layersFor(img).length || img.status === 'original' ? (
                    <img draggable={false} src={img.url} alt={img.name} />
                  ) : (
                    layersFor(img)
                      .filter((l) => l.visible)
                      .map((l) => (
                        <img
                          key={l.id}
                          draggable={false}
                          src={l.previewUrl || l.url}
                          alt={l.name}
                          style={{
                            left: l.previewUrl ? 0 : l.x,
                            top: l.previewUrl ? 0 : l.y,
                            width: l.previewUrl ? img.width : l.width,
                            height: l.previewUrl ? img.height : l.height,
                            opacity: l.opacity,
                          }}
                        />
                      ))
                  )}
                </div>
                {!showOriginal &&
                  !marquee &&
                  !(selectionModifier && tool === 'select') &&
                  selectedId === img.id && (
                    <svg className="annotations" viewBox={`0 0 ${img.width} ${img.height}`}>
                      <>
                        {img.annotations.map((mark) => (
                          <Mark
                            key={mark.id}
                            mark={mark}
                            scale={view.scale}
                            selected={
                              selectedId === img.id &&
                              selectedMarkId === mark.id &&
                              mark.layerId === layerId
                            }
                            active={!layerId || mark.layerId === layerId}
                            onSelect={
                              tool === 'select' ? (e) => selectMark(e, img, mark) : undefined
                            }
                            onLabelDrag={
                              tool === 'select' ? (e) => selectMark(e, img, mark, true) : undefined
                            }
                          />
                        ))}
                        {draft?.imageId === img.id && (
                          <Mark mark={draft.item} active scale={view.scale} />
                        )}
                      </>
                    </svg>
                  )}
                {selectedId === img.id &&
                  selectedLayer &&
                  selectedLayer.visible &&
                  !showOriginal &&
                  !marquee &&
                  !(selectionModifier && tool === 'select') && (
                    <LayerFrame
                      frame={layerFrame(selectedLayer, img)}
                      name={selectedLayer.kind === 'plan' ? selectedLayer.name : undefined}
                      scale={view.scale}
                      editable={img.status === 'preview' && tool === 'select' && !busy}
                      onDrag={(e, handle) => beginFrame(e, img, handle)}
                    />
                  )}
                {selectedId === img.id &&
                  !showOriginal &&
                  !marquee &&
                  !(selectionModifier && tool === 'select') &&
                  img.layers
                    .filter((l) => l.kind === 'plan' && l.visible && l.id !== layerId)
                    .map((l) => (
                      <LayerFrame
                        key={l.id}
                        frame={layerFrame(l, img)}
                        name={l.name}
                        scale={view.scale}
                        editable={false}
                        onDrag={() => {}}
                        onSelect={
                          tool === 'select'
                            ? (e) => {
                                e.stopPropagation();
                                setLayerId(l.id);
                                setSelectedMarkId(null);
                              }
                            : undefined
                        }
                      />
                    ))}
                {selectedId === img.id && (
                  <span
                    className="board-dimensions"
                    style={{ transform: `scale(${1 / view.scale})`, transformOrigin: 'left top' }}
                  >
                    {img.width} × {img.height}
                  </span>
                )}
              </div>
            ))}
          </div>
          {marquee && (
            <div
              className="node-marquee"
              aria-label="图片框选范围"
              style={{
                left: view.x + marquee.x * view.scale,
                top: view.y + marquee.y * view.scale,
                width: marquee.width * view.scale,
                height: marquee.height * view.scale,
              }}
            />
          )}
          {selectedIds.length > 1 && (
            <div className="multi-selection-info">
              已选 {selectedIds.length} 张图片 · 拖动可一起移动 · Delete 删除
            </div>
          )}
          {draggingFiles && <div className="drop-overlay">松开即可导入到当前画布</div>}
          <div className="canvas-bottom" onPointerDown={(e) => e.stopPropagation()}>
            <div className="view-tabs">
              <button
                role="switch"
                aria-checked={showOriginal}
                className={showOriginal ? 'active' : ''}
                disabled={!image || !original?.url || !original.complete}
                title="只对比当前节点与最初原图，不改变任务输入或导出内容"
                onClick={() => setShowOriginal((v) => !v)}
              >
                <span className="compare-switch" />
                显示原图
              </button>
            </div>
            <span className="grow" />
            <div className="zoom-controls">
              <button onClick={() => zoom(1 / 1.2)} aria-label="缩小">
                −
              </button>
              <button onClick={() => setView((v) => ({ ...v, scale: 1 }))}>
                {Math.round(view.scale * 100)}%
              </button>
              <button onClick={() => zoom(1.2)} aria-label="放大">
                ＋
              </button>
              <span />
              <button onClick={() => fit()}>适应</button>
            </div>
          </div>
        </div>
        <div
          className="splitter"
          role="separator"
          aria-label="调整图层栏宽度"
          aria-orientation="vertical"
          onPointerDown={(e) => resize(e, 'layersWidth')}
        />
        <aside className="layers-panel" style={{ width: doc.layout.layersWidth || 210 }}>
          <div className="panel-heading">
            <b>图层</b>
            <span>{displayedLayers.length}</span>
            <span className="grow" />
            {image?.status === 'preview' && (
              <>
                <button
                  className="icon-button"
                  aria-label="新建图层"
                  title="新建只有画幅框的图层，不生成图片"
                  disabled={busy || displayedLayers.length >= 300}
                  onClick={addPlanningLayer}
                >
                  ＋
                </button>
                <button
                  className="icon-button"
                  aria-label="删除预分层图层"
                  title="删除选中预分层图层及所属标注，可撤销"
                  disabled={busy || !selectedLayer}
                  onClick={deletePlanLayer}
                >
                  −
                </button>
              </>
            )}
            <button
              className="icon-button"
              title="选择整张图片"
              onClick={() => {
                setLayerId(null);
                setSelectedMarkId(null);
              }}
            >
              ▣
            </button>
          </div>
          <div className="image-picker">
            <select
              aria-label="当前图片"
              value={selectedId || ''}
              onChange={(e) => chooseImage(e.target.value)}
            >
              <option value="" disabled>
                选择图片
              </option>
              {doc.images.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          {image && (
            <button
              className={`whole-image ${!layerId ? 'active' : ''}`}
              onClick={() => setLayerId(null)}
            >
              <span>▣</span> 总图
              <span className="grow" />
              <small>{statusText[image.status]}</small>
            </button>
          )}
          <div className="layer-list">
            {displayedLayers.length ? (
              [...displayedLayers].reverse().map((l) => (
                <div
                  key={l.id}
                  className={`layer-row ${layerId === l.id ? 'active' : ''} ${!l.visible ? 'hidden-layer' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    dragLayer.current = l.id;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', l.id);
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragLayer.current;
                    if (!from || from === l.id) return;
                    changeImage((i) => {
                      const list = layersFor(i);
                      const a = list.findIndex((x) => x.id === from);
                      const b = list.findIndex((x) => x.id === l.id);
                      list.splice(b, 0, ...list.splice(a, 1));
                    });
                    dragLayer.current = null;
                  }}
                  onClick={() => {
                    setLayerId(l.id);
                    setSelectedMarkId(null);
                  }}
                >
                  <span className="drag-handle" title="拖动调整上下顺序">
                    ⠿
                  </span>
                  <div className="layer-thumb checker">
                    {l.kind === 'plan' ? (
                      <span className="planning-thumb" title="仅规划框，尚未重建">
                        ▱{displayedLayers.indexOf(l) + 1}
                      </span>
                    ) : (
                      <img src={l.previewUrl || l.url} alt="" />
                    )}
                  </div>
                  <div className="layer-title">
                    <span
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        const name = prompt('图层名称', l.name);
                        if (name?.trim())
                          changeImage((i) => {
                            layersFor(i).find((x) => x.id === l.id)!.name = name.trim();
                          });
                      }}
                    >
                      {l.name}
                    </span>
                    <small>
                      {l.kind === 'plan'
                        ? '规划框'
                        : l.preview
                          ? '预览'
                          : l.kind === 'text'
                            ? '可编辑文字'
                            : l.kind === 'vector'
                              ? '矢量'
                              : '位图'}
                      {l.opinion ? ' · 有意见' : ''}
                    </small>
                  </div>
                  <button
                    className={`disposition ${l.disposition}`}
                    disabled={l.kind === 'plan'}
                    title={
                      l.disposition === 'keep'
                        ? '已标记保留，点击改为重建'
                        : '已标记重建，点击改为保留'
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      changeImage((i) => {
                        const v = layersFor(i).find((x) => x.id === l.id)!;
                        v.disposition = v.disposition === 'keep' ? 'rebuild' : 'keep';
                      });
                    }}
                  >
                    {l.disposition === 'keep' ? '✓' : '↻'}
                  </button>
                  <button
                    className="eye"
                    title={l.visible ? '隐藏图层' : '显示图层'}
                    aria-label={`${l.visible ? '隐藏' : '显示'}${l.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      changeImage((i) => {
                        const v = layersFor(i).find((x) => x.id === l.id)!;
                        v.visible = !v.visible;
                      });
                    }}
                  >
                    {l.visible ? '◉' : '○'}
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-layers">
                <span>▱</span>
                <p>{image ? '尚未分层' : '选择一张图片'}</p>
                <small>{image ? '点击预分层，先查看建议图层。' : '每张图片都有独立的图层。'}</small>
              </div>
            )}
          </div>
          {image?.status === 'preview' && (
            <div className="preview-confirm">
              <p>选中图层后，用选择工具拖动虚线框调整画幅；可调整顺序和标注。</p>
              <button
                className="primary"
                onClick={() => queue('layer')}
                disabled={busy || !displayedLayers.length}
              >
                确认方案，开始真实分层
              </button>
            </div>
          )}
          <div className="layer-footnote">
            <span>↕ 拖动排序</span>
            <span>✓ 保留　↻ 重建</span>
          </div>
        </aside>
        <div
          className="splitter"
          role="separator"
          aria-label="调整修改意见栏宽度"
          aria-orientation="vertical"
          onPointerDown={(e) => resize(e, 'opinionsWidth')}
        />
        <aside className="opinions-panel" style={{ width: doc.layout.opinionsWidth || 300 }}>
          <div className="panel-heading">
            <b>修改意见</b>
            <span className="grow" />
            <span className="scope-badge">{selectedLayer ? '当前图层' : '总图'}</span>
          </div>
          <div className="opinion-content">
            <div className="scope-title">
              <span className="scope-icon">{selectedLayer ? '▱' : '▣'}</span>
              <span>{selectedLayer?.name || image?.name || '未选择图片'}</span>
            </div>
            <p className="field-hint">
              {selectedLayer
                ? '仅显示这个图层的修改意见，画布中对应标注已突出。'
                : '只显示整张图片的修改意见。点击图层，查看该层意见。'}
            </p>
            {image?.status === 'preview' && selectedLayer && (
              <div className="frame-controls">
                <label className="plan-name">
                  图层名称
                  <input
                    aria-label="图层名称"
                    maxLength={300}
                    value={selectedLayer.name}
                    onChange={(e) =>
                      changeImage((i) => {
                        i.layers.find((l) => l.id === selectedLayer.id)!.name = e.target.value;
                      })
                    }
                    onBlur={() => {
                      if (!selectedLayer.name.trim())
                        changeImage((i) => {
                          i.layers.find((l) => l.id === selectedLayer.id)!.name = '未命名图层';
                        });
                    }}
                  />
                </label>
                <span>
                  重建画幅 {layerFrame(selectedLayer, image).width} ×{' '}
                  {layerFrame(selectedLayer, image).height}
                </span>
                <button
                  disabled={busy}
                  title="恢复预分层建议范围，不改变预览图片、标注和物体比例"
                  onClick={() =>
                    changeImage((i) => {
                      const l = i.layers.find((l) => l.id === selectedLayer.id)!;
                      l.frame = suggestedFrame(l, i);
                    })
                  }
                >
                  恢复建议画幅
                </button>
                <small>拖边改范围，拖尺寸标签移动框；不缩放物体。请为发丝、阴影和光晕留白。</small>
                <GenerationHint frame={layerFrame(selectedLayer, image)} />
              </div>
            )}
            {selectedLayer?.generationSize && (
              <p className="field-hint">
                生成 {selectedLayer.generationSize.width} × {selectedLayer.generationSize.height} ·
                图层 {selectedLayer.width} × {selectedLayer.height}
                {selectedLayer.generationAdaptation && (
                  <>
                    {' '}
                    · {selectedLayer.generationAdaptation.scale >= 1 ? '放大' : '缩小'}{' '}
                    {selectedLayer.generationAdaptation.scale.toFixed(2)}×
                    {selectedLayer.generationAdaptation.padding === 'edge-copy'
                      ? ' · 背景边缘延展，请检查接缝'
                      : ''}
                  </>
                )}
              </p>
            )}
            <textarea
              aria-label={selectedLayer ? '图层修改意见' : '总图修改意见'}
              className="opinion-editor"
              disabled={!image}
              style={{ height: doc.layout.editorHeight || 260 }}
              value={selectedLayer?.opinion ?? image?.opinion ?? ''}
              placeholder={
                selectedLayer
                  ? '例如：保留字形与位置，将描边改为可编辑效果…'
                  : '例如：放大整张图片到 2K，保持分层不变…'
              }
              onChange={(e) => opinionChange(e.target.value)}
              onBlur={() => {
                editingGroup.current = '';
              }}
            />
            <div
              className="editor-resize"
              role="separator"
              aria-label="调整修改意见输入区高度"
              aria-orientation="horizontal"
              onPointerDown={(e) => resize(e, 'editorHeight')}
            >
              <span />
            </div>
            <div className="opinion-actions">
              <span className="muted">自动保存 · {selectedLayer ? '仅此图层' : '总图'}</span>
              <button className="primary" disabled={!image || busy} onClick={() => queue('revise')}>
                提交修改 ↗
              </button>
            </div>
            {image && (
              <div className="annotation-tags" aria-label="当前标注列表">
                {annotationTags.length ? (
                  annotationTags.map((mark, index) => (
                    <span
                      className={`annotation-chip ${selectedMarkId === mark.id ? 'active' : ''}`}
                      key={mark.id}
                    >
                      <button
                        className="annotation-chip-label"
                        aria-label={`选择标注 ${mark.text || index + 1}`}
                        title={mark.text || '未填写意见'}
                        onClick={() => {
                          setSelectedMarkId(mark.id);
                          setLayerId(mark.layerId);
                          setTool('select');
                        }}
                      >
                        <i style={{ background: mark.color }} />
                        {mark.text || `标注 ${index + 1}`}
                      </button>
                      <button
                        className="annotation-chip-remove"
                        aria-label={`删除标注 ${mark.text || index + 1}`}
                        title="删除标注"
                        onClick={() => deleteAnnotation(mark.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))
                ) : (
                  <span className="muted">{layerId ? '此图层暂无标注' : '此图片暂无标注'}</span>
                )}
              </div>
            )}
            {selectedAnnotation && (
              <div className="annotation-editor">
                <div className="annotation-heading">
                  <b>已选标注</b>
                  <button
                    title="删除标注"
                    onClick={() => {
                      changeImage((i) => {
                        i.annotations = i.annotations.filter((a) => a.id !== selectedMarkId);
                      });
                      setSelectedMarkId(null);
                    }}
                  >
                    删除
                  </button>
                </div>
                <AnnotationStyle
                  type={selectedAnnotation.type}
                  value={selectedAnnotation}
                  prefix="已选标注"
                  onChange={(patch) =>
                    changeImage((i) => {
                      const mark = i.annotations.find((a) => a.id === selectedMarkId);
                      if (mark) Object.assign(mark, patch);
                    })
                  }
                />
                <textarea
                  aria-label="标注文字"
                  value={selectedAnnotation.text}
                  placeholder="为箭头或选区补充说明…"
                  onChange={(e) =>
                    changeImage((i) => {
                      i.annotations.find((a) => a.id === selectedMarkId)!.text = e.target.value;
                    })
                  }
                />
                <label>
                  归属
                  <select
                    aria-label="标注归属"
                    value={selectedAnnotation.layerId || ''}
                    onChange={(e) => {
                      const target = e.target.value || null;
                      changeImage((i) => {
                        i.annotations.find((a) => a.id === selectedMarkId)!.layerId = target;
                      });
                      setLayerId(target);
                    }}
                  >
                    <option value="">总图</option>
                    {displayedLayers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {selectedLayer?.kind === 'text' && selectedLayer.text && (
              <TextProperties
                layer={selectedLayer}
                update={(fn) =>
                  changeImage((i) => {
                    const l = layersFor(i).find((l) => l.id === layerId);
                    if (l) fn(l);
                  })
                }
              />
            )}
            <div className="quiet-tip">
              <span>↗</span>
              <p>
                选中图片后可在图外写标注。箭头、框选和涂抹按图片坐标提交；拖动图片时标注一起移动。
              </p>
            </div>
          </div>
          <div className="handoff">
            <button
              className="handoff-button"
              disabled={!image || busy}
              onClick={() => queue('photoshop')}
            >
              <span className="adobe ps">Ps</span>交接 PS
              <span className="tooltip">非常消耗 Codex 额度</span>
            </button>
            <button
              className="handoff-button"
              disabled={!image || busy}
              onClick={() => queue('illustrator')}
            >
              <span className="adobe ai">Ai</span>交接 AI
              <span className="tooltip">非常消耗 Codex 额度</span>
            </button>
          </div>
        </aside>
      </main>
      <footer className="statusbar">
        <span className="status-led" />
        <span>本地画布</span>
        <span className="status-divider" />
        <span>{image ? `${image.width} × ${image.height} px` : '准备就绪'}</span>
        <span className="grow" />
        {busy && <span className="working">处理中…</span>}
        <button
          className={activeJobs.length ? 'jobs-active' : ''}
          onClick={() => setJobListOpen(!jobListOpen)}
        >
          任务{' '}
          {activeJobs.length
            ? `· ${activeJobs.length} 项待处理`
            : jobs.length
              ? `· ${jobs.length}`
              : ''}{' '}
          ⌃
        </button>
      </footer>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
      {jobListOpen && (
        <div className="jobs-popover">
          <div className="panel-heading">
            <b>当前对话任务</b>
            <span className="grow" />
            <button onClick={() => setJobListOpen(false)}>×</button>
          </div>
          {!jobs.length ? (
            <p className="empty-jobs">还没有处理任务</p>
          ) : (
            jobs.slice(0, 30).map((j) => (
              <div key={j.id} data-job-id={j.id} className={`job-row ${j.status}`}>
                <div>
                  <b>{jobNames[j.type]}</b>
                  <span>{jobLabel(j)}</span>
                </div>
                <p>{j.message || ''}</p>
                {j.status === 'waiting_codex' && (
                  <small>
                    {j.dispatch?.state === 'sent'
                      ? '请求已自动送达；对话正在忙时会等待处理。'
                      : j.dispatch?.state === 'sending'
                        ? '正在发送，无需手动输入消息。'
                        : !j.dispatch
                          ? '这是旧版保留的请求。取消后重新点击功能按钮即可自动发送。'
                          : '请查看发送详情；原图及意见均已保留。'}
                  </small>
                )}
                {(j.dispatch?.detail || j.webProgress?.detail) && (
                  <details>
                    <summary>查看详情</summary>
                    <p>{j.webProgress?.detail || j.dispatch?.detail}</p>
                  </details>
                )}
                {j.status === 'completed' && j.result?.artifactUrl && (
                  <button onClick={() => void downloadArtifact(j)}>下载产物 ↓</button>
                )}
                {['queued', 'running', 'waiting_codex'].includes(j.status) && (
                  <button
                    onClick={async () => {
                      try {
                        const result = await api<Job>(`/api/jobs/${j.id}/cancel`, {
                          method: 'POST',
                        });
                        setJobs((list) => list.map((x) => (x.id === result.id ? result : x)));
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    取消
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <section className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <h2>画布设置</h2>
                <p>选择适合当前图片的处理方式</p>
              </div>
              <button aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>
                ×
              </button>
            </div>
            <nav className="settings-tabs">
              {[
                ['psd', 'PSD 分层'],
                ['vector', '矢量化'],
                ['api', 'API 凭证'],
                ['adobe', 'PS / AI'],
                ['display', '外观'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={settingsTab === id ? 'active' : ''}
                  onClick={() => setSettingsTab(id)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="settings-body">
              {settingsTab === 'psd' && (
                <>
                  <PsdSettings
                    mode={doc.settings.psdMode}
                    options={doc.settings.cutoutOptions}
                    onSave={async (mode: PsdMode, options: CutoutOptions) => {
                      if (busy) throw new Error('请等待当前保存完成');
                      change((d) => {
                        d.settings.psdMode = mode;
                        d.settings.cutoutOptions = clone(options);
                      });
                      setBusy(true);
                      try {
                        await flush();
                        await api('/api/cutout-defaults', {
                          method: 'PUT',
                          body: JSON.stringify({ psdMode: mode, cutoutOptions: options }),
                        });
                        setNotice('分层流程与抠图参数已保存为默认');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                  <ModelStatus models={settings?.models} />
                </>
              )}
              {settingsTab === 'vector' && (
                <>
                  <p className="settings-intro">
                    API
                    支持当前原图或已完成的图层逐层矢量化；免费网页自动上传、下载，并返回关联矢量节点。
                  </p>
                  {engines.map((engine) => (
                    <div key={engine.id} className="vector-provider">
                      <button
                        className={`option-card ${doc.settings.vectorEngine === engine.id ? 'selected' : ''}`}
                        onClick={() =>
                          change((d) => {
                            d.settings.vectorEngine = engine.id;
                          })
                        }
                      >
                        <span className="radio-dot" />
                        <div>
                          <b>
                            {engine.name}
                            <span className="engine-description">{engine.description}</span>
                          </b>
                          <p>
                            {engine.id === 'vectorizerCom' &&
                            doc.settings.vectorizerComMode === 'codex'
                              ? '网站免费 · Codex 操作消耗额度'
                              : engine.cost}
                          </p>
                          <small>{engine.detail}</small>
                          <p>
                            {engine.id === 'vectorizerCom'
                              ? '无需凭证'
                              : (
                                    engine.id === 'recraft'
                                      ? settings?.recraftConfigured
                                      : engine.id === 'vectorizer'
                                        ? settings?.vectorizerConfigured
                                        : settings?.api302Configured
                                  )
                                ? '凭证已配置'
                                : '尚未配置凭证'}
                          </p>
                        </div>
                      </button>
                      {engine.id === 'vectorizerCom' && (
                        <label className="website-mode">
                          网页操作方式
                          <select
                            aria-label="Vectorizer.com 网页操作方式"
                            value={doc.settings.vectorizerComMode || 'auto'}
                            onChange={(e) =>
                              change((d) => {
                                d.settings.vectorEngine = 'vectorizerCom';
                                d.settings.vectorizerComMode = e.target.value as 'auto' | 'codex';
                              })
                            }
                          >
                            <option value="auto">自动脚本 · 不消耗 Codex 额度</option>
                            <option value="codex">Codex 操作网页 · 消耗 Codex 额度</option>
                          </select>
                          <small>
                            {doc.settings.vectorizerComMode === 'codex'
                              ? '由当前对话的 Codex 操作可见网页并回传。遇到验证会提示你接管，完成后继续；需要可用的浏览器控制工具。'
                              : '自动上传和下载；遇到验证可能失败，可改用 Codex 操作网页。'}
                          </small>
                        </label>
                      )}
                      <div className="provider-links">
                        {engine.links.map(([label, url]) => (
                          <a key={url} href={url} target="_blank" rel="noreferrer">
                            {label} ↗
                          </a>
                        ))}
                      </div>
                    </div>
                  ))}
                  <p className="settings-note">
                    效果等级是推荐标记，具体效果因素材而异。自动脚本与 API 不消耗 Codex 额度；Codex
                    操作网页会消耗额度。API 由服务商单独收费，逐层转换按提交图片数量计费。价格核对于
                    2026-09-19，以服务商最新报价为准。预分层、生成与修复仍按原方案消耗额度。
                  </p>
                  <button className="text-link" onClick={() => setSettingsTab('api')}>
                    配置 API 凭证 →
                  </button>
                </>
              )}
              {settingsTab === 'api' && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusy(true);
                    try {
                      const values = Object.fromEntries(
                        Object.entries(credentials).filter(([, v]) => v.trim()),
                      );
                      const result = await api<ServiceSettings>('/api/settings', {
                        method: 'PUT',
                        body: JSON.stringify(values),
                      });
                      setSettings((s) => ({ ...s!, ...result }));
                      setCredentials({
                        recraftKey: '',
                        api302Key: '',
                        vectorizerId: '',
                        vectorizerSecret: '',
                      });
                      setNotice('凭证已保存到本机');
                    } catch (err) {
                      setError(String(err));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <p className="settings-intro">
                    密钥只保存在本机，不随画布项目导出。留空表示保留已有配置。
                  </p>
                  <label className="credential">
                    Recraft 官方 API Key{' '}
                    <span>{settings?.recraftConfigured ? '已配置' : '未配置'}</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={credentials.recraftKey}
                      placeholder="输入新的 API Key"
                      onChange={(e) =>
                        setCredentials((c) => ({ ...c, recraftKey: e.target.value }))
                      }
                    />
                  </label>
                  <label className="credential">
                    Vectorizer.AI 官方 API ID{' '}
                    <span>{settings?.vectorizerConfigured ? '已配置' : '未配置'}</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={credentials.vectorizerId}
                      placeholder="填写官方 API ID"
                      onChange={(e) =>
                        setCredentials((c) => ({ ...c, vectorizerId: e.target.value }))
                      }
                    />
                  </label>
                  <label className="credential">
                    Vectorizer.AI 官方 API Secret
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={credentials.vectorizerSecret}
                      placeholder="填写官方 API Secret，与 302 Key 不通用"
                      onChange={(e) =>
                        setCredentials((c) => ({ ...c, vectorizerSecret: e.target.value }))
                      }
                    />
                  </label>
                  <label className="credential">
                    302.AI API Key <span>{settings?.api302Configured ? '已配置' : '未配置'}</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={credentials.api302Key}
                      placeholder="输入 302.AI API Key，不是 Vectorizer.AI 官方密钥"
                      onChange={(e) => setCredentials((c) => ({ ...c, api302Key: e.target.value }))}
                    />
                  </label>
                  <div className="provider-links">
                    <a href="https://www.recraft.ai/api" target="_blank" rel="noreferrer">
                      Recraft 官方申请密钥 ↗
                    </a>
                    <a href="https://dash.302.ai/" target="_blank" rel="noreferrer">
                      302.AI 控制台 ↗
                    </a>
                    <a href="https://vectorizer.ai/" target="_blank" rel="noreferrer">
                      Vectorizer.AI 官网 ↗
                    </a>
                  </div>
                  <button
                    className="primary"
                    disabled={busy || !Object.values(credentials).some(Boolean)}
                  >
                    保存凭证
                  </button>
                  <ModelStatus models={settings?.models} />
                </form>
              )}
              {settingsTab === 'adobe' && <AdobeSettings />}
              {settingsTab === 'display' && (
                <>
                  <p className="settings-intro">
                    拖动画布和右侧两栏之间的边缘调整宽度，拖动输入框下缘调整高度。布局自动保存。
                  </p>
                  <div className="theme-cards">
                    {(['dark', 'light'] as const).map((t) => (
                      <button
                        className={`theme-card ${t} ${doc.settings.theme === t ? 'selected' : ''}`}
                        key={t}
                        onClick={() =>
                          change((d) => {
                            d.settings.theme = t;
                          })
                        }
                      >
                        <div>
                          <i />
                          <i />
                          <i />
                        </div>
                        {t === 'dark' ? '暗色' : '亮色'}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() =>
                      change((d) => {
                        d.layout = { layersWidth: 210, opinionsWidth: 300, editorHeight: 260 };
                      })
                    }
                  >
                    恢复默认面板大小
                  </button>
                </>
              )}
            </div>
            <div className="settings-footer">
              <span>
                {['api', 'adobe', 'psd'].includes(settingsTab)
                  ? '此页设置需点击保存'
                  : '设置自动保存'}
              </span>
              <button className="primary" onClick={() => setSettingsOpen(false)}>
                完成
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
