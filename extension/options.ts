import { bridgeTransportDescription } from '../src/shared/bridge-connection-status.js';
const status = document.querySelector('#state')!;
const details = document.querySelector('#details')!;
document.body.style.minWidth = '360px';
document.body.style.maxWidth = '560px';
document.querySelector('#connect')!.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CONNECT' });
  await refresh();
});
document.querySelector('#stop')!.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP' });
  await refresh();
});
async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: 'STATUS' });
  status.textContent = result.error
    ? '连接状态读取失败：' + result.error
    : bridgeTransportDescription(
        Boolean(result.connected),
        result.connectionStage ?? 'disconnected',
        result.connectionFailure ?? '',
      );
  details.textContent = result.profileId ? '资料编号：' + result.profileId.slice(0, 8) : '';
}
void refresh();
setInterval(() => {
  void refresh();
}, 2000);
