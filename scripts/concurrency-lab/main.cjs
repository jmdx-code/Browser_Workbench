// Separate, windowless Electron entry point: never imports the production desktop/server.
const { app, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.env.WORKBENCH_LAB_CONFIG, 'utf8'));
if (fs.readFileSync(path.join(config.scratch, '.isolated-lab'), 'utf8') !== config.id)
  throw Error('LAB_MARKER');
app.setPath('userData', path.join(config.scratch, 'electron-user'));
app.setPath('sessionData', path.join(config.scratch, 'electron-session'));
const children = new Set();
const results = [];
const report = { ...config, electronMain: process.versions, results, complete: false };
function save() {
  fs.writeFileSync(path.join(config.reportDir, 'results.json'), JSON.stringify(report, null, 2));
}
function child(role, spec) {
  const p = utilityProcess.fork(path.join(__dirname, 'utility.mjs'), [role, JSON.stringify(spec)], {
    env: { ...process.env },
    stdio: 'pipe',
    serviceName: 'Isolated concurrency lab ' + role,
  });
  children.add(p);
  p.on('exit', () => children.delete(p));
  for (const stream of [p.stdout, p.stderr])
    stream?.on('data', (c) => fs.appendFileSync(path.join(config.reportDir, 'utility.log'), c));
  return p;
}
function wait(p, type, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('LAB_TIMEOUT_' + type)), timeoutMs);
    const onExit = (code) => finish(Error('LAB_CHILD_EXIT_' + code + '_WAIT_' + type));
    const onMessage = (m) => {
      if (m.type === 'error') finish(Error(m.error));
      else if (m.type === type) finish(null, m);
    };
    function finish(error, value) {
      clearTimeout(timer);
      p.off('message', onMessage);
      p.off('exit', onExit);
      error ? reject(error) : resolve(value);
    }
    p.on('message', onMessage);
    p.once('exit', onExit);
  });
}
async function stop(p) {
  if (!children.has(p)) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    p.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    p.kill();
  });
}
app.on('before-quit', () => {
  for (const p of children) p.kill();
});
app.whenReady().then(async () => {
  try {
    const cases = [
      { name: 'baseline-direct', mode: 'direct', timeout: 5000 },
      { name: 'baseline-worker', mode: 'worker', timeout: 5000 },
      {
        name: 'write-lock-direct-5000',
        mode: 'direct',
        timeout: 5000,
        hold: 'write',
        holdMs: 6500,
      },
      {
        name: 'write-lock-worker-5000',
        mode: 'worker',
        timeout: 5000,
        hold: 'write',
        holdMs: 6500,
      },
      { name: 'write-lock-direct-100', mode: 'direct', timeout: 100, hold: 'write', holdMs: 800 },
      { name: 'write-lock-released', mode: 'direct', timeout: 5000, hold: 'write', holdMs: 500 },
      { name: 'reader-ordinary-write', mode: 'direct', timeout: 5000, hold: 'read', holdMs: 800 },
      {
        name: 'reader-close-checkpoint',
        mode: 'direct',
        timeout: 5000,
        hold: 'read',
        holdMs: 6500,
        action: 'checkpoint',
      },
    ];
    for (const spec of config.experiments.includes('E5') ? cases : []) {
      const p = child('scenario', spec);
      const prepared = await wait(p, 'prepared');
      let holder;
      if (spec.hold) {
        holder = child('holder', { ...spec, file: prepared.file });
        await wait(holder, 'held');
      }
      const result = wait(p, 'result');
      p.postMessage({ type: 'go' });
      const value = (await result).value;
      const expectsBusy = spec.hold === 'write' && spec.holdMs > spec.timeout;
      const expectationMet =
        spec.action === 'checkpoint'
          ? value.value?.busy === 1
          : expectsBusy
            ? value.error?.errcode === 5 && value.count === 1
            : !value.error && value.count === 2;
      results.push({ experiment: 'E5', ...spec, ...value, expectationMet });
      save();
      if (holder) await stop(holder);
      await stop(p);
      if (!expectationMet) throw Error('LAB_EXPECTATION_FAILED_' + spec.name);
    }
    const scoped = config.experiments.includes('E1-SCOPED');
    const commits = config.experiments.includes('E2');
    const records = config.experiments.includes('E1-RECORDS');
    const e1 = child(commits ? 'commits' : records ? 'records' : scoped ? 'scoped' : 'e1', {});
    results.push({
      experiment: commits ? 'E2' : records ? 'E1-RECORDS' : scoped ? 'E1-SCOPED' : 'E1',
      ...(
        await wait(
          e1,
          'result',
          config.e1Matrix ? 330000 : records ? 330000 : scoped || commits ? 120000 : 35000,
        )
      ).value,
    });
    await stop(e1);
    report.complete = true;
    save();
    app.exit(0);
  } catch (error) {
    report.error = error.stack;
    save();
    await Promise.all([...children].map(stop));
    app.exit(1);
  }
});
