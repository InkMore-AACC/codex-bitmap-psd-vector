import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import sharp from 'sharp';
// @ts-ignore JavaScript command-line utility is also exported for offline testing.
import { createReviewImage } from '../scripts/review-image.mjs';

test('review derivatives are bounded, decodable, preserve the source, and never overwrite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-review-'));
  try {
    const source = path.join(dir, 'source.png');
    const preview = path.join(dir, 'preview.jpg');
    await sharp(randomBytes(1024 * 1024 * 4), { raw: { width: 1024, height: 1024, channels: 4 } }).png().toFile(source);
    const before = createHash('sha256').update(await fs.readFile(source)).digest('hex');
    const result = await createReviewImage(source, preview, { maxBytes: 65536, maxEdge: 1024, contextGuard:false });
    assert.ok(result.previewBytes <= 65536);
    assert.equal(result.sourceHasAlpha, true);
    assert.equal(result.sourceSha256, before);
    assert.equal(createHash('sha256').update(await fs.readFile(source)).digest('hex'), before);
    const decoded = await sharp(preview).raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, result.previewSize[0]);
    assert.equal(decoded.info.channels, 3);
    await assert.rejects(createReviewImage(source, source), /different path/);
    await assert.rejects(createReviewImage(source, preview,{contextGuard:false}), /EEXIST/);
    await assert.rejects(createReviewImage(source, path.join(dir, 'invalid.jpg'), { contextGuard:false,crop: { left: 1000, top: 0, width: 100, height: 10 } }), /within/);
    const crop = await createReviewImage(source, path.join(dir, 'crop.jpg'), { contextGuard:false,crop: { left: 10, top: 20, width: 128, height: 96 }, background: '#202020' });
    assert.deepEqual(crop.previewSize, [128, 96]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
