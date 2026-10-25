import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import type { PreferenceUpdate, Preferences } from '../shared/workspace-preferences.js';

// Card header colors. Persisted in workspace preferences once the backend adds
// `combinationColors` (docs/UI_BACKEND_REQUESTS.md B3). Until then a stable
// default derived from the combination id is shown and editing is disabled.
export const cardColorNames = [
  'graphite',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'violet',
] as const;
export type CardColor = (typeof cardColorNames)[number];
export const cardColorLabels: Record<CardColor, string> = {
  graphite: '石墨',
  blue: '海蓝',
  teal: '青绿',
  green: '森绿',
  amber: '琥珀',
  orange: '橙红',
  red: '绯红',
  violet: '紫罗兰',
};
export function defaultCardColor(id: string): CardColor {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return cardColorNames[hash % cardColorNames.length] ?? 'graphite';
}
type WithColors = Preferences & { combinationColors?: Record<string, string> };
export function useCardColors() {
  const [prefs, setPrefs] = useState<WithColors | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .workspacePreferences(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
      .then(
        (value) => {
          if (!controller.signal.aborted) setPrefs(value as WithColors);
        },
        () => {
          if (!controller.signal.aborted) setPrefs(null);
        },
      );
    return () => controller.abort();
  }, [revision]);
  const supported = !!prefs && prefs.combinationColors !== undefined;
  const colorOf = useCallback(
    (id: string): CardColor => {
      const saved = prefs?.combinationColors?.[id];
      return (cardColorNames as readonly string[]).includes(saved ?? '')
        ? (saved as CardColor)
        : defaultCardColor(id);
    },
    [prefs],
  );
  const setColor = useCallback(
    async (id: string, color: CardColor) => {
      if (!prefs || prefs.combinationColors === undefined)
        throw Error('需升级软件后可设置卡片颜色');
      const input = {
        expectedRevision: prefs.revision,
        values: {
          defaultTimeZone: prefs.defaultTimeZone,
          desktopNotifications: prefs.desktopNotifications,
          combinationColors: { ...prefs.combinationColors, [id]: color },
        },
      } as PreferenceUpdate;
      try {
        setPrefs(
          (await api.saveWorkspacePreferences(input, AbortSignal.timeout(10_000))) as WithColors,
        );
      } catch (failure) {
        setRevision((value) => value + 1);
        throw failure;
      }
    },
    [prefs],
  );
  return { supported, colorOf, setColor };
}
