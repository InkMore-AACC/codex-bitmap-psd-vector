import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { initializeCanvas, readPsd, writePsdBuffer } from 'ag-psd';
import { reconcileSaved } from '../reconcile';
initializeCanvas(
  (w, h) => createCanvas(w, h) as any,
  (w, h) => new ImageData(w, h) as any,
);
const service = JSON.parse(fs.readFileSync('data/service.json', 'utf8'));
const task = `ui-test-canvas-20260918-${Date.now()}`;
const fixture = () => {
  const w = 640,
    h = 800;
  const canvas = createCanvas(w, h),
    ctx = canvas.getContext('2d');
  const children: any[] = [];
  const layer = (name: string, draw: () => void) => {
    ctx.clearRect(0, 0, w, h);
    draw();
    children.push({ name, imageData: ctx.getImageData(0, 0, w, h) });
  };
  layer('背景', () => {
    ctx.fillStyle = '#dfd5c6';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ccc0ae';
    ctx.beginPath();
    ctx.ellipse(320, 620, 200, 40, 0, 0, Math.PI * 2);
    ctx.fill();
  });
  layer('产品', () => {
    ctx.fillStyle = '#77685c';
    ctx.fillRect(225, 300, 190, 300);
    ctx.fillStyle = '#c8baa8';
    ctx.fillRect(245, 350, 150, 160);
    ctx.fillStyle = '#3c382e';
    ctx.font = '24px Arial';
    ctx.fillText('STILL', 287, 420);
    ctx.font = '12px Arial';
    ctx.fillText('A MOMENT OF QUIET', 254, 453);
  });
  layer('标题', () => {
    ctx.fillStyle = '#464235';
    ctx.font = '54px Arial';
    ctx.fillText('LESS, BUT', 64, 115);
    ctx.fillText('BETTER.', 64, 175);
    ctx.font = '15px Arial';
    ctx.fillText('EVERYDAY ESSENTIALS / 2026', 68, 224);
    ctx.font = '13px Arial';
    ctx.fillText('SIMPLE THINGS. BEAUTIFULLY MADE.', 68, 747);
  });
  children[2].text = {
    text: 'LESS, BUT\nBETTER.',
    transform: [1, 0, 0, 1, 64, 115],
    style: { font: { name: 'Arial' }, fontSize: 54, fillColor: { r: 70, g: 66, b: 53 } },
  };
  ctx.clearRect(0, 0, w, h);
  for (const child of children) {
    const temp = createCanvas(w, h);
    temp.getContext('2d').putImageData(child.imageData, 0, 0);
    ctx.drawImage(temp, 0, 0);
  }
  return {
    psd: writePsdBuffer(
      { width: w, height: h, children, imageData: ctx.getImageData(0, 0, w, h) },
      { generateThumbnail: false },
    ),
    png: canvas.toBuffer('image/png'),
  };
};

