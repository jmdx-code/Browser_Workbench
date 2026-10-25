// Test-only rollback of later schemas to exercise real forward migrations.
import { dropMaterialSchema } from './material-schema.js';
export const dropControlSchema =
  dropMaterialSchema +
  'DROP TRIGGER immutable_browse_intent;DROP TRIGGER retain_browse_intent;DROP TABLE task_browse_intents;' +
  [
    'DROP TRIGGER immutable_task_control_receipt',
    'DROP TRIGGER retain_task_control_receipt',
    'DROP TABLE task_control_receipts',
    'DROP TRIGGER immutable_task_control_binding',
    'DROP TRIGGER retain_task_control_binding',
    'DROP TABLE task_control_bindings',
  ].join(';') +
  ';';
