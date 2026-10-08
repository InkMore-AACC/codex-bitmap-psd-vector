"""Verified pinned-file download with domestic mirrors first."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid
import requests

ROOT = Path(__file__).resolve().parents[1]


def digest(path, entry):
    h = hashlib.sha256() if entry['algorithm'] == 'sha256' else hashlib.sha1()
    if entry['algorithm'] == 'git-sha1':
        h.update(f"blob {path.stat().st_size}\0".encode())
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def install_file(entry):
    target = (ROOT / entry['path']).resolve()
    if not target.is_relative_to(ROOT):
        raise ValueError(f'Invalid install path: {target} outside {ROOT}')
    if target.is_file() and target.stat().st_size == entry['size'] and digest(target, entry) == entry['hash']:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.part')
    errors = []
    for url in entry['urls']:
        try:
            print('下载 ' + entry['path'] + ' (' + url.split('/')[2] + ')', flush=True)
            with requests.get(url, stream=True, timeout=(15, 90)) as response:
                response.raise_for_status()
                with temporary.open('wb') as stream:
                    count = 0
                    for chunk in response.iter_content(4 * 1024 * 1024):
                        count += len(chunk)
                        if count > entry['size']:
                            raise ValueError('下载大小与固定版本不符')
                        stream.write(chunk)
            if temporary.stat().st_size != entry['size'] or digest(temporary, entry) != entry['hash']:
                raise ValueError('下载摘要与固定版本不符')
            os.replace(temporary, target)
            return
        except Exception as exc:
            errors.append(str(exc))
            temporary.unlink(missing_ok=True)
    raise RuntimeError(entry['path'] + ': ' + '; '.join(errors))
