"""Offline SeedVR2 7B INT8 ConvRot adapter using a pinned Comfy inference core.

No Comfy server, user custom nodes, web UI, or external model paths are loaded.
"""
import gc
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / '.runtime/seedvr2-comfy'
MANIFEST = Path(__file__).with_name('seedvr2-models.json')
MODEL = ROOT / 'models/seedvr2/seedvr2_7b_int8_convrot.safetensors'
VAE = ROOT / 'models/seedvr2/seedvr2_ema_vae_fp16.safetensors'
NAME = 'SeedVR2 7B 标准版 INT8'


def status():
    try:
        record = json.loads((MODEL.parent / 'verified.json').read_text())
        manifest = json.loads(MANIFEST.read_text())
        if record['manifestHash'] != hashlib.sha256(MANIFEST.read_bytes()).hexdigest():
            raise ValueError('安装版本需要更新')
        for entry in manifest['files']:
            p = ROOT / entry['path']
            if p.stat().st_size != entry['size'] or p.stat().st_mtime_ns != record['files'][entry['path']]:
                raise ValueError('模型文件需要重新校验')
        if (SOURCE / '.canvas-revision').read_text().strip() != manifest['source']['revision']:
            raise ValueError('推理程序版本不符')
        missing = [n for n in ['comfy_kitchen', 'comfy_aimdo', 'torchsde', 'psutil', 'av', 'pydantic', 'torchvision', 'imageio_ffmpeg']
                   if importlib.util.find_spec(n) is None]
        if missing:
            raise ValueError('缺少依赖：' + ', '.join(missing))
        import torch
        if not torch.cuda.is_available():
            raise ValueError('NVIDIA CUDA 不可用')
        return {'available': True, 'model': NAME, 'message': NAME + ' 已安装并校验 · 本地运行'}
    except Exception as exc:
        return {'available': False, 'model': NAME,
                'message': NAME + ' 尚未就绪，请运行 scripts/setup-seedvr2.ps1。' + str(exc)}


def validate(options):
    if options.get('model') != 'seedvr2-7b-int8' or options['scale'] not in [2, 4]:
        raise ValueError('无效的 SeedVR2 模型或倍率')
    if options['seedColor'] not in ['lab', 'wavelet', 'adain', 'none']:
        raise ValueError('无效的颜色保持方式')
    tile, overlap = options['seedVaeTile'], options['seedVaeOverlap']
    if tile not in [256, 512, 1024] or not isinstance(overlap, int) or not 32 <= overlap <= tile / 4 or overlap % 32:
        raise ValueError('SeedVR2 编解码重叠须为32的倍数且不超过分块的1/4')
    if not 0 <= options['seedDetail'] <= 1 or options['seedMemory'] not in ['normal', 'low']:
        raise ValueError('无效的细节或显存设置')
    if not isinstance(options['seed'], int) or not 0 <= options['seed'] <= 4294967295:
        raise ValueError('无效的随机种子')


