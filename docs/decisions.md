# qavor — Architecture Decision Records (ADRs)

Decisions resolving the six open questions in section 9 of the [proposal](./proposal.md).

Format: ADR-NNN, status, context, decision, consequences. Each can be revisited; supersede with a new ADR rather than editing in place.

---

## ADR-001 — Implementation language: **Node.js (TypeScript)**

**Status:** Accepted (v0).

**Context.** qavor is a lean wrapper that mostly orchestrates child processes (`git`, `docker`, language toolchains), composes config, walks a dependency graph in parallel, and serves a snappy CLI. The implementation language must offer ergonomic asynchronous subprocess orchestration, a mature ecosystem for YAML parsing (with source positions), JSON Schema validation, and git/compose tooling, fast iteration speed for what is largely orchestration glue, and the ability to ship a self-contained, easy-to-install artifact across macOS and Linux.

**Options considered.**
- **Node.js (TypeScript)** — first-class `async`/`await`, an excellent ecosystem for our workload (`execa`, `p-queue`, `eemeli/yaml` with source positions, `ajv` for JSON Schema, `simple-git`), and a large precedent for high-quality CLIs in this space (npm, pnpm, Vercel, Vite, Supabase, Prisma, SST, Nx, Turborepo). Modern Node ships a Single Executable Application (SEA) facility, closing the distribution gap that previously favoured compiled languages.
- **Go** — also a strong fit (gh, kubectl, helm, k9s, lazygit, dagger). Rejected because TypeScript gives us materially faster iteration speed for orchestration glue, and Node's async I/O model maps more cleanly onto our subprocess-heavy, fan-out workload than goroutines + channels do for the same surface area.
- **Rust** — stronger runtime guarantees, but slower iteration speed and a steeper authoring curve than is warranted for what is mostly orchestration glue.

**Decision.** Node.js 26 (or newer) with TypeScript (strict mode), distributed as a Single Executable Application.

**Implementation guidelines (binding).**
- **Asynchronous everywhere.** All I/O uses asynchronous APIs (`node:fs/promises`, `execa`, the Promise-returning surface of `node:child_process`, streaming YAML helpers). Synchronous I/O is forbidden outside startup-only paths that have an explicit comment justifying the choice.
- **Bounded parallelism.** Every fan-out operation (clone, prepare, status, log fetch, env resolution across services, …) routes through a concurrency limiter — `p-queue` for ordered fan-out with progress, `p-limit` for ad-hoc limits — so qavor never blows past OS/hardware ceilings (CPU, RAM, open file descriptors, socket count). The default concurrency derives from `os.availableParallelism()`; operators override globally via `--jobs N` and per workstream where it matters. Long-running operations stream output incrementally and respond to `SIGINT` / `SIGTERM` promptly.

**Consequences.**
- **Runtime:** Node.js 26 or newer; single supported runtime, no Bun/Deno fork at v0.
- **Language:** TypeScript with `strict: true`, ES modules, target `ES2023`.
- **Package manager:** `pnpm`.
- **Toolchain (locked at v0):**
  - CLI framework: `commander` (small, mature, async-friendly).
  - YAML: `yaml` (eemeli/yaml) — preserves source positions for multi-document files and exposes the CST when richer diagnostics are needed.
  - JSON Schema validation: `ajv` (draft 2020-12) + `ajv-formats`; schemas live under `docs/schemas/` and are imported as JSON.
  - TypeScript types for manifests: generated from the JSON Schemas via `json-schema-to-typescript` so the schemas remain the single source of truth.
  - Subprocess: `execa` (promise-based, streaming-friendly, structured errors, signal-safe).
  - Concurrency control: `p-queue` (ordered, progress-aware), `p-limit` (lightweight), `p-map` for fan-out-with-results.
  - Logging: `pino` with `pino-pretty` in TTY; structured JSON in non-TTY / `--json` mode.
  - Git: `simple-git` for inspection (status, ahead/behind); we shell out via `execa` for mutating operations to keep behaviour identical to the user's `git` installation.
  - Compose: parse/emit via the `yaml` library against the compose-spec JSON Schema validated with `ajv`.
  - dotenv: `dotenv` for `.env` / `.env.native` / `.env.docker` loading (parsing only — qavor owns precedence).
  - Testing: Node's built-in `node:test` runner with `tsx` for TS execution; promote to `vitest` only if richer fixtures justify it.
  - Linting & formatting: `eslint` + `typescript-eslint` + `prettier`.
  - Build: `tsup` (esbuild under the hood) emits an ESM CLI bundle as the SEA input.
