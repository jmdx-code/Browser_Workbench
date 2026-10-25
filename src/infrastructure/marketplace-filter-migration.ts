// Forward-only gate: older strict snapshot readers cannot understand filter fields.
export const marketplaceFilterMigration =
  "INSERT INTO workspace_execution_contracts VALUES('marketplace-filters',1);" +
  "INSERT INTO workspace_execution_contracts VALUES('publication-destination',1)";
