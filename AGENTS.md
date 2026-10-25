# Development guidelines

- Use Node.js 24.19+ and the existing Electron / Vite / TypeScript stack.
- Read README.md, docs/PUBLIC_ARCHITECTURE.md and docs/SOFTWARE_UPDATES.md before changing the project.
- Preserve layer boundaries and existing persistence migrations. Add new migrations instead of editing applied migrations.
- Keep changes within the requested scope. Prefer straightforward implementations and reuse existing task/control flows.
- Never treat an input acknowledgement as a confirmed business result. Preserve pending/unknown results and stop authority correctly.
- Do not commit account data, credentials, databases, source media or development audit records.
- Run focused regressions for changed behavior; run npm run check before a release.
- Local checkouts may contain .local/AGENTS.private.md and private operational notes under docs/. If present, read them before local development. They retain local user constraints and are intentionally excluded from the public repository.
