"""Real SuperSVG coarse/refine inference with a native Windows Skia renderer.

The upstream neural network and SLIC scheduling are retained exactly. Rendering
is inference-only; optional diffvg gradient optimization is intentionally absent.
Transparency is preserved by an explicitly quantized all-vector alpha mask.
"""
from pathlib import Path
import ast
import math
import os
import sys
import time
from types import SimpleNamespace
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / 'vendor' / 'SuperSVG'
MODELS = ROOT / 'models'

def path_data(points):
    p = points.reshape(-1,2)
    s = f'M {p[0,0]:.4f} {p[0,1]:.4f}'
    for i in range(0,len(p),3):
        a,b,c = p[(i+1)%len(p)],p[(i+2)%len(p)],p[(i+3)%len(p)]
        s += f' C {a[0]:.4f} {a[1]:.4f} {b[0]:.4f} {b[1]:.4f} {c[0]:.4f} {c[1]:.4f}'
    return s+' Z'

def render_strokes(strokes, width=512):
    import numpy as np
    import skia
    import torch
    frames = []
    for batch in strokes.detach().cpu().numpy():
        surface = skia.Surface(width,width); canvas = surface.getCanvas(); canvas.clear(skia.ColorTRANSPARENT)
        for stroke in batch:
            alpha = float(stroke[-1]) if len(stroke)==28 else 1.0
            if alpha <= 0: continue
            points = stroke[:24].reshape(-1,2)*width
            path = skia.Path(); path.moveTo(*points[0])
            for i in range(0,12,3): path.cubicTo(*points[(i+1)%12],*points[(i+2)%12],*points[(i+3)%12])
            path.close()
            paint = skia.Paint(AntiAlias=True, Color4f=skia.Color4f(*[float(x) for x in stroke[24:27]],alpha))
            canvas.drawPath(path,paint)
        # Explicit RGBA and unpremultiplied channels match diffvg's output contract.
        rgba = surface.makeImageSnapshot().toarray(colorType=skia.ColorType.kRGBA_8888_ColorType, alphaType=skia.AlphaType.kUnpremul_AlphaType)
        frames.append(torch.from_numpy(np.asarray(rgba).copy()).permute(2,0,1).float()/255)
    return torch.stack(frames).to(strokes.device)

def load_models(device):
    import torch
    from torch import nn
    # Upstream constructors load DINO through a relative, hard-coded path.
    weights = UPSTREAM / 'weights'; weights.mkdir(exist_ok=True)
    for name in ['coarse.pt','refine.pt','dino_deitsmall16_pretrain.pth']:
        source = MODELS/name
        if not source.exists(): raise FileNotFoundError(f'Missing model: {source}. Run scripts/setup-models.ps1')
        target = weights/name
        if not target.exists():
            try: os.link(source,target)
            except OSError:
                import shutil; shutil.copyfile(source,target)
    sys.path.insert(0,str(UPSTREAM))
    from models.encoder import StrokeAttentionPredictor
    from models.refine_encoder import StrokeAttentionPredictor as RefinePredictor
    class Coarse(nn.Module):
        def __init__(self):
            super().__init__(); self.encoder=StrokeAttentionPredictor(stroke_num=128,stroke_dim=27,self_attn_depth=1,num_loss=True); self.width=512
        def predict_path(self,x,num=None): return self.encoder(x,num)
        def rendering(self,strokes): return render_strokes(strokes,self.width)
    # This is exactly FusionConvNet from upstream, without training/render imports.
    class Fusion(nn.Module):
        def __init__(self):
            super().__init__(); self.conv1=nn.Conv2d(6,16,3,1,1); self.relu1=nn.GELU(); self.conv2=nn.Conv2d(16,32,3,1,1); self.relu2=nn.GELU(); self.conv3=nn.Conv2d(32,3,3,1,1); self.relu3=nn.GELU()
        def forward(self,x): return self.relu3(self.conv3(self.relu2(self.conv2(self.relu1(self.conv1(x))))))
    class Refine(nn.Module):
        def __init__(self):
            super().__init__(); self.encoder=RefinePredictor(stroke_num=8,stroke_dim=27,self_attn_depth=4,num_loss=False); self.fuser_conv=Fusion()
        def forward(self,x,canvas): return self.encoder(self.fuser_conv(torch.cat((x,canvas),dim=1)))[:,:8]
    coarse=Coarse(); coarse.load_state_dict(torch.load(MODELS/'coarse.pt',map_location='cpu',weights_only=True),strict=True)
    refine=Refine(); raw=torch.load(MODELS/'refine.pt',map_location='cpu',weights_only=True)
    state=raw.get('model_state_dict',raw)
    state={k[len('refine_model.'):]:v for k,v in state.items() if k.startswith('refine_model.')}
    if not state: raise RuntimeError('Unexpected SuperSVG refine checkpoint schema')
    refine.load_state_dict(state,strict=True)
    return coarse.to(device).eval(), SimpleNamespace(coarse_model=refine.to(device).eval())

