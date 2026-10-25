import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SessionCloser } from '../src/application/session-closer.js';
import type { SessionClosePort } from '../src/domain/session-close.js';

function fixture() {
  const state = { local: 0, remote: [] as string[], released: 0, transport: true };
  const port: SessionClosePort = {
    closeLocal: async () => {
      state.local++;
    },
    assertTransport: () => {
      if (!state.transport) throw Error('TRANSPORT_CHANGED');
    },
    stopRemote: async (requestId) => {
      state.remote.push(requestId);
      return { requestId, state: 'stopped' };
    },
    release: () => {
      state.released++;
    },
  };
  return { state, port, closer: new SessionCloser(port), id: randomUUID() };
}
test('closer caches the exact successful native receipt and never cancels or releases twice', async () => {
  const f = fixture();
  const first = f.closer.close(f.id);
  assert.equal(f.closer.close(f.id), first);
  const receipt = await first;
  assert.deepEqual(await f.closer.retry(f.id), receipt);
  assert.equal(f.state.local, 1);
  assert.deepEqual(f.state.remote, [f.id]);
  assert.equal(f.state.released, 1);
  await assert.rejects(f.closer.close(randomUUID()), /ID_CONFLICT/);
  await assert.rejects(f.closer.retry(randomUUID()), /BINDING_MISMATCH/);
});
test('lost remote response keeps the owner until explicit same-request retry; ordinary close never resends', async () => {
  const f = fixture(),
    original = f.port.stopRemote;
  f.port.stopRemote = async (requestId) => {
    await original(requestId);
    throw Error('REPLY_LOST');
  };
  await assert.rejects(f.closer.close(f.id), /REPLY_LOST/);
  await assert.rejects(f.closer.close(f.id), /REPLY_LOST/);
  assert.equal(f.state.released, 0);
  assert.deepEqual(f.state.remote, [f.id]);
  f.port.stopRemote = original;
  assert.deepEqual(await f.closer.retry(f.id), { requestId: f.id, state: 'stopped' });
  assert.equal(f.state.local, 1);
  assert.deepEqual(f.state.remote, [f.id, f.id]);
  assert.equal(f.state.released, 1);
});
test('a replacement connection cannot supply a receipt for the stopped original session', async () => {
  const f = fixture();
  f.port.stopRemote = async () => {
    f.state.transport = false;
    throw Error('REPLY_LOST');
  };
  await assert.rejects(f.closer.close(f.id), /REPLY_LOST/);
  await assert.rejects(f.closer.retry(f.id), /TRANSPORT_CHANGED/);
  assert.equal(f.state.released, 0);
  assert.equal(f.state.local, 1);
});
test('late response after transport replacement and mismatching stop IDs cannot release ownership', async () => {
  const f = fixture(),
    original = f.port.stopRemote;
  f.port.stopRemote = async (requestId) => {
    const result = await original(requestId);
    f.state.transport = false;
    return result;
  };
  await assert.rejects(f.closer.close(f.id), /TRANSPORT_CHANGED/);
  assert.equal(f.state.released, 0);
  f.state.transport = true;
  f.port.stopRemote = async () => ({ requestId: randomUUID(), state: 'stopped' });
  await assert.rejects(f.closer.retry(f.id), /UNCONFIRMED/);
  assert.equal(f.state.released, 0);
});
test('unconfirmed local cancellation cannot be promoted by remote state or retried blindly', async () => {
  const f = fixture();
  f.port.closeLocal = async () => {
    throw Error('LOCAL_UNCONFIRMED');
  };
  await assert.rejects(f.closer.close(f.id), /LOCAL_UNCONFIRMED/);
  await assert.rejects(f.closer.retry(f.id), /LOCAL_STOP_UNCONFIRMED/);
  assert.deepEqual(f.state.remote, []);
  assert.equal(f.state.released, 0);
});
test('explicit retry cannot overlap pending cancellation or manufacture an initial request', async () => {
  const f = fixture();
  await assert.rejects(f.closer.retry(f.id), /BINDING_MISMATCH/);
  let resolve: (() => void) | undefined;
  const wait = new Promise<void>((done) => {
    resolve = done;
  });
  f.port.closeLocal = async () => {
    await wait;
  };
  const closing = f.closer.close(f.id);
  await assert.rejects(f.closer.retry(f.id), /IN_FLIGHT/);
  assert.ok(resolve);
  resolve();
  await closing;
});

