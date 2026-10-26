import type {
  AILabelReading,
  AILabelSetting,
  AILabelPurpose,
} from '../shared/facebook-ai-label.js';
import { aiLabelTarget } from '../shared/facebook-ai-label.js';

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
  if (
    setting === 'off' &&
    !opened &&
    !changed &&
    !confirmed &&
    reading.phase !== 'settings' &&
    reading.value !== true
  )
    return { kind: 'ready' as const };
  const action = (purpose: AILabelPurpose) => ({
    kind: 'action' as const,
    purpose,
    target: aiLabelTarget(purpose, reading),
  });
  if (reading.phase === 'composer') {
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
