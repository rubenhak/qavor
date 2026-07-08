# qavor — MVP delivery record & roadmap

> **Status: MVP shipped.** The v0/MVP milestone defined in this document is
> complete and published to npm (`qavor`). The task-by-task checklist that
> originally lived here has been retired now that every workstream landed; this
> document is kept as the delivery record and the forward roadmap. For the
> authoritative, always-current picture of what runs today, see the
> *Implementation status* section of the [README](../README.md) and the
> annotated [proposal](./proposal.md).

## MVP scope (delivered)

The MVP goal was: run `qavor init <project-repo-source>` against a project repo
whose `kind: project` manifest enumerates a small set of repos, clone them, run
prepare commands declared by the `kind: service` manifests, and start those
services in **native mode** with layered env composed per the documented
resolution order. All of that ships, along with several items originally slated
for v0.5/v1 (see below).

Delivered workstreams (A–J from the original plan):

- **A — Project skeleton & tooling.** pnpm + TypeScript (strict, ESM), `commander`
  CLI with `--json` / `--verbose` / `--jobs` / `--serial` / `--parallel` /
  `--config` / `--offline` / `--refresh`, `tsup` bundle, `biome` lint/format,
  `pino` logging, exit-code contract ([`exit-codes.md`](./exit-codes.md)),
  hermetic `testdata/` fixtures.
- **B — Manifest model & validation.** Per-kind JSON Schemas in `docs/schemas/`,
  position-preserving YAML loader (multi-document), Ajv validation mapped to
  `file:line:column`, generated TS types (`pnpm gen:types`), `qavor validate`.
- **C — Workspace & bootstrap.** `qavor init` (local path + git URL), `.qavor/`
  state layout, `qavor workspace info`. Plus single-repo (`standalone`) projects.
- **D — Git operations.** `clone` / `sync` / `status` / `commit` / `push` with a
  `--only` selector, bounded fan-out, and a live status TUI.
- **E — Manifest discovery & repo wiring.** Registry build (`name → kind/file/parsed`),
  cross-reference validation, `qavor manifests`, `qavor discover`.
- **F — Dependency preparation.** Delivered as the more general **dynamic-command**
  system (below) rather than a hard-coded `qavor prepare`. (The interim
  lockfile-hash skip cache was implemented and then removed; commands run
  unconditionally.)
- **G — Environment composition.** Layered composer with provenance, `${VAR}`
  interpolation, long-form `envSpec` (`required` / `secret`), `qavor env`.
- **H — Native run.** `src/supervisor/native.ts`, `qavor up` / `down` / `logs` / `ps`.
- **I — Doctor.** `qavor doctor` (git, docker warn-only, writable dirs, per-service
  `check_installed`).
- **J — Documentation & release.** README + docs; npm publish via GitHub Actions
  Trusted Publishing (OIDC). SEA binaries / Homebrew tap remain on the roadmap.

## Delivered beyond the original MVP line

These were listed as out-of-scope for MVP but have since landed:

- **`kind: profile` resolution** — `profiles:` on services and profiles,
  chaining, flattened at registry-build time.
- **Remote profile sources (ADR-007)** — https / GitHub / git / `file://`
  references, integrity pins, caching, `--offline` / `--refresh`.
- **Step-list merge directives** — `$append` / `$prepend` / `$replace` / `$unset`
  under a command's `operations`, for inherited runtime commands.
- **`require:` dependency env composition** — a unit's env resolution walks its
  `require:` graph; `qavor resolve-env` exposes it with `export` / `dotenv` output.
- **Backing-service `env.publish` contract** — published keys (and only those)
  propagate to dependents during env composition.
- **Dynamic manifest commands** — any non-reserved `runtime.native.<key>` becomes
  `qavor <command>`, fanned out across declaring services; `qavor commands` lists them.

## Roadmap (not yet implemented)

Ordered roughly by expected sequence, not committed dates:

1. **Container execution.** `--mode docker` for services; the generated,
   qavor-owned compose project (ADR-005); image-name templating and build/run.
2. **Backing-service orchestration.** `mode: docker-compose` bring-up, health/
   readiness gating, `qavor backing up|down|reset|snapshot|restore`. The
   `env.publish` contract already composes; runtime execution is the gap.
3. **Runtime dependency graph.** Topological multi-service start over `require:`,
   readiness probes (HTTP/TCP/command), `waitFor: ready`, `--with-deps` / `--no-deps`.
4. **Secrets.** `${secret:...}` interpolation (reserved; fails closed today) and
   pluggable providers (1Password / sops / vault).
5. **Selectors.** Groups and group-level requirements; `--group` / `--tag` /
   `--dirty` / `--ahead` / `--behind` state filters, uniform across every verb.
6. **Git ergonomics.** Branch ops, PR helpers, coordinated tagging, stash, `clean`.
7. **Introspection & docs.** `qavor graph`, `qavor explain`, `qavor docs`.
8. **Run ergonomics.** Hot reload (`watch:`), debug mode, port allocation.
9. **Distribution.** SEA per-platform binaries, Homebrew tap, curl installer.
10. **Extensibility.** Plugin system, alternate container runtimes
    (Podman/OrbStack/nerdctl), toolchain version management (mise/asdf),
    telemetry, remote/team workspaces.

## Engineering invariants (still binding)

These held through the MVP and continue to gate new work:

- All I/O is asynchronous; every fan-out routes through `p-queue` / `p-limit` /
  `p-map` with concurrency defaulting to `os.availableParallelism()`, overridable
  via `--jobs N`.
- Manifest validation errors report `file:line:path` and the `kind:`.
- Every command supports `--json` and returns documented exit codes.
- Schemas are the source of truth; TS types are generated, never hand-written.
- `pnpm lint && pnpm test && pnpm gen:types:check && pnpm typecheck` is green
  before any change is declared done.
