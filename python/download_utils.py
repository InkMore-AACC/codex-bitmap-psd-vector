"""Bounded-memory checksums compatible with Python 3.10 and newer."""
import hashlib
from pathlib import Path


def file_hexdigest(file, algorithm='sha256'):
    digest = hashlib.new(algorithm)
    with Path(file).open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