test('same-owner local recovery must actually succeed before requesting the original remote STOP', async () => {
  const f = fixture();
  let recovery = 0;
  f.port.closeLocal = async () => {
    throw Error('LOCAL_UNCONFIRMED');
  };
  f.port.retryCloseLocal = async () => {
    recovery++;
    if (recovery === 1) throw Error('STILL_DRAINING');
  };
  await assert.rejects(f.closer.close(f.id), /LOCAL_UNCONFIRMED/);
  await assert.rejects(f.closer.retry(f.id), /STILL_DRAINING/);
  assert.deepEqual(f.state.remote, []);
  assert.equal(f.state.released, 0);
  await assert.rejects(f.closer.retry(randomUUID()), /BINDING_MISMATCH/);
  f.state.transport = false;
  await assert.rejects(f.closer.retry(f.id), /TRANSPORT_CHANGED/);
  assert.equal(recovery, 1);
  f.state.transport = true;
  assert.deepEqual(await f.closer.retry(f.id), { requestId: f.id, state: 'stopped' });
  assert.deepEqual(f.state.remote, [f.id]);
  assert.equal(f.state.local, 0);
  assert.equal(recovery, 2);
  assert.equal(f.state.released, 1);
});

test('local cancellation timeout is unconfirmed and cannot overlap or release on a late local result', async () => {
  const f = fixture();
  let finish!: () => void;
  f.port.closeLocal = async () => {
    f.state.local++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  };
  const closer = new SessionCloser(f.port, { localMilliseconds: 10, remoteMilliseconds: 100 });
  await assert.rejects(closer.close(f.id), /LOCAL_STOP_TIMEOUT/);
  await assert.rejects(closer.retry(f.id), /IN_FLIGHT/);
  assert.equal(f.state.released, 0);
  assert.deepEqual(f.state.remote, []);
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.state.released, 0);
  assert.deepEqual(f.state.remote, []);
  await assert.rejects(closer.close(f.id), /LOCAL_STOP_TIMEOUT/);
  assert.deepEqual(await closer.retry(f.id), { requestId: f.id, state: 'stopped' });
  assert.equal(f.state.local, 1);
  assert.equal(f.state.released, 1);
});

test('remote stop timeout retains ownership; late reply cannot confirm and a pending retry cannot resend', async () => {
  const f = fixture(),
    original = f.port.stopRemote;
  let finish!: () => void;
  f.port.stopRemote = async (id) => {
    const result = await original(id);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return result;
  };
  const closer = new SessionCloser(f.port, { localMilliseconds: 100, remoteMilliseconds: 10 });
  await assert.rejects(closer.close(f.id), /REMOTE_STOP_TIMEOUT/);
  await assert.rejects(closer.retry(f.id), /IN_FLIGHT/);
  assert.deepEqual(f.state.remote, [f.id]);
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.state.released, 0);
  await assert.rejects(closer.close(f.id), /REMOTE_STOP_TIMEOUT/);
  f.port.stopRemote = original;
  assert.deepEqual(await closer.retry(f.id), { requestId: f.id, state: 'stopped' });
  assert.deepEqual(f.state.remote, [f.id, f.id]);
  assert.equal(f.state.released, 1);
});

test('stop deadlines must be finite positive integer budgets', () => {
  const f = fixture();
  for (const localMilliseconds of [0, -1, Infinity, NaN, 1.5])
    assert.throws(
      () => new SessionCloser(f.port, { localMilliseconds, remoteMilliseconds: 10 }),
      /DEADLINE_INVALID/,
    );
});
