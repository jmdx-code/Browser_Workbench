import { isDeepStrictEqual } from 'node:util';

export function findSavedBrowseCombination(combinations, value) {
  const configuration = ({ name, steps, randomOrder, loop }) => ({
    name,
    steps: steps.map(({ id: _id, ...spec }) => spec),
    randomOrder,
    loop,
  });
  return combinations.find(
    (row) =>
      row.saved && !row.draft && isDeepStrictEqual(configuration(row.saved), configuration(value)),
  );
}
