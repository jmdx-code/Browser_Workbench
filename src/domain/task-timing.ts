import { DateTime } from 'luxon';
import type { Timing } from '../shared/task-timing.js';
export function taskTimingEligibility(
  timing: Timing | undefined,
  now: number,
  alreadyStarted = false,
): 'OPEN' | 'WAIT' | 'MISSED' {
  if (!timing) return 'OPEN';
  if (timing.mode === 'at') {
    if (now < timing.startAt) return 'WAIT';
    return !alreadyStarted && now - timing.startAt > 60_000 ? 'MISSED' : 'OPEN';
  }
  const local = DateTime.fromMillis(now, { zone: timing.timeZone });
  if (!local.isValid) throw Error('SCHEDULE_TIME_ZONE_INVALID');
  const [startHour = 0, startMinute = 0] = timing.startTime.split(':').map(Number),
    [endHour = 0, endMinute = 0] = timing.endTime.split(':').map(Number);
  let day = local.startOf('day');
  const overnight = timing.startTime > timing.endTime;
  if (overnight && local.hour * 60 + local.minute < endHour * 60 + endMinute)
    day = day.minus({ days: 1 });
  if (!timing.weekdays.includes(day.weekday)) return 'WAIT';
  const start = day.set({ hour: startHour, minute: startMinute }),
    end = (overnight ? day.plus({ days: 1 }) : day).set({ hour: endHour, minute: endMinute });
  return now >= start.toMillis() && now < end.toMillis() ? 'OPEN' : 'WAIT';
}
