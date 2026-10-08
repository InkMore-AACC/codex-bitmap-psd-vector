import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import {checkContextBudget,findCurrentHistory} from './check-context-budget.mjs';

// Viewing derivative only. Never use this JPEG as a production material or alpha proof.
export async function createReviewImage(source, destination, options = {}) {
  const maxBytes = options.maxBytes ?? 384 * 1024;
  const maxEdge = options.maxEdge ?? 1536;
  if (!Number.isInteger(maxBytes) || maxBytes < 4096 || maxBytes > 1024 * 1024)
    throw new Error('maxBytes must be 4096..1048576');
  if (!Number.isInteger(maxEdge) || maxEdge < 128 || maxEdge > 2048)
    throw new Error('maxEdge must be 128..2048');
  if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase())
    throw new Error('Preview must have a different path from the source');
  if (!/\.jpe?g$/i.test(destination)) throw new Error('Preview destination must end in .jpg or .jpeg');
  // A Codex-launched production invocation checks its real history before producing another viewing image.
  // Offline fixture tests can explicitly disable this check; no history is ever rewritten.
  let contextBudget;
  if(process.env.CODEX_THREAD_ID&&options.contextGuard!==false){
    const history=await findCurrentHistory(process.env.CODEX_THREAD_ID);
    contextBudget=await checkContextBudget(history,{taskId:process.env.CODEX_THREAD_ID,reserveBytes:Math.ceil(maxBytes*4/3)+2048});
    if(!contextBudget.allowed)throw new Error('Context viewing budget exceeded. Save a checkpoint and use official context management; do not rewrite history or retry the same oversized context.');
  }
  const input = await fs.readFile(source);
  const metadata = await sharp(input).metadata();
  const crop = options.crop;
  if (crop && (!['left', 'top', 'width', 'height'].every(k => Number.isInteger(crop[k])) ||
      crop.left < 0 || crop.top < 0 || crop.width < 1 || crop.height < 1 ||
      crop.left + crop.width > metadata.width || crop.top + crop.height > metadata.height))
    throw new Error('Crop must be an integer rectangle within the original image');
  const width = crop?.width ?? metadata.width;
  const height = crop?.height ?? metadata.height;
  const background = options.background ?? '#eeeeee';
  for (let edge = Math.min(maxEdge, Math.max(width, height)); edge >= 64; edge = Math.floor(edge * 0.8)) {
    for (const quality of [95, 90, 85, 80]) {
      let pipeline = sharp(input);
      if (crop) pipeline = pipeline.extract(crop);
      const { data, info } = await pipeline.flatten({ background })
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
      if (data.length > maxBytes) continue;
      // Fully decode before exposing a path. Exclusive write protects earlier candidates.
      await sharp(data).raw().toBuffer();
      await fs.mkdir(path.dirname(path.resolve(destination)), { recursive: true });
      await fs.writeFile(destination, data, { flag: 'wx' });
      return {
        kind: 'viewing-only-jpeg', previewPath: path.resolve(destination),
        sourcePath: path.resolve(source), sourceSha256: crypto.createHash('sha256').update(input).digest('hex'),
        sourceBytes: input.length, sourceSize: [metadata.width, metadata.height],
        sourceHasAlpha: !!metadata.hasAlpha, crop: crop ?? null, background,
        previewBytes: data.length, previewSize: [info.width, info.height], quality,
        maxBytes, maxEdge,
        contextBudget,
        warning: '仅供视觉检查；原始 PNG/PSD、透明度与像素测量均使用 sourcePath。需要细节时另取原尺寸局部。',
      };
    }
  }
  throw new Error('Cannot produce a decodable preview within the byte budget');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, destination, rawOptions] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: node scripts/review-image.mjs <source> <new-preview.jpg> [options-json]');
  console.log(JSON.stringify(await createReviewImage(source, destination, rawOptions ? JSON.parse(rawOptions) : {}), null, 2));
}
