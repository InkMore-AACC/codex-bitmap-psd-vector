import fs from 'node:fs';
import path from 'node:path';
import { processAlive, processSnapshot, type ProcessIdentity } from '../shared/process-owner.js';

export async function hasCanvasOwners(data: string): Promise<boolean> {
  const dir = path.join(data, 'service-owners');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  const leases = files.map((name) => ({
    file: path.join(dir, name),
    lease: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as {
      pid: number;
      owner?: ProcessIdentity;
    },
  }));
  // A failed process query must never be interpreted as an exited desktop.
  const rows = leases.some(({ lease }) => lease.owner) ? await processSnapshot() : [];
  let alive = false;
  for (const { file, lease } of leases) {
    const live = lease.owner
      ? rows.some((r) => r.pid === lease.owner!.pid && r.started === lease.owner!.started)
      : processAlive(lease.pid);
    if (live) alive = true;
    else
      try {
        fs.unlinkSync(file);
      } catch {
        /* already removed */
      }
  }
  return alive;
}

export function lifecycleGuard(options: {
  owners: () => Promise<boolean>;
  busy: () => boolean;
  stop: () => void;
  now?: () => number;
  graceMs?: number;
  managed?: boolean;
}) {
  const now = options.now || Date.now;
  let managed = !!options.managed,
    idleSince = now(),
    checking = false,
    closed = false;
  return async () => {
    if (checking || closed) return;
    checking = true;
    try {
      const owners = await options.owners();
      if (owners) managed = true;
      if (!managed || owners || options.busy()) {
        idleSince = now();
        return;
      }
      if (now() - idleSince >= (options.graceMs ?? 15_000)) {
        closed = true;
        options.stop();
      }
    } catch {
      idleSince = now(); /* fail safe: retain service on uncertain ownership */
    } finally {
      checking = false;
    }
  };
}
