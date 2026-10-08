import {replaceLocalMaterialRgba,type RepairRgba,MATERIAL_REPAIR_PIXEL_BUDGET} from './photoshop-material-repair.js';

/** File-space kernel only. Callers must bind and freeze the clean source,
 * independent keep selection, real generated background and complete canvas.
 * This cannot identify background pixels or certify a Photoshop selection. */
export function protectKnownBackgroundRgba(input:{
  source:RepairRgba;
  generated:RepairRgba;
  keepMask:Uint8Array|Uint8ClampedArray;
}) {
  const {source,generated,keepMask}=input;
  for(const [name,image]of [['Source',source],['Generated background',generated]] as const){
    if(!Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<1||image.height<1||
      image.width*image.height>MATERIAL_REPAIR_PIXEL_BUDGET||image.data.length!==image.width*image.height*4)
      throw new Error(`${name} must be a complete RGBA8 canvas within 1500000 pixels`);
    for(let k=0;k<image.data.length;k+=4)
      if(image.data[k+3]!==255)throw new Error(`${name} must be opaque; transmissive foreground pixels are not clean background`);
  }
  if(source.width!==generated.width||source.height!==generated.height||keepMask.length!==source.width*source.height)
    throw new Error('Background protection requires identical full-file source, generated and keep-mask dimensions');
  let kept=0,filled=0;
  for(const value of keepMask){
    if(value===255)kept++;
    else if(value===0)filled++;
    else throw new Error('Initial background protection requires an independently reviewed binary 0/255 keep mask');
  }
  if(!kept||!filled)throw new Error('Keep mask must contain both confirmed background and generated fill; a complete source cannot be a bottom layer');
  const frame={x:0,y:0,width:source.width,height:source.height};
  const result=replaceLocalMaterialRgba({base:generated,patch:source,mask:keepMask,baseFrame:frame,patchFrame:frame});
  // Assert the promised file-space identity, including channels with value 0.
  // This is deliberately independent of PNG encoding and PS bleed/resampling.
  for(let p=0;p<keepMask.length;p++){
    const expected=keepMask[p]===255?source.data:generated.data;
    for(let c=0;c<4;c++)if(result.image.data[p*4+c]!==expected[p*4+c])
      throw new Error('Background protection changed a selected source/fill channel');
  }
  return {...result,keptPixels:kept,generatedFillPixels:filled,
    guarantee:'file-space-source-or-generated-RGBA8-exact' as const};
}