- **Distribution:** Published to npm as **`qavor`** (`npm i -g qavor`) via GitHub Actions Trusted Publishing (OIDC) — this is the live install path today. The per-platform Single Executable Application (SEA) build for `darwin/arm64`, `darwin/amd64`, `linux/amd64`, `linux/arm64`, plus the Homebrew tap and `curl`-install script, remain **planned** and are not yet shipped. (The decision stands; only the SEA/brew artifacts are outstanding.)
- We accept a slightly larger distribution payload (the embedded Node runtime) in exchange for the ergonomic and ecosystem benefits above.

---

## ADR-002 — Process supervision: **own minimal supervisor for native, compose for docker / docker-compose**

**Status:** Superseded for native mode. The native supervisor described below (and its `up`/`down`/`logs`/`ps` verbs) has been **removed**: qavor hard-codes no command names and does not daemonize or track PIDs. A long-running service is expressed as an ordinary manifest command (`run`, by convention) and run in the foreground via `qavor run`; backgrounding, logging, and signalling are the command's own responsibility. The compose path for `docker` / `docker-compose` remains planned. The original reasoning is retained below for history.

**Context.** qavor must start and stop a heterogeneous set of services in topological order, gate dependents on readiness probes, multiplex logs, and shut down cleanly. Two extremes exist: build a full supervisor, or push everything through `docker compose`.

**Options considered.**
- **Own minimal native supervisor + compose for docker mode + compose for backing services** — Each native service runs as a child process tracked in `.qavor/state/`. We own the dependency graph, readiness gating, log multiplexing, signal handling, and PID lifecycle in TypeScript (using `node:child_process` + `execa`, async readiness probes, and a `p-queue`-bounded start loop). Container-mode services (`mode: docker`) and backing services (`mode: docker-compose`) are delegated to a generated compose project for batteries-included networking, restart policies, and volume management.
- **Delegate native too (overmind/honcho/foreman)** — Reuses an existing supervisor but forces dual code paths for readiness gating, log prefixing, and dep-graph awareness, since none of those tools natively understand qavor's graph.
- **Run everything through compose (incl. native)** — Forces every dev workflow through containers, which conflicts with the explicit "native vs docker per service, switchable per invocation" requirement (5.4) and the goal of low-latency hot-reload loops.

**Decision.** Own minimal supervisor for `mode: native`; compose for `mode: docker` and `mode: docker-compose` (the latter typical for backing services). The supervisor is intentionally small: process spawn, env injection, stdout/stderr capture, signal handling, readiness probe loop, and PID/state file in `.qavor/state/`.

**Consequences.**
- Two execution backends share one orchestration plane (the dep graph, env composer, readiness gate).
- We must implement: `start/stop/restart/status`, structured log capture with rotation, SIGTERM-then-SIGKILL with configurable grace, crash detection with optional restart policy, port allocation.
- Each runtime backend in a manifest exposes uniform commands; only `check_installed` and `install` are reserved (they drive `qavor doctor`). `run`, `prepare`, and the rest are ordinary user-defined commands run via `qavor <command>`.
- We can later add a third backend (e.g., remote/SSH) without disturbing the orchestration plane.

---

## ADR-003 — Container runtime abstraction: **Docker only at v0**

**Status:** Accepted (v0). Plugin extension for Podman / OrbStack / nerdctl deferred to v2.

**Context.** Container build/run support spans build (`docker build` / BuildKit), run (`docker run` / `docker compose up`), and lifecycle ops. Supporting multiple runtimes from day one multiplies test surface and slows the MVP.

