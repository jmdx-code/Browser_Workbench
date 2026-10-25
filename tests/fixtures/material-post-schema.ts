// Generated migration fixtures only. Restore migration8's guard after dropping later schema.
import { dropMaterialUploadStageSchema } from './material-upload-stage-schema.js';
export const dropMaterialPostSchema =
  dropMaterialUploadStageSchema +
  [
    'DROP TABLE material_archive_state',
    'DROP TABLE material_archive_requests',
    'DROP TABLE material_publications',
    'DROP TABLE material_attempt_verdicts',
    'DROP TABLE material_operation_verdicts',
    'DROP TABLE material_post_operations',
    'DROP TRIGGER material_terminal_evidence_required',
    "CREATE TRIGGER material_settlement_not_implemented BEFORE UPDATE OF state ON material_reservations WHEN NEW.state IN ('PUBLISHED','NOT_PUBLISHED') BEGIN SELECT RAISE(ABORT,'MATERIAL_SETTLEMENT_NOT_IMPLEMENTED'); END",
  ].join(';') +
  ';';
