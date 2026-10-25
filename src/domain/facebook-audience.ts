import { Spec } from '../shared/browser-actions.js';
import { privacyTargets, type ComposerAudience } from '../shared/facebook-audience.js';

export function audienceTarget(reading: ComposerAudience, purpose: keyof typeof privacyTargets) {
  if (reading.ready === 'loading' || !reading.draftEmpty) return null;
  const allowed =
    purpose === 'OPEN_AUDIENCE'
      ? reading.phase === 'COMPOSER' && reading.openEnabled && reading.audience !== 'SELF'
      : purpose === 'SELECT_SELF'
        ? reading.phase === 'MENU' && !reading.selfSelected && reading.selfEnabled
        : reading.phase === 'MENU' &&
          reading.selfSelected &&
          reading.defaultChecked === false &&
          reading.confirmEnabled;
  return allowed ? Spec.parse(privacyTargets[purpose]) : null;
}
