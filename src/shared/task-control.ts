import { z } from 'zod';
import { Id } from './contracts.js';
import { ExecutionContext, sameExecution } from './task-execution.js';

export const SessionStopBinding = ExecutionContext.extend({ requestId: Id }).strict();
export const SessionStopReceipt = SessionStopBinding.extend({
  state: z.literal('stopped'),
}).strict();
export const TaskControlBinding = SessionStopBinding.extend({
  jobId: Id,
  mode: z.enum(['pause', 'stop']),
}).strict();
export type StopBinding = z.infer<typeof SessionStopBinding>;
export type StopReceipt = z.infer<typeof SessionStopReceipt>;
export type ControlBinding = z.infer<typeof TaskControlBinding>;
export function sameStop(a: StopBinding, b: StopBinding): boolean {
  return sameExecution(a, b) && a.requestId === b.requestId;
}
export function sameControl(a: ControlBinding, b: ControlBinding): boolean {
  return sameStop(a, b) && a.jobId === b.jobId && a.mode === b.mode;
}
