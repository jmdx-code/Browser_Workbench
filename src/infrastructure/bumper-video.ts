import type { Page } from 'playwright-core';
import type { BumperPost } from './group-bumper-effects.js';

// Runs inside the existing bound setup operation. It does not grant control,
// submit reactions, or credit a wall-clock wait as actual video playback.
export async function watchBumperVideo(input: {
  page: Page;
  initial: BumperPost;
  readCurrent: () => Promise<BumperPost>;
  guard: () => void;
  sleep: (ms: number) => Promise<void>;
  sound: boolean;
  budgetMs?: number;
  tickMs?: number;
  stallMs?: number;
  onSummary?: (summary: {
    outcome: 'ended' | 'budget';
    speakerConfirmedUnmuted: boolean;
    videoSpeakerMuted: boolean | null;
    videoMuted: boolean | null;
    hoverAttempts: number;
    unmuteClicks: number;
  }) => void;
}) {
  const { page, guard, sleep } = input;
  const tick = input.tickMs ?? 1000,
    stall = input.stallMs ?? 12000;
  const start = performance.now(),
    deadline = start + (input.budgetMs ?? 180000);
  let current = input.initial,
    clicked = false,
    completed = false,
    hoverAttempts = 0,
    unmuteClicks = 0,
    speakerConfirmedUnmuted = current.videoSpeakerMuted === false,
    css = current.videoCSS;
  const center = async (selector: string) => {
    guard();
    await page
      .locator(selector)
      .first()
      .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }), undefined, {
        timeout: 3000,
      });
  };
  const read = async () => {
    guard();
    const next = await input.readCurrent();
    guard();
    if (next.postId !== input.initial.postId || next.feedbackId !== input.initial.feedbackId)
      throw Error('观看中的目标帖子已变化');
    if (next.videoSpeakerMuted === false) speakerConfirmedUnmuted = true;
    return next;
  };
  const wakePlayerControls = async (videoSelector: string) => {
    guard();
    const videoLocator = page.locator(videoSelector).first();
    if (typeof videoLocator.hover === 'function') {
      // Facebook CometVideoPlayer / Reels covers <video> with a full-bleed sibling overlay
      // div, causing non-forced Playwright hover() to time out on hit-target checks without
      // ever moving the pointer. force:true moves the real pointer onto the player overlay.
      await videoLocator.hover({ force: true, timeout: 2000 }).catch(() => {});
    }
    await videoLocator
      .evaluate(
        (el) => {
          if (!(el instanceof Element)) return;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return;
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const hit =
            typeof document !== 'undefined' && typeof document.elementFromPoint === 'function'
              ? document.elementFromPoint(cx, cy)
              : null;
          const targets = hit && hit !== el ? [hit, el] : [el];
          for (const target of targets) {
            try {
              if (typeof PointerEvent === 'function') {
                target.dispatchEvent(
                  new PointerEvent('pointerover', {
                    bubbles: true,
                    cancelable: true,
                    clientX: cx,
                    clientY: cy,
                  }),
                );
                target.dispatchEvent(
                  new PointerEvent('pointermove', {
                    bubbles: true,
                    cancelable: true,
                    clientX: cx,
                    clientY: cy,
                  }),
                );
              }
              if (typeof MouseEvent === 'function') {
                target.dispatchEvent(
                  new MouseEvent('mouseover', {
                    bubbles: true,
                    cancelable: true,
                    clientX: cx,
                    clientY: cy,
                  }),
                );
                target.dispatchEvent(
                  new MouseEvent('mousemove', {
                    bubbles: true,
                    cancelable: true,
                    clientX: cx,
                    clientY: cy,
                  }),
                );
              }
            } catch {
              /* Synthetic hover wakeup is best-effort alongside pointer hover. */
            }
          }
        },
        undefined,
        { timeout: 2000 },
      )
      .catch(() => {});
  };
  const clickSpeakerControl = async (audioSelector: string) => {
    guard();
    const audioLocator = page.locator(audioSelector).first();
    // Vertical 9:16 Reels inside tiled windows (500-602px tall) often leave the top-right
    // speaker icon above the viewport or behind Facebook's ~130px sticky group header after
    // centering <video>. Nudge scroll just enough to expose the speaker icon unobstructed
    // while keeping >70% of the video inside the viewport.
    await audioLocator
      .evaluate(
        (el) => {
          if (!(el instanceof Element) || typeof window === 'undefined') return;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0 || !(window.innerHeight > 0)) return;
          const topSafe = Math.min(148, Math.floor(window.innerHeight * 0.28));
          const bottomSafe = Math.max(topSafe + 40, window.innerHeight - 28);
          if (r.top < topSafe) {
            window.scrollBy(0, r.top - (topSafe + 12));
          } else if (r.bottom > bottomSafe) {
            window.scrollBy(0, r.bottom - (bottomSafe - 16));
          }
        },
        undefined,
        { timeout: 2000 },
      )
      .catch(() => {});
    let clickedOk = false;
    try {
      await audioLocator.click({ timeout: 2000 });
      clickedOk = true;
    } catch {
      clickedOk = false;
    }
    if (!clickedOk) {
      await audioLocator
        .evaluate(
          (el) => {
            if (el instanceof HTMLElement) el.click();
          },
          undefined,
          { timeout: 2000 },
        )
        .catch(() => {});
    }
  };
  const ensureUnmuted = async () => {
    if (!input.sound) return;
    if (current.videoSpeakerMuted === false) speakerConfirmedUnmuted = true;
    const needsSpeakerWakeup =
      !current.videoAudioCSS ||
      current.videoSpeakerMuted === true ||
      (current.videoSpeakerMuted === undefined &&
        (!speakerConfirmedUnmuted || current.videoMuted !== false));
    if (needsSpeakerWakeup && css && hoverAttempts < 4) {
      hoverAttempts++;
      await wakePlayerControls(css);
      await sleep(Math.min(250, tick));
      current = await read().catch(() => current);
      css = current.videoCSS ?? css;
    }
    const speakerNeedsClick =
      current.videoSpeakerMuted === true ||
      (current.videoSpeakerMuted === undefined &&
        (!speakerConfirmedUnmuted || current.videoMuted !== false));
    if (current.videoAudioCSS && speakerNeedsClick && unmuteClicks < 3) {
      unmuteClicks++;
      await clickSpeakerControl(current.videoAudioCSS);
      await sleep(Math.min(200, tick));
      current = await read().catch(() => current);
      css = current.videoCSS ?? css;
      // If normal click hit an animating/covered control and speaker stayed muted, fallback to DOM click once.
      if (current.videoAudioCSS && current.videoSpeakerMuted === true && unmuteClicks < 3) {
        unmuteClicks++;
        guard();
        await page
          .locator(current.videoAudioCSS)
          .first()
          .evaluate(
            (el) => {
              if (el instanceof HTMLElement) el.click();
            },
            undefined,
            { timeout: 2000 },
          )
          .catch(() => {});
        await sleep(Math.min(200, tick));
        current = await read().catch(() => current);
        css = current.videoCSS ?? css;
      }
    }
  };
  const play = async (allowDirectUnmute: boolean) => {
    if (!css) return;
    guard();
    await page
      .locator(css)
      .first()
      .evaluate(
        (el, opts) => {
          if (!(el instanceof HTMLVideoElement)) throw Error('视频节点已变化');
          el.loop = false;
          if (!opts.sound) {
            el.muted = true;
            if (el.paused && !el.ended) {
              void el.play().catch(() => {});
            }
            return;
          }
          if (el.volume < 0.5) el.volume = 0.8;
          if (opts.allowDirectUnmute) {
            const canUnmuteDirectly =
              typeof navigator === 'undefined' ||
              !('userActivation' in navigator) ||
              Boolean(navigator.userActivation?.hasBeenActive);
            if (el.muted && (canUnmuteDirectly || el.paused)) {
              el.muted = false;
            }
          }
          if (el.paused && !el.ended) {
            void el.play().catch(() => {
              el.muted = true;
              void el.play().catch(() => {});
            });
          }
        },
        { sound: input.sound, allowDirectUnmute },
        { timeout: 3000 },
      );
  };
  try {
    const lazyUntil = Math.min(deadline, start + 6000);
    while (!css && performance.now() < lazyUntil) {
      if (current.videoPlayCSS && !clicked) {
        guard();
        clicked = true;
        await page.locator(current.videoPlayCSS).first().click({ timeout: 3000 });
      }
      await sleep(Math.min(300, tick));
      current = await read();
      css = current.videoCSS;
    }
    if (!css) throw Error('视频播放器未加载，未执行本帖互动');
    await center(css);
    if (input.sound && current.videoPaused !== false && !current.videoAudioCSS) {
      // CometVideoPlayer on poster frame does not mount the bottom speaker button until
      // playback starts. Start playback first without mutating el.muted=false, then wake
      // and click Facebook's real speaker button so its React state & icon flip on.
      if (current.videoPlayCSS && !clicked) {
        guard();
        clicked = true;
        await page
          .locator(current.videoPlayCSS)
          .first()
          .click({ timeout: 3000 })
          .catch(() => {});
      }
      await play(false).catch(() => {});
      await sleep(Math.min(300, tick));
      current = await read().catch(() => current);
      css = current.videoCSS ?? css;
    }
    const canFallbackDirectUnmute = () =>
      speakerConfirmedUnmuted || hoverAttempts >= 4 || unmuteClicks >= 3;
    const finish = (outcome: 'ended' | 'budget'): 'ended' | 'budget' => {
      completed = true;
      input.onSummary?.({
        outcome,
        speakerConfirmedUnmuted,
        videoSpeakerMuted: current.videoSpeakerMuted ?? null,
        videoMuted: current.videoMuted ?? null,
        hoverAttempts,
        unmuteClicks,
      });
      return outcome;
    };
    await ensureUnmuted();
    await play(canFallbackDirectUnmute()).catch(() => {});
    let lastTime = current.videoCurrentTime ?? 0,
      lastFrames = current.videoFrames ?? 0,
      lastProgress = performance.now(),
      progressed = false,
      recovered = false,
      missing = 0;
    while (true) {
      guard();
      if (
        current.videoEnded === true ||
        (typeof current.videoDuration === 'number' &&
          current.videoDuration >= 2 &&
          (current.videoCurrentTime ?? 0) >= current.videoDuration - 0.6)
      ) {
        return finish('ended');
      }
      const now = performance.now();
      if (now >= deadline) {
        if (!progressed) throw Error('视频未实际播放，未执行本帖互动');
        return finish('budget');
      }
      await sleep(Math.min(tick, deadline - now));
      try {
        current = await read();
        missing = 0;
      } catch (error) {
        guard();
        if (++missing >= 3) throw error;
        continue;
      }
      const time = current.videoCurrentTime ?? 0,
        frames = current.videoFrames ?? 0;
      if (time > lastTime + 0.03 || frames > lastFrames) {
        progressed = true;
        lastProgress = performance.now();
        recovered = false;
      }
      if (lastTime >= 3 && time + 1.5 < lastTime && progressed) {
        return finish('ended');
      }
      lastTime = time;
      lastFrames = frames;
      css = current.videoCSS ?? css;
      if (
        input.sound &&
        unmuteClicks < 3 &&
        (current.videoSpeakerMuted === true ||
          (!speakerConfirmedUnmuted && hoverAttempts < 4) ||
          (current.videoSpeakerMuted === undefined &&
            current.videoMuted === true &&
            hoverAttempts < 4))
      ) {
        await ensureUnmuted();
        await play(canFallbackDirectUnmute()).catch(() => {});
      }
      const offscreen = await page
        .locator(css)
        .first()
        .evaluate(
          (el) => {
            const r = el.getBoundingClientRect(),
              h = innerHeight || 800;
            return r.bottom < h * 0.25 || r.top > h * 0.75;
          },
          undefined,
          { timeout: 3000 },
        )
        .catch(() => false);
      if (offscreen) await center(css);
      if (
        !recovered &&
        (current.videoPaused || performance.now() - lastProgress >= Math.min(4000, stall / 2))
      ) {
        recovered = true;
        await center(css);
        if (current.videoPaused && current.videoPlayCSS && !clicked) {
          guard();
          clicked = true;
          await page.locator(current.videoPlayCSS).first().click({ timeout: 3000 });
        }
        await play(canFallbackDirectUnmute()).catch(() => {});
        await ensureUnmuted();
      }
      if (performance.now() - lastProgress >= stall)
        throw Error('视频播放长时间未推进，未执行本帖互动');
    }
  } finally {
    if (!completed && input.sound && css) {
      try {
        guard();
        await page
          .locator(css)
          .first()
          .evaluate(
            (el) => {
              if (el instanceof HTMLVideoElement) el.muted = true;
            },
            undefined,
            { timeout: 2000 },
          );
      } catch {
        /* Revocation owns cleanup after stop. */
      }
    }
  }
}
