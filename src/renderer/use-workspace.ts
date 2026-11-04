import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace } from '../shared/contracts.js';
import { api } from './api.js';
import { WorkspaceReader } from './workspace-reader.js';
export function useWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const reader = useRef<WorkspaceReader | null>(null);
  const refresh = useCallback(
    (force = false) => reader.current?.refresh(force) ?? Promise.resolve(),
    [],
  );
  useEffect(() => {
    const current = new WorkspaceReader(api.snapshot, (next, failure) => {
      if (next) setWorkspace(next);
      setError(failure);
    });
    reader.current = current;
    void current.refresh();
    let timer: ReturnType<typeof setInterval> | null = null;
    const schedule = () => {
      if (timer) clearInterval(timer);
      const hidden = typeof document !== 'undefined' && document.hidden;
      timer = setInterval(() => void current.refresh(), hidden ? 10_000 : 1800);
    };
    const onVisibility = () => {
      schedule();
      if (typeof document !== 'undefined' && !document.hidden) {
        void current.refresh();
      }
    };
    schedule();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      if (timer) clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      current.dispose();
      if (reader.current === current) reader.current = null;
    };
  }, [refresh]);
  return { workspace, error, refresh };
}
