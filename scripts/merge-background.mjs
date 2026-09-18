import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
const [visible,generated,output]=process.argv.slice(2);
if(!visible||!generated||!output)throw new Error('Usage: node scripts/merge-background.mjs original-visible-background.png generated-full-background.png output.png');
if(path.resolve(output)===path.resolve(visible)||path.resolve(output)===path.resolve(generated)||fs.existsSync(output))throw new Error('Output must be a new file');
const meta=await sharp(visible).metadata();
await sharp(generated).resize(meta.width,meta.height).composite([{input:visible}]).png().toFile(output);
console.log(JSON.stringify({path:path.resolve(output),width:meta.width,height:meta.height,method:'original-visible-pixels-over-generated-occlusion-fill'}));
