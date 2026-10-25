export const resourceTableMigration = `
CREATE TABLE resource_table_heads(combination_id TEXT PRIMARY KEY REFERENCES combinations(id),revision INTEGER NOT NULL CHECK(revision>0));
CREATE TABLE resource_table_versions(combination_id TEXT NOT NULL REFERENCES combinations(id),revision INTEGER NOT NULL CHECK(revision>0),body TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(combination_id,revision));
CREATE TRIGGER immutable_resource_table_update BEFORE UPDATE ON resource_table_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESOURCE_TABLE'); END;
CREATE TRIGGER immutable_resource_table_delete BEFORE DELETE ON resource_table_versions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RESOURCE_TABLE'); END;
`;
