// Compatibility for repository acceptance/observation scripts using the versioned bounded API.
export function taskRuntimeReader(request) {
  let cursor;
  let terminals = new Map();
  return async () => {
    let value;
    do {
      const query = new URLSearchParams(cursor ? { cursor } : {});
      value = await request('/tasks/runtime?' + query);
      if (value.resetRequired) terminals.clear();
      for (const plan of value.recentTerminalPlans ?? []) terminals.set(plan.id, plan);
      for (const plan of value.plans) terminals.delete(plan.id);
      terminals = new Map(
        [...terminals.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 50)
          .map((plan) => [plan.id, plan]),
      );
      cursor = value.cursor;
    } while (value.hasMore);
    return { ...value, plans: [...value.plans, ...terminals.values()] };
  };
}
