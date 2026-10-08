import fs from 'node:fs';
import crypto from 'node:crypto';

function fingerprint(file: string): string | null {
  try {
    const bytes = fs.readFileSync(file), stat = fs.statSync(file);
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs,
      crypto.createHash('sha256').update(bytes).digest('hex')].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Keep the staged file and target intact on failure; never unlink a locked target. */
export function replaceStagedFile(staged: string, target: string) {
  let initialTarget: string | null | undefined, initialStaged: string | null | undefined;
  if (process.platform === 'win32') {
    try { initialTarget = fingerprint(target); initialStaged = fingerprint(staged); }
    catch { /* Preserve the original single rename when snapshots cannot be read. */ }
  }
  const delays = [10, 20, 40, 80];
  const sameFiles = () => {
    try { return fingerprint(target) === initialTarget && fingerprint(staged) === initialStaged; }
    catch { return false; }
  };
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(staged, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(code || '') ||
          attempt >= delays.length || initialTarget === undefined || !initialStaged || !sameFiles())
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt]);
      if (!sameFiles()) throw error;
    }
  }
}
