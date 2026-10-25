import http from 'node:http';
export async function reserveControllerPort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT_CONFIG_REJECTED');
  const bootstrapHandler: http.RequestListener = (_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain;charset=utf-8', 'retry-after': '1' });
    res.end('控制服务正在启动');
  };
  const server = http.createServer(bootstrapHandler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, bootstrapHandler };
}
export async function releaseControllerPort(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
