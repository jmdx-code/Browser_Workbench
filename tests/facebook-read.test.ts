import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import {
  kernelAccessURL,
  kernelFacebookReadURL,
  assertKernelSessionCommand,
} from '../src/shared/kernel-policy.js';
import {
  PageReadRequest,
  validateProjection,
  type PageProjection,
  type PageProjectionRequest,
} from '../src/shared/page-read.js';
import { KernelLease } from '../src/domain/kernel-lease.js';
import { KernelExecutor } from '../src/application/kernel-executor.js';
import {
  KernelJsonObject,
  type KernelBackend,
  type KernelStamp,
} from '../src/shared/kernel-protocol.js';
import { analyzeFacebookIdentityPage } from '../src/domain/facebook-page-analysis.js';
import { facebookIdentityProjection } from '../src/infrastructure/facebook-read-adapter.js';
import { pageProjectionExpression } from '../extension/page-projection.js';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import { ChromeKernelBackend, type KernelNativeBackend } from '../extension/kernel-backend.js';
import type { TabProof } from '../src/shared/kernel-state.js';
import { sampleFacebookPage } from '../src/application/page-read-sampler.js';

const query = PageReadRequest.parse({
  queries: [
    { key: 'identity', selector: '[role="banner"] a', limit: 1, text: true, attributes: ['href'] },
  ],
});
function page(request: PageProjectionRequest = query): PageProjection {
  return {
    url: 'https://www.facebook.com/',
    timeOrigin: 1000,
    ready: 'complete',
    visibility: 'hidden',
    rows: request.queries.map((item) => ({ key: item.key, nodes: [] })),
  };
}
function native() {
  const stamp: KernelStamp = {
    profileId: randomUUID(),
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 0,
    expiresAt: Date.now() + 10_000,
  };
  const lease = new KernelLease(stamp.profileId, stamp.connectionEpoch);
  const calls: string[] = [];
  let blockedScope: Promise<void> | undefined;
  let projection: PageProjection = page();
  const backend: KernelBackend = {
    scope: async () => {
      if (blockedScope) await blockedScope;
    },
    attach: async () => ({
      targetId: 'owned',
      type: 'page',
      title: '',
      url: 'https://www.facebook.com/',
      attached: true,
    }),
    detach: async () => {
      calls.push('detach');
    },
    create: async () => ({ tabId: 7 }),
    remove: async () => {
      calls.push('remove');
    },
    send: async (_target, method) => {
      calls.push(method);
      return {};
    },
    project: async () => {
      calls.push('project');
      return projection;
    },
  };
  const executor = new KernelExecutor(lease, backend, [7], new Set(), 'facebook-readonly');
  executor.grant(stamp);
  return {
    executor,
    stamp,
    calls,
    blockScope: (value: Promise<void>) => {
      blockedScope = value;
    },
    setPage: (value: PageProjection) => {
      projection = value;
    },
  };
}

