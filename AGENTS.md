# AGENTS.md — qavor

Guidance for AI coding agents working in this repo. Read this in full before generating or editing code. The decisions referenced here are **binding** — they are already adopted ADRs, not suggestions. Push back (in chat) before deviating; do not silently change them.

---

## 1. What qavor is

`qavor` is a single CLI for managing a constellation of related repositories as one cohesive developer workspace: clone, prepare (deps), run native or in containers, manage backing deps (postgres/kafka/redis/…) as services, compose env vars across a dependency graph, and orchestrate the start/stop lifecycle.

It is a **lean wrapper**. It owns:
- the declarative manifest model,
- the cross-repo dependency graph,
- environment composition with explicit precedence,
- and the orchestration loop.

It shells out for everything else: `git`, `docker` / `docker compose`, language toolchains (`npm`/`pnpm`, `uv`/`pip`, `go`, `cargo`, …). **Never** reimplement what an installed tool already does.

It is **not** a CI/CD system, a Kubernetes replacement, a devcontainer, a process supervisor for production, or a new container runtime / package manager.

---

## 2. Source-of-truth documents

Read these before changing anything non-trivial. When the docs and code disagree, the docs win — update code or escalate.

- `docs/proposal.md` — product vision, full requirements (existing + new), CLI surface, env precedence.
- `docs/decisions.md` — the six accepted ADRs (language, supervisor, container runtime, bootstrap, compose ownership, state dir).
- `docs/manifests.md` — canonical manifest examples and on-disk layout.
- `docs/schemas/` — formal JSON Schemas (one per `kind:` + master dispatcher `qavor.schema.json` + shared defs). **These schemas are the contract; TypeScript types are generated from them, not the other way around.**
- `docs/mvp-tasks.md` — the locked v0/MVP task list and the explicit out-of-scope list.
- `README.md` — short orientation; mirrors the proposal.

---

## 3. Current repo state

Pre-implementation. Today the repo contains only documentation and JSON Schemas. There is no `src/`, no `package.json`, no tests yet. When you create them, follow the layout and tooling locked below.

---

## 4. Binding tech stack (ADR-001)

Do not substitute alternatives without a new ADR.

- **Runtime:** Node.js 26 or newer. Single supported runtime — no Bun/Deno fork at v0.
- **Language:** TypeScript with `strict: true`, ES modules, `target: ES2023`.
- **Package manager:** `pnpm` (lockfile committed).
- **CLI framework:** `commander` (async action handlers).
- **YAML:** `yaml` (eemeli/yaml) — must preserve source positions for `file:line:column` diagnostics; multi-document via `parseAllDocuments`.
- **JSON Schema validation:** `ajv` (draft 2020-12) + `ajv-formats`. Schemas live under `docs/schemas/` and are imported as JSON modules.
- **Manifest types:** generated from the JSON Schemas via `json-schema-to-typescript` (CI-checked via `pnpm gen:types`). Do **not** hand-write the manifest types — the schemas are the single source of truth.
- **Subprocess:** `execa` (promise-based, streaming, structured errors, signal-safe).
- **Concurrency:** `p-queue` for ordered fan-out with progress, `p-limit` for ad-hoc limits, `p-map` for fan-out-with-results.
- **Logging:** `pino` with `pino-pretty` in TTY; structured JSON in non-TTY / `--json` mode.
- **Git:** `simple-git` only for read-only inspection (status, ahead/behind). All mutating ops shell out via `execa` so behaviour matches the user's `git` install.
- **Compose:** parse/emit via the `yaml` library validated with `ajv` against the compose-spec schema.
- **dotenv:** the `dotenv` package — for parsing only. qavor owns precedence (see §7).
- **Testing:** Node's built-in `node:test` with `tsx`. Promote to `vitest` only if richer fixtures justify it; do not introduce both.
- **Lint/format:** `biome` (replaces ESLint + Prettier). Config in `biome.jsonc`. Run via `pnpm lint` (check) or `pnpm format` (fix).
- **Bundling:** `tsup` (esbuild) emits an ESM CLI bundle as the SEA input.
- **Distribution:** Node Single Executable Application (SEA) for `darwin/arm64`, `darwin/amd64`, `linux/amd64`, `linux/arm64`. Plus a published `@<org>/qavor` npm package.

---

## 5. Non-negotiable engineering rules

These are enforced through code review and CI; do not ship code that violates them.

