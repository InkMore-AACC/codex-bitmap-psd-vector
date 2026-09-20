"""Checksum and mirror fallback tests without network or installed models."""
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from download_utils import file_hexdigest
from download_models import download
from download_matting import verified


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.content = b'checked-model' * 200000
        self.sha = hashlib.sha256(self.content).hexdigest()
        self.md5 = hashlib.md5(self.content).hexdigest()
        blocker = patch('hashlib.file_digest', side_effect=AssertionError('Unavailable on Python 3.10'), create=True)
        blocker.start()
        self.addCleanup(blocker.stop)

    def test_streamed_digest_and_fine_model_verification(self):
        target = self.root / 'weights'
        target.write_bytes(self.content)
        self.assertEqual(file_hexdigest(target), self.sha)
        self.assertEqual(file_hexdigest(target, 'md5'), self.md5)
        self.assertTrue(verified(target, {'sha256': self.sha}))
        self.assertFalse(verified(target, {'sha256': 'bad'}))
        code = b'# model code'
        target.write_bytes(code)
        git_sha = hashlib.sha1(b'blob ' + str(len(code)).encode() + b'\0' + code).hexdigest()
        self.assertTrue(verified(target, {'gitSha1': git_sha}))
        self.assertFalse(verified(self.root / 'missing', {'sha256': self.sha}))

    def test_existing_verified_weight_does_not_download(self):
        (self.root / 'models').mkdir()
        (self.root / 'models/u2netp.onnx').write_bytes(self.content)
        with patch('download_models.ROOT', self.root), patch('urllib.request.urlopen', side_effect=AssertionError('No network')):
            result = download(('u2netp.onnx', None, self.md5))
        self.assertEqual(result['sha256'], self.sha)

    def test_bad_mirror_is_rejected_before_official_fallback(self):
        with patch('download_models.ROOT', self.root), patch('urllib.request.urlopen', side_effect=[io.BytesIO(b'corrupt'), io.BytesIO(self.content)]) as request:
            result = download(('u2netp.onnx', None, self.md5))
        self.assertEqual(request.call_count, 2)
        self.assertIn('hf-mirror.com', request.call_args_list[0].args[0].full_url)
        self.assertIn('github.com', result['source'])
        self.assertEqual(result['sha256'], self.sha)
        self.assertEqual((self.root / 'models/u2netp.onnx').read_bytes(), self.content)


if __name__ == '__main__':
    unittest.main()
