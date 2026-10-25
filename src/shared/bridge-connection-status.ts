const failures: Record<string, string> = {
  NETWORK_UNAVAILABLE: '无法建立本机连接，请检查本机端口或浏览器网络提示',
  AUTH_TIMEOUT: '连接已到达软件，但认证握手超时',
  AUTH_OR_PROTOCOL_REJECTED: '软件拒绝了认证或协议，请保留资料编号供核对',
  PROTOCOL_REJECTED: '插件拒绝了软件返回的协议消息',
  CONNECTION_CLOSED: '本机连接已断开，插件将尝试重连',
};
export function bridgeConnectionDescription(stage: string, failure: string) {
  if (stage === 'ready') return '';
  const previous = Object.hasOwn(failures, failure) ? failures[failure] : undefined;
  if (previous && ['connecting', 'authenticating'].includes(stage)) return previous + '；正在重连';
  if (stage === 'restoring') return '软件握手已通过，正在确认原控制已停止';
  if (stage === 'authenticating') return '已到达本机软件，正在认证';
  if (stage === 'connecting') return '正在连接本机端口18767';
  return previous ?? '尚未连接本机软件';
}

export function bridgeTransportDescription(connected: boolean, stage: string, failure: string) {
  return connected && stage === 'ready'
    ? '软件已连接 · 通道就绪'
    : bridgeConnectionDescription(stage === 'ready' ? 'disconnected' : stage, failure);
}
