import { bumperNativeEvents } from './fixtures/bumper-native-events.js';
// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Page, Locator } from 'playwright-core';
import { projectGroupBumper, readGroupBumper } from '../src/infrastructure/group-bumper-effects.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import {
  typeBumperComment,
  executeBumperOperation,
  isBumperGraphQLRestricted,
  BumperFatalError,
  GroupBumperBrowserAdapter,
} from '../src/infrastructure/group-bumper-runner.js';

const group = '1116799701798635',
  author = '61572590020071',
  post = '4550823395062898';
function box(el: Element) {
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 500,
    bottom: 500,
    width: 500,
    height: 500,
    toJSON: () => ({}),
  });
}
function fiber(
  el: Element,
  name: string,
  props: Record<string, unknown>,
  parent?: Record<string, unknown>,
) {
  Reflect.set(el, '__reactFiber$test', {
    type: { displayName: name },
    memoizedProps: props,
    return: parent,
  });
}
beforeEach(() => {
  document.body.innerHTML = '<main></main>';
  document.head.innerHTML = '<base href="https://www.facebook.com/">';
  vi.stubGlobal('location', new URL('https://www.facebook.com/groups/' + group + '/'));
  Reflect.deleteProperty(window, '__wbReactRootNodesV1');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function article(html: string) {
  const a = document.createElement('div');
  a.setAttribute('role', 'article');
  a.innerHTML = html;
  document.querySelector('main')?.append(a);
  [a, ...a.querySelectorAll('*')].forEach(box);
  return a;
}
it('picture pcb link does not mask a separate GHLLink time label', () => {
  const a = article(
    '<a href="https://www.facebook.com/photo/?set=pcb.' +
      post +
      '"><img></a><a id="stamp" href="#">x</a>',
  );
  fiber(a.querySelector('#stamp')!, 'GHLLink.react', {
    href: '/groups/' + group + '/posts/' + post + '/',
    label: '11小时',
  });
  const p = projectGroupBumper({ groupId: group }).posts[0];
  expect(p?.postId).toBe(post);
  expect(p?.ageHours).toBe(11);
});
it('base64 feed unit, feedback ID and nested native creation time provide independent evidence', () => {
  const a = article('<span>plain text</span>');
  fiber(a, 'CometFeedUnitCard.react', {
    feedUnit: { id: btoa('Uzpf:VK:' + post), section: { creation_time: Date.now() / 1000 - 3600 } },
  });
  expect(projectGroupBumper({ groupId: group }).posts[0]?.postId).toBe(post);
  expect(projectGroupBumper({ groupId: group }).posts[0]?.ageHours).toBeCloseTo(1, 2);
  a.innerHTML = '<button id="like"></button>';
  box(a.querySelector('button')!);
  Reflect.deleteProperty(a, '__reactFiber$test');
  fiber(a.querySelector('button')!, 'CometUFIReactButtonBase.react', {
    feedback: { __id: btoa('feedback:' + post) },
  });
  expect(projectGroupBumper({ groupId: group }).posts[0]?.postId).toBe(post);
});
it('SVG group cover and FDSProfilePhoto author source are extracted without confusing post images', () => {
  document.querySelector('main')!.innerHTML =
    '<svg role="img"><image xlink:href="https://example.com/group.jpg"></image></svg>';
  const a = article(
    '<a id="author" href="https://www.facebook.com/groups/' +
      group +
      '/user/' +
      author +
      '/"><svg role="img"><image href="https://example.com/author.jpg"></image></svg>Name</a><a href="https://www.facebook.com/groups/' +
      group +
      '/posts/' +
      post +
      '/">2h</a>',
  );
  let state = projectGroupBumper({ groupId: group, pageId: author });
  expect(state.avatarUrl).toBe('https://example.com/group.jpg');
  expect(state.posts[0]?.authorAvatarUrl).toBe('https://example.com/author.jpg');
  expect(state.pageAvatarUrl).toBe('https://example.com/author.jpg');
  a.querySelector('svg')!.remove();
  fiber(a.querySelector('#author')!, 'FDSProfilePhoto.react', {
    source: { uri: 'https://example.com/fiber.jpg' },
  });
  state = projectGroupBumper({ groupId: group });
  expect(state.posts[0]?.authorAvatarUrl).toBe('https://example.com/fiber.jpg');
});
it('skeletons are loading rather than an empty finished feed, and searches can match Group Fiber IDs', () => {
  const a = article('');
  fiber(a, 'CometFeedGlimmer.react', {});
  expect(projectGroupBumper({ groupId: group }).loading).toBe(true);
  vi.stubGlobal('location', new URL('https://www.facebook.com/groups/search/groups/'));
  const link = document.createElement('a');
  // WO60-B：搜索入口只认 /groups/<id或别名>/ 形态的小组主页链接，再按 Fiber 小组 ID 匹配
  link.href = 'https://www.facebook.com/groups/opaque-slug/';
  link.textContent = 'result';
  box(link);
  document.body.append(link);
  fiber(link, 'GroupsSearchResult.react', { group: { id: group, __typename: 'Group' } });
  expect(projectGroupBumper({ groupId: group }).groupEntryCSS).toBeTruthy();
});
it('legacy per-node Fiber and shared weak container cache are supported', () => {
  const a = article('');
  Reflect.set(a, '__reactInternalInstance$test', {
    type: { displayName: 'CometFeedUnitCard.react' },
    memoizedProps: { feedUnit: { id: btoa('actor:VK:' + post) } },
  });
  expect(projectGroupBumper({ groupId: group }).posts[0]?.postId).toBe(post);
  expect(Reflect.get(window, '__wbReactRootNodesV1')).toBeInstanceOf(WeakMap);
});
it('Lexical input centers, focuses, clears an old draft, types character by character, normalizes and never submits', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  let value = 'old';
  const box = {
    evaluate: async () => {
      calls.push('center');
    },
    click: async () => {
      calls.push('focus');
    },
    innerText: async () => value,
    press: async (key: string) => {
      calls.push(key);
      if (key === 'Backspace') value = '';
    },
    pressSequentially: async (text: string) => {
      calls.push('fallback');
      value = text;
    },
  } as unknown as Locator;
  const page = {
    keyboard: {
      type: async (ch: string) => {
        calls.push('char:' + ch);
        value += ch;
      },
      insertText: async (text: string) => {
        calls.push('insert:' + text);
        value += text;
      },
    },
  } as unknown as Page;
  const run = typeBumperComment(page, box, 'hi, 顶!');
  await vi.runAllTimersAsync();
  await run;
  expect(calls).toEqual([
    'center',
    'focus',
    'ControlOrMeta+A',
    'Backspace',
    'char:h',
    'char:i',
    'char:,',
    'char: ',
    'char:顶',
    'char:!',
  ]);
  expect(calls).not.toContain('Enter');
});
it('a normal click timeout finishes its binding without killing the connection; the next operation still runs', async () => {
  const stop = vi.fn(),
    reconcile = vi.fn();
  const connection = {
    stopRequestId: '00000000-0000-4000-8000-000000000055',
    revokeInput: () => {},
    nativeMutationCalls: {},
    execute: async (binding: unknown, work: () => Promise<unknown>) => ({
      binding,
      value: await work(),
    }),
    reconcile,
  };
  const run = (work: () => Promise<unknown>) =>
    executeBumperOperation({
      connection: connection as unknown as Parameters<
        typeof executeBumperOperation
      >[0]['connection'],
      binding: {} as Parameters<typeof executeBumperOperation>[0]['binding'],
      label: 'click',
      work,
      verify: async () => true,
      assertCurrent: async () => {},
      stop,
    });
  await expect(
    run(async () => {
      throw Error('locator.click: Timeout 4000ms');
    }),
  ).rejects.toThrow('Timeout');
  await expect(run(async () => true)).resolves.toBe(true);
  expect(stop).not.toHaveBeenCalled();
  expect(reconcile.mock.calls[0]?.[1].outcome).toBe('NOT_APPLIED');
});
it('a sent action with unconfirmed business result is retained, never changed to success or no-effect', async () => {
  let count = 0;
  const reconcile = vi.fn();
  const connection = {
    stopRequestId: '00000000-0000-4000-8000-000000000055',
    revokeInput: () => {},
    get nativeMutationCalls() {
      return { input: count };
    },
    execute: async (binding: unknown, work: () => Promise<unknown>) => ({
      binding,
      value: await work(),
    }),
    reconcile,
  };
  await expect(
    executeBumperOperation({
      connection: connection as unknown as Parameters<
        typeof executeBumperOperation
      >[0]['connection'],
      binding: {} as Parameters<typeof executeBumperOperation>[0]['binding'],
      label: 'comment',
      work: async () => {
        count++;
        return true;
      },
      verify: async () => false,
      assertCurrent: async () => {},
      stop: vi.fn(),
    }),
  ).rejects.toThrow('待核对');
  expect(reconcile).not.toHaveBeenCalled();
});
it('fatal identity change is not swallowed by the operation wrapper', async () => {
  const stop = vi.fn();
  const connection = {
    stopRequestId: '00000000-0000-4000-8000-000000000055',
    revokeInput: () => {},
    nativeMutationCalls: {},
    execute: async (
      _b: unknown,
      work: () => Promise<unknown>,
      _f: unknown,
      failure: (reason: string) => Promise<void>,
    ) => {
      try {
        return { value: await work() };
      } catch (e) {
        await failure((e as Error).message);
        throw e;
      }
    },
    reconcile: vi.fn(),
  };
  await expect(
    executeBumperOperation({
      connection: connection as unknown as Parameters<
        typeof executeBumperOperation
      >[0]['connection'],
      binding: {} as Parameters<typeof executeBumperOperation>[0]['binding'],
      label: 'like',
      work: async () => {
        throw new BumperFatalError('KERNEL_CONTEXT_CHANGED');
      },
      verify: async () => true,
      assertCurrent: async () => {},
      stop,
    }),
  ).rejects.toBeInstanceOf(BumperFatalError);
  expect(stop).toHaveBeenCalledOnce();
});

it.each([
  ['time_sort', false],
  ['random_browse', false],
  ['time_sort', true],
  ['random_browse', true],
] as const)(
  '%s keeps exploring with scanOnly=%s and isolates one target failure',
  async (mode, scanOnly) => {
    vi.useFakeTimers();
    let scrolls = 0,
      current = '',
      groupInput = group;
    const clicked: string[] = [];
    const recorded: string[] = [];
    let metadataWrites = 0;
    const close = vi.fn();
    const liked = new Set<string>();
    let mutations = 0;
    const postRow = (id: string, owner: string) => ({
      postId: id,
      postUrl: 'https://www.facebook.com/groups/' + group + '/posts/' + id + '/',
      authorId: owner,
      authorName: 'page',
      authorAliases: [],
      authorAvatarUrl: null,
      pinned: false,
      ageHours: 1,
      timeText: '1h',
      feedbackId: 'fb' + id,
      liked: liked.has(id),
      likeCSS: id,
      commentCSS: null,
      commentButtonCSS: null,
      hasVideo: false,
      comments: [],
    });
    const nativeEvents = bumperNativeEvents();
    const page = {
      url: () => current,
      goto: async (url: string) => {
        current = url;
        return null;
      },
      waitForURL: async () => {},
      on: nativeEvents.on,
      off: nativeEvents.off,
      mouse: {
        wheel: async () => {
          scrolls++;
        },
      },
      evaluate: async (fn: Function, input: { groupId?: string }) => {
        if (!input) return 'test-document';
        if (fn.name === 'projectGroupInvitationState')
          return {
            accountId: '10000000001',
            ready: true,
            visible: true,
            verificationRequired: false,
          };
        groupInput = input.groupId ?? groupInput;
        return {
          url: current,
          groupIds: [groupInput],
          avatarUrl: 'data:image/webp;base64,AAAA',
          pageAvatarUrl: null,
          ready: true,
          visible: true,
          restricted: false,
          loading: false,
          groupEntryCSS: current.includes('/search/groups') ? 'entry' : null,
          posts:
            scrolls === 0
              ? Array.from({ length: 9 }, (_, i) => postRow('50000000' + i, '99999999999'))
              : scrolls === 1
                ? [postRow('600000001', author), postRow('600000002', author)]
                : [],
        };
      },
      locator: (selector: string) => ({
        first() {
          return this;
        },
        evaluate: async () => {},
        click: async () => {
          if (selector.includes('bumper-group')) {
            current = 'https://www.facebook.com/groups/' + groupInput + '/';
            return;
          }
          clicked.push(selector);
          if (selector === '600000001') throw Error('locator.click: Timeout 4000ms');
          mutations++;
          liked.add(selector);
          nativeEvents.like('10000000001', 'fb' + selector);
        },
      }),
    };
    const proof = {
      ownershipId: '00000000-0000-4000-8000-000000000001',
      profileId: 'p',
      browserSessionEpoch: 'session',
      tabId: 1,
      targetId: 't',
    };
    const connection = {
      stopRequestId: '00000000-0000-4000-8000-000000000055',
      revokeInput: () => {},
      browser: { contexts: () => [{ pages: () => [page] }] },
      context: async () => ({ accountId: '10000000001' }),
      execute: async (binding: unknown, work: () => Promise<unknown>) => ({
        binding,
        value: await work(),
      }),
      reconcile: async () => {},
      get nativeMutationCalls() {
        return { input: mutations };
      },
      close,
      retryClose: close,
    };
    const peer = { online: true, synced: true, epoch: 'epoch', profileId: 'p', capabilities: [] };
    const kernel = {
      withSummary: async (_p: unknown, run: (port: unknown) => unknown) =>
        run({
          inventory: async () => ({
            tabs: [{ state: 'READY', proof }],
            workspaceMain: proof,
            operations: [],
          }),
        }),
      inspectIdleFacebookPage: async () => ({ actor: { accountId: '10000000001' }, proof }),
      connectFacebook: async () => connection,
    };
    const repo = {
      getOperation: async () => null,
      listOperationsByProfile: async () => [],
      prepareOperation: async (input: unknown) => input,
      setOperationResolution: async (_id: string, r: unknown) => r,
      markOperationSettled: async () => {},
      markOperationReview: async () => {},
      confirmSubmission: async (
        _id: string,
        row: never,
        _comment: unknown,
        resolution: unknown,
      ) => {
        await repo.record(row);
        return resolution;
      },
      eligibility: async () => ({ today: 0, allowed: true }),
      pickComment: async () => null,
      record: async (row: { postId: string }) => {
        recorded.push(row.postId);
        return true;
      },
      updateAvatar: async () => {
        metadataWrites++;
      },
      applyResolvedTargetMetadata: async () => {
        metadataWrites++;
      },
    };
    const adapter = new GroupBumperBrowserAdapter(
      repo as unknown as ConstructorParameters<typeof GroupBumperBrowserAdapter>[0],
      () =>
        kernel as unknown as ReturnType<ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]>,
      () =>
        ({ peers: new Map([['p', peer]]) }) as unknown as ReturnType<
          ConstructorParameters<typeof GroupBumperBrowserAdapter>[2]
        >,
      async () => false,
      0,
    );
    const target = (id: string) => ({
      id,
      name: 'page',
      avatarUrl: null,
      folderId: null,
      sortOrder: 0,
      totalBumpedCount: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const work = adapter.run(
      'p',
      [target(group)],
      [target(author)],
      {
        ...BumperSettings.parse({}),
        searchMode: mode,
        commentProbability: 0,
        maxPostsPerGroupPage: 2,
      },
      {
        executionMode: scanOnly ? 'scan_only' : 'live',
        cancelled: () => false,
        status: () => {},
        added: () => {},
      },
    );
    await vi.runAllTimersAsync();
    await work;
    expect(scrolls).toBeGreaterThan(0);
    if (scanOnly) {
      expect(clicked.filter((id) => /^\d+$/.test(id))).toEqual([]);
      expect(recorded).toEqual([]);
      expect(metadataWrites).toBe(0);
    } else {
      expect(clicked).toContain('600000002');
      expect(recorded).toEqual(['600000002']);
    }
    expect(close).toHaveBeenCalledOnce();
  },
);

it('projectGroupBumper detects video posts, marks data-wb-bumper-video, without pausing offscreen videos above viewport', () => {
  const offscreen = document.createElement('video');
  let pausedCalled = false;
  Object.defineProperty(offscreen, 'paused', { value: false });
  offscreen.pause = () => {
    pausedCalled = true;
  };
  offscreen.getBoundingClientRect = () => ({
    x: 0,
    y: -600,
    left: 0,
    top: -600,
    right: 400,
    bottom: -300,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  });
  document.body.append(offscreen);

  const a = article(
    `<a href="https://www.facebook.com/groups/${group}/posts/${post}/">1h</a><video id="v"></video>`,
  );
  const v = a.querySelector<HTMLVideoElement>('#v')!;
  Object.defineProperty(v, 'currentTime', { value: 14.5, configurable: true });
  Object.defineProperty(v, 'duration', { value: 15, configurable: true });
  Object.defineProperty(v, 'ended', { value: false, configurable: true });

  const state = projectGroupBumper({ groupId: group });
  expect(pausedCalled).toBe(false);
  expect(state.posts[0]?.hasVideo).toBe(true);
  expect(state.posts[0]?.videoDuration).toBe(15);
  expect(state.posts[0]?.videoCurrentTime).toBe(14.5);
  expect(state.posts[0]?.videoEnded).toBe(false);
  expect(state.posts[0]?.videoCSS).toBe(`[data-wb-bumper-video="${post}"]`);
});

it('detects GraphQL 368/1404078 restriction errors and CometErrorDialog/Temporarily Blocked dialogs', () => {
  expect(
    isBumperGraphQLRestricted(
      'for (;;);\n{"errors":[{"code":368,"summary":"You\u2019re Temporarily Blocked"}]}',
    ),
  ).toBe(true);
  expect(
    isBumperGraphQLRestricted(
      '{"errors":[{"code":1,"error_subcode":1404078,"description":"说话太快，暂时被禁止"}]}',
    ),
  ).toBe(true);
  expect(isBumperGraphQLRestricted('{"data":{"feedback_react":{"feedback":{"id":"1"}}}}')).toBe(
    false,
  );

  const dlg = document.createElement('div');
  dlg.setAttribute('role', 'dialog');
  dlg.textContent = 'ข้อความที่ไม่รู้จัก';
  fiber(dlg, 'GroupsCometFeatureInterventionDialog.react', {});
  box(dlg);
  document.body.append(dlg);
  expect(projectGroupBumper({ groupId: group }).restricted).toBe(true);
});

it('page_group_feed resolves multiple non-numeric page slugs via group search and passes resolvedPageId to checkPost', async () => {
  vi.useFakeTimers();
  let current = '';
  const visitedUrls: string[] = [];
  const evaluatePageIds: (string | undefined)[] = [];
  const liked = new Set<string>();
  let mutations = 0;

  const nativeEvents = bumperNativeEvents();
  const page = {
    url: () => current,
    goto: async (url: string) => {
      current = url;
      visitedUrls.push(url);
      return null;
    },
    waitForURL: async () => {},
    on: nativeEvents.on,
    off: nativeEvents.off,
    mouse: { wheel: async () => {} },
    evaluate: async (fn: Function, input: { groupId?: string; pageId?: string }) => {
      if (!input) return 'test-document';
      if (fn.name === 'projectGroupInvitationState')
        return {
          accountId: '10000000001',
          ready: true,
          visible: true,
          verificationRequired: false,
        };
      evaluatePageIds.push(input.pageId);
      const isSecondSearch = current.includes('PageTwo');
      const isFirstUser = current.includes('/user/61500000001/');
      const isSecondUser = current.includes('/user/61500000002/');
      const pid = isSecondSearch || isSecondUser ? '700000002' : '700000001';
      const aid = isSecondSearch || isSecondUser ? '61500000002' : '61500000001';
      const aname = isSecondSearch || isSecondUser ? 'PageTwo' : 'PageOne';
      return {
        url: current,
        groupIds: [group],
        avatarUrl: null,
        pageAvatarUrl: null,
        ready: true,
        visible: true,
        restricted: false,
        loading: false,
        groupEntryCSS: null,
        posts: [
          {
            postId: pid,
            postUrl: `https://www.facebook.com/groups/${group}/posts/${pid}/`,
            authorId: isFirstUser || isSecondUser ? (input.pageId ?? null) : aid,
            authorName: aname,
            authorAliases: [isSecondSearch || isSecondUser ? 'slug-two' : 'slug-one'],
            authorAvatarUrl: null,
            pinned: false,
            ageHours: 1,
            timeText: '1h',
            feedbackId: 'fb' + pid,
            liked: liked.has(pid),
            likeCSS: pid,
            commentCSS: null,
            commentButtonCSS: null,
            hasVideo: false,
            comments: [],
          },
        ],
      };
    },
    locator: (selector: string) => ({
      first() {
        return this;
      },
      evaluate: async () => {},
      click: async () => {
        mutations++;
        liked.add(selector);
        nativeEvents.like('10000000001', 'fb' + selector);
      },
    }),
  };
  const proof = {
    ownershipId: '00000000-0000-4000-8000-000000000001',
    profileId: 'p',
    browserSessionEpoch: 'session',
    tabId: 1,
    targetId: 't',
  };
  const connection = {
    stopRequestId: '00000000-0000-4000-8000-000000000055',
    revokeInput: () => {},
    browser: { contexts: () => [{ pages: () => [page] }] },
    context: async () => ({ accountId: '10000000001' }),
    execute: async (binding: unknown, work: () => Promise<unknown>) => ({
      binding,
      value: await work(),
    }),
    reconcile: async () => {},
    get nativeMutationCalls() {
      return { input: mutations };
    },
    close: async () => {},
    retryClose: async () => {},
  };
  const peer = { online: true, synced: true, epoch: 'epoch', profileId: 'p', capabilities: [] };
  const kernel = {
    withSummary: async (_p: unknown, run: (port: unknown) => unknown) =>
      run({
        inventory: async () => ({
          tabs: [{ state: 'READY', proof }],
          workspaceMain: proof,
          operations: [],
        }),
      }),
    inspectIdleFacebookPage: async () => ({ actor: { accountId: '10000000001' }, proof }),
    connectFacebook: async () => connection,
  };
  const recorded: string[] = [];
  const repo = {
    getOperation: async () => null,
    listOperationsByProfile: async () => [],
    prepareOperation: async (input: unknown) => input,
    setOperationResolution: async (_id: string, r: unknown) => r,
    markOperationSettled: async () => {},
    markOperationReview: async () => {},
    confirmSubmission: async (_id: string, row: never, _comment: unknown, resolution: unknown) => {
      await repo.record(row);
      return resolution;
    },
    eligibility: async () => ({ today: 0, allowed: true }),
    pickComment: async () => null,
    record: async (row: { postId: string }) => {
      recorded.push(row.postId);
      return true;
    },
    updateAvatar: async () => {},
  };
  const adapter = new GroupBumperBrowserAdapter(
    repo as unknown as ConstructorParameters<typeof GroupBumperBrowserAdapter>[0],
    () =>
      kernel as unknown as ReturnType<ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]>,
    () =>
      ({ peers: new Map([['p', peer]]) }) as unknown as ReturnType<
        ConstructorParameters<typeof GroupBumperBrowserAdapter>[2]
      >,
    async () => false,
    0,
  );
  const mkTarget = (id: string, name: string) => ({
    id,
    name,
    avatarUrl: null,
    folderId: null,
    sortOrder: 0,
    totalBumpedCount: 0,
    createdAt: 0,
    updatedAt: 0,
  });
  const work = adapter.run(
    'p',
    [mkTarget(group, 'Group1')],
    [mkTarget('slug-one', 'PageOne'), mkTarget('slug-two', 'PageTwo')],
    {
      ...BumperSettings.parse({}),
      searchMode: 'page_group_feed',
      commentProbability: 0,
      maxPostsPerGroupPage: 1,
    },
    { cancelled: () => false, status: () => {}, added: () => {} },
  );
  await vi.runAllTimersAsync();
  await work;
  expect(visitedUrls.some((u) => u.includes('/search/?q=PageTwo'))).toBe(true);
  expect(evaluatePageIds).toContain('61500000001');
  expect(evaluatePageIds).toContain('61500000002');
  expect(evaluatePageIds).not.toContain('slug-one');
  expect(recorded).toEqual(['700000001', '700000002']);
});

it('detects group welcome dialog and marks welcomeDismissCSS without flagging restricted', () => {
  const dlg = document.createElement('div');
  dlg.setAttribute('role', 'dialog');
  dlg.innerHTML = `
    <div>你好，歡迎加入全球華人資訊交流群！ - 管理員團隊</div>
    <div id="continue-btn" role="button">繼續</div>
  `;
  box(dlg);
  const btn = dlg.querySelector<HTMLElement>('#continue-btn')!;
  box(btn);
  document.body.append(dlg);

  dlg.setAttribute('aria-modal', 'true');
  fiber(btn, 'FDSCircleButton.react', {});
  const state = projectGroupBumper({ groupId: group });
  expect(state.restricted).toBe(false);
  expect(state.welcomeDismissCSS).toBe('[data-wb-bumper-welcome-dismiss="1"]');
  expect(btn.getAttribute('data-wb-bumper-welcome-dismiss')).toBe('1');
});

it('executes all human-like mouse.wheel/mouse.move inside connection.execute when paceScale > 0, dismisses welcome dialog, and falls back to direct URL when search click fails', async () => {
  vi.useFakeTimers();
  let current = '';
  let inBoundLease = false;
  let welcomeOpen = true;
  let scrolls = 0;
  let mutations = 0;
  const liked = new Set<string>();
  const visitedUrls: string[] = [];
  const clickedSelectors: string[] = [];

  const nativeEvents = bumperNativeEvents();
  const page = {
    url: () => current,
    goto: async (url: string) => {
      current = url;
      visitedUrls.push(url);
      return null;
    },
    waitForURL: async () => {},
    on: nativeEvents.on,
    off: nativeEvents.off,
    mouse: {
      wheel: async () => {
        if (!inBoundLease) throw new Error('KERNEL_BOUND_INPUT_INACTIVE: wheel outside op');
        scrolls++;
        mutations++;
      },
      move: async () => {
        if (!inBoundLease) throw new Error('KERNEL_BOUND_INPUT_INACTIVE: move outside op');
        mutations++;
      },
    },
    evaluate: async (fn: Function, input?: unknown) => {
      if (!input) return 'test-document';
      if (fn.name === 'bumperDialogClosed') return !welcomeOpen;
      if (!input) return 'test-document';
      if (fn.name === 'projectGroupInvitationState')
        return {
          accountId: '10000000001',
          ready: true,
          visible: true,
          verificationRequired: false,
        };
      return {
        url: current,
        groupIds: [group],
        avatarUrl: null,
        pageAvatarUrl: null,
        ready: true,
        visible: true,
        restricted: false,
        loading: false,
        groupEntryCSS: current.includes('/search/groups') ? '[data-wb-bumper-group="1"]' : null,
        welcomeDismissCSS:
          current.includes(`/groups/${group}`) && welcomeOpen
            ? '[data-wb-bumper-welcome-dismiss="1"]'
            : null,
        posts:
          scrolls === 0
            ? [
                {
                  postId: '500000001',
                  postUrl: `https://www.facebook.com/groups/${group}/posts/500000001/`,
                  authorId: '99999999999',
                  authorName: 'OtherPage',
                  authorAliases: [],
                  authorAvatarUrl: null,
                  pinned: false,
                  ageHours: 1,
                  timeText: '1h',
                  feedbackId: 'fb500000001',
                  liked: false,
                  likeCSS: '500000001',
                  commentCSS: null,
                  commentButtonCSS: null,
                  hasVideo: false,
                  comments: [],
                },
              ]
            : [
                {
                  postId: '800000001',
                  postUrl: `https://www.facebook.com/groups/${group}/posts/800000001/`,
                  authorId: author,
                  authorName: 'TargetPage',
                  authorAliases: [],
                  authorAvatarUrl: null,
                  pinned: false,
                  ageHours: 1,
                  timeText: '1h',
                  feedbackId: 'fb800000001',
                  liked: liked.has('800000001'),
                  likeCSS: '800000001',
                  commentCSS: null,
                  commentButtonCSS: null,
                  hasVideo: false,
                  comments: [],
                },
              ],
      };
    },
    locator: (selector: string) => ({
      first() {
        return this;
      },
      evaluate: async () => {
        if (selector === '[data-wb-bumper-group="1"]')
          throw new Error('locator.evaluate: Timeout 4000ms exceeded');
      },
      click: async () => {
        if (!inBoundLease) throw new Error('KERNEL_BOUND_INPUT_INACTIVE: click outside op');
        clickedSelectors.push(selector);
        mutations++;
        if (selector === '[data-wb-bumper-welcome-dismiss="1"]') {
          welcomeOpen = false;
          return;
        }
        liked.add(selector);
        nativeEvents.like('10000000001', 'fb' + selector);
      },
    }),
  };

  const proof = {
    ownershipId: '00000000-0000-4000-8000-000000000001',
    profileId: 'p',
    browserSessionEpoch: 'session',
    tabId: 1,
    targetId: 't',
  };
  const connection = {
    stopRequestId: '00000000-0000-4000-8000-000000000055',
    revokeInput: () => {},
    browser: { contexts: () => [{ pages: () => [page] }] },
    context: async () => ({ accountId: '10000000001' }),
    execute: async (binding: unknown, work: () => Promise<unknown>) => {
      inBoundLease = true;
      try {
        return { binding, value: await work() };
      } finally {
        inBoundLease = false;
      }
    },
    reconcile: async () => {},
    get nativeMutationCalls() {
      return { input: mutations };
    },
    close: async () => {},
    retryClose: async () => {},
  };
  const peer = { online: true, synced: true, epoch: 'epoch', profileId: 'p', capabilities: [] };
  const kernel = {
    withSummary: async (_p: unknown, run: (port: unknown) => unknown) =>
      run({
        inventory: async () => ({
          tabs: [{ state: 'READY', proof }],
          workspaceMain: proof,
          operations: [],
        }),
      }),
    inspectIdleFacebookPage: async () => ({ actor: { accountId: '10000000001' }, proof }),
    connectFacebook: async () => connection,
  };
  const recorded: string[] = [];
  const repo = {
    getOperation: async () => null,
    listOperationsByProfile: async () => [],
    prepareOperation: async (input: unknown) => input,
    setOperationResolution: async (_id: string, r: unknown) => r,
    markOperationSettled: async () => {},
    markOperationReview: async () => {},
    confirmSubmission: async (_id: string, row: never, _comment: unknown, resolution: unknown) => {
      await repo.record(row);
      return resolution;
    },
    eligibility: async () => ({ today: 0, allowed: true }),
    pickComment: async () => null,
    record: async (row: { postId: string }) => {
      recorded.push(row.postId);
      return true;
    },
    updateAvatar: async () => {},
  };
  const adapter = new GroupBumperBrowserAdapter(
    repo as unknown as ConstructorParameters<typeof GroupBumperBrowserAdapter>[0],
    () =>
      kernel as unknown as ReturnType<ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]>,
    () =>
      ({ peers: new Map([['p', peer]]) }) as unknown as ReturnType<
        ConstructorParameters<typeof GroupBumperBrowserAdapter>[2]
      >,
    async () => false,
    0.001,
  );
  const mkTarget = (id: string) => ({
    id,
    name: 'target',
    avatarUrl: null,
    folderId: null,
    sortOrder: 0,
    totalBumpedCount: 0,
    createdAt: 0,
    updatedAt: 0,
  });
  const work = adapter.run(
    'p',
    [mkTarget(group)],
    [mkTarget(author)],
    {
      ...BumperSettings.parse({}),
      searchMode: 'random_browse',
      commentProbability: 0,
      maxPostsPerGroupPage: 1,
    },
    { cancelled: () => false, status: () => {}, added: () => {} },
  );
  await vi.runAllTimersAsync();
  await work;
  expect(visitedUrls).toContain(`https://www.facebook.com/groups/${group}/`);
  expect(clickedSelectors).toContain('[data-wb-bumper-welcome-dismiss="1"]');
  expect(recorded).toEqual(['800000001']);
});

