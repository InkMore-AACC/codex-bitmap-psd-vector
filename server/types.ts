export type {
  TextLayer,
  TextEffects,
  Layer,
  Annotation,
  VectorEngine,
  CanvasImage,
  Document,
} from '../shared/canvas.js';
import type { CanvasImage, VectorEngine } from '../shared/canvas.js';
import type { CutoutOptions, PsdMode } from '../shared/cutout.js';
import type { UpscaleSettings } from '../shared/upscale.js';
import type { StandaloneMatting } from '../shared/standalone-matting.js';
export interface Job {
  photoshop?: import('../shared/photoshop.js').PhotoshopSettings;
  matting?: StandaloneMatting;
  upscale?: UpscaleSettings;
  preserveKeptLayers?: boolean;
  frameContractVersion?: 1;
  reconstructionVersion?: 3;
  /** New jobs opt in; persisted v3 jobs remain resumable without new review gates. */
  reconstructionWorkflowVersion?: 4;
  webProgress?: {
    phase: 'working' | 'verification' | 'blocked';
    updatedAt: string;
    completed?: number;
    reviewUrl?: string;
    detail?: string;
  };
  dispatch?: {
    state: 'sending' | 'sent' | 'received' | 'failed' | 'uncertain';
    updatedAt: string;
    detail?: string;
  };
  id: string;
  documentId: string;
  taskId: string;
  imageId: string;
  type:
    'upscale' | 'cutout' | 'plan' | 'layer' | 'revise' | 'vectorize' | 'photoshop' | 'illustrator';
  status: 'queued' | 'running' | 'waiting_codex' | 'completed' | 'failed' | 'cancelled';
  message: string;
  createdAt: string;
  version: number;
  mode: 1 | PsdMode;
  cutoutOptions?: CutoutOptions;
  engine: VectorEngine;
  webMode?: 'auto' | 'codex';
  layerIds?: string[];
  useOriginal?: boolean;
  useVectorLayers?: boolean;
  snapshot: CanvasImage;
  result?: unknown;
}
