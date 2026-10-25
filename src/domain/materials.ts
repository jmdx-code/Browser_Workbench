import type { MaterialFileSnapshot, MaterialScan, PreflightReport } from '../shared/materials.js';

export function normalizeMaterialText(input: string): string {
  return input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .trim();
}
// Dedupe is content-based: retain media multiplicity, ignore file names and presentation order.
// The publishing snapshot separately preserves the ordered files. Do not change v1 after persistence.
export function materialFingerprintPayload(
  text: string,
  files: readonly Pick<MaterialFileSnapshot, 'role' | 'digest'>[],
): string {
  return JSON.stringify({
    version: 1,
    text: normalizeMaterialText(text),
    media: files
      .filter((file) => file.role !== 'text')
      .map((file) => ({ role: file.role, digest: file.digest }))
      .sort((a, b) => {
        const left = a.role + ':' + a.digest,
          right = b.role + ':' + b.digest;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
  });
}
export function summarizeMaterialScan(scan: MaterialScan, scannedAt: string): PreflightReport {
  const first = new Map<string, string>();
  return {
    directory: scan.directory,
    scannedAt,
    complete: scan.complete,
    readonly: true,
    publishingReady: false,
    fingerprintVersion: 1,
    packages: scan.packages.map((material) => {
      const duplicateOf = first.get(material.fingerprint) ?? null;
      if (!duplicateOf) first.set(material.fingerprint, material.source);
      return {
        source: material.source,
        format: material.format,
        fingerprint: material.fingerprint,
        bytes: material.files.reduce((sum, file) => sum + file.bytes, 0),
        mediaCount: material.files.filter((file) => file.role !== 'text').length,
        duplicateOf,
      };
    }),
    issues: scan.issues,
    excluded: scan.excluded,
    uniqueContents: first.size,
  };
}