test('Facebook read URL scope rejects alternate hosts, credentials, other ports, schemes and fixture escalation', () => {
  assert.equal(kernelFacebookReadURL('https://www.facebook.com/checkpoint/'), true);
  for (const url of [
    'http://www.facebook.com/',
    'https://facebook.com/',
    'https://www.facebook.com.evil.test/',
    'https://user@www.facebook.com/',
    'https://www.facebook.com:444/',
    'about:blank',
  ])
    assert.equal(kernelFacebookReadURL(url), false, url);
  assert.equal(kernelAccessURL('https://www.facebook.com/', 'fixture'), false);
  assert.equal(
    kernelAccessURL('http://127.0.0.1:18767/kernel-fixture', 'facebook-readonly'),
    false,
  );
});
test('initial uncommitted document can be sampled again, with all reads tied to current context', async () => {
  let reads = 0,
    waits = 0;
  const ready = page();
  ready.rows[0]?.nodes.push({ tag: 'a', text: 'Profile', visible: true, attributes: {} });
  const result = await sampleFacebookPage(query, {
    assertCurrent: () => {},
    read: async () => {
      if (++reads === 1) throw Error('KERNEL_SCOPE_CHANGED');
      return ready;
    },
    wait: async () => {
      waits++;
    },
  });
  assert.deepEqual(result, ready);
  assert.equal(reads, 2);
  assert.equal(waits, 1);
});
test('foreign document result and malformed response are rejected without polling them again', async () => {
  for (const result of [{ ...page(), url: 'https://evil.test/' }, { unexpected: true }]) {
    let reads = 0,
      waits = 0;
    await assert.rejects(
      sampleFacebookPage(query, {
        assertCurrent: () => {},
        read: async () => {
          reads++;
          return result;
        },
        wait: async () => {
          waits++;
        },
      }),
    );
    assert.equal(reads, 1);
    assert.equal(waits, 0);
  }
});
test('context replacement during load waiting prevents another native read', async () => {
  let current = true,
    reads = 0;
  await assert.rejects(
    sampleFacebookPage(query, {
      assertCurrent: () => {
        if (!current) throw Error('CONTEXT_CHANGED');
      },
      read: async () => {
        reads++;
        throw Error('KERNEL_SCOPE_CHANGED');
      },
      wait: async () => {
        current = false;
      },
    }),
    /CONTEXT_CHANGED/,
  );
  assert.equal(reads, 1);
});
test('initial scope rejection has a finite sampling budget and never creates a new tab or reopens a lease', async () => {
  let reads = 0,
    waits = 0;
  await assert.rejects(
    sampleFacebookPage(query, {
      assertCurrent: () => {},
      read: async () => {
        reads++;
        throw Error('KERNEL_SCOPE_CHANGED');
      },
      wait: async () => {
        waits++;
      },
    }),
    /SCOPE_CHANGED/,
  );
  assert.equal(reads, 16);
  assert.equal(waits, 15);
});
test('read scope rejects Runtime scripts, input, uploads, dialogs, navigation and profile-level commands', () => {
  for (const method of [
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'Input.dispatchMouseEvent',
    'Input.insertText',
    'DOM.setFileInputFiles',
    'Page.navigate',
    'Page.bringToFront',
    'Page.handleJavaScriptDialog',
    'Browser.close',
    'Network.getResponseBody',
  ])
    assert.throws(
      () => assertKernelSessionCommand(method, {}, new Set(), 'facebook-readonly'),
      /READONLY/,
    );
  assert.deepEqual(
    assertKernelSessionCommand('Page.enable', {}, new Set(), 'facebook-readonly'),
    {},
  );
});
test('declarative projection rejects arbitrary properties, scripts, oversized requests and duplicate keys', () => {
  assert.equal(
    PageReadRequest.safeParse({ ...query, expression: 'document.cookie' }).success,
    false,
  );
  assert.equal(
    PageReadRequest.safeParse({ queries: [{ ...query.queries[0], attributes: ['value'] }] })
      .success,
    false,
  );
  assert.equal(
    PageReadRequest.safeParse({ queries: [query.queries[0], query.queries[0]] }).success,
    false,
  );
  assert.equal(
    PageReadRequest.safeParse({ queries: [{ ...query.queries[0], limit: 100 }] }).success,
    false,
  );
});
test('projection response must match exact query order, requested attributes, text permission and node limits', () => {
  const result = page();
  assert.deepEqual(validateProjection(query, result), result);
  assert.throws(() => validateProjection(query, { ...result, rows: [] }), /MISMATCH/);
  const node = { tag: 'a', text: '', visible: true, attributes: { value: 'secret' } };
  assert.throws(
    () => validateProjection(query, { ...result, rows: [{ key: 'identity', nodes: [node] }] }),
    /MISMATCH/,
  );
  const noText = PageReadRequest.parse({ queries: [{ ...query.queries[0], text: false }] });
  assert.throws(
    () =>
      validateProjection(noText, {
        ...result,
        rows: [{ key: 'identity', nodes: [{ ...node, text: 'unexpected', attributes: {} }] }],
      }),
    /MISMATCH/,
  );
  assert.throws(
    () =>
      validateProjection(query, {
        ...result,
        rows: [
          {
            key: 'identity',
            nodes: [
              { ...node, attributes: {} },
              { ...node, attributes: {} },
            ],
          },
        ],
      }),
    /MISMATCH/,
  );
});
test('oversized multi-byte response cannot overflow the private transport envelope', () => {
  const request = PageReadRequest.parse({
    queries: Array.from({ length: 24 }, (_, index) => ({
      ...query.queries[0],
      key: 'query' + index,
      limit: 8,
    })),
  });
  const result = page(request);
  for (const row of result.rows)
    row.nodes.push(
      ...Array.from({ length: 8 }, () => ({
        tag: 'a',
        text: '中'.repeat(500),
        visible: true,
        attributes: { href: '中'.repeat(2048) },
      })),
    );
  assert.throws(() => validateProjection(request, result), /TOO_LARGE/);
});
test('fixed projection treats malicious selector characters as data and never reads form values or executes input', () => {
  const malicious = 'x");globalThis.executed=true;//';
  const request = PageReadRequest.parse({
    queries: [{ ...query.queries[0], selector: malicious }],
  });
  let observed = '';
  const value: unknown = runInNewContext(pageProjectionExpression(request), {
    location: { href: 'https://www.facebook.com/' },
    performance: { timeOrigin: 1000 },
    document: {
      readyState: 'complete',
      visibilityState: 'visible',
      querySelectorAll: (selector: string) => {
        observed = selector;
        return [
          {
            tagName: 'A',
            textContent: 'Example',
            value: 'credential',
            getAttribute: (key: string) => (key === 'href' ? '/profile.php?id=42' : null),
            getBoundingClientRect: () => ({ width: 10, height: 10 }),
          },
        ];
      },
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  const result = validateProjection(request, value);
  assert.equal(observed, malicious);
  assert.equal(JSON.stringify(result).includes('credential'), false);
  assert.equal(result.rows[0]?.nodes[0]?.attributes.href, '/profile.php?id=42');
});
test('only attached owned top-level target can be projected', async () => {
  const { executor, calls } = native();
  await assert.rejects(executor.project(7, query), /NOT_OWNED/);
  await executor.attach(7);
  await assert.rejects(executor.project(99, query), /NOT_OWNED/);
  assert.equal((await executor.project(7, query)).url, 'https://www.facebook.com/');
  assert.deepEqual(calls, ['project']);
});
test('stop during asynchronous scope check fences projection before native page evaluation', async () => {
  const fixture = native();
  await fixture.executor.attach(7);
  let unblock: (() => void) | undefined;
  fixture.blockScope(
    new Promise<void>((resolve) => {
      unblock = resolve;
    }),
  );
  const reading = fixture.executor.project(7, query);
  const stopped = fixture.executor.stop(randomUUID());
  unblock?.();
  await assert.rejects(reading, /FENCED/);
  assert.equal((await stopped).state, 'stopped');
  assert.equal(fixture.calls.includes('project'), false);
});
test('foreign page response fails scope and cannot become identity evidence', async () => {
  const fixture = native();
  await fixture.executor.attach(7);
  fixture.setPage({ ...page(), url: 'https://evil.test/' });
  await assert.rejects(fixture.executor.project(7, query), /SCOPE_CHANGED/);
});
test('fixture executor cannot gain Facebook projection through the new optional method', async () => {
  const fixture = native();
  const backend: KernelBackend = {
    scope: async () => {},
    attach: async () => ({
      targetId: 'fixture',
      type: 'page',
      title: '',
      url: 'about:blank',
      attached: true,
    }),
    detach: async () => {},
    create: async () => ({ tabId: 7 }),
    remove: async () => {},
    send: async () => ({}),
    project: async () => page(),
  };
  const executor = new KernelExecutor(
    new KernelLease(fixture.stamp.profileId, fixture.stamp.connectionEpoch),
    backend,
    [7],
  );
  executor.grant(fixture.stamp);
  await executor.attach(7);
  await assert.rejects(executor.project(7, query), /UNAVAILABLE/);
});
test('avatar, candidate numeric profile ID or display name never proves current acting account', () => {
  const projection = page(facebookIdentityProjection);
  const links = projection.rows.find((row) => row.key === 'accountLinks');
  assert.ok(links);
  links.nodes.push({
    tag: 'a',
    visible: true,
    text: 'Other profile',
    attributes: { href: '/profile.php?id=42' },
  });
  const result = analyzeFacebookIdentityPage(projection);
  assert.equal(result.candidates[0]?.id, '42');
  assert.equal(result.account.state, 'unknown');
  assert.equal(result.account.id, null);
  assert.equal(result.account.avatar, null);
});
test('logged out requires one visible same-form credential pair on home or login route, without reading credentials', () => {
  const projection = page(facebookIdentityProjection);
  projection.url = 'https://www.facebook.com/login/';
  for (const key of ['loginForm', 'loginEmail', 'loginPassword']) {
    const row = projection.rows.find((item) => item.key === key);
    assert.ok(row);
    row.nodes.push({ tag: 'input', text: '', attributes: {}, visible: true });
  }
  assert.equal(analyzeFacebookIdentityPage(projection).account.state, 'logged-out');
  projection.url = 'https://www.facebook.com/';
  assert.equal(analyzeFacebookIdentityPage(projection).account.state, 'logged-out');
  projection.url = 'https://www.facebook.com/login/';
  projection.ready = 'loading';
  assert.equal(analyzeFacebookIdentityPage(projection).account.state, 'unknown');
});
test('hidden, ambiguous, incomplete or conflicting login evidence cannot mark an account logged out', () => {
  const original = page(facebookIdentityProjection);
  for (const key of ['loginForm', 'loginEmail', 'loginPassword'])
    original.rows
      .find((row) => row.key === key)
      ?.nodes.push({
        tag: key === 'loginForm' ? 'form' : 'input',
        text: '',
        visible: true,
        attributes: {},
      });
  for (const key of ['loginForm', 'loginEmail', 'loginPassword']) {
    const projection = structuredClone(original);
    const node = projection.rows.find((row) => row.key === key)?.nodes[0];
    assert.ok(node);
    node.visible = false;
    assert.equal(analyzeFacebookIdentityPage(projection).account.state, 'unknown');
  }
  for (const change of ['two-forms', 'profile-link', 'registration', 'interactive']) {
    const projection = structuredClone(original);
    if (change === 'two-forms')
      projection.rows
        .find((row) => row.key === 'loginForm')
        ?.nodes.push({
          tag: 'form',
          text: '',
          visible: true,
          attributes: {},
        });
    if (change === 'profile-link')
      projection.rows
        .find((row) => row.key === 'accountLinks')
        ?.nodes.push({
          tag: 'a',
          text: 'Profile',
          visible: true,
          attributes: { href: '/profile.php?id=42' },
        });
    if (change === 'registration') projection.url = 'https://www.facebook.com/reg/';
    if (change === 'interactive') projection.ready = 'interactive';
    assert.equal(analyzeFacebookIdentityPage(projection).account.state, 'unknown', change);
  }
});
test('checkpoint means verification; access restriction route is not guessed as banned', () => {
  const projection = page(facebookIdentityProjection);
  projection.url = 'https://www.facebook.com/checkpoint/';
  assert.equal(analyzeFacebookIdentityPage(projection).account.state, 'verification');
  projection.url = 'https://www.facebook.com/disabled/';
  assert.equal(analyzeFacebookIdentityPage(projection).account.state, 'unknown');
  assert.throws(
    () => analyzeFacebookIdentityPage({ ...projection, url: 'https://evil.test/' }),
    /SCOPE_REJECTED/,
  );
});
test('extension read session rejects files and operation begin before journal can authorize business input', async () => {
  const fixture = native();
  const journal = new KernelJournal(new MemoryKernelStorage());
  await journal.initialize(fixture.stamp.profileId, randomUUID());
  const responses: unknown[] = [];
  const backend: KernelNativeBackend = {
    scope: async () => {},
    attach: async () => ({
      targetId: 'fb',
      type: 'page',
      title: '',
      url: 'https://www.facebook.com/',
      attached: true,
    }),
    detach: async () => {},
    create: async () => ({ tabId: 7 }),
    remove: async () => {},
    send: async () => ({}),
    owns: () => true,
    detached: () => {},
    expectedDetach: () => false,
  };
  const channel = new ExtensionKernelChannel(
    () => ({
      profileId: fixture.stamp.profileId,
      epoch: fixture.stamp.connectionEpoch,
      valid: true,
    }),
    (reply) => responses.push(reply),
    () => backend,
    journal,
  );
  let sequence = 0;
  async function rpc(body: Record<string, unknown>) {
    responses.length = 0;
    channel.receive({
      type: 'KERNEL_REQUEST',
      requestId: randomUUID(),
      sequence: ++sequence,
      connectionEpoch: fixture.stamp.connectionEpoch,
      leaseId: fixture.stamp.leaseId,
      ...body,
    });
    for (let attempt = 0; attempt < 20 && !responses.length; attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return KernelJsonObject.parse(responses[0]);
  }
  assert.match(
    String(
      (
        await rpc({
          kind: 'open',
          access: 'facebook-readonly',
          files: ['C:/secret'],
          stamp: fixture.stamp,
        })
      ).error,
    ),
    /FILES_REJECTED/,
  );
  assert.equal(
    (await rpc({ kind: 'open', access: 'facebook-readonly', files: [], stamp: fixture.stamp }))
      .error,
    undefined,
  );
  const binding = {
    ...fixture.stamp,
    expiresAt: undefined,
    accountId: '42',
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: '0'.repeat(64),
  };
  delete binding.expiresAt;
  assert.match(
    String((await rpc({ kind: 'beginOperation', binding })).error),
    /READONLY_OPERATION/,
  );
  assert.equal((await journal.snapshot()).operations.length, 0);
});
test('native read boundary rechecks revocation after asynchronous target lookup, before Runtime evaluation', async () => {
  const journal = new KernelJournal(new MemoryKernelStorage());
  const profileId = randomUUID(),
    epoch = randomUUID();
  await journal.initialize(profileId, epoch);
  const proof: TabProof = {
    profileId,
    browserSessionEpoch: epoch,
    ownershipId: randomUUID(),
    tabId: 7,
    targetId: 'fb',
  };
  await journal.prepareTab(proof.ownershipId, 'https://www.facebook.com/');
  await journal.confirmTab(proof);
  const original = globalThis.chrome;
  let readable = true,
    evaluateCalls = 0,
    lookup = 0;
  const mock = {
    debugger: {
      getTargets: async () => {
        if (++lookup >= 3) readable = false;
        return [
          { tabId: 7, id: 'fb', type: 'page', url: 'https://www.facebook.com/', attached: true },
        ];
      },
      attach: async () => {},
      sendCommand: async (_target: unknown, method: string) => {
        if (method === 'Runtime.evaluate') evaluateCalls++;
        return {
          targetInfo: {
            targetId: 'fb',
            type: 'page',
            title: '',
            url: 'https://www.facebook.com/',
            attached: true,
          },
        };
      },
    },
  };
  try {
    globalThis.chrome = mock as unknown as typeof chrome;
    const backend = new ChromeKernelBackend(
      journal,
      () => false,
      'facebook-readonly',
      () => readable,
    );
    await backend.adopt(proof);
    await backend.attach(7);
    await assert.rejects(backend.project(7, query), /READ_FENCED/);
    assert.equal(evaluateCalls, 0);
    await assert.rejects(
      backend.send({ tabId: 7 }, 'Runtime.evaluate', { expression: 'document.cookie' }),
      /READONLY/,
    );
    assert.equal(evaluateCalls, 0);
  } finally {
    globalThis.chrome = original;
  }
});

test('native readonly removal rechecks lease revocation after target lookup and preserves READY proof', async () => {
  const journal = new KernelJournal(new MemoryKernelStorage());
  const profileId = randomUUID(),
    epoch = randomUUID();
  await journal.initialize(profileId, epoch);
  const proof: TabProof = {
    profileId,
    browserSessionEpoch: epoch,
    ownershipId: randomUUID(),
    tabId: 7,
    targetId: 'fb',
  };
  await journal.prepareTab(proof.ownershipId, 'https://www.facebook.com/');
  await journal.confirmTab(proof);
  const original = globalThis.chrome;
  let readable = true,
    removals = 0,
    lookup = 0;
  try {
    globalThis.chrome = {
      debugger: {
        getTargets: async () => {
          if (++lookup >= 2) readable = false;
          return [
            { tabId: 7, id: 'fb', type: 'page', url: 'https://www.facebook.com/', attached: false },
          ];
        },
      },
      tabs: {
        remove: async () => {
          removals++;
        },
      },
    } as unknown as typeof chrome;
    const backend = new ChromeKernelBackend(
      journal,
      () => false,
      'facebook-readonly',
      () => readable,
    );
    await backend.adopt(proof);
    await assert.rejects(backend.remove(7), /READONLY_LEASE_REJECTED/);
    assert.equal(removals, 0);
    assert.equal((await journal.snapshot()).tabs[0]?.state, 'READY');
  } finally {
    globalThis.chrome = original;
  }
});

test('fixed SVG attribute projection returns only requested xlink href without evaluating page code', () => {
  const request = PageReadRequest.parse({
    queries: [
      { key: 'avatar', selector: 'image', limit: 1, text: false, attributes: ['xlink:href'] },
    ],
  });
  const expression = pageProjectionExpression(request);
  const result: unknown = runInNewContext(expression, {
    location: { href: 'https://www.facebook.com/' },
    performance: { timeOrigin: 1000 },
    document: {
      readyState: 'complete',
      visibilityState: 'hidden',
      querySelectorAll: () => [
        {
          tagName: 'image',
          getBoundingClientRect: () => ({ width: 36, height: 36 }),
          getAttribute: (key: string) =>
            key === 'xlink:href' ? 'https://example.test/avatar.png' : null,
          get textContent() {
            throw Error('TEXT_MUST_NOT_BE_READ');
          },
        },
      ],
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  assert.deepEqual(validateProjection(request, result).rows[0]?.nodes[0]?.attributes, {
    'xlink:href': 'https://example.test/avatar.png',
  });
  assert.equal(
    PageReadRequest.safeParse({ queries: [{ ...request.queries[0], attributes: ['onclick'] }] })
      .success,
    false,
  );
});
