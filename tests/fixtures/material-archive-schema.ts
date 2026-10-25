// Generated migration test databases only, never product or retained evidence.
import { dropResourceTableSchema } from './workspace-schema.js';
export const dropMaterialArchivePreparationSchema =
  dropResourceTableSchema +
  'DROP TABLE material_archive_plans;DROP TABLE material_archive_preparation;';
