import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bridgeConnectionDescription,
  bridgeTransportDescription,
} from '../src/shared/bridge-connection-status.js';
test('transport readiness does not claim task pause or remain ready after disconnect', () => {
  assert.equal(bridgeTransportDescription(true, 'ready', ''), '软件已连接 · 通道就绪');
  assert.equal(bridgeTransportDescription(false, 'ready', ''), '尚未连接本机软件');
  assert.match(bridgeTransportDescription(true, 'restoring', ''), /原控制已停止/);
  assert.doesNotMatch(bridgeTransportDescription(true, 'ready', ''), /任务|暂停/);
});
test('bridge status distinguishes transport, authentication and stop recovery without exposing raw errors', () => {
  assert.match(bridgeConnectionDescription('connecting', ''), /连接本机端口/);
  assert.match(bridgeConnectionDescription('authenticating', ''), /正在认证/);
  assert.match(bridgeConnectionDescription('restoring', ''), /原控制已停止/);
  assert.match(bridgeConnectionDescription('disconnected', 'AUTH_OR_PROTOCOL_REJECTED'), /拒绝/);
  assert.match(bridgeConnectionDescription('disconnected', 'NETWORK_UNAVAILABLE'), /无法建立/);
  assert.equal(bridgeConnectionDescription('ready', 'AUTH_TIMEOUT'), '');
  assert.equal(
    bridgeConnectionDescription('disconnected', 'sensitive-unknown-error'),
    '尚未连接本机软件',
  );
});
