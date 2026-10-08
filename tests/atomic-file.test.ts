import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { replaceStagedFile } from '../server/atomic-file.js';

function fixture(t: TestContext, existing = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-canvas-atomic-'));
  const target = path.join(dir, 'target.json'), staged = path.join(dir, 'staged.tmp');
  if (existing) fs.writeFileSync(target, 'original');
  fs.writeFileSync(staged, 'candidate');
  t.after(() => {
    const resolved = fs.realpathSync(dir), tempRoot = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), tempRoot);
    assert(path.basename(resolved).startsWith('layer-canvas-atomic-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { target, staged };
}
const busy = () => Object.assign(new Error('temporary Windows lock'), { code: 'EPERM' });

test('atomic replacement keeps the exact staged bytes', t => {
  const f = fixture(t); replaceStagedFile(f.staged, f.target);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'candidate');
  assert.equal(fs.existsSync(f.staged), false);
});

test('Windows transient rename retries, persistent locks preserve both files', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), rename = fs.renameSync; let calls = 0;
  const stub = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    calls++; if (calls === 1) throw busy(); return rename(from, to);
  });
  replaceStagedFile(f.staged, f.target); assert.equal(calls, 2);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'candidate'); stub.mock.restore();
  const locked = fixture(t); calls = 0;
  t.mock.method(fs, 'renameSync', () => { calls++; throw busy(); });
  assert.throws(() => replaceStagedFile(locked.staged, locked.target), { code: 'EPERM' });
  assert.equal(calls, 5);
  assert.equal(fs.readFileSync(locked.target, 'utf8'), 'original');
  assert.equal(fs.readFileSync(locked.staged, 'utf8'), 'candidate');
});

test('Windows retry stops when a target update or new target is observed', { skip: process.platform !== 'win32' }, t => {
  for (const existing of [true, false]) {
    const f = fixture(t, existing); let calls = 0;
    const stub = t.mock.method(fs, 'renameSync', () => {
      calls++; fs.writeFileSync(f.target, 'concurrent user update'); throw busy();
    });
    assert.throws(() => replaceStagedFile(f.staged, f.target), { code: 'EPERM' });
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'concurrent user update');
    assert.equal(fs.readFileSync(f.staged, 'utf8'), 'candidate'); stub.mock.restore();
  }
});

test('Windows retry refuses changed staged bytes and never retries unrelated errors', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); let calls = 0;
  const stub = t.mock.method(fs, 'renameSync', () => {
    calls++; fs.writeFileSync(f.staged, 'changed candidate'); throw busy();
  });
  assert.throws(() => replaceStagedFile(f.staged, f.target), { code: 'EPERM' });
  assert.equal(calls, 1); assert.equal(fs.readFileSync(f.target, 'utf8'), 'original'); stub.mock.restore();
  const g = fixture(t); calls = 0;
  t.mock.method(fs, 'renameSync', () => { calls++; throw Object.assign(new Error('disk failure'), { code: 'EIO' }); });
  assert.throws(() => replaceStagedFile(g.staged, g.target), { code: 'EIO' });
  assert.equal(calls, 1); assert.equal(fs.readFileSync(g.staged, 'utf8'), 'candidate');
});

test('actual Windows sharing lock can release during bounded replacement', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), quoted = "'" + f.target.replace(/'/g, "''") + "'";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$stream=[System.IO.File]::Open(${quoted},[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite);try{[Console]::WriteLine('locked');[System.Threading.Thread]::Sleep(60)}finally{$stream.Dispose()}`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock helper timeout')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('lock helper failed: ' + code)); });
  });
  replaceStagedFile(f.staged, f.target);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'candidate');
  await new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null) { child.exitCode === 0 ? resolve() : reject(new Error('lock helper failed')); return; }
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('lock helper failed')));
  });
});
