// Browser work uses the full configured product capacity, without the former
// four-startup/four-upload preparation bottlenecks. Per-profile fencing remains.
export const MAX_CONCURRENT_PROFILES = 100;
export const DEFAULT_CONCURRENT_PROFILES = MAX_CONCURRENT_PROFILES;
export const MAX_CONCURRENT_STARTUPS = MAX_CONCURRENT_PROFILES;
export const MAX_CONCURRENT_UPLOAD_PREPARATIONS = MAX_CONCURRENT_PROFILES;
export const TASK_CAPACITY_HEADER = 'x-workbench-task-capacity';
export const TASK_CAPACITY_VERSION = '2';
