"""Boundary, upstream-configuration and real output checks for vector updates."""
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET
from vector_options import validate_options

ROOT=Path(__file__).resolve().parents[1]
class VectorOptionsTests(unittest.TestCase):
    def test_invalid_parameters_fail_before_model_execution(self):
        for engine,options in [('supersvg',{'optimizeIter':1}),('supersvg',{'seed':-1}),('supersvg',{'pathNum':3.2}),('adavec',{'shapeIterations':0}),('adavec',{'compactness':float('nan')}),('adavec',{'unknown':1})]:
            with self.subTest(engine=engine,options=options),self.assertRaises(ValueError):validate_options(engine,options)

    def test_adavec_upstream_parameters_are_replaced(self):
        try:import pydiffvg
        except ImportError:self.skipTest('AdaVec native runtime required')
        from adavec_adapter import load_upstream
        options=validate_options('adavec',{'segments':123,'compactness':3.5,'colorMergeDistance':6,'filterSpeckle':7,'cornerThreshold':42,'lengthThreshold':5,'spliceThreshold':32,'pathPrecision':2})
        env=load_upstream(options,'cpu')
        self.assertIn(123,env['get_clus_seg'].__code__.co_consts)
        self.assertIn(3.5,env['get_clus_seg'].__code__.co_consts)
        self.assertIn('cpu',env['get_sam_seg'].__code__.co_consts)
        for value in (7,42,5,32,2):self.assertIn(value,env['get_shapes'].__code__.co_consts)
        import torch
        from types import SimpleNamespace
        gradient=SimpleNamespace(offsets=torch.tensor([1.,0.],requires_grad=True),radius=torch.tensor([-1.,0.],requires_grad=True))
        with torch.no_grad():env['_stabilize_gradient'](gradient)
        self.assertGreater(float(gradient.offsets[1]-gradient.offsets[0]),0)
        self.assertTrue((gradient.offsets<=1).all());self.assertTrue((gradient.radius>0).all())

    def test_diffvg_native_backward_has_finite_nonzero_gradients(self):
        try:import pydiffvg
        except ImportError:self.skipTest('AdaVec native runtime required')
        import torch
        pydiffvg.set_use_gpu(False)
        radius=torch.tensor(6.,requires_grad=True)
        shape=pydiffvg.Circle(radius=radius,center=torch.tensor([12.,12.]),stroke_width=torch.tensor(0.))
        group=pydiffvg.ShapeGroup(shape_ids=torch.tensor([0]),fill_color=torch.tensor([1.,0.,0.,1.]))
        args=pydiffvg.RenderFunction.serialize_scene(24,24,[shape],[group])
        result=pydiffvg.RenderFunction.apply(24,24,2,2,0,None,*args)
        result[:,:,3].sum().backward()
        self.assertTrue(torch.isfinite(radius.grad));self.assertGreater(abs(float(radius.grad)),0.1)

    def test_adavec_real_cluster_paths_and_gradient_stage(self):
        try:import pydiffvg
        except ImportError:self.skipTest('AdaVec native runtime required')
        import torch
        pydiffvg.set_use_gpu(False)
        from PIL import Image,ImageDraw
        from adavec_adapter import load_upstream
        out=ROOT/'test-output/vector-update/adavec-stage';out.mkdir(parents=True,exist_ok=True)
        for name in ('temp','together_opt'):(out/name).mkdir(exist_ok=True)
        im=Image.new('RGB',(64,64),'white');draw=ImageDraw.Draw(im);draw.ellipse((12,12,52,52),fill='red');im.save(out/'input.png')
        env=load_upstream(validate_options('adavec',{'segments':32,'shapeIterations':1}),'cpu')
        clusters=env['get_clus_seg'](str(out/'input.png'),str(out))
        merged=env['merge']([],clusters,str(out))
        w,h,shapes,groups=env['get_shapes'](merged,str(out))
        shapes,groups=env['shapes_simple'](shapes,groups);env['w']=w;env['h']=h
        env['optimize_shapes'](str(out/'input.png'),shapes,groups,1,w,h,torch.device('cpu'),str(out))
        self.assertGreater(len(shapes),1)
        for shape in shapes:self.assertTrue(torch.isfinite(shape.points).all())

    def test_actual_super_svg_output_is_vector_and_preserves_alpha(self):
        path=ROOT/'test-output/vector-update/supersvg.svg'
        if not path.exists():self.skipTest('Run real SuperSVG integration first')
        tree=ET.parse(path);tags=[n.tag.split('}')[-1] for n in tree.iter()]
        self.assertNotIn('image',tags);self.assertNotIn('foreignObject',tags);self.assertIn('mask',tags)
        import skia
        surface=skia.Surface(512,512);surface.getCanvas().clear(skia.ColorTRANSPARENT)
        stream=skia.MemoryStream(path.read_bytes())
        dom=skia.SVGDOM.MakeFromStream(stream);self.assertIsNotNone(dom);dom.render(surface.getCanvas())
        rgba=surface.makeImageSnapshot().toarray(colorType=skia.ColorType.kRGBA_8888_ColorType,alphaType=skia.AlphaType.kUnpremul_AlphaType)
        self.assertEqual(int(rgba[0,0,3]),0)
        self.assertGreater(int((rgba[:,:,3]>240).sum()),10000)

if __name__=='__main__':unittest.main()
