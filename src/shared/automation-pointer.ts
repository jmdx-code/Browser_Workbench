// Visual feedback only, not a system cursor or a fingerprint/stealth mechanism.
export function installAutomationPointer() {
  if (document.getElementById('bw-automation-pointer')) return;
  const marker = document.createElement('div');
  marker.id = 'bw-automation-pointer';
  marker.setAttribute('aria-hidden', 'true');
  marker.style.cssText =
    'position:fixed;left:0;top:0;width:14px;height:20px;background:#f59e0b;border:1px solid #111;clip-path:polygon(0 0,0 100%,35% 72%,60% 100%,76% 90%,54% 62%,100% 62%);pointer-events:none;z-index:2147483647;transform:translate(-30px,-30px)';
  document.documentElement.append(marker);
  document.addEventListener(
    'mousemove',
    (event) => {
      marker.style.transform = 'translate(' + event.clientX + 'px,' + event.clientY + 'px)';
    },
    { passive: true },
  );
  document.addEventListener(
    'mousedown',
    () => {
      marker.style.background = '#ef4444';
    },
    { passive: true },
  );
  document.addEventListener(
    'mouseup',
    () => {
      marker.style.background = '#f59e0b';
    },
    { passive: true },
  );
}
