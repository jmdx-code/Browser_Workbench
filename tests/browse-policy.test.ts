import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  effectiveBrowseMilliseconds,
  type TimedBrowseReading,
} from '../src/domain/browse-policy.js';

function sample(): TimedBrowseReading {
  const profileId = randomUUID();
  return {
    context: {
      profileId,
      accountId: 'fixture',
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 0,
    },
    stepId: randomUUID(),
    startedAt: 0,
    finishedAt: 0,
    reading: {
      type: 'video',
      proof: {
        profileId,
        ownershipId: randomUUID(),
        browserSessionEpoch: randomUUID(),
        tabId: 42,
        targetId: 'fixture-target',
      },
      documentEpoch: 0,
      routeEpoch: 0,
      contentId: 'fixture-video',
      visible: true,
      ready: true,
      paused: false,
      buffering: false,
      timeSeconds: 0,
      playbackRate: 1,
    },
  };
}
const next = (previous: TimedBrowseReading): TimedBrowseReading => ({
  ...structuredClone(previous),
  startedAt: 1000,
  finishedAt: 1000,
  reading: {
    ...structuredClone(previous.reading),
    ...(previous.reading.type === 'video' ? { timeSeconds: 1 } : {}),
  },
});

test('marketplace includes a bounded slow visible read without crediting hidden, loading, changed documents or long gaps', () => {
  const first = sample();
  const { proof, documentEpoch, routeEpoch, contentId } = first.reading;
  first.reading = {
    type: 'marketplace',
    proof,
    documentEpoch,
    routeEpoch,
    contentId,
    visible: true,
    ready: true,
  };
  const second = next(first);
  second.startedAt = 1000;
  second.finishedAt = 4200;
  assert.equal(effectiveBrowseMilliseconds(first, second), 4200);
  for (const change of [
    (s: TimedBrowseReading) => {
      s.reading.visible = false;
    },
    (s: TimedBrowseReading) => {
      s.reading.ready = false;
    },
    (s: TimedBrowseReading) => {
      s.reading.contentId = 'different-document';
    },
    (s: TimedBrowseReading) => {
      s.finishedAt = 6001;
    },
  ]) {
    const changed = structuredClone(second);
    change(changed);
    assert.equal(effectiveBrowseMilliseconds(first, changed), 0);
  }
});

test('effective video time follows actual progression and playback rate, excludes sample latency and does not count buffering wall time', () => {
  const first = sample(),
    second = next(first);
  assert.equal(effectiveBrowseMilliseconds(undefined, second), 0);
  assert.equal(effectiveBrowseMilliseconds(first, second), 1000);
  if (second.reading.type !== 'video' || first.reading.type !== 'video')
    throw Error('FIXTURE_TYPE');
  second.reading.timeSeconds = 0.2;
  assert.equal(effectiveBrowseMilliseconds(first, second), 200);
  first.reading.playbackRate = second.reading.playbackRate = 2;
  second.reading.timeSeconds = 2;
  second.startedAt = 800;
  assert.equal(effectiveBrowseMilliseconds(first, second), 800);
});

test('hidden, paused, buffering, unready and slow observations never contribute effective time', () => {
  const first = sample();
  for (const change of [
    { visible: false },
    { ready: false },
    { paused: true },
    { buffering: true },
  ]) {
    const second = next(first);
    second.reading = { ...second.reading, ...change };
    assert.equal(effectiveBrowseMilliseconds(first, second), 0);
    assert.equal(effectiveBrowseMilliseconds(second, next(second)), 0);
  }
  const slow = next(first);
  slow.startedAt = 0;
  slow.finishedAt = 3000;
  assert.equal(effectiveBrowseMilliseconds(first, slow), 0);
});

test('seeking, long gaps, nonmonotonic clocks and playback rate changes cannot inflate time', () => {
  const first = sample();
  for (const advance of [0, 100]) {
    const second = next(first);
    if (second.reading.type === 'video') second.reading.timeSeconds = advance;
    assert.equal(effectiveBrowseMilliseconds(first, second), 0);
  }
  const delayed = next(first);
  delayed.startedAt = delayed.finishedAt = 6000;
  assert.equal(effectiveBrowseMilliseconds(first, delayed), 0);
  const regressed = next(first);
  regressed.startedAt = regressed.finishedAt = -1000;
  assert.equal(effectiveBrowseMilliseconds(first, regressed), 0);
  const different = next(first);
  if (different.reading.type === 'video') different.reading.playbackRate = 2;
  assert.equal(effectiveBrowseMilliseconds(first, different), 0);
});

test('bounded real read latency does not permanently prevent progress and is excluded from credited time', () => {
  const first = sample(),
    second = next(first);
  second.startedAt = 1000;
  second.finishedAt = 1800;
  if (second.reading.type === 'video') second.reading.timeSeconds = 1.8;
  assert.equal(effectiveBrowseMilliseconds(first, second), 1000);
});

