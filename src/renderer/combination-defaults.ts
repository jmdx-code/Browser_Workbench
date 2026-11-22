import type { Combination, Step } from '../shared/contracts.js';

export function normalizeCombinationResources(value: Combination): Combination {
  return {
    ...value,
    steps: value.steps.map((step) =>
      step.type === 'post'
        ? { ...step, resourceMode: 'table' as const, resourceDirectory: '' }
        : step.type === 'marketplace'
          ? {
              id: step.id,
              type: 'marketplace' as const,
              durationMinutes: step.durationMinutes,
              keyword: '',
              maxLikes: 0 as const,
              minLikeCount: 0 as const,
            }
          : step,
    ),
  };
}

export function newPostStep(id: string, destination: 'post' | 'story' = 'post'): Step {
  return {
    id,
    type: 'post',
    destination,
    ...(destination === 'story' ? { audience: 'preserve-current' as const } : {}),
    count: 1,
    resourceDirectory: '',
    resourceMode: 'table',
    allowRepeat: false,
    forbidSameAccountRepeat: true,
    archivePublished: false,
  };
}

export function newCombination(destination?: 'post' | 'story'): Combination {
  return {
    name:
      destination === 'story' ? '新快拍组合' : destination === 'post' ? '新发帖组合' : '新任务组合',
    note: '',
    steps: destination
      ? [newPostStep(crypto.randomUUID(), destination)]
      : [
          {
            id: crypto.randomUUID(),
            type: 'video',
            durationMinutes: 15,
            maxLikes: 0,
            minLikeCount: 500,
          },
        ],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  };
}
