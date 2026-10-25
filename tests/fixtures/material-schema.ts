// Only for generated migration test databases, never for product recovery.
import { dropMaterialPostSchema } from './material-post-schema.js';
export const dropMaterialSchema =
  dropMaterialPostSchema +
  [
    'DROP TABLE material_reservations',
    'DROP TABLE material_post_intents',
    'DROP TABLE material_sources',
    'DROP TABLE material_contents',
    'DROP TABLE material_roots',
    'DROP TABLE material_catalogs',
  ].join(';') +
  ';';