**Options considered.**
- **Docker only at v0** — Single code path, smallest test matrix, ships fastest. Most contributors and CI runners already have Docker.
- **Multi-runtime from day one** — Larger surface area, more abstraction layers, slower MVP, and most differences (Podman socket, rootless, BuildKit availability) only matter for a minority.

**Decision.** Docker (and `docker compose` v2 plugin) only at v0. We require Docker Engine ≥ 24 with BuildKit enabled. The container interaction layer is wrapped behind an internal `ContainerRuntime` interface so a Podman/OrbStack/nerdctl backend can drop in later as a plugin (per ADR-006 plugin model is post-MVP).

**Consequences.**
- The manifest model fixes runtime backend names to `native`, `docker`, and `docker-compose`. Future backends will add new keys without renaming the existing ones.
- `qavor doctor` checks Docker presence/version/permissions and BuildKit availability.
- OrbStack on macOS works transparently (Docker-compatible CLI).
- Documented limitation: Podman users must wait for v2 or use Docker.

---

## ADR-004 — Bootstrap: **project-repo seeded; workspaces pointer is generated**

**Status:** Accepted (v0). Supersedes the original "bootstrap manifest as a freestanding file" framing.

**Context.** With per-repo declarative config, the very first `qavor` invocation has no repos yet. Some declarative artifact must enumerate the repos to clone, and it must be reachable before any clone happens. The earlier draft proposed a freestanding "bootstrap manifest" stored either locally or behind a URL; the manifest model in [manifests.md](./manifests.md) instead splits this responsibility into two `kind:`-discriminated documents.

**The split.**
- A **project repo** is the seed of the workspace. Its `qavor.yaml` is `kind: project` and lists every other repo to clone, with shared `git.root_url` / `repo_prefix` / `default_branch` to derive URLs from short names.
- The **workspace directory** itself is not a git repo. At its root sits a tiny `qavor.yaml` with `kind: workspaces` and a single field — `root_project_path` — pointing at the cloned project repo. This file is generated by `qavor init` and is the only piece of workspace state that lives outside `.qavor/`.

**Options considered.**
- **Single freestanding bootstrap file (original proposal)** — Required deciding where it lives (file vs URL vs seed repo) and duplicated information that already belongs alongside the project's source of truth.
- **Project-repo seeded + generated workspaces pointer (chosen)** — Source of truth (the project manifest) lives in a normal git repo so it benefits from review, history, and access controls. The on-disk `kind: workspaces` document is purely a runtime breadcrumb that ties the workspace dir to the project repo path.
- **Inferred (no pointer file)** — Force the user to invoke qavor from inside the project repo. Rejected: workspaces typically contain many repos; running from any of them, or from the workspace root, must Just Work.

**Decision.** `qavor init <project-repo-source>` is the only entry point.

`<project-repo-source>` may be:
1. A local path to an already-cloned project repo (treated as the project repo in place).
2. A `git@…` or `https://…` git URL — qavor clones it under `<workspace-root>/<repo-name>.git/` and proceeds.
3. A path inside an existing workspace dir (re-init / repair).

After resolving the source, qavor:
1. Ensures the workspace directory exists (creates it if `<workspace-root>` was supplied via `--into <dir>`; otherwise uses cwd).
2. Reads the project repo's `qavor.yaml` (`kind: project`).
3. Writes `<workspace-root>/qavor.yaml` (`kind: workspaces`) pointing to the project repo path.
4. Clones the rest of the repos enumerated in the project manifest, applying `git.repo_prefix` / `git.default_branch` / per-repo overrides.

**Consequences.**
- Single source of truth for "what's in the workspace": the project repo's manifest, versioned like any other code.
- Private project repos are reachable through the user's git credential helper — no second auth surface for qavor to manage.
- The generated `kind: workspaces` file is small, deterministic, and safe to commit if a team chooses (it just records `root_project_path`).
- A user can reproducibly recreate a workspace by running `qavor init <project-repo-url>` again into a new directory.

