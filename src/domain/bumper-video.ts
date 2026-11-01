export interface BumperVideoSample {
  time: number;
  frames: number;
  source: string;
  paused: boolean;
  ended: boolean;
  ready: number;
}
export function bumperVideoCredit(
  previous: BumperVideoSample,
  current: BumperVideoSample,
  sampleIntervalMs: number,
  stepMs: number,
  frameOnlyGrantedMs: number,
) {
  const interval = Math.max(0, Math.min(stepMs * 2, Math.round(sampleIntervalMs)));
  if (current.source && previous.source && current.source !== previous.source)
    return { grantedMs: 0, frameOnlyGrantedMs, sourceChanged: true };
  const delta = current.time - previous.time,
    frames = current.frames - previous.frames;
  if (delta > 0 && delta <= (interval / 1000) * 2.5 + 0.25)
    return {
      grantedMs: Math.min(interval, Math.round(delta * 1000)),
      frameOnlyGrantedMs: 0,
      sourceChanged: false,
    };
  if (delta === 0 && frames > 0 && !current.paused && !current.ended && current.ready >= 2) {
    const grantedMs = Math.max(
      0,
      Math.min(interval, Math.max(40, Math.round((frames / 24) * 1000)), 1500 - frameOnlyGrantedMs),
    );
    return { grantedMs, frameOnlyGrantedMs: frameOnlyGrantedMs + grantedMs, sourceChanged: false };
  }
  return { grantedMs: 0, frameOnlyGrantedMs, sourceChanged: false };
}
