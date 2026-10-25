// Append-only 33. All original intents, manifests and UNKNOWN operations stay unchanged.
export const storyVideoDerivationMigration =
  "INSERT INTO workspace_execution_contracts(name,version) VALUES('story-video-derived-media',1)";
