"""Validated public options shared by vector workers. No silent ignored options."""
import math

SPECS = {
    'supersvg': {
        'pathNum': (1000,64,4096,int), 'refinePathsPerSegment': (8,1,64,int),
        'refineBatchSize': (16,1,64,int), 'seed': (0,0,4294967295,int),
        'optimizeIter': (0,0,0,int),
    },
    'adavec': {
        'segments': (1000,32,4096,int), 'compactness': (10,0.1,100,float),
        'colorMergeDistance': (10,0.1,100,float), 'filterSpeckle': (4,0,128,int),
        'cornerThreshold': (60,0,180,int), 'lengthThreshold': (4,3.5,10,float),
        'spliceThreshold': (45,0,180,int), 'pathPrecision': (3,0,8,int),
        'pathIterations': (200,0,2000,int), 'shapeIterations': (100,1,1000,int),
        'seed': (0,0,4294967295,int),
    },
}

def validate_options(engine, options=None):
    spec=SPECS[engine]; options=options or {}
    if not isinstance(options,dict): raise ValueError('Vector options must be an object')
    unknown=set(options)-set(spec)-{'device'}
    if unknown: raise ValueError(f'Unknown {engine} options: {sorted(unknown)}')
    result={}
    for key,(default,minimum,maximum,kind) in spec.items():
        value=options.get(key,default)
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not minimum<=value<=maximum or (kind is int and int(value)!=value):
            raise ValueError(f'{engine}.{key} must be {kind.__name__} in [{minimum}, {maximum}]')
        result[key]=kind(value)
    result['device']=options.get('device','auto')
    if result['device'] not in ('auto','cpu','cuda'): raise ValueError('device must be auto, cpu or cuda')
    return result
