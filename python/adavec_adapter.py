"""AdaVec official algorithm adapter, isolated native DiffVG runtime.

Never falls back to another vectorizer. Parameterizes the pinned upstream
functions, removes an unused import of an unshipped module, and preserves input
alpha as a vector-only mask. DiffVG gradients are required for a real result.
"""
from pathlib import Path
import argparse
import ast
import contextlib
import importlib.util
import json
import os
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from vector_options import validate_options

ROOT=Path(__file__).resolve().parents[1]
UPSTREAM=ROOT/'vendor/AdaVec'
REVISION='d4c03c3480d9ab595f729e59a33b596bef9bec3f'
RUNTIME=ROOT/'.runtime/adavec/Scripts/python.exe'
CHECKPOINT=ROOT/'models/sam_vit_h_4b8939.pth'
REQUIRED=('torch','torchvision','cv2','skimage','sklearn','segment_anything','pydiffvg','vtracer','skfmm','matplotlib')

def local_status():
    missing=[]
    for name in REQUIRED:
        try:
            if importlib.util.find_spec(name) is None: missing.append(name)
        except (ImportError,ValueError): missing.append(name)
    errors=[]
    if not missing:
        try:
            import pydiffvg
            import diffvg
            if not hasattr(diffvg,'FilterType'): errors.append('DiffVG native binary is not loadable')
        except Exception as exc: errors.append(f'DiffVG import: {exc}')
    if not CHECKPOINT.is_file(): errors.append('Missing SAM ViT-H checkpoint')
    if not (UPSTREAM/'main.py').is_file(): errors.append('Missing pinned AdaVec source')
    if missing: errors.append('Missing dependencies: '+', '.join(missing))
    return {'available':not errors,'errors':errors,'missing':missing,'runtime':str(RUNTIME),'checkpoint':str(CHECKPOINT),'revision':REVISION}

def probe_runtime():
    if not RUNTIME.is_file(): return {'available':False,'errors':['AdaVec isolated runtime not installed; run scripts/setup-adavec.ps1'],'runtime':str(RUNTIME)}
    try:
        proc=subprocess.run([str(RUNTIME),str(Path(__file__).resolve()),'--status'],capture_output=True,text=True,encoding='utf-8',timeout=35)
        result=json.loads(proc.stdout.strip().splitlines()[-1])
        return result
    except Exception as exc: return {'available':False,'errors':[str(exc)],'runtime':str(RUNTIME)}

def dispatch(input_path,output_path,options=None):
    options=validate_options('adavec',options)
    state=probe_runtime()
    if not state['available']: raise RuntimeError('AdaVec unavailable: '+'; '.join(state['errors']))
    proc=subprocess.run([str(RUNTIME),str(Path(__file__).resolve()),'--input',str(Path(input_path).resolve()),'--output',str(Path(output_path).resolve()),'--options-json',json.dumps(options)],capture_output=True,text=True,encoding='utf-8',errors='replace')
    if proc.stderr: print(proc.stderr,file=sys.stderr)
    if not proc.stdout.strip(): raise RuntimeError(f'AdaVec worker exited {proc.returncode} without a result')
    result=json.loads(proc.stdout.strip().splitlines()[-1])
    if proc.returncode or result.get('error'): raise RuntimeError(result.get('error',f'AdaVec exited {proc.returncode}'))
    return result

