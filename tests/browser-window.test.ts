import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Core, type Peer } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import type { Command } from '../src/bridge/protocol.js';
import { BridgeBrowserWindow } from '../src/infrastructure/bridge-browser-window.js';
import type { Plan } from '../src/shared/task-contracts.js';

test('display of an active registered main bypasses identification-page creation, while stopping wins', async () => {
  const store = new Store(':memory:');
  const core = new Core(store);
  const peer = core.connect(
    randomUUID(),
    () => assert.fail('no legacy control or page creation'),
    () => {},
  );
  peer.synced = true;
  peer.phase = 'PAUSED';
  let state = 'RUNNING',
    shown = 0;
  const service = new BridgeBrowserWindow(
    core,
    { list: () => [{ profileId: peer.profileId, state }] as Plan[] },
    async (profileId) => {
      shown++;
      return { profileId, tabId: 7, focused: true };
    },
  );
  try {
    assert.deepEqual(await service.show(peer.profileId, 'selected'), {
      profileId: peer.profileId,
      tabId: 7,
      focused: true,
    });
    assert.equal(store.list().length, 0);
    state = 'STOPPING';
    await assert.rejects(service.show(peer.profileId, 'selected'), /正在停止/);
    assert.equal(shown, 1);
  } finally {
    store.close();
  }
});

for (const windowOnly of [false, true])
  test(
    (windowOnly ? 'native window status avoids debugger observation' : 'old bridge fallback') +
      ' shows only selected profile and confirms focus/STOP',
    async () => {
      const store = new Store(':memory:');
      const core = new Core(store);
      const sent: Command[] = [];
      let focused = true;
      let loadedURL = '';
      let peer: Peer;
      peer = core.connect(
        randomUUID(),
        (input) => {
          const message = input as { type: 'RESUME' | 'STOP'; requestId: string } | Command;
          queueMicrotask(async () => {
            if (message.type === 'RESUME') await core.resumed(peer, message.requestId);
            else if (message.type === 'STOP') await core.stopped(peer, message.requestId);
            else if (message.type === 'COMMAND') {
              sent.push(message);
              if (message.action.kind === 'createTaskTab') loadedURL = message.action.url;
              await core.reply(peer, {
                type: 'RESULT',
                commandId: message.commandId,
                status: 'VERIFIED',
                evidence:
                  message.action.kind === 'createTaskTab'
                    ? { tabId: 321, url: loadedURL }
                    : message.action.kind === 'observe'
                      ? { url: loadedURL }
                      : message.action.kind === 'readTabState'
                        ? {
                            url: loadedURL,
                            status: 'complete',
                            state: 'normal',
                            focused,
                            active: true,
                          }
                        : { state: 'normal', focused, active: true },
              });
            }
          });
        },
        () => {},
      );
      peer.synced = true;
      peer.phase = 'PAUSED';
      peer.extensionVersion = '0.3.19';
      peer.capabilities = windowOnly ? ['local-window-status-v1'] : [];
      const service = new BridgeBrowserWindow(core, { list: () => [] });
      try {
        const result = await service.show(peer.profileId, 'Chrome 旧资料');
        assert.equal(result.focused, true);
        assert.equal(peer.phase, 'PAUSED');
        assert.deepEqual(
          sent.map((row) => row.action.kind),
          ['createTaskTab', windowOnly ? 'readTabState' : 'observe', 'windowState'],
        );
        const create = sent[0]?.action;
        assert.ok(create?.kind === 'createTaskTab');
        const url = new URL(create.url);
        assert.equal(url.origin, 'http://127.0.0.1:18767');
        assert.equal(url.searchParams.get('profileId'), peer.profileId);
        assert.equal(url.searchParams.get('alias'), 'Chrome 旧资料');
        assert.equal(store.list().length, 3);
        assert.ok(
          store
            .list()
            .every((row) => row.profileId === peer.profileId && row.status === 'VERIFIED'),
        );
        focused = false;
        await assert.rejects(service.show(peer.profileId, 'second'), /未能确认/);
        assert.equal(peer.phase, 'PAUSED');
        assert.equal(sent.length, 6); // No blind replay on a mismatching focus acknowledgement.
        await assert.rejects(service.show(randomUUID(), 'offline'), /未连接/);
        assert.equal(sent.length, 6);
      } finally {
        await core.shutdown();
        store.close();
      }
    },
  );
