import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function serviceIdentity(root: string, data: string) {
  const normalize = (value: string) => {
    let resolved = path.resolve(value);
    try {
      resolved = fs.realpathSync(resolved);
    } catch {}
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([normalize(root), normalize(data)]))
    .digest('hex');
}
