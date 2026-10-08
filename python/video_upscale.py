"""Bounded-memory, temporal SeedVR2 video pipeline. No frame interpolation."""
from fractions import Fraction
from pathlib import Path
import json
import os
import subprocess
import time

MAX_SECONDS = 600


def ffmpeg(arguments):
    import imageio_ffmpeg
    result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', *arguments],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=1800)
    if result.returncode:
        raise ValueError('视频编码失败：' + result.stderr.decode('utf-8', errors='replace')[-1800:])


def oriented(frame):
    import numpy as np
    rotation = frame.rotation
    if rotation % 90:
        raise ValueError('暂不支持非直角旋转的视频，请先导出为正常方向的 MP4')
    return np.rot90(frame.to_ndarray(format='rgb24'), round(rotation/90)).copy()


def inspect_video(input_path):
    import av
    with av.open(str(input_path)) as container:
        if len(container.streams.video) != 1:
            raise ValueError('请选择只有一条画面的普通视频')
        stream = container.streams.video[0]
        if stream.codec_context.color_trc in [16, 18]:
            raise ValueError('当前支持 SDR 视频，HDR/PQ/HLG 请先转换为 SDR，避免颜色错误')
        if stream.sample_aspect_ratio and stream.sample_aspect_ratio != 1:
            raise ValueError('暂不支持非方形像素视频，请先转换为方形像素，避免画面变形')
        rate = stream.average_rate or stream.guessed_rate
        if not rate or not 0 < rate <= 120:
            raise ValueError('视频帧率无法识别或超过120帧/秒')
        times, durations = [], []
        width = height = 0
        first = None
        for frame in container.decode(stream):
            if first is None:
                if any(c.bits > 8 for c in frame.format.components) or len(frame.format.components) == 4:
                    raise ValueError('当前支持8位不透明 SDR 视频；高位深或透明视频请先转换')
                first = oriented(frame)
                height, width = first.shape[:2]
                if width * height > 40_000_000:
                    raise ValueError('输入视频单帧尺寸过大')
            elif (frame.width, frame.height) != (stream.width, stream.height):
                raise ValueError('暂不支持中途改变尺寸的视频')
            if frame.pts is None:
                raise ValueError('视频缺少时间戳，请重新封装为 MP4 后导入')
            timestamp = Fraction(frame.pts) * frame.time_base
            if times and timestamp <= times[-1]:
                raise ValueError('视频时间戳重复或倒退，请重新封装后导入')
            times.append(timestamp)
            durations.append(Fraction(frame.duration) * frame.time_base if frame.duration else 1/rate)
            if timestamp - times[0] > MAX_SECONDS or len(times) > MAX_SECONDS * 120:
                raise ValueError('当前单段视频最多10分钟，请先分段处理')
        if not times:
            raise ValueError('视频没有可解码的画面')
        duration = times[-1] - times[0] + durations[-1]
        if duration > MAX_SECONDS + 1/rate:
            raise ValueError('当前单段视频最多10分钟，请先分段处理')
        return {'width':width, 'height':height, 'duration':float(duration), 'fpsNumerator':rate.numerator,
                'fpsDenominator':rate.denominator, 'frameCount':len(times), 'audioStreams':len(container.streams.audio),
                'times':times, 'durations':durations, 'timeBase':stream.time_base, 'first':first}


def public_info(info):
    return {k:info[k] for k in ['width','height','duration','fpsNumerator','fpsDenominator','frameCount','audioStreams']}


def audio_spans(file, count):
    import av
    spans = []
    for index in range(count):
        start = end = None
        with av.open(str(file)) as container:
            for frame in container.decode(audio=index):
                if frame.pts is None: raise ValueError('音轨缺少时间戳，无法验证同步')
                timestamp = float(frame.pts * frame.time_base)
                if start is None: start = timestamp
                end = timestamp + frame.samples / frame.sample_rate
        if start is None: raise ValueError('音轨没有可解码的声音')
        spans.append((start, end))
    return spans


