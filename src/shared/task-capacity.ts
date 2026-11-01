// Browser work uses the full configured product capacity, while smoothing
// initial CDP/admission startup waves to 6 concurrent browser startups.
export const MAX_CONCURRENT_PROFILES = 100;
export const DEFAULT_CONCURRENT_PROFILES = MAX_CONCURRENT_PROFILES;
export const MAX_CONCURRENT_STARTUPS = 6;
export const MAX_CONCURRENT_UPLOAD_PREPARATIONS = MAX_CONCURRENT_PROFILES;
export const TASK_CAPACITY_HEADER = 'x-workbench-task-capacity';
export const TASK_CAPACITY_VERSION = '2';
