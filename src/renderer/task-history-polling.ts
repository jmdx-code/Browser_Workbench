import type { History } from '../shared/task-contracts.js';

export function taskHistoryNeedsPolling(
  history: Pick<History, 'selectedPlanId' | 'plans'>,
  requestedPlanId: string | null,
): boolean {
  if (!requestedPlanId) return true;
  const terminal = new Set(['FAILED', 'STOPPED', 'COMPLETED']);
  if (history.selectedPlanId === requestedPlanId) {
    const selected = history.plans.find((plan) => plan.id === history.selectedPlanId);
    return !!selected && !terminal.has(selected.state);
  }
  return true;
}
