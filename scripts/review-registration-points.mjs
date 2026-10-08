import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import sharp from 'sharp';
import {checkContextBudget, findCurrentHistory} from './check-context-budget.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sort = (a, b) => a.source[0] - b.source[0] || a.source[1] - b.source[1];
const even = rows => Array.from({length: Math.min(3, rows.length)}, (_, i) =>
  rows[Math.round(i * (rows.length - 1) / Math.max(1, Math.min(3, rows.length) - 1))]);

// Displays existing measurements; never measures again, fits, changes a gate or writes materials.
export async function reviewRegistrationPoints(manifestPath, destination, options = {}) {
  const taskId = options.taskId ?? process.env.CODEX_THREAD_ID;
  if (!taskId || process.env.CODEX_THREAD_ID && taskId !== process.env.CODEX_THREAD_ID)
    throw Error('Real current task identity required');
  if (!/\.jpg$/i.test(destination)) throw Error('New diagnostic JPEG required');
  const snapshots = new Map();
  async function capture(filename, expectedHash) {
    filename = path.resolve(filename);
    const bytes = await fs.readFile(filename);
    if (expectedHash && digest(bytes) !== expectedHash) throw Error('Frozen input hash changed');
    if (snapshots.has(filename) && !snapshots.get(filename).equals(bytes)) throw Error('Input changed while reading');
    snapshots.set(filename, bytes);
    return bytes;
  }
  const manifest = JSON.parse((await capture(manifestPath)).toString('utf8'));
  if (manifest.taskId !== taskId) throw Error('Foreign diagnostic task');
  async function record(key) {
    const item = manifest[key];
    if (!item?.path || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw Error('Hash-bound receipt required: ' + key);
    return JSON.parse((await capture(item.path, item.sha256)).toString('utf8'));
  }
  const [freeze, q, g, a] = await Promise.all(['freeze', 'prepare', 'registered', 'alignment'].map(record));
  const p = a.proposal;
  const localIndex = q.referencePaths?.indexOf(q.localPath) ?? -1;
  const referenceHash = q.localReferenceHash ?? (localIndex >= 0 ? q.referenceHashes?.[localIndex] : undefined);
  const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
  if (![taskId, freeze.jobId, freeze.imageId, q.id, g.id].every(uuid) ||
      ![freeze.sourceHash, referenceHash, g.hash].every(h => /^[a-f0-9]{64}$/.test(h ?? '')))
    throw Error('Actual frozen task/job/image/request/material identity and hashes required');
  if (freeze.taskId !== taskId || g.requestId !== q.id || a.record?.id !== g.id ||
      a.record?.hash !== g.hash || path.resolve(a.record?.originalPath ?? '') !== path.resolve(g.originalPath) ||
      !q.sourceLayerIds?.length || q.sourceLayerIds.some(id => !Object.values(freeze.ids ?? {}).includes(id)) ||
      JSON.stringify(q.sourceLayerIds) !== JSON.stringify(g.sourceLayerIds) ||
      JSON.stringify(q.frame) !== JSON.stringify(g.frame)) throw Error('Receipts do not bind the same frozen job material');
  if (!['sift', 'orb'].includes(p?.method) || !p.points?.length || p.points.length > 7000 ||
      !Number.isFinite(p.scale) || p.scale <= 0 || !a.evidencePath)
    throw Error('Existing feature proposal required; edge/missing evidence is not replaced');
  const proposalBytes = await capture(a.evidencePath);
  if (!isDeepStrictEqual(JSON.parse(proposalBytes.toString('utf8')), p))
    throw Error('Proposal differs from actual measurement evidence');
  const [source, reference, generated] = await Promise.all([
    capture(freeze.sourcePath, freeze.sourceHash), capture(q.localPath, referenceHash), capture(g.originalPath, g.hash),
  ]);
  const [sourceMeta, refMeta, genMeta] = await Promise.all([source, reference, generated].map(b => sharp(b).metadata()));
  const frame = q.frame;
  if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isInteger) ||
      frame.x < 0 || frame.y < 0 || frame.width < 1 || frame.height < 1 ||
      frame.x + frame.width > sourceMeta.width || frame.y + frame.height > sourceMeta.height ||
      sourceMeta.width * sourceMeta.height > 1500000 ||
      q.canvas?.width !== sourceMeta.width || q.canvas?.height !== sourceMeta.height ||
      JSON.stringify(p.referenceSize) !== JSON.stringify([refMeta.width, refMeta.height]) ||
      JSON.stringify(p.sourceSize) !== JSON.stringify([genMeta.width, genMeta.height]))
    throw Error('Direct source-pixel frame/dimensions required; do not guess a resized mapping');
  const exact = await sharp(source).extract({left: frame.x, top: frame.y, width: frame.width, height: frame.height}).ensureAlpha().raw().toBuffer();
  if (!exact.equals(await sharp(reference).ensureAlpha().raw().toBuffer())) throw Error('Local reference differs from frozen source');
  const point = (v, size) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) &&
    v[0] >= 0 && v[1] >= 0 && v[0] < size[0] && v[1] < size[1];
  for (const row of p.points) if (!['fit', 'validation'].includes(row.role) ||
      !point(row.source, p.sourceSize) || !point(row.target, p.referenceSize) ||
      !Number.isFinite(row.residual) || row.residual < 0 || typeof row.inlier !== 'boolean')
    throw Error('Malformed existing feature pair');
  const chosen = [...even(p.points.filter(r => r.role === 'fit').sort(sort)),
    ...even(p.points.filter(r => r.role === 'validation').sort(sort))];
  if (!chosen.some(r => r.role === 'validation')) throw Error('No existing held-out pairs to view');
  const reportPath = destination.replace(/\.jpg$/i, '.json');
  for (const filename of [destination, reportPath]) {
    if (snapshots.has(path.resolve(filename))) throw Error('Cannot overwrite an input');
    try { await fs.stat(filename); throw Error('Diagnostic output already exists'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const maxBytes = 131072;
  let contextBudget;
  if (process.env.CODEX_THREAD_ID && options.contextGuard !== false) {
    contextBudget = await checkContextBudget(await findCurrentHistory(taskId), {taskId, reserveBytes: Math.ceil(maxBytes * 4 / 3) + 2048});
    if (!contextBudget.allowed) throw Error('Viewing context budget exceeded; preserve checkpoint, never rewrite history');
  }
  async function patch(bytes, meta, pt, requestedSide) {
    const side = Math.max(1, Math.min(Math.round(requestedSide), meta.width, meta.height));
    const crop = {left: Math.max(0, Math.min(meta.width - side, Math.round(pt[0] - side / 2))),
      top: Math.max(0, Math.min(meta.height - side, Math.round(pt[1] - side / 2))), width: side, height: side};
    const plain = await sharp(bytes).extract(crop).flatten({background: '#eee'}).resize(96, 96).png().toBuffer();
    const x = (pt[0] - crop.left) / side * 96, y = (pt[1] - crop.top) / side * 96;
    const svg = Buffer.from(`<svg width="96" height="96"><path d="M${x-7} ${y}H${x+7}M${x} ${y-7}V${y+7}" stroke="#ff4747" stroke-width="1"/></svg>`);
    return {crop, image: await sharp(plain).composite([{input: svg}]).png().toBuffer()};
  }
  const panels = [], rows = [];
  for (let i = 0; i < chosen.length; i++) {
    const row = chosen[i];
    const [ref, gen] = await Promise.all([patch(reference, refMeta, row.target, 48), patch(generated, genMeta, row.source, 48 / p.scale)]);
    const top = 40 + i * 120;
    panels.push({input: ref.image, left: 6, top}, {input: gen.image, left: 112, top},
      {input: Buffer.from(`<svg width="265" height="96"><text x="5" y="20" font-size="12">${i+1} ${row.role} ${row.inlier?'inlier':'not-inlier'}</text><text x="5" y="42" font-size="12">residual=${row.residual.toFixed(2)}</text></svg>`), left: 214, top});
    rows.push({...row, referenceCrop: ref.crop, generatedCrop: gen.crop});
  }
  panels.push({input: Buffer.from('<svg width="480" height="35"><text x="6" y="22" font-size="13">clean reference | generated original | existing pairs</text></svg>'), left: 0, top: 0});
  const pixels = await sharp({create: {width: 480, height: 40 + chosen.length * 120, channels: 3, background: '#eee'}}).composite(panels).png().toBuffer();
  let jpeg;
  for (const quality of [92, 85, 78, 70, 60]) {
    const candidate = await sharp(pixels).jpeg({quality, chromaSubsampling: '4:4:4'}).toBuffer();
    if (candidate.length <= maxBytes) { jpeg = candidate; break; }
  }
  if (!jpeg) throw Error('Diagnostic cannot fit viewing byte budget');
  for (const [filename, bytes] of snapshots) if (!bytes.equals(await fs.readFile(filename))) throw Error('Input changed during diagnostic');
  const report = {taskId, jobId: freeze.jobId, imageId: freeze.imageId, requestId: q.id, generationId: g.id,
    kind: 'readonly-registration-pairs-not-reference-or-material', method: p.method,
    applied: a.applied, originalAccepted: p.accepted, originalReason: a.reason ?? p.reason,
    selection: 'up to three deterministic evenly spaced source-x/y-order pairs per existing fit/validation role; never selected by residual or inlier',
    sourceHash: freeze.sourceHash, referenceHash: digest(reference), generatedHash: g.hash,
    evidenceSha256: digest(proposalBytes), inputHashes: [...snapshots].map(([filename, bytes]) => ({path: filename, sha256: digest(bytes)})),
    previewPath: path.resolve(destination), previewBytes: jpeg.length, previewSha256: digest(jpeg), rows, contextBudget,
    referencesAllowed: false, productionMaterial: false, independentReview: false,
    confirmsCorrespondenceSemantics: false, altersMeasurementOrAcceptance: false, wholeGoalAccepted: false};
  await fs.mkdir(path.dirname(path.resolve(destination)), {recursive: true});
  await fs.writeFile(destination, jpeg, {flag: 'wx'});
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), {flag: 'wx'});
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [manifest, destination] = process.argv.slice(2);
  if (!manifest || !destination) throw Error('Usage: node scripts/review-registration-points.mjs <hash-bound-receipts.json> <new-diagnostic.jpg>');
  const r = await reviewRegistrationPoints(manifest, destination);
  console.log(JSON.stringify({previewPath: r.previewPath, previewBytes: r.previewBytes, rows: r.rows.length, wholeGoalAccepted: false}));
}
