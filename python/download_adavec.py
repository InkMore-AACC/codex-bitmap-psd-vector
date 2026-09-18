"""SAM checkpoint mirror-first download with pinned SHA-256 verification."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
SHA='a7bf3b02f3ebf1267aba913ff637d9a2d5c33d3173bb679e46d9f338c26f262e'
NAME='sam_vit_h_4b8939.pth'
SOURCES=[f'https://hf-mirror.com/ybelkada/segment-anything/resolve/main/checkpoints/{NAME}',f'https://dl.fbaipublicfiles.com/segment_anything/{NAME}']

def main():
    target=ROOT/'models'/NAME;target.parent.mkdir(exist_ok=True)
    def digest(path):
        with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
    if target.exists() and digest(target)==SHA: return
    for url in SOURCES:
        try:
            print(f'Downloading {url}',flush=True)
            part=target.with_suffix('.pth.part')
            request=urllib.request.Request(url,headers={'User-Agent':'LayerCanvas/0.2'})
            with urllib.request.urlopen(request,timeout=90) as response,part.open('wb') as stream:
                while chunk:=response.read(4*1024*1024):stream.write(chunk)
            if digest(part)!=SHA:raise RuntimeError('SAM checkpoint SHA-256 mismatch')
            part.replace(target)
            (ROOT/'models/adavec-manifest.json').write_text(json.dumps({'file':NAME,'sha256':SHA,'source':url,'bytes':target.stat().st_size},indent=2),encoding='utf-8')
            print('Verified SAM checkpoint',flush=True);return
        except Exception as exc:print(f'Source failed: {exc}',flush=True)
    raise RuntimeError('Unable to download verified SAM checkpoint')

if __name__=='__main__':main()
