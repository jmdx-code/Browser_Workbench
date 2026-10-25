import test from 'node:test';
import assert from 'node:assert/strict';
import { guardNativeInput } from '../src/application/native-input-gate.js';
const input = {
  target: { tabId: 1 },
  method: 'Input.dispatchMouseEvent',
  params: { type: 'mousePressed' },
};
test('native input resources are checked after SDK waits and current owner is checked again before return', async () => {
  let active = true,
    resources = 0,
    sent = 0;
  const assertCurrent = () => {
    if (!active) throw Error('OWNER_REPLACED');
  };
  await assert.rejects(
    (async () => {
      await guardNativeInput(input, assertCurrent, async () => {
        resources++;
        await Promise.resolve();
        active = false;
      });
      sent++;
    })(),
    /OWNER_REPLACED/,
  );
  assert.equal(resources, 1);
  assert.equal(sent, 0);
});
test('native gate rejects resource validation failure before send', async () => {
  let sent = 0;
  await assert.rejects(
    (async () => {
      await guardNativeInput(
        { ...input, method: 'DOM.setFileInputFiles' },
        () => {},
        async () => {
          throw Error('STAGE_CHANGED');
        },
      );
      sent++;
    })(),
    /STAGE_CHANGED/,
  );
  assert.equal(sent, 0);
});
test('resource guard cannot replace native command parameters', async () => {
  await assert.rejects(
    guardNativeInput(
      input,
      () => {},
      async (command) => {
        command.params.type = 'mouseReleased';
      },
    ),
    /NATIVE_INPUT_GUARD_MUTATED_COMMAND/,
  );
});
test('mutating caller command during resource wait does not change the inspected snapshot', async () => {
  const request = structuredClone(input);
  const result = await guardNativeInput(
    request,
    () => {},
    async () => {
      request.target.tabId = 9;
      request.params.type = 'mouseReleased';
      await Promise.resolve();
    },
  );
  assert.deepEqual(result, input);
});
test('read-only commands do not acquire input resources and plain inputs still enforce current actor', async () => {
  let inspections = 0;
  await guardNativeInput(
    { ...input, method: 'Runtime.evaluate' },
    () => {
      throw Error('INPUT_FENCE_SHOULD_NOT_RUN');
    },
    async () => {
      inspections++;
    },
  );
  assert.equal(inspections, 0);
  await assert.rejects(
    guardNativeInput(input, () => {
      throw Error('ACTOR_REVOKED');
    }),
    /ACTOR_REVOKED/,
  );
});
