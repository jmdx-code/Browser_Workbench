import test from 'node:test';
import assert from 'node:assert/strict';
import {
  facebookBrowseNavigationSelector,
  facebookStoryNavigationSelector,
  projectFacebookBrowseNavigation,
} from '../src/infrastructure/facebook-native-browse-navigation.js';
import { facebookBrowseSurface } from '../src/shared/facebook-browse-route.js';

test('native navigation selects only observed homepage and generic video header destinations', () => {
  assert.equal(
    facebookBrowseNavigationSelector('https://www.facebook.com/'),
    '[aria-label="Facebook"] a[role="link"][href="/"]',
  );
  assert.equal(
    facebookBrowseNavigationSelector('https://www.facebook.com/reels/'),
    '[aria-label="Facebook"] a[role="link"][href="/reel/?s=tab"]',
  );
  for (const url of [
    'https://example.com/',
    'https://www.facebook.com/stories/create/',
    'https://www.facebook.com/reel/123',
    'https://www.facebook.com/reels/?x=1',
  ])
    assert.equal(facebookBrowseNavigationSelector(url), null);
  assert.equal(facebookBrowseSurface('https://www.facebook.com/reel/?s=tab'), 'video');
  for (const url of [
    'https://www.facebook.com/reel/',
    'https://www.facebook.com/reel/?s=tab&s=tab',
    'https://www.facebook.com/reel/?s=other',
    'https://www.facebook.com/reel/?s=tab#x',
  ])
    assert.equal(facebookBrowseSurface(url), null);
});

test('story entry selector is restricted to the observed homepage creation link', () => {
  assert.equal(
    facebookStoryNavigationSelector(
      'https://www.facebook.com/stories/create/',
      'https://www.facebook.com/',
    ),
    '[role="main"] a[role="link"][href="/stories/create/"]',
  );
  for (const previous of [
    'https://example.com/',
    'https://www.facebook.com/reel/123',
    'https://www.facebook.com/stories/create/',
  ])
    assert.equal(
      facebookStoryNavigationSelector('https://www.facebook.com/stories/create/', previous),
      null,
    );
  assert.equal(
    facebookStoryNavigationSelector(
      'https://www.facebook.com/marketplace/',
      'https://www.facebook.com/',
    ),
    null,
  );
});

test('native navigation projection rejects ambiguity, hidden documents, disabled links and dialogs', () => {
  const names = [
    'document',
    'location',
    'performance',
    'getComputedStyle',
    'innerWidth',
    'innerHeight',
  ];
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  let count = 1,
    disabled = false,
    dialog = false,
    hiddenAncestor = false,
    offscreen = false;
  const doc = {
    readyState: 'interactive',
    visibilityState: 'visible',
    querySelectorAll: (selector: string) =>
      selector !== 'header'
        ? [
            {
              getBoundingClientRect: () => ({
                width: dialog ? 80 : 0,
                height: dialog ? 50 : 0,
                top: 0,
                bottom: 50,
                left: 0,
                right: 80,
              }),
            },
          ]
        : Array.from({ length: count }, () => ({
            getBoundingClientRect: () => ({
              width: 80,
              height: 50,
              top: offscreen ? 1500 : 0,
              bottom: offscreen ? 1550 : 50,
              left: 0,
              right: 80,
            }),
            getAttribute: (name: string) =>
              name === 'href' ? '/reel/?s=tab' : disabled ? 'true' : null,
            hasAttribute: () => false,
            closest: () => (hiddenAncestor ? {} : null),
          })),
  };
  const values = [
    doc,
    { origin: 'https://www.facebook.com', href: 'https://www.facebook.com/' },
    { timeOrigin: 12 },
    () => ({ visibility: 'visible', display: 'block' }),
    1280,
    800,
  ];
  try {
    names.forEach((name, i) =>
      Object.defineProperty(globalThis, name, { value: values[i], configurable: true }),
    );
    assert.deepEqual(projectFacebookBrowseNavigation('header'), {
      url: 'https://www.facebook.com/',
      timeOrigin: 12,
      href: '/reel/?s=tab',
    });
    offscreen = true;
    assert.ok(
      projectFacebookBrowseNavigation('header'),
      'the native locator may scroll a visible-layout link into view',
    );
    offscreen = false;
    count = 2;
    assert.equal(projectFacebookBrowseNavigation('header'), null);
    count = 1;
    disabled = true;
    assert.equal(projectFacebookBrowseNavigation('header'), null);
    disabled = false;
    dialog = true;
    assert.equal(projectFacebookBrowseNavigation('header'), null);
    dialog = false;
    hiddenAncestor = true;
    assert.equal(projectFacebookBrowseNavigation('header'), null);
    hiddenAncestor = false;
    doc.visibilityState = 'hidden';
    assert.equal(projectFacebookBrowseNavigation('header'), null);
    doc.visibilityState = 'visible';
    doc.readyState = 'loading';
    assert.equal(projectFacebookBrowseNavigation('header'), null);
  } finally {
    names.forEach((name, i) => {
      const descriptor = previous[i];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