test('multi-image canvas, scoped opinions, annotations, resizers, PSD export and Codex queue', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?taskId=${task}#token=${service.token}`);
  await expect(page.getByText('让每个元素，都能独立编辑')).toBeVisible();
  const f = fixture();
  await page.locator('input[type=file]').setInputFiles([
    { name: 'Still.psd', mimeType: 'image/vnd.adobe.photoshop', buffer: f.psd },
    { name: 'Reference.png', mimeType: 'image/png', buffer: f.png },
  ]);
  await expect(page.locator('.image-board')).toHaveCount(2);
  await page.getByLabel('当前图片').selectOption({ label: 'Still.psd' });
  await expect(page.locator('.layer-row')).toHaveCount(3);
  await page.getByLabel('总图修改意见').fill('整张图片放大至 2K，保持分层不变。');
  await page.locator('.layer-row').filter({ hasText: '标题' }).click();
  await expect(page.getByLabel('图层修改意见')).toHaveValue('');
  await page.getByLabel('图层修改意见').fill('标题保持字形，改为可编辑文字。');
  await page.locator('.whole-image').click();
  await expect(page.getByLabel('总图修改意见')).toHaveValue('整张图片放大至 2K，保持分层不变。');
  await page.locator('.layer-row').filter({ hasText: '标题' }).click();
  await expect(page.getByLabel('图层修改意见')).toHaveValue('标题保持字形，改为可编辑文字。');
  // Draw a real annotation at image coordinates after fitting the image.
  await page.locator('.image-board.selected').dblclick();
  await page.getByLabel('箭头 A').click();
  const board = (await page.locator('.image-board.selected').boundingBox())!;
  await page.mouse.move(board.x + board.width * 0.2, board.y + board.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(board.x + board.width * 0.5, board.y + board.height * 0.35, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByLabel('标注文字')).toBeVisible();
  await page.getByLabel('标注文字').fill('只调整标题效果');
  await expect(page.locator('.image-board.selected .annotations line')).toHaveCount(1);
  await page.getByLabel('选择 V').click();
  // Both sidebar widths and editor height are adjustable and saved.
  const layersBefore = (await page.locator('.layers-panel').boundingBox())!.width;
  const splitter = (await page.getByRole('separator', { name: '调整图层栏宽度' }).boundingBox())!;
  await page.mouse.move(splitter.x + 2, splitter.y + 150);
  await page.mouse.down();
  await page.mouse.move(splitter.x - 45, splitter.y + 150, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await page.locator('.layers-panel').boundingBox())!.width)
    .toBeGreaterThan(layersBefore + 30);
  const editorBefore = (await page.getByLabel('图层修改意见').boundingBox())!.height;
  const handle = (await page
    .getByRole('separator', { name: '调整修改意见输入区高度' })
    .boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 75, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await page.getByLabel('图层修改意见').boundingBox())!.height)
    .toBeGreaterThan(editorBefore + 50);
  const ps = page.locator('.handoff-button').first();
  await expect(page.locator('.handoff .tooltip').first()).toBeHidden();
  await ps.hover();
  await expect(page.locator('.handoff .tooltip').first()).toBeVisible();
  await page.locator('.panel-heading').first().hover();
  await expect(page.locator('.handoff .tooltip').first()).toBeHidden();
  await expect(page.locator('.save-state')).toHaveText('已保存');
  await page.screenshot({ path: 'test-output/canvas-dark.png' });
  await page.reload();
  await expect(page.locator('.image-board')).toHaveCount(2);
  await page.getByLabel('当前图片').selectOption({ label: 'Still.psd' });
  await expect(page.getByLabel('总图修改意见')).toHaveValue('整张图片放大至 2K，保持分层不变。');
  await page.locator('.layer-row').filter({ hasText: '标题' }).click();
  await expect(page.getByLabel('图层修改意见')).toHaveValue('标题保持字形，改为可编辑文字。');
  await expect(page.locator('.image-board.selected .annotations line')).toHaveCount(1);
  const downloadPromise = page.waitForEvent('download');
  await page.getByLabel('导出格式').selectOption('psd');
  const output = await downloadPromise;
  await output.saveAs(path.resolve('test-output/ui-roundtrip.psd'));
  expect(fs.statSync('test-output/ui-roundtrip.psd').size).toBeGreaterThan(1000);
  await page.getByLabel('PSD 分层方案设置').click();
  await expect(page.getByText('方案 1 · 本地精抠 + 生成补全', { exact: true })).toBeVisible();
  await page.getByText('方案 2 · 本地粗抠 + 生成重建', { exact: true }).click();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '☾ 暗色' }).click();
  await expect(page.locator('.app.light')).toBeVisible();
  await page.screenshot({ path: 'test-output/canvas-light.png' });
  await page.getByRole('button', { name: '☀ 亮色' }).click();
  await page.getByRole('button', { name: '▧ 预分层', exact: true }).click();
  await expect(page.locator('.job-row.waiting_codex')).toBeVisible();
  await expect(page.getByText('在打开本画布的 Codex 对话中说：“处理画布请求”。')).toBeVisible();
  await page.locator('.job-row').getByRole('button', { name: '取消' }).click();
  await expect(page.locator('.job-row.cancelled')).toBeVisible();
  expect(errors).toEqual([]);
});

