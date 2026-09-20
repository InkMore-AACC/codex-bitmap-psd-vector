import fs from 'node:fs';
import { readKeys } from './credentials.js';
import { cleanSvg } from './svg.js';
export async function vectorizeBytes(
  data: Buffer,
  engine: string,
  keys: {
    recraftKey?: string;
    api302Key?: string;
    vectorizerId?: string;
    vectorizerSecret?: string;
  },
  signal?: AbortSignal,
  request: typeof fetch = fetch,
) {
  if (!['recraft', 'vectorizer302', 'vectorizer'].includes(engine))
    throw new Error(
      engine === 'vectorizerCom'
        ? 'Vectorizer.com 使用网页自动转换流程'
        : '该矢量引擎已移除，请重新选择',
    );
  const form = new FormData();
  let endpoint = '',
    headers: Record<string, string> = {};
  if (engine === 'recraft') {
    if (!keys.recraftKey) throw new Error('请先在设置中填写 Recraft 官方 API Key');
    endpoint = 'https://external.api.recraft.ai/v1/images/vectorize';
    headers.Authorization = `Bearer ${keys.recraftKey}`;
    form.append('file', new Blob([new Uint8Array(data)]), 'layer.png');
    form.append('response_format', 'b64_json');
  } else if (engine === 'vectorizer302') {
    if (!keys.api302Key)
      throw new Error('请先在设置中填写 302.AI API Key（不是 Vectorizer.AI 官方密钥）');
    endpoint = 'https://api.302.ai/vectorizer/api/v1/vectorize';
    headers.Authorization = `Bearer ${keys.api302Key}`;
    form.append('image', new Blob([new Uint8Array(data)]), 'layer.png');
    form.append('output.file_format', 'svg');
  } else if (engine === 'vectorizer') {
    if (!keys.vectorizerId || !keys.vectorizerSecret)
      throw new Error('请先填写 Vectorizer.AI 官方 API ID 和 Secret');
    endpoint = 'https://vectorizer.ai/api/v1/vectorize';
    headers.Authorization = `Basic ${Buffer.from(`${keys.vectorizerId}:${keys.vectorizerSecret}`).toString('base64')}`;
    form.append('image', new Blob([new Uint8Array(data)]), 'layer.png');
    form.append('output.file_format', 'svg');
  } else throw new Error('未知矢量引擎');
  const response = await request(endpoint, {
    method: 'POST',
    body: form,
    headers,
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
      : AbortSignal.timeout(180000),
  });
  if (!response.ok)
    throw new Error(`${engine} 请求失败（HTTP ${response.status}）；请检查凭证、额度和图片尺寸`);
  let svg = '';
  if (engine === 'vectorizer302' || engine === 'vectorizer') svg = await response.text();
  else {
    const result: any = await response.json();
    const item = result.image || result.data?.[0];
    if (item?.b64_json) svg = Buffer.from(item.b64_json, 'base64').toString('utf8');
    else if (item?.url) {
      const u = new URL(item.url);
      if (u.protocol !== 'https:') throw new Error('API 返回非 HTTPS 下载地址');
      const r = await request(u, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(60000),
        redirect: 'error',
      });
      if (!r.ok) throw new Error('无法下载 Recraft 结果');
      svg = await r.text();
    } else throw new Error('Recraft 没有返回 SVG');
  }
  return cleanSvg(svg);
}
export async function vectorize(input: string, engine: string, signal?: AbortSignal) {
  return vectorizeBytes(fs.readFileSync(input), engine, await readKeys(), signal);
}
