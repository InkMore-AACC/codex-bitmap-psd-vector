"""Local-only fine matting with pinned, verified public weights; no image generation."""
import json
import math
import os
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
_MODELS={}
BASE={'padding':0,'feather':0,'offset':0,'blackPoint':0,'whitePoint':1}
DEFAULTS={
    'coarse':{**BASE,'threads':8},
    'birefnet':{**BASE,'padding':32,'resolution':2048,'device':'auto','precision':'fp32','decontaminate':False},
    'lucida':{**BASE,'padding':32,'resolution':1024,'device':'auto','precision':'fp32','decontaminate':False},
}

def options_for(model, incoming=None):
    if model not in DEFAULTS: raise ValueError('未知抠图模型')
    values={**DEFAULTS[model],**(incoming or {})}
    if set(values)-set(DEFAULTS[model]): raise ValueError('未知抠图参数')
    bounds={'padding':(0,256,True),'feather':(0,10,False),'offset':(-20,20,True),'blackPoint':(0,.95,False),'whitePoint':(.05,1,False),'threads':(1,16,True),'resolution':(512,3072,True)}
    for key,(lo,hi,integer) in bounds.items():
        if key not in values: continue
        v=values[key]
        if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not lo<=v<=hi or (integer and int(v)!=v): raise ValueError(f'{key}: 参数超出范围')
    if values['whitePoint']<=values['blackPoint']: raise ValueError('不透明点必须大于透明点')
    if 'resolution' in values and values['resolution']%32: raise ValueError('处理分辨率必须为32的倍数')
    if values.get('device','auto') not in ['auto','cuda','cpu'] or values.get('precision','fp32') not in ['fp32','fp16']: raise ValueError('设备或精度无效')
    if 'decontaminate' in values and not isinstance(values['decontaminate'],bool): raise ValueError('去色设置必须是开关')
    return values

def load_model(model, options):
    # Inference must never fetch missing weights, architecture or backbone online.
    os.environ['HF_HUB_OFFLINE']='1'
    os.environ['TRANSFORMERS_OFFLINE']='1'
    import torch
    from transformers import AutoModelForImageSegmentation
    from download_matting import SPECS, verified
    requested=options['device']
    if requested=='cuda' and not torch.cuda.is_available(): raise RuntimeError('CUDA 不可用，请在设置里选择自动或 CPU')
    device='cuda' if requested!='cpu' and torch.cuda.is_available() else 'cpu'
    precision='fp16' if device=='cuda' and options['precision']=='fp16' else 'fp32'
    key=(model,device,precision)
    if key not in _MODELS:
        folder=ROOT/'models'/model
        for name,check in SPECS[model]['files'].items():
            if not verified(folder/name,check): raise RuntimeError(f'{model} 文件缺失或校验失败，请运行 scripts/setup-models.ps1 -FineMatting')
        config=json.loads((folder/'config.json').read_text())
        if config.get('bb_pretrained') is not False: raise RuntimeError('模型配置不允许下载外部骨干权重')
        torch.set_num_threads(min(8,os.cpu_count() or 4))
        net=AutoModelForImageSegmentation.from_pretrained(str(folder),trust_remote_code=True,local_files_only=True)
        net.eval().to(device=device,dtype=torch.float16 if precision=='fp16' else torch.float32)
        _MODELS[key]=net
    return _MODELS[key],device,precision

def fine_mask(image, model, options):
    import numpy as np
    import torch
    from PIL import Image
    from torchvision import transforms
    net,device,precision=load_model(model,options)
    # Match public demo preprocessing. Keep source pixels separately at original size.
    rgb=image.convert('RGBA')
    white=Image.new('RGBA',rgb.size,(255,255,255,255))
    rgb=Image.alpha_composite(white,rgb).convert('RGB')
    size=options['resolution']
    transform=transforms.Compose([transforms.Resize((size,size)),transforms.ToTensor(),transforms.Normalize([.485,.456,.406],[.229,.224,.225])])
    data=transform(rgb).unsqueeze(0).to(device=device,dtype=torch.float16 if precision=='fp16' else torch.float32)
    with torch.inference_mode():
        prediction=net(data)[-1].sigmoid().float()
        if not torch.isfinite(prediction).all(): raise RuntimeError('模型输出异常，请切换 FP32 或降低分辨率')
        alpha=torch.nn.functional.interpolate(prediction,size=(image.height,image.width),mode='bilinear',align_corners=False)[0,0].cpu().numpy()
    # Do not min-max stretch / threshold the soft alpha: that destroys faint glows.
    return np.clip(alpha,0,1),{'device':device,'precision':precision,'resolution':size}

def adjust_alpha(alpha, options):
    import cv2
    import numpy as np
    alpha=np.clip((alpha-options['blackPoint'])/(options['whitePoint']-options['blackPoint']),0,1).astype(np.float32)
    radius=abs(int(options['offset']))
    if radius:
        kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(radius*2+1,radius*2+1))
        alpha=(cv2.dilate if options['offset']>0 else cv2.erode)(alpha,kernel)
    if options['feather']>0: alpha=cv2.GaussianBlur(alpha,(0,0),options['feather'])
    return np.clip(alpha,0,1)

def decontaminate(rgb, alpha):
    # Foreground estimation (FB blur fusion), also used by official BiRefNet demo.
    import cv2
    import numpy as np
    image=rgb.astype(np.float32)/255
    a=alpha[:,:,None].astype(np.float32)
    fg,bg=image.copy(),image.copy()
    for radius in [90,6]:
        blurred=cv2.blur(a,(radius,radius))[:,:,None]
        fg_mean=cv2.blur(fg*a,(radius,radius))/(blurred+1e-5)
        bg_mean=cv2.blur(bg*(1-a),(radius,radius))/(1-blurred+1e-5)
        fg=np.clip(fg_mean+a*(image-a*fg_mean-(1-a)*bg_mean),0,1)
        bg=bg_mean
    return np.round(fg*255).astype(np.uint8)
