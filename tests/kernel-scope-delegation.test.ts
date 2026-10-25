import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KernelExecutor } from '../src/application/kernel-executor.js';
import { KernelLease } from '../src/domain/kernel-lease.js';
import type { KernelBackend } from '../src/shared/kernel-protocol.js';

for (const delegated of [false, true]) {
  test(`trusted scope delegation=${delegated} retains native scope, local ownership and lease checks`, async () => {
    const profileId = randomUUID(),
      lease = new KernelLease(profileId, randomUUID());
    let scopeCalls = 0,
      nativeChecks = 0,
      nativeAllowed = true;
    const backend: KernelBackend = {
      ...(delegated ? { scopeEnforcedBySend: true as const } : {}),
      scope: async () => {
        scopeCalls++;
      },
      attach: async () => ({
        targetId: 'fixed-target',
        type: 'page',
        title: '',
        url: 'http://127.0.0.1:18767/kernel-fixture',
        attached: true,
      }),
      detach: async () => {},
      create: async () => ({ tabId: 42 }),
      remove: async () => {},
      send: async (target) => {
        nativeChecks++;
        assert.equal(target.tabId, 42);
        if (!nativeAllowed) throw Error('GENERATED_NATIVE_SCOPE_CHANGED');
        return { result: { value: 1 } };
      },
    };
    const executor = new KernelExecutor(lease, backend, [42], new Set());
    executor.grant({
      profileId,
      connectionEpoch: lease.connectionEpoch,
      leaseId: randomUUID(),
      generation: 0,
      expiresAt: Date.now() + 10_000,
    });
    await executor.attach(42);
    scopeCalls = 0;
    assert.deepEqual(
      await executor.send({ tabId: 42 }, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
      }),
      { result: { value: 1 } },
    );
    assert.equal(scopeCalls, delegated ? 0 : 1);
    assert.equal(nativeChecks, 1);
    await assert.rejects(
      executor.send({ tabId: 43 }, 'Runtime.evaluate', { expression: '1' }),
      /NOT_OWNED/,
    );
    assert.equal(nativeChecks, 1);
    nativeAllowed = false;
    await assert.rejects(
      executor.send({ tabId: 42 }, 'Runtime.evaluate', { expression: '1' }),
      /NATIVE_SCOPE_CHANGED/,
    );
    assert.equal(nativeChecks, 2);
    lease.revoke();
    await assert.rejects(executor.send({ tabId: 42 }, 'Runtime.evaluate', { expression: '1' }));
    assert.equal(nativeChecks, 2);
  });
}
