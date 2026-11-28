import { useCallback, useEffect, useState } from 'react';
import type { PreferenceUpdate, Preferences } from '../shared/workspace-preferences.js';
import { api } from './api.js';
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
function defaultCardColor(id: string): CardColor {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return cardColorNames[hash % cardColorNames.length] ?? 'graphite';
}
type WithColors = Preferences & { combinationColors?: Record<string, string> };
export function useCardColors() {
  const [prefs, setPrefs] = useState<WithColors | null>(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .workspacePreferences(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
      .then(
        (v) => !controller.signal.aborted && setPrefs(v as WithColors),
        () => !controller.signal.aborted && setPrefs(null),
      );
    return () => controller.abort();
  }, [revision]);
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
        setRevision((v) => v + 1);
        throw failure;
      }
    },
    [prefs],
  );
  return { supported: !!prefs && prefs.combinationColors !== undefined, colorOf, setColor };
}
