import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { connectionPath, imagePoint } from '../web/canvasGeometry';
import { mergeConcurrent, reconcileSaved } from '../web/reconcile';
import type { CanvasDocument } from '../web/types';

test('image-local coordinates remain outside the image; source connections follow endpoints', () => {
  assert.deepEqual(imagePoint({ x: 30, y: 60 }, { left: 10, top: 20 }, { x: 100, y: 100, scale: .5 }, { x: 20, y: 30 }), [-180, -150]);
  const parent = { x: 0, y: 0, width: 200, height: 100 }, child = { x: 300, y: 100, width: 200, height: 100 };
  assert.match(connectionPath(parent, child), /^M 200 50 C/);
  assert.match(connectionPath({ ...parent, x: 600 }, child), /^M 600 50 C/);
});

test('three-way save merges completed nodes and reports genuine conflicts without overwriting', () => {
  const base = { revision: 1, images: [{ id: 'source', x: 0, opinion: 'before', layers: [{ id: 'layer', opinion: '' }] }] };
  const local = structuredClone(base); local.images[0].x = 100;
  const remote = structuredClone(base); remote.revision = 2; remote.images.push({ id: 'result', x: 200, opinion: '', layers: [] }); remote.images[0].layers.push({ id: 'new-layer', opinion: '' });
  const merged = mergeConcurrent(base, local, remote);
  assert.deepEqual(merged.conflicts, []); assert.equal(merged.value.images.length, 2); assert.equal(merged.value.images[0].x, 100); assert.equal(merged.value.images[0].layers.length, 2);
  assert.equal(reconcileSaved(base, local, remote).images.length, 2);
  local.images[0].opinion = 'local'; remote.images[0].opinion = 'remote';
  const conflict = mergeConcurrent(base, local, remote); assert.deepEqual(conflict.conflicts, ['images[source].opinion']); assert.equal(conflict.value.images[0].opinion, 'local');
});

