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
export interface Job {
  frameContractVersion?: 1;
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
  type: 'plan' | 'layer' | 'revise' | 'vectorize' | 'photoshop' | 'illustrator';
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
