import fs from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { cleanSvg } from './svg.js';

/** Public upload/review/download UI only. Each layer gets an isolated upload session. */
export class VectorizerBrowser {
  private browser?: Browser;
  async open() {
    for (const channel of ['msedge', 'chrome']) {
      try { this.browser = await chromium.launch({ channel, headless: true, timeout: 20000 }); return; } catch { /* try the other installed browser */ }
    }
    throw new Error('网页转换启动失败：需要本机安装 Microsoft Edge 或 Chrome');
  }
  async convert(data: Buffer, signal: AbortSignal, progress: (text: string) => void) {
    signal.throwIfAborted();
    if (!this.browser) throw new Error('网页转换浏览器未启动');
    const context = await this.browser.newContext({ acceptDownloads: true, locale: 'en-US' });
    try { return await convertInContext(context, data, signal, progress); }
    finally { await context.close().catch(() => {}); }
  }
  async close() { await this.browser?.close().catch(() => {}); }
}

export async function convertInContext(context: BrowserContext, data: Buffer, signal: AbortSignal, progress: (text: string) => void) {
  const stop = () => { void context.close().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  const deadline = setTimeout(stop, 180000);
  try {
    signal.throwIfAborted();
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    progress('正在打开免费转换网页');
    await page.goto('https://vectorizer.com/', { waitUntil: 'domcontentloaded' });
    progress('正在自动上传图层');
    await page.locator('#fileInput').setInputFiles({ name: 'layer.png', mimeType: 'image/png', buffer: data });
    // The review link acquires its public result URL after conversion completes.
    await page.waitForFunction(() => document.querySelector('#reviewBtn')?.getAttribute('href')?.startsWith('/review/'), undefined, { timeout: 120000 });
    signal.throwIfAborted();
    progress('正在自动下载矢量结果');
    await page.locator('#reviewBtn').click();
    const [downloaded] = await Promise.all([page.waitForEvent('download'), page.locator('button.download-btn').click()]);
    const file = await downloaded.path();
    signal.throwIfAborted();
    if (!file || !/\.svg$/i.test(downloaded.suggestedFilename())) throw new Error('网页没有返回 SVG 文件');
    if ((await fs.stat(file)).size > 40 * 1024 * 1024) throw new Error('网页结果超过 40 MB');
    return cleanSvg(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (signal.aborted) throw new Error('已取消网页转换');
    if (error instanceof Error && /不允许|SVG|40 MB/.test(error.message)) throw error;
    throw new Error('免费网页转换失败：网站超时、页面变化或需要人工验证。原图已保留，请稍后重试或选择其他引擎');
  } finally { clearTimeout(deadline); signal.removeEventListener('abort', stop); }
}