test('save response keeps server text preview and newer local opinion', () => {
  const before = {
    revision: 1,
    images: [
      { id: 'i', opinion: '', layers: [{ id: 'l', text: 'hello', url: 'old.png', opinion: '' }] },
    ],
  };
  const local = structuredClone(before);
  local.images[0].layers[0].opinion = 'keep effects';
  const saved = structuredClone(before);
  saved.revision = 2;
  saved.images[0].layers[0].url = 'rendered.png';
  const merged = reconcileSaved(before, local, saved);
  expect(merged.images[0].layers[0]).toEqual({
    id: 'l',
    text: 'hello',
    url: 'rendered.png',
    opinion: 'keep effects',
  });
  expect(merged.revision).toBe(2);
});

test('native text edits, visibility undo, pure SVG export and preview confirmation', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const taskId = task + '-text';
  await page.goto(`/?taskId=${taskId}#token=${service.token}`);
  await expect(page.locator('.empty-canvas')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({
    name: 'Typography.psd',
    mimeType: 'image/vnd.adobe.photoshop',
    buffer: fixture().psd,
  });
  await expect(page.locator('.layer-row')).toHaveCount(3);
  await page.locator('.layer-row').filter({ hasText: '标题' }).click();
  await page.getByText('可编辑文字属性', { exact: true }).click();
  await page.getByLabel('文字内容').fill('EDITABLE TITLE');
  await page.getByLabel('字号', { exact: true }).fill('48');
  await page.getByLabel('描边', { exact: true }).check();
  await page.getByLabel('描边宽度').fill('3');
  await expect(page.locator('.save-state')).toHaveText('已保存');
  const outputPromise = page.waitForEvent('download');
  await page.getByLabel('导出格式').selectOption('psd');
  const download = await outputPromise;
  await download.saveAs(path.resolve('test-output/ui-text-edited.psd'));
  const psd = readPsd(fs.readFileSync('test-output/ui-text-edited.psd'), { useImageData: true });
  const textLayer = psd.children!.find((l) => l.name === '标题')!;
  expect(textLayer.text!.text).toBe('EDITABLE TITLE');
  expect(textLayer.text!.style!.fontSize).toBe(48);
  expect(textLayer.effects!.stroke![0].size!.value).toBe(3);
  await page.getByLabel('隐藏标题').click();
  await expect(page.getByLabel('显示标题')).toBeVisible();
  await page.getByLabel('撤销', { exact: true }).click();
  await expect(page.getByLabel('隐藏标题')).toBeVisible();
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><rect width="300" height="300" fill="#3d3355"/><circle cx="150" cy="150" r="90" fill="#b29ae8"/><path d="M100 150L140 190L210 110" stroke="#fff" fill="none" stroke-width="16"/></svg>';
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'Vector.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await expect(page.locator('.image-board')).toHaveCount(2);
  const svgPromise = page.waitForEvent('download');
  await page.getByLabel('导出格式').selectOption('svg');
  const svgFile = await svgPromise;
  await svgFile.saveAs(path.resolve('test-output/ui-pure-vector.svg'));
  expect(fs.readFileSync('test-output/ui-pure-vector.svg', 'utf8')).not.toMatch(
    /<image|data:image/,
  );
  await page.getByLabel('当前图片').selectOption({ label: 'Typography.psd' });
  await expect(page.locator('.save-state')).toHaveText('已保存');
  const docResponse = await request.get(`/api/document?taskId=${taskId}`, {
    headers: { 'X-Canvas-Token': service.token },
  });
  const doc = await docResponse.json();
  doc.images[0].status = 'preview';
  doc.images[0].layers.forEach((l: any) => (l.preview = true));
  const seeded = await request.put(`/api/document/${doc.id}`, {
    headers: { 'X-Canvas-Token': service.token },
    data: { document: doc, expectedRevision: doc.revision },
  });
  expect(seeded.ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: '确认方案，开始真实分层' })).toBeVisible();
  await page.getByRole('button', { name: '确认方案，开始真实分层' }).click();
  await expect(page.locator('.job-row.waiting_codex')).toBeVisible();
  await expect(page.locator('.job-row b')).toHaveText('确认分层');
  await page.locator('.job-row').getByRole('button', { name: '取消' }).click();
  expect(errors).toEqual([]);
});