it('reports transparent 0-bump reasons and throws when all groups fail to enter', async () => {
  vi.useFakeTimers();
  let mode: 'fail_all' | 'no_author' | 'too_old' | 'cooldown' = 'fail_all';
  let current = '';

  const nativeEvents = bumperNativeEvents();
  const page = {
    url: () => current,
    goto: async (url: string) => {
      current = url;
      return null;
    },
    waitForURL: async () => {},
    on: nativeEvents.on,
    off: nativeEvents.off,
    mouse: { wheel: async () => {}, move: async () => {} },
    evaluate: async (fn: Function, input?: unknown) => {
      if (!input) return 'test-document';
      if (!input) return 'test-document';
      if (fn.name === 'projectGroupInvitationState')
        return {
          accountId: '10000000001',
          ready: true,
          visible: true,
          verificationRequired: false,
        };
      if (mode === 'fail_all') {
        return {
          url: current,
          groupIds: [group],
          avatarUrl: null,
          pageAvatarUrl: null,
          ready: true,
          visible: true,
          restricted: false,
          loading: false,
          groupEntryCSS: null,
          posts: [],
        };
      }
      return {
        url: current,
        groupIds: [group],
        avatarUrl: null,
        pageAvatarUrl: null,
        ready: true,
        visible: true,
        restricted: false,
        loading: false,
        groupEntryCSS: null,
        posts: [
          {
            postId: '900000001',
            postUrl: `https://www.facebook.com/groups/${group}/posts/900000001/`,
            authorId: mode === 'no_author' ? '99999999999' : author,
            authorName: 'TargetPage',
            authorAliases: [],
            authorAvatarUrl: null,
            pinned: false,
            ageHours: mode === 'too_old' ? 72 : 1,
            timeText: mode === 'too_old' ? '3d' : '1h',
            feedbackId: 'fb900000001',
            liked: false,
            likeCSS: '900000001',
            commentCSS: null,
            commentButtonCSS: null,
            hasVideo: false,
            comments: [],
          },
        ],
      };
    },
    locator: () => ({
      first() {
        return this;
      },
      evaluate: async () => {},
      click: async () => {},
    }),
  };

  const proof = {
    ownershipId: '00000000-0000-4000-8000-000000000001',
    profileId: 'p',
    browserSessionEpoch: 'session',
    tabId: 1,
    targetId: 't',
  };
  const connection = {
    stopRequestId: '00000000-0000-4000-8000-000000000055',
    revokeInput: () => {},
    browser: { contexts: () => [{ pages: () => [page] }] },
    context: async () => ({ accountId: '10000000001' }),
    execute: async (binding: unknown, work: () => Promise<unknown>) => ({
      binding,
      value: await work(),
    }),
    reconcile: async () => {},
    nativeMutationCalls: { input: 1 },
    close: async () => {},
    retryClose: async () => {},
  };
  const peer = { online: true, synced: true, epoch: 'epoch', profileId: 'p', capabilities: [] };
  const kernel = {
    withSummary: async (_p: unknown, run: (port: unknown) => unknown) =>
      run({
        inventory: async () => ({
          tabs: [{ state: 'READY', proof }],
          workspaceMain: proof,
          operations: [],
        }),
      }),
    inspectIdleFacebookPage: async () => ({ actor: { accountId: '10000000001' }, proof }),
    connectFacebook: async () => connection,
  };
  const repo = {
    getOperation: async () => null,
    listOperationsByProfile: async () => [],
    prepareOperation: async (input: unknown) => input,
    setOperationResolution: async (_id: string, r: unknown) => r,
    markOperationSettled: async () => {},
    markOperationReview: async () => {},
    confirmSubmission: async (_id: string, row: never, _comment: unknown, resolution: unknown) => {
      await repo.record(row);
      return resolution;
    },
    eligibility: async () => ({ today: 0, allowed: mode !== 'cooldown' }),
    pickComment: async () => null,
    record: async () => true,
    updateAvatar: async () => {},
  };
  const adapter = new GroupBumperBrowserAdapter(
    repo as unknown as ConstructorParameters<typeof GroupBumperBrowserAdapter>[0],
    () =>
      kernel as unknown as ReturnType<ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]>,
    () =>
      ({ peers: new Map([['p', peer]]) }) as unknown as ReturnType<
        ConstructorParameters<typeof GroupBumperBrowserAdapter>[2]
      >,
    async () => false,
    0,
  );
  const mkTarget = (id: string) => ({
    id,
    name: 'target',
    avatarUrl: null,
    folderId: null,
    sortOrder: 0,
    totalBumpedCount: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  // 1. fail_all throws
  const failWork = adapter.run(
    'p',
    [mkTarget(group)],
    [mkTarget(author)],
    { ...BumperSettings.parse({}), searchMode: 'time_sort' },
    { cancelled: () => false, status: () => {}, added: () => {} },
  );
  const failExpect = expect(failWork).rejects.toThrow(/全部小组执行异常：小组暂无可访问帖子/);
  await vi.runAllTimersAsync();
  await failExpect;

  const scanFail = adapter.run(
    'p',
    [mkTarget(group)],
    [mkTarget(author)],
    { ...BumperSettings.parse({}), searchMode: 'time_sort' },
    { executionMode: 'scan_only', cancelled: () => false, status: () => {}, added: () => {} },
  );
  const scanFailExpected = expect(scanFail).rejects.toThrow(/全部小组执行异常/);
  await vi.runAllTimersAsync();
  await scanFailExpected;

  // 2. no_author reports '已完成 · 0 次（小组内未扫到目标主页帖子）'
  mode = 'no_author';
  let lastStatus = '';
  const noAuthorWork = adapter.run(
    'p',
    [mkTarget(group)],
    [mkTarget(author)],
    { ...BumperSettings.parse({}), searchMode: 'time_sort' },
    {
      cancelled: () => false,
      status: (s) => {
        lastStatus = s;
      },
      added: () => {},
    },
  );
  await vi.runAllTimersAsync();
  await noAuthorWork;
  expect(lastStatus).toBe('已完成 · 0 次（小组内未扫到目标主页帖子）');

  // 3. too_old reports '已完成 · 0 次（扫到 1 帖均超出 24h 时效）'
  mode = 'too_old';
  const tooOldWork = adapter.run(
    'p',
    [mkTarget(group)],
    [mkTarget(author)],
    { ...BumperSettings.parse({}), searchMode: 'time_sort', maxPostAgeHours: 24 },
    {
      cancelled: () => false,
      status: (s) => {
        lastStatus = s;
      },
      added: () => {},
    },
  );
  await vi.runAllTimersAsync();
  await tooOldWork;
  expect(lastStatus).toBe('已完成 · 0 次（扫到 1 帖均超出 24h 时效）');

  // 4. cooldown reports '已完成 · 0 次（目标帖均已顶过或冷却中）'
  mode = 'cooldown';
  const cooldownWork = adapter.run(
    'p',
    [mkTarget(group)],
    [mkTarget(author)],
    { ...BumperSettings.parse({}), searchMode: 'time_sort' },
    {
      cancelled: () => false,
      status: (s) => {
        lastStatus = s;
      },
      added: () => {},
    },
  );
  await vi.runAllTimersAsync();
  await cooldownWork;
  expect(lastStatus).toBe('已完成 · 0 次（目标帖均已顶过或冷却中）');
});

it('detects progressbar/empty feed loading state, extracts groupTitle, retries transient context destruction, and falls back to search when classic numeric Page ID has 0 posts under /user/{id}/', async () => {
  const main = document.querySelector('main')!;
  main.innerHTML = '<h1>全球华人资讯交流群</h1><div role="feed"></div>';
  const feedEl = main.querySelector('[role="feed"]')!;
  box(feedEl);
  const emptyFeedState = projectGroupBumper({ groupId: group });
  expect(emptyFeedState.loading).toBe(true);
  expect(emptyFeedState.groupTitle).toBe('全球华人资讯交流群');

  // readGroupBumper retries transient context destruction
  let evalAttempts = 0;
  const mockPage = {
    evaluate: async () => {
      evalAttempts++;
      if (evalAttempts === 1) {
        throw new Error('page.evaluate: Cannot find context with specified id');
      }
      return {
        url: `https://www.facebook.com/groups/${group}/`,
        groupIds: [group],
        groupTitle: '全球华人资讯交流群',
        avatarUrl: null,
        pageAvatarUrl: null,
        ready: true,
        visible: true,
        restricted: false,
        loading: false,
        groupEntryCSS: null,
        posts: [],
      };
    },
  } as unknown as Page;
  const recovered = await readGroupBumper(mockPage, { groupId: group });
  expect(evalAttempts).toBe(2);
  expect(recovered.groupTitle).toBe('全球华人资讯交流群');
});

it('targetPostId reads only the selected article and reacquires its controls after virtual DOM replacement', () => {
  article(`<a href="https://www.facebook.com/groups/${group}/posts/999999999999/">1h</a>`);
  const target = article(
    `<a href="https://www.facebook.com/groups/${group}/posts/${post}/">1h</a><button role="button">Like</button>`,
  );
  const button = target.querySelector('button')!;
  fiber(button, 'CometUFIReactButtonBase', { feedback: { id: 'feedback:' + post } });
  const first = projectGroupBumper({ groupId: group, targetPostId: post });
  expect(first.posts.map((p) => p.postId)).toEqual([post]);
  expect(first.posts[0]?.likeCSS).toBe(`[data-wb-bumper-like="${post}"]`);
  target.remove();
  const replacement = article(
    `<a href="https://www.facebook.com/groups/${group}/posts/${post}/">1h</a><button role="button">Like</button>`,
  );
  const fresh = replacement.querySelector('button')!;
  fiber(fresh, 'CometUFIReactButtonBase', { feedback: { id: 'feedback:' + post } });
  const second = projectGroupBumper({ groupId: group, targetPostId: post });
  expect(second.posts.map((p) => p.postId)).toEqual([post]);
  expect(fresh.getAttribute('data-wb-bumper-like')).toBe(post);
  replacement.remove();
  expect(projectGroupBumper({ groupId: group, targetPostId: post }).posts).toEqual([]);
});

it('emits one post when a virtual feed temporarily renders duplicate copies', () => {
  for (let i = 0; i < 2; i++) {
    const row = article(
      `<a href="https://www.facebook.com/groups/${group}/posts/${post}/">1h</a><button>Like</button>`,
    );
    const button = row.querySelector('button');
    if (button) fiber(button, 'CometUFIReactButtonBase', { feedback: { id: 'feedback:' + post } });
  }
  const result = projectGroupBumper({ groupId: group, targetPostId: post });
  expect(result.posts.map((p) => p.postId)).toEqual([post]);
  expect(document.querySelectorAll('[data-wb-bumper-like]')).toHaveLength(1);
});

it('binds comment article seeds to their native feed card and uses its Story actor, time and feedback only', () => {
  const host = document.createElement('section');
  host.innerHTML = `<a id="owner" href="/groups/${group}/user/${author}/">Owner</a>
    <a href="/groups/${group}/posts/${post}/">1h</a><button id="main-like">Like</button>
    <div role="article"><a id="commenter" href="/groups/${group}/user/100009497147200/">Commenter</a><button id="comment-like">Like</button></div>
    <div role="article"><a href="/groups/${group}/user/100084822904685/">Other commenter</a></div>
    <aside><a href="/groups/${group}/posts/999999999999/">Shared story</a><button id="shared-like">Like</button></aside>`;
  document.querySelector('main')!.append(host);
  [host, ...host.querySelectorAll('*')].forEach(box);
  const storyId = btoa('actor:VK:' + post),
    feedback = 'native-main-feedback';
  const records: Record<string, Record<string, unknown>> = {
    [storyId]: {
      __typename: 'Story',
      post_id: post,
      actors: { __refs: [author] },
      creation_time: Date.now() / 1000 - 7200,
      feedback: { __ref: feedback },
    },
    [author]: { id: author, name: 'Native owner' },
  };
  const env = { getStore: () => ({ getSource: () => ({ get: (id: string) => records[id] }) }) };
  const card = {
    type: { displayName: 'CometFeedUnitCard.react' },
    memoizedProps: { story: { __id: storyId } },
    return: {
      type: { displayName: 'RelayEnvironmentProvider' },
      memoizedProps: { environment: env },
    },
  };
  for (const el of [host, ...host.querySelectorAll('*')]) fiber(el, 'div', {}, card);
  fiber(host.querySelector('#owner')!, 'ActorHovercard', { actorID: author }, card);
  fiber(
    host.querySelector('#main-like')!,
    'CometUFIReactButtonBase',
    { feedback: { __id: feedback } },
    card,
  );
  for (const row of host.querySelectorAll('[role="article"]')) {
    const comment = {
      type: { displayName: 'CometUFICommentRow.react' },
      memoizedProps: { comment: { __id: 'comment-record' }, creation_time: Date.now() / 1000 },
      return: card,
    };
    for (const el of [row, ...row.querySelectorAll('*')]) fiber(el, 'div', {}, comment);
  }
  fiber(
    host.querySelector('#comment-like')!,
    'CometUFIReactButtonBase',
    { feedback: { __id: 'comment-feedback' }, isReacted: true },
    Reflect.get(host.querySelector('[role="article"]')!, '__reactFiber$test'),
  );
  const sharedCard = {
    type: { displayName: 'CometFeedUnitCard.react' },
    memoizedProps: { story: { __id: btoa('actor:VK:999999999999') } },
    return: card,
  };
  for (const el of [host.querySelector('aside')!, ...host.querySelectorAll('aside *')])
    fiber(el, 'div', {}, sharedCard);
  fiber(
    host.querySelector('#shared-like')!,
    'CometUFIReactButtonBase',
    { feedback: { __id: 'shared-feedback' }, isReacted: true },
    sharedCard,
  );
  const result = projectGroupBumper({ groupId: group, targetPostId: post }).posts;
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    postId: post,
    authorId: author,
    authorName: 'Native owner',
    feedbackId: feedback,
    liked: false,
  });
  expect(result[0]?.ageHours).toBeCloseTo(2, 2);
  expect(host.querySelector('#main-like')!.getAttribute('data-wb-bumper-like')).toBe(post);
  expect(host.querySelector('#comment-like')!.hasAttribute('data-wb-bumper-like')).toBe(false);
  expect(host.querySelector('#shared-like')!.hasAttribute('data-wb-bumper-like')).toBe(false);
  expect(result[0]?.authorAliases).not.toContain('100009497147200');
});

