import {z} from 'zod';
import type {LayerFrame} from './layer-frame.js';
import {opticalPartError} from './optical-parts.js';
export const filmCutoutsSchema=z.array(z.object({name:z.string().trim().min(1).max(100),center:z.tuple([z.number().finite(),z.number().finite()]),radiusX:z.number().finite().gt(1),radiusY:z.number().finite().gt(1),angle:z.number().finite().min(-180).max(180)}).strict()).min(1).max(8);
export type FilmCutout=z.infer<typeof filmCutoutsSchema>[number];
type Quad=[number,number][];
const cross=(a:number[],b:number[],p:number[])=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
/** Analytic ellipse containment. Polygon mode is explicit; existing quad recipes stay strict. */
export function validateFilmCutouts(cuts:FilmCutout[]|undefined,frame:LayerFrame,outer:Quad,boundaryMode:'quad'|'clipped-polygon'='quad'){
  if(!cuts)return;filmCutoutsSchema.parse(cuts);
  const n=outer.length,polygon=boundaryMode==='clipped-polygon';
  if((polygon ? n<5||n>8 : n!==4) || new Set(cuts.map(c=>c.name)).size!==cuts.length)throw opticalPartError(polygon?'薄膜圆窗须唯一命名且外轮廓为五至八点凸多边形':'薄膜圆窗须唯一命名且外轮廓为简单四边形');
  const signs=outer.map((a,i)=>cross(a,outer[(i+1)%n],outer[(i+2)%n]));
  if(signs.some(v=>Math.abs(v)<.01)||!signs.every(v=>Math.sign(v)===Math.sign(signs[0])) ||
      outer.some((a,i)=>outer.some((p,k)=>k!==i&&k!==(i+1)%n&&Math.sign(signs[0])*cross(a,outer[(i+1)%n],p)<=.01)))throw opticalPartError(polygon?'圆窗外膜须为无自交凸多边形':'圆窗外膜须为无自交凸四边形');
  const direction=Math.sign(signs[0]),boxes:number[][]=[];
  for(const c of cuts){
    const t=c.angle*Math.PI/180,ct=Math.cos(t),st=Math.sin(t),[x,y]=c.center;
    const rx=Math.hypot(c.radiusX*ct,c.radiusY*st),ry=Math.hypot(c.radiusX*st,c.radiusY*ct),box=[x-rx,y-ry,x+rx,y+ry];
    if(box[0]<frame.x||box[1]<frame.y||box[2]>frame.x+frame.width||box[3]>frame.y+frame.height)throw opticalPartError('薄膜圆窗须完整位于冻结画幅内');
    for(let i=0;i<n;i++){
      const a=outer[i],b=outer[(i+1)%n],nx=-(b[1]-a[1]),ny=b[0]-a[0];
      const support=Math.hypot(c.radiusX*(nx*ct+ny*st),c.radiusY*(-nx*st+ny*ct));
      if(direction*cross(a,b,c.center)<=support+.01)throw opticalPartError(polygon?'薄膜圆窗须严格内含于膜多边形，不能切到外沿':'薄膜圆窗须严格内含于膜四边形，不能切到外沿');
    }
    // Conservative non-overlap avoids holes cancelling each other under even-odd raster fill.
    if(boxes.some(b=>box[0]<b[2]&&box[2]>b[0]&&box[1]<b[3]&&box[3]>b[1]))throw opticalPartError('薄膜圆窗承载框不得相交');
    boxes.push(box);
  }
}
/** Four cubic knots for editable native PS ellipses; constants describe geometry only. */
export function filmCutoutKnots(c:FilmCutout):[number,number,number,number,number,number][] {
  const k=.5522847498307936,t=c.angle*Math.PI/180,ct=Math.cos(t),st=Math.sin(t);
  const point=(x:number,y:number):[number,number]=>[c.center[0]+x*ct-y*st,c.center[1]+x*st+y*ct];
  return [[c.radiusX,-k*c.radiusY,c.radiusX,0,c.radiusX,k*c.radiusY],[k*c.radiusX,c.radiusY,0,c.radiusY,-k*c.radiusX,c.radiusY],[-c.radiusX,k*c.radiusY,-c.radiusX,0,-c.radiusX,-k*c.radiusY],[-k*c.radiusX,-c.radiusY,0,-c.radiusY,k*c.radiusX,-c.radiusY]].map(v=>[...point(v[0],v[1]),...point(v[2],v[3]),...point(v[4],v[5])]);
}
