# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical reading

**Read `AGENTS.md` in full before generating or modifying non-trivial code.** It contains binding decisions (ADRs), non-negotiable engineering rules, MVP scope boundaries, and common pitfalls. This file is a supplement, not a replacement.

## Commands

```bash
pnpm install            # install dependencies
pnpm dev                # run from source via tsx
pnpm build              # bundle via tsup → dist/index.js
pnpm gen:types          # regenerate manifest TS types from docs/schemas/ (do this first when editing schemas)
pnpm gen:types:check    # CI check that generated types are up-to-date
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint
pnpm format             # prettier --write
pnpm test               # node:test + tsx (hermetic fixtures under testdata/)
```

The CI gate is: `pnpm lint && pnpm test && pnpm gen:types:check && pnpm typecheck`. All must pass before declaring work done.

To run a single test file: `node --import tsx --test test/<file>.test.ts`


**Always run the tests and linter after making changes, and fix any failures before declaring the work done.** Do not leave the tree with failing tests or lint errors. After successful completion also run the `pnpm format` and `pnpm build` before committing the changes.

## Architecture

Qavor is a **lean wrapper CLI** that owns the manifest model, dependency graph, env composition, and orchestration loop — shelling out to `git`, `docker compose`, and language toolchains for everything else.

### Manifest model

All YAML documents carry a top-level `kind:` field that dispatches to its JSON Schema and orchestration semantics. The `kind: project` manifest's `repositories:` list is the **single source of truth for the workspace repo set** — `kind: service` manifests only describe how to build and run apps and never contribute repos to the workspace. Schemas live in `docs/schemas/` and are **the single source of truth** — TypeScript types in `src/manifest/types/` are generated from them via `json-schema-to-typescript`, never hand-written. When adding manifest fields: edit the schema first → `pnpm gen:types` → write code against the generated type.

### Source layout

```
src/
├── cli/            # Commander setup, command handlers (init, git, prepare, env, run, etc.)
├── manifest/       # YAML loader (with source-position preservation), Ajv validators, registry
│   └── types/      # GENERATED — do not edit
├── workspace/      # Workspace init, .qavor/ state directory management
├── git/            # Git wrapper: execa for mutations, simple-git for read-only inspection
├── env/            # Layered env composer with provenance tracking
├── prepare/        # runtime.*.prepare execution, lockfile-hash skip cache
├── supervisor/     # native.ts (own supervisor via execa), compose.ts (docker compose driver)
└── util/           # Concurrency helpers (p-queue/p-limit/p-map), AbortSignal, fs utils
```

### Key wiring

- **Env precedence** (later wins): dep `env.common` → dep `env.native/docker` → dep `.env` → own `env.common` → own `env.native/docker` → own `.env` → workspace `.env` → CLI `--env`. Full chain in `docs/proposal.md §6`.
- **Fan-out concurrency**: every multi-repo operation uses `p-queue`/`p-limit`/`p-map` with `os.availableParallelism()` default, overridable via `--jobs N`. Never `Promise.all` over unbounded user input.
- **Output modes**: human-readable (pino-pretty on TTY) vs. NDJSON (`--json` flag). Logs always on stderr.
- **Exit codes**: `0` ok · `1` user error · `2` manifest error · `3` runtime error. Defined in `docs/exit-codes.md`.
- **State directory**: `.qavor/` at workspace root (gitignored) holds PIDs, logs, generated compose files, and cache. Layout in `AGENTS.md §10`.

### Commit message style

Scoped, present tense, lowercase: `manifest: add foo field to service schema` or `cli: fix --json output for env command`. Reference workstream IDs (`D2`, `F1`, etc.) from `docs/mvp-tasks.md` where applicable.
