import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  Progress,
  PlayGate,
  WatchTasks,
  WatchSpec,
  type Sample,
  type Media,
  type Observation,
} from '../../src/bridge/watch.js';
import type { Command } from '../../src/bridge/protocol.js';
import { Core } from '../../src/bridge/core.js';
import { Store } from '../../src/bridge/store.js';
const media: Media = {
  nodeId: 31,
  index: 0,
  source: 'video1',
  time: 0,
  duration: 12,
  paused: false,
  readyState: 4,
  visible: true,
  area: 100,
  loop: true,
  rate: 1,
  ended: false,
};
function sample(
  at: number,
  time: number,
  changes: Partial<Media> = {},
  visibility = 'visible',
): Sample {
  return { at, identity: 'video1', visibility, media: { ...media, time, ...changes } };
}
test('观看只累计连续可见的真实播放进度，支持正常循环', () => {
  const progress = new Progress();
  progress.add(sample(1000, 10));
  assert.equal(progress.add(sample(2000, 11)).delta, 1);
  assert.equal(progress.add(sample(3000, 0)).delta, 1);
  assert.equal(progress.seconds, 2);
});
test('隐藏、暂停、缓冲、跳进度、长采样空白均不记观看', () => {
  for (const [first, second] of [
    [sample(1000, 0), sample(2000, 1, {}, 'hidden')],
    [sample(1000, 0), sample(2000, 1, { paused: true })],
    [sample(1000, 0), sample(2000, 1, { readyState: 1 })],
    [sample(1000, 0), sample(2000, 10)],
    [sample(1000, 0), sample(5000, 4)],
    [sample(1000, 0), sample(2000, 1, { rate: 2 })],
    [sample(1000, 0), sample(2000, 1, { visible: false })],
    [sample(1000, 0, {}, 'hidden'), sample(2000, 1)],
  ]) {
    const p = new Progress();
    p.add(first!);
    assert.equal(p.add(second!).delta, 0);
    assert.equal(p.seconds, 0);
  }
});
test('视频或文档身份变化中断，不能把第二条视频时间拼入第一条', () => {
  const p = new Progress();
  p.add(sample(1000, 0));
  assert.throws(
    () => p.add({ ...sample(2000, 1), identity: 'video2' }),
    /MEDIA_OR_DOCUMENT_CHANGED/,
  );
});
test('初始元数据加载不误判视频替换，未准备区间不计时；已准备视频时长变化仍中断', () => {
  const p = new Progress();
  p.add(sample(1000, 0, { readyState: 0, duration: null, paused: true }));
  assert.equal(p.add(sample(2000, 0)).delta, 0);
  assert.equal(p.add(sample(3000, 1)).delta, 1);
  assert.throws(() => p.add(sample(4000, 2, { duration: 20 })), /MEDIA_OR_DOCUMENT_CHANGED/);
});

