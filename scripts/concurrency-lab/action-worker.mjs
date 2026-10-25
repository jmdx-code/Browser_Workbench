import { parentPort, workerData } from 'node:worker_threads';
import { open, action } from './db.mjs';
try {
  const db = open(workerData.file, workerData.timeout);
  parentPort.postMessage({ versions: process.versions, ...action(db, workerData) });
  db.close();
} catch (e) {
  parentPort.postMessage({ workerError: e.stack });
}
