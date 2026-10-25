// Generated rollback fixtures only, never product or retained evidence databases.
import { dropMaterialArchivePreparationSchema } from './material-archive-schema.js';
export const dropMaterialCacheCleanupSchema =
  dropMaterialArchivePreparationSchema +
  [
    'DROP TABLE material_cache_cleanup_completions',
    'DROP TABLE material_cache_directory_removals',
    'DROP TABLE material_cache_cleanup_files',
    'DROP TABLE material_cache_cleanup_scopes',
    'DROP TABLE material_cache_cleanup_state',
    'DROP TABLE material_cache_cleanup_requests',
  ].join(';') +
  ';';
