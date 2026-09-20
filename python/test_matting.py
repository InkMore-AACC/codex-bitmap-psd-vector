"""CPU tests for pixel/alpha handling without model downloads or inference."""
import tempfile
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
from matting import options_for, adjust_alpha, decontaminate
from worker import segment

class MattingTests(unittest.TestCase):
    def test_soft_alpha_unchanged_by_defaults(self):
        alpha=np.array([[0,.001,.1,.3,.8,1]],dtype=np.float32)
        for model in ['coarse','birefnet','lucida']:
            np.testing.assert_array_equal(adjust_alpha(alpha,options_for(model)),alpha)
        with self.assertRaises(ValueError): options_for('lucida',{'blackPoint':.8,'whitePoint':.2})
        with self.assertRaises(ValueError): options_for('birefnet',{'resolution':1234})

    def test_parameter_directions(self):
        alpha=np.zeros((20,20),np.float32);alpha[8:12,8:12]=1
        for offset,larger in [(2,True),(-1,False)]:
            result=adjust_alpha(alpha,options_for('lucida',{'offset':offset}))
            self.assertEqual(result.sum()>alpha.sum(),larger)
        soft=adjust_alpha(alpha,options_for('lucida',{'feather':1}))
        self.assertTrue(np.any((soft>0)&(soft<1)))
        a=np.array([[.1,.5,.9]],np.float32)
        self.assertLess(adjust_alpha(a,options_for('lucida',{'blackPoint':.2}))[0,1],.5)
        self.assertGreater(adjust_alpha(a,options_for('lucida',{'whitePoint':.8}))[0,1],.5)

    def test_fine_model_reads_original_rgb_without_coarse_mask_and_keeps_existing_alpha(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);img=np.zeros((16,20,4),np.uint8);img[:,:,:3]=[20,80,200];img[:,:,3]=128
            Image.fromarray(img).save(root/'input.png')
            (root/'boxes.json').write_text(json.dumps([{'name':'bg','kind':'background','box':[0,0,20,16]},{'box':[4,4,8,8]}]))
            def predict(crop,model,opts):
                self.assertEqual(model,'lucida');self.assertEqual(crop.size,(12,12));np.testing.assert_array_equal(np.asarray(crop)[:,:,:3],img[2:14,2:14,:3]);return np.full((12,12),.5,np.float32),{'device':'cpu'}
            with patch('worker.fine_mask',side_effect=predict),patch('worker.model_mask',side_effect=AssertionError('No coarse mask before fine matting')):
                result=segment(root/'input.png',root/'out',root/'boxes.json',model='lucida',options={'padding':2})
            layer=result['layers'][1];self.assertEqual((layer['x'],layer['y']),(2,2))
            rgba=np.asarray(Image.open(layer['path']));self.assertTrue(np.all(rgba[:,:,3]==64));np.testing.assert_array_equal(rgba[:,:,:3],img[2:14,2:14,:3])
            self.assertTrue(result['layers'][0]['preview']);self.assertTrue(result['warnings'])

    def test_decontamination_keeps_opaque_rgb(self):
        rgb=np.full((20,20,3),[100,130,200],np.uint8)
        np.testing.assert_array_equal(decontaminate(rgb,np.ones((20,20),np.float32)),rgb)

if __name__=='__main__':unittest.main()