1. **Asynchronous everywhere.** All I/O uses async APIs (`node:fs/promises`, `execa`, the Promise-returning surfaces). Synchronous I/O is forbidden outside startup-only paths, and even there it needs an inline comment justifying it. No `readFileSync`, no `execSync`, no `fs.existsSync` in hot paths.
2. **Bounded parallelism.** Every fan-out (clone, prepare, status, log fetch, env resolution, manifest discovery, …) routes through `p-queue` / `p-limit` / `p-map`. Default concurrency is `os.availableParallelism()`; users override globally with `--jobs N`. Never spawn N tasks where N is unbounded user input.
3. **Cancellable.** Long-running operations stream output incrementally and respond to `SIGINT` / `SIGTERM` promptly. Use `AbortSignal` end-to-end through `execa` and async loops.
4. **Manifests are the source of truth.** Never embed manifest defaults in code that contradict the JSON Schemas. If a schema needs a new field, edit the schema first, regenerate types, then write code against the new type.
5. **Error provenance.** Validation and parse errors must report `file:line:column` plus the manifest `kind:` and the JSON path. Use `yaml`'s source-position info; map Ajv errors back to the original document.
6. **No interleaved logs on fan-out.** Per-repo / per-service output is buffered or prefixed so parallel runs are readable. `--jobs 1` is the deterministic mode for CI/tests.
7. **Exit codes are a contract.** `0` ok, `1` user-error, `2` manifest-error, `3` runtime-error, `≥10` reserved. Document in `docs/exit-codes.md` when created.
8. **`--json` mode** must produce machine-readable output for every command that prints user output. Never mix human prose with JSON in the same stream.
9. **No secrets in manifests or logs.** Secret values flow through the `${secret:...}` interpolation reserved syntax (v0 fails closed on it). Redact `secret: true` envs in logs and `qavor env` output but pass the real value to the child process.
10. **Selectors must be uniform.** When implemented, `--repo`, `--group`, `--tag`, `--dirty`, `--ahead`, `--behind` behave identically across every multi-repo verb. Do not add ad-hoc filters on a single command.

---

## 6. Manifest model (the discriminated union)

Every YAML document carries a top-level `kind:` that selects its schema and orchestration semantics:

| kind | Role | Where it lives |
|---|---|---|
| `workspaces` | Pointer to the project repo. Generated by `qavor init`. | Workspace-root `qavor.yaml`. |
| `project` | Workspace identity + list of repos. | Project repo root `qavor.yaml`. |
| `service` | A runnable app with `native` / `docker` / `docker-compose` runtime blocks. Also covers backing deps (postgres/kafka/…): a backing service typically runs via `docker-compose` (ADR-005) and exposes an `env.publish` contract. | Repo root or sub-dir `qavor.yaml`. |
| `profile` | Reusable runtime + env bundle, referenced via `profiles:`. | Anywhere. |

The repo set is defined **exclusively** by the `kind: project` manifest's `repositories:` list. `kind: service` manifests (whether first-party apps or backing deps) never alter which repos belong to the workspace. A repo belongs to the workspace because the project manifest lists it; a repo may contain zero, one, or many service manifests.

A repo may put all manifests in one multi-document `qavor.yaml` (separated by `---`) or split them under a `qavor/` sub-directory. Both forms mix kinds freely. Validators must handle both.

Cross-repo refs use names (`{ service: token-issuer }`, `{ service: postgres }`); names are unique workspace-wide. The workspace registry is `name → (kind, file, parsed)`.

**Profile resolution happens at registry-build time.** When `buildWorkspaceRegistry` assembles the registry, every entry's `profiles:` chain is flattened into its `runtime`/`mode`/`env` (later profiles and the entry's own values winning; chained profiles supported) and the `profiles:` key is dropped. Every command (`prepare`, `up`, `env`, …) therefore reads the *effective* definition from `entry.data` without re-resolving. The standalone `resolve-manifest` command is purely a debug printer over that already-resolved data. Profile cycles and unknown profile references are reported as manifest issues. Keep the flattening logic in `manifest/resolve.ts` as the single implementation.

---

## 7. Environment composition (later wins)

The full chain is defined in `docs/proposal.md` §6 and `docs/manifests.md`. Summary:

1. **Required dependencies** (recursive over `require:`):
   1. dep's `env.common`
   2. dep's `env.native` or `env.docker` (mode-dependent)
   3. dep's `<dir>/.env`
   4. dep's `<dir>/.env.native` or `.env.docker`
   - When a dep declares `env.publish:` (a backing service), only that contract flows to its dependents.
2. **The service itself** (profiles merged in below its own env):
   1. `env.common` → `env.native`/`env.docker` → `.env` → `.env.native`/`.env.docker`
3. **Workspace `.env`** (next to the `kind: workspaces` pointer).
4. **CLI** `--env KEY=VAL`.

`qavor env <service>` must print the resolved value with provenance (file + line + layer) per key. Build the env composer so provenance is preserved through every layer — never collapse maps eagerly.

---

## 8. Process supervision (ADR-002)

- **`mode: native`** → own minimal supervisor. Spawn via `execa` with `detached: true` (own process group); signal the group via `process.kill(-pid, ...)` with SIGTERM-then-SIGKILL after a configurable grace. Track PID + start metadata in `.qavor/state/<service>.json` via `fs/promises`.
- **`mode: docker`** and **`mode: docker-compose`** (the latter typical for backing services) → generated `docker compose` project under `.qavor/compose/` (gitignored). qavor owns the file end-to-end (generate-and-own, with overlay overrides per ADR-005); users never hand-edit the generated file.
- Both backends share one orchestration plane: dep graph, env composer, readiness gate.
- Future backends (Podman/OrbStack/SSH) land behind the same `ContainerRuntime` / supervisor interface (post-MVP). Don't widen the interface speculatively — only what current callers need.

---

## 9. Bootstrap (ADR-004)

`qavor init <project-repo-source> [--into <dir>]` is the only entry point. `<source>` may be:
1. a local path to an already-cloned project repo,
2. a `git@…` or `https://…` URL (cloned under `<workspace-root>/<repo-name>.git/`, cached at `~/.cache/qavor/projects/<hash>/`),
3. a path inside an existing workspace (re-init / repair — must be idempotent).

`qavor init` then reads the project repo's `qavor.yaml` (must be `kind: project`), writes the workspace-root `qavor.yaml` (`kind: workspaces`, `root_project_path:` pointing at the project repo), and clones the rest.

---

## 10. State directory layout (ADR-006)

```
<workspace>/.qavor/                  # per-workspace, gitignored
├── state/                           # PIDs, supervisor state, health-check results
├── logs/<service>/                  # rotated log files
├── compose/                         # generated docker compose project
├── cache/                           # lockfile hashes, resolved env, dep graph
├── workspace.json                   # project name, project repo path, manifest hash
└── config.local.yaml                # workspace-local non-secret overrides

~/.cache/qavor/                      # global, respect $XDG_CACHE_HOME if set
├── projects/<hash>/                 # cached project-repo clones
└── artifacts/                       # downloaded helpers
```

`qavor clean` is per-workspace by default; `qavor clean --global` clears the shared cache.

---

## 11. Expected source layout

When you create `src/`, organize it like this (adjust if a clear better arrangement emerges, but keep modules cohesive):

```
src/
├── cli/                # commander entry, command files, --json/--jobs/--verbose plumbing
├── manifest/           # YAML loader (positions), Ajv validators, registry, discovery
│   └── types/          # generated TS types from docs/schemas (do not hand-edit)
├── workspace/          # init, workspace state, .qavor/ + ~/.cache/qavor management
├── git/                # git wrapper (execa + simple-git for reads), per-repo verbs
├── env/                # layered env composer, .env parsing, interpolation, provenance
├── prepare/            # runtime.*.prepare execution, lockfile-hash skip cache
├── supervisor/
│   ├── native.ts       # native process supervisor
│   └── compose.ts      # docker compose generator + driver (post-MVP for services)
├── logging/            # pino setup, per-service log capture & rotation, tail
├── util/               # concurrency helpers, AbortSignal helpers, fs helpers
└── index.ts            # bin entry

test/                   # node:test + tsx
testdata/               # fixture project + 3 toy repos (1 node, 2 python/uv)
scripts/                # gen-types, gen-cli-docs, SEA build, codesign
```

Keep files small and single-purpose. Don't introduce framework-style abstractions (DI containers, base classes) when a plain function + types will do.

---

## 12. MVP scope boundary (read `docs/mvp-tasks.md` for the locked task list)

