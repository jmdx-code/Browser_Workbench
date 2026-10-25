import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectFacebookDocumentIdentity } from '../extension/facebook-document-identity.js';

const sample = JSON.parse(await readFile('tests/fixtures/facebook-native-identity.json', 'utf8'));
function documentFixture(change: (entries: unknown[]) => void = () => {}, extraScripts = 0) {
  const menu = structuredClone(sample.response);
  const composer = {
    data: { viewer: { actor: { ...menu.data.viewer.actor } } },
    extensions: { is_final: true },
  };
  const entries = [
    [
      'RelayPrefetchedStreamCache',
      null,
      null,
      [
        'adp_CometSettingsDropdownTriggerQueryRelayPreloader_6acae8ae6965a8b98440513',
        { __bbox: { result: menu } },
      ],
    ],
    [
      'RelayPrefetchedStreamCache',
      null,
      null,
      [
        'adp_CometFeedInlineComposerQueryRelayPreloader_6acae8ae783877656909808',
        { __bbox: { result: composer } },
      ],
    ],
  ];
  change(entries);
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    location: { href: 'https://www.facebook.com/' },
    document: {
      readyState: 'complete',
      querySelectorAll: () => [
        {
          textContent: JSON.stringify({
            require: [['ScheduledServerJS', null, null, [{ __bbox: { require: entries } }]]],
            extra: { fb_dtsg: 'private-credential', other_profiles: ['not returned'] },
          }),
        },
        ...Array.from({ length: extraScripts }, () => ({ textContent: '{"require":[]}' })),
      ],
    },
  })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  return {
    menu,
    composer,
    close: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
test('native header reel route retains software identity without expanding bridge defaults', () => {
  const f = documentFixture();
  try {
    globalThis.location.href = 'https://www.facebook.com/reel/?s=tab';
    assert.equal(projectFacebookDocumentIdentity('browse').actor?.accountId, sample.request.av);
    assert.equal(projectFacebookDocumentIdentity('task').actor, null);
    assert.equal(projectFacebookDocumentIdentity('home').actor, null);
    globalThis.location.href += '&other=1';
    assert.equal(projectFacebookDocumentIdentity('browse').actor, null);
  } finally {
    f.close();
  }
});

test('software-owned interactive pages still require completed native identity while bridge defaults remain unchanged', () => {
  const f = documentFixture();
  try {
    Object.defineProperty(document, 'readyState', { value: 'interactive', configurable: true });
    for (const scope of ['browse', 'post-current'] as const)
      assert.equal(projectFacebookDocumentIdentity(scope).actor?.accountId, sample.request.av);
    assert.equal(projectFacebookDocumentIdentity().actor, null);
    assert.equal(projectFacebookDocumentIdentity('task').actor, null);
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    for (const scope of ['browse', 'post-current'] as const)
      assert.equal(projectFacebookDocumentIdentity(scope).actor, null);
  } finally {
    f.close();
  }
  for (const complete of [true, false]) {
    const story = storyEntries();
    if (!complete) story.rows.pop();
    const s = documentFixture((entries) => entries.splice(1, 1, ...story.rows));
    try {
      globalThis.location.href = 'https://www.facebook.com/stories/create/';
      Object.defineProperty(document, 'readyState', { value: 'interactive', configurable: true });
      assert.equal(
        projectFacebookDocumentIdentity('story').actor?.accountId ?? null,
        complete ? sample.request.av : null,
      );
    } finally {
      s.close();
    }
  }
});

test('observed two-query preload structure returns only the matching current User and no credentials', () => {
  const f = documentFixture();
  try {
    const value = projectFacebookDocumentIdentity();
    assert.equal(value.actor?.accountId, sample.request.av);
    assert.equal(value.actor?.name, 'Nway Myint');
    assert.equal(JSON.stringify(value).includes('credential'), false);
    assert.equal(JSON.stringify(value).includes('other_profiles'), false);
  } finally {
    f.close();
  }
});
test('regional Marketplace search uses the original preload identity while action and inbox routes stay excluded', () => {
  const f = documentFixture();
  try {
    const location = globalThis.location as unknown as { href: string };
    location.href =
      'https://www.facebook.com/marketplace/christchurch/search/?category_id=479353692612078&minPrice=10&maxPrice=200';
    assert.equal(projectFacebookDocumentIdentity('browse').actor?.accountId, sample.request.av);
    for (const path of [
      '/marketplace/inbox/search/',
      '/marketplace/create/search/',
      '/marketplace/you/',
    ]) {
      location.href = 'https://www.facebook.com' + path;
      assert.equal(projectFacebookDocumentIdentity('browse').actor, null);
    }
  } finally {
    f.close();
  }
});
test('actual 203-script homepage scale does not erase matched actors; excess document work still fails closed', () => {
  const actual = documentFixture(() => {}, 202);
  try {
    assert.equal(projectFacebookDocumentIdentity().actor?.accountId, sample.request.av);
  } finally {
    actual.close();
  }
  const excess = documentFixture(() => {}, 1024);
  try {
    assert.equal(projectFacebookDocumentIdentity().actor, null);
  } finally {
    excess.close();
  }
});

test('browse scope accepts the current single User menu on watch without relaxing posting composer identity', () => {
  const f = documentFixture((entries) => {
    entries.splice(1, 1);
  });
  try {
    for (const url of [
      'https://www.facebook.com/watch/',
      'https://www.facebook.com/reels/',
      'https://www.facebook.com/reel/123456?mibextid=test',
      'https://www.facebook.com/marketplace/',
      'https://www.facebook.com/marketplace/search/?query=phone',
      'https://www.facebook.com/marketplace/item/123456/',
    ]) {
      (globalThis.location as unknown as { href: string }).href = url;
      assert.equal(projectFacebookDocumentIdentity('browse').actor?.accountId, sample.request.av);
      assert.equal(projectFacebookDocumentIdentity('task').actor, null);
    }
    (globalThis.location as unknown as { href: string }).href = 'https://www.facebook.com/';
    assert.equal(projectFacebookDocumentIdentity('task').actor, null);
    // Software's current-post reader separately checks the unique rendered creator.
    assert.equal(
      projectFacebookDocumentIdentity('post-current').actor?.accountId,
      sample.request.av,
    );
  } finally {
    f.close();
  }
});

test('current-post projection accepts a retained home document, but rejects conflicting or duplicate native records', () => {
  for (const mode of ['conflict', 'duplicate-menu', 'duplicate-composer', 'partial'] as const) {
    const f = documentFixture((entries) => {
      if (mode === 'duplicate-menu') entries.push(structuredClone(entries[0]));
      else if (mode === 'duplicate-composer') entries.push(structuredClone(entries[1]));
      else {
        const entry = entries[1] as [
          unknown,
          unknown,
          unknown,
          [
            string,
            {
              __bbox: {
                result: {
                  data: { viewer: { actor: { id: string } } };
                  extensions: { is_final: boolean };
                };
              };
            },
          ],
        ];
        if (mode === 'conflict') entry[3][1].__bbox.result.data.viewer.actor.id = '99';
        else entry[3][1].__bbox.result.extensions.is_final = false;
      }
    });
    try {
      assert.equal(projectFacebookDocumentIdentity('post-current').actor, null);
    } finally {
      f.close();
    }
  }
});
test('preloaded partial, errored, additional or conflicting actors and duplicate queries never grant identity', () => {
  for (const mutation of [
    (f: ReturnType<typeof documentFixture>) => {
      f.menu.extensions.is_final = false;
    },
    (f: ReturnType<typeof documentFixture>) => {
      f.menu.errors = [];
    },
    (f: ReturnType<typeof documentFixture>) => {
      f.menu.data.viewer.is_lar_acting_as_additional_profile = true;
    },
    (f: ReturnType<typeof documentFixture>) => {
      f.composer.data.viewer.actor.id = '99';
    },
    (f: ReturnType<typeof documentFixture>) => {
      f.composer.data.viewer.actor.name = 'Other';
    },
  ]) {
    const f = documentFixture();
    // Rebuild the simulated DOM string after mutating selected response objects.
    mutation(f);
    try {
      assert.equal(projectFacebookDocumentIdentity().actor, null);
    } finally {
      f.close();
    }
  }
  const f = documentFixture((entries) => {
    entries.push(entries[0]);
  });
  try {
    assert.equal(projectFacebookDocumentIdentity().actor, null);
  } finally {
    f.close();
  }
});

function storyEntries() {
  const key = 'adp_StoriesCreateQueryRelayPreloader_6ad00611e2c616d04849277';
  const record = (result: unknown, name = key) => [
    'RelayPrefetchedStreamCache',
    null,
    null,
    [name, { __bbox: { result } }],
  ];
  const first = {
    data: {
      viewer: {
        actor: { ...sample.response.data.viewer.actor, is_additional_profile_plus: false },
      },
    },
    extensions: { is_final: false },
  };
  const patch = {
    data: { visual_composer_satp_collections: [] },
    path: [],
    extensions: { is_final: false },
  };
  const final = {
    data: { viewer: { inspirations_data: [] } },
    path: [],
    extensions: { is_final: true },
  };
  return { first, patch, final, rows: [record(first), record(patch), record(final)], record };
}

test('observed suspense story creator requires completed matching me/actor/menu and a unique visible creation shell', () => {
  for (const scenario of [
    'valid',
    'wrong-actor',
    'wrong-me',
    'partial',
    'duplicate',
    'missing-form',
    'hidden-preview',
    'viewer-route',
    'old-partial',
  ] as const) {
    const actor = { __typename: 'User', id: sample.request.av };
    const result = {
      data: { viewer: { actor: { ...actor } }, me: { ...actor } },
      extensions: { is_final: true },
    };
    if (scenario === 'wrong-actor') result.data.viewer.actor.id = '99';
    if (scenario === 'wrong-me') result.data.me.id = '99';
    if (scenario === 'partial') result.extensions.is_final = false;
    const entry = [
      'RelayPrefetchedStreamCache@037d140c04ccad31c88ad955e7861879',
      null,
      null,
      [
        'adp_StoriesSuspenseNavigationPaneRootWithEntryPointQueryRelayPreloader_6ad0cd773ad337d13519451',
        { __bbox: { result } },
      ],
    ];
    const f = documentFixture((entries) => {
      entries.splice(1, 1, entry);
      if (scenario === 'duplicate') entries.push(structuredClone(entry));
      if (scenario === 'old-partial') entries.push(storyEntries().rows[0]!);
    });
    const originalQuery = document.querySelectorAll;
    const originalStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
    try {
      globalThis.location.href =
        scenario === 'viewer-route'
          ? 'https://www.facebook.com/stories/123/456/'
          : 'https://www.facebook.com/stories/create';
      const element = (text: string, hidden = false) => ({
        textContent: text,
        getBoundingClientRect: () => ({ width: hidden ? 0 : 100, height: 100 }),
      });
      Object.defineProperty(document, 'querySelectorAll', {
        configurable: true,
        value: (selector: string) =>
          selector.startsWith('script[')
            ? originalQuery('script[type="application/json"][data-sjs]')
            : selector.includes('Stories Creation Form')
              ? scenario === 'missing-form'
                ? []
                : [element(sample.response.data.viewer.actor.name)]
              : selector.includes('Stories Creation Preview')
                ? [element('', scenario === 'hidden-preview')]
                : [],
      });
      Object.defineProperty(globalThis, 'getComputedStyle', {
        configurable: true,
        value: () => ({ display: 'block', visibility: 'visible' }),
      });
      assert.equal(
        projectFacebookDocumentIdentity('story').actor?.accountId ?? null,
        scenario === 'valid' ? sample.request.av : null,
        scenario,
      );
    } finally {
      if (originalStyle) Object.defineProperty(globalThis, 'getComputedStyle', originalStyle);
      else Reflect.deleteProperty(globalThis, 'getComputedStyle');
      f.close();
    }
  }
});

test('story scope requires one completed creator stream matching the native selected actor; other scopes stay closed', () => {
  const story = storyEntries();
  const f = documentFixture((entries) => entries.splice(1, 1, ...story.rows));
  try {
    globalThis.location.href = 'https://www.facebook.com/stories/create/';
    assert.equal(projectFacebookDocumentIdentity('story').actor?.accountId, sample.request.av);
    for (const scope of ['home', 'task', 'browse'] as const)
      assert.equal(projectFacebookDocumentIdentity(scope).actor, null);
    globalThis.location.href = 'https://www.facebook.com/';
    assert.equal(projectFacebookDocumentIdentity('story').actor, null);
  } finally {
    f.close();
  }
});

test('software story reads accept observed versioned Relay module names without ignoring late conflicts', () => {
  for (const conflict of [false, true]) {
    const story = storyEntries();
    const f = documentFixture((entries) => {
      entries.splice(1, 1, ...story.rows);
      for (const row of entries as unknown[][])
        row[0] = 'RelayPrefetchedStreamCache@45aabeb6562624847421d6f4ae4605c5';
      if (conflict) entries.push(structuredClone(entries[0]));
    });
    try {
      globalThis.location.href = 'https://www.facebook.com/stories/create/';
      assert.equal(
        projectFacebookDocumentIdentity('story').actor?.accountId ?? null,
        conflict ? null : sample.request.av,
      );
      globalThis.location.href = 'https://www.facebook.com/';
      assert.equal(projectFacebookDocumentIdentity('home').actor, null);
    } finally {
      f.close();
    }
  }
});

test('story stream rejects incomplete, cross-key, duplicate, errored or conflicting creator records', () => {
  const mutations: ((s: ReturnType<typeof storyEntries>) => void)[] = [
    (s) => {
      s.rows.pop();
    },
    (s) => {
      s.first.data.viewer.actor.id = '99';
    },
    (s) => {
      s.first.data.viewer.actor.is_additional_profile_plus = true;
    },
    (s) => {
      s.rows.push(s.rows[2]!);
    },
    (s) => {
      s.rows[1] = s.rows[0]!;
    },
    (s) => {
      s.rows[2] = s.record(s.final, 'adp_StoriesCreateQueryRelayPreloader_aaaaaaaaaaaaaaaa');
    },
    (s) => {
      s.rows[2] = s.record({ ...s.final, errors: [] });
    },
    (s) => {
      s.rows[2] = s.record({ ...s.final, path: ['viewer'] });
    },
    (s) => {
      s.rows[2] = s.record({ ...s.final, data: s.first.data });
    },
    (s) => {
      s.rows.splice(1, 0, ...Array.from({ length: 8 }, () => s.rows[1]!));
    },
  ];
  for (const mutate of mutations) {
    const story = storyEntries();
    mutate(story);
    const f = documentFixture((entries) => entries.splice(1, 1, ...story.rows));
    try {
      globalThis.location.href = 'https://www.facebook.com/stories/create/';
      assert.equal(projectFacebookDocumentIdentity('story').actor, null);
    } finally {
      f.close();
    }
  }
});
