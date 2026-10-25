import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import { FacebookPostEffects } from '../shared/facebook-post-observation.js';
import { readFacebookReviewContent } from './facebook-review-reader.js';
import { readFacebookReelContent } from './facebook-reel-reader.js';
import {
  facebookComposerPostLabels,
  FACEBOOK_COMPOSER_ADVANCE_COPY,
} from '../shared/facebook-ui.js';
import { projectFacebookReelResult } from './facebook-reel-result-reader.js';

// Fixed, bounded DOM projection. The asynchronous reader may hash this composer's local
// decoded Blob preview; it never fetches remote media, cookies, or page stores.
export function projectFacebookPostEffects(
  input:
    | 'visible'
    | 'result-dialog'
    | {
        scope: 'visible' | 'result-dialog';
        postLabels: string[];
        advanceLabels: string[];
      } = 'visible',
) {
  const scope = typeof input === 'string' ? input : input.scope;
  const postLabels = typeof input === 'string' ? ['发布'] : input.postLabels;
  const advanceLabels = typeof input === 'string' ? [] : input.advanceLabels;
  const visible = (e: Element) => {
    const rect = e.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      !e.closest('[aria-hidden="true"]') &&
      getComputedStyle(e).visibility !== 'hidden'
    );
  };
  const account = (href: string | null) => {
    if (!href) return null;
    try {
      const u = new URL(href, location.href);
      const id = u.searchParams.get('id');
      return u.origin === 'https://www.facebook.com' &&
        u.pathname === '/profile.php' &&
        /^\d{1,30}$/.test(id ?? '')
        ? id
        : null;
    } catch {
      return null;
    }
  };
  const roots = Array.from(
    document.querySelectorAll('[role="dialog"]:has(form [role="textbox"][contenteditable="true"])'),
  ).filter(visible);
  let composer = null;
  const root = roots.length === 1 ? roots[0] : undefined;
  if (root) {
    const edit = root.querySelector(
      'form [role="textbox"][contenteditable="true"]',
    ) as HTMLElement | null;
    const files = Array.from(
      root.querySelectorAll(
        'form input[type="file"][multiple][accept*="image/"][accept*="video/"]',
      ),
    );
    const lists = Array.from(root.querySelectorAll('[role="form"] [role="list"]')).filter(visible);
    const list = lists.length === 1 ? lists[0] : null;
    const images = list
      ? Array.from(list.querySelectorAll('img')).filter(visible)
      : Array.from(root.querySelectorAll('img')).filter((image) =>
          image.currentSrc.startsWith('blob:' + location.origin + '/'),
        );
    const removals = list
      ? Array.from(
          list.querySelectorAll(
            '[role="button"]:is([aria-label="移除视频"],[aria-label="Remove video"])',
          ),
        ).filter(visible)
      : [];
    const videos = Array.from(root.querySelectorAll('video')).filter(visible);
    // The observed homepage composer has a native form, no ARIA form/list, and a
    // unique attachment video. Its preview bytes/causal transfer are still required
    // by the business verifier; a video element or remove button alone never suffices.
    const rawVideos = Array.from(root.querySelectorAll('video'));
    const standaloneVideo = !list && rawVideos.length === 1 ? rawVideos[0] : undefined;
    const durations = list
      ? Array.from(list.querySelectorAll('span'))
          .filter(visible)
          .filter((element) => !element.querySelector('span'))
          .flatMap((element) => {
            const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(element.textContent ?? '');
            if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return [];
            return [Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])];
          })
      : [];
    const buttons = Array.from(root.querySelectorAll('[role="button"]')).filter(visible);
    const submits = buttons.filter((button) =>
      postLabels.includes(button.getAttribute('aria-label') ?? ''),
    );
    const advances = buttons.filter((button) =>
      advanceLabels.includes(button.getAttribute('aria-label') ?? ''),
    );
    const input = files.length === 1 ? (files[0] as HTMLInputElement) : null;
    if (edit && visible(edit) && input)
      composer = {
        text:
          edit.textContent === '' && !edit.querySelector('img,video,a')
            ? ''
            : edit.innerText.slice(0, 100_001),
        files: Array.from(input.files ?? [])
          .slice(0, 21)
          .map((f) => ({ name: f.name, size: f.size })),
        media: [
          ...images.map((e) => ({
            kind: 'image' as const,
            name: e.getAttribute('alt'),
            ready: (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0,
          })),
          ...removals.map(() => ({
            kind: 'video' as const,
            name: null,
            ...(durations.length === 1 && durations[0] && durations[0] > 0
              ? { durationSeconds: durations[0] }
              : {}),
            ready:
              videos.length === 1 &&
              Boolean(
                videos[0] &&
                videos[0].readyState >= 2 &&
                videos[0].videoWidth > 0 &&
                !videos[0].error,
              ),
          })),
          ...(standaloneVideo
            ? [
                {
                  kind: 'video' as const,
                  name: null,
                  ...(Number.isFinite(standaloneVideo.duration) && standaloneVideo.duration > 0
                    ? { durationSeconds: standaloneVideo.duration }
                    : {}),
                  ready:
                    standaloneVideo.readyState >= 2 &&
                    standaloneVideo.videoWidth > 0 &&
                    !standaloneVideo.error,
                },
              ]
            : []),
        ].slice(0, 21),
        uploaded: Array.from(root.querySelectorAll('[role="form"] span')).some(
          (e) => e.textContent === '已上传的影音内容',
        ),
        busy: Array.from(
          root.querySelectorAll('[role="progressbar"],[role="alert"],[aria-busy="true"]'),
        ).some(visible),
        submitEnabled:
          submits.length === 1 &&
          submits[0]?.getAttribute('aria-disabled') !== 'true' &&
          !submits[0]?.hasAttribute('disabled'),
        advanceEnabled:
          submits.length === 0 &&
          advances.length === 1 &&
          advances[0]?.getAttribute('aria-disabled') !== 'true' &&
          !advances[0]?.hasAttribute('disabled'),
      };
  }
  const articles = Array.from(document.querySelectorAll('[role="article"]'))
    .filter((e) => scope !== 'result-dialog' || e.closest('[role="dialog"]') !== null)
    .filter(visible);
  // The observed direct permalink renders one innermost post dialog without role=article.
  // Never apply this fallback to a feed or select among multiple post dialogs.
  const postDialog =
    '[role="dialog"]:has([data-ad-rendering-role="story_message"]):has([data-ad-rendering-role="profile_name"])';
  const dialogs =
    scope === 'result-dialog'
      ? Array.from(document.querySelectorAll(postDialog))
          .filter(visible)
          .filter((e) => !e.querySelector(postDialog) && !e.querySelector('[role="article"]'))
      : [];
  const postRoots = articles.length ? articles : dialogs.length === 1 ? dialogs : [];
  const posts = postRoots.slice(0, 21).map((root) => {
    const names = Array.from(
      root.querySelectorAll('[data-ad-rendering-role="profile_name"] a[href]'),
    );
    const authors = [
      ...new Set(
        names.map((e) => account(e.getAttribute('href'))).filter((x): x is string => x !== null),
      ),
    ];
    const links = Array.from(root.querySelectorAll('a[href]'));
    const result = links.flatMap((a) => {
      try {
        const u = new URL(a.getAttribute('href') ?? '', location.href);
        if (u.origin !== 'https://www.facebook.com') return [];
        if (u.pathname === '/permalink.php') {
          const post = u.searchParams.get('story_fbid'),
            id = u.searchParams.get('id');
          return post &&
            /^[a-zA-Z0-9]{1,200}$/.test(post) &&
            authors.length === 1 &&
            id === authors[0]
            ? [
                {
                  id: post,
                  url: 'https://www.facebook.com/permalink.php?story_fbid=' + post + '&id=' + id,
                },
              ]
            : [];
        }
        const reel = /^\/reel\/(\d{1,30})\/$/.exec(u.pathname);
        return reel?.[1]
          ? [{ id: reel[1], url: 'https://www.facebook.com/reel/' + reel[1] + '/' }]
          : [];
      } catch {
        return [];
      }
    });
    const results = [...new Map(result.map((x) => [x.id, x])).values()];
    if (
      scope === 'result-dialog' &&
      articles.length === 0 &&
      postRoots.length === 1 &&
      results.length === 0
    ) {
      const route = new URL(location.href),
        postId = route.searchParams.get('story_fbid'),
        actorId = route.searchParams.get('id');
      if (
        route.origin === 'https://www.facebook.com' &&
        route.pathname === '/permalink.php' &&
        route.searchParams.size === 2 &&
        !route.hash &&
        /^\d{1,30}$/.test(postId ?? '') &&
        authors.length === 1 &&
        actorId === authors[0] &&
        postId
      )
        results.push({ id: postId, url: route.href });
    }
    const slots = Array.from(
      root.querySelectorAll(
        '[data-ad-rendering-role="story_message"] [data-ad-comet-preview="message"]',
      ),
    );
    // FB inserts its expand/collapse control inside the final text line. Walk the visible original
    // text without that control; comparison uses the platform's rendered whitespace convention.
    const nativeMessages =
      scope === 'result-dialog'
        ? Array.from(root.querySelectorAll('[data-ad-rendering-role="story_message"]')).filter(
            visible,
          )
        : [];
    const slot =
      slots.length === 1
        ? slots[0]
        : slots.length === 0 && nativeMessages.length === 1
          ? nativeMessages[0]
          : undefined;
    const emoji = (image: HTMLImageElement) => {
      try {
        const url = new URL(image.currentSrc || image.src),
          alt = image.alt;
        return (
          url.origin === 'https://static.xx.fbcdn.net' &&
          url.pathname.startsWith('/images/emoji.php/') &&
          alt.length > 0 &&
          alt.length <= 24 &&
          /\p{Extended_Pictographic}/u.test(alt)
        );
      } catch {
        return false;
      }
    };
    const lines = slot
      ? Array.from(slot.querySelectorAll('div[dir="auto"]')).filter(
          (e) => visible(e) && !e.querySelector('div[dir="auto"]'),
        )
      : [];
    const text =
      slot && Array.from(slot.querySelectorAll('img')).every(emoji)
        ? (lines.length ? lines : [slot])
            .map((e) => {
              const walker = document.createTreeWalker(
                e,
                NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
              );
              let node: Node | null;
              let value = '';
              while ((node = walker.nextNode()))
                if (!node.parentElement?.closest('[role="button"],[aria-hidden="true"]')) {
                  if (node.nodeType === Node.TEXT_NODE) value += node.textContent ?? '';
                  else if (node instanceof HTMLImageElement && emoji(node)) value += node.alt;
                }
              return value;
            })
            .join('\n')
        : null;
    const photos = [
      ...new Set(
        links.flatMap((a) => {
          try {
            const u = new URL(a.getAttribute('href') ?? '', location.href);
            const id = u.searchParams.get('fbid');
            return u.origin === 'https://www.facebook.com' &&
              u.pathname === '/photo/' &&
              id &&
              /^\d{1,30}$/.test(id)
              ? [id]
              : [];
          } catch {
            return [];
          }
        }),
      ),
    ];
    const videoIds = [
      ...new Set(
        Array.from(root.querySelectorAll('[data-video-id]'))
          .map((e) => e.getAttribute('data-video-id'))
          .filter((x): x is string => /^\d{1,30}$/.test(x ?? '')),
      ),
    ];
    const videos = Array.from(root.querySelectorAll('video'));
    return {
      accountId: authors.length === 1 ? (authors[0] ?? null) : null,
      postId: results.length === 1 ? (results[0]?.id ?? null) : null,
      permalink: results.length === 1 ? (results[0]?.url ?? null) : null,
      text: text === null ? null : text.slice(0, 100_001),
      expanded: !Array.from(root.querySelectorAll('[role="button"]')).some(
        (e) =>
          visible(e) && ['展开', 'See more', '查看更多', 'See More'].includes(e.textContent ?? ''),
      ),
      nestedShare:
        links.some((a) => /\/groups\/[^/]+\/(?:posts|user)\//.test(a.getAttribute('href') ?? '')) ||
        authors.length > 1,
      photos: photos.slice(0, 21),
      videoId: videoIds.length === 1 ? (videoIds[0] ?? null) : null,
      videoReady:
        videos.length === 1 &&
        Boolean(
          videos[0] && videos[0].readyState >= 2 && videos[0].videoWidth > 0 && !videos[0].error,
        ),
    };
  });
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready: document.readyState,
    composer,
    posts,
  };
}