**In MVP (v0):**
- Workstreams A–J in `docs/mvp-tasks.md`.
- `qavor init`, `qavor doctor`, `qavor clone`, `qavor sync`, `qavor status`, `qavor commit`, `qavor push`, `qavor prepare`, `qavor up <service>`, `qavor down <service>`, `qavor logs <service>`, `qavor ps`, `qavor env <service>`, `qavor validate`, `qavor workspace info`.
- Native mode only. One service per `qavor up` invocation. No graph orchestration yet.
- `--repo <name>` and "all repos" forms only — no `--group` / `--tag` / state filters in MVP.
- `kind: profile` resolution and chaining: profiles are flattened into each manifest's `runtime`/`mode`/`env` at registry-build time and consumed by every command. See §6.

**Explicitly out of MVP (deferred to v0.5 / v1):**
- Groups & group selectors; filtered selectors; state filters.
- Dependency graph, topological start, cross-service `require:` resolution at runtime.
- Readiness probes, `waitFor: ready`.
- Backing-service execution (`mode: docker-compose`), generated compose project, `env.publish:` propagation.
- `mode: docker` for services — container build/run, image templating, registry push.
- Secrets providers (1Password / sops / vault); `${secret:...}` v0 fails closed.
- `qavor explain`, `qavor graph`, `qavor docs`, `qavor branch`, PR helpers, tag/release, stash, snapshot/restore, hot reload, debug mode, plugin system, alt container runtimes, telemetry.

**Rule:** if you're tempted to implement something on the deferred list "for completeness", stop and raise it explicitly — it requires a roadmap revision, not an opportunistic PR.

---

## 13. Testing & quality bar

- Use `node:test` + `tsx` as the runner. Co-locate tests under `test/` mirroring `src/`.
- Every workstream in `docs/mvp-tasks.md` ends with a tests bullet — treat that as the acceptance bar.
- Use `testdata/` fixtures: a project repo + 3 toy repos (1 node, 2 python/uv). Git remotes are `file://` URLs for hermetic tests.
- For supervisor edge cases (process groups, SIGTERM-then-SIGKILL, log rotation), write table-driven tests.
- Smoke-test against a 25-repo fixture before each release to catch FD/concurrency regressions.
- Lint, type-check, and tests must pass in CI before merge. `./lint.sh` runs the full static-analysis gate (biome check, generated-types check, typecheck). `pnpm test` runs the test suite. Both must be green before declaring work done.

---

## 14. Workflow for agents

Before generating non-trivial code:

1. **Read the relevant doc sections.** Manifest changes → `manifests.md` + `schemas/*.json`. Behaviour changes → `proposal.md` + `decisions.md`. MVP work → `mvp-tasks.md`.
2. **Check the schemas first.** If the work touches manifests, edit `docs/schemas/*.json` first, regenerate TS types, then write code against the generated types.
3. **Plan, then code.** Multi-file changes deserve a brief plan or todo list before edits. Keep changes focused on one workstream at a time.
4. **Respect the scope boundary.** If a request implies deferred functionality, surface that in chat — don't quietly grow the MVP.
5. **No new top-level dependencies** without justifying them against the locked toolchain in §4. Prefer using what's already there.
6. **Run lint + tests** before declaring work done. After every non-trivial change run `./lint.sh` (biome check, generated-types check, typecheck) and then `pnpm test`. Fix any lint errors you introduce; only touch pre-existing lint warnings when they obstruct the change.
7. **Commit messages** follow the docs' style (concise, present tense, scoped: e.g. `manifest: ...`, `cli: ...`, `supervisor: ...`). Reference the workstream id (e.g. `D2`) where applicable. Never commit without explicit user request.

---

## 15. Common pitfalls to avoid

- Hand-writing manifest types instead of generating them from `docs/schemas/`.
- Using `child_process.execSync` or `fs.readFileSync` outside a justified startup-only path.
- Unbounded `Promise.all([...])` over user input — always use `p-queue` / `p-limit` / `p-map`.
- Swallowing `execa` errors. Propagate them with the underlying command + exit code + stderr tail.
- Logging raw env maps that may contain secrets.
- Editing the generated `.qavor/compose/docker-compose.yaml` from code paths other than the generator.
- Adding a feature from the "deferred" list in §12 without a roadmap revision.
- Reaching for a heavier abstraction (class hierarchies, DI, plugin loader) when a function + a discriminated union will do.
- Touching the JSON schemas without regenerating types or updating `docs/manifests.md` cross-references.
