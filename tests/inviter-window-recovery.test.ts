import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Locator } from 'playwright-core';
import {
  clickInvitationControl,
  GroupInviterBrowserAdapter,
} from '../src/infrastructure/group-inviter-runner.js';
import type { GroupInviterRepository } from '../src/application/group-inviter-service.js';
import { kernelJournal } from '../extension/kernel-storage.js';
import { revealBrowserWindow } from '../extension/reveal-browser-window.js';

test('obscured setup controls retry through DOM only after validation, never on cancellation or an already-applied click', async () => {
  for (const mode of ['fallback', 'restricted', 'already-applied', 'other-error']) {
    const calls: string[] = [];
    const control = {
      evaluate: async (fn: Function) => {
        calls.push(fn.toString().includes('scrollIntoView') ? 'center' : 'DOM-click');
      },
      click: async ({ timeout }: { timeout: number }) => {
        assert.equal(timeout, 4000);
        calls.push('coordinate-click');
        throw Error(
          mode === 'other-error' ? 'CONNECTION_CHANGED' : 'locator.click: Timeout 4000ms exceeded',
        );
      },
    } as unknown as Locator;
    const action = clickInvitationControl(control, async () => {
      calls.push('validate');
      if (mode === 'restricted') throw Error('GROUP_INVITER_VERIFICATION_REQUIRED');
      return mode !== 'already-applied';
    });
    if (mode === 'restricted' || mode === 'other-error') await assert.rejects(action);
    else await action;
    assert.equal(calls.includes('DOM-click'), mode === 'fallback');
    assert.equal(calls[0], 'center');
  }
});

test('failed non-submit execution retains its binding for final cleanup rather than losing the journal operation', async () => {
  const adapter = new GroupInviterBrowserAdapter(
    {} as GroupInviterRepository,
    () => undefined,
    () => undefined,
    () => null,
  );
  const pendingSetup = new Map();
  const conn = {
    context: async () => ({}),
    execute: async () => {
      throw Error('locator.click timeout');
    },
  };
  Reflect.get(adapter, 'scopes').set(conn, {
    guard: () => {},
    pendingSetup,
    groupId: '123',
    jobId: randomUUID(),
    stepId: randomUUID(),
    stopId: randomUUID(),
    page: {
      evaluate: async () => ({
        url: 'https://www.facebook.com/groups/123/',
        accountId: '456',
        ready: true,
        visible: true,
      }),
    },
  });
  await assert.rejects(
    Reflect.get(adapter, 'execBoundOp').call(
      adapter,
      conn,
      '456',
      'open-invite-modal',
      async () => {},
    ),
    /timeout/,
  );
  assert.equal(pendingSetup.size, 1);
});

test('window reveal uses registered main, then existing Facebook, then active tab, without navigating or modifying pending operations', async () => {
  const previous = Reflect.get(globalThis, 'chrome');
  const saved: Record<string, unknown> = {};
  let tabs = [
    { id: 8, windowId: 1, active: true, url: 'https://example.com/' },
    { id: 9, windowId: 2, active: false, url: 'https://www.facebook.com/groups/123/' },
  ];
  let focusedWindow = -1;
  const changed: number[] = [];
  Reflect.set(globalThis, 'chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: saved[key] }),
        set: async (value: object) => Object.assign(saved, value),
      },
    },
    tabs: {
      query: async () => tabs,
      get: async (id: number) => tabs.find((tab) => tab.id === id),
      update: async (id: number, props: { active: boolean }) => {
        assert.deepEqual(props, { active: true });
        changed.push(id);
        tabs.find((t) => t.id === id)!.active = true;
      },
    },
    windows: {
      get: async (id: number) => ({
        state: focusedWindow === id ? 'normal' : 'minimized',
        focused: focusedWindow === id,
      }),
      update: async (id: number, props: { focused?: boolean; state?: string }) => {
        if (props.focused) focusedWindow = id;
      },
    },
  });
  try {
    const profileId = randomUUID(),
      epoch = randomUUID();
    await kernelJournal.initialize(profileId, epoch);
    const binding = {
      profileId,
      accountId: '123',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 0,
      operationId: randomUUID(),
      jobId: randomUUID(),
      stepId: randomUUID(),
      actionDigest: '0'.repeat(64),
    };
    await kernelJournal.begin(binding);
    const before = await kernelJournal.snapshot();
    assert.equal((await revealBrowserWindow()).tabId, 9);
    assert.deepEqual(await kernelJournal.snapshot(), before);
    tabs = tabs.slice(0, 1);
    assert.equal((await revealBrowserWindow()).tabId, 8);
    assert.deepEqual(changed, [9, 8]);
    tabs = [];
    await assert.rejects(revealBrowserWindow(), /NO_WINDOW/);
  } finally {
    Reflect.set(globalThis, 'chrome', previous);
  }
});
