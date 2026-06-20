# qavor v0 / MVP — Locked Task List

Source-of-truth task list for the **v0 / MVP** milestone defined in section 10 of the [proposal](./proposal.md). Reflects the manifest model in [manifests.md](./manifests.md) as the authoritative shape.

**Scope statement.** The MVP must let a single developer run `qavor init <project-repo-source>` against a project repo whose `kind: project` manifest enumerates a small set of repos (the sole source of the workspace repo set), clone them, run any prepare commands declared by the `kind: service` manifests found in those repos, and start those services in **native mode** with layered env vars composed per the documented resolution order.

No groups (selectors), no cross-service graph orchestration, no docker mode, no backing services (`docker-compose` + `env.publish`), no profiles. Those land in v0.5 / v1 per the roadmap.

**Time budget.** 4–6 weeks of focused work for one engineer.

**Definition of Done (MVP-wide).**
- Single executable built via Node.js 26 Single Executable Application (SEA) for `darwin/arm64`, `darwin/amd64`, `linux/amd64`, `linux/arm64`; plus an `npm`-installable package for users with a Node runtime.
- All commands have `--help`, support `--json`, and return documented exit codes.
- All I/O paths are asynchronous (`node:fs/promises`, `execa`, etc.); every fan-out goes through a bounded concurrency limiter (`p-queue` / `p-limit`) defaulting to `os.availableParallelism()` and overridable via `--jobs N`.
- Manifest validation errors point to file + line + path (`kind:` discriminated).
- Smoke-tested end-to-end against a fixture workspace whose project manifest lists 3 toy repos (1 node service, 2 python services).
- README on the repo with install + quickstart.

---

## Workstream A — Project skeleton & tooling

- [ ] **A1.** Initialize npm package `@<org>/qavor`, target Node.js 26+ (`engines.node: ">=26"`), TypeScript strict mode (ESM, `target: ES2023`). Bootstrap with `pnpm`: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `.editorconfig`, `.nvmrc`.
- [ ] **A2.** Add `commander` CLI scaffolding (async action handlers) with root command, `--version`, `--verbose`, `--json`, `--config`, `--jobs <n>` (global concurrency override).
- [ ] **A3.** Add `tsup` (esbuild) bundler config emitting an ESM CLI bundle. Add SEA build pipeline that produces single executables for the four target platforms via Node's Single Executable Application facility; wire CI to build & publish snapshot artifacts on PRs.
- [ ] **A4.** Add `eslint` + `typescript-eslint` + `prettier` with a sane ruleset; add CI lint + test jobs (`pnpm lint`, `pnpm test`).
- [ ] **A5.** Wire structured logging via `pino` (`pino-pretty` in TTY, JSON in non-TTY / `--json` mode) with a `--verbose` switch.
- [ ] **A6.** Define exit-code contract (0 ok, 1 user-error, 2 manifest-error, 3 runtime-error, ≥10 reserved) and document in `docs/exit-codes.md`.
- [ ] **A7.** Set up `testdata/` with a fixture workspace: 1 project repo + 3 toy repos (1 node service, 2 python/uv services), each with a single-service `kind: service` `qavor.yaml`.

## Workstream B — Manifest model & validation

- [ ] **B1.** Vendor [`docs/schemas/qavor.schema.json`](./schemas/qavor.schema.json) and the per-kind schemas (`workspaces`, `project`, `service`, `profile`, plus shared `qavor.defs.schema.json`) into `src/schema/` and import them as JSON modules.
- [ ] **B2.** Implement an asynchronous YAML loader that preserves source positions and supports multi-document files (`---` separated). Use `yaml` (eemeli/yaml) — read files via `node:fs/promises` and use the CST/AST surface to map nodes back to `file:line:column`. Loader returns one parsed document per `kind:` node.
- [ ] **B3.** Wire `ajv` (draft 2020-12) + `ajv-formats` for validation; dispatch each loaded document to the per-kind schema based on its `kind:` field. Compile schemas once at startup; map Ajv errors back to `file:line:path` using the position info from B2.
- [ ] **B4.** Generate TypeScript types for the six manifest kinds from the JSON Schemas via `json-schema-to-typescript` (kept in sync via a `pnpm gen:types` script run in CI). `kind:` is the discriminated-union tag; each kind has its own type. Hand-write narrow runtime guards where the generator falls short.
- [ ] **B5.** `qavor validate <path>` command — accepts a single file (`qavor.yaml`, single or multi-document) or a directory (e.g. `./qavor/`); validates every document concurrently via `p-map`; nonzero on any error.
- [ ] **B6.** Tests: each kind's schema-valid sample passes; deliberately broken samples surface useful error messages; unknown `kind:` is rejected; mixed-kind multi-doc files validate per document.