test('visible feed includes bounded observation time, but loading and excessive read gaps still do not count', () => {
  const first = sample();
  first.reading = {
    type: 'feed',
    proof: first.reading.proof,
    documentEpoch: 0,
    routeEpoch: 0,
    contentId: 'visible-feed-document',
    visible: true,
    ready: true,
  };
  const second = next(first);
  second.finishedAt = 1800;
  assert.equal(effectiveBrowseMilliseconds(first, second), 1800);
  second.reading.ready = false;
  assert.equal(effectiveBrowseMilliseconds(first, second), 0);
  second.reading.ready = true;
  second.finishedAt = 4000;
  assert.equal(effectiveBrowseMilliseconds(first, second), 4000);
  second.finishedAt = 5001;
  assert.equal(effectiveBrowseMilliseconds(first, second), 5000);
  second.finishedAt = 6001;
  assert.equal(effectiveBrowseMilliseconds(first, second), 0);
});

test('feed read overhead is bounded by the existing five-second interval, without relaxing video freshness', () => {
  const first = sample();
  first.reading = {
    type: 'feed',
    proof: first.reading.proof,
    documentEpoch: 0,
    routeEpoch: 0,
    contentId: 'same-document',
    visible: true,
    ready: true,
  };
  first.startedAt = 0;
  first.finishedAt = 3000;
  const second = structuredClone(first);
  second.startedAt = 4000;
  second.finishedAt = 7000;
  assert.equal(effectiveBrowseMilliseconds(first, second), 4000);
  second.reading.visible = false;
  assert.equal(effectiveBrowseMilliseconds(first, second), 0);
  second.reading.visible = true;
  second.finishedAt = 8001;
  assert.equal(effectiveBrowseMilliseconds(first, second), 5000);
  second.finishedAt = 9001;
  assert.equal(effectiveBrowseMilliseconds(first, second), 0);
});

test('step, content, document, route, native target, account and lease changes break the time interval', () => {
  const first = sample();
  const changes: ((reading: TimedBrowseReading) => void)[] = [
    (s) => {
      s.stepId = randomUUID();
    },
    (s) => {
      s.reading.contentId = 'different';
    },
    (s) => {
      s.reading.documentEpoch++;
    },
    (s) => {
      s.reading.routeEpoch++;
    },
    (s) => {
      s.reading.proof.targetId = 'different';
    },
    (s) => {
      s.context.accountId = 'different';
    },
    (s) => {
      s.context.leaseId = randomUUID();
    },
    (s) => {
      s.context.connectionEpoch = randomUUID();
    },
  ];
  for (const change of changes) {
    const second = next(first);
    change(second);
    assert.equal(effectiveBrowseMilliseconds(first, second), 0);
  }
});

test('feed uses the same current visible owned-page boundaries and excludes the transition between contents', () => {
  const first = sample();
  const {
    paused: _paused,
    buffering: _buffering,
    timeSeconds: _time,
    playbackRate: _rate,
    ...base
  } = first.reading as Extract<typeof first.reading, { type: 'video' }>;
  first.reading = { ...base, type: 'feed' };
  assert.equal(effectiveBrowseMilliseconds(first, next(first)), 1000);
  const second = next(first);
  second.reading.contentId = 'new-feed-content';
  assert.equal(effectiveBrowseMilliseconds(first, second), 0);
});

test('visible document read jitter is capped, and missing polls, navigation, hidden and loading still receive zero', () => {
  for (const type of ['feed', 'marketplace'] as const) {
    const first = sample();
    const { proof, documentEpoch, routeEpoch, contentId } = first.reading;
    first.reading = {
      type,
      proof,
      documentEpoch,
      routeEpoch,
      contentId,
      visible: true,
      ready: true,
    };
    const second = next(first);
    second.startedAt = 4500;
    second.finishedAt = 5200;
    assert.equal(effectiveBrowseMilliseconds(first, second), 5000);
    for (const change of [
      (s: TimedBrowseReading) => {
        s.startedAt = 5001;
      },
      (s: TimedBrowseReading) => {
        s.finishedAt = 6001;
      },
      (s: TimedBrowseReading) => {
        s.reading.visible = false;
      },
      (s: TimedBrowseReading) => {
        s.reading.ready = false;
      },
      (s: TimedBrowseReading) => {
        s.reading.contentId = 'new-document';
      },
      (s: TimedBrowseReading) => {
        s.context.leaseId = randomUUID();
      },
    ]) {
      const changed = structuredClone(second);
      change(changed);
      assert.equal(effectiveBrowseMilliseconds(first, changed), 0);
    }
  }
});
