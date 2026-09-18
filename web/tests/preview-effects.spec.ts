import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import sharp from 'sharp';

test('native text effect preview is rendered at full image extent', async ({page,request}) => {
  const taskId=process.env.LAYER_CANVAS_EFFECTS_TASK;
  test.skip(!taskId,'Set LAYER_CANVAS_EFFECTS_TASK to the real native PSD effects sample.');
  const service=JSON.parse(fs.readFileSync('data/service.json','utf8'));
  const response=await request.get(`/api/document?taskId=${encodeURIComponent(taskId!)}`,{headers:{'X-Canvas-Token':service.token}});
  const doc=await response.json();const image=doc.images.find((i:any)=>i.name==='可编辑文字与原生字效.psd');
  expect(image).toBeTruthy();const layer=image.layers.find((l:any)=>l.kind==='text');expect(layer.previewUrl).toBeTruthy();
  const mutations:string[]=[];page.on('request',r=>{if(r.url().includes('/api/')&&['POST','PUT','DELETE','PATCH'].includes(r.method()))mutations.push(r.url());});
  await page.goto(`/?taskId=${encodeURIComponent(taskId!)}#token=${service.token}`);
  await page.getByLabel('当前图片').selectOption(image.id);await page.locator('.image-board.selected').dblclick();
  const picture=page.locator('.image-board.selected').getByAltText(layer.name,{exact:true});
  await expect(picture).toHaveAttribute('src',layer.previewUrl);
  await expect(picture).toHaveCSS('left','0px');await expect(picture).toHaveCSS('top','0px');
  await expect(picture).toHaveCSS('width',`${image.width}px`);await expect(picture).toHaveCSS('height',`${image.height}px`);
  await expect.poll(()=>picture.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0)).toBe(true);
  const withEffects=await page.locator('.image-board.selected').screenshot({path:'test-output/native-preview-with-effects.png'});
  // Temporary DOM-only reference rendering checks actual displayed pixels; no document/API writes.
  const before=await picture.evaluate((el:HTMLImageElement)=>({src:el.getAttribute('src')!,style:el.getAttribute('style')!}));
  await picture.evaluate((el:HTMLImageElement,l:any)=>{el.src=l.url;el.style.left=`${l.x}px`;el.style.top=`${l.y}px`;el.style.width=`${l.width}px`;el.style.height=`${l.height}px`;},layer);
  await expect.poll(()=>picture.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0)).toBe(true);
  const withoutEffects=await page.locator('.image-board.selected').screenshot({path:'test-output/native-preview-raw-reference.png'});
  await picture.evaluate((el:HTMLImageElement,state)=>{el.setAttribute('src',state.src);el.setAttribute('style',state.style);},before);
  await expect.poll(()=>picture.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0)).toBe(true);
  const a=await sharp(withEffects).removeAlpha().raw().toBuffer();const b=await sharp(withoutEffects).removeAlpha().raw().toBuffer();expect(a.length).toBe(b.length);
  let changed=0;for(let i=0;i<a.length;i+=3)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>12)changed++;
  expect(changed).toBeGreaterThan(100);
  await page.locator('.layer-row').filter({hasText:layer.name}).click();
  await page.screenshot({path:'test-output/canvas-current-task.png'});
  expect(mutations).toEqual([]);
  fs.writeFileSync('test-output/native-preview-pixel-check.json',JSON.stringify({taskId,imageId:image.id,layerId:layer.id,previewUrl:layer.previewUrl,changedPixels:changed,mutatingRequests:mutations.length},null,2));
});