def prepare(input_path, output_dir):
    from PIL import Image
    info = inspect_video(input_path)
    out = Path(output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(info['first']).save(out/'poster.png')
    # Browser-compatible preview is separate; inference always reads the original.
    ffmpeg(['-i', str(input_path), '-map', '0:v:0', '-map', '0:a:0?', '-vf',
            "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-fps_mode', 'passthrough', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', str(out/'preview.mp4')])
    return {**public_info(info), 'poster':str(out/'poster.png'), 'preview':str(out/'preview.mp4')}


def temporal_chunks(iterator, size, overlap, infer):
    """Yield each source timestamp exactly once; blend only the same frames across chunks."""
    import numpy as np
    batch, pending = [], []
    while True:
        while len(batch) < size:
            try:
                batch.append(next(iterator))
            except StopIteration:
                break
        if not batch:
            return
        output = infer([item[1] for item in batch])
        if len(output) != len(batch):
            raise ValueError('视频模型返回的帧数不一致')
        for i, previous in enumerate(pending):
            weight = (i+1)/(len(pending)+1)
            output[i] = np.clip(np.rint(previous.astype(np.float32)*(1-weight)+output[i].astype(np.float32)*weight),0,255).astype(np.uint8)
        # Lookahead prevents reprocessing an overlap-only tail.
        try:
            following = next(iterator)
        except StopIteration:
            for item, rgb in zip(batch, output):
                yield item[0], rgb
            return
        emit = len(batch)-overlap
        for item, rgb in zip(batch[:emit], output[:emit]):
            yield item[0], rgb
        pending, batch = output[emit:], batch[emit:] + [following]


def upscale_video(input_path, output_dir, options):
    import av
    import torch
    from PIL import Image
    from seedvr2 import Engine, validate, status, NAME
    validate(options)
    size, overlap = options['videoFrames'], options['videoOverlap']
    if size not in [5,9,17] or overlap not in [1,5,9] or overlap >= size or options['videoQuality'] not in [16,18,23]:
        raise ValueError('视频参数无效')
    ready = status()
    if not ready['available']:
        raise ValueError(ready['message'])
    out = Path(output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    def progress(message):
        temporary = out/'video-progress.tmp'
        temporary.write_text(json.dumps({'message':message},ensure_ascii=False),encoding='utf-8')
        os.replace(temporary,out/'video-progress.json')
    progress('检查视频尺寸、时间戳与音轨…')
    info = inspect_video(input_path)
    width, height = info['width']*options['scale'], info['height']*options['scale']
    if width * height > 40_000_000 or max(width,height)>16384:
        raise ValueError('超分输出超过安全尺寸，请降低倍率')
    engine = Engine(options)
    warnings = []
    def infer(images):
        try:
            return engine.frames(images)
        except torch.cuda.OutOfMemoryError:
            # Retry the same temporal group, never silently split it into unrelated images.
            engine.close()
            engine.__init__(dict(options,seedMemory='low',seedVaeTile=256,seedVaeOverlap=64))
            warnings.append('显存不足，使用省显存编解码重试；连续帧数和输出尺寸不变')
            try:
                return engine.frames(images)
            except torch.cuda.OutOfMemoryError:
                raise ValueError('视频超分显存不足，请将连续处理帧数改为5或降低倍率后重试') from None
    def frames():
        with av.open(str(input_path)) as source:
            for index, frame in enumerate(source.decode(video=0)):
                yield index, Image.fromarray(oriented(frame))
    count = 0
    silent = out/'silent.mp4'
    time_base = info['timeBase']
    rate = Fraction(info['fpsNumerator'], info['fpsDenominator'])
    durations = {int((t-info['times'][0])/time_base): int(((info['times'][i+1]-t) if i+1<len(info['times']) else info['durations'][i])/time_base) for i,t in enumerate(info['times'])}
    try:
        with av.open(str(silent),'w') as target:
            stream = target.add_stream('libx264',rate=rate)
            stream.width, stream.height, stream.pix_fmt = width, height, 'yuv420p'
            stream.time_base = stream.codec_context.time_base = time_base
            stream.options = {'crf':str(options['videoQuality']), 'preset':'medium'}
            def mux(packets):
                for packet in packets:
                    if packet.pts in durations: packet.duration = durations[packet.pts]
                    target.mux(packet)
            for index, rgb in temporal_chunks(iter(frames()),size,overlap,infer):
                if rgb.shape[:2] != (height,width): raise ValueError('超分视频帧尺寸不一致')
                frame = av.VideoFrame.from_ndarray(rgb,format='rgb24')
                frame.pts = int((info['times'][index]-info['times'][0])/time_base)
                frame.time_base = time_base
                mux(stream.encode(frame))
                count += 1
                progress(f'视频超分：{count}/{info["frameCount"]} 帧 · 连续{size}帧，重叠{overlap}帧')
            mux(stream.encode())
        peak = round(torch.cuda.max_memory_allocated()/1e9,2)
    finally:
        engine.close()
    if count != info['frameCount']: raise ValueError('超分视频帧数丢失，未创建结果节点')
    progress('合并原音轨并检查结果…')
    output = out/'upscaled.mp4'
    ffmpeg(['-copyts','-i',str(silent),'-itsoffset',str(-float(info['times'][0])),'-i',str(input_path),
            '-map','0:v:0','-map','1:a?','-c:v','copy','-c:a','aac','-b:a','192k','-t',str(info['duration']),
            '-avoid_negative_ts','disabled','-movflags','+faststart',str(output)])
    result = inspect_video(output)
    if (result['width'],result['height'],result['frameCount'],result['audioStreams']) != (width,height,count,info['audioStreams']):
        raise ValueError('结果尺寸、帧数或音轨数不符合原视频，未提交')
    tolerance = max(0.002,float(time_base)*2)
    if any(abs(float((a-result['times'][0])-(b-info['times'][0]))) > tolerance for a,b in zip(result['times'],info['times'])):
        raise ValueError('结果时间戳与原视频不一致，未提交')
    if abs(result['duration']-info['duration']) > max(0.05,1/float(rate)):
        raise ValueError('结果时长与原视频不一致，未提交')
    origin = float(info['times'][0])
    for before, after in zip(audio_spans(input_path,info['audioStreams']),audio_spans(output,result['audioStreams'])):
        expected = (max(0, before[0]-origin), min(info['duration'],before[1]-origin))
        if abs(expected[0]-after[0]) > 0.06 or abs(expected[1]-after[1]) > 0.06:
            raise ValueError('结果音轨起止时间与原视频不一致，未提交')
    Image.fromarray(result['first']).save(out/'poster.png')
    silent.unlink(missing_ok=True)
    progress('视频超分完成，正在回传画布…')
    return {**public_info(result),'path':str(output),'poster':str(out/'poster.png'),
            'warnings':list(dict.fromkeys(warnings)), 'seconds':round(time.monotonic()-started,2),
            'execution':{'model':NAME,'settings':engine.options,'requestedSettings':options,'temporal':True,'peakVramGB':peak,'verifiedFrames':count}}
