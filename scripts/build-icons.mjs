import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Original vector is the single source for app, installer and UI previews.
const source = await loadImage(await readFile('public/app-icon.svg'));
await mkdir('build', { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const size of [...sizes, 512]) {
  const canvas = createCanvas(size, size);
  canvas.getContext('2d').drawImage(source, 0, 0, size, size);
  const png = canvas.toBuffer('image/png');
  if (size === 512) await writeFile('public/app-icon.png', png);
  else {
    images.push(png);
    if ([16, 32, 48, 128].includes(size)) await writeFile(`build/icon-${size}.png`, png);
  }
}
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((png, index) => {
  const entry = 6 + index * 16;
  const size = sizes[index];
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
await writeFile('build/icon.ico', Buffer.concat([header, ...images]));
console.log('Original app icons generated (16–512px).');
