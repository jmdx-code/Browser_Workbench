# Development Guidelines

- Use Node.js 24.19+ and the Electron 44 / Vite 8 / React 19 / TypeScript 5.9 stack.
- Read `README.md`, `docs/PUBLIC_ARCHITECTURE.md`, `docs/ARCHITECTURE.md`, and `docs/SOFTWARE_UPDATES.md` before changing architecture.
- Enforce `scripts/check-boundaries.mjs` across all 8 `src/` layers (`shared`, `domain`, `application`, `infrastructure`, `http`, `renderer`, `bridge`, `desktop`) with zero `any`, zero non-null `!`, and zero `@ts-ignore`/`@ts-nocheck`.
- Keep source modules cohesive and well-structured by responsibility; split readers, actuators, orchestrators, and route/gateway concerns cleanly without altering verified DOM/GraphQL/ADB/SQL invariants.
- Preserve SQLite persistence migrations cleanly (append new migrations instead of mutating already-shipped versions).
- Never treat an input acknowledgement as a confirmed business result; preserve `UNKNOWN` / `pending_approval` evidence and stop authority.
- Do not commit account data, credentials, SQLite databases, media fixtures, or audit outputs.
- Verify changes with `npm run format && npm run check`, stress checks when concurrency/transport changes, and live desktop acceptance before finalizing.
