import type { LayerFrame } from './layer-frame.js';
import type { CutoutOptions, PsdMode } from './cutout.js';
export interface TextLayer {
  value: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  x: number;
  y: number;
}
export interface TextEffects {
  stroke?: { color: string; size: number };
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number; opacity: number };
}
export interface ImageLayer {
  id: string;
  name: string;
  url: string;
  previewUrl?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  opacity: number;
  opinion: string;
  disposition: 'keep' | 'rebuild';
  kind: 'raster' | 'text' | 'vector';
  svg?: string;
  text?: TextLayer;
  textDirty?: boolean;
  psdStyle?: TextEffects;
  role?: 'background' | 'foreground';
  preview?: boolean;
  frame?: LayerFrame;
  sourceLayerIds?: string[];
  generationSize?: { width: number; height: number };
  generationSourceUrl?: string;
  sourceCrop?: { x: number; y: number; width: number; height: number };
  generationAdaptation?: {
    scale: number;
    offsetX: number;
    offsetY: number;
    contentWidth: number;
    contentHeight: number;
    aspectError: number;
    padding: 'transparent' | 'edge-copy';
    crop?: { x: number; y: number; width: number; height: number };
  };
  cutoutBox?: [number, number, number, number];
  originalPsdIndex?: number[];
  groupPath?: string[];
}
/** A semantic planning record, not an empty raster or a generated preview. */
export type PlanningLayer = Omit<
  ImageLayer,
  'kind' | 'url' | 'previewUrl' | 'preview' | 'frame'
> & {
  kind: 'plan';
  url?: never;
  previewUrl?: never;
  preview: true;
  frame: LayerFrame;
};
export type Layer = ImageLayer | PlanningLayer;
export interface Annotation {
  id: string;
  layerId: string | null;
  type: 'arrow' | 'ellipse' | 'box' | 'pen' | 'text';
  points: number[];
  text: string;
  color: string;
  brushSize?: number;
  opacity?: number;
  strokeWidth?: number;
  fontWeight?: number;
  fontSize?: number;
  labelPosition?: [number, number];
}
export type VectorEngine = 'vectorizerCom' | 'recraft' | 'vectorizer302' | 'vectorizer';
export interface CanvasImage {
  id: string;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  source: string;
  url: string;
  layers: Layer[];
  vectorLayers?: Layer[];
  annotations: Annotation[];
  opinion: string;
  status: 'original' | 'preview' | 'layered' | 'vector';
  version: number;
  vectorUrl?: string;
  psdSource?: string;
  parentId?: string;
  sourceJobId?: string;
  sourceVersion?: number;
  basedOnOlderVersion?: boolean;
  artifactUrl?: string;
}
export interface Document {
  id: string;
  taskId: string;
  revision: number;
  images: CanvasImage[];
  settings: {
    psdMode: PsdMode;
    cutoutOptions?: CutoutOptions;
    vectorEngine: VectorEngine;
    vectorizerComMode?: 'auto' | 'codex';
    theme: 'dark' | 'light';
  };
  layout: { layersWidth: number; opinionsWidth: number; editorHeight: number };
  updatedAt: string;
}
