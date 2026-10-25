import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mediaPoint } from '../../extension/media-point.js';
import { Action } from '../../src/bridge/protocol.js';
const action = {
  kind: 'mediaClick' as const,
  tabId: 1,
  documentEpoch: 0,
  routeEpoch: 0,
  mediaIndex: 0,
  mediaNodeId: 31,
  mediaSource: 'fixture.mp4',
  surface: { containerCSS: '.player', hitCSS: '.surface' },
};
function point(
  options: {
    hidden?: boolean;
    playing?: boolean;
    wrongSource?: boolean;
    hit?: 'video' | 'surface' | 'foreign' | 'control';
    allowSurface?: boolean;
  } = {},
) {
  const surface = { contains: (hit: unknown) => hit === overlay };
  const overlay = { matches: () => true, closest: () => (options.hit === 'control' ? {} : null) };
  const video = {
    currentSrc: options.wrongSource ? 'other.mp4' : 'fixture.mp4',
    paused: !options.playing,
    ended: false,
    contains: () => false,
    closest: () => surface,
    getBoundingClientRect: () => ({ x: 20, y: 30, width: 400, height: 200 }),
  };
  const hit =
    options.hit === 'video' || !options.hit
      ? video
      : options.hit === 'foreign'
        ? { matches: () => true, closest: () => null }
        : overlay;
  return runInNewContext(`(${mediaPoint.toString()})(action)`, {
    action: options.allowSurface === false ? { ...action, surface: undefined } : action,
    document: {
      visibilityState: options.hidden ? 'hidden' : 'visible',
      querySelectorAll: () => [video],
      elementFromPoint: () => hit,
    },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  });
}
test('视频命中与同一播放器内指定空展示层可输入；其他遮挡和控制元素拒绝', () => {
  assert.equal(point().x, 220);
  assert.equal(point({ hit: 'surface' }).y, 130);
  assert.throws(() => point({ hit: 'surface', allowSurface: false }), /TARGET_OCCLUDED/);
  assert.throws(() => point({ hit: 'foreign' }), /TARGET_OCCLUDED/);
  assert.throws(() => point({ hit: 'control' }), /TARGET_OCCLUDED/);
});
test('隐藏、已自动恢复播放或视频被替换时，在鼠标输入前拒绝', () => {
  assert.throws(() => point({ hidden: true }), /TARGET_HIDDEN/);
  assert.throws(() => point({ playing: true }), /MEDIA_STATE_CHANGED/);
  assert.throws(() => point({ wrongSource: true }), /MEDIA_CHANGED/);
});
test('媒体展示层参数严格限制，不接受执行脚本或额外字段', () => {
  assert.doesNotThrow(() => Action.parse(action));
  assert.throws(() =>
    Action.parse({ ...action, surface: { ...action.surface, script: 'video.play()' } }),
  );
  assert.throws(() =>
    Action.parse({ ...action, surface: { ...action.surface, hitCSS: 'x'.repeat(301) } }),
  );
});
