import fs from 'node:fs';
import path from 'node:path';
import { processAlive } from '../shared/process-owner.js';

// One service per data directory, including on Windows where port reuse can
// otherwise allow concurrent listeners. A PID-named file arbitrates recovery.
export function acquireServiceLock(data: string): (() => void) | undefined {
  fs.mkdirSync(data, { recursive: true });
  const dir = path.join(data, 'service-lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(dir);
      const file = path.join(dir, `owner-${process.pid}.json`);
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      return () => {
        try {
          fs.unlinkSync(file);
          fs.rmdirSync(dir);
        } catch {
          /* already released */
        }
      };
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const files = fs.readdirSync(dir);
        if (!files.length) {
          if (Date.now() - fs.statSync(dir).mtimeMs < 30_000) return;
          fs.rmdirSync(dir); // Atomic and only succeeds while empty.
          continue;
        }
        if (files.length !== 1 || !/^owner-\d+\.json$/.test(files[0])) return;
        const pid = Number(files[0].slice(6, -5));
        if (processAlive(pid)) return;
        // Only one contender can unlink this exact dead owner's file.
        fs.unlinkSync(path.join(dir, files[0]));
        fs.rmdirSync(dir);
      } catch (e: any) {
        if (e.code !== 'ENOENT') return;
      }
    }
  }
}
