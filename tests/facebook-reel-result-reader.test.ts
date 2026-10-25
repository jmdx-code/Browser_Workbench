import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFacebookReelResult } from '../src/infrastructure/facebook-reel-result-reader.js';

test('folded Reel caption is not reported expanded; expanding it retains the same author and video identity', () => {
  const names = [
    'document',
    'location',
    'innerHeight',
    'innerWidth',
    'getComputedStyle',
    'NodeFilter',
  ];
  const previous = names.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const visible = {
    getBoundingClientRect: () => ({
      width: 200,
      height: 100,
      top: 0,
      bottom: 100,
      left: 0,
      right: 200,
    }),
    closest: () => null,
  };
  const author = { ...visible, getAttribute: () => '/profile.php?id=10000000000004' };
  let folded = true;
  const button = {
    ...visible,
    get textContent() {
      return folded ? 'See more' : 'See less';
    },
  };
  const caption = { ...visible, querySelectorAll: () => [] };
  const video = { ...visible, readyState: 4, videoWidth: 640, videoHeight: 360, error: null };
  const group = {
    ...visible,
    parentElement: null,
    querySelector: () => author,
    querySelectorAll: (selector: string) => {
      if (selector.includes('heading')) return [author];
      if (selector.includes('span')) return [caption];
      if (selector.includes('button')) return [button];
      if (selector === 'video') return [video];
      return [group];
    },
  };
  const document = {
    readyState: 'complete',
    querySelectorAll: () => [group],
    createTreeWalker: () => {
      let read = false;
      return {
        nextNode: () => {
          if (read) return null;
          read = true;
          return {
            parentElement: caption,
            textContent: folded ? 'Original caption…' : 'Original caption complete',
          };
        },
      };
    },
  };
  const values = [
    document,
    { href: 'https://www.facebook.com/reel/1584031386340020' },
    800,
    1200,
    () => ({ visibility: 'visible' }),
    { SHOW_TEXT: 4 },
  ];
  try {
    names.forEach((name, index) =>
      Object.defineProperty(globalThis, name, {
        value: values[index],
        configurable: true,
        writable: true,
      }),
    );
    const initial = projectFacebookReelResult();
    assert.equal(initial.posts.length, 1);
    assert.equal(initial.posts[0]?.expanded, false);
    folded = false;
    const expanded = projectFacebookReelResult();
    assert.equal(expanded.posts[0]?.expanded, true);
    assert.equal(expanded.posts[0]?.text, 'Original caption complete');
    assert.equal(expanded.posts[0]?.accountId, initial.posts[0]?.accountId);
    assert.equal(expanded.posts[0]?.videoId, initial.posts[0]?.videoId);
    assert.equal(expanded.posts[0]?.videoReady, true);
  } finally {
    previous.forEach(([name, descriptor]) => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
