"""Worker contract tests with generated fixtures; no downloads or paid calls."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
from worker import segment

class ModelContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input = self.root / 'input.png'
        Image.new('RGBA', (24, 16), (20, 80, 200, 255)).save(self.input)

    def boxes(self, values):
        path = self.root / 'boxes.json'
        path.write_text(json.dumps(values), encoding='utf-8')
        return path

    def test_invalid_box_rejected_before_inference(self):
        with self.assertRaises(ValueError), patch('worker.model_mask', side_effect=AssertionError):
            segment(self.input, self.root / 'out', self.boxes([{'box': [30, 0, 4, 4]}]))

    def test_coarse_preview_keeps_coordinates_and_soft_edges(self):
        alpha = np.tile(np.arange(8, dtype=np.uint8) * 32, (8, 1))
        with patch('worker.model_mask', return_value=Image.fromarray(alpha)) as predict:
            result = segment(self.input, self.root / 'out', self.boxes([{'box': [4, 3, 8, 8]}]))
        predict.assert_called_once()
        layer = result['layers'][0]
        self.assertEqual((layer['x'], layer['y'], layer['width'], layer['height']), (4, 3, 8, 8))
        actual = np.asarray(Image.open(layer['path']))
        np.testing.assert_array_equal(actual[:, :, 3], alpha)
        self.assertTrue(np.all(actual[:, :, :3] == [20, 80, 200]))
        self.assertTrue(layer['preview'])

    def test_background_is_inverse_union_and_always_a_preview(self):
        boxes = self.boxes([{'kind': 'background', 'box': [0, 0, 24, 16]}, {'box': [0, 0, 24, 16]}])
        with patch('worker.model_mask', return_value=Image.new('L', (24, 16), 128)):
            result = segment(self.input, self.root / 'out', boxes)
        background, foreground = [np.asarray(Image.open(l['path']))[:, :, 3].astype(int) for l in result['layers']]
        self.assertLessEqual(int(np.abs(background + foreground - 255).max()), 1)
        self.assertTrue(all(l['preview'] for l in result['layers']))
        self.assertTrue(result['warnings'])

    def test_removed_model_is_rejected(self):
        with self.assertRaises(ValueError):
            segment(self.input, self.root / 'out', model='isnet')

if __name__ == '__main__':
    unittest.main()
