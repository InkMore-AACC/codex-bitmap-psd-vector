"""Integration checks against actual model files. Run after setup-models.ps1."""
import json
from pathlib import Path
import sys
import unittest
import xml.etree.ElementTree as ET
import numpy as np
from PIL import Image
from worker import segment,status

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/evidence/models'

class ModelIntegration(unittest.TestCase):
    def test_real_rough_and_fine_cutouts(self):
        self.assertTrue(status()['segmentation'])
        for fine in [False,True]:
            result=segment(OUT/'astronaut.png',OUT/('fine' if fine else 'rough'),fine=fine)
            rgba=np.asarray(Image.open(result['layers'][0]['path']))
            self.assertEqual(rgba.shape,(512,512,4))
            self.assertGreater(float((rgba[:,:,3]<10).mean()),0.1)
            self.assertGreater(float((rgba[:,:,3]>240).mean()),0.1)
            original=np.asarray(Image.open(OUT/'astronaut.png'))
            self.assertTrue(np.array_equal(rgba[:,:,:3],original))

    def test_pure_vector_output(self):
        for filename in ['astronaut.svg','transparent.svg']:
            tree=ET.parse(OUT/filename)
            tags=[e.tag.split('}')[-1] for e in tree.iter()]
            self.assertNotIn('image',tags)
            self.assertNotIn('foreignObject',tags)
            self.assertGreater(tags.count('path'),200)
        tags=[e.tag.split('}')[-1] for e in ET.parse(OUT/'transparent.svg').iter()]
        self.assertIn('mask',tags)

    def test_rendered_svg_keeps_transparency(self):
        import skia
        raw=(OUT/'transparent.svg').read_bytes()
        stream=skia.MemoryStream(raw)
        dom=skia.SVGDOM.MakeFromStream(stream)
        self.assertIsNotNone(dom)
        surface=skia.Surface(512,512);surface.getCanvas().clear(skia.ColorTRANSPARENT)
        dom.render(surface.getCanvas())
        rgba=surface.makeImageSnapshot().toarray(colorType=skia.ColorType.kRGBA_8888_ColorType,alphaType=skia.AlphaType.kUnpremul_AlphaType)
        self.assertEqual(int(rgba[0,0,3]),0)
        self.assertGreater(float((rgba[:,:,3]<128).mean()),0.4)
        self.assertGreater(float((rgba[:,:,3]>240).mean()),0.3)

    def test_constant_alpha_mask_does_not_shrink_canvas(self):
        from supersvg_adapter import alpha_mask
        import skia
        mask=alpha_mask(np.full((8,8),128,dtype=np.uint8),8,8)
        raw=('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">'+mask+'<rect width="8" height="8" fill="red" mask="url(#source-alpha)"/></svg>').encode()
        stream=skia.MemoryStream(raw);dom=skia.SVGDOM.MakeFromStream(stream)
        surface=skia.Surface(8,8);surface.getCanvas().clear(skia.ColorTRANSPARENT);dom.render(surface.getCanvas())
        rgba=surface.makeImageSnapshot().toarray()
        self.assertTrue(np.all(rgba[:,:,3]==128))

    def test_invalid_box_rejected(self):
        boxes=OUT/'invalid-box.json';boxes.write_text(json.dumps([{'x':600,'y':0,'width':1,'height':1}]))
        with self.assertRaises(ValueError): segment(OUT/'astronaut.png',OUT/'invalid',boxes)

    def test_box_cutout_coordinates_and_rgb(self):
        boxes=OUT/'box.json';boxes.write_text(json.dumps([{'name':'person','box':[0,15,365,485]}]))
        result=segment(OUT/'astronaut.png',OUT/'box',boxes)
        layer=result['layers'][0]
        self.assertEqual((layer['x'],layer['y'],layer['width'],layer['height']),(0,15,365,485))
        actual=np.asarray(Image.open(layer['path']))
        original=np.asarray(Image.open(OUT/'astronaut.png'))[15:500,:365]
        self.assertTrue(np.array_equal(actual[:,:,:3],original))
        self.assertGreater(float((actual[:,:,3]<128).mean()),0.05)

    def test_background_is_inverse_union_not_duplicate_foreground(self):
        boxes=OUT/'with-background.json'
        boxes.write_text(json.dumps([{'name':'background','box':[0,0,512,512],'kind':'background'}, {'name':'person','box':[0,0,512,512]}]))
        result=segment(OUT/'astronaut.png',OUT/'with-background',boxes)
        background=np.asarray(Image.open(result['layers'][0]['path']))[:,:,3]
        foreground=np.asarray(Image.open(result['layers'][1]['path']))[:,:,3]
        self.assertLessEqual(int(np.abs(background.astype(int)+foreground.astype(int)-255).max()),1)
        self.assertTrue(result['layers'][0]['preview'])
        self.assertTrue(result['warnings'])

if __name__=='__main__': unittest.main()
