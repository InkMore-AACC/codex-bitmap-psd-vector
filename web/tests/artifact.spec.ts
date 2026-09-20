import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('completed native artifact downloads authenticated original bytes', async ({ page }) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (
      request.url().includes('/api/') &&
      ['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method())
    )
      mutations.push(request.url());
  });
  const taskId = process.env.LAYER_CANVAS_ARTIFACT_TASK;
  test.skip(
    !taskId,
    'Set LAYER_CANVAS_ARTIFACT_TASK to a task containing a real completed native artifact.',
  );
  const service = JSON.parse(fs.readFileSync('data/service.json', 'utf8'));
  const jobs = JSON.parse(fs.readFileSync('data/jobs.json', 'utf8'));
  const job = jobs.findLast(
    (j: any) =>
      j.taskId === taskId && j.status === 'completed' && j.result?.artifactUrl?.endsWith('.ai'),
  );
  expect(job, 'A real completed Illustrator artifact must exist').toBeTruthy();
  const expectedPath = path.join(
    'data',
    'documents',
    job.documentId,
    'assets',
    path.basename(job.result.artifactUrl),
  );
  const expected = fs.readFileSync(expectedPath);
  expect(expected.subarray(0, 1024).toString()).toMatch(/%PDF|%!PS-Adobe/);
  await page.goto(`/?taskId=${encodeURIComponent(taskId!)}#token=${service.token}`);
  await expect(page.locator('.app')).toBeVisible();
  await page.locator('.statusbar button').click();
  const row = page.locator(`[data-job-id="${job.id}"]`);
  await expect(row.getByRole('button', { name: '下载产物 ↓' })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await row.getByRole('button', { name: '下载产物 ↓' }).click();
  const artifact = await downloaded;
  expect(artifact.suggestedFilename()).toMatch(/-Illustrator\.ai$/);
  const output = path.resolve('test-output/ui-native-artifact.ai');
  await artifact.saveAs(output);
  expect(fs.readFileSync(output).equals(expected)).toBe(true);
  await page.screenshot({ path: 'test-output/canvas-artifact-download.png' });
  await page.locator('.jobs-popover .panel-heading button').click();
  const psdOption = page
    .getByLabel('当前图片')
    .locator('option')
    .filter({ hasText: '可编辑文字与原生字效.psd' });
  if (await psdOption.count()) {
    await page.getByLabel('当前图片').selectOption({ label: '可编辑文字与原生字效.psd' });
    await page.locator('.image-board.selected').dblclick();
    await page.locator('.layer-row').filter({ hasText: 'Editable title' }).click();
    await page.screenshot({ path: 'test-output/canvas-current-task.png' });
  }
  expect(mutations).toEqual([]);
});
