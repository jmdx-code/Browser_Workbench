import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRendering } from '../extension/task-rendering.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('stop drains a native capture refresh before confirming cleanup and rejects its late result', async () => {
  let resume!: () => void;
  let starts = 0,
    stops = 0,
    allowed = true;
  const rendering = new TaskRendering(async (_target, method, params) => {
    if (
      method === 'Emulation.setFocusEmulationEnabled' &&
      params.enabled === true &&
      ++starts === 2
    )
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false) stops++;
  });
  const guard = () => {
    if (!allowed) throw Error('STOPPED');
  };
  await rendering.ensure(7, 'native-seven', guard);
  const refreshing = assert.rejects(rendering.refresh(7, 'native-seven', guard), /STOPPED|REVOKED/);
  await tick();
  allowed = false;
  let done = false;
  const stopping = rendering.release().then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false);
  resume();
  await Promise.all([refreshing, stopping]);
  assert.equal(stops, 2); // Stop old stream, then clean up the late new stream.
});

test('refresh serializes stop before start and coalesces callers arriving during native stop', async () => {
  const calls: string[] = [];
  let active = false,
    resumeStop!: () => void;
  const rendering = new TaskRendering(async (_target, method, params) => {
    if (method === 'Page.setWebLifecycleState') return;
    const tag = `${method}:${String(params.enabled)}`;
    calls.push(tag);
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === true) {
      if (active) throw Error('Focus emulation is already active');
      active = true;
    }
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false) {
      if (calls.length === 2)
        await new Promise<void>((resolve) => {
          resumeStop = resolve;
        });
      active = false;
    }
  });
  await rendering.ensure(7, 'native-seven', () => {});
  const first = rendering.refresh(7, 'native-seven', () => {});
  const second = rendering.refresh(7, 'native-seven', () => {});
  await tick();
  const third = rendering.refresh(7, 'native-seven', () => {});
  let ensured = false;
  const ensuring = rendering
    .ensure(7, 'native-seven', () => {})
    .then(() => {
      ensured = true;
    });
  await tick();
  assert.equal(ensured, false);
  assert.deepEqual(calls, [
    'Emulation.setFocusEmulationEnabled:true',
    'Emulation.setFocusEmulationEnabled:false',
  ]);
  resumeStop();
  await Promise.all([first, second, third, ensuring]);
  assert.deepEqual(calls, [
    'Emulation.setFocusEmulationEnabled:true',
    'Emulation.setFocusEmulationEnabled:false',
    'Emulation.setFocusEmulationEnabled:true',
  ]);
  await rendering.release();
  assert.equal(active, false);
});

test('STOP during native refresh stop prevents restart and drains cleanup', async () => {
  let resumeStop!: () => void,
    starts = 0,
    stops = 0;
  const rendering = new TaskRendering(async (_target, method, params) => {
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === true) starts++;
    if (
      method === 'Emulation.setFocusEmulationEnabled' &&
      params.enabled === false &&
      ++stops === 1
    )
      await new Promise<void>((resolve) => {
        resumeStop = resolve;
      });
  });
  await rendering.ensure(7, 'native-seven', () => {});
  const refreshing = assert.rejects(
    rendering.refresh(7, 'native-seven', () => {}),
    /REVOKED/,
  );
  await tick();
  const ensuring = assert.rejects(
    rendering.ensure(7, 'native-seven', () => {}),
    /REVOKED/,
  );
  const stopping = rendering.release();
  resumeStop();
  await Promise.all([refreshing, ensuring, stopping]);
  assert.equal(starts, 1);
  assert.equal(stops, 2);
});

test('late ACK failure from before refresh cannot stop the refreshed stream', async () => {
  let rejectAck!: (error: Error) => void,
    stops = 0;
  const rendering = new TaskRendering(async (_target, method, params) => {
    if (method === 'Page.screencastFrameAck')
      await new Promise<void>((_resolve, reject) => {
        rejectAck = reject;
      });
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false) stops++;
  });
  await rendering.ensure(7, 'native-seven', () => {});
  rendering.consume({ tabId: 7 }, 'Page.screencastFrame', { sessionId: 1 }, () => true);
  await rendering.refresh(7, 'native-seven', () => {});
  rejectAck(Error('OLD_ACK_FAILED'));
  await tick();
  assert.equal(stops, 1);
  await rendering.release();
  assert.equal(stops, 2);
});

