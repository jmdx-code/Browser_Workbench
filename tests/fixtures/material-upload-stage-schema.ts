// Generated migration test databases only. Never use this on product or evidence databases.
import { dropMaterialCacheCleanupSchema } from './material-cache-cleanup-schema.js';
export const dropMaterialUploadStageSchema =
  dropMaterialCacheCleanupSchema +
  [
    'DROP TABLE material_upload_stage_manifests',
    'DROP TABLE material_upload_stage_state',
    'DROP TABLE material_upload_stage_owners',
  ].join(';') +
  ';';
