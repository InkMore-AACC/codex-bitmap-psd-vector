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
from matting import options_for, fine_mask, adjust_alpha, decontaminate

def status():
    weights = {n: (MODELS / n).is_file() for n in ['u2netp.onnx']}
    deps = all(importlib.util.find_spec(n) is not None for n in ['torch','transformers','timm','kornia','einops','safetensors'])
    fine_ready = {n: deps and all((MODELS/n/f).is_file() for f in ['model.safetensors','birefnet.py','BiRefNet_config.py','config.json','verified.json']) for n in ['birefnet','lucida']}
    return {**fine_ready, 'python': sys.version.split()[0], 'weights': weights,
            'segmentation': weights['u2netp.onnx'] and importlib.util.find_spec('onnxruntime') is not None}


_SESSIONS = {}

def model_mask(image, threads=8):
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    name = 'u2netp.onnx'
    key=(name,threads)
    if key not in _SESSIONS:
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(threads, os.cpu_count() or 4)
        options.inter_op_num_threads = 1
        _SESSIONS[key] = ort.InferenceSession(str(MODELS / name), options, providers=['CPUExecutionProvider'])
    session = _SESSIONS[key]
    size = 320
    arr = np.asarray(image.convert('RGB').resize((size, size), Image.Resampling.LANCZOS), dtype=np.float32)
    arr = arr / max(float(arr.max()), 1)
    mean = [0.485, 0.456, 0.406]
    std = [0.229, 0.224, 0.225]
    arr = ((arr - np.asarray(mean, dtype=np.float32)) / np.asarray(std, dtype=np.float32)).transpose(2,0,1)[None]
    pred = session.run(None, {session.get_inputs()[0].name: arr})[0][0,0]
    pred = (pred-pred.min()) / max(float(pred.max()-pred.min()), 1e-8)
    return Image.fromarray((pred*255).astype('uint8')).resize(image.size, Image.Resampling.LANCZOS)

def segment(input_path, output_dir, boxes_file=None, model="coarse", options=None):
    import numpy as np
    from PIL import Image, ImageOps
    started = time.monotonic()
    options = options_for(model, options)
    execution = {'device':'cpu','precision':'fp32'}
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
        bx=float(box.get('x',0)); by=float(box.get('y',0))
        bw=float(box.get('width',im.width)); bh=float(box.get('height',im.height))
        if not all(__import__('math').isfinite(v) for v in [bx,by,bw,bh]) or bw<=0 or bh<=0: raise ValueError(f'Invalid box {i}')
        if bx>=im.width or by>=im.height or bx+bw<=0 or by+bh<=0: raise ValueError(f'Box {i} outside image')
        padding=0 if box.get('kind')=='background' else int(options['padding'])
        x=max(0,int(__import__('math').floor(bx))-padding); y=max(0,int(__import__('math').floor(by))-padding)
        right=min(im.width,int(__import__('math').ceil(bx+bw))+padding); bottom=min(im.height,int(__import__('math').ceil(by+bh))+padding)
        w=right-x; h=bottom-y
        if w<=0 or h<=0: raise ValueError(f'Invalid box {i}')
        crop = im.crop((x,y,x+w,y+h))
        name = str(box.get('name', f'图层 {i+1}'))
        if box.get('kind') == 'background':
            # Defer background alpha until every foreground model mask is known.
            rgba = np.asarray(crop).copy()
            backgrounds.append((len(result),x,y,w,h))
            warnings.append(f'{name}: 预览背景已扣除前景，遮挡区域待 Codex 补全，不是最终背景')
        else:
            original_alpha = np.asarray(crop.getchannel('A')).astype(np.float32)/255
            if original_alpha.min() < 1 and not boxes_file:
                alpha = adjust_alpha(original_alpha.copy(),options)
            else:
                if model in ['birefnet','lucida']:
                    raw,execution=fine_mask(crop,model,options)
                else:
                    raw=np.asarray(model_mask(crop,options['threads'])).astype(np.float32)/255
                alpha=adjust_alpha(raw,options)*original_alpha
            rgba=np.asarray(crop).copy()
            if options.get('decontaminate'): rgba[:,:,:3]=decontaminate(rgba[:,:,:3],alpha)
            alpha=np.round(np.clip(alpha,0,1)*255).astype('uint8')
            rgba[:,:,3]=alpha
            foreground_union[y:y+h,x:x+w] = np.maximum(foreground_union[y:y+h,x:x+w],alpha)
            if int((alpha > 128).sum()) < 10: warnings.append(f'{name}: 模型未找到可信主体，请调整框选或交给 Codex')
        path = out / f'layer-{i+1}.png'
        Image.fromarray(rgba).save(path)
        result.append({'name':name, 'path':str(path), 'x':x, 'y':y, 'width':w, 'height':h, 'preview': True})
    for index,x,y,w,h in backgrounds:
        path = Path(result[index]['path'])
        rgba = np.asarray(Image.open(path)).copy()
        rgba[:,:,3] = (rgba[:,:,3].astype(np.float32) * (1-foreground_union[y:y+h,x:x+w]/255)).astype('uint8')
        Image.fromarray(rgba).save(path)
        result[index]['preview'] = True
    return {'layers':result, 'width':im.width, 'height':im.height,
            'method':model, 'options':options, 'execution':execution, 'warnings':warnings,
            'seconds':round(time.monotonic()-started,3)}

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    seg = sub.add_parser('segment'); seg.add_argument('--input',required=True); seg.add_argument('--output',required=True)
    seg.add_argument('--model',choices=['coarse','birefnet','lucida'],default='coarse'); seg.add_argument('--options',help='Frozen cutout parameter JSON');
    seg.add_argument('--boxes')
    args = parser.parse_args()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            if args.command == 'status': result = status()
            elif args.command == 'segment': result = segment(args.input,args.output,args.boxes,args.model,json.loads(Path(args.options).read_text(encoding='utf-8-sig')) if args.options else None)
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