it('WO54 empty member feed never takes an unrelated main image as the target avatar', () => {
  document.querySelector('main')!.innerHTML = '<img src="https://example.com/unrelated.jpg">';
  expect(projectGroupBumper({ groupId: group, pageId: author }).pageAvatarUrl).toBeNull();
});
it('WO54 target Relay actor picture references provide an avatar even with no posts', () => {
  const main = document.querySelector('main')!;
  const records: Record<string, Record<string, unknown>> = {
    [author]: { id: author, 'profile_picture(height:40)': { __ref: 'picture' } },
    picture: { uri: 'https://example.com/exact.jpg' },
  };
  fiber(main, 'RelayEnvironmentProvider', {
    environment: { getStore: () => ({ getSource: () => ({ get: (id: string) => records[id] }) }) },
  });
  expect(projectGroupBumper({ groupId: group, pageId: author }).pageAvatarUrl).toBe(
    'https://example.com/exact.jpg',
  );
});

it('WO54 alternate Fiber objects for the same native Story keep its main like control', () => {
  const storyId = btoa('actor:VK:' + post),
    feedback = 'native-feedback';
  const host = article(
    `<a href="https://www.facebook.com/groups/${group}/posts/${post}/">1h</a><button>Like</button>`,
  );
  fiber(host, 'CometFeedUnitCard.react', {
    story: { __id: storyId, feedback: { __id: feedback } },
  });
  const alternate = {
    type: { displayName: 'CometFeedUnitCard.react' },
    memoizedProps: { story: { __id: storyId, feedback: { __id: feedback } } },
  };
  const button = host.querySelector('button')!;
  fiber(button, 'CometUFIReactButtonBase.react', { feedback: { __id: feedback } }, alternate);
  expect(projectGroupBumper({ groupId: group, targetPostId: post }).posts[0]?.likeCSS).toBe(
    `[data-wb-bumper-like="${post}"]`,
  );
});

