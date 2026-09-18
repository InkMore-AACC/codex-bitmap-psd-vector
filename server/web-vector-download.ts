import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { cleanSvg } from './svg.js';

export function reviewAddress(value: string) {
  const url = new URL(value);
  if (url.origin !== 'https://vectorizer.com' || !/^\/review\/[a-f0-9]{16}\/?$/.test(url.pathname) || url.search || url.hash)
    throw new Error('需要当前 Vectorizer.com 的公开结果页地址');
  return url.href;
}
export class VerificationRequired extends Error {}
export type DownloadInput = { layerId: string; uploadPath: string };

/** Receives existing website results; never uploads, converts, or calls a private endpoint. */
export async function receiveInContext(context: BrowserContext, reviewUrl: string, inputs: DownloadInput[], output: string,
  signal: AbortSignal, progress: (message: string, completed: number) => void) {
  const address = reviewAddress(reviewUrl);
  signal.throwIfAborted();
  const page = await context.newPage();
  const stop = () => { void page.close().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if(page.url()!==address)throw new VerificationRequired('结果页发生跳转；请在当前网页确认验证和结果是否仍有效');
    const names = page.locator('input.name-input');
    try { await names.first().waitFor({ state: 'visible', timeout: 15000 }); }
    catch { throw new VerificationRequired('下载接收器未能访问结果页；请在当前网页确认验证及结果是否仍有效'); }
    const available = await names.evaluateAll(elements => elements.map(el => (el as HTMLInputElement).value || el.getAttribute('placeholder')));
    const expected = inputs.map(i => path.basename(i.uploadPath, '.png'));
    if (new Set(available).size !== available.length || available.length !== expected.length || expected.some(n => !available.includes(n)))
      throw new Error('网页文件名称或数量与当前任务不一致，未回传任何结果');
    await fs.mkdir(output, { recursive: true });
    const files: { layerId: string; path: string }[] = [];
    for (const [index, input] of inputs.entries()) {
      signal.throwIfAborted();
      const name = expected[index];
      const destination = path.join(output, name + '.svg');
      // Resume only validated downloads already bound to this task directory.
      let valid = false;
      try { const stat = await fs.stat(destination); if (stat.size <= 40 * 1024 * 1024) { cleanSvg(await fs.readFile(destination, 'utf8')); valid = true; } } catch {}
      if (!valid) {
        progress(`正在接收矢量文件 ${index + 1}/${inputs.length}`, files.length);
        const row = page.locator('.review').filter({ has: page.getByPlaceholder(name, { exact: true }) });
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 45000 }), row.getByRole('button', { name: 'DOWNLOAD', exact: true }).click(),
        ]);
        if (download.suggestedFilename() !== name + '.svg') throw new Error('下载文件名称不匹配');
        const downloadedPath = await download.path();
        signal.throwIfAborted();
        if (!downloadedPath || (await fs.stat(downloadedPath)).size > 40 * 1024 * 1024) throw new Error('下载文件无效或超过 40 MB');
        const svg = cleanSvg(await fs.readFile(downloadedPath, 'utf8'));
        await fs.writeFile(destination + '.part', svg);
        await fs.rename(destination + '.part', destination);
      }
      files.push({ layerId: input.layerId, path: destination });
      progress(`已接收并校验 ${files.length}/${inputs.length} 个矢量文件`, files.length);
    }
    await fs.writeFile(path.join(output, 'web-download-manifest.json'), JSON.stringify({ reviewUrl: address, files }, null, 2));
    return files;
  } finally { signal.removeEventListener('abort', stop); await page.close().catch(() => {}); }
}

export async function receiveWebVectors(reviewUrl: string, inputs: DownloadInput[], output: string, signal: AbortSignal,
  progress: (message: string, completed: number) => void) {
  reviewAddress(reviewUrl);
  let browser;
  for (const channel of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel, headless: true, timeout: 20000 }); break; } catch {}
  }
  if (!browser) throw new Error('下载接收器需要已安装的 Edge 或 Chrome');
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    return await receiveInContext(context, reviewUrl, inputs, output, signal, progress);
  } finally { await browser.close().catch(() => {}); }
}
