// New stored action kinds require an append-only compatibility gate. No new operation ledger.
export const browseActionMigration =
  "INSERT INTO workspace_execution_contracts VALUES('owned-browse-actions',1)";