class Engine:
    """One model load per job; frames share the temporal VAE and denoiser."""
    def __init__(self, options):
        self.options = options
        # Configure the library before its first import. Never parse the canvas worker's arguments.
        sys.path.insert(0, str(SOURCE))
        import comfy.options
        comfy.options.enable_args_parsing(False)
        from comfy.cli_args import args
        args.disable_dynamic_vram = True
        args.disable_cuda_graphs = True
        args.lowvram = options['seedMemory'] == 'low'
        args.reserve_vram = 2.0 if args.lowvram else 1.0
        import torch
        import comfy.sd
        import comfy.utils
        import comfy.sample
        import comfy.model_management as mm
        # Apply again for a retry in the same worker; cli_args are otherwise read only at import.
        mm.vram_state = mm.VRAMState.LOW_VRAM if args.lowvram else mm.VRAMState.NORMAL_VRAM
        mm.EXTRA_RESERVED_VRAM = args.reserve_vram * 1024 ** 3
        from comfy_extras.nodes_seedvr import SeedVR2Preprocess, SeedVR2Conditioning, SeedVR2PostProcessing
        self.torch, self.mm = torch, mm
        self.pre, self.condition, self.post = SeedVR2Preprocess, SeedVR2Conditioning, SeedVR2PostProcessing
        self.model = comfy.sd.load_diffusion_model(str(MODEL))
        if self.model is None or self.model.model.model_config.unet_config.get('image_model') != 'seedvr2':
            raise ValueError('SeedVR2 权重加载失败')
        self.vae = comfy.sd.VAE(sd=comfy.utils.load_torch_file(str(VAE)), dtype=torch.float16)
        torch.cuda.reset_peak_memory_stats()

    def frames(self, images):
        import numpy as np
        from PIL import Image
        import comfy.sample
        torch, options, vae = self.torch, self.options, self.vae
        width, height = images[0].width * options['scale'], images[0].height * options['scale']
        if width * height > 40_000_000 or max(width, height) > 16384:
            raise ValueError('超分输出超过安全尺寸，请降低倍率')
        refs = [np.array(im.convert('RGB').resize((width,height), Image.Resampling.LANCZOS)) for im in images]
        ref = torch.from_numpy(np.stack(refs)).float() / 255
        with torch.inference_mode():
            padded = self.pre.execute(ref)[0]
            tile, overlap = options['seedVaeTile'], options['seedVaeOverlap']
            # The complete temporal chunk is encoded jointly (not independent still images).
            temporal = padded.shape[1] if padded.ndim == 5 else padded.shape[0]
            latent = vae.encode_tiled(padded, tile_x=tile, tile_y=tile, overlap=overlap, tile_t=temporal, overlap_t=0)
            positive, negative = self.condition.execute(self.model, {'samples': latent})
            noise = comfy.sample.prepare_noise(latent, options['seed'])
            samples = comfy.sample.sample(self.model, noise, 1, 1.0, 'euler', 'simple', positive, negative,
                                          latent, denoise=1.0, seed=options['seed'])
            compression = vae.spacial_compression_decode()
            decoded = vae.decode_tiled(samples, tile_x=tile//compression, tile_y=tile//compression,
                                       overlap=overlap//compression, tile_t=latent.shape[2], overlap_t=0)
            restored = self.post.execute(decoded, ref, options['seedColor'])[0]
            restored = restored.reshape(-1, restored.shape[-3], restored.shape[-2], restored.shape[-1])[:len(images)].cpu()
            if restored.shape != ref.shape or not torch.isfinite(restored).all():
                raise ValueError('SeedVR2 返回帧数、尺寸或数值异常，未提交结果')
            mixed = restored * options['seedDetail'] + ref * (1-options['seedDetail'])
            return [(frame.clamp(0,1).numpy()*255).round().astype(np.uint8) for frame in mixed]

    def close(self):
        self.mm.unload_all_models()
        self.model = self.vae = None
        gc.collect()
        self.mm.soft_empty_cache()


def run_once(input_path, output_dir, options):
    import numpy as np
    import torch
    from PIL import Image, ImageOps
    from scipy.ndimage import distance_transform_edt
    original = ImageOps.exif_transpose(Image.open(input_path)).convert('RGBA')
    width, height = original.width * options['scale'], original.height * options['scale']
    if width * height > 40_000_000 or max(width, height) > 16384:
        raise ValueError('超分输出超过安全尺寸，请降低倍率')
    pixels = np.array(original)
    holes = pixels[:,:,3] == 0
    if holes.all():
        image = original.resize((width,height), Image.Resampling.LANCZOS)
    else:
        if holes.any():
            ix = distance_transform_edt(holes, return_distances=False, return_indices=True)
            pixels[holes,:3] = pixels[ix[0][holes],ix[1][holes],:3]
        engine = Engine(options)
        try:
            image = Image.fromarray(engine.frames([Image.fromarray(pixels[:,:,:3])])[0])
            image.putalpha(original.getchannel('A').resize((width,height), Image.Resampling.LANCZOS))
        finally:
            engine.close()
    output = Path(output_dir).resolve() / 'upscaled.png'
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output)
    return {'path':str(output), 'width':width, 'height':height,
            'execution':{'model':NAME,'weightPrecision':'INT8 ConvRot','settings':options,
                         'device':torch.cuda.get_device_name(),'peakVramGB':round(torch.cuda.max_memory_allocated()/1e9,2)}}


def upscale(input_path, output_dir, options):
    validate(options)
    ready = status()
    if not ready['available']:
        raise ValueError(ready['message'])
    import torch
    started = time.monotonic()
    warnings = []
    for attempt in range(2):
        try:
            result = run_once(input_path, output_dir, options)
            return dict(result, warnings=warnings, seconds=round(time.monotonic()-started, 2))
        except torch.cuda.OutOfMemoryError:
            if attempt:
                raise ValueError('SeedVR2 显存不足，请关闭其他 GPU 任务或降低倍率；未降低结果尺寸。') from None
            options = dict(options, seedVaeTile=256, seedVaeOverlap=64, seedMemory='low')
            warnings.append('显存不足，已缩小编解码分块重试；输出尺寸和模型未改变')
        import comfy.model_management as mm
        mm.unload_all_models()
        gc.collect()
        mm.soft_empty_cache()
