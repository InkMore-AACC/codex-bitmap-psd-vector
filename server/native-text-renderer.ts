import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { nativeTextRecipeSchema, nativeTextInkQuad, type NativeTextRecipe } from '../shared/native-text.js';
import { GENERATION_PIXEL_BUDGET } from '../shared/generation-geometry.js';

export const NATIVE_TEXT_ALGORITHM = 'native-solid-glyphs-v1';
export const NATIVE_TEXT_PLANE_ALGORITHM = 'native-planar-solid-glyphs-v2';
type Frame = { x: number; y: number; width: number; height: number };
const digest = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
export const nativeTextSignature = (value: unknown) => digest(Buffer.from(JSON.stringify(value)));

// Hold font bytes for the lifetime of the native typeface (some library versions
// retain the input Buffer). Alias by file hash so system-family names cannot win.
const fonts = new Map<string, { bytes: Buffer; alias: string }>();

function nativeTypeface(s: NativeTextRecipe['spans'][number]) {
  let font = fonts.get(s.fontHash);
  if (!font) {
    font = { bytes: fs.readFileSync(s.fontPath), alias: 'LCNative_' + s.fontHash };
    if (digest(font.bytes) !== s.fontHash || !GlobalFonts.register(font.bytes, font.alias))
      throw new Error('实际字体加载失败');
    fonts.set(s.fontHash, font);
  }
  return font;
}

/** Measure in an untransformed native context, independent of diagnostic carrier allocation. */
export function measureNativeTextSpan(span: NativeTextRecipe['spans'][number]) {
  validateNativeTextRecipe({ version: 1, observation: '只读字体诊断，真实字体在源像素比例度量', spans: [span] },
    { x: 0, y: 0, width: 30000, height: 30000 });
  const ctx = createCanvas(1, 1).getContext('2d');
  ctx.font = `${span.fontSize}px "${nativeTypeface(span).alias}"`;
  const m = ctx.measureText(span.text), width = m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
    height = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  if (![width, height].every(n => Number.isFinite(n) && n > 0)) throw new Error('实际字体缺少可见墨迹度量');
  return { width, height };
}

/** Unicode SFNT cmap 4/12. Refuse unsupported containers rather than using fallback. */
export function fontHasCodePoint(bytes: Buffer, code: number): boolean {
  const check = (start: number, size: number) => {
    if (!Number.isSafeInteger(start) || start < 0 || start + size > bytes.length)
      throw new Error('字体cmap边界无效');
  };
  check(0, 12);
  if (![0x00010000, 0x4f54544f].includes(bytes.readUInt32BE(0)))
    throw new Error('当前原生文字仅支持单字体TTF/OTF，不支持TTC/WOFF或隐式字体替代');
  const count = bytes.readUInt16BE(4); check(12, count * 16);
  let offset = -1, length = 0;
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16;
    if (['COLR', 'CPAL', 'CBDT', 'CBLC', 'sbix', 'SVG '].includes(bytes.toString('ascii', p, p + 4)))
      throw new Error('当前实心单色文字不支持彩色/位图/SVG字形字体');
    if (bytes.toString('ascii', p, p + 4) === 'cmap') {
      offset = bytes.readUInt32BE(p + 8); length = bytes.readUInt32BE(p + 12);
    }
  }
  if (offset < 0) throw new Error('字体缺少Unicode cmap');
  check(offset, length); if (length < 4) throw new Error('字体cmap截断');
  const table = bytes.subarray(offset, offset + length);
  const inTable = (p: number, n: number) => {
    if (p < 0 || p + n > table.length) throw new Error('字体cmap子表越界');
  };
  const n = table.readUInt16BE(2); inTable(4, n * 8);
  const maps: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = 4 + i * 8, platform = table.readUInt16BE(p), encoding = table.readUInt16BE(p + 2);
    if (platform === 0 || platform === 3 && [1, 10].includes(encoding)) maps.push(table.readUInt32BE(p + 4));
  }
  // Prefer a complete Unicode mapping. A mapped .notdef glyph is missing.
  for (const format of [12, 4]) for (const start of maps) {
    inTable(start, 2); if (table.readUInt16BE(start) !== format) continue;
    inTable(start, format === 12 ? 16 : 14);
    const len = format === 12 ? table.readUInt32BE(start + 4) : table.readUInt16BE(start + 2);
    inTable(start, len); const t = table.subarray(start, start + len);
    if (format === 12) {
      const groups = t.readUInt32BE(12);
      if (16 + groups * 12 > len) throw new Error('字体cmap12组截断');
      for (let i = 0; i < groups; i++) {
        const p = 16 + i * 12, first = t.readUInt32BE(p), last = t.readUInt32BE(p + 4);
        if (code >= first && code <= last) return t.readUInt32BE(p + 8) + code - first !== 0;
      }
      return false;
    }
    if (code > 0xffff) continue;
    const segments = t.readUInt16BE(6) / 2;
    if (!Number.isInteger(segments) || 16 + segments * 8 > len) throw new Error('字体cmap4分段截断');
    const starts = 16 + segments * 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
    for (let i = 0; i < segments; i++) {
      if (code > t.readUInt16BE(14 + i * 2) || code < t.readUInt16BE(starts + i * 2)) continue;
      const delta = t.readInt16BE(deltas + i * 2), range = t.readUInt16BE(ranges + i * 2);
      if (!range) return (code + delta & 0xffff) !== 0;
      const p = ranges + i * 2 + range + (code - t.readUInt16BE(starts + i * 2)) * 2;
      if (p < 0 || p + 2 > len) throw new Error('字体cmap4字形截断');
      const glyph = t.readUInt16BE(p); return glyph !== 0 && (glyph + delta & 0xffff) !== 0;
    }
    return false;
  }
  return false;
}

