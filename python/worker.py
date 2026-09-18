"""Local model worker. One JSON result on stdout; diagnostics on stderr."""
from __future__ import annotations
import argparse
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / 'models'

def status():
    weights = {n: (MODELS / n).is_file() for n in ['u2netp.onnx', 'isnet-general-use.onnx']}
    return {'python': sys.version.split()[0], 'weights': weights,
            'segmentation': weights['u2netp.onnx'] and importlib.util.find_spec('onnxruntime') is not None,
            'fineSegmentation': weights['isnet-general-use.onnx'] and importlib.util.find_spec('onnxruntime') is not None}


_SESSIONS = {}

def model_mask(image, fine=False):
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    name = 'isnet-general-use.onnx' if fine else 'u2netp.onnx'
    if name not in _SESSIONS:
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(8, os.cpu_count() or 4)
        options.inter_op_num_threads = 1
        _SESSIONS[name] = ort.InferenceSession(str(MODELS / name), options, providers=['CPUExecutionProvider'])
    session = _SESSIONS[name]
    size = 1024 if fine else 320
    arr = np.asarray(image.convert('RGB').resize((size, size), Image.Resampling.LANCZOS), dtype=np.float32)
    arr = arr / max(float(arr.max()), 1)
    mean = [0.5]*3 if fine else [0.485, 0.456, 0.406]
    std = [1.0]*3 if fine else [0.229, 0.224, 0.225]
    arr = ((arr - np.asarray(mean, dtype=np.float32)) / np.asarray(std, dtype=np.float32)).transpose(2,0,1)[None]
    pred = session.run(None, {session.get_inputs()[0].name: arr})[0][0,0]
    pred = (pred-pred.min()) / max(float(pred.max()-pred.min()), 1e-8)
    return Image.fromarray((pred*255).astype('uint8')).resize(image.size, Image.Resampling.LANCZOS)

def segment(input_path, output_dir, boxes_file=None, fine=False):
    import numpy as np
    from PIL import Image, ImageOps
    started = time.monotonic()
    im = ImageOps.exif_transpose(Image.open(input_path)).convert('RGBA')
    out = Path(output_dir).resolve(); out.mkdir(parents=True, exist_ok=True)
    boxes = json.loads(Path(boxes_file).read_text(encoding='utf-8-sig')) if boxes_file else None
    if isinstance(boxes, dict): boxes = boxes.get('layers', boxes.get('boxes', []))
    boxes = boxes or [{'name': '主体', 'x':0, 'y':0, 'width':im.width, 'height':im.height}]
    if len(boxes) > 128: raise ValueError('At most 128 local cutouts per request')
    result = []; warnings = []
    foreground_union = np.zeros((im.height,im.width),dtype=np.uint8)
    backgrounds = []
    for i, box in enumerate(boxes):
        if isinstance(box, list): box = dict(zip(['x','y','width','height'], box))
        if 'box' in box: box = {**box, **dict(zip(['x','y','width','height'], box['box']))}
        x = max(0, int(box.get('x',0))); y = max(0, int(box.get('y',0)))
        w = min(im.width-x, int(box.get('width',im.width))); h = min(im.height-y, int(box.get('height',im.height)))
        if w <= 0 or h <= 0: raise ValueError(f'Invalid box {i}')
        crop = im.crop((x,y,x+w,y+h))
        name = str(box.get('name', f'图层 {i+1}'))
        if box.get('kind') == 'background':
            # Defer background alpha until every foreground model mask is known.
            rgba = np.asarray(crop).copy()
            backgrounds.append((len(result),x,y,w,h))
            warnings.append(f'{name}: 预览背景已扣除前景，遮挡区域待 Codex 补全，不是最终背景')
        else:
            original_alpha = np.asarray(crop.getchannel('A'))
            if original_alpha.min() < 255 and not boxes_file:
                alpha = original_alpha
            else:
                alpha = np.asarray(model_mask(crop, fine))
                alpha = (alpha.astype(np.float32) * original_alpha / 255).astype('uint8')
            rgba = np.asarray(crop).copy(); rgba[:,:,3] = alpha
            foreground_union[y:y+h,x:x+w] = np.maximum(foreground_union[y:y+h,x:x+w],alpha)
            if int((alpha > 128).sum()) < 10: warnings.append(f'{name}: 模型未找到可信主体，请调整框选或交给 Codex')
        path = out / f'layer-{i+1}.png'
        Image.fromarray(rgba).save(path)
        result.append({'name':name, 'path':str(path), 'x':x, 'y':y, 'width':w, 'height':h, 'preview': not fine})
    for index,x,y,w,h in backgrounds:
        path = Path(result[index]['path'])
        rgba = np.asarray(Image.open(path)).copy()
        rgba[:,:,3] = (rgba[:,:,3].astype(np.float32) * (1-foreground_union[y:y+h,x:x+w]/255)).astype('uint8')
        Image.fromarray(rgba).save(path)
        result[index]['preview'] = True
    return {'layers':result, 'width':im.width, 'height':im.height,
            'method':'isnet-general-use' if fine else 'u2netp', 'warnings':warnings,
            'seconds':round(time.monotonic()-started,3)}

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    seg = sub.add_parser('segment'); seg.add_argument('--input',required=True); seg.add_argument('--output',required=True)
    seg.add_argument('--boxes'); seg.add_argument('--fine',action='store_true')
    vec = sub.add_parser('vectorize'); vec.add_argument('--input',required=True); vec.add_argument('--output',required=True)
    vec.add_argument('--paths',type=int,default=1024); vec.add_argument('--device',choices=['auto','cpu','cuda'],default='auto')
    vec.add_argument('--engine',choices=['supersvg','adavec'],default='supersvg')
    vec.add_argument('--options',help='Path to a JSON object with engine-specific parameters')
    args = parser.parse_args()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            if args.command == 'status': result = status()
            elif args.command == 'segment': result = segment(args.input,args.output,args.boxes,args.fine)
            else:
                options=json.loads(Path(args.options).read_text(encoding='utf-8-sig')) if args.options else {}
                if args.engine=='adavec':
                    from adavec_adapter import dispatch
                    result=dispatch(args.input,args.output,{'device':args.device,**options})
                else:
                    from supersvg_adapter import vectorize
                    result = vectorize(args.input,args.output,args.paths,args.device,options)
        print(json.dumps(result,ensure_ascii=False))
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'error':str(exc),'type':type(exc).__name__},ensure_ascii=False))
        return 1
    return 0

if __name__ == '__main__':
    if hasattr(sys.stdout,'reconfigure'): sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr,'reconfigure'): sys.stderr.reconfigure(encoding='utf-8')
    raise SystemExit(main())
