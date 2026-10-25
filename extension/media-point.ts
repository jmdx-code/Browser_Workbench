import type { Action } from '../src/bridge/protocol.js';
type MediaInput = Extract<Action, { kind: 'mediaClick' }>;
// Self-contained DOM guard, serialized into the owned document by the worker.
// Website selectors are supplied by the local adapter, never embedded here.
export function mediaPoint(action: MediaInput) {
  const video = document.querySelectorAll('video')[action.mediaIndex];
  if (!video || video.currentSrc !== action.mediaSource) throw Error('MEDIA_CHANGED');
  if (!video.paused || video.ended) throw Error('MEDIA_STATE_CHANGED');
  if (document.visibilityState !== 'visible') throw Error('TARGET_HIDDEN');
  const rect = video.getBoundingClientRect();
  const style = getComputedStyle(video);
  if (
    !rect.width ||
    !rect.height ||
    style.visibility !== 'visible' ||
    style.display === 'none' ||
    Number(style.opacity) === 0
  )
    throw Error('TARGET_HIDDEN');
  const x = rect.x + rect.width / 2,
    y = rect.y + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  let accepted = Boolean(hit && (hit === video || video.contains(hit)));
  if (!accepted && hit && action.surface) {
    const surface = video.closest(action.surface.containerCSS);
    accepted = Boolean(
      surface &&
      surface.contains(hit) &&
      hit.matches(action.surface.hitCSS) &&
      !hit.closest(
        'a,button,[role="button"],[role="dialog"],[aria-modal="true"],input,[contenteditable="true"]',
      ),
    );
  }
  if (!accepted) throw Error('TARGET_OCCLUDED');
  return { x, y };
}
