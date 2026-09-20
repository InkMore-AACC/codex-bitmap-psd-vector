"""Verified, repeatable model setup; mainland mirror first, upstream fallback."""
import concurrent.futures
from download_utils import file_hexdigest
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPECS = [
    ('u2netp.onnx', None, '8e83ca70e441ab06c318d82300c84806'),
]

def download(spec):
    name, sha, md5 = spec
    target = ROOT / 'models' / name
    target.parent.mkdir(exist_ok=True)
    def valid(path):
        if not path.exists(): return False
        return file_hexdigest(path, 'sha256' if sha else 'md5') == (sha or md5)
    # Mirror data is accepted only if it matches the upstream digest.
    sources = [f'https://hf-mirror.com/nekoshisan/rembg/resolve/main/{name}',
               f'https://github.com/danielgatis/rembg/releases/download/v0.0.0/{name}']
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
    return {'file': name, 'bytes': target.stat().st_size, 'sha256': file_hexdigest(target), 'source': source}

if __name__ == '__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(download, SPECS))
    (ROOT / 'models' / 'manifest.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps(results, indent=2))