test('a rejected refresh stop never starts another encoder and remains fenced', async () => {
  let starts = 0;
  const rendering = new TaskRendering(async (_target, method, params) => {
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === true) starts++;
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false)
      throw Error('NATIVE_STOP_FAILED');
  });
  await rendering.ensure(7, 'native-seven', () => {});
  await assert.rejects(
    rendering.refresh(7, 'native-seven', () => {}),
    /NATIVE_STOP_FAILED/,
  );
  await assert.rejects(
    rendering.ensure(7, 'native-seven', () => {}),
    /SCOPE_CHANGED/,
  );
  assert.equal(starts, 1);
  rendering.forget(7);
});

test('refresh without an existing stream starts only once', async () => {
  const calls: string[] = [];
  const rendering = new TaskRendering(async (_target, method, params) => {
    if (method === 'Page.setWebLifecycleState') return;
    calls.push(`${method}:${String(params.enabled)}`);
  });
  await rendering.refresh(7, 'native-seven', () => {});
  assert.deepEqual(calls, ['Emulation.setFocusEmulationEnabled:true']);
  await rendering.release();
});

test(
  'failed refresh inside maintenance cannot deadlock its own cleanup',
  { timeout: 1000 },
  async () => {
    let active = false,
      starts = 0,
      stops = 0;
    const rendering = new TaskRendering(async (_target, method, params) => {
      if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === true) {
        if (++starts === 2) throw Error('START_FAILED');
        active = true;
      }
      if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false) {
        active = false;
        stops++;
      }
    });
    await rendering.ensure(7, 'native-seven', () => {});
    rendering.maintain((id, target, guard) => rendering.refresh(id, target, guard));
    await tick();
    await rendering.release();
    assert.equal(active, false);
    assert.equal(stops, 2);
  },
);

test('presentation maintenance is coalesced and stop revokes then drains it before confirming cleanup', async () => {
  const calls: string[] = [];
  let resume!: () => void;
  let guarded = false;
  const rendering = new TaskRendering(async (_target, method, params) => {
    if (method === 'Page.setWebLifecycleState') return;
    calls.push(`${method}:${String(params.enabled)}`);
  });
  await rendering.ensure(7, 'native-seven', () => {});
  const work = async (tabId: number, targetId: string, guard: () => void) => {
    assert.equal(tabId, 7);
    assert.equal(targetId, 'native-seven');
    guard();
    await new Promise<void>((resolve) => {
      resume = resolve;
    });
    assert.throws(guard, /REVOKED/);
    guarded = true;
  };
  rendering.maintain(work);
  rendering.maintain(async () => {
    throw Error('DUPLICATE_MAINTENANCE');
  });
  await tick();
  let released = false;
  const stopping = rendering.release().then(() => {
    released = true;
  });
  await tick();
  assert.equal(released, false);
  resume();
  await stopping;
  assert.equal(guarded, true);
  assert.equal(released, true);
  assert.deepEqual(calls, [
    'Emulation.setFocusEmulationEnabled:true',
    'Emulation.setFocusEmulationEnabled:false',
  ]);
  rendering.maintain(async () => {
    throw Error('IDLE_MAINTENANCE');
  });
  await tick();
});

test('slow frame acknowledgements are bounded and exhausted permission tears the stream down', async () => {
  const pending: (() => void)[] = [];
  let stopped = 0;
  const rendering = new TaskRendering(async (_target, method, params) => {
    if (method === 'Page.screencastFrameAck')
      return new Promise<void>((resolve) => {
        pending.push(resolve);
      });
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false) stopped++;
  });
  await rendering.ensure(7, 'native-seven', () => {});
  for (let i = 0; i < 5; i++)
    rendering.consume(
      { tabId: 7 },
      'Page.screencastFrame',
      { sessionId: i, data: 'discard' },
      () => true,
    );
  await tick();
  assert.equal(pending.length, 4);
  assert.equal(stopped, 1);
  pending.forEach((resolve) => resolve());
  await rendering.ensure(7, 'native-seven', () => {});
  rendering.consume({ tabId: 7 }, 'Page.screencastFrame', { sessionId: 8 }, () => false);
  await tick();
  assert.equal(stopped, 2);
});

