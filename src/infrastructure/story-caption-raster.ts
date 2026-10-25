import type { Awaitable } from '../domain/persistence.js';
import { createHash } from 'node:crypto';

const families =
  '"Segoe UI", "Helvetica Neue", "Noto Sans", "Myanmar Text", "Myanmar MN", "Noto Sans Myanmar", "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface StoryCaptionRaster {
  rendererVersion: 1;
  textSha256: string;
  png: Buffer;
  width: number;
  height: number;
  fontSize: number;
  lines: string[];
  bounds: { x: number; y: number; width: number; height: number };
}

// A derived-media input only. It never edits a source file or grants upload/publication authority.
export async function renderStoryCaption(
  text: string,
  width: number,
  height: number,
  assertCurrent: () => Awaitable<void>,
): Promise<StoryCaptionRaster> {
  await assertCurrent();
  if (!text.trim() || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
    throw Error('STORY_CAPTION_TEXT_INVALID');
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 240 ||
    height < 240 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 12_000_000
  )
    throw Error('STORY_CAPTION_DIMENSIONS_INVALID');
  const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');
  await assertCurrent();
  if (
    /[\u1000-\u109f\ua9e0-\ua9ff\uaa60-\uaa7f]/.test(text) &&
    !['Myanmar Text', 'Myanmar MN', 'Noto Sans Myanmar'].some((family) => GlobalFonts.has(family))
  )
    throw Error('STORY_CAPTION_MYANMAR_FONT_UNAVAILABLE');
  const canvas = createCanvas(width, height),
    ctx = canvas.getContext('2d');
  const margin = Math.ceil(width * 0.06),
    padding = Math.ceil(width * 0.025);
  const maxWidth = width - 2 * (margin + padding);
  let layout: { size: number; lines: string[]; lineHeight: number } | undefined;
  for (const base of [44, 40, 36, 32, 28]) {
    await assertCurrent();
    const size = Math.max(12, Math.round((base * width) / 720));
    ctx.font = `${size}px ${families}`;
    const lines: string[] = [];
    for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
      let line = '';
      for (const word of words.segment(paragraph)) {
        if (ctx.measureText(line + word.segment).width <= maxWidth) {
          line += word.segment;
          continue;
        }
        if (line) {
          lines.push(line);
          line = '';
        }
        if (ctx.measureText(word.segment).width <= maxWidth) {
          line = word.segment;
          continue;
        }
        for (const grapheme of graphemes.segment(word.segment)) {
          if (ctx.measureText(grapheme.segment).width > maxWidth)
            throw Error('STORY_CAPTION_GLYPH_TOO_WIDE');
          if (line && ctx.measureText(line + grapheme.segment).width > maxWidth) {
            lines.push(line);
            line = '';
          }
          line += grapheme.segment;
        }
      }
      lines.push(line);
    }
    const lineHeight = Math.ceil(size * 1.7);
    if (lines.length * lineHeight + padding * 2 <= height * 0.45) {
      layout = { size, lines, lineHeight };
      break;
    }
  }
  if (!layout) throw Error('STORY_CAPTION_DOES_NOT_FIT');
  const boxHeight = layout.lines.length * layout.lineHeight + padding * 2;
  const bounds = {
    x: margin,
    y: Math.floor(height * 0.78 - boxHeight),
    width: width - margin * 2,
    height: boxHeight,
  };
  if (bounds.y < margin) throw Error('STORY_CAPTION_DOES_NOT_FIT');
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [i, line] of layout.lines.entries()) {
    await assertCurrent();
    ctx.fillText(line, width / 2, bounds.y + padding + (i + 0.5) * layout.lineHeight);
  }
  await assertCurrent();
  const png = await canvas.encode('png');
  await assertCurrent();
  if (png.length > 8 * 1024 * 1024) throw Error('STORY_CAPTION_BITMAP_BUDGET');
  return {
    rendererVersion: 1,
    textSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    png,
    width,
    height,
    fontSize: layout.size,
    lines: layout.lines,
    bounds,
  };
}