test('vector view keeps raster layers and scopes opinions and original conversion', async ({
  page,
  request,
}) => {
  const taskId = task + '-versions';
  await page.goto(`/?taskId=${taskId}#token=${service.token}`);
  await expect(page.locator('.empty-canvas')).toBeVisible();
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="800"><rect width="640" height="800" fill="#594375"/><circle cx="320" cy="400" r="180" fill="#c4a0ff"/></svg>';
  await page.locator('input[type=file]').setInputFiles([
    { name: 'Layered.psd', mimeType: 'image/vnd.adobe.photoshop', buffer: fixture().psd },
    { name: 'Result.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) },
  ]);
  await expect(page.locator('.image-board')).toHaveCount(2);
  const headers = { 'X-Canvas-Token': service.token };
  const response = await request.get(`/api/document?taskId=${taskId}`, { headers });
  const doc = await response.json();
  doc.images[0].vectorLayers = [
    { ...doc.images[1].layers[0], id: 'vector-result-layer', name: '矢量重建' },
  ];
  doc.images[0].vectorUrl = doc.images[1].url;
  const seeded = await request.put(`/api/document/${doc.id}`, {
    headers,
    data: { document: doc, expectedRevision: doc.revision },
  });
  expect(seeded.ok()).toBeTruthy();
  await page.reload();
  await page.getByLabel('当前图片').selectOption({ label: 'Layered.psd' });
  await expect(page.locator('.layer-row')).toHaveCount(3);
  await page.locator('.view-tabs').getByRole('button', { name: '矢量', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await page.locator('.layer-row').click();
  await page.getByLabel('图层修改意见').fill('只调整矢量路径');
  await page.locator('.view-tabs').getByRole('button', { name: '分层', exact: true }).click();
  await expect(page.locator('.layer-row')).toHaveCount(3);
  await page.locator('.layer-row').filter({ hasText: '标题' }).click();
  await expect(page.getByLabel('图层修改意见')).toHaveValue('');
  await page.locator('.view-tabs').getByRole('button', { name: '矢量', exact: true }).click();
  await page.locator('.layer-row').click();
  await expect(page.getByLabel('图层修改意见')).toHaveValue('只调整矢量路径');
  await page.locator('.view-tabs').getByRole('button', { name: '原图', exact: true }).click();
  await expect(page.locator('.image-board.selected .image-content>img')).toHaveAttribute(
    'src',
    doc.images[0].source,
  );
  // Inspect the live POST payload, then cancel the real local task immediately.
  const sent = page.waitForRequest((r) => r.url().endsWith('/jobs') && r.method() === 'POST');
  await page.getByRole('button', { name: '◇ 矢量化', exact: true }).click();
  const payload = (await sent).postDataJSON();
  expect(payload.useOriginal).toBe(true);
  expect(payload.layerIds).toBeUndefined();
  const cancel = page.locator('.job-row').getByRole('button', { name: '取消' });
  if (await cancel.count()) await cancel.click();
  const after = await (await request.get(`/api/document?taskId=${taskId}`, { headers })).json();
  expect(after.images[0].layers).toHaveLength(3);
  expect(after.images[0].vectorLayers).toHaveLength(1);
});