def load_upstream(options,device):
    """Keep the official functions; change only documented configuration sites."""
    sys.path.insert(0,str(UPSTREAM))
    tree=ast.parse((UPSTREAM/'main.py').read_text(encoding='utf-8'))
    # Upstream optimize_points imports path_simple, absent from the release and
    # used only by its __main__ demo. Load its actual functions without the demo.
    point_tree=ast.parse((UPSTREAM/'optimize_points.py').read_text(encoding='utf-8'))
    point_tree.body=[n for n in point_tree.body if isinstance(n,(ast.FunctionDef,ast.Import))]
    points_env={};exec(compile(point_tree,str(UPSTREAM/'optimize_points.py'),'exec'),points_env)
    tree.body=[n for n in tree.body if not (isinstance(n,ast.If) and ast.unparse(n.test).startswith('__name__')) and not (isinstance(n,ast.ImportFrom) and n.module=='optimize_points')]
    class Configure(ast.NodeTransformer):
        def visit_Expr(self,node):
            self.generic_visit(node)
            if isinstance(node.value,ast.Call) and ast.unparse(node.value.func)=='group.fill_color.offsets.clamp_':
                # Original independent [0,1] clamps allow equal/crossed stops,
                # which aborts DiffVG's native process at offset_next > current.
                return [node,ast.Expr(value=ast.Call(func=ast.Name(id='_stabilize_gradient',ctx=ast.Load()),args=[ast.Attribute(value=ast.Name(id='group',ctx=ast.Load()),attr='fill_color',ctx=ast.Load())],keywords=[]))]
            return node
        def visit_Assign(self,node):
            self.generic_visit(node)
            if len(node.targets)==1 and isinstance(node.targets[0],ast.Name):
                key={'n_segments':'segments','compactness':'compactness'}.get(node.targets[0].id)
                if key: node.value=ast.Constant(options[key])
                if node.targets[0].id=='device' and isinstance(node.value,ast.Constant) and node.value.value=='cuda': node.value=ast.Constant(device)
            return node
        def visit_Call(self,node):
            self.generic_visit(node)
            func=ast.unparse(node.func)
            names={'eps':'colorMergeDistance'} if func=='DBSCAN' else ({'filter_speckle':'filterSpeckle','corner_threshold':'cornerThreshold','length_threshold':'lengthThreshold','splice_threshold':'spliceThreshold','path_precision':'pathPrecision'} if func=='vtracer.convert_image_to_svg_py' else {})
            for kw in node.keywords:
                if kw.arg in names: kw.value=ast.Constant(options[names[kw.arg]])
            return node
    tree=ast.fix_missing_locations(Configure().visit(tree))
    def stabilize_gradient(gradient):
        import torch
        offsets=gradient.offsets
        if not torch.isfinite(offsets).all():raise RuntimeError('AdaVec produced invalid gradient stops')
        gap=1e-4
        for i in range(len(offsets)):
            minimum=0 if i==0 else float(offsets[i-1])+gap
            offsets[i].clamp_(minimum,1-(len(offsets)-i-1)*gap)
        if hasattr(gradient,'radius'):gradient.radius.clamp_(min=1e-4)
    env={'__name__':'adavec_upstream','optimize_points':points_env['optimize_points'],'_stabilize_gradient':stabilize_gradient}
    exec(compile(tree,str(UPSTREAM/'main.py'),'exec'),env)
    # OpenCV's Windows imread/imwrite reject non-ASCII project paths.
    # Keep all numerical operations and BGR conventions, replace only file IO.
    from types import SimpleNamespace
    import cv2
    import numpy as np
    def imread(path,flags=cv2.IMREAD_COLOR):
        return cv2.imdecode(np.fromfile(path,dtype=np.uint8),flags)
    def imwrite(path,image):
        ok,data=cv2.imencode(Path(path).suffix,image)
        if ok:data.tofile(path)
        return ok
    env['cv2']=SimpleNamespace(**{**vars(cv2),'imread':imread,'imwrite':imwrite})
    return env

