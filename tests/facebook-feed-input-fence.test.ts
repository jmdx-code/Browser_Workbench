import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  projectFacebookBrowsePage,
  projectFacebookFeedInputFence,
} from '../src/infrastructure/facebook-browse-reader.js';

test('feed content projection inspects scroll roots only under the actual center wheel target, without scanning all descendants', () => {
  const rect = () => ({ left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 });
  const main = {
    tagName: 'MAIN',
    getBoundingClientRect: rect,
    getAttribute: () => null,
    scrollHeight: 500,
    clientHeight: 500,
    scrollTop: 0,
    contains: (_el: unknown) => true,
    querySelectorAll: (selector: string) => {
      assert.notEqual(selector, '*');
      return [];
    },
  };
  const root = {
    tagName: 'DIV',
    getBoundingClientRect: rect,
    getAttribute: () => null,
    scrollHeight: 2000,
    clientHeight: 500,
    scrollTop: 80,
    parentElement: main,
  };
  const child = {
    tagName: 'DIV',
    getBoundingClientRect: rect,
    getAttribute: () => null,
    scrollHeight: 50,
    clientHeight: 50,
    scrollTop: 0,
    parentElement: root,
  };
  let styles = 0;
  const value = runInNewContext('(' + projectFacebookBrowsePage.toString() + ')()', {
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      scrollingElement: { scrollHeight: 10000, clientHeight: 720 },
      elementFromPoint: () => child,
      querySelectorAll: (selector: string) => (selector === 'main,[role="main"]' ? [main] : []),
    },
    location: { href: 'https://www.facebook.com/', pathname: '/' },
    performance: { timeOrigin: 100 },
    innerWidth: 1280,
    innerHeight: 720,
    scrollY: 0,
    getComputedStyle: (el: unknown) => {
      styles++;
      return {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        overflowY: el === root ? 'auto' : 'visible',
      };
    },
  });
  assert.equal(value.scrollY, 80);
  assert.equal(value.structure.scrollRoots.length, 1);
  assert.equal(value.structure.scrollRoots[0].top, 80);
  assert.equal(value.structure.centerHit.withinMain, true);
  assert.ok(styles <= 10);
});

test('feed input fence reads only document/main/dialog fields, never descendants, posts or players and grants no content', () => {
  const element = {
    getAttribute: (name: string) => (name === 'aria-modal' ? 'true' : null),
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 500,
      bottom: 500,
      width: 500,
      height: 500,
    }),
  };
  for (const blocked of [false, true]) {
    const queried: string[] = [];
    const value = runInNewContext('(' + projectFacebookFeedInputFence.toString() + ')()', {
      document: {
        readyState: 'complete',
        visibilityState: 'visible',
        querySelectorAll: (selector: string) => {
          queried.push(selector);
          if (selector === 'main,[role="main"]') return [element];
          if (selector === '[role="dialog"]') return blocked ? [element] : [];
          throw Error('UNEXPECTED_SEMANTIC_READ');
        },
      },
      location: { href: 'https://www.facebook.com/' },
      performance: { timeOrigin: 100 },
      innerWidth: 1280,
      innerHeight: 720,
      scrollY: 100,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    });
    assert.equal(value.ready, true);
    assert.equal(value.blocked, blocked);
    assert.equal(value.contentKey, null);
    assert.equal(value.video, null);
    assert.deepEqual(queried, ['main,[role="main"]', '[role="dialog"]']);
  }
});