## Workstream C — Workspace & bootstrap (project-repo seeded)

- [ ] **C1.** Implement `qavor init <project-repo-source> [--into <dir>]` per ADR-004:
  - Resolve `<project-repo-source>` as either an existing local path or a git URL.
  - When URL: clone the project repo into `<workspace-root>/<repo-name>.git/` (cache the clone under `~/.cache/qavor/projects/<hash>/` for reuse).
  - Read the project repo's `qavor.yaml` (must be `kind: project`).
  - Generate `<workspace-root>/qavor.yaml` (`kind: workspaces`) pointing to the project repo path.
  - Re-running into an existing workspace is idempotent.
- [ ] **C2.** Workspace state directory layout per ADR-006: create `.qavor/{state,logs,compose,cache}` and `.gitignore` it; create global `~/.cache/qavor/{projects,artifacts}`.
- [ ] **C3.** Persist workspace identity in `.qavor/workspace.json` (project name, project repo path, manifest hash).
- [ ] **C4.** `qavor workspace info` (cwd resolution, paths, version, manifest hash, location of the resolved `kind: workspaces` and `kind: project` files).
- [ ] **C5.** Tests: init from local path, init from a fixture git URL via `file://`, re-init is idempotent, generated `kind: workspaces` validates against its schema.

## Workstream D — Git operations (single-repo verb-set, all-repo dispatch)

> Selectors land in v0.5; MVP ships only `--repo <name>` and "all repos" forms. "All repos" = the union of the project manifest's `repositories:` list.

- [ ] **D1.** Asynchronous subprocess wrapper around `git` built on `execa`, with streaming stdout/stderr capture, structured error parsing, and AbortSignal support for cancellation. Use `simple-git` for read-only inspection (status, ahead/behind) where it materially simplifies parsing.
- [ ] **D2.** `qavor git clone` — clone every repo in the project manifest. URL is derived from `git.root_url` + `git.repo_prefix` + `<name>` unless an explicit `url` is given on the entry. Branch comes from per-entry `branch` / `tag` / `commit` else `git.default_branch`. Clone path is `<workspace-root>/<name>.git/` unless overridden by `path`. Idempotent (skip if present, fast-path).
- [ ] **D3.** `qavor git sync` — `git fetch && git pull --ff-only` per repo. Reports per-repo result and summary.
- [ ] **D4.** `qavor git status` — aggregated table: repo, branch, ahead/behind, dirty count, last commit (short).
- [ ] **D5.** `qavor git commit -m <msg>` — commit pending changes per repo (skips clean repos). Optionally `--allow-empty`. No multi-message wizardry in MVP.
- [ ] **D6.** `qavor git push` — `git push` per repo with current branch. No PR creation (deferred to v0.5+).
- [ ] **D7.** Bounded parallelism via `p-queue` (default concurrency = `os.availableParallelism()`, override with `--jobs N`). Per-repo progress lines via the shared logger, buffered per repo so output is never interleaved. Honour `--jobs 1` for deterministic CI runs.
- [ ] **D8.** Tests against a local `file://` remote fixture; cover happy path + dirty + ahead/behind cases; cover URL derivation from `repo_prefix` and explicit-`url` overrides.

## Workstream E — Manifest discovery & repo wiring

- [ ] **E1.** After clone, walk each cloned repo to discover its manifests:
  - `qavor.yaml` at the repo root (single or multi-document), or
  - any `qavor.yaml` files under a `qavor/` directory at the repo root, or
  - any `<sub-dir>/qavor.yaml` under the repo root.
  Build the workspace registry: `name → (kind, file, parsed)`.
- [ ] **E2.** Validate cross-references: every name in a `kind: project` `repositories:` entry must resolve to a cloned repo; every `kind: service` `name:` must be unique workspace-wide. Backing-service (`env.publish`) and profile references are flagged "out of MVP scope" if encountered (warn, do not fail).
- [ ] **E3.** Tests: registry built correctly for fixture workspace; duplicate names error out with file+line; out-of-MVP kinds in v0 (`profile`) are visible as warnings.

## Workstream F — Dependency preparation (via `runtime.native.prepare`)