export async function readFacebookPostEffects(page: Page, assertCurrent: () => Awaitable<void>) {
  await assertCurrent();
  const reading = FacebookPostEffects.parse(
    await page.evaluate(projectFacebookPostEffects, {
      scope: 'visible' as const,
      postLabels: facebookComposerPostLabels(),
      advanceLabels: FACEBOOK_COMPOSER_ADVANCE_COPY.map((copy) => copy.label),
    }),
  );
  await assertCurrent();
  if (new URL(reading.url).origin !== 'https://www.facebook.com')
    throw Error('FACEBOOK_POST_EFFECT_ORIGIN');
  const review = await readFacebookReviewContent(page, assertCurrent);
  if (review.url !== reading.url || review.timeOrigin !== reading.timeOrigin)
    throw Error('FACEBOOK_POST_EFFECT_DOCUMENT_CHANGED');
  if (review.found) reading.composer = review.composer;
  const reel = await readFacebookReelContent(page, assertCurrent);
  if (reel.url !== reading.url || reel.timeOrigin !== reading.timeOrigin)
    throw Error('FACEBOOK_POST_EFFECT_DOCUMENT_CHANGED');
  if (reel.found) reading.composer = reel.composer;
  if (/^\/reel\/\d{1,30}\/$/.test(new URL(reading.url).pathname)) {
    const result = FacebookPostEffects.parse(await page.evaluate(projectFacebookReelResult));
    await assertCurrent();
    if (result.url !== reading.url || result.timeOrigin !== reading.timeOrigin)
      throw Error('FACEBOOK_POST_EFFECT_DOCUMENT_CHANGED');
    if (!reading.composer) reading.posts = result.posts;
  }
  const media = reading.composer?.media;
  if (media?.length && media.every((item) => item.kind === 'image' && item.ready)) {
    const previews = await page.evaluate(async () => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          !element.closest('[aria-hidden="true"]') &&
          getComputedStyle(element).visibility !== 'hidden'
        );
      };
      const roots = Array.from(
        document.querySelectorAll(
          '[role="dialog"]:has(form [role="textbox"][contenteditable="true"])',
        ),
      ).filter(visible);
      const root = roots.length === 1 ? roots[0] : null;
      if (!root) return null;
      const lists = Array.from(root.querySelectorAll('[role="form"] [role="list"]')).filter(
        visible,
      );
      const list = lists.length === 1 ? lists[0] : null;
      const images = list
        ? Array.from(list.querySelectorAll('img')).filter(visible)
        : Array.from(root.querySelectorAll('img')).filter((image) =>
            image.currentSrc.startsWith('blob:' + location.origin + '/'),
          );
      if (!images.length || images.length > 20) return null;
      const url = location.href,
        timeOrigin = performance.timeOrigin;
      let remaining = 32 * 1024 * 1024;
      const proofs = [];
      for (const image of images) {
        const src = image.currentSrc,
          name = image.getAttribute('alt');
        if (
          !src.startsWith('blob:' + location.origin + '/') ||
          !image.complete ||
          !image.naturalWidth ||
          !image.isConnected
        ) {
          proofs.push({ name, bytes: null });
          continue;
        }
        try {
          const response = await fetch(src);
          if (!response.ok || !response.body) return null;
          const reader = response.body.getReader(),
            chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > remaining) {
                await reader.cancel();
                return null;
              }
              chunks.push(part.value);
            }
          } finally {
            reader.releaseLock();
          }
          if (
            !size ||
            image.currentSrc !== src ||
            !image.isConnected ||
            !image.complete ||
            !image.naturalWidth ||
            image.getAttribute('alt') !== name
          )
            return null;
          remaining -= size;
          const data = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const digest = await crypto.subtle.digest('SHA-256', data);
          if (
            location.href !== url ||
            performance.timeOrigin !== timeOrigin ||
            image.currentSrc !== src ||
            !image.isConnected
          )
            return null;
          proofs.push({
            name,
            bytes: {
              source: 'owned-preview-blob' as const,
              size,
              sha256: Array.from(new Uint8Array(digest))
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join(''),
            },
          });
        } catch {
          return null;
        }
      }
      return { url, timeOrigin, proofs };
    });
    await assertCurrent();
    if (
      previews &&
      previews.url === reading.url &&
      previews.timeOrigin === reading.timeOrigin &&
      previews.proofs.length === media.length &&
      previews.proofs.every((proof, index) => proof.name === media[index]?.name)
    ) {
      previews.proofs.forEach((proof, index) => {
        const item = media[index];
        if (item && proof.bytes) item.previewBytes = proof.bytes;
      });
    }
  }
  if (
    media?.length === 1 &&
    media[0]?.kind === 'video' &&
    media[0].ready &&
    reading.composer?.files.length === 0
  ) {
    const proof = await page.evaluate(async () => {
      const roots = document.querySelectorAll(
        '[role="dialog"]:has(form [role="textbox"][contenteditable="true"])',
      );
      const root = roots.length === 1 ? roots[0] : null;
      const videos = root?.querySelectorAll('video');
      const video = videos?.length === 1 ? videos[0] : null;
      const src = video?.currentSrc;
      // A local preview Blob is immutable. Never fetch a remote URL, credentials, or feed media.
      if (
        !video ||
        !src?.startsWith('blob:' + location.origin + '/') ||
        video.readyState < 2 ||
        video.videoWidth <= 0 ||
        video.error
      )
        return null;
      try {
        const response = await fetch(src);
        if (!response.ok || !response.body) return null;
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 32 * 1024 * 1024) {
              await reader.cancel();
              return null;
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
        if (!size || video.currentSrc !== src || !video.isConnected || video.error) return null;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        if (video.currentSrc !== src || !video.isConnected || video.error) return null;
        return {
          url: location.href,
          timeOrigin: performance.timeOrigin,
          source: 'owned-preview-blob' as const,
          size,
          sha256: Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        };
      } catch {
        return null;
      }
    });
    await assertCurrent();
    if (proof && proof.url === reading.url && proof.timeOrigin === reading.timeOrigin)
      media[0].previewBytes = { source: proof.source, sha256: proof.sha256, size: proof.size };
  }
  return reading;
}
