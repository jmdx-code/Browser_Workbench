// New task snapshots require a forward-only compatibility gate, even without new tables.
export const marketplaceTaskMigration =
  "INSERT INTO workspace_execution_contracts VALUES('marketplace-task',1)";
