"""CPU media/temporal regression tests; no model download or GPU inference."""
import tempfile
from pathlib import Path
from fractions import Fraction
import unittest
from unittest.mock import patch
import numpy as np
import av
from PIL import Image
from video_upscale import temporal_chunks, inspect_video, ffmpeg, prepare, upscale_video

OPTIONS = dict(model='seedvr2-7b-int8',scale=2,seedColor='lab',seedDetail=1,seedVaeTile=512,
               seedVaeOverlap=128,seedMemory='normal',seed=42,videoFrames=9,videoOverlap=5,videoQuality=18)

class FakeEngine:
    def __init__(self, options): self.options=options
    def frames(self, images):
        return [np.array(im.resize((im.width*self.options['scale'],im.height*self.options['scale']),Image.Resampling.LANCZOS)) for im in images]
    def close(self): pass

class VideoTests(unittest.TestCase):
    def test_temporal_boundaries_preserve_every_timestamp_once(self):
        for size in [5,9,17]:
            for overlap in [1,5,9]:
                if overlap>=size: continue
                for count in [1,2,4,5,8,9,10,13,17,18,26,35]:
                    def infer(items): return [np.full((2,2,3),v,np.uint8) for v in items]
                    result=list(temporal_chunks(iter((i,i) for i in range(count)),size,overlap,infer))
                    self.assertEqual([x[0] for x in result],list(range(count)))
                    for i,rgb in result: self.assertTrue((rgb==i).all())

    @patch('seedvr2.Engine',FakeEngine)
    @patch('seedvr2.status',return_value={'available':True})
    def test_vfr_audio_rotation_and_odd_tail(self,_status):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)
            # 13 frames with nonuniform intervals and a delayed audio track.
            pts=[0,40,80,160,200,240,280,400,440,480,520,560,640]
            with av.open(str(p/'silent.mp4'),'w') as target:
                stream=target.add_stream('libx264',rate=25)
                stream.width,stream.height,stream.pix_fmt=64,48,'yuv420p'
                stream.time_base=stream.codec_context.time_base=Fraction(1,1000)
                for i,t in enumerate(pts):
                    frame=av.VideoFrame.from_ndarray(np.full((48,64,3),i*15,np.uint8),format='rgb24')
                    frame.pts,frame.time_base=t,Fraction(1,1000)
                    for packet in stream.encode(frame): target.mux(packet)
                for packet in stream.encode(): target.mux(packet)
            ffmpeg(['-i',str(p/'silent.mp4'),'-itsoffset','0.2','-f','lavfi','-i','sine=frequency=440:duration=0.4',
                    '-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac',str(p/'with-audio.mp4')])
            ffmpeg(['-display_rotation','90','-i',str(p/'with-audio.mp4'),'-c','copy',str(p/'input.mp4')])
            source=inspect_video(p/'input.mp4')
            self.assertEqual((source['width'],source['height']),(48,64))
            preview=prepare(p/'input.mp4',p/'preview')
            self.assertEqual(preview['frameCount'],13)
            result=upscale_video(p/'input.mp4',p/'output',OPTIONS)
            self.assertEqual((result['width'],result['height'],result['frameCount'],result['audioStreams']),(96,128,13,1))
            output=inspect_video(result['path'])
            self.assertEqual(output['times'],source['times'])
            # AAC encoder priming may move the first decoded sample by one audio block.
            def audio_start(file):
                with av.open(str(file)) as c:
                    f=next(c.decode(audio=0));return float(f.pts*f.time_base)
            self.assertLess(abs(audio_start(p/'input.mp4')-audio_start(result['path'])),0.035)

    def test_corrupt_file_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/'bad.mp4';file.write_text('not a video')
            with self.assertRaises(Exception): inspect_video(file)

if __name__=='__main__': unittest.main()
