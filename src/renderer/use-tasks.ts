import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.js';
import type { z } from 'zod';
import type {
  TaskCapabilities,
  TaskRuntimeOverview,
  Assignment,
  TaskCommand,
} from '../shared/task-contracts.js';

export function useTasks() {
  const [capabilities, setCapabilities] = useState<z.infer<typeof TaskCapabilities> | null>(null);
  const [runtime, setRuntime] = useState<z.infer<typeof TaskRuntimeOverview> | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const replay = useRef<{ cursor?: string; terminals: NonNullable<typeof runtime>['plans'] }>({
    terminals: [],
  });
  const pendingStart = useRef<{ key: string; input: Assignment } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let cursor = replay.current.cursor;
    let terminalPlans = replay.current.terminals;
    const load = async () => {
      if (pending || controller.signal.aborted || document.hidden) return;
      pending = true;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
        const [caps, value] = await Promise.all([
          api.taskCapabilities(signal),
          api.taskRuntime(signal, cursor),
        ]);
        if (!controller.signal.aborted) {
          setCapabilities(caps);
          if (value.resetRequired) terminalPlans = [];
          const latest = new Map(terminalPlans.map((plan) => [plan.id, plan]));
          for (const plan of value.recentTerminalPlans ?? []) latest.set(plan.id, plan);
          for (const plan of value.plans) latest.delete(plan.id);
          terminalPlans = [...latest.values()]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 50);
          cursor = value.cursor;
          replay.current = { cursor, terminals: terminalPlans };
          setRuntime({ ...value, plans: [...value.plans, ...terminalPlans] });
          if (value.hasMore && !controller.signal.aborted) setTimeout(() => void load(), 0);
          setError('');
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setCapabilities(null);
          setError(
            failure instanceof ApiError && failure.code === 'TASK_CONTRACT_UPGRADE_REQUIRED'
              ? failure.message
              : '任务状态读取失败，恢复后可启动；下方记录可能是上次结果。',
          );
        }
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    const visible = () => void load();
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [revision]);
  const start = async (input: Omit<Assignment, 'requestId'>) => {
    const key = JSON.stringify(input);
    const attempt =
      pendingStart.current?.key === key
        ? pendingStart.current
        : {
            key,
            input: { ...input, requestId: crypto.randomUUID() },
          };
    pendingStart.current = attempt;
    // Keep the original request ID on reply loss; retrying the button cannot create a second batch.
    const result = await api.startTasks(attempt.input);
    pendingStart.current = null;
    setRevision((value) => value + 1);
    return result;
  };
  const command = async (input: TaskCommand) => {
    try {
      return await api.commandTasks(input);
    } finally {
      setRevision((value) => value + 1);
    }
  };
  return {
    capabilities,
    runtime,
    error,
    start,
    command,
    refresh: () => setRevision((value) => value + 1),
  };
}
