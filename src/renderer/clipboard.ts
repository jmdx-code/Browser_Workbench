export async function copyTextToClipboard(text: string): Promise<void> {
  if (!text) throw Error('没有可复制的内容');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Chromium can deny the async API; use the current document copy action.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-9999px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    if (!document.execCommand('copy')) throw Error('复制未成功，请手动选中复制');
  } finally {
    document.body.removeChild(area);
  }
}
