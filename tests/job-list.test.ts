import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { jobList, jobTiming } from '../web/jobList';
import type { CanvasDocument, Job } from '../web/types';

const fixtureJob = (index: number, status: Job['status'] = 'completed'): Job => ({
  id: `job-${index}`, documentId: 'job-list-fixture', taskId: 'job-list-fixture',
  imageId: 'source', type: 'upscale', status, message: `任务 ${index}`,
  createdAt: new Date(Date.UTC(2026, 9, 12, 0, index)).toISOString(), version: 1,
});

test('active tasks are never truncated and history remains newest-first through status changes', () => {
  const history = Array.from({ length: 45 }, (_, i) => fixtureJob(i));
  const active = Array.from({ length: 35 }, (_, i) => fixtureJob(i + 45, 'running'));
  const jobs = [...history, ...active];
  const original = jobs.map((j) => j.id);
  const list = jobList(jobs, 30);
  assert.equal(list.active.length, 35);
  assert.equal(list.visible.length, 65);
  assert.equal(list.hiddenHistory, 15);
  assert.equal(list.visible[0].id, 'job-79');
  assert.equal(list.visible[35].id, 'job-44');
  assert.equal(list.visible.at(-1)?.id, 'job-15');
  assert.deepEqual(jobs.map((j) => j.id), original, 'must not reorder the stored list');
  assert.deepEqual(jobList([...jobs].reverse(), 30), list, 'independent of API order');
  assert.equal(jobList(jobs, 60).visible.length, 80);
  const changed = jobs.map((j) => j.id === 'job-79' ? { ...j, status: 'failed' as const } : j);
  assert.equal(jobList(changed, 30).visible[34].id, 'job-79');
  for (const status of ['queued', 'waiting_codex', 'running'] as const)
    assert.equal(jobList([fixtureJob(0, status), fixtureJob(100)], 1).visible[0].id, 'job-0');
});

test('elapsed time includes waiting and is not presented as execution progress', () => {
  const job = fixtureJob(0, 'queued');
  assert.match(jobTiming(job, Date.parse(job.createdAt) + 65000), /提交后已过 1分5秒/);
  assert.doesNotMatch(jobTiming({ ...job, status: 'completed' }), /已过/);
  assert.equal(jobTiming({ ...job, createdAt: 'invalid' }), '');
});

test('submitted task stays visible after polls, receives progress, finishes and retains expandable history', { timeout: 60000 }, async () => {
  // All APIs are intercepted: no real document, task, model or credentials are used.
  const output = path.resolve(`test-output/job-list-ui-${process.pid}`);
  await build({ configFile: false, plugins: [react()], logLevel: 'error', build: { outDir: output } });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const file = path.join(output, pathname === '/' ? 'index.html' : pathname);
    try {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(fs.readFileSync(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };
  const browser = await chromium.launch({ channel: 'msedge', headless: true }).catch(async (error) => { await close(); throw error; });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="gray"/></svg>');
    const doc: CanvasDocument = {
      id: 'job-list-fixture', taskId: 'job-list-fixture', revision: 1, updatedAt: '',
      images: [{ id: 'source', name: '任务测试', x: 0, y: 0, width: 20, height: 20, source: svg, url: svg, layers: [], annotations: [], opinion: '', version: 1, status: 'original' }],
      settings: { psdMode: 2, vectorEngine: 'vectorizerCom', theme: 'dark' },
      layout: { layersWidth: 210, opinionsWidth: 300, editorHeight: 260 },
    };
    let jobs = Array.from({ length: 45 }, (_, i) => fixtureJob(i));
    let polls = 0;
    let submissions = 0;
    const unexpected: string[] = [];
    await page.route('**/api/**', async (route) => {
      const req = route.request(), pathname = new URL(req.url()).pathname;
      if (pathname === '/api/document' && req.method() === 'GET') return route.fulfill({ json: doc });
      if (pathname.endsWith('/view-state')) return route.fulfill({ json: { x: 80, y: 80, scale: 1, selectedImageId: 'source' } });
      if (pathname.endsWith('/reference')) return route.fulfill({ json: { url: svg, complete: true } });
      if (pathname === '/api/settings' && req.method() === 'GET') return route.fulfill({ json: { recraftConfigured: false, api302Configured: false, vectorizerConfigured: false, models: {} } });
      if (pathname === '/api/jobs/job-45/cancel' && req.method() === 'POST') {
        jobs[45] = { ...jobs[45], status: 'cancelled', message: '已取消' };
        return route.fulfill({ json: jobs[45] });
      }
      if (pathname.endsWith('/jobs') && req.method() === 'POST') {
        submissions++;
        assert.equal(req.postDataJSON().type, 'upscale');
        const job = fixtureJob(45, 'queued');
        jobs.push(job); // Deliberately preserve the server's oldest-first order.
        return route.fulfill({ status: 202, json: job });
      }
      if (pathname.endsWith('/jobs') && req.method() === 'GET') {
        polls++;
        return route.fulfill({ json: jobs });
      }
      unexpected.push(`${req.method()} ${pathname}`);
      return route.fulfill({ status: 500, json: { error: 'Unexpected test API' } });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?taskId=job-list-fixture#token=test-only`);
    await expect(page.getByLabel('当前图片')).toHaveValue('source');
    await expect.poll(() => polls).toBeGreaterThan(0);
    await page.getByRole('button', { name: '超分', exact: true }).click();
    const row = page.locator('[data-job-id="job-45"]');
    await expect(row).toBeVisible();
    const afterSubmit = polls;
    await expect.poll(() => polls, { timeout: 10000 }).toBeGreaterThan(afterSubmit + 1);
    await expect(row).toBeVisible();
    await expect(page.locator('.job-row').first()).toHaveAttribute('data-job-id', 'job-45');
    await expect(page.locator('.job-row')).toHaveCount(31);
    jobs[45] = { ...jobs[45], status: 'running', message: '正在进行本地超分' };
    await expect(row).toContainText('正在进行本地超分', { timeout: 10000 });
    await expect(row).toContainText('提交后已过');
    jobs[45] = { ...jobs[45], status: 'completed', message: '超分已返回画布' };
    await expect(row).toContainText('超分已返回画布', { timeout: 10000 });
    await expect(row).not.toContainText('提交后已过');
    await expect(page.locator('.job-row')).toHaveCount(30);
    await page.getByRole('button', { name: /显示更早任务/ }).click();
    await expect(page.locator('.job-row')).toHaveCount(46);
    await expect(page.locator('.job-row').last()).toHaveAttribute('data-job-id', 'job-0');
    jobs = jobs.map((j) => ({ ...j, status: 'running' }));
    // Reload resets history pagination; even more than 30 active tasks must remain.
    await page.reload();
    await page.locator('footer button').filter({ hasText: '任务' }).click();
    await expect(page.locator('.job-row.running')).toHaveCount(46, { timeout: 10000 });
    await row.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('.job-row.running')).toHaveCount(45);
    await expect(row).toHaveClass(/cancelled/);
    assert.equal(submissions, 1);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await close(); }
});
