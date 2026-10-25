import { z } from 'zod';
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const TaskTimeZone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, '时区无效');
export const TaskTiming = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('at'),
      startAt: z.number().int().positive().safe(),
      timeZone: TaskTimeZone,
    })
    .strict(),
  z
    .object({
      mode: z.literal('window'),
      startTime: time,
      endTime: time,
      timeZone: TaskTimeZone,
      weekdays: z
        .array(z.number().int().min(1).max(7))
        .min(1, '请选择至少一个运行日期')
        .max(7)
        .refine((values) => new Set(values).size === values.length),
    })
    .strict()
    .refine((value) => value.startTime !== value.endTime, '开始和结束时间不能相同'),
]);
export type Timing = z.infer<typeof TaskTiming>;
export function taskTimingLabel(timing: Timing) {
  return timing.mode === 'at'
    ? '定时 ' +
        new Intl.DateTimeFormat('zh-CN', {
          timeZone: timing.timeZone,
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(timing.startAt) +
        ' · ' +
        timing.timeZone
    : '运行时间窗 ' +
        timing.startTime +
        '～' +
        timing.endTime +
        (timing.startTime > timing.endTime ? '（次日）' : '') +
        ' · ' +
        timing.timeZone;
}