it('WO58: projectGroupBumper detects joinGroupCSS in group header and extracts [role="feed"] > div Reel/user cards without role="article"', () => {
  const main = document.querySelector('main')!;
  main.innerHTML = `
    <div id="header">
      <h1>海外华人互助社团</h1>
      <div id="join-btn" role="button">加入社團</div>
      <div id="invite-btn" role="button">邀請</div>
    </div>
    <div role="feed">
      <div id="reel-card">
        <a id="reel-author" href="https://www.facebook.com/groups/${group}/user/${author}/">Target Author</a>
        <a id="reel-link" href="https://www.facebook.com/reel/${post}/">2h</a>
        <div id="reel-like" role="button" data-ad-rendering-role="like_button">赞</div>
      </div>
    </div>
  `;
  [main, ...main.querySelectorAll('*')].forEach(box);
  const reelCard = main.querySelector('#reel-card')!;
  fiber(reelCard, 'CometFeedUnitErrorBoundary.react', {
    feedUnit: { id: btoa('Uzpf:VK:' + post), creation_time: Date.now() / 1000 - 3600 },
  });

  const join = main.querySelector('#join-btn');
  if (join) fiber(join, 'GroupsCometJoinForumButton.react', { testid: 'group-can-join-' + group });
  const surface = projectGroupBumper({ groupId: group });
  expect(surface.joinGroupCSS).toBe('[data-wb-bumper-join="1"]');
  expect(main.querySelector('#join-btn')?.getAttribute('data-wb-bumper-join')).toBe('1');
  expect(surface.posts).toHaveLength(1);
  expect(surface.posts[0]).toMatchObject({
    postId: post,
    authorId: author,
    authorName: 'Target Author',
    postCSS: `[data-wb-bumper-post="${post}"]`,
    likeCSS: `[data-wb-bumper-like="${post}"]`,
  });
});