test('同一视频的内部路由更新只丢弃过渡间隔，后续实际增长可继续累计', () => {
  const p = new Progress();
  p.add({ ...sample(1000, 0), routeEpoch: 0 });
  assert.equal(p.add({ ...sample(2000, 1), routeEpoch: 4 }).reason, 'ROUTE_REBASELINE');
  assert.equal(p.seconds, 0);
  assert.equal(p.add({ ...sample(3000, 2), routeEpoch: 4 }).delta, 1);
  assert.equal(p.seconds, 1);
  assert.throws(
    () => p.add({ ...sample(4000, 3), identity: 'different-reel', routeEpoch: 5 }),
    /MEDIA_OR_DOCUMENT_CHANGED/,
  );
});
test('短暂自动暂停、隐藏和结束不触发播放输入；持续可见暂停经过宽限期才输入', () => {
  const gate = new PlayGate();
  const observation = { visibility: 'visible' } as Observation;
  const paused = { ...media, paused: true };
  assert.equal(gate.due(observation, paused, 1000, 2500), false);
  assert.equal(gate.due(observation, paused, 2000, 2500), false);
  assert.equal(gate.due(observation, media, 2100, 2500), false);
  assert.equal(gate.due(observation, paused, 3000, 2500), false);
  assert.equal(gate.due(observation, paused, 5500, 2500), true);
  assert.equal(gate.due({ ...observation, visibility: 'hidden' }, paused, 6000, 2500), false);
  assert.equal(gate.due(observation, paused, 7000, 2500), false);
  assert.equal(gate.due(observation, { ...paused, ended: true }, 10000, 2500), false);
});
test('观看地址与预算严格限制；未授权 FB、同资料重复任务和全局预算拒绝', async () => {
  assert.throws(() =>
    WatchSpec.parse({
      profileId: randomUUID(),
      operationId: randomUUID(),
      url: 'https://attacker.example/',
      targetSeconds: 1,
      maxWallSeconds: 10,
    }),
  );
  const store = new Store(':memory:'),
    core = new Core(store),
    tasks = new WatchTasks(core, 5, 2);
  const peers = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const p = core.connect(
        randomUUID(),
        () => {},
        () => {},
      );
      await core.sync(p);
      await core.synced(p, p.controlId!, []);
      await core.resume(p.profileId);
      await core.resumed(p, p.controlId!);
      return p;
    }),
  );
  const spec = (i: number) => ({
    profileId: peers[i]!.profileId,
    operationId: randomUUID(),
    url: 'http://127.0.0.1:18767/fixture',
    targetSeconds: 1,
    maxWallSeconds: 10,
  });
  await assert.rejects(
    async () => await tasks.start({ ...spec(0), url: 'https://www.facebook.com/reel/123/' }),
    /FACEBOOK_NOT_AUTHORIZED/,
  );
  const first = spec(0),
    row = await tasks.start(first);
  assert.equal((await tasks.start(first)).taskId, row.taskId);
  await assert.rejects(async () => await tasks.start(spec(0)), /PROFILE_TASK_BUSY/);
  await tasks.start(spec(1));
  await assert.rejects(async () => await tasks.start(spec(2)), /GLOBAL_TASK_LIMIT/);
  tasks.shutdown();
  await core.shutdown();
  await new Promise((r) => setImmediate(r));
  store.close();
});

