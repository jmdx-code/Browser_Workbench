/** A date input denotes the entire selected local calendar day. */
export function cleanupDateEnd(date: string): number {
  return new Date(date + 'T23:59:59.999').getTime();
}
