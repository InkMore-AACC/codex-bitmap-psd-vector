import { z } from 'zod';

export const contourSearchSchema=z.object({version:z.literal(1),
  box:z.tuple([z.number().int().nonnegative(),z.number().int().nonnegative(),z.number().int().positive(),z.number().int().positive()]),
  observation:z.string().trim().min(12).max(2000),
}).strict();
export type ContourSearch=z.infer<typeof contourSearchSchema>;
type Frame={x:number;y:number;width:number;height:number};
/** Measurement scope only, never an output crop/mask or an after-generation target adjustment. */
export function contourSearchViewport(search:ContourSearch,frame:Frame,referenceSize:[number,number]):[number,number,number,number] {
  contourSearchSchema.parse(search);
  const [x,y,w,h]=search.box,[rw,rh]=referenceSize;
  if(![frame.x,frame.y,frame.width,frame.height,rw,rh].every(Number.isFinite)||Math.min(frame.width,frame.height,rw,rh)<=0 ||
    x<frame.x || y<frame.y || x+w>frame.x+frame.width || y+h>frame.y+frame.height)
    throw new Error('事前轮廓搜索范围须完整属于冻结本层画幅，不能改变来源或裁切输出');
  const factor=(rw*frame.width+rh*frame.height)/(frame.width*frame.width+frame.height*frame.height);
  if(Math.abs(rw-frame.width*factor)>1 || Math.abs(rh-frame.height*factor)>1)
    throw new Error('轮廓搜索参考须保持冻结画幅统一比例，不能分别换算横纵坐标');
  return [(x-frame.x)*factor,(y-frame.y)*factor,w*factor,h*factor];
}
