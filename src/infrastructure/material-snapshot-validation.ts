import path from 'node:path';
import { createHash } from 'node:crypto';
import { materialFingerprintPayload, normalizeMaterialText } from '../domain/materials.js';
import type { MaterialPackageSnapshot } from '../shared/materials.js';

function segments(value: string) {
  const result = value.split(/[\\/]/);
  if (result.some((piece) => !piece || piece === '.' || piece === '..' || /[:\x00]/.test(piece)))
    throw Error('MATERIAL_SOURCE_INVALID');
  return result;
}
export function validateSnapshot(snapshot: MaterialPackageSnapshot) {
  const anchor = segments(snapshot.source);
  if (anchor.length !== 1 || anchor[0]?.toLowerCase() === '已发')
    throw Error('MATERIAL_SOURCE_INVALID');
  const media = snapshot.files.filter((file) => file.role !== 'text'),
    texts = snapshot.files.filter((file) => file.role === 'text');
  const single = snapshot.files.length === 1 && snapshot.files[0]?.relativePath === snapshot.source;
  const folder = snapshot.files.every((file) => {
    const parts = segments(file.relativePath);
    return parts.length === 2 && parts[0] === snapshot.source;
  });
  const sidecar =
    snapshot.files.length === 2 &&
    snapshot.files.some((file) => file.relativePath === snapshot.source && file.role !== 'text') &&
    snapshot.files.every(
      (file) =>
        segments(file.relativePath).length === 1 &&
        (file.relativePath === snapshot.source ||
          (file.role === 'text' &&
            path.parse(file.relativePath).name.toLowerCase().normalize('NFC') ===
              path.parse(snapshot.source).name.toLowerCase().normalize('NFC'))),
    );
  if (
    (!single && !folder && !sidecar) ||
    new Set(snapshot.files.map((file) => file.relativePath.toLowerCase())).size !==
      snapshot.files.length
  )
    throw Error('MATERIAL_SOURCE_INVALID');
  if (
    texts.length > 1 ||
    texts.some((file) => file.bytes > 262144) ||
    snapshot.files.some((file) => String(file.bytes) !== file.proof.size) ||
    snapshot.text !== normalizeMaterialText(snapshot.text)
  )
    throw Error('MATERIAL_SNAPSHOT_INVALID');
  if (folder && texts.some((file) => path.basename(file.relativePath) !== '正文.txt'))
    throw Error('MATERIAL_SNAPSHOT_INVALID');
  const format =
    media.length === 0 && texts.length === 1 && snapshot.text
      ? 'text'
      : media.length === 1 && media[0]?.role === 'video'
        ? 'video'
        : media.length === 1 && media[0]?.role === 'image'
          ? 'single-image'
          : media.length >= 2 && media.length <= 20 && media.every((file) => file.role === 'image')
            ? 'multi-image'
            : null;
  if (snapshot.format !== format || (!texts.length && snapshot.text))
    throw Error('MATERIAL_FORMAT_INVALID');
  const payload = materialFingerprintPayload(snapshot.text, snapshot.files);
  if (createHash('sha256').update(payload).digest('hex') !== snapshot.fingerprint)
    throw Error('MATERIAL_FINGERPRINT_INVALID');
  return payload;
}
