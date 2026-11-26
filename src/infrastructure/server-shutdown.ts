export interface BoundedShutdownDeps {
  stopTimers: () => void;
  stopServices: () => Promise<void>;
  recordStopping: () => void;
  closeBridge: () => Promise<void>;
  flushLogs: () => Promise<void>;
  closePersistence: () => Promise<void>;
  serviceStopBudgetMs?: number;
  logFlushBudgetMs?: number;
}
async function runWithBudget(work: () => Promise<void>, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/**
 * Coordinates graceful server shutdown with an explicit budget for stopping
 * background services so `closeBridge()` and `closePersistence()` (WAL checkpoint)
 * are always guaranteed to execute before the Electron shell exits.
 */
export async function runBoundedServerShutdown(deps: BoundedShutdownDeps): Promise<void> {
  deps.stopTimers();
  await runWithBudget(deps.stopServices, deps.serviceStopBudgetMs ?? 7_000);
  deps.recordStopping();
  await runWithBudget(deps.closeBridge, 3_000);
  await runWithBudget(deps.flushLogs, deps.logFlushBudgetMs ?? 1_000);
  await deps.closePersistence();
}
