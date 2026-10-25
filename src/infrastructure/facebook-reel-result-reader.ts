// Actual own Reels result structure captured in audit/reel-result-readonly-0313.
// Project only the visible author's player and caption. Neighbouring recommendations and
// remote video URLs are excluded. Route identity is checked against the native submit later.
export function projectFacebookReelResult() {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth &&
      !element.closest('[aria-hidden="true"]') &&
      getComputedStyle(element).visibility !== 'hidden'
    );
  };
  const route = new URL(location.href);
  const videoId = /^\/reel\/(\d{1,30})\/?$/.exec(route.pathname)?.[1];
  const empty = {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready: document.readyState,
    composer: null,
    posts: [],
  };
  if (route.origin !== 'https://www.facebook.com' || !videoId || route.search || route.hash)
    return empty;
  const groups = Array.from(
    document.querySelectorAll(
      'main [role="group"][aria-label="Video player"],[role="main"] [role="group"][aria-label="Video player"]',
    ),
  )
    .filter(visible)
    .filter((group) => group.querySelector('h2 a[href],[role="heading"] a[href]'));
  if (groups.length !== 1 || !groups[0]) return empty;
  const group = groups[0];
  const authors = [
    ...new Set(
      Array.from(group.querySelectorAll('h2 a[href],[role="heading"] a[href]'))
        .filter(visible)
        .flatMap((link) => {
          try {
            const url = new URL(link.getAttribute('href') ?? '', location.href),
              id = url.searchParams.get('id');
            return url.origin === route.origin &&
              url.pathname === '/profile.php' &&
              id !== null &&
              /^\d{1,30}$/.test(id)
              ? [id]
              : [];
          } catch {
            return [];
          }
        }),
    ),
  ];
  if (authors.length !== 1) return empty;
  // The actual full caption is one dir=auto span; the collapse button is inside it.
  const captions = Array.from(group.querySelectorAll('span[dir="auto"]'))
    .filter(visible)
    .filter(
      (element) =>
        !element.closest('h2,[role="heading"],[role="button"]') &&
        !Array.from(element.querySelectorAll('span[dir="auto"]')).some(
          (child) => !child.closest('[role="button"]'),
        ),
    );
  if (captions.length > 1) return empty;
  let text: string | null = null;
  if (captions[0]) {
    const walker = document.createTreeWalker(captions[0], NodeFilter.SHOW_TEXT);
    text = '';
    let node: Node | null;
    while ((node = walker.nextNode()))
      if (!node.parentElement?.closest('[role="button"]')) text += node.textContent ?? '';
    if (text.length > 100_000) return empty;
  }
  let container: Element | null = group,
    video: HTMLVideoElement | null = null;
  for (let depth = 0; depth < 5 && container; depth++, container = container.parentElement) {
    const players = Array.from(
      container.querySelectorAll('[role="group"][aria-label="Video player"]'),
    ).filter(visible);
    const videos = Array.from(container.querySelectorAll('video')).filter(visible);
    if (players.length > 1 || videos.length > 1) return empty;
    if (videos.length === 1) {
      video = videos[0] ?? null;
      break;
    }
  }
  if (!video) return empty;
  return {
    ...empty,
    posts: [
      {
        accountId: authors[0],
        postId: videoId,
        permalink: route.href,
        text,
        expanded: !Array.from(group.querySelectorAll('[role="button"]')).some(
          (button) =>
            visible(button) &&
            ['展开', 'See more', '查看更多', 'See More'].includes(button.textContent?.trim() ?? ''),
        ),
        nestedShare: false,
        photos: [],
        videoId,
        videoReady:
          video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !video.error,
      },
    ],
  };
}
