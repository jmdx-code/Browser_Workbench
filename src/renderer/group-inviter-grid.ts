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
    text.trim().startsWith('"') ||
    !!groupPair(text) ||
    (column === 0 && extractGroupId(text) !== text.trim())
  );
}

export function parseGroupClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  const clean = (value: string) => value.replace(/\s*\r?\n\s*/g, ' ').trim();
  const endCell = () => {
    row.push(clean(cell));
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  const normalized = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (quoted) {
      if (ch === '"' && normalized[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '\t') endCell();
    else if (ch === '\n') endRow();
    else if (ch === '"' && !cell) quoted = true;
    else cell += ch;
  }
  endRow();
  while (rows.length && rows[0]?.every((v) => !v)) rows.shift();
  while (rows.length && rows.at(-1)?.every((v) => !v)) rows.pop();
  return rows;
}
export function applyGroupGridPaste(
  rows: DraftGroupEntry[],
  startRow: number,
  startCol: 0 | 1,
  clipboardText: string,
  createRow: (groupId?: string, groupName?: string) => DraftGroupEntry,
  endRow = startRow,
  endCol: 0 | 1 = startCol,
): DraftGroupEntry[] {
  let matrix = parseGroupClipboard(clipboardText);
  const single = matrix[0]?.[0];
  if (
    matrix.length === 1 &&
    matrix[0]?.length === 1 &&
    single !== undefined &&
    !groupPair(single) &&
    endRow > startRow
  )
    matrix = Array.from({ length: endRow - startRow + 1 }, () => [single]);
  // Column expansion is intentionally not applied: a single-column paste preserves its neighbour.
  void endCol;
  const next = rows.map((row) => ({ ...row }));
  matrix.forEach((cells, offset) => {
    const index = startRow + offset;
    while (next.length <= index) next.push(createRow());
    const row = next[index];
    if (!row) return;
    const pair =
      cells.length >= 2
        ? [extractGroupId(cells[0] ?? ''), cells.slice(1).join(' ').trim()]
        : groupPair(cells[0] ?? '');
    next[index] = pair
      ? { ...row, groupId: pair[0] ?? '', groupName: pair[1] ?? '' }
      : startCol === 0
        ? { ...row, groupId: extractGroupId(cells[0] ?? '') }
        : { ...row, groupName: cells[0] ?? '' };
  });
  return next;
}
export function clearGroupGridRange(
  rows: DraftGroupEntry[],
  minRow: number,
  maxRow: number,
  minCol: 0 | 1,
  maxCol: 0 | 1,
): DraftGroupEntry[] {
  return rows.map((row, index) =>
    index < minRow || index > maxRow
      ? { ...row }
      : {
          ...row,
          ...(minCol <= 0 && maxCol >= 0 ? { groupId: '' } : {}),
          ...(minCol <= 1 && maxCol >= 1 ? { groupName: '' } : {}),
        },
  );
}
export function deleteGroupGridRows(
  rows: DraftGroupEntry[],
  minRow: number,
  maxRow: number,
  createRow: () => DraftGroupEntry,
): DraftGroupEntry[] {
  const next = rows
    .filter((_, index) => index < minRow || index > maxRow)
    .map((row) => ({ ...row }));
  return next.length ? next : [createRow()];
}
export function formatGroupGridRangeForClipboard(
  rows: DraftGroupEntry[],
  minRow: number,
  maxRow: number,
  minCol: 0 | 1,
  maxCol: 0 | 1,
): string {
  const quote = (text: string) =>
    /["\t\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  return rows
    .slice(minRow, maxRow + 1)
    .map((row) =>
      [row.groupId, row.groupName]
        .slice(minCol, maxCol + 1)
        .map(quote)
        .join('\t'),
    )
    .join('\n');
}
