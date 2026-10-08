"""No GPU allocation, network, or user canvas changes."""
import unittest
from seedvr2 import validate

DEFAULT = dict(model='seedvr2-7b-int8', scale=2, seedColor='lab', seedDetail=1,
               seedVaeTile=512, seedVaeOverlap=128, seedMemory='normal', seed=42)

class SeedSettingsTests(unittest.TestCase):
    def test_parameter_limits(self):
        validate(DEFAULT)
        for change in [dict(scale=3), dict(seedVaeTile=256), dict(seedDetail=1.1),
                       dict(seedVaeOverlap=0), dict(seed=-1), dict(model='seedvr2-7b-sharp')]:
            with self.assertRaises(ValueError):
                validate(dict(DEFAULT, **change))

if __name__ == '__main__':
    unittest.main()