**Amendment (2026-07, single-repo projects).** ADR-004 assumes a workspace of many repos and therefore mandated `qavor init` + a generated `kind: workspaces` pointer, explicitly rejecting the "inferred, no pointer file" option. That rejection was justified *only* by the multi-repo premise ("workspaces typically contain many repos; running from any of them must Just Work"). A **single-repo project** breaks that premise: the repo is the entire workspace, so there is nowhere else to run from and nothing to point at.

For a `kind: project` manifest with `standalone: true` (and no `repositories:`):
- There is **no `kind: workspaces` manifest** — the workspaces pointer is a multi-repo construct only. The repo containing the standalone project manifest *is* the workspace root.
- `qavor init` is **not required**. Any command run inside the repo detects the standalone project by walking up (only after finding no `kind: workspaces` pointer), and lazily bootstraps an in-repo `.qavor/`. `qavor init` still works but refuses to write a pointer over the repo's own manifest.
- The repo set is a single synthesized self-entry, so the multi-repo machinery (git fan-out, discovery, doctor) runs unchanged.

This is an **additive carve-out**, not a reversal: multi-repo bootstrap still follows ADR-004 exactly. The inferred/no-pointer path is scoped strictly to the single-repo layout the original ADR did not consider. See `AGENTS.md §6` and [manifests.md](./manifests.md#single-repo-standalone-projects).

---

## ADR-005 — Compose file ownership: **generate-and-own with overlay overrides**

**Status:** Accepted (v0).

**Context.** Container services (`mode: docker`) and backing services (`mode: docker-compose`) need a compose project. Either qavor owns it end-to-end (generated from manifests) or qavor consumes a user-authored compose file.

**Options considered.**
- **Generate-and-own** — qavor renders a compose file into `.qavor/compose/docker-compose.yaml` from the declarative model. Pure source-of-truth in qavor manifests; users never edit the generated file.
- **User-authored** — qavor reads an existing compose file and tries to align env/deps with manifests. Brittle, dual source of truth, hostile to the dependency graph.
- **Generate-and-own with overlay overrides** — qavor owns the generated file, but supports user-supplied overlay files referenced from a manifest (e.g. via a `compose.override:` field on the relevant kind, defined later when the need arises). Overlays are merged using compose's standard `-f` stacking. Escape hatch without losing source-of-truth.

**Decision.** Generate-and-own with overlay overrides.

**Consequences.**
- Generated file is treated as a build artifact: written under `.qavor/compose/`, regenerated on every relevant op, and listed in `.gitignore`.
- The compose project is composed from every `kind: service` whose active mode is `docker` or `docker-compose` (the latter typical for backing services). The runtime block on each manifest provides the build/run command(s) qavor uses to populate the compose service.
- Overlays (when introduced) are explicit, versioned, and limited (qavor warns when an overlay clobbers an env var that qavor would have published from a service's `env.publish:` map — provenance is preserved in `qavor explain`).
- Compose project name is namespaced per workspace (the project manifest's `name`) to avoid collisions when multiple workspaces coexist.

---

## ADR-006 — Workspace state directory: **per-workspace `.qavor/` plus global `~/.cache/qavor/`**

**Status:** Accepted (v0).

**Context.** qavor needs to persist resolved env, last-known repo states, lockfile hashes, generated compose files, PIDs, logs, and downloaded artifacts (cached project repos, language toolchains where applicable).

**Options considered.**
- **Per-workspace only (`./.qavor/`)** — Self-contained, easy to reason about, but duplicates large artifacts (toolchains, image layers — though images are Docker's domain).
- **Global only (`~/.cache/qavor/`)** — Shared cache, but workspace state in a global dir is fragile, hard to inspect, and complicates multi-workspace use.
- **Both (split by purpose)** — Per-workspace `.qavor/` holds workspace-scoped state; global `~/.cache/qavor/` holds shared/immutable artifacts.

**Decision.** Both, split by purpose.

**Consequences.**
- Per-workspace `./.qavor/` (gitignored by qavor's `init`):
  - `state/` — PIDs, supervisor state, last health-check results.
  - `logs/<service>/` — rotated log files.
  - `compose/` — generated compose project.
  - `cache/` — lockfile hashes, resolved env snapshots, dep-graph cache.
  - `config.local.yaml` — workspace-local non-secret overrides.
- Global `~/.cache/qavor/` (or `$XDG_CACHE_HOME/qavor/`):
  - `projects/<hash>/` — cached clones of project repos when `qavor init` was given a URL into an empty workspace.
  - `artifacts/` — downloaded helpers (e.g., schema files, optional tooling).
- A `qavor clean` operates per-workspace by default; `qavor clean --global` clears the shared cache.

---

## ADR-007 — Remote profile sources: **profiles may be referenced by URL / git, fetched at registry-build time**

**Status:** Accepted (2026-07).

**Context.** Profiles (`kind: profile`) are reusable `runtime`/`mode`/`env` bundles referenced by name from a `profiles:` list. Teams want to share a curated profile across many workspaces without copying it into each one. ADR-004 deliberately rejected putting the **bootstrap/workspaces manifest** behind a URL (it duplicates information that belongs in the project repo, and would add a second auth surface). That rejection is about the workspace's *repo set*, not about reusable configuration fragments — a shared profile is content, not workspace identity, so the two concerns are distinct.

**Options considered.**
- **Names only (status quo)** — Simple, fully offline, but every workspace must vendor a copy of any shared profile and keep it in sync by hand.
- **Project-level import block** — A `profileSources: [url]` list on the project manifest. Central, but adds a new top-level field and a second indirection (import, then reference by name).
- **URL/object at the reference site (chosen)** — A `profiles:` entry may itself be a remote source (string URI or long-form object). Matches how profiles are already referenced; the fetched profile is registered under its declared name and then flows through the unchanged name-based resolver.

**Decision.** A `profiles:` entry may be a bare name **or** a remote source. Supported sources: an https URL, a GitHub URL/shorthand, a git SSH/HTTPS repo ref (`…/repo.git//path[@ref]`), or a `file://`/relative path. A pre-pass in `buildWorkspaceRegistry` fetches each unique source (bounded fan-out, `AbortSignal`), validates it as `kind: profile`, registers it, and rewrites the reference to the profile's name so `manifest/resolve.ts` runs unchanged.

**Consequences.**
- **Auth, no new store.** Git sources authenticate through the user's existing git credential helper / SSH agent — consistent with ADR-004's "no second auth surface". The *only* new surface is an **optional** bearer token for raw https/GitHub sources, gated behind an explicit `auth.tokenEnv` (an env-var name); nothing is sent unless the manifest opts in.
- **Integrity.** An optional `sha256` pin (SRI-style `integrity:` field or `#sha256=` fragment) is verified against the fetched bytes and fails closed on mismatch.
- **Determinism / offline.** Fetched content is cached under `~/.cache/qavor/` (`profiles/` for https/GitHub, `profiles-git/` for clones — see ADR-006). `--offline` resolves from cache only; `--refresh` re-fetches. A workspace that declares no remote reference pays zero network cost.
- **No new dependency.** Fetching uses Node's built-in `fetch` and the existing git wrapper (ADR-001 / AGENTS §4).
- **Errors.** Fetch/git/integrity failures and invalid fetched documents are collected as manifest issues during registry build (fail-closed), reported with the source URI as the `file`; like any unresolvable reference they surface via the exit `2` (manifest error) path.

---

## Decision summary table

| ADR | Topic | Decision |
|---|---|---|
| 001 | Implementation language | **Node.js (TypeScript)**, Node 26+, shipped on npm as `qavor` (SEA build planned) |
| 002 | Process supervision | *Superseded for native* (no built-in supervisor; `run` is a foreground manifest command). Compose for docker / docker-compose still planned. |
| 003 | Container runtime | **Docker only at v0**; pluggable later |
| 004 | Bootstrap | **`qavor init <project-repo-source>`** — project repo is the seed; `kind: workspaces` pointer is generated |
| 005 | Compose file | Generated-and-owned, with overlay overrides |
| 006 | State directory | Per-workspace `./.qavor/` + global `~/.cache/qavor/` |
| 007 | Remote profile sources | `profiles:` may reference a URL / git / file source; fetched, pinned, cached at registry-build time |