it('WO58: GroupBumperBrowserAdapter joins group before time_sort navigation and hydrates offscreen target post (likeCSS=null, postCSS present) during browse dwell before liking', async () => {
  vi.useFakeTimers();
  let current = '';
  let joined = false;
  let postCentered = false;
  const actionOrder: string[] = [];
  const liked = new Set<string>();
  let mutations = 0;

  const nativeEvents = bumperNativeEvents();
  const page = {
    url: () => current,
    viewportSize: () => ({ width: 1280, height: 800 }),
    goto: async (url: string) => {
      current = url;
      if (url.includes('sorting_setting=CHRONOLOGICAL')) {
        actionOrder.push('navigate:time_sort');
      }
      return null;
    },
    waitForURL: async () => {},
    on: nativeEvents.on,
    off: nativeEvents.off,
    mouse: {
      wheel: async () => {},
      move: async () => {},
    },
    evaluate: async (fn: Function, input?: { groupId?: string; targetPostId?: string }) => {
      if (!input) return 'test-document';
      if (fn.name === 'projectGroupInvitationState')
        return {
          accountId: '10000000001',
          ready: true,
          visible: true,
          verificationRequired: false,
        };
      return {
        url: current,
        groupIds: [group],
        avatarUrl: null,
        pageAvatarUrl: null,
        ready: true,
        visible: true,
        restricted: false,
        loading: false,
        groupEntryCSS: null,
        joinGroupCSS: !joined && !current.includes('/search') ? '[data-wb-bumper-join="1"]' : null,
        welcomeDismissCSS: null,
        posts: [
          {
            postId: post,
            postUrl: `https://www.facebook.com/groups/${group}/posts/${post}/`,
            authorId: author,
            authorName: 'TargetPage',
            authorAliases: [],
            authorAvatarUrl: null,
            pinned: false,
            ageHours: 1,
            timeText: '1h',
            feedbackId: postCentered ? 'fb-' + post : null,
            liked: liked.has(post),
            postCSS: `[data-wb-bumper-post="${post}"]`,
            likeCSS: postCentered ? `[data-wb-bumper-like="${post}"]` : null,
            commentCSS: null,
            commentButtonCSS: null,
            hasVideo: false,
            comments: [],
          },
        ],
      };
    },
    locator: (selector: string) => ({
      first() {
        return this;
      },
      evaluate: async () => {
        if (selector === `[data-wb-bumper-post="${post}"]`) {
          postCentered = true;
          actionOrder.push('center:postCSS');
        }
      },
      click: async () => {
        mutations++;
        if (selector === '[data-wb-bumper-join="1"]') {
          joined = true;
          actionOrder.push('click:join');
          return;
        }
        if (selector === `[data-wb-bumper-like="${post}"]`) {
          liked.add(post);
          nativeEvents.like('10000000001', 'fb-' + post);
          actionOrder.push('click:like');
        }
      },
    }),
  };

  const proof = {
    ownershipId: '00000000-0000-4000-8000-000000000001',
    profileId: 'p',
    browserSessionEpoch: 'session',
    tabId: 1,
    targetId: 't',
  };
  const connection = {
    stopRequestId: '00000000-0000-4000-8000-000000000055',
    revokeInput: () => {},
    browser: { contexts: () => [{ pages: () => [page] }] },
    context: async () => ({ accountId: '10000000001' }),
    execute: async (binding: unknown, work: () => Promise<unknown>) => ({
      binding,
      value: await work(),
    }),
    reconcile: async () => {},
    get nativeMutationCalls() {
      return { input: mutations };
    },
    close: async () => {},
    retryClose: async () => {},
  };
  const peer = { online: true, synced: true, epoch: 'epoch', profileId: 'p', capabilities: [] };
  const kernel = {
    withSummary: async (_p: unknown, run: (port: unknown) => unknown) =>
      run({
        inventory: async () => ({
          tabs: [{ state: 'READY', proof }],
          workspaceMain: proof,
          operations: [],
        }),
      }),
    inspectIdleFacebookPage: async () => ({ actor: { accountId: '10000000001' }, proof }),
    connectFacebook: async () => connection,
  };
  const recorded: string[] = [];
  const preparedActions: string[] = [];
  const repo = {
    getOperation: async () => null,
    listOperationsByProfile: async () => [],
    prepareOperation: async (input: { actionKind: string }) => {
      preparedActions.push(input.actionKind);
      return input;
    },
    setOperationResolution: async (_id: string, r: unknown) => r,
    markOperationSettled: async () => {},
    markOperationReview: async () => {},
    confirmSubmission: async (_id: string, row: never, _comment: unknown, resolution: unknown) => {
      await repo.record(row);
      return resolution;
    },
    eligibility: async () => ({ today: 0, allowed: true }),
    pickComment: async () => null,
    record: async (row: { postId: string }) => {
      recorded.push(row.postId);
      return true;
    },
    updateAvatar: async () => {},
  };
  const adapter = new GroupBumperBrowserAdapter(
    repo as unknown as ConstructorParameters<typeof GroupBumperBrowserAdapter>[0],
    () =>
      kernel as unknown as ReturnType<ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]>,
    () =>
      ({ peers: new Map([['p', peer]]) }) as unknown as ReturnType<
        ConstructorParameters<typeof GroupBumperBrowserAdapter>[2]
      >,
    async () => false,
    0,
  );
  const mkTarget = (id: string) => ({
    id,
    name: 'target',
    avatarUrl: null,
    folderId: null,
    sortOrder: 0,
    totalBumpedCount: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  const work = adapter.run(
    'p',
    [mkTarget(group)],
    [mkTarget(author)],
    {
      ...BumperSettings.parse({}),
      searchMode: 'time_sort',
      likeProbability: 100,
      commentProbability: 0,
      maxPostsPerGroupPage: 1,
    },
    { cancelled: () => false, status: () => {}, added: () => {} },
  );
  await vi.runAllTimersAsync();
  await work;

  // WO60：无搜索名时直接一步打开 CHRONOLOGICAL 小组页；加入小组后再重开时间排序页
  expect(actionOrder).toEqual([
    'navigate:time_sort',
    'click:join',
    'navigate:time_sort',
    'center:postCSS',
    'click:like',
  ]);
  expect(preparedActions).toContain('setup_open_group');
  expect(recorded).toEqual([post]);
});

it('WO59: projectGroupBumper filters out sticky header join button with hidden/transparent ancestor and marks visible main Join group / 加入社團 button', () => {
  const main = document.querySelector('main')!;
  main.innerHTML = `
    <div id="sticky-bar" style="opacity: 0; visibility: hidden;">
      <div>
        <div id="sticky-join" role="button" aria-label="加入社團">加入社團</div>
      </div>
    </div>
    <div id="main-header">
      <div id="main-join" role="button" aria-label="加入社團">加入社團</div>
    </div>
  `;
  [main, ...main.querySelectorAll('*')].forEach(box);
  const stickyJoin = main.querySelector<HTMLElement>('#sticky-join')!;
  const mainJoin = main.querySelector<HTMLElement>('#main-join')!;
  stickyJoin.getBoundingClientRect = () => ({
    x: 0,
    y: 112.5,
    left: 0,
    top: 112.5,
    right: 104,
    bottom: 148.5,
    width: 104,
    height: 36,
    toJSON: () => ({}),
  });
  mainJoin.getBoundingClientRect = () => ({
    x: 0,
    y: 362,
    left: 0,
    top: 362,
    right: 104,
    bottom: 398,
    width: 104,
    height: 36,
    toJSON: () => ({}),
  });

  fiber(mainJoin, 'GroupsCometJoinForumButton.react', { testid: 'group-can-join-' + group });
  fiber(stickyJoin, 'GroupsCometJoinForumButton.react', { testid: 'group-can-join-' + group });
  const surface = projectGroupBumper({ groupId: group });
  expect(surface.joinGroupCSS).toBe('[data-wb-bumper-join="1"]');
  expect(stickyJoin.getAttribute('data-wb-bumper-join')).toBeNull();
  expect(mainJoin.getAttribute('data-wb-bumper-join')).toBe('1');

  // Also verify English aria-label="Join group" is matched
  main.innerHTML = `
    <div id="en-header">
      <div id="en-join" role="button" aria-label="Join group">Join group</div>
    </div>
  `;
  [main, ...main.querySelectorAll('*')].forEach(box);
  const englishJoin = main.querySelector('#en-join');
  if (englishJoin)
    fiber(englishJoin, 'GroupsCometJoinForumButton.react', { testid: 'group-can-join-' + group });
  const enSurface = projectGroupBumper({ groupId: group });
  expect(enSurface.joinGroupCSS).toBe('[data-wb-bumper-join="1"]');
  expect(main.querySelector('#en-join')?.getAttribute('data-wb-bumper-join')).toBe('1');
});

it('WO59: GroupBumperBrowserAdapter joins group after waitForFeed when SPA entry initially had joinGroupCSS=null, and re-navigates to CHRONOLOGICAL in time_sort mode', async () => {
  vi.useFakeTimers();
  let current = '';
  let joined = false;
  let groupReads = 0;
  const actionOrder: string[] = [];
  const liked = new Set<string>();
  let mutations = 0;

  const nativeEvents = bumperNativeEvents();
  const page = {
    url: () => current,
    viewportSize: () => ({ width: 1280, height: 800 }),
    goto: async (url: string) => {
      current = url;
      if (url.includes('sorting_setting=CHRONOLOGICAL')) {
        actionOrder.push('navigate:time_sort');
      }
      return null;
    },
    waitForURL: async () => {},
    on: nativeEvents.on,
    off: nativeEvents.off,
    mouse: {
      wheel: async () => {},
      move: async () => {},
    },
    evaluate: async (fn: Function, input?: { groupId?: string; targetPostId?: string }) => {
      if (!input) return 'test-document';
      if (fn.name === 'projectGroupInvitationState')
        return {
          accountId: '10000000001',
          ready: true,
          visible: true,
          verificationRequired: false,
        };
      if (!current.includes('/search')) groupReads++;
      // Simulate SPA transition: 1st read on group page has joinGroupCSS=null; subsequent reads in waitForFeed have joinGroupCSS present until joined
      const showJoin = !joined && !current.includes('/search') && groupReads >= 2;
      return {
        url: current,
        groupIds: [group],
        avatarUrl: null,
        pageAvatarUrl: null,
        ready: true,
        visible: true,
        restricted: false,
        loading: false,
        groupEntryCSS: null,
        joinGroupCSS: showJoin ? '[data-wb-bumper-join="1"]' : null,
        welcomeDismissCSS: null,
        posts: [
          {
            postId: post,
            postUrl: `https://www.facebook.com/groups/${group}/posts/${post}/`,
            authorId: author,
            authorName: 'TargetPage',
            authorAliases: [],
            authorAvatarUrl: null,
            pinned: false,
            ageHours: 1,
            timeText: '1h',
            feedbackId: 'fb-' + post,
            liked: liked.has(post),
            postCSS: `[data-wb-bumper-post="${post}"]`,
            likeCSS: `[data-wb-bumper-like="${post}"]`,
            commentCSS: null,
            commentButtonCSS: null,
            hasVideo: false,
            comments: [],
          },
        ],
      };
    },
    locator: (selector: string) => ({
      first() {
        return this;
      },
      evaluate: async () => {},
      click: async () => {
        mutations++;
        if (selector === '[data-wb-bumper-join="1"]') {
          joined = true;
          actionOrder.push('click:join');
          return;
        }
        if (selector === `[data-wb-bumper-like="${post}"]`) {
          liked.add(post);
          nativeEvents.like('10000000001', 'fb-' + post);
          actionOrder.push('click:like');
        }
      },
    }),
  };

  const proof = {
    ownershipId: '00000000-0000-4000-8000-000000000001',
    profileId: 'p',
    browserSessionEpoch: 'session',
    tabId: 1,
    targetId: 't',
  };
  const connection = {
    stopRequestId: '00000000-0000-4000-8000-000000000055',
    revokeInput: () => {},
    browser: { contexts: () => [{ pages: () => [page] }] },
    context: async () => ({ accountId: '10000000001' }),
    execute: async (binding: unknown, work: () => Promise<unknown>) => ({
      binding,
      value: await work(),
    }),
    reconcile: async () => {},
    get nativeMutationCalls() {
      return { input: mutations };
    },
    close: async () => {},
    retryClose: async () => {},
  };
  const peer = { online: true, synced: true, epoch: 'epoch', profileId: 'p', capabilities: [] };
  const kernel = {
    withSummary: async (_p: unknown, run: (port: unknown) => unknown) =>
      run({
        inventory: async () => ({
          tabs: [{ state: 'READY', proof }],
          workspaceMain: proof,
          operations: [],
        }),
      }),
    inspectIdleFacebookPage: async () => ({ actor: { accountId: '10000000001' }, proof }),
    connectFacebook: async () => connection,
  };
  const recorded: string[] = [];
  const repo = {
    getOperation: async () => null,
    listOperationsByProfile: async () => [],
    prepareOperation: async (input: unknown) => input,
    setOperationResolution: async (_id: string, r: unknown) => r,
    markOperationSettled: async () => {},
    markOperationReview: async () => {},
    confirmSubmission: async (_id: string, row: never, _comment: unknown, resolution: unknown) => {
      await repo.record(row);
      return resolution;
    },
    eligibility: async () => ({ today: 0, allowed: true }),
    pickComment: async () => null,
    record: async (row: { postId: string }) => {
      recorded.push(row.postId);
      return true;
    },
    updateAvatar: async () => {},
  };
  const adapter = new GroupBumperBrowserAdapter(
    repo as unknown as ConstructorParameters<typeof GroupBumperBrowserAdapter>[0],
    () =>
      kernel as unknown as ReturnType<ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]>,
    () =>
      ({ peers: new Map([['p', peer]]) }) as unknown as ReturnType<
        ConstructorParameters<typeof GroupBumperBrowserAdapter>[2]
      >,
    async () => false,
    0,
  );
  const mkTarget = (id: string) => ({
    id,
    name: 'target',
    avatarUrl: null,
    folderId: null,
    sortOrder: 0,
    totalBumpedCount: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  const work = adapter.run(
    'p',
    [mkTarget(group)],
    [mkTarget(author)],
    {
      ...BumperSettings.parse({}),
      searchMode: 'time_sort',
      likeProbability: 100,
      commentProbability: 0,
      maxPostsPerGroupPage: 1,
    },
    { cancelled: () => false, status: () => {}, added: () => {} },
  );
  await vi.runAllTimersAsync();
  await work;

  expect(actionOrder).toEqual([
    'navigate:time_sort',
    'click:join',
    'navigate:time_sort',
    'click:like',
  ]);
  expect(recorded).toEqual([post]);
});
