import type {
  AILabelReading,
  AILabelSetting,
  AILabelPurpose,
} from '../shared/facebook-ai-label.js';
import { aiLabelTarget } from '../shared/facebook-ai-label.js';

export function aiLabelEffectObserved(
  purpose: string,
  reading: AILabelReading | undefined,
  setting: AILabelSetting,
) {
  if (!reading?.ready || !reading.visible || setting === 'preserve-current') return false;
  if (purpose === 'OPEN_AI_LABEL') return reading.phase === 'settings';
  if (reading.value !== (setting === 'on')) return false;
  return purpose === 'SET_AI_LABEL'
    ? reading.phase === 'settings' || (reading.phase === 'composer' && reading.mode === 'inline')
    : purpose === 'CONFIRM_AI_LABEL' && reading.phase === 'composer';
}

export function decidePostAILabel(
  setting: AILabelSetting,
  reading: AILabelReading | undefined,
  applied: (purpose: AILabelPurpose) => boolean,
) {
  if (setting === 'preserve-current') return { kind: 'ready' as const };
  if (!reading?.ready || !reading.visible) return { kind: 'wait' as const };
  const wanted = setting === 'on';
  const opened = applied('OPEN_AI_LABEL'),
    changed = applied('SET_AI_LABEL');
  const confirmed = applied('CONFIRM_AI_LABEL');
  const action = (purpose: AILabelPurpose) => ({
    kind: 'action' as const,
    purpose,
    target: aiLabelTarget(purpose, reading),
  });
  if (reading.phase === 'composer') {
    if (reading.mode === 'inline') {
      if (reading.value === wanted) return { kind: 'ready' as const };
      if (changed) throw Error('POST_AI_LABEL_CHANGED');
      return reading.switchEnabled ? action('SET_AI_LABEL') : { kind: 'wait' as const };
    }
    if (opened && !confirmed) throw Error('POST_AI_LABEL_SETTINGS_CLOSED');
    if (reading.value === wanted) return { kind: 'ready' as const };
    if (opened || changed || confirmed) throw Error('POST_AI_LABEL_CHANGED');
    return action('OPEN_AI_LABEL');
  }
  if (reading.phase !== 'settings' || !opened || confirmed || reading.value === null)
    throw Error('POST_AI_LABEL_CONFIGURATION_UNAVAILABLE');
  if (reading.value !== wanted) {
    if (changed) throw Error('POST_AI_LABEL_CHANGED');
    return reading.switchEnabled ? action('SET_AI_LABEL') : { kind: 'wait' as const };
  }
  return reading.confirmEnabled ? action('CONFIRM_AI_LABEL') : { kind: 'wait' as const };
}