def vectorize(input_path,output_path,options=None):
    options=validate_options('adavec',options)
    state=local_status()
    if not state['available']: raise RuntimeError('; '.join(state['errors']))
    import numpy as np
    import torch
    import pydiffvg
    from PIL import Image,ImageOps
    from supersvg_adapter import alpha_mask
    import random
    started=time.monotonic();device=options['device']
    if device=='auto': device='cuda' if torch.cuda.is_available() else 'cpu'
    if device=='cuda' and not torch.cuda.is_available(): raise RuntimeError('CUDA requested but unavailable')
    torch.manual_seed(options['seed']);np.random.seed(options['seed']);random.seed(options['seed'])
    torch.set_num_threads(min(8,os.cpu_count() or 4))
    # A CPU native DiffVG build can still use CUDA for SAM and PyTorch losses.
    pydiffvg.set_use_gpu(False)
    original=ImageOps.exif_transpose(Image.open(input_path)).convert('RGBA')
    target=Path(output_path).resolve();target.parent.mkdir(parents=True,exist_ok=True)
    work=target.parent/(target.stem+'-adavec-work');work.mkdir(exist_ok=True)
    rgb=Image.new('RGBA',original.size,'white');rgb.alpha_composite(original)
    rgb_path=work/'input-rgb.png';rgb.convert('RGB').save(rgb_path)
    env=load_upstream(options,device)
    timings={}
    def stage(name,fn):
        start=time.monotonic();value=fn();timings[name]=round(time.monotonic()-start,3);return value
    sam=stage('sam',lambda:env['get_sam_seg'](str(rgb_path),str(CHECKPOINT),str(work)))
    # Upstream returns a pair of empty lists when SAM finds nothing.
    if isinstance(sam,tuple): sam=[]
    clus=stage('clustering',lambda:env['get_clus_seg'](str(rgb_path),str(work)))
    merged=stage('merge',lambda:env['merge'](sam,clus,str(work)))
    for name in ('temp','shape_opted','together_opt'): (work/name).mkdir(exist_ok=True)
    w,h,shapes,groups=stage('paths',lambda:env['get_shapes'](merged,str(work)))
    if not shapes: raise RuntimeError('AdaVec produced no paths')
    simple_shapes,simple_groups=env['shapes_simple'](shapes,groups)
    env['w']=w;env['h']=h
    def fit_paths():
        for index,shape in enumerate(simple_shapes):
            shape.points=env['optimize_points'](torch.device('cpu'),w,h,shape,shapes[index],num_iter=options['pathIterations']).detach()
    stage('pathOptimization',fit_paths)
    stage('jointOptimization',lambda:env['optimize_shapes'](str(rgb_path),simple_shapes,simple_groups,options['shapeIterations'],w,h,torch.device('cpu'),str(work)))
    for shape in simple_shapes:
        if not torch.isfinite(shape.points).all():raise RuntimeError('AdaVec optimization produced non-finite path coordinates')
    raw=work/'result.svg';pydiffvg.save_svg(str(raw),w,h,simple_shapes,simple_groups)
    root=ET.parse(raw).getroot();ns='{http://www.w3.org/2000/svg}'
    if any(n.tag.split('}')[-1] in ('image','foreignObject') for n in root.iter()): raise RuntimeError('AdaVec output contains embedded raster content')
    alpha=np.asarray(original.getchannel('A'));warnings=['SAM 使用所选设备；DiffVG 路径与颜色优化使用本机 CPU。大图及较多优化轮数可能耗时较长。']
    if alpha.min()<255:
        # Keep the original alpha after optimization, as editable vector paths.
        mask_defs=ET.fromstring(alpha_mask(alpha,w,h))
        for element in mask_defs.iter(): element.tag=ns+element.tag
        root.insert(0,mask_defs)
        group=ET.Element(ns+'g',{'mask':'url(#source-alpha)'})
        for child in list(root):
            if child.tag.split('}')[-1] not in ('defs','metadata','title','desc'):
                root.remove(child);group.append(child)
        root.append(group);warnings.append('透明度保存为32级纯矢量蒙版，未嵌入位图。')
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    ET.ElementTree(root).write(target,encoding='utf-8',xml_declaration=True)
    return {'path':str(target),'method':'adavec','device':device,'renderer':'diffvg-cpu','parameters':options,'paths':len(simple_shapes),'seconds':round(time.monotonic()-started,3),'stages':timings,'warnings':warnings,'upstreamRevision':REVISION}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--status',action='store_true');parser.add_argument('--input');parser.add_argument('--output');parser.add_argument('--options-json',default='{}');args=parser.parse_args()
    try:
        with contextlib.redirect_stdout(sys.stderr): result=local_status() if args.status else vectorize(args.input,args.output,json.loads(args.options_json))
        print(json.dumps(result,ensure_ascii=False));return 0
    except Exception as exc:
        import traceback;traceback.print_exc(file=sys.stderr)
        print(json.dumps({'error':str(exc),'type':type(exc).__name__},ensure_ascii=False));return 1

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8');raise SystemExit(main())
