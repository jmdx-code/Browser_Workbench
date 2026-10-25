import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Page, Response } from 'playwright-core';
import { FacebookDraftUploadTrace } from '../src/infrastructure/facebook-draft-upload-trace.js';

test('upload trace uses the existing page channel and keeps response evidence separate from readiness', async () => {
  const events = new EventEmitter();
  const page = Object.assign(events, {
    context: () => {
      throw Error('unexpected second CDP session');
    },
  }) as unknown as Page;
  let enabled = 0,
    persisted = 0;
  const trace = new FacebookDraftUploadTrace(async () => {
    persisted++;
  });
  const start: Parameters<FacebookDraftUploadTrace['start']> = [
    page,
    { operationId: 'original-upload' } as Parameters<FacebookDraftUploadTrace['start']>[1],
    { files: [{ name: 'original.mp4' }] } as Parameters<FacebookDraftUploadTrace['start']>[2],
    () => {},
    async () => {
      enabled++;
    },
  ];
  await trace.start(...start);
  const response = (url: string): Response =>
    ({
      url: () => url,
      request: () => ({ method: () => 'POST' }),
      status: () => 200,
      body: async () =>
        Buffer.from(
          JSON.stringify({
            video_id: '123456',
            status: 'processing',
            filename: 'original.mp4',
            access_token: 'do-not-retain',
            other: { filename: 'foreign.mp4' },
          }),
        ),
    }) as unknown as Response;
  events.emit('response', response('https://example.com/upload'));
  events.emit('response', response('https://rupload.facebook.com/video-upload'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(enabled, 1);
  assert.equal(persisted, 1);
  assert.equal(trace.records.length, 1);
  assert.deepEqual(trace.records[0]?.selected, {
    video_id: '123456',
    status: 'processing',
    filename: 'original.mp4',
  });
  assert.equal('ready' in trace.records[0]!, false);
  await trace.close();
  assert.equal(events.listenerCount('response'), 0);
  events.emit('response', response('https://rupload.facebook.com/video-upload'));
  assert.equal(trace.records.length, 1);
  const unavailable = new FacebookDraftUploadTrace(async () => {});
  await unavailable.start(page, start[1], start[2], start[3], async () => {
    throw Error('optional Network observation unavailable');
  });
  assert.deepEqual(unavailable.records, [
    { operationId: 'original-upload', result: 'OBSERVATION_UNAVAILABLE' },
  ]);
  await assert.rejects(
    unavailable.start(
      page,
      start[1],
      start[2],
      () => {
        throw Error('actor revoked');
      },
      async () => {},
    ),
    /actor revoked/,
  );
  await unavailable.close();
});

test('passive upload trace accepts attachment POST and video PUT but excludes unrelated requests', async () => {
  const events = new EventEmitter();
  const page = events as unknown as Page;
  const trace = new FacebookDraftUploadTrace(async () => {});
  await trace.start(
    page,
    { operationId: 'original-upload' } as Parameters<FacebookDraftUploadTrace['start']>[1],
    { files: [{ name: 'original.mp4' }] } as Parameters<FacebookDraftUploadTrace['start']>[2],
    () => {},
    async () => {},
  );
  const response = (url: string, method: string): Response =>
    ({
      url: () => url,
      request: () => ({ method: () => method }),
      status: () => 200,
      body: async () =>
        Buffer.from(
          'for (;;);' +
            JSON.stringify({
              video_id: '123456',
              processing_status: 'processing',
              credential: { id: '999' },
              filename: 'foreign.mp4',
            }),
        ),
    }) as unknown as Response;
  for (const [url, method] of [
    ['https://rupload.facebook.com/video-upload', 'GET'],
    ['https://www.facebook.com/ajax/react_composer/attachments/anything', 'GET'],
    ['https://www.facebook.com/ajax/react_composer/unrelated', 'POST'],
    ['https://example.com/ajax/react_composer/attachments/upload', 'POST'],
    ['https://vupload2.facebook.com/ajax/video/upload/requests/start/', 'GET'],
    ['https://vupload-edge.facebook.com/unrelated', 'POST'],
    ['https://vupload2.facebook.com.evil.test/ajax/video/upload/requests/post/', 'POST'],
    ['https://rupload.facebook.com/video-upload?token=do-not-retain', 'PUT'],
    ['https://www.facebook.com/ajax/react_composer/attachments/upload/?token=secret', 'POST'],
    ['https://vupload2.facebook.com/ajax/video/upload/requests/start/?token=secret', 'POST'],
    ['https://vupload-edge.facebook.com/ajax/video/upload/requests/receive/?token=secret', 'POST'],
    ['https://vupload2.facebook.com/ajax/video/upload/requests/post/?token=secret', 'POST'],
  ])
    events.emit('response', response(url!, method!));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(trace.records.length, 5);
  assert.deepEqual(
    trace.records.map((r) => r.method),
    ['PUT', 'POST', 'POST', 'POST', 'POST'],
  );
  for (const record of trace.records) {
    assert.deepEqual(record.selected, { video_id: '123456', processing_status: 'processing' });
    assert.equal('ready' in record, false);
    assert.equal(JSON.stringify(record).includes('secret'), false);
    assert.equal(JSON.stringify(record).includes('token'), false);
  }
  await trace.close();
});
