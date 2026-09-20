export type { Layer, Annotation, CanvasImage, Document as CanvasDocument } from '../shared/canvas';
export type Job = {
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
  engine?: string;
  result?: { artifactUrl?: string; [key: string]: unknown };
};
export type ServiceSettings = {
  recraftConfigured: boolean;
  api302Configured: boolean;
  vectorizerConfigured: boolean;
  models: Record<string, unknown>;
};
