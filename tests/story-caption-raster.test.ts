import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { renderStoryCaption } from '../src/infrastructure/story-caption-raster.js';

test('caption raster preserves complete Unicode, explicit newlines, readable bounds and transparent media area', async () => {
  const text = GlobalFonts.has('Myanmar Text')
    ? 'မကျော်သွားပါနဲ့ဦး။\n🧡 Test caption'
    : 'Complete caption\nTest caption';
  let checks = 0;
  const result = await renderStoryCaption(text, 720, 1280, () => {
    checks++;
  });
  assert.equal(result.textSha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(result.lines.join(''), text.replaceAll('\n', ''));
  assert.ok(result.bounds.x > 0 && result.bounds.y > 0);
  assert.ok(
    result.bounds.x + result.bounds.width < 720 && result.bounds.y + result.bounds.height < 1280,
  );
  assert.ok(checks >= 5);
  const image = await loadImage(result.png);
  const canvas = createCanvas(720, 1280),
    ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  assert.equal(ctx.getImageData(0, 0, 1, 1).data[3], 0);
  const pixels = ctx.getImageData(
    result.bounds.x,
    result.bounds.y,
    result.bounds.width,
    result.bounds.height,
  ).data;
  let light = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i]! > 180 && pixels[i + 1]! > 180 && pixels[i + 2]! > 180) light++;
  assert.ok(light > 100, 'caption has visible glyph pixels');
});

test('long tokens wrap at grapheme boundaries without losing text; oversized input and cancellation do not yield a bitmap', async () => {
  const text = 'word'.repeat(45);
  const result = await renderStoryCaption(text, 720, 1280, () => {});
  assert.equal(result.lines.join(''), text);
  assert.ok(result.lines.length > 1);
  await assert.rejects(
    renderStoryCaption('x'.repeat(2001), 720, 1280, () => {}),
    /TEXT_INVALID/,
  );
  await assert.rejects(
    renderStoryCaption('x', 100000, 1280, () => {}),
    /DIMENSIONS_INVALID/,
  );
  await assert.rejects(
    renderStoryCaption('x', 720, 1280, () => {
      throw Error('STOPPED');
    }),
    /STOPPED/,
  );
  let checks = 0;
  await assert.rejects(
    renderStoryCaption('x', 720, 1280, () => {
      if (++checks === 4) throw Error('STOPPED');
    }),
    /STOPPED/,
  );
});
