import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { atomic, json } from './store.js';
const file = path.join(process.env.LOCALAPPDATA || os.homedir(), 'LayerCanvas', 'credentials.json');
type Keys = {
  api302Key?: string;
  recraftKey?: string;
  vectorizerId?: string;
  vectorizerSecret?: string;
};
function crypt(value: string, decrypt = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const script = decrypt
      ? '$s=ConvertTo-SecureString ([Console]::In.ReadToEnd());$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}'
      : '$s=ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force;[Console]::Out.Write((ConvertFrom-SecureString $s))';
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
      ),
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error('Windows 凭证加密失败')),
    );
    p.stdin.end(value);
  });
}
export async function readKeys(): Promise<Keys> {
  const data = json<Record<string, string>>(file, {});
  const result: Keys = {};
  for (const [key, value] of Object.entries(data)) {
    if (['recraftKey', 'api302Key', 'vectorizerId', 'vectorizerSecret'].includes(key) && value)
      (result as any)[key] = await crypt(value, true);
  }
  return result;
}
export function keyStatus() {
  const k = json<Record<string, string>>(file, {});
  return {
    recraftConfigured: !!k.recraftKey,
    api302Configured: !!k.api302Key,
    vectorizerConfigured: !!k.vectorizerId && !!k.vectorizerSecret,
  };
}
export async function updateKeys(keys: Keys) {
  const data = json<Record<string, string>>(file, {});
  for (const key of ['recraftKey', 'api302Key', 'vectorizerId', 'vectorizerSecret'] as const) {
    if (keys[key] !== undefined) {
      if (keys[key]!.length > 2000) throw new Error('凭证长度无效');
      data[key] = keys[key] ? await crypt(keys[key]!) : '';
    }
  }
  atomic(file, data);
  return keyStatus();
}
