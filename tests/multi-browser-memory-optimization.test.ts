// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { projectFacebookDocumentIdentity } from '../src/shared/facebook-document-identity.js';
import { projectGroupInvitationState } from '../src/infrastructure/group-inviter-effects.js';
import {
  projectFacebookBrowsePage,
  projectFacebookFeedInputFence,
} from '../src/infrastructure/facebook-browse-reader.js';
import { projectFacebookStoryPage } from '../src/infrastructure/facebook-story-page-reader.js';
import { projectFacebookBackground } from '../src/infrastructure/facebook-background-reader.js';
import { projectFacebookComposerAudience } from '../src/infrastructure/facebook-composer-audience.js';

type Row = unknown[];
const accountId = '10000000000001';
const actor = (id = accountId) => ({ __typename: 'User', id, name: 'Example User' });
const query = (name: string, result: unknown, alias = false): Row => [
  alias ? 'RelayPrefetchedStreamCache@' + 'b'.repeat(32) : 'RelayPrefetchedStreamCache',
  null,
  null,
  [`adp_${name}QueryRelayPreloader_${'a'.repeat(20)}`, { __bbox: { result } }],
];
const identityRows = (id = accountId): Row[] => [
  query('CometSettingsDropdownTrigger', {
    data: { viewer: { actor: actor(id), is_lar_acting_as_additional_profile: false } },
    extensions: { is_final: true },
  }),
  query('CometFeedInlineComposer', {
    data: { viewer: { actor: actor(id) } },
    extensions: { is_final: true },
  }),
];
function script(rows: unknown[], extra: Record<string, unknown> = {}) {
  const node = document.createElement('script');
  node.type = 'application/json';
  node.dataset.sjs = '';
  node.textContent = JSON.stringify({
    require: [['ScheduledServerJS', null, null, [{ __bbox: { require: rows } }]]],
    ...extra,
  });
  document.body.append(node);
  return node;
}
function route(path: string) {
  vi.stubGlobal('location', new URL('https://www.facebook.com' + path));
}
function box(el: Element, x = 0, y = 0, width = 600, height = 400) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({}),
  });
  (el as HTMLElement).style.cssText += ';display:block;visibility:visible;opacity:1;';
}
const baselineSource = execFileSync(
  'git',
  ['show', 'HEAD:src/shared/facebook-document-identity.ts'],
  { encoding: 'utf8' },
);
const exported: Record<string, unknown> = {};
new Function(
  'exports',
  ts.transpileModule(baselineSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)(exported);
const baseline = exported.projectFacebookDocumentIdentity as typeof projectFacebookDocumentIdentity;
const result = (
  fn: typeof projectFacebookDocumentIdentity,
  scope: Parameters<typeof fn>[0] = 'home',
) => fn(scope).actor?.accountId ?? null;

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.cookie = 'c_user=; Max-Age=0; path=/';
  for (const key of ['__wbIdentityScriptsV1', '__wbReactRootNodesV1', '__wbInvitationScriptUserV1'])
    Reflect.deleteProperty(window, key);
  route('/');
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('scrollY', 0);
  vi.spyOn(Date, 'now').mockReturnValue(1793000000000);
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  if (!document.elementFromPoint)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => document.querySelector('main'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('lightweight per-script identity summaries retain the original decision', () => {
  it('hits WeakMap without encoding or parsing again, and stores no body, tokens or unrelated profiles', () => {
    const node = script(identityRows(), {
      privateToken: 'private-value-not-cached',
      large: { unrelatedProfiles: ['not-an-actor'] },
    });
    const parse = vi.spyOn(JSON, 'parse'),
      encode = vi.spyOn(TextEncoder.prototype, 'encode');
    expect(result(projectFacebookDocumentIdentity)).toBe(accountId);
    const parses = parse.mock.calls.length,
      encodes = encode.mock.calls.length;
    expect(result(projectFacebookDocumentIdentity)).toBe(accountId);
    expect(parse.mock.calls.length).toBe(parses);
    expect(encode.mock.calls.length).toBe(encodes);
    const cache = Reflect.get(window, '__wbIdentityScriptsV1') as WeakMap<Element, unknown>;
    expect(cache).toBeInstanceOf(WeakMap);
    const summary = JSON.stringify(cache.get(node));
    expect(summary.length).toBeLessThan(1500);
    expect(summary).not.toContain('private-value-not-cached');
    expect(summary).not.toContain('unrelatedProfiles');
    expect(summary).not.toContain('require');
  });
  it('still enumerates live nodes and rejects an inserted late conflict even after the original node is cached', () => {
    const first = script(identityRows());
    expect(result(projectFacebookDocumentIdentity)).toBe(accountId);
    const conflict = script([identityRows('10000000000002')[0]]);
    expect(result(projectFacebookDocumentIdentity)).toBeNull();
    expect(result(baseline)).toBeNull();
    conflict.remove();
    expect(result(projectFacebookDocumentIdentity)).toBe(accountId);
    first.remove();
    expect(result(projectFacebookDocumentIdentity)).toBeNull();
  });
  it('handles node replacement and does not reuse another script node summary', () => {
    const first = script(identityRows());
    expect(result(projectFacebookDocumentIdentity)).toBe(accountId);
    first.replaceWith(script(identityRows('10000000000002')));
    expect(result(projectFacebookDocumentIdentity)).toBe('10000000000002');
  });
  it('does not cache a scope-specific verdict: hashed aliases and conflicts obey the original scope gate', () => {
    const rows = identityRows();
    rows[0]![0] = 'RelayPrefetchedStreamCache@' + 'b'.repeat(32);
    script(rows);
    expect(result(projectFacebookDocumentIdentity, 'browse')).toBe(accountId);
    expect(result(projectFacebookDocumentIdentity, 'home')).toBeNull();
    expect(result(projectFacebookDocumentIdentity, 'task')).toBe(accountId);
    expect(result(baseline, 'home')).toBeNull();
    expect(result(baseline, 'task')).toBe(accountId);
  });
  it.each([
    'duplicate',
    'wrongActor',
    'errors',
    'unfinished',
    'additional',
    'invalidId',
    'invalidName',
    'tooManyModules',
    'tooManyScripts',
    'tooLargeIdentity',
    'tooManyBytes',
  ] as const)('matches the old fail-closed result for %s, including on cache hits', (kind) => {
    const rows = identityRows();
    if (kind === 'duplicate') rows.push(...identityRows());
    if (kind === 'wrongActor') rows.push(identityRows('10000000000002')[1]!);
    const payload = (rows[0]![3] as unknown[])[1] as {
      __bbox: { result: Record<string, unknown> };
    };
    const value = payload.__bbox.result;
    if (kind === 'errors') value.errors = [];
    if (kind === 'unfinished') value.extensions = { is_final: false };
    if (kind === 'additional')
      value.data = { viewer: { actor: actor(), is_lar_acting_as_additional_profile: true } };
    if (kind === 'invalidId')
      value.data = {
        viewer: { actor: actor('wrong'), is_lar_acting_as_additional_profile: false },
      };
    if (kind === 'invalidName')
      value.data = {
        viewer: { actor: { ...actor(), name: '' }, is_lar_acting_as_additional_profile: false },
      };
    script(rows);
    if (kind === 'tooManyModules') script(Array.from({ length: 60001 }, () => ['x']));
    if (kind === 'tooManyScripts') for (let i = 0; i < 1024; i++) script([]);
    if (kind === 'tooLargeIdentity') {
      const node = script([]);
      node.textContent =
        'adp_CometSettingsDropdownTriggerQueryRelayPreloader_' + 'x'.repeat(1024 * 1024);
    }
    if (kind === 'tooManyBytes')
      for (let i = 0; i < 25; i++) {
        const node = script([]);
        node.textContent = 'x'.repeat(1024 * 1024 + 1);
      }
    const old = result(baseline);
    expect(result(projectFacebookDocumentIdentity)).toBe(old);
    expect(result(projectFacebookDocumentIdentity)).toBe(old);
  });
  it('merges streamed story chunks across different script nodes and catches late invalid patches', () => {
    route('/stories/create/');
    script([identityRows()[0]]);
    const root = query('StoriesCreate', {
      data: { viewer: { actor: { ...actor(), is_additional_profile_plus: false } } },
      extensions: { is_final: false },
    });
    const patch = query('StoriesCreate', { data: {}, path: [], extensions: { is_final: true } });
    script([root]);
    const end = script([patch]);
    expect(result(projectFacebookDocumentIdentity, 'story')).toBe(accountId);
    expect(result(baseline, 'story')).toBe(accountId);
    script([patch]);
    expect(result(projectFacebookDocumentIdentity, 'story')).toBeNull();
    expect(result(baseline, 'story')).toBeNull();
    end.remove();
    expect(result(projectFacebookDocumentIdentity, 'story')).toBe(accountId);
  });
});

describe('invitation script reads and live Fiber cache', () => {
  it('c_user short circuits document.scripts completely', () => {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => `c_user=${accountId}`,
    });
    const scripts = vi.spyOn(document, 'scripts', 'get').mockImplementation(() => {
      throw Error('must not read scripts');
    });
    expect(projectGroupInvitationState().accountId).toBe(accountId);
    expect(scripts).not.toHaveBeenCalled();
    Reflect.deleteProperty(document, 'cookie');
  });
  it('stops at the first matching script and caches a found ID by document timeOrigin', () => {
    const first = document.createElement('script'),
      second = document.createElement('script');
    first.textContent = `{"USER_ID":"${accountId}"}`;
    document.body.append(first, second);
    const late = vi.spyOn(second, 'textContent', 'get').mockImplementation(() => {
      throw Error('late script should not be touched');
    });
    const origin = vi.spyOn(performance, 'timeOrigin', 'get').mockReturnValue(100);
    expect(projectGroupInvitationState().accountId).toBe(accountId);
    expect(late).not.toHaveBeenCalled();
    const text = vi.spyOn(first, 'textContent', 'get').mockImplementation(() => {
      throw Error('cached ID should skip rereading');
    });
    expect(projectGroupInvitationState().accountId).toBe(accountId);
    expect(text).not.toHaveBeenCalled();
    text.mockReturnValue('{"USER_ID":"10000000000002"}');
    origin.mockReturnValue(200);
    expect(projectGroupInvitationState().accountId).toBe('10000000000002');
  });
  it('does not pin a missing ID while document scripts are still arriving', () => {
    expect(projectGroupInvitationState().accountId).toBeNull();
    const node = document.createElement('script');
    node.textContent = `{"USER_ID":"${accountId}"}`;
    document.body.append(node);
    expect(projectGroupInvitationState().accountId).toBe(accountId);
  });
  it('reuses live root mappings, follows committed alternates, and discovers a newly mounted checkbox', () => {
    route('/groups/12345/');
    document.body.innerHTML =
      '<main><div role="dialog"><div role="checkbox" aria-checked="false"></div></div></main>';
    const host = document.querySelector('main')!,
      dialog = document.querySelector('[role="dialog"]')!,
      checkbox = document.querySelector('[role="checkbox"]')!;
    for (const el of [host, dialog, checkbox]) box(el);
    type Fiber = Record<string, unknown>;
    const root: Fiber = {};
    const owner = { current: root };
    root.stateNode = owner;
    const dialogFiber: Fiber = {
      type: { displayName: 'GroupsCometInviteFriendsDialog' },
      stateNode: dialog,
      memoizedProps: {
        queries: { dialogQueryReference: { name: 'GroupsCometInviteFriendsDialogQuery' } },
      },
      return: root,
    };
    const item: Fiber = {
      type: { displayName: 'GroupsCometInviteFriendsSearchFriendItem' },
      stateNode: checkbox,
      memoizedProps: { user$key: { id: '12345' }, isInvited: false, isMember: false },
      return: dialogFiber,
    };
    let walks = 0;
    Object.defineProperty(root, 'child', {
      get: () => {
        walks++;
        return dialogFiber;
      },
    });
    dialogFiber.child = item;
    Object.defineProperty(host, '__reactContainer$test', { enumerable: true, value: root });
    expect(projectGroupInvitationState().items[0]?.invited).toBe(false);
    const initial = walks;
    expect(initial).toBeGreaterThan(0);
    expect(projectGroupInvitationState().items[0]?.invited).toBe(false);
    expect(walks).toBe(initial);
    const nextRoot: Fiber = { stateNode: owner },
      nextDialog: Fiber = { ...dialogFiber, return: nextRoot },
      nextItem: Fiber = {
        ...item,
        memoizedProps: { user$key: { id: '12345' }, isInvited: true, isMember: false },
        return: nextDialog,
      };
    nextRoot.child = nextDialog;
    nextDialog.child = nextItem;
    item.alternate = nextItem;
    nextItem.alternate = item;
    dialogFiber.alternate = nextDialog;
    nextDialog.alternate = dialogFiber;
    owner.current = nextRoot;
    expect(projectGroupInvitationState().items[0]?.invited).toBe(true);
    expect(walks).toBe(initial);
    const extra = document.createElement('div');
    extra.setAttribute('role', 'checkbox');
    dialog.append(extra);
    box(extra);
    nextItem.sibling = {
      ...nextItem,
      stateNode: extra,
      memoizedProps: { user$key: { id: '67890' }, isInvited: false },
    };
    expect(projectGroupInvitationState().items.map((i) => i.id)).toEqual(['12345', '67890']);
    expect(Reflect.get(window, '__wbReactRootNodesV1')).toBeInstanceOf(WeakMap);
  });
});

