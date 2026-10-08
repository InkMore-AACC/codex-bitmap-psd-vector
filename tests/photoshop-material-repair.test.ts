import test from 'node:test';
import assert from 'node:assert/strict';
import {
  axisAlignedRepairFrame,
  replaceLocalMaterialRgba,
} from '../server/photoshop-material-repair.js';

const frame = { x: 0, y: 0, width: 1, height: 1 };
const image = (data: number[], width = 1, height = 1) => ({
  width,
  height,
  data: Uint8Array.from(data),
});

test('core replacement clears stale alpha through a transparent patch hole', () => {
  const r = replaceLocalMaterialRgba({
    base: image([90, 80, 70, 180]),
    patch: image([200, 10, 0, 0]),
    baseFrame: frame,
    patchFrame: frame,
    mask: Uint8Array.of(255),
  });
  assert.deepEqual([...r.image.data], [0, 0, 0, 0]);
  assert.equal(r.stats.alphaDecreasedPixels, 1);
});

test('feather interpolates premultiplied RGBA instead of accumulating old alpha', () => {
  const r = replaceLocalMaterialRgba({
    base: image([255, 0, 0, 255]),
    patch: image([0, 0, 255, 0]),
    baseFrame: frame,
    patchFrame: frame,
    mask: Uint8Array.of(128),
  });
  assert.deepEqual([...r.image.data], [255, 0, 0, 127]);
  const sameAlpha = replaceLocalMaterialRgba({
    base: image([255, 0, 0, 128]),
    patch: image([0, 0, 255, 128]),
    baseFrame: frame,
    patchFrame: frame,
    mask: Uint8Array.of(128),
  });
  assert.deepEqual([...sameAlpha.image.data], [127, 0, 128, 128]);
});

test('document coordinates preserve the entire carrier and every channel outside the mask', () => {
  const base = image([1, 2, 3, 0, 90, 80, 70, 200, 4, 5, 6, 40], 3);
  const r = replaceLocalMaterialRgba({
    base,
    patch: image([20, 30, 40, 80]),
    baseFrame: { x: 10, y: 20, width: 3, height: 1 },
    patchFrame: { x: 11, y: 20, width: 1, height: 1 },
    mask: Uint8Array.of(0, 255, 0),
  });
  assert.equal(r.image.width, 3);
  assert.deepEqual([...r.image.data], [1, 2, 3, 0, 20, 30, 40, 80, 4, 5, 6, 40]);
  assert.deepEqual([...base.data], [1, 2, 3, 0, 90, 80, 70, 200, 4, 5, 6, 40]);
});

test('bilinear resampling excludes RGB hidden in transparent patch pixels', () => {
  const r = replaceLocalMaterialRgba({
    base: image([0, 0, 0, 0]),
    patch: image([255, 0, 0, 0, 0, 0, 255, 255], 2),
    baseFrame: { ...frame, width: 2 },
    patchFrame: { ...frame, width: 2 },
    mask: Uint8Array.of(255),
  });
  assert.deepEqual([...r.image.data], [0, 0, 255, 128]);
});

test('unprovided patch area cannot be silently erased by a repair mask', () => {
  assert.throws(
    () =>
      replaceLocalMaterialRgba({
        base: image([1, 2, 3, 255]),
        patch: image([4, 5, 6, 255]),
        baseFrame: frame,
        patchFrame: { ...frame, x: 4 },
        mask: Uint8Array.of(255),
      }),
    /outside.*patch carrier/,
  );
});

test('requires a verified full-file axis-aligned quad and rejects transforms requiring guesses', () => {
  assert.deepEqual(axisAlignedRepairFrame([45, 228, 895, 228, 895, 1348, 45, 1348]), {
    x: 45,
    y: 228,
    width: 850,
    height: 1120,
  });
  assert.throws(() => axisAlignedRepairFrame([0, 0, 4, 1, 3, 5, -1, 4]), /axis-aligned/);
  assert.throws(() => axisAlignedRepairFrame([0, 0, 4, 0, 3, 4, 0, 4]), /axis-aligned/);
  assert.throws(() => axisAlignedRepairFrame([0, 0, 0, 0, 0, 1, 0, 1]), /Invalid/);
});

test('rejects incomplete carriers, oversized work images and masks of the wrong size', () => {
  const valid = {
    base: image([0, 0, 0, 0]),
    patch: image([0, 0, 0, 0]),
    baseFrame: frame,
    patchFrame: frame,
    mask: Uint8Array.of(255),
  };
  assert.throws(() => replaceLocalMaterialRgba({ ...valid, base: image([0], 1) }), /complete RGBA/);
  assert.throws(() => replaceLocalMaterialRgba({ ...valid, base: image([], 1500001) }), /budget/);
  assert.throws(
    () => replaceLocalMaterialRgba({ ...valid, mask: new Uint8Array(0) }),
    /full base carrier/,
  );
});
