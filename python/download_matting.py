"""Pinned official model snapshots. Mainland mirror first; all files verified."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request
from download_utils import file_hexdigest

ROOT = Path(__file__).resolve().parents[1]
SPECS = json.loads((ROOT / 'python/matting_models.json').read_text(encoding='utf-8'))

def verified(file, spec):
    if not file.is_file(): return False
    if 'sha256' in spec:
        return file_hexdigest(file) == spec['sha256']
    with file.open('rb') as stream:
        content = stream.read()
    return hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest() == spec['gitSha1']

def download_model(name):
    spec = SPECS[name]
    folder = ROOT / 'models' / name
    folder.mkdir(parents=True, exist_ok=True)
    for filename, check in spec['files'].items():
        target = folder / filename
        if verified(target, check): continue
        for host in ['https://hf-mirror.com', 'https://huggingface.co']:
            url = f"{host}/{spec['repo']}/resolve/{spec['revision']}/{filename}"
            tmp = target.with_suffix(target.suffix + '.part')
            try:
                print(f'{name}: downloading {filename} from {host}', flush=True)
                request = urllib.request.Request(url, headers={'User-Agent':'LayerCanvas/0.1'})
                with urllib.request.urlopen(request, timeout=60) as response, tmp.open('wb') as output:
                    while chunk := response.read(1024 * 1024): output.write(chunk)
                if not verified(tmp, check): raise ValueError('文件校验不符')
                tmp.replace(target)
                break
            except Exception as exc:
                print(f'{name}/{filename}: {exc}', flush=True)
        else: raise RuntimeError(f'{name}/{filename}: 国内镜像与官方源均未成功，未使用未验证文件')
    (folder/'verified.json').write_text(json.dumps({'repo':spec['repo'],'revision':spec['revision'],'files':spec['files']},indent=2),encoding='utf-8')
    print(f'{name}: all files verified', flush=True)

if __name__ == '__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(download_model, SPECS))
