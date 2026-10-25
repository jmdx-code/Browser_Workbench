// Shared negotiation source for the extension advertisement and the controller validator.
export const bridgeCapabilities = [
  'task-window-passive-layout-v1',
  'kernel-direct-operation-files-v1',
  'kernel-control-release-v1',
  'task-window-occlusion-focus-v1', // Accepted from older bridges, no longer advertised.
  'task-window-content-layout-v1',
  'task-window-simple-recovery-v1',
  'task-window-occlusion-recovery-v1',
  'task-window-layout-v1',
  'task-presentation-recovery-v1',
  'operation-journal-v2',
  'stop-confirmation',
  'media-observation',
  'media-node-identity',
  'task-activation',
  'media-surface-input',
  'fixture-kernel-v1',
  'kernel-journal-v1',
  'facebook-readonly-v1',
  'facebook-readonly-v2',
  'facebook-native-identity-v1',
  'kernel-operation-files-v1',
  'kernel-derived-operation-files-v1',
  'facebook-task-kernel-v1',
  'facebook-task-main-frame-v1',
  'kernel-unknown-end-v1',
  'kernel-create-foreground-v1',
  'kernel-idle-tab-end-v1',
  'local-window-status-v1',
  'facebook-existing-display-v1',
  'visible-pointer-v1',
  'profile-foreground-v1',
  'kernel-page-quiesce-v1',
  'workspace-main-group-v1',
  'kernel-stopped-main-reobserve-v1',
  'kernel-owned-page-reveal-v1',
  'kernel-workspace-main-proof-v1',
  'kernel-workspace-cleanup-v1',
  'kernel-background-presentation-v1',
  'kernel-task-rendering-v1',
] as const;

// Old controllers reject unknown HELLO capability names. Advertise this optional
// feature only after the current controller explicitly lists it in CHALLENGE.
export function bridgeHelloCapabilities(supported: unknown) {
  const recovery =
    Array.isArray(supported) &&
    supported.some((value) => value === 'task-presentation-recovery-v1');
  return bridgeCapabilities.filter(
    (value) =>
      (![
        'task-window-passive-layout-v1',
        'kernel-direct-operation-files-v1',
        'kernel-control-release-v1',
      ].includes(value) ||
        (Array.isArray(supported) && supported.includes(value))) &&
      (value !== 'task-presentation-recovery-v1' || recovery) &&
      (value !== 'task-window-layout-v1' ||
        (Array.isArray(supported) && supported.includes(value))) &&
      value !== 'task-window-occlusion-focus-v1' &&
      (value !== 'task-window-content-layout-v1' ||
        (Array.isArray(supported) && supported.includes(value))) &&
      (value !== 'task-window-simple-recovery-v1' ||
        (Array.isArray(supported) && supported.includes(value))) &&
      (value !== 'task-window-occlusion-recovery-v1' ||
        (Array.isArray(supported) && supported.includes(value))),
  );
}