- [ ] **F1.** Implement `src/prepare/` that, for each selected `kind: service`, runs the `runtime.native.prepare.cmd` declared on the service (or its profile, post-MVP) via `execa`. The command executes asynchronously in the service's manifest directory with the composed env. The command's stdout/stderr are discarded by default and passed through raw to the terminal under `--verbose`; no per-service log files are written.
- [ ] **F2.** Lockfile-aware skip — asynchronously hash a configurable list of files (default heuristics: `package-lock.json`/`pnpm-lock.yaml`/`yarn.lock` for node, `uv.lock` for python) via streaming `crypto.createHash` and write to `.qavor/cache/prepare/<service>.json`; skip when unchanged unless `--force`.
- [ ] **F3.** `qavor prepare [--repo <name>]` command. Parallel across services via `p-queue`, honouring the global `--jobs` setting.
- [ ] **F4.** Run `pre_prepare` / `post_prepare` hooks declared on the service manifest in scope.
- [ ] **F5.** Tests: fixture node service + fixture python/uv service prepare on first run; cache hit on re-run; `--force` invalidates.

## Workstream G — Environment composition (MVP subset)

> Scope: native mode only. No `env.publish` propagation from backing services (out of MVP). No `${secret:...}` interpolation.

- [ ] **G1.** Implement layered env composer with the MVP precedence (later wins):
  1. Service: `env.common`, then `env.native`, then `<manifest-dir>/.env`, then `<manifest-dir>/.env.native`.
  2. Workspace `.env` (next to the `kind: workspaces` pointer).
  3. CLI `--env KEY=VAL`.
  Profiles, required-dep contributions, and backing-service `env.publish:` propagation land in v0.5.
- [ ] **G2.** Implement interpolation for `${VAR}` against prior layers and process env. Reject unresolved references unless the env entry is a long-form `envSpec` with `default:` set.
- [ ] **G3.** Honor long-form `envSpec` `required: true` and `secret: true`. Missing required vars fail at start with file+line provenance. Secret vars are redacted in logs and `qavor env` output (full value still passed to the child process).
- [ ] **G4.** `qavor env <service>` prints resolved env with provenance (file + line + layer for each var).
- [ ] **G5.** Tests: precedence rules; interpolation; `.env` and `.env.native` discovery; missing required var fails; secret redaction.

## Workstream H — Native run (single-service supervisor; no graph)

> Topological start, readiness gating, log multiplexing, `require:` resolution land in v0.5. MVP supervises one service per invocation.

- [ ] **H1.** Implement `src/supervisor/native.ts` — spawn child via `runtime.native.run.cmd` using `execa` (own process group via `detached: true` so the child survives the CLI exit and can be signalled as a group), pipe stdout/stderr to rotating log files under `.qavor/logs/<service>/` via async streams, write PID + start metadata to `.qavor/state/<service>.json` via `fs/promises`.
- [ ] **H2.** `qavor up <service>` — start a single named service in `mode: native`; refuses if already running; refuses with a clear error if `runtime.native.enabled` is false. `--mode docker` returns "deferred to v1".
- [ ] **H3.** `qavor down <service>` — `process.kill(-pid, 'SIGTERM')` against the process group with a 10s grace (configurable via env on the runtime backend in a later iteration), then `SIGKILL`; clear state file. Run `pre_run` / `post_run` hooks where declared.
- [ ] **H4.** `qavor logs <service> [-f]` — asynchronously read or follow rotated log files (use `node:fs/promises` + an async tail loop with `fs.watch`).
- [ ] **H5.** `qavor ps` — list known services with state (stopped/running/crashed) and uptime; liveness checks done in parallel via `p-map`.
- [ ] **H6.** Crash detection: if child exits unexpectedly, mark `crashed` in state file and surface in `ps`. No auto-restart in MVP.
- [ ] **H7.** Tests: lifecycle (up/down), graceful shutdown timeout path, log rotation by size, refusal when service has no `native` backend.

## Workstream I — Doctor

- [ ] **I1.** `qavor doctor` checks: git ≥ 2.30; writable `.qavor/`; writable `~/.cache/qavor/`; `XDG_CACHE_HOME` honored if set.
- [ ] **I2.** Run each in-scope service's `runtime.native.check_installed.cmd` and report ok/warn/fail per service. A failed `check_installed` surfaces the corresponding `install.cmd` as a hint (does not auto-execute).
- [ ] **I3.** Container/Docker checks deferred (v1) — doctor warns rather than fails when missing.
- [ ] **I4.** Output: per-check status (ok/warn/fail), nonzero exit on any fail.

