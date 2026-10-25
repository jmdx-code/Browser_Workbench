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
    const timer = setInterval(() => void current.refresh(), 2000);
    return () => {
      clearInterval(timer);
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
