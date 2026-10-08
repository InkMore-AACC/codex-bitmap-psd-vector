const fragment = new URLSearchParams(location.hash.slice(1));
const incoming =
  fragment.get('token') || (!location.hash.includes('=') ? location.hash.slice(1) : '');
if (incoming) {
  sessionStorage.setItem('layer-canvas-token', incoming);
  history.replaceState(null, '', location.pathname + location.search);
}
export const token = () => sessionStorage.getItem('layer-canvas-token') || '';
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Canvas-Token', token());
  if (init.body && !(init.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      `${response.status === 409 ? '版本冲突：请先保留当前修改，再重新载入。' : ''}${body.error || body.message || `请求失败 (${response.status})`}`,
    );
  }
  return response.json();
}
// Only initial, read-only loading is retried. Never replay a mutation.
export async function apiWhenReady<T>(path: string, signal: AbortSignal): Promise<T> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<T>(path, { signal });
    } catch (error) {
      if (signal.aborted || error instanceof ApiError || attempt >= 29) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, 1000);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
}
export async function download(path: string, name: string) {
  const response = await fetch(path, {
    headers: { 'X-Canvas-Token': token() },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || '导出失败');
  }
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
