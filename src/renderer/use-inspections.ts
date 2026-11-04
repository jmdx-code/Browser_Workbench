import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { InspectionReader, type InspectionReadState } from './inspection-reader.js';

export function useInspections() {
  const [state, setState] = useState<InspectionReadState>({
    rows: [],
    available: false,
    error: '',
  });
  const reader = useRef<InspectionReader | null>(null);
  useEffect(() => {
    const current = new InspectionReader(
      { read: api.profileInspections, request: api.inspectProfiles },
      setState,
    );
    reader.current = current;
    void current.refresh();
    let timer: ReturnType<typeof setInterval> | null = null;
    const schedule = () => {
      if (timer) clearInterval(timer);
      const hidden = typeof document !== 'undefined' && document.hidden;
      timer = setInterval(() => void current.refresh(), hidden ? 10_000 : 2000);
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
  }, []);
  const refresh = useCallback(() => reader.current?.refresh() ?? Promise.resolve(), []);
  const request = useCallback(async (ids: string[]) => {
    const current = reader.current;
    if (!current) throw Error('检查服务尚未连接，请稍候。');
    return current.request(ids);
  }, []);
  return { ...state, refresh, request };
}