def inference_functions():
    import cv2
    import numpy as np
    import torch
    import torchvision.transforms as transforms
    from skimage.segmentation import slic
    names={'ensure_stroke_dim_28','decode_by_id_map','global_slic_refine_once'}
    tree=ast.parse((UPSTREAM/'inference.py').read_text(encoding='utf-8'))
    extracted=ast.Module(body=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names],type_ignores=[])
    env={'torch':torch,'np':np,'cv2':cv2,'slic':slic,'math':math,'RENDER_WIDTH':512,'PREDICT_BATCH_SIZE':16,'PATHS_PER_REGION':128,'resize_224':transforms.Resize([224,224]),'resize_512':transforms.Resize([512,512])}
    exec(compile(extracted,str(UPSTREAM/'inference.py'),'exec'),env)
    return env

def alpha_mask(alpha, width, height):
    import cv2
    import numpy as np
    nodes=[]
    # Constant alpha is represented exactly, including the outermost pixels.
    constant = bool(np.all(alpha==alpha[0,0]))
    if constant:
        level=int(alpha[0,0])
        nodes=[f'<rect width="{width}" height="{height}" fill="rgb({level},{level},{level})"/>']
    levels = [] if constant else list(range(8,256,8)) + [255]
    for level in levels:
        threshold=1 if len(levels)==1 else max(1,level-4)
        binary=(alpha>=threshold).astype('uint8')
        contours,_=cv2.findContours(binary,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
        pieces=[]
        for contour in contours:
            points=cv2.approxPolyDP(contour,0.25,True).reshape(-1,2)
            if len(points)<3: continue
            pieces.append('M '+' L '.join(f'{x:.2f} {y:.2f}' for x,y in points)+' Z')
        if pieces: nodes.append(f'<path fill="rgb({level},{level},{level})" fill-rule="evenodd" d="{" ".join(pieces)}"/>')
    return f'<defs><mask id="source-alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="{width}" height="{height}" style="mask-type:luminance">'+''.join(nodes)+'</mask></defs>'

_MODEL_CACHE={}

def vectorize(input_path,output_path,path_count=1024,device='auto',options=None):
    import numpy as np
    import torch
    from PIL import Image,ImageOps
    started=time.monotonic()
    from vector_options import validate_options
    options=validate_options('supersvg', {'pathNum':path_count,'device':device,**(options or {})})
    path_count=options['pathNum'];device=options['device']
    if options['optimizeIter']:
        raise ValueError('SuperSVG Windows Skia backend does not support optimizeIter > 0; no optimization was performed')
    torch.set_num_threads(min(8,os.cpu_count() or 4))
    if device=='auto': device='cuda' if torch.cuda.is_available() else 'cpu'
    if device=='cuda' and not torch.cuda.is_available(): raise RuntimeError('CUDA is unavailable')
    dev=torch.device(device); torch.manual_seed(options['seed']); np.random.seed(options['seed'])
    if device not in _MODEL_CACHE: _MODEL_CACHE[device]=load_models(dev)
    coarse,refine=_MODEL_CACHE[device]
    funcs=inference_functions()
    original=ImageOps.exif_transpose(Image.open(input_path)).convert('RGBA')
    alpha=np.asarray(original.getchannel('A'))
    background=Image.new('RGBA',original.size,'white'); background.alpha_composite(original)
    rgb=background.convert('RGB')
    inference_start=time.monotonic()
    with torch.inference_mode():
        strokes,_=funcs['decode_by_id_map'](rgb,coarse,dev,max(1,path_count//64))
        strokes=funcs['global_slic_refine_once'](rgb,strokes,coarse,refine,path_count,options['refinePathsPerSegment'],options['refineBatchSize'],dev)
    infer_seconds=time.monotonic()-inference_start
    strokes=strokes[0].detach().cpu().numpy()
    w,h=original.size; transparent=bool(alpha.min()<255)
    body=[]
    for stroke in strokes:
        opacity=float(stroke[-1]) if len(stroke)==28 else 1
        if opacity<=0: continue
        points=stroke[:24].reshape(-1,2)*np.array([w,h]); color=np.clip(np.round(stroke[24:27]*255),0,255).astype(int)
        body.append(f'<path d="{path_data(points)}" fill="rgb({color[0]},{color[1]},{color[2]})" fill-opacity="{opacity:.4f}"/>')
    defs=alpha_mask(alpha,w,h) if transparent else ''
    mask=' mask="url(#source-alpha)"' if transparent else ''
    svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{defs}<g{mask}>'+''.join(body)+'</g></svg>'
    ET.fromstring(svg)
    target=Path(output_path).resolve();target.parent.mkdir(parents=True,exist_ok=True);target.write_text(svg,encoding='utf-8')
    warnings=['使用 SuperSVG 官方 coarse/refine 网络；Windows Skia 渲染；未执行 diffvg 梯度微调。']
    if transparent: warnings.append('透明度保留为纯矢量蒙版，连续透明度量化为 32 级；未嵌入位图。')
    return {'path':str(target),'method':'supersvg','device':device,'parameters':options,'paths':len(body),'seconds':round(time.monotonic()-started,3),'inferenceSeconds':round(infer_seconds,3),'warnings':warnings}
