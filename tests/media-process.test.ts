import test from 'node:test';
import assert from 'node:assert/strict';
import { runMediaProcess } from '../src/infrastructure/media-process.js';

test('local media child collects bounded output without a shell and waits for actual exit', async () => {
  const text = 'literal spaces & ; " quotes';
  assert.equal(
    await runMediaProcess(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', text],
      () => {},
    ),
    text,
  );
  await assert.rejects(
    runMediaProcess(process.execPath, ['-e', 'process.exit(3)'], () => {}),
    /EXIT_FAILED/,
  );
  await assert.rejects(
    runMediaProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(1100000))'],
      () => {},
    ),
    /OUTPUT_BUDGET/,
  );
});

test('cancelled or timed-out media child is killed and collected before rejection', async () => {
  let checks = 0;
  await assert.rejects(
    runMediaProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], () => {
      if (++checks > 1) throw Error('STOPPED');
    }),
    /STOPPED/,
  );
  await assert.rejects(
    runMediaProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], () => {}, 50),
    /TIMEOUT/,
  );
  await assert.rejects(
    runMediaProcess('Z:/missing-media-process.exe', [], () => {}),
    /ENOENT/,
  );
});
