import test from 'node:test';
import assert from 'node:assert/strict';
import { findSavedBrowseCombination } from '../saved-browse-combination.mjs';

const value = {
  name: '验收 · 首页2分钟',
  note: 'New scope',
  steps: [{ id: 'new-step', type: 'feed', durationMinutes: 2, maxLikes: 0, minLikeCount: 0 }],
  randomOrder: false,
  loop: { mode: 'finite', rounds: 1 },
};
const saved = () => ({
  id: 'saved-combination',
  version: 2,
  draft: null,
  saved: {
    ...structuredClone(value),
    note: 'Earlier scope',
    steps: [{ ...value.steps[0], id: 'old-step' }],
  },
});

test('matching immutable browse configuration is reused without changing old step IDs or notes', () => {
  const row = saved();
  const before = structuredClone(row);
  assert.equal(findSavedBrowseCombination([row], value), row);
  assert.deepEqual(row, before);
});

test('a draft, another name, different budget or configured interaction is never reused', () => {
  for (const change of [
    (row) => {
      row.draft = {};
    },
    (row) => {
      row.saved.name = 'User combination';
    },
    (row) => {
      row.saved.steps[0].durationMinutes = 3;
    },
    (row) => {
      row.saved.steps[0].maxLikes = 1;
    },
    (row) => {
      row.saved.randomOrder = true;
    },
    (row) => {
      row.saved.loop.rounds = 2;
    },
  ]) {
    const row = saved();
    change(row);
    assert.equal(findSavedBrowseCombination([row], value), undefined);
  }
});
