const events = [];
for (const type of ['click', 'input', 'keydown', 'change'])
  document.addEventListener(
    type,
    (e) => {
      events.push({
        type,
        trusted: e.isTrusted,
        target: e.target.id || e.target.closest('article')?.dataset.key,
        value: e.target.value,
      });
      document.getElementById('events').textContent = JSON.stringify(events.slice(-30));
    },
    true,
  );
document.getElementById('event-button').onclick = () =>
  (document.getElementById('business-state').textContent = '事件测试已完成');
function wire(e) {
  e.querySelector('button').onclick = () => (e.querySelector('output').textContent = '已点赞');
}
document.querySelectorAll('article').forEach(wire);
if (document.getElementById('replace'))
  document.getElementById('replace').onclick = () => {
    const old = document.querySelector('article[data-key=B]');
    const n = old.cloneNode(true);
    old.replaceWith(n);
    wire(n);
  };
if (document.getElementById('overlay'))
  document.getElementById('overlay').onclick = () =>
    (document.getElementById('cover').style.display = 'grid');
if (document.getElementById('dismiss'))
  document.getElementById('dismiss').onclick = () =>
    (document.getElementById('cover').style.display = 'none');
let revision = 0;
if (document.getElementById('route'))
  document.getElementById('route').onclick = () => {
    const url = new URL(location.href);
    url.searchParams.set('route', String(++revision));
    history.pushState({}, '', url);
  };
const video = document.getElementById('video');
if (video) {
  document.getElementById('play').onclick = () => video.play();
  document.getElementById('pause').onclick = () => video.pause();
  if (new URL(location.href).searchParams.get('mediaSurface') === '1') {
    const player = document.getElementById('player');
    const section = player.closest('section');
    document.querySelector('main').prepend(section);
    const surface = document.createElement('div');
    surface.setAttribute('role', 'presentation');
    surface.style.cssText = 'position:absolute;inset:0;background:transparent';
    surface.onclick = () => (video.paused ? video.play() : video.pause());
    player.append(surface);
  }
}
const visibility = [];
function sample() {
  visibility.push({
    at: Date.now(),
    visibility: document.visibilityState,
    time: video?.currentTime,
    paused: video?.paused,
    readyState: video?.readyState,
    networkState: video?.networkState,
    mediaError: video?.error ? { code: video.error.code, message: video.error.message } : null,
    mp4Support: video?.canPlayType('video/mp4; codecs="avc1.42E01E"'),
    viewport: { width: innerWidth, height: innerHeight },
    browser: { userAgent: navigator.userAgent, braveApi: Boolean(navigator.brave) },
  });
  document.getElementById('media-log').textContent = JSON.stringify(visibility.slice(-30));
}
document.addEventListener('visibilitychange', sample);
setInterval(sample, 1000);
sample();
