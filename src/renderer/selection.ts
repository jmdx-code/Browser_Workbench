export function toggleSet(
  current: ReadonlySet<string>,
  ids: string | readonly string[],
  checked?: boolean,
) {
  const next = new Set(current);
  for (const id of typeof ids === 'string' ? [ids] : ids) {
    if (checked ?? !next.has(id)) next.add(id);
    else next.delete(id);
  }
  return next;
}
export function selectionState(current: ReadonlySet<string>, ids: string[]) {
  const count = ids.filter((id) => current.has(id)).length;
  return {
    checked: ids.length > 0 && count === ids.length,
    mixed: count > 0 && count < ids.length,
  };
}
