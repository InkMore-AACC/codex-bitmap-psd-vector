import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ProcessIdentity = { pid: number; started: string };
export type ProcessRow = ProcessIdentity & { parent: number; name: string };
const run = promisify(execFile);

// Only process identity is read. No app databases, command lines or credentials.
export async function processSnapshot(): Promise<ProcessRow[]> {
  const script = `@(Get-CimInstance Win32_Process | ForEach-Object { @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;name=$_.Name;started=$_.CreationDate.ToUniversalTime().ToString('o')} }) | ConvertTo-Json -Compress`;
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout: 8000, maxBuffer: 2_000_000 },
  );
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

export function desktopOwner(rows: ProcessRow[], pid: number): ProcessIdentity | undefined {
  const visited = new Set<number>();
  let owner: ProcessIdentity | undefined;
  for (let depth = 0; pid && depth < 32 && !visited.has(pid); depth++) {
    visited.add(pid);
    const row = rows.find((r) => r.pid === pid);
    if (!row) break;
    if (/^(codex|chatgpt)\.exe$/i.test(row.name)) owner = { pid: row.pid, started: row.started };
    pid = row.parent;
  }
  return owner;
}

export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code !== 'ESRCH';
  }
}