## Workstream J — Documentation & release

- [ ] **J1.** Repo README: install (curl + brew), quickstart, link to proposal/decisions/manifests/schemas.
- [ ] **J2.** `docs/cli.md` generated from `commander`'s help metadata (auto-doc script under `scripts/gen-cli-docs.ts`).
- [ ] **J3.** Update [`docs/manifests.md`](./manifests.md) and [`docs/schemas/`](./schemas/) cross-links if any field gets renamed during implementation.
- [ ] **J4.** Cut `v0.1.0` tag; publish the npm package to the registry and the per-platform SEA artifacts via GitHub Releases; refresh the Homebrew tap formula to point at the new artifacts.

---

## Explicitly out of scope for MVP (deferred per roadmap)

These are real requirements, intentionally pushed to v0.5 / v1 / later:

- Groups, group-level selectors, group dependencies (`{ group: ... }` requirement form).
- Filtered selectors (`--group`, `--tag`, `--dirty`, `--ahead`, `--behind`).
- Dependency graph, topological start, cross-service / cross-repo `require:` resolution at runtime.
- Readiness probes (HTTP/TCP/command), `waitFor: ready` semantics.
- Backing-service execution (`mode: docker-compose` for postgres/mysql/kafka), generated compose project, `env.publish:` propagation, seed/migrations, snapshot/restore.
- `mode: docker` for services — container build & run, image templating, registry push.
- `kind: profile` resolution — `profiles:` lists on services, profile chaining.
- Multi-language ergonomics through curated profile bundles (go, rust, java, ruby, dotnet beyond what `runtime.native.prepare.cmd` already supports).
- Toolchain version management via `mise`/`asdf`.
- Secrets providers (1Password / sops / vault) — MVP only honors `.env` / `.env.native` / `.env.local`.
- `${secret:...}` interpolation (the syntax is reserved; v0 fails closed if encountered).
- `qavor explain`, `qavor graph`, `qavor docs`.
- Branch ops (`qavor branch`), PR helpers, coordinated tagging.
- Stash, full clean, backup/restore.
- Hot reload (`watch:`-style), debug mode, port allocation.
- Plugin system; alt container runtimes (Podman/OrbStack/nerdctl).
- Telemetry; remote/team workspaces.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Scope creep — temptation to add backing services/profiles/graph for "completeness". | This task list is the contract; new items require an explicit roadmap revision. |
| Native supervisor edge cases on macOS (process groups, controlling tty). | Spawn children with `execa({ detached: true })` so each runs in its own process group; signal the group via `process.kill(-pid, ...)`; cover with table-driven tests. |
| YAML position info pass-through across multi-document files. | Pin to `yaml` (eemeli/yaml) early — it preserves positions and handles multi-doc via `parseAllDocuments`; test error-message quality in B6. |
| Subprocess fan-out exhausting OS limits (file descriptors, RAM, ports) on large workspaces. | Every fan-out uses `p-queue` with concurrency defaulting to `os.availableParallelism()`; expose `--jobs N` everywhere; document the knob in `docs/cli.md`; smoke-test against a fixture workspace with 25 toy repos to catch FD leaks. |
| SEA artifact bloat or platform-specific signing surprises. | Build SEA artifacts in CI per platform from day one; sign macOS binaries via the `codesign` step in J4; gate releases on smoke-running each artifact against the fixture workspace. |
| Lockfile-skip false positives across CI cache layouts. | Hash includes lockfile path + file size + mtime + sha256; fall through to install on any mismatch. |
| Manifest discovery ambiguity (root `qavor.yaml` vs `qavor/` dir vs sub-dir manifests). | Document precedence explicitly in `docs/manifests.md`; warn on conflicts; cover with E2 tests. |

---

## Acceptance scenario (run at end of MVP)

A reviewer with a clean machine and Node + uv installed should be able to:

```bash
brew install <org>/tap/qavor
qavor init https://example.com/acme/acme-platform.git --into ./acme   # clones the project repo
cd ./acme
qavor doctor                                                          # all green
qavor git clone                                                       # 3 repos cloned per project manifest
qavor prepare                                                         # node + uv installs via runtime.native.prepare
qavor env auth                                                        # see resolved env w/ provenance
qavor up auth                                                         # runtime.native.run.cmd launched, PID tracked
qavor logs auth -f                                                    # tails output
qavor down auth                                                       # graceful stop
qavor git status                                                      # aggregated repo state
```

If every step above passes on darwin/arm64 and linux/amd64, MVP ships.
