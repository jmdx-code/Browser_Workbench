import type { Awaitable } from './persistence.js';
import type { ControlBinding, StopReceipt } from '../shared/task-control.js';
import type { Plan } from '../shared/task-contracts.js';

export interface TaskControlRepository {
  bind(binding: ControlBinding): Awaitable<void>;
  confirm(binding: ControlBinding, receipt: StopReceipt): Awaitable<Plan>;
  list(): Awaitable<{ binding: ControlBinding; receipt: StopReceipt | null }[]>;
}
