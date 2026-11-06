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
}) {
  const { page, guard, sleep } = input;
  const tick = input.tickMs ?? 1000,
    stall = input.stallMs ?? 12000;
  const start = performance.now(),
    deadline = start + (input.budgetMs ?? 180000);
  let current = input.initial,
    clicked = false,
    css = current.videoCSS;
  const center = async (selector: string) => {
    guard();
    await page
      .locator(selector)
      .first()
      .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  };
  const read = async () => {
    guard();
    const next = await input.readCurrent();
    guard();
    if (next.postId !== input.initial.postId || next.feedbackId !== input.initial.feedbackId)
      throw Error('观看中的目标帖子已变化');
    return next;
  };
  const play = async () => {
    if (!css) return;
    guard();
    await page
      .locator(css)
      .first()
      .evaluate((el, sound) => {
        if (!(el instanceof HTMLVideoElement)) throw Error('视频节点已变化');
        el.loop = false;
        el.muted = !sound;
        if (sound && el.volume < 0.5) el.volume = 0.8;
        if (el.paused && !el.ended) {
          void el.play().catch(() => {
            el.muted = true;
            void el.play().catch(() => {});
          });
        }
      }, input.sound);
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
    await play().catch(() => {});
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
      )
        return 'ended';
      const now = performance.now();
      if (now >= deadline) {
        if (!progressed) throw Error('视频未实际播放，未执行本帖互动');
        return 'budget';
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
      if (lastTime >= 3 && time + 1.5 < lastTime && progressed) return 'ended';
      lastTime = time;
      lastFrames = frames;
      css = current.videoCSS ?? css;
      const offscreen = await page
        .locator(css)
        .first()
        .evaluate((el) => {
          const r = el.getBoundingClientRect(),
            h = innerHeight || 800;
          return r.bottom < h * 0.25 || r.top > h * 0.75;
        })
        .catch(() => false);
      if (offscreen) await center(css);
      if (
        !recovered &&
        (current.videoPaused || performance.now() - lastProgress >= Math.min(4000, stall / 2))
      ) {
        recovered = true;
        await center(css);
        await play().catch(() => {});
        if (current.videoPaused && current.videoPlayCSS && !clicked) {
          guard();
          clicked = true;
          await page.locator(current.videoPlayCSS).first().click({ timeout: 3000 });
        }
      }
      if (performance.now() - lastProgress >= stall)
        throw Error('视频播放长时间未推进，未执行本帖互动');
    }
  } finally {
    if (input.sound && css) {
      try {
        guard();
        await page
          .locator(css)
          .first()
          .evaluate((el) => {
            if (el instanceof HTMLVideoElement) el.muted = true;
          });
      } catch {
        /* Revocation owns cleanup after stop. */
      }
    }
  }
}