function videos(path = '/reel/12345/') {
  route(path);
  document.body.innerHTML =
    '<main><video id="past" src="https://example.com/past.mp4"></video><video id="current" src="https://example.com/current.mp4"></video><video id="future" src="https://example.com/future.mp4"></video><video id="near" src="https://example.com/near.mp4"></video></main>';
  const main = document.querySelector('main')!;
  box(main, 0, 0, 1200, 800);
  const all = ['past', 'current', 'future', 'near'].map(
    (id) => document.getElementById(id) as HTMLVideoElement,
  );
  all.forEach((v, i) => {
    box(v, 20, [-1000, 80, 1200, -300][i]!, 640, 400);
    for (const [key, value] of Object.entries({
      paused: false,
      readyState: 4,
      videoWidth: 640,
      videoHeight: 400,
      duration: 60,
      currentTime: 10,
      ended: false,
      error: null,
      playbackRate: 1,
      currentSrc: v.getAttribute('src'),
    }))
      Object.defineProperty(v, key, { configurable: true, value });
    Object.defineProperty(v, 'srcObject', {
      configurable: true,
      writable: true,
      value: i === 0 ? {} : null,
    });
    vi.spyOn(v, 'pause').mockImplementation(() => {});
    vi.spyOn(v, 'load').mockImplementation(() => {});
  });
  return { main, past: all[0]!, current: all[1]!, future: all[2]!, near: all[3]! };
}
describe('route pruning and bounded historical video teardown', () => {
  it('on a numeric Reel skips feed/article, entry-link and 1000-node style scans', () => {
    const f = videos();
    const queries = vi.spyOn(f.main, 'querySelectorAll');
    const reading = projectFacebookBrowsePage();
    expect(reading.video?.source).toContain('current.mp4');
    expect(reading.structure.structuralPosts).toBe(0);
    for (const selector of [
      '[role="article"]',
      '[data-ad-rendering-role="profile_name"]',
      'a[href]',
      '*',
    ])
      expect(queries.mock.calls.some((call) => call[0] === selector)).toBe(false);
  });
  it('frees only old offscreen history; current, visible previews and future source stay intact', () => {
    const f = videos();
    box(f.near, 20, -100, 640, 400);
    projectFacebookBrowsePage();
    expect(f.past.preload).toBe('none');
    expect(f.past.getAttribute('src')).toBeNull();
    expect(f.past.srcObject).toBeNull();
    expect(f.past.dataset.wbBufferFreed).toBe('1');
    expect(f.past.load).toHaveBeenCalledTimes(1);
    expect(f.current.pause).not.toHaveBeenCalled();
    expect(f.current.load).not.toHaveBeenCalled();
    expect(f.current.getAttribute('src')).toContain('current.mp4');
    expect(f.near.pause).not.toHaveBeenCalled();
    expect(f.near.load).not.toHaveBeenCalled();
    expect(f.future.preload).toBe('none');
    expect(f.future.pause).toHaveBeenCalled();
    expect(f.future.load).not.toHaveBeenCalled();
    expect(f.future.getAttribute('src')).toContain('future.mp4');
    projectFacebookBrowsePage();
    expect(f.past.load).toHaveBeenCalledTimes(1);
  });
  it('also frees passed homepage history, but never frees media in story or Marketplace readers', () => {
    let f = videos('/');
    projectFacebookBrowsePage();
    expect(f.past.dataset.wbBufferFreed).toBe('1');
    f = videos('/marketplace/');
    projectFacebookBrowsePage();
    expect(f.past.pause).not.toHaveBeenCalled();
    expect(f.past.load).not.toHaveBeenCalled();
  });
  it('media teardown failures do not abort reading the current player', () => {
    const f = videos();
    vi.mocked(f.past.pause).mockImplementation(() => {
      throw Error('detached');
    });
    expect(projectFacebookBrowsePage().video?.source).toContain('current.mp4');
    expect(f.current.load).not.toHaveBeenCalled();
  });
  it('all five Fiber-based readers share a weak fallback cache, not a retained strong Map', () => {
    document.body.innerHTML = '<main></main>';
    box(document.querySelector('main')!);
    projectFacebookFeedInputFence();
    const cache = Reflect.get(window, '__wbReactRootNodesV1');
    expect(cache).toBeInstanceOf(WeakMap);
    projectFacebookBrowsePage();
    projectFacebookStoryPage();
    projectFacebookBackground({
      scope: '[role="dialog"]',
      openCSS: '[data-test-open]',
      clearCSS: '[data-test-clear]',
      solids: [],
    });
    projectFacebookComposerAudience();
    expect(Reflect.get(window, '__wbReactRootNodesV1')).toBe(cache);
  });
});
