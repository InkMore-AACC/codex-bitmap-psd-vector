import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Read-only visual evidence from the complete current material. Never substitute
 * these flattened previews for its original alpha-bearing bytes. */
export async function writeIsolationPreviews(
  bytes: Buffer,
  directory: string,
  surface: 'normal' | 'screen',
) {
  const tag = crypto.randomUUID();
  const size = await sharp(bytes).metadata();
  const render = async (tone: string, color: string) => {
    const preview =
      surface === 'screen'
        ? await sharp({
            create: { width: size.width!, height: size.height!, channels: 4, background: color },
          })
            .composite([{ input: bytes, blend: 'screen' }])
            .png()
            .toBuffer()
        : await sharp(bytes).flatten({ background: color }).png().toBuffer();
    const file = path.join(directory, `isolation-${tag}-${tone}.png`);
    fs.writeFileSync(file, preview);
    return { path: file, hash: digest(preview) };
  };
  return {
    dark: await render('dark', '#101014'),
    light: await render('light', '#eeeeee'),
    surface,
    workingHash: digest(bytes),
  };
}
