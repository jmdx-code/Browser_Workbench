import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectFacebookStoryVideoInput } from '../src/infrastructure/facebook-story-page-reader.js';

function fixture() {
  const names = ['location', 'document'];
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const file = new File(['generated-test-video'], 'pattern.mp4', { type: 'video/mp4' });
  const input = { files: [file], isConnected: true };
  const location = {
    origin: 'https://www.facebook.com',
    pathname: '/stories/create/',
    href: 'https://www.facebook.com/stories/create/',
  };
  const document = { readyState: 'complete', querySelectorAll: () => [input] };
  for (const [name, value] of Object.entries({ location, document }))
    Object.defineProperty(globalThis, name, { value, configurable: true });
  return {
    file,
    input,
    location,
    document,
    close: () => {
      names.forEach((name, i) => {
        const descriptor = previous[i];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      });
    },
  };
}

test('video input diagnostic returns only bounded selected-file identity, not readiness or submit authority', async () => {
  const f = fixture();
  try {
    const result = await projectFacebookStoryVideoInput();
    assert.equal(result?.bytes, f.file.size);
    assert.equal(result?.sha256, createHash('sha256').update('generated-test-video').digest('hex'));
    assert.deepEqual(Object.keys(result ?? {}).sort(), ['bytes', 'sha256', 'timeOrigin', 'url']);
  } finally {
    f.close();
  }
});

test('video diagnostic rejects foreign routes, ambiguous selections and over-budget files before reading bytes', async () => {
  for (const mode of [
    'foreign',
    'route',
    'loading',
    'multiple-inputs',
    'multiple-files',
    'empty',
    'oversize',
    'image',
  ]) {
    const f = fixture();
    let reads = 0;
    Object.defineProperty(f.file, 'arrayBuffer', {
      value: async () => {
        reads++;
        return new ArrayBuffer(0);
      },
    });
    try {
      if (mode === 'foreign') f.location.origin = 'https://example.com';
      if (mode === 'route') f.location.pathname = '/';
      if (mode === 'loading') f.document.readyState = 'loading';
      if (mode === 'multiple-inputs') f.document.querySelectorAll = () => [f.input, f.input];
      if (mode === 'multiple-files') f.input.files.push(f.file);
      if (mode === 'empty') f.input.files = [];
      if (mode === 'oversize')
        Object.defineProperty(f.file, 'size', { value: 32 * 1024 * 1024 + 1 });
      if (mode === 'image') Object.defineProperty(f.file, 'type', { value: 'image/png' });
      assert.equal(await projectFacebookStoryVideoInput(), null, mode);
      assert.equal(reads, 0, mode);
    } finally {
      f.close();
    }
  }
});

test('video diagnostic cannot retain a file proof across document or selected-file changes', async () => {
  for (const mode of ['navigation', 'disconnected', 'replaced']) {
    const f = fixture();
    const buffer = await f.file.arrayBuffer();
    Object.defineProperty(f.file, 'arrayBuffer', {
      value: async () => {
        if (mode === 'navigation') f.location.href = 'https://www.facebook.com/';
        if (mode === 'disconnected') f.input.isConnected = false;
        if (mode === 'replaced')
          f.input.files = [new File(['other'], 'other.mp4', { type: 'video/mp4' })];
        return buffer;
      },
    });
    try {
      assert.equal(await projectFacebookStoryVideoInput(), null, mode);
    } finally {
      f.close();
    }
  }
});
