"""Verified, repeatable model setup; mainland mirror first, upstream fallback."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPECS = [
    ('u2netp.onnx', None, '8e83ca70e441ab06c318d82300c84806'),
    ('isnet-general-use.onnx', None, 'fc16ebd8b0c10d971d3513d564d01e29'),
]

def download(spec):
    name, sha, md5 = spec
    target = ROOT / 'models' / name
    target.parent.mkdir(exist_ok=True)
    def valid(path):
        if not path.exists(): return False
        return hashlib.file_digest(path.open('rb'), 'sha256' if sha else 'md5').hexdigest() == (sha or md5)
    sources = ([f'https://hf-mirror.com/JTUplayer/SuperSVG/resolve/main/weights/{name}',
                f'https://huggingface.co/JTUplayer/SuperSVG/resolve/main/weights/{name}'] if sha else
               [f'https://hf-mirror.com/briaai/RMBG-1.4/resolve/main/{name}',
                f'https://github.com/danielgatis/rembg/releases/download/v0.0.0/{name}'])
    # No trustworthy mainland upstream for these rembg exports is currently known;
    # try known rembg mirror repository, and require original author's digest.
    if md5: sources[0] = f'https://hf-mirror.com/nekoshisan/rembg/resolve/main/{name}'
    source = 'existing-verified'
    manifest = ROOT / 'models' / 'manifest.json'
    if manifest.exists():
        previous = json.loads(manifest.read_text(encoding='utf-8'))
        source = next((item['source'] for item in previous if item['file'] == name), source)
    if not valid(target):
        for url in sources:
            try:
                print(f'Downloading {name}: {url}', flush=True)
                tmp = target.with_suffix(target.suffix + '.part')
                req = urllib.request.Request(url, headers={'User-Agent': 'LayerCanvas/0.1'})
                with urllib.request.urlopen(req, timeout=90) as response, tmp.open('wb') as out:
                    while chunk := response.read(1024 * 1024): out.write(chunk)
                if not valid(tmp): raise ValueError('Upstream checksum mismatch')
                tmp.replace(target)
                source = url
                break
            except Exception as exc:
                print(f'{name}: source failed: {exc}', flush=True)
        else: raise RuntimeError(f'No verified download succeeded for {name}')
    return {'file': name, 'bytes': target.stat().st_size, 'sha256': hashlib.file_digest(target.open('rb'), 'sha256').hexdigest(), 'source': source}

if __name__ == '__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(download, SPECS))
    (ROOT / 'models' / 'manifest.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps(results, indent=2))
