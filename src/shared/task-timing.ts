import { z } from 'zod';
import { PosInt, intRange, sReq, strictObj } from './contracts.js';
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const TaskTimeZone = sReq(100).refine((v) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, '时区无效');
export const TaskTiming = z.discriminatedUnion('mode', [
  strictObj({ mode: z.literal('at'), startAt: PosInt.safe(), timeZone: TaskTimeZone }),
  strictObj({
    mode: z.literal('window'),
    startTime: time,
    endTime: time,
    timeZone: TaskTimeZone,
    weekdays: z
      .array(intRange(1, 7))
      .min(1, '请选择至少一个运行日期')
      .max(7)
      .refine((v) => new Set(v).size === v.length),
  }).refine((v) => v.startTime !== v.endTime, '开始和结束时间不能相同'),
]);
export type Timing = z.infer<typeof TaskTiming>;
export function taskTimingLabel(timing: Timing) {
  if (timing.mode !== 'at')
    return `运行时间窗 ${timing.startTime}～${timing.endTime}${timing.startTime > timing.endTime ? '（次日）' : ''} · ${timing.timeZone}`;
  const dt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timing.timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timing.startAt);
  return `定时 ${dt} · ${timing.timeZone}`;
}