test('rendering is bounded to one exact native target, shares startup, discards pixels and acknowledges every frame', async () => {
  const calls: { tabId: number; method: string; params: Record<string, unknown> }[] = [];
  const rendering = new TaskRendering(async (target, method, params) => {
    if (method === 'Page.setWebLifecycleState') return;
    calls.push({ ...target, method, params });
  });
  await Promise.all([
    rendering.ensure(7, 'native-seven', () => {}),
    rendering.ensure(7, 'native-seven', () => {}),
  ]);
  assert.equal(calls.length, 1);
  await assert.rejects(
    rendering.ensure(8, 'other', () => {}),
    /TARGET_LIMIT/,
  );
  await assert.rejects(
    rendering.ensure(7, 'changed', () => {}),
    /SCOPE_CHANGED/,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      rendering.consume(
        { tabId: 7 },
        'Page.screencastFrame',
        { sessionId: 1, data: 'private pixels' },
        () => true,
      ),
      true,
    );
  await tick();
  assert.equal(calls.filter((c) => c.method === 'Page.screencastFrameAck').length, 2);
  assert.equal(JSON.stringify(calls).includes('private pixels'), false);
  assert.equal(
    rendering.consume({ tabId: 8 }, 'Page.screencastFrame', {}, () => true),
    false,
  );
  assert.equal(
    rendering.consume({ tabId: 7, sessionId: 'child' }, 'Page.screencastFrame', {}, () => true),
    false,
  );
  await Promise.all([rendering.release(), rendering.release()]);
  assert.equal(
    calls.filter(
      (c) => c.method === 'Emulation.setFocusEmulationEnabled' && c.params.enabled === false,
    ).length,
    1,
  );
  await rendering.ensure(8, 'other', () => {});
  await rendering.release();
});

test('revocation during native start releases its eventual stream and never returns a usable rendering permit', async () => {
  let started!: () => void,
    allowed = true,
    stopped = 0;
  const rendering = new TaskRendering(async (_target, method, params) => {
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === true)
      return new Promise<void>((resolve) => {
        started = resolve;
      });
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false) stopped++;
  });
  const pending = assert.rejects(
    rendering.ensure(7, 'native-seven', () => {
      if (!allowed) throw Error('STOPPED');
    }),
    /STOPPED|REVOKED/,
  );
  allowed = false;
  const cleanup = rendering.release();
  started();
  await Promise.all([pending, cleanup]);
  assert.equal(stopped, 1);
});

test('uncertain native start is cleaned up once, never retried or reported as success', async () => {
  const calls: string[] = [];
  const rendering = new TaskRendering(async (_target, method, params) => {
    calls.push(`${method}:${String(params.enabled)}`);
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === true)
      throw Error('ACK_LOST');
  });
  await assert.rejects(
    rendering.ensure(7, 'native-seven', () => {}),
    /ACK_LOST/,
  );
  assert.deepEqual(calls, [
    'Emulation.setFocusEmulationEnabled:true',
    'Emulation.setFocusEmulationEnabled:false',
  ]);
});

test('a late old-frame acknowledgement failure cannot release a replacement stream', async () => {
  let rejectAck!: (error: Error) => void,
    stopped = 0;
  const rendering = new TaskRendering(async (_target, method, params) => {
    if (method === 'Page.screencastFrameAck')
      return new Promise<void>((_resolve, reject) => {
        rejectAck = reject;
      });
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false) stopped++;
  });
  await rendering.ensure(7, 'native-seven', () => {});
  rendering.consume({ tabId: 7 }, 'Page.screencastFrame', { sessionId: 1 }, () => true);
  await rendering.release();
  await rendering.ensure(7, 'native-seven', () => {});
  rejectAck(Error('OLD_NATIVE_ACK_FAILED'));
  await tick();
  assert.equal(stopped, 1);
  await rendering.release();
});

test('failed cleanup stays fenced until native detach, and frame traffic cannot reactivate it', async () => {
  let acks = 0;
  const rendering = new TaskRendering(async (_target, method, params) => {
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false)
      throw Error('NATIVE_STOP_FAILED');
    if (method === 'Page.screencastFrameAck') acks++;
  });
  await rendering.ensure(7, 'native-seven', () => {});
  await assert.rejects(rendering.release(), /NATIVE_STOP_FAILED/);
  await assert.rejects(
    rendering.ensure(7, 'native-seven', () => {}),
    /SCOPE_CHANGED/,
  );
  assert.equal(
    rendering.consume({ tabId: 7 }, 'Page.screencastFrame', { sessionId: 1 }, () => true),
    true,
  );
  assert.equal(acks, 0);
  rendering.forget(7);
  await rendering.ensure(7, 'new-native-seven', () => {});
  rendering.forget(7);
});