export function validateNativeTextRecipe(recipe: NativeTextRecipe, frame: Frame) {
  nativeTextRecipeSchema.parse(recipe);
  for (const s of recipe.spans) {
    if (nativeTextInkQuad(recipe, s.box).some(([x,y]) => !Number.isFinite(x) || !Number.isFinite(y) ||
        x < frame.x || y < frame.y || x > frame.x + frame.width || y > frame.y + frame.height))
      throw new Error('原生字形观察框须完整属于本层冻结画幅');
    if (!path.isAbsolute(s.fontPath) || !/\.(ttf|otf)$/i.test(s.fontPath))
      throw new Error('原生文字须提供实际TTF/OTF绝对路径');
    const b = fs.readFileSync(s.fontPath);
    if (digest(b) !== s.fontHash) throw new Error('字体文件已变化，与冻结字体摘要不符');
    for (const ch of new Set([...s.text])) if (!fontHasCodePoint(b, ch.codePointAt(0)!))
      throw new Error(`冻结字体缺少字形U+${ch.codePointAt(0)!.toString(16)}，不能静默替代`);
  }
}

/** Transparent full carrier, filled glyphs, one uniform transform; never reads source pixels. */
export function renderNativeText(recipe: NativeTextRecipe, frame: Frame, size: { width: number; height: number }) {
  if (![size.width, size.height].every(n => Number.isSafeInteger(n) && n > 0) ||
      size.width * size.height > GENERATION_PIXEL_BUDGET)
    throw new Error('原生文字完整承载超过150万工作像素预算');
  validateNativeTextRecipe(recipe, frame);
  const canvas = createCanvas(size.width, size.height), ctx = canvas.getContext('2d');
  const scale = Math.min(size.width / frame.width, size.height / frame.height);
  const marginX = (size.width - frame.width * scale) / 2, marginY = (size.height - frame.height * scale) / 2;
  ctx.translate(marginX - frame.x * scale, marginY - frame.y * scale); ctx.scale(scale, scale);
  if (recipe.version === 2) ctx.transform(...recipe.transform);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const measured: { text: string; fontHash: string; fontSize: number; color: string; inkBox: Frame;
    localInkBox?: Frame; inkQuad?: [number,number][] }[] = [];
  for (const s of recipe.spans) {
    const font = nativeTypeface(s);
    ctx.font = `${s.fontSize}px "${font.alias}"`; ctx.fillStyle = s.color;
    const m = ctx.measureText(s.text), w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
      h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    if (![w, h].every(n => Number.isFinite(n) && n > 0) || w > s.box.width + 0.01 || h > s.box.height + 0.01)
      throw new Error('实际字形超出观察框；须修正新计划字体或字号，不能裁切/拉伸字形');
    // Anchor visible ink, preserving actual internal spacing and solid fill.
    ctx.fillText(s.text, s.box.x + m.actualBoundingBoxLeft, s.box.y + m.actualBoundingBoxAscent);
    const localInkBox = { x: s.box.x, y: s.box.y, width: w, height: h }, inkQuad = nativeTextInkQuad(recipe, localInkBox);
    const xs = inkQuad.map(p=>p[0]), ys = inkQuad.map(p=>p[1]);
    measured.push({ text: s.text, fontHash: s.fontHash, fontSize: s.fontSize, color: s.color,
      inkBox: recipe.version === 1 ? localInkBox : {x:Math.min(...xs),y:Math.min(...ys),
        width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)},
      ...(recipe.version === 2 ? {localInkBox,inkQuad} : {}) });
  }
  const bytes = canvas.toBuffer('image/png');
  return { bytes, proof: { algorithm: recipe.version === 2 ? NATIVE_TEXT_PLANE_ALGORITHM : NATIVE_TEXT_ALGORITHM,
    ...(recipe.version === 2 ? {transform:recipe.transform} : {}), recipeHash: nativeTextSignature(recipe),
    outputHash: digest(bytes), size, frame, scale, marginX, marginY, measured,
    note: '实际字体填充渲染，工作结果为位图文字；内容/字体与源一致性须另行审查，非image_gen或可编辑PS文字。' } };
}
export type NativeTextRenderProof = ReturnType<typeof renderNativeText>['proof'];
