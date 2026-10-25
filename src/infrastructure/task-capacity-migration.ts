// Append-only migration: preserve the selected limit, default and the original task ledger.
export const taskCapacityMigration = [
  'ALTER TABLE scheduler_settings RENAME TO scheduler_settings_before_100',
  'CREATE TABLE scheduler_settings(id INTEGER PRIMARY KEY CHECK(id=1),max_concurrent_profiles INTEGER NOT NULL CHECK(max_concurrent_profiles BETWEEN 1 AND 100))',
  'INSERT INTO scheduler_settings SELECT * FROM scheduler_settings_before_100',
  'DROP TABLE scheduler_settings_before_100',
  "INSERT INTO workspace_execution_contracts(name,version) VALUES('task-capacity',2)",
].join(';');
