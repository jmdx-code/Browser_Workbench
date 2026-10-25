import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { KernelRelayModel } from './kernel-relay-model.js';

// Private single-owner loopback endpoint. Not attached to the public workbench server.
export async function openKernelRelayEndpoint(model: KernelRelayModel) {
  const token = randomBytes(32).toString('hex');
  const route = '/kernel/' + randomUUID();
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  let client: WebSocket | undefined;
  let accepting = true;
  let stopping: ReturnType<KernelRelayModel['stop']> | undefined;
  let closing: ReturnType<KernelRelayModel['stop']> | undefined;
  let closed = false;
  let retrying: ReturnType<KernelRelayModel['stop']> | undefined;
  const stopRequestId = randomUUID();
  const stop = () => {
    accepting = false;
    stopping ??= model.stop(stopRequestId);
    client?.terminate();
    void stopping.catch(() => {});
    return stopping;
  };
  server.on('upgrade', (request, socket, head) => {
    const supplied = request.headers['x-workbench-kernel'];
    const a = Buffer.from(typeof supplied === 'string' ? supplied : '');
    const b = Buffer.from(token);
    if (
      !accepting ||
      client ||
      request.url !== route ||
      request.headers.origin !== undefined ||
      a.length !== b.length ||
      !timingSafeEqual(a, b)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    // Reserve before upgrading: two simultaneous upgrade events cannot take ownership.
    accepting = false;
    sockets.handleUpgrade(request, socket, head, (ws) => {
      client = ws;
      model.connect((message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      });
      ws.on('message', (raw) => {
        void (async () => {
          await model.receive(JSON.parse(raw.toString()) as unknown);
        })().catch(() => {
          stop();
          ws.close(1008, 'KERNEL_PROTOCOL_REJECTED');
        });
      });
      ws.on('close', stop);
      ws.on('error', stop);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('KERNEL_ENDPOINT_ADDRESS_INVALID');
  return {
    endpoint: `ws://127.0.0.1:${address.port}${route}`,
    headers: { 'x-workbench-kernel': token },
    close() {
      closing ??= (async () => {
        try {
          return await stop();
        } finally {
          client?.terminate();
          await new Promise<void>((resolve) => sockets.close(() => resolve()));
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          closed = true;
        }
      })();
      return closing;
    },
    retryClose() {
      // Never reopen sockets or restore the SDK. Recheck only the original executor's
      // drain/detach after the first bounded close finished; unresolved inputs remain.
      if (!closed) return Promise.reject(Error('KERNEL_LOCAL_STOP_RETRY_IN_FLIGHT'));
      retrying ??= model.stop(stopRequestId).finally(() => {
        retrying = undefined;
      });
      return retrying;
    },
  };
}
