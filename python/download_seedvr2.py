"""Install only SeedVR2 7B standard INT8 + one VAE, with pinned hashes."""
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import zipfile
import requests
from download_pinned import install_file

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = Path(__file__).with_name('seedvr2-models.json')


def main():
    m = json.loads(MANIFEST.read_text(encoding='utf-8'))
    source = ROOT / '.runtime/seedvr2-comfy'
    marker = source / '.canvas-revision'
    if not marker.exists() or marker.read_text().strip() != m['source']['revision']:
        # No verified mainland mirror of this exact source revision; use upstream.
        print('下载固定版本推理程序（不安装或启动 ComfyUI 界面）', flush=True)
        response = requests.get(m['source']['url'], timeout=(20, 180))
        response.raise_for_status()
        if hashlib.sha256(response.content).hexdigest() != m['source']['sha256']:
            raise ValueError('推理源码校验失败')
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            for entry in archive.infolist():
                rel = Path(*Path(entry.filename).parts[1:])
                if not rel.parts or entry.is_dir():
                    continue
                dest = (source / rel).resolve()
                if not dest.is_relative_to(source.resolve()):
                    raise ValueError('源码压缩包包含无效路径')
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(archive.read(entry))
        marker.write_text(m['source']['revision'], encoding='utf-8')
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(install_file, m['files']))
    record = {'manifestHash': hashlib.sha256(MANIFEST.read_bytes()).hexdigest(),
              'files': {e['path']: (ROOT / e['path']).stat().st_mtime_ns for e in m['files']}}
    dest = ROOT / 'models/seedvr2/verified.json'
    tmp = dest.with_suffix('.tmp')
    tmp.write_text(json.dumps(record), encoding='utf-8')
    os.replace(tmp, dest)
    print('SeedVR2 7B 标准版 INT8 与 VAE 已安装并校验', flush=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
