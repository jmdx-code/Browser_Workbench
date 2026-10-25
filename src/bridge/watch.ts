import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Core } from './core.js';
import { BridgeError, ORIGIN, TaskURL, allowedTaskURL, type Action } from './protocol.js';
export const WatchSpec = z
  .object({
    profileId: z.string().uuid(),
    operationId: z.string().uuid(),
    url: TaskURL,
    targetSeconds: z.number().int().min(1).max(300),
    maxWallSeconds: z.number().int().min(10).max(600),
  })
  .strict()
  .refine((v) => v.maxWallSeconds >= v.targetSeconds + 5, 'WALL_BUDGET_TOO_SMALL');
export type WatchSpec = z.infer<typeof WatchSpec>;
export type Media = {
  index: number;
  nodeId: number;
  source: string;
  time: number;
  duration: number | null;
  paused: boolean;
  readyState: number;
  visible: boolean;
  area: number;
  loop: boolean;
  rate: number;
  ended: boolean;
};
export type Observation = {
  url: string;
  visibility: string;
  tabId: number;
  documentEpoch: number;
  routeEpoch: number;
  video: Media[];
  buttons: { label?: string; text?: string }[];
  text?: string;
};
export type Sample = {
  at: number;
  identity: string;
  visibility: string;
  media: Media;
  routeEpoch?: number;
};
export class Progress {
  seconds = 0;
  private previous?: Sample;
  add(current: Sample) {
    const previous = this.previous;
    this.previous = current;
    if (!previous) return { delta: 0, reason: 'BASELINE' };
    if (previous.identity !== current.identity) throw new BridgeError('MEDIA_OR_DOCUMENT_CHANGED');
    if (
      previous.media.readyState >= 2 &&
      current.media.readyState >= 2 &&
      previous.media.duration !== current.media.duration
    )
      throw new BridgeError('MEDIA_OR_DOCUMENT_CHANGED');
    // SPA history updates can occur while the same video node keeps playing.
    // Discard the transition interval; input commands still require the latest route epoch.
    if (previous.routeEpoch !== current.routeEpoch) return { delta: 0, reason: 'ROUTE_REBASELINE' };
    const valid = (s: Sample) =>
      s.visibility === 'visible' &&
      s.media.visible &&
      !s.media.paused &&
      s.media.readyState >= 2 &&
      Math.abs(s.media.rate - 1) < 0.01;
    if (!valid(current) || !valid(previous))
      return { delta: 0, reason: 'HIDDEN_PAUSED_OR_UNREADY' };
    const wall = (current.at - previous.at) / 1000;
    if (wall <= 0 || wall > 2.5) return { delta: 0, reason: 'SAMPLE_GAP' };
    let delta = current.media.time - previous.media.time;
    if (
      delta < 0 &&
      previous.media.loop &&
      current.media.loop &&
      previous.media.duration &&
      current.media.duration === previous.media.duration
    )
      delta += previous.media.duration;
    if (delta <= 0 || delta > wall + 0.25) return { delta: 0, reason: 'STALLED_OR_SEEKED' };
    delta = Math.min(delta, wall);
    this.seconds += delta;
    return { delta, reason: 'PLAYING' };
  }
}
export class PlayGate {
  private pausedSince?: number;
  due(observation: Observation, video: Media, at: number, graceMs: number) {
    if (!video.paused || !video.visible || observation.visibility !== 'visible' || video.ended) {
      this.pausedSince = undefined;
      return false;
    }
    this.pausedSince ??= at;
    return at - this.pausedSince >= graceMs;
  }
}
export class WatchTasks {
  private active = new Map<string, { taskId: string; aborted: boolean; epoch: string }>();
  constructor(
    private core: Core,
    private intervalMs = 1000,
    private globalLimit = 2,
  ) {}
  busy(profileId: string) {
    return this.active.has(profileId);
  }
  stop(profileId: string) {
    const task = this.active.get(profileId);
    if (task) task.aborted = true;
  }
  shutdown() {
    for (const task of this.active.values()) task.aborted = true;
  }
  async start(input: unknown) {
    const spec = WatchSpec.parse(input);
    const old = await this.core.store.taskByOperation(spec.profileId, spec.operationId);
    if (old) {
      if (old.spec !== JSON.stringify(spec)) throw new BridgeError('TASK_ID_CONFLICT');
      return old;
    }
    const peer = this.core.peers.get(spec.profileId);
    if (peer?.phase !== 'RUNNING' || !peer.synced) throw new BridgeError('PROFILE_NOT_RUNNING');
    if ((await this.core.store.unresolved(spec.profileId)).length)
      throw new BridgeError('RESULT_REVIEW_REQUIRED');
    if (spec.url.startsWith('https:') && !(await this.core.store.facebookAllowed(spec.profileId)))
      throw new BridgeError('FACEBOOK_NOT_AUTHORIZED');
    if (this.busy(spec.profileId)) throw new BridgeError('PROFILE_TASK_BUSY');
    if (this.active.size >= this.globalLimit) throw new BridgeError('GLOBAL_TASK_LIMIT');
    const { row } = await this.core.store.createTask(spec.profileId, spec.operationId, spec);
    const token = { taskId: row.taskId, aborted: false, epoch: peer.epoch };
    this.active.set(spec.profileId, token);
    void this.run(spec, token).catch(() => {});
    return row;
  }
  private async run(spec: WatchSpec, token: { taskId: string; aborted: boolean; epoch: string }) {
    const started = Date.now(),
      progress = new Progress(),
      playGate = new PlayGate();
    let tabId: number | undefined, clickId: string | undefined, last: Observation | undefined;
    let samples: unknown[] = [],
      playAttempted = false,
      activationAttempted = false;
    const check = () => {
      const peer = this.core.peers.get(spec.profileId);
      if (token.aborted || peer?.epoch !== token.epoch || peer.phase !== 'RUNNING')
        throw new BridgeError('TASK_INTERRUPTED');
      if (Date.now() - started > spec.maxWallSeconds * 1000)
        throw new BridgeError('WATCH_DEADLINE');
    };
    const command = async (action: Action) => {
      check();
      const row = await this.core.run({
        profileId: spec.profileId,
        operationId: randomUUID(),
        action,
      });
      check();
      if (!['VERIFIED', 'ACKNOWLEDGED'].includes(row.status))
        throw new BridgeError(
          'ACTION_' + row.status + ':' + (JSON.parse(row.result ?? '{}').error ?? ''),
        );
      return { row, evidence: JSON.parse(row.result ?? '{}').evidence };
    };
    const save = async (status: string, error?: string) =>
      await this.core.store.setTask(token.taskId, status, {
        tabId,
        effectiveSeconds: progress.seconds,
        targetSeconds: spec.targetSeconds,
        elapsedSeconds: (Date.now() - started) / 1000,
        samples: samples.slice(-30),
        lastObservation: last,
        error,
        criterion: '页面可见、视频可见、正常速度且时间连续增长；不代表平台已记为观看',
      });
    try {
      await save('RUNNING');
      const created = await command({ kind: 'createTaskTab', url: spec.url });
      tabId = created.evidence?.tabId;
      if (!tabId) throw new BridgeError('TASK_TAB_MISSING');
      while (progress.seconds < spec.targetSeconds) {
        check();
        let observed;
        try {
          observed = await command({ kind: 'observe', tabId });
        } catch (error) {
          if (
            progress.seconds === 0 &&
            Date.now() - started < 10000 &&
            error instanceof Error &&
            error.message === 'ACTION_FAILED:TAB_SCOPE_CHANGED'
          ) {
            samples.push({ at: Date.now(), reason: 'WAITING_FOR_ALLOWED_NAVIGATION' });
            await save('RUNNING');
            await delay(this.intervalMs);
            continue;
          }
          throw error;
        }
        last = observed.evidence as Observation;
        if (!allowedTaskURL(last.url)) {
          samples.push({ at: Date.now(), reason: 'WAITING_FOR_NAVIGATION' });
          await save('RUNNING');
          await delay(this.intervalMs);
          continue;
        }
        if (
          !activationAttempted &&
          this.core.peers.get(spec.profileId)?.capabilities?.includes('task-activation')
        ) {
          activationAttempted = true;
          await command({ kind: 'activateTab', tabId });
          samples.push({
            at: Date.now(),
            delta: 0,
            reason: 'TASK_ACTIVATION_SENT_REOBSERVE_VISIBILITY',
          });
          await save('RUNNING');
          await delay(this.intervalMs);
          continue;
        }
        const localFixture = new URL(spec.url).origin === ORIGIN;
        const surfaceFixture =
          localFixture && new URL(spec.url).searchParams.get('mediaSurface') === '1';
        const video = last.video
          ?.filter((v) => v.nodeId && (localFixture || v.readyState >= 2))
          .sort((a, b) => Number(b.visible) - Number(a.visible) || b.area - a.area)[0];
        if (!video) {
          samples.push({ at: Date.now(), reason: 'WAITING_FOR_MEDIA' });
          await save('RUNNING');
          await delay(this.intervalMs);
          continue;
        }
        const result = progress.add({
          at: Date.now(),
          identity: JSON.stringify([
            last.url,
            last.documentEpoch,
            video.index,
            video.nodeId,
            video.source,
          ]),
          routeEpoch: last.routeEpoch,
          visibility: last.visibility,
          media: video,
        });
        samples.push({
          at: Date.now(),
          time: video.time,
          visibility: last.visibility,
          visible: video.visible,
          paused: video.paused,
          ...result,
        });
        // Facebook may briefly pause during its initial player/route setup.
        // Observe a stable pause before sending the single allowed play input.
        const playDue = localFixture
          ? last.visibility === 'visible' &&
            video.paused &&
            !video.ended &&
            (!surfaceFixture || video.visible)
          : playGate.due(last, video, Date.now(), 2500);
        if (playDue && !playAttempted) {
          playAttempted = true;
          let action: Action = {
            kind: 'mediaClick',
            tabId,
            documentEpoch: last.documentEpoch,
            routeEpoch: last.routeEpoch,
            mediaIndex: video.index,
            mediaSource: video.source,
            mediaNodeId: video.nodeId,
            ...((surfaceFixture || !localFixture) &&
            this.core.peers.get(spec.profileId)?.capabilities?.includes('media-surface-input')
              ? {
                  surface: {
                    containerCSS: '[role="group"][aria-label="Video player"]',
                    hitCSS: '[role="presentation"]:empty',
                  },
                }
              : {}),
          };
          if (localFixture && !surfaceFixture)
            action = {
              kind: 'click',
              tabId,
              documentEpoch: last.documentEpoch,
              routeEpoch: last.routeEpoch,
              target: { css: '#play' },
            };
          else if (!surfaceFixture) {
            const playLabels = ['Play', '播放', '播放视频', 'Play video'];
            const labels = last.buttons.filter((b) => b.label && playLabels.includes(b.label));
            if (labels.length === 1)
              action = {
                kind: 'click',
                tabId,
                documentEpoch: last.documentEpoch,
                routeEpoch: last.routeEpoch,
                target: {
                  css: `button[aria-label=${JSON.stringify(labels[0]!.label)}],[role="button"][aria-label=${JSON.stringify(labels[0]!.label)}]`,
                },
              };
          }
          let clicked;
          try {
            clicked = await command(action);
          } catch (error) {
            if (
              error instanceof Error &&
              /^ACTION_FAILED:(?:Error: )?MEDIA_STATE_CHANGED$/.test(error.message)
            ) {
              samples.push({
                at: Date.now(),
                delta: 0,
                reason: 'PLAY_STATE_CHANGED_BEFORE_INPUT_NO_RETRY',
              });
              await save('RUNNING');
              await delay(this.intervalMs);
              continue;
            }
            throw error;
          }
          if (clicked.row.status === 'ACKNOWLEDGED') clickId = clicked.row.commandId;
          await save('RUNNING');
          await delay(this.intervalMs);
          continue;
        }
        if (clickId && result.delta > 0) {
          await this.core.review(
            spec.profileId,
            clickId,
            'CONFIRMED_SUCCESS',
            '连续观察确认播放时间增长',
            { observationCommandId: observed.row.commandId, observation: last },
          );
          clickId = undefined;
        }
        await save('RUNNING');
        await delay(this.intervalMs);
      }
      check();
      await command({ kind: 'closeTab', tabId });
      await save('VERIFIED');
    } catch (error) {
      const code = error instanceof Error ? error.message : 'WATCH_ERROR';
      await save(
        code === 'TASK_INTERRUPTED'
          ? 'INTERRUPTED'
          : (await this.core.store.unresolved(spec.profileId)).length
            ? 'NEEDS_REVIEW'
            : 'FAILED',
        code,
      );
      const peer = this.core.peers.get(spec.profileId);
      if (peer?.online && peer.epoch === token.epoch && peer.phase === 'RUNNING')
        await this.core.stop(spec.profileId);
    } finally {
      if (this.active.get(spec.profileId) === token) this.active.delete(spec.profileId);
    }
  }
}
