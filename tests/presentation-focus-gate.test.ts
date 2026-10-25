import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PresentationFocusGate,
  PositionRecoveryGate,
} from '../src/application/presentation-focus-gate.js';

test('position recovery has no absent FIFO owner; all 100 live profiles reach the native serial queue', () => {
  const gate = new PositionRecoveryGate();
  assert.equal(gate.request('a', 0), true);
  assert.equal(gate.request('a', 25), false);
  assert.equal(gate.request('b', 25), true);
  assert.equal(gate.request('a', 1999), false);
  assert.equal(gate.request('a', 2000), true);
  assert.equal(gate.request('b', 2025), true);
  // A denied/recovered owner that stops retrying cannot block unrelated profiles.
  for (let i = 0; i < 98; i++) assert.equal(gate.request('p' + i, 2025), true);
  assert.equal(gate.request('over-capacity', 2025), false);
  gate.cancel('a');
  assert.equal(gate.request('new', 2025), true);
});

test('one controller serializes foreground recovery with per-profile cooldown and FIFO fairness', () => {
  const gate = new PresentationFocusGate();
  assert.equal(gate.request('a', 0), true);
  assert.equal(gate.request('a', 2500), false);
  assert.equal(gate.request('b', 500), false);
  assert.equal(gate.request('c', 1000), false);
  assert.equal(gate.request('c', 2500), false);
  assert.equal(gate.request('b', 2500), true);
  assert.equal(gate.request('c', 5000), true);
  assert.equal(gate.request('a', 15000), true);
});

test('a stopped or expired queued owner never blocks recovery indefinitely', () => {
  const gate = new PresentationFocusGate();
  gate.request('a', 0);
  gate.request('stopped', 100);
  gate.request('b', 200);
  gate.cancel('stopped');
  assert.equal(gate.request('b', 2500), true);
  gate.request('gone', 3000);
  assert.equal(gate.request('c', 15001), true);
});

test('new extension can still authenticate to an old controller without advertising unknown capability names', async () => {
  const { bridgeHelloCapabilities, bridgeCapabilities } =
    await import('../src/shared/bridge-capabilities.js');
  for (const supported of [
    undefined,
    null,
    [],
    { capabilities: ['task-presentation-recovery-v1'] },
  ])
    assert.equal(
      bridgeHelloCapabilities(supported).includes('task-presentation-recovery-v1'),
      false,
    );
  assert.deepEqual(
    bridgeHelloCapabilities(bridgeCapabilities),
    bridgeCapabilities.filter((c) => c !== 'task-window-occlusion-focus-v1'),
  );
  assert.equal(
    bridgeHelloCapabilities(bridgeCapabilities).includes('task-window-occlusion-focus-v1'),
    false,
  );
  assert.equal(bridgeHelloCapabilities([]).includes('task-window-content-layout-v1'), false);
  assert.equal(bridgeHelloCapabilities([]).includes('task-window-simple-recovery-v1'), false);
  assert.equal(
    bridgeHelloCapabilities(bridgeCapabilities).includes('task-window-simple-recovery-v1'),
    true,
  );
  assert.equal(
    bridgeHelloCapabilities(['task-window-content-layout-v1']).includes(
      'task-window-content-layout-v1',
    ),
    true,
  );
  assert.equal(
    bridgeHelloCapabilities(bridgeCapabilities).length,
    new Set(bridgeHelloCapabilities(bridgeCapabilities)).size,
  );
  assert.equal(
    bridgeHelloCapabilities(['arbitrary-script']).includes('task-presentation-recovery-v1'),
    false,
  );
});