test('canvas interactions preserve local annotations, drag nodes at zoom, and persist settings', { timeout: 90000 }, async () => {
  const output = path.resolve(`test-output/canvas-ui-${process.pid}`);
  await build({ configFile: false, plugins: [react()], logLevel: 'error', build: { outDir: output } });
  const server = createServer((request, response) => {
    const file = path.join(output, new URL(request.url || '/', 'http://localhost').pathname === '/' ? 'index.html' : new URL(request.url || '/', 'http://localhost').pathname);
    try { const bytes = fs.readFileSync(file); response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); response.end(bytes); } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  const browser = await chromium.launch({ channel: 'msedge', headless: true }).catch(async error => { await close(); throw error; });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#563779"/></svg>');
  let saved: CanvasDocument = {
    id: 'ui-fixture', taskId: 'ui-fixture', revision: 1, updatedAt: '',
    images: [{ id: 'source', name: '测试原图', x: 100, y: 100, width: 200, height: 200, source: svg, url: svg, layers: [], annotations: [], opinion: '总图意见', version: 1, status: 'original' },
      { id: 'result', parentId: 'source', sourceJobId: 'done', name: '分层结果', x: 500, y: 100, width: 200, height: 200, source: svg, url: svg, layers: [{ id: 'layer-1', name: '主体', x: 0, y: 0, width: 200, height: 200, url: svg, visible: true, opacity: 1, opinion: '图层意见', disposition: 'keep', kind: 'raster' }], annotations: [], opinion: '结果总图意见', version: 1, status: 'layered' }],
    settings: { psdMode: 2, vectorEngine: 'vectorizerCom', theme: 'dark' }, layout: { layersWidth: 210, opinionsWidth: 300, editorHeight: 260 },
  };
  let puts = 0;
  let completeDuringSave = false;
  let conflictDuringSave = false;
  let uiJobs: any[] = [];
  let vectorClicks = 0;
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if(path.endsWith('/reference'))return route.fulfill({json:{url:svg,complete:true}});
    if(path==='/api/adobe/probe')return route.fulfill({json:{status:'partial',channels:[{name:'MCP',status:'success',message:'工具服务已连接'},{name:'Windows 脚本',status:'failed',message:'请先打开软件'}],technical:'fixture-details-only'}});
    if(path==='/api/adobe')return route.fulfill({json:{photoshop:{mode:'auto',installed:true},illustrator:{mode:'auto',url:'http://localhost:18412/v1/mcp',hasToken:false}}});
    if (path === '/api/settings') return route.fulfill({ json: { recraftConfigured: false, api302Configured: false, models: { segmentation: true, supersvg: true, adavec: false } } });
    if (path.endsWith('/jobs') && req.method() === 'POST') {
      vectorClicks++;
      const body=req.postDataJSON();
      const job={id:'dispatch-ui',taskId:saved.taskId,documentId:saved.id,imageId:body.imageId,type:body.type,status:'waiting_codex',message:'正在自动发送到当前 Codex 对话…',dispatch:{state:'sending',updatedAt:''}};
      uiJobs=[{...job,message:'已发送到当前 Codex 对话，等待处理',dispatch:{state:'sent',updatedAt:''}}];
      return route.fulfill({status:202,json:job});
    }
    if (path.endsWith('/jobs')) return route.fulfill({ json: uiJobs });
    if (path.endsWith('/dispatch')) return route.fulfill({ json: { listenerActive: true, automaticWake: false } });
    if (req.method() === 'PUT') {
      if (completeDuringSave) { completeDuringSave = false; saved.revision++; saved.images.push({ ...structuredClone(saved.images[1]), id: 'late-result', name: '异步完成结果', sourceJobId: 'late', x: 800 }); return route.fulfill({ status: 409, json: { error: 'document revision changed' } }); }
      if (conflictDuringSave) { conflictDuringSave = false; saved.revision++; saved.images[1].opinion = '服务器同时修改'; return route.fulfill({ status: 409, json: { error: 'document revision changed' } }); }
      saved = { ...req.postDataJSON().document, revision: saved.revision + 1 }; puts++; return route.fulfill({ json: saved });
    }
    return route.fulfill({ json: saved });
  });
  const flush = async () => { await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === '已保存'); };
  try {
    await page.goto(`${baseUrl}?taskId=ui-fixture#token=test-only`);
    await page.locator('[data-image-id="source"]').waitFor();
    const source = page.locator('[data-image-id="source"]');
    assert.equal(await page.locator('.annotations').count(),0);
    await page.getByRole('combobox',{name:'当前图片',exact:true}).selectOption('source');
    const first = (await source.boundingBox())!;
    const canvas = (await page.locator('.canvas').boundingBox())!;
    await page.getByRole('button', { name: '箭头 A', exact: true }).click();
    await page.getByLabel('新标注颜色', { exact: true }).fill('#ff6600');
    await page.getByRole('slider', { name: '新标注粗细', exact: true }).fill('7');
    // Start on blank canvas above the selected image, end inside it.
    await page.mouse.move(first.x + 30, first.y - 55);
    await page.mouse.down(); await page.mouse.move(first.x + 60, first.y + 55, { steps: 5 }); await page.mouse.up();
    await page.getByRole('textbox', { name: '标注文字', exact: true }).fill('移动到上一层');
    await flush();
    assert.equal(saved.images[0].annotations.length, 1);
    assert.ok(saved.images[0].annotations[0].points[1] < 0, 'outside endpoint must not be clamped');
    assert.equal(saved.images[0].annotations[0].color, '#ff6600');
    assert.equal(saved.images[0].annotations[0].strokeWidth, 7);
    assert.equal(await source.locator('.annotations line').getAttribute('stroke-width'), '7');
    await page.getByLabel('已选标注颜色', { exact: true }).fill('#00aaff');
    await page.getByRole('slider', { name: '已选标注粗细', exact: true }).fill('4'); await flush();
    await page.getByRole('button',{name:'▣ 总图 原图',exact:true}).click();
    await page.getByRole('button',{name:'选择标注 移动到上一层',exact:true}).click();
    await page.getByRole('textbox',{name:'标注文字',exact:true}).fill('标签编辑意见');await flush();
    assert.equal(saved.images[0].annotations[0].text,'标签编辑意见');
    const tag=page.locator('.annotation-chip').filter({hasText:'标签编辑意见'});await tag.hover();
    assert.equal(await tag.getByRole('button',{name:'删除标注 标签编辑意见',exact:true}).isVisible(),true);
    await tag.getByRole('button',{name:'删除标注 标签编辑意见',exact:true}).click();await flush();assert.equal(saved.images[0].annotations.length,0);
    await page.getByRole('button',{name:'撤销',exact:true}).click();await flush();assert.equal(saved.images[0].annotations.length,1);
    await page.getByRole('button',{name:'选择标注 标签编辑意见',exact:true}).click();await page.getByRole('textbox',{name:'标注文字',exact:true}).fill('移动到上一层');await flush();
    assert.equal(saved.images[0].annotations[0].strokeWidth, 4);
    assert.equal(await source.locator('.annotations line').getAttribute('stroke'), '#00aaff');
    const coordinates = structuredClone(saved.images[0].annotations[0].points);
    const oldPath = await page.locator('.node-connections path[data-child="result"]').getAttribute('d');
    await page.getByRole('button', { name: '选择 V', exact: true }).click();
    completeDuringSave = true;
    // Drag image pixels, not the title.
    await page.mouse.move(first.x + 100, first.y + 100); await page.mouse.down(); await page.mouse.move(first.x + 160, first.y + 130, { steps: 5 }); await page.mouse.up();
    await flush();
    assert.ok(Math.abs(saved.images[0].x - 200) < .01); assert.ok(Math.abs(saved.images[0].y - 150) < .01);
    assert.deepEqual(saved.images[0].annotations[0].points, coordinates);
    assert.ok(saved.images.some(i => i.id === 'late-result'), 'completed output must survive a stale local save');
    assert.notEqual(await page.locator('.node-connections path[data-child="result"]').getAttribute('d'), oldPath);
    const moved = (await source.boundingBox())!;
    await page.getByRole('button', { name: '框选 R', exact: true }).click();
    await page.mouse.move(moved.x + 10, moved.y + 10); await page.mouse.down(); await page.mouse.move(moved.x + 70, moved.y + 60, { steps: 5 }); await page.mouse.up(); await flush();
    assert.equal(saved.images[0].annotations.at(-1)?.type, 'box');
    await page.getByRole('button', { name: '涂抹选择 B', exact: true }).click();
    await page.getByRole('slider', { name: '新标注笔刷大小', exact: true }).fill('42');
    await page.getByRole('slider',{name:'新标注透明度',exact:true}).fill('75');
    await page.mouse.move(moved.x + 15, moved.y + 75); await page.mouse.down(); await page.mouse.move(moved.x + 65, moved.y + 95, { steps: 10 }); await page.mouse.up(); await flush();
    assert.equal(saved.images[0].annotations.at(-1)?.brushSize, 42);
    assert.equal(saved.images[0].annotations.at(-1)?.opacity,.25);
    assert.equal(await source.locator('.annotations polyline').getAttribute('opacity'),'0.25');
    await page.getByRole('slider',{name:'已选标注透明度',exact:true}).fill('60');await flush();
    assert.equal(saved.images[0].annotations.at(-1)?.opacity,.4);
    assert.ok(saved.images[0].annotations.at(-1)!.points.length > 8);
    await page.getByRole('button', { name: '圈选 O', exact: true }).click();
    await page.getByLabel('新标注颜色', { exact: true }).fill('#33cc44');
    await page.getByRole('slider', { name: '新标注粗细', exact: true }).fill('6');
    await page.mouse.move(moved.x + 10, moved.y + 15); await page.mouse.down(); await page.mouse.move(moved.x + 55, moved.y + 50); await page.mouse.up(); await flush();
    assert.equal(await source.locator('.annotations ellipse').getAttribute('stroke-width'), '6');
    await page.getByRole('button', { name: '文字 T', exact: true }).click();
    await page.getByLabel('新标注颜色', { exact: true }).fill('#ff2255');
    await page.getByRole('slider', { name: '新标注字重', exact: true }).fill('800');
    await page.getByRole('spinbutton', { name: '新标注字号', exact: true }).fill('22');
    await page.mouse.click(moved.x + 20, moved.y + 110); await flush();
    assert.equal(saved.images[0].annotations.at(-1)?.fontWeight, 800);
    assert.equal(await source.locator('.annotations text').filter({ hasText: '输入标注' }).getAttribute('font-size'), '22');
    // Space is a temporary hand tool; it must not move the underlying image.
    const xBeforePan = saved.images[0].x;
    await page.keyboard.press('Escape'); await page.keyboard.down('Space');
    await page.mouse.move(moved.x + 90, moved.y + 90); await page.mouse.down(); await page.mouse.move(moved.x + 125, moved.y + 110); await page.mouse.up(); await page.keyboard.up('Space');
    assert.equal(saved.images[0].x, xBeforePan);
    // Text labels drag independently without changing target geometry.
    await page.getByRole('combobox',{name:'当前图片',exact:true}).selectOption('source');
    const arrowText = source.locator('.annotations text').filter({ hasText: '移动到上一层' });
    const label = (await arrowText.boundingBox())!;
    await page.mouse.move(label.x + 15, label.y + 5); await page.mouse.down(); await page.mouse.move(label.x + 50, label.y - 30, { steps: 5 }); await page.mouse.up(); await flush();
    assert.ok(saved.images[0].annotations[0].labelPosition);
    assert.deepEqual(saved.images[0].annotations[0].points, coordinates);
    await page.getByRole('button', { name: 'PSD 分层方案设置', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: /方案 1 ·/ }).count(), 0);
    await page.getByRole('button', { name: /方案 3 ·/ }).click();
    await page.getByRole('button', { name: '矢量化', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: /SuperSVG|AdaVec/ }).count(), 0);
    await page.getByRole('combobox',{name:'Vectorizer.com 网页操作方式'}).selectOption('codex');await flush();assert.equal(saved.settings.vectorizerComMode,'codex');
    await page.getByRole('button', { name: /Vectorizer.AI 官方 API/ }).click();await flush();assert.equal(saved.settings.vectorEngine,'vectorizer');
    await page.getByRole('button', { name: /Vectorizer.AI.*302.AI/ }).click();
    assert.equal(await page.getByRole('link', { name: 'Vectorizer.AI 官网 ↗', exact:true }).getAttribute('href'), 'https://vectorizer.ai/');
    assert.ok(await page.getByText('按张计费 · $0.30/张', {exact:true}).count());
    await page.getByRole('button', {name:'PS / AI',exact:true}).click();
    const ps=page.locator('.adobe-app').first();await ps.getByRole('button',{name:'检查连接',exact:true}).click();await ps.getByText('部分成功',{exact:true}).waitFor();
    assert.equal(await ps.locator('pre').isVisible(),false);assert.ok(await ps.getByText(/MCP：成功/).count());assert.ok(await ps.getByText(/Windows 脚本：失败/).count());
    await ps.getByText('查看详情',{exact:true}).click();assert.equal(await ps.locator('pre').isVisible(),true);
    await page.getByRole('button', { name: '完成', exact: true }).click(); await flush();
    assert.equal(saved.settings.psdMode, 3); assert.equal(saved.settings.vectorEngine, 'vectorizer302');
    // Reload round-trip uses the saved mock document, never the user's active canvas.
    await page.reload(); await source.waitFor();
    assert.equal(await page.locator('.annotations').count(),0);await page.getByRole('combobox',{name:'当前图片',exact:true}).selectOption('source');
    assert.equal(await source.locator('.annotations polyline').getAttribute('opacity'),'0.4');
    assert.equal(await page.locator('.node-connections path[data-child]').count(), 2);
    assert.equal(await page.locator('.node-connections path[data-child]').first().getAttribute('stroke-width'),'9');
    assert.equal(await source.locator('.annotations line').getAttribute('stroke-width'), '4');
    assert.equal(await source.locator('.annotations text').filter({ hasText: '输入标注' }).getAttribute('font-weight'), '800');
    await page.getByRole('combobox', { name: '当前图片', exact: true }).selectOption('result');
    assert.equal(await source.locator('.annotations').count(),0);assert.equal(await page.locator('[data-image-id="result"] .annotations').count(),1);
    await page.locator('.canvas').focus();await page.keyboard.press('Escape');assert.equal(await page.locator('.annotations').count(),0);await page.getByRole('combobox',{name:'当前图片',exact:true}).selectOption('result');
    assert.equal(await page.getByRole('textbox', { name: '总图修改意见', exact: true }).inputValue(), '结果总图意见');
    await page.locator('.layer-title').getByText('主体', { exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '图层修改意见', exact: true }).inputValue(), '图层意见');
    assert.equal(await page.locator('.tool-rail button svg[viewBox="0 0 24 24"]').count(),7);
    const compare=page.getByRole('switch',{name:'显示原图',exact:true});
    await compare.click();assert.equal(await compare.getAttribute('aria-checked'),'true');
    assert.equal(await page.locator('[data-image-id="result"] .original-comparison').count(),1);
    assert.equal(await source.locator('.original-comparison').count(),0);
    assert.equal(await page.locator('.annotations').count(),0);
    assert.equal(await page.getByRole('textbox',{name:'图层修改意见',exact:true}).inputValue(),'图层意见');
    await compare.click();assert.equal(await page.locator('.original-comparison').count(),0);
    assert.ok(puts > 0); assert.deepEqual(errors, []);
    assert.ok(canvas.width > 500);
    await page.getByRole('button',{name:'◇ 矢量化',exact:true}).click();
    const dispatched=page.locator('[data-job-id="dispatch-ui"]');
    await dispatched.getByText('请求已自动送达；对话正在忙时会等待处理。',{exact:true}).waitFor();
    assert.equal(vectorClicks,1);assert.equal(await dispatched.getByText('已发送',{exact:true}).count(),1);
    assert.equal(await page.getByText(/接单未连接|开启画布接单/).count(),0);
    uiJobs=[{...uiJobs[0],message:'发送到 Codex 失败，图片和修改意见已保留',dispatch:{state:'failed',updatedAt:'',detail:'测试连接失败'}}];
    await dispatched.getByText('发送失败',{exact:true}).waitFor();
    assert.equal(await dispatched.getByText('测试连接失败',{exact:true}).isVisible(),false);
    await dispatched.getByText('查看详情',{exact:true}).click();assert.equal(await dispatched.getByText('测试连接失败',{exact:true}).isVisible(),true);
    uiJobs=[{...uiJobs[0],status:'running',message:'等待网页验证',webProgress:{phase:'verification',updatedAt:''}}];
    await dispatched.getByText('等待网页验证',{exact:true}).first().waitFor();
    uiJobs=[{...uiJobs[0],message:'下载被中断，已保留文件',webProgress:{phase:'blocked',updatedAt:''}}];
    await dispatched.getByText('下载受阻',{exact:true}).waitFor();
    saved.images.push({...structuredClone(saved.images[1]),id:'received-vector',parentId:'result',sourceJobId:'dispatch-ui',name:'收到的矢量结果',x:9000,y:-938,status:'vector',vectorUrl:svg});saved.revision++;
    uiJobs=[{...uiJobs[0],status:'completed',message:'SVG 已接收',result:{imageId:'received-vector',artifactUrl:'/received.svg'}}];
    await page.waitForFunction(()=>document.querySelector<HTMLSelectElement>('select[aria-label="当前图片"]')?.value==='received-vector');
    const receivedBounds=await page.locator('[data-image-id="received-vector"]').boundingBox();const canvasBounds=await page.locator('.canvas').boundingBox();
    assert.ok(receivedBounds&&canvasBounds);assert.ok(receivedBounds.x>=canvasBounds.x&&receivedBounds.y>=canvasBounds.y);assert.ok(receivedBounds.x+receivedBounds.width<=canvasBounds.x+canvasBounds.width&&receivedBounds.y+receivedBounds.height<=canvasBounds.y+canvasBounds.height,'finished result must be fully visible');
    await page.locator('.canvas').evaluate(el=>{el.scrollTop=273;el.scrollLeft=150});
    assert.deepEqual(await page.locator('.canvas').evaluate(el=>[el.scrollLeft,el.scrollTop]),[0,0],'browser focus must not scroll the canvas independently of its world transform');
    await page.getByRole('combobox',{name:'当前图片',exact:true}).selectOption('result');
    await page.locator('.jobs-popover .panel-heading button').click();
    await page.getByRole('button',{name:'选择 V',exact:true}).click();
    await page.getByRole('combobox',{name:'当前图片',exact:true}).selectOption('source');
    await page.getByRole('button',{name:'适应',exact:true}).click();
    await page.locator('[data-image-id="source"]').click({modifiers:['Shift']});
    assert.equal(await page.locator('.annotations').count(),0);
    await page.getByRole('button',{name:'适应',exact:true}).click();
    const selectCanvas=(await page.locator('.canvas').boundingBox())!;
    const boxes=await Promise.all(['source','result'].map(id=>page.locator(`[data-image-id="${id}"]`).boundingBox()));
    const left=Math.min(...boxes.map(b=>b!.x))-8,top=Math.min(...boxes.map(b=>b!.y))-34,right=Math.max(...boxes.map(b=>b!.x+b!.width))+8,bottom=Math.max(...boxes.map(b=>b!.y+b!.height))+8;
    assert.ok(left>selectCanvas.x&&top>selectCanvas.y);
    await page.mouse.move(left,top);await page.mouse.down();await page.mouse.move(right,bottom,{steps:6});
    assert.equal(await page.locator('.annotations').count(),0);await page.mouse.up();
    assert.ok(await page.locator('.image-board.selected').count()>=2);
    assert.equal(await page.getByRole('button',{name:'◇ 矢量化',exact:true}).isEnabled(),false);
    // A click in empty space clears the group; modifier clicks create an exact group.
    await page.mouse.click(selectCanvas.x+selectCanvas.width-50,selectCanvas.y+50);
    await page.getByRole('combobox',{name:'当前图片',exact:true}).selectOption('source');
    await page.keyboard.down('Control');await page.locator('.annotations').waitFor({state:'hidden'});await page.locator('[data-image-id="result"]').click();await page.keyboard.up('Control');
    assert.equal(await page.locator('.image-board.selected').count(),2);assert.equal(await page.locator('.annotations').count(),0);
    const groupBefore=structuredClone(saved.images.filter(i=>['source','result'].includes(i.id)));const groupBox=(await source.boundingBox())!;
    await page.mouse.move(groupBox.x+groupBox.width/2,groupBox.y+groupBox.height/2);await page.mouse.down();await page.mouse.move(groupBox.x+groupBox.width/2+12,groupBox.y+groupBox.height/2+8,{steps:4});await page.mouse.up();await flush();
    const groupAfter=saved.images.filter(i=>['source','result'].includes(i.id));assert.ok(groupAfter[0].x!==groupBefore[0].x);assert.ok(Math.abs((groupAfter[0].x-groupBefore[0].x)-(groupAfter[1].x-groupBefore[1].x))<.01);assert.deepEqual(groupAfter[0].annotations,groupBefore[0].annotations);
    const beforeDelete=structuredClone(saved.images);await page.getByRole('button',{name:'删除选中图片',exact:true}).click();await flush();
    assert.equal(saved.images.some(i=>i.id==='source'||i.id==='result'),false);assert.equal(saved.images.length,beforeDelete.length-2);
    await page.getByRole('button',{name:'撤销',exact:true}).click();await flush();assert.equal(saved.images.length,beforeDelete.length);
    await page.getByRole('combobox',{name:'当前图片',exact:true}).selectOption('result');
    await page.locator('.whole-image').click();
    conflictDuringSave = true;
    await page.getByRole('textbox', { name: '总图修改意见', exact: true }).fill('保留我的本地意见');
    await page.getByRole('button', { name: '下载未保存草稿', exact: true }).waitFor();
    assert.equal(saved.images[1].opinion, '服务器同时修改');
    assert.equal(await page.getByRole('textbox', { name: '总图修改意见', exact: true }).inputValue(), '保留我的本地意见');
  } finally { await browser.close(); await close(); }
});