test('模拟完整观看闭环：初始跳转重试、空 source 视频计时、核验后关闭', async () => {
  const store = new Store(':memory:'),
    core = new Core(store),
    tasks = new WatchTasks(core, 20);
  const profileId = randomUUID();
  store.pair(profileId, 'test-only-secret', 'a'.repeat(32));
  store.allowFacebook(profileId);
  const started = Date.now();
  let observations = 0,
    closed = false;
  const peer = core.connect(
    profileId,
    (message) => {
      const cmd = message as Command;
      if (cmd.type !== 'COMMAND') return;
      queueMicrotask(async () => {
        if (cmd.action.kind === 'createTaskTab')
          await core.reply(peer, {
            type: 'RESULT',
            commandId: cmd.commandId,
            status: 'VERIFIED',
            evidence: { tabId: 1 },
          });
        else if (cmd.action.kind === 'observe') {
          observations++;
          if (observations <= 2)
            await core.reply(peer, {
              type: 'RESULT',
              commandId: cmd.commandId,
              status: 'FAILED',
              error: 'TAB_SCOPE_CHANGED',
            });
          else
            await core.reply(peer, {
              type: 'RESULT',
              commandId: cmd.commandId,
              status: 'VERIFIED',
              evidence: {
                url: 'https://www.facebook.com/reel/123/',
                visibility: 'visible',
                tabId: 1,
                documentEpoch: 1,
                routeEpoch: 2,
                buttons: [],
                video: [
                  {
                    ...media,
                    source: '',
                    paused: observations <= 4,
                    time: (Date.now() - started) / 1000,
                  },
                ],
              },
            });
        } else if (cmd.action.kind === 'closeTab') {
          closed = true;
          await core.reply(peer, { type: 'RESULT', commandId: cmd.commandId, status: 'VERIFIED' });
        } else assert.fail('Unexpected write: ' + cmd.action.kind);
      });
    },
    () => {},
  );
  await core.sync(peer);
  await core.synced(peer, peer.controlId!, []);
  await core.resume(profileId);
  await core.resumed(peer, peer.controlId!);
  try {
    const task = await tasks.start({
      profileId,
      operationId: randomUUID(),
      url: 'https://www.facebook.com/watch/',
      targetSeconds: 1,
      maxWallSeconds: 10,
    });
    const deadline = Date.now() + 3000;
    let result: any;
    while (Date.now() < deadline) {
      result = store.tasks().find((r: any) => r.taskId === task.taskId);
      if (result.status !== 'RUNNING' && result.status !== 'PREPARED') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(result.status, 'VERIFIED');
    assert.equal(closed, true);
    assert.ok(JSON.parse(result.evidence).effectiveSeconds >= 1);
    assert.ok(observations > 2);
  } finally {
    tasks.shutdown();
    await core.shutdown();
    await new Promise((r) => setImmediate(r));
    store.close();
  }
});

test('新增激活能力先重新观察；隐藏页不发送播放输入，可见后只发送一次并核验', async () => {
  const store = new Store(':memory:'),
    core = new Core(store),
    tasks = new WatchTasks(core, 20);
  const id = randomUUID();
  store.pair(id, 'test-only-secret', 'a'.repeat(32));
  let observed = 0,
    activated = false,
    playingAt = 0,
    clicks = 0,
    closed = false;
  const peer = core.connect(
    id,
    (message) => {
      const cmd = message as Command;
      if (cmd.type !== 'COMMAND') return;
      queueMicrotask(async () => {
        let evidence: unknown = {};
        switch (cmd.action.kind) {
          case 'createTaskTab':
            evidence = { tabId: 1 };
            break;
          case 'activateTab':
            assert.equal(observed, 1);
            activated = true;
            break;
          case 'observe': {
            observed++;
            evidence = {
              url: 'http://127.0.0.1:18767/fixture',
              tabId: 1,
              documentEpoch: 1,
              routeEpoch: 0,
              visibility: observed < 5 ? 'hidden' : 'visible',
              buttons: [],
              video: [
                {
                  ...media,
                  paused: !playingAt,
                  time: playingAt ? (Date.now() - playingAt) / 1000 : 0,
                },
              ],
            };
            break;
          }
          case 'click':
            assert.ok(activated && observed >= 5);
            clicks++;
            playingAt = Date.now();
            await core.reply(peer, {
              type: 'RESULT',
              commandId: cmd.commandId,
              status: 'ACKNOWLEDGED',
              evidence: { inputDispatched: true },
            });
            return;
          case 'closeTab':
            closed = true;
            break;
          default:
            assert.fail('Unexpected command ' + cmd.action.kind);
        }
        await core.reply(peer, {
          type: 'RESULT',
          commandId: cmd.commandId,
          status: 'VERIFIED',
          evidence,
        });
      });
    },
    () => {},
  );
  peer.capabilities = ['task-activation'];
  await core.sync(peer);
  await core.synced(peer, peer.controlId!, []);
  await core.resume(id);
  await core.resumed(peer, peer.controlId!);
  try {
    const task = await tasks.start({
      profileId: id,
      operationId: randomUUID(),
      url: 'http://127.0.0.1:18767/fixture',
      targetSeconds: 1,
      maxWallSeconds: 10,
    });
    const until = Date.now() + 3000;
    let result: any;
    while (Date.now() < until) {
      result = store.tasks().find((v: any) => v.taskId === task.taskId);
      if (!['RUNNING', 'PREPARED'].includes(result.status)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(result.status, 'VERIFIED');
    assert.equal(clicks, 1);
    assert.equal(closed, true);
    assert.equal(store.unresolved(id).length, 0);
  } finally {
    tasks.shutdown();
    await core.shutdown();
    await new Promise((r) => setImmediate(r));
    store.close();
  }
});
