import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config, open, prepare, action } from './db.mjs';
import { pathToFileURL } from 'node:url';
const role = process.argv[2],
  spec = JSON.parse(process.argv[3]);
const send = (type, value) => process.parentPort.postMessage({ type, ...value });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  if (role === 'holder') {
    const db = open(spec.file);
    if (spec.hold === 'write') {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE probe SET value=? WHERE id=1').run('held');
    } else {
      db.exec('BEGIN');
      db.prepare('SELECT * FROM probe').all();
    }
    send('held', { pid: process.pid });
    setTimeout(() => {
      db.exec('ROLLBACK');
      db.close();
      process.exit(0);
    }, spec.holdMs);
  } else if (role === 'scenario') {
    const file = path.join(config.scratch, spec.name + '.sqlite');
    const db = prepare(file);
    db.exec(`PRAGMA busy_timeout=${spec.timeout}`);
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    const gaps = [];
    let last = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 20);
    process.parentPort.once('message', async () => {
      try {
        await pause(100);
        histogram.reset();
        await pause(40);
        gaps.length = 0;
        last = performance.now();
        let result;
        const wallStart = performance.now();
        if (spec.mode === 'worker') {
          result = await new Promise((resolve, reject) => {
            const worker = new Worker(new URL('./action-worker.mjs', import.meta.url), {
              workerData: { ...spec, file },
            });
            let value;
            worker.once('message', (message) => {
              value = message;
            });
            worker.once('error', reject);
            worker.once('exit', (code) => {
              if (code || !value || value.workerError)
                reject(Error(value?.workerError ?? 'WORKER_EXIT_' + code));
              else resolve({ ...value, workerVersions: value.versions, workerExited: true });
            });
          });
        } else result = action(db, spec);
        const requestWallMs = performance.now() - wallStart;
        await pause(100);
        clearInterval(interval);
        histogram.disable();
        db.close();
        send('result', {
          value: {
            ...result,
            requestWallMs,
            pid: process.pid,
            versions: process.versions,
            gatewayTimerSamples: gaps.length,
            gatewayTimerGapMaxMs: Math.max(...gaps),
            gatewayDelayMaxMs: histogram.max / 1e6,
            gatewayDelayP99Ms: histogram.percentile(99) / 1e6,
          },
        });
      } catch (e) {
        send('error', { error: e.stack });
      }
    });
    send('prepared', { file });
  } else if (role === 'commits') {
    const { runE2 } = await import(pathToFileURL(config.bundle).href);
    send('result', { value: await runE2(config) });
  } else if (role === 'e1') {
    const { runE1 } = await import(pathToFileURL(config.bundle).href);
    send('result', { value: await runE1(config) });
  } else if (role === 'scoped') {
    const { runScoped } = await import(pathToFileURL(config.bundle).href);
    send('result', { value: await runScoped(config) });
  } else if (role === 'records') {
    const { runRecords } = await import(pathToFileURL(config.bundle).href);
    send('result', { value: await runRecords(config) });
  } else throw Error('UNKNOWN_LAB_ROLE');
} catch (e) {
  send('error', { error: e.stack });
}
