export interface DraftGroupEntry {
  key: string;
  groupId: string;
  groupName: string;
}

export function extractGroupId(raw: string): string {
  const value = raw.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
    if (/(^|\.)facebook\.com$/i.test(url.hostname)) {
      const match = /^\/groups\/([^/?#]+)/i.exec(url.pathname);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
  } catch {
    /* Plain IDs stay unchanged. */
  }
  return value;
}

function groupPair(line: string): [string, string] | null {
  const explicit = /^([^\t,，|]+)[\t,，|]+(.*)$/.exec(line);
  if (explicit) {
    const id = extractGroupId(explicit[1] ?? '');
    if (/^[A-Za-z0-9._-]+$/.test(id)) return [id, (explicit[2] ?? '').trim()];
  }
  const space = /^(\S+)\s+(.+)$/.exec(line.trim());
  if (space?.[1] && space[2]) {
    const id = extractGroupId(space[1]);
    // A name containing spaces is one B-column cell, unless its first token
    // identifies a numeric group, URL, or a distinguishable group slug.
    if (/^\d+$/.test(id) || id !== space[1] || /^[A-Za-z0-9]+[._-][A-Za-z0-9._-]+$/.test(id))
      return [id, space[2].trim()];
  }
  return null;
}

export function isGroupGridPaste(text: string, column: 0 | 1): boolean {
  return (
    /[\r\n\t]/.test(text) ||
    !!groupPair(text) ||
    (column === 0 && extractGroupId(text) !== text.trim())
  );
}

export function applyGroupGridPaste(
  rows: DraftGroupEntry[],
  startRow: number,
  startCol: 0 | 1,
  clipboardText: string,
  createRow: (groupId?: string, groupName?: string) => DraftGroupEntry,
): DraftGroupEntry[] {
  const lines = clipboardText.split(/\r?\n/);
  while (lines.length && !lines[0]?.trim()) lines.shift();
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  const next = rows.map((row) => ({ ...row }));
  for (const [offset, line] of lines.entries()) {
    const index = startRow + offset;
    while (next.length <= index) next.push(createRow());
    const row = next[index];
    if (!row) continue;
    const pair = groupPair(line);
    next[index] = pair
      ? { ...row, groupId: pair[0], groupName: pair[1] }
      : startCol === 0
        ? { ...row, groupId: extractGroupId(line) }
        : { ...row, groupName: line.trim() };
  }
  return next;
}
