---
name: qavor-commands
description: Author, discover, and run dynamic (manifest-defined) commands for the Qavor CLI — the named shell tasks declared under `runtime.native` in a service's qavor.yaml (e.g. prepare, build, test, lint, migrate, update_libraries) that qavor fans out across the workspace as `qavor <command>`. Use when the user asks to "add a qavor command", "define prepare/build/test/lint/migrate in qavor.yaml", "run a qavor command across services", "list qavor commands", "why isn't my qavor command running", or "what commands does this workspace have". Optional argument: the command name or service in question.
argument-hint: [command-name | service-name | "list"]
---

# Qavor Dynamic Commands

This skill helps you **author, discover, and run dynamic commands** with the [Qavor CLI](https://github.com/rubenhak/qavor): the per-service shell tasks declared in `qavor.yaml` that qavor turns into `qavor <command>` subcommands and fans out across every service that declares them.

Read the whole file before editing a manifest or running anything.

## What a dynamic command is

A Qavor `kind: service` manifest declares runtime backends under `runtime:`. Inside the **`native`** backend, a small set of keys is reserved for the start lifecycle:

| Reserved key | Meaning |
|--------------|---------|
| `enabled` | Backend gate (boolean). |
| `check_installed` | Probe that decides whether `install` must run. |
| `install` | Runs only when `check_installed` fails. |
| `run` | The long-lived process started by `qavor up` (single step only). |

**Every other key under `runtime.native` is a dynamic command** — a named shell task discovered at startup and exposed as `qavor <name>`. There is no fixed command set; whatever you declare is runnable. Common examples: `prepare`, `build`, `test`, `lint`, `migrate`, `update_libraries`, `seed`, `clean`.

When you run `qavor <name>`, qavor fans the command out across **all** services that declare it; a service that doesn't declare it is reported `skipped`.

## Hard constraints (verify against these before editing)

These come from the implementation, not just the schema. Get them wrong and the command silently won't run:

1. **`native` backend only.** Dynamic commands are discovered and run **only** from `runtime.native`. The JSON Schema technically lets you put extra keys under `runtime.docker` or `runtime.docker-compose`, but qavor will never discover or run them. Put dynamic commands under `runtime.native`.
2. **Names must be safe tokens.** A command name is registrable only if it matches `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`. No spaces or exotic characters. Convention: lowercase with `_` (e.g. `update_libraries`).
3. **No shadowing built-ins.** If a command name collides with a built-in (`init`, `discover`, `workspace`, `manifests`, `validate`, `git`, `up`, `down`, `logs`, `ps`, `env`, `resolve-env`, `resolve-manifest`, `doctor`, `commands`, `help`), the built-in wins and the dynamic command is **not** reachable as `qavor <name>`. `qavor commands` flags it as `(shadowed)`. Pick a non-colliding name (e.g. `app-up` instead of `up`).
4. **No positional-arg passthrough.** `qavor <command>` accepts only `--only` and `--env` (plus global flags). Extra positional args are **not** forwarded to the shell step. A step written as `npm test ${@}` receives nothing — `$@` expands empty. If a command needs an input, pass it through the environment (`--env KEY=VAL`) and read `$KEY` in the step.
5. **Runs unconditionally.** No hashing, caching, or skip logic. Every invocation runs every step. Make steps idempotent.
6. **First non-zero exit aborts the rest.** Steps run in declaration order; the first failing step stops the command for that service and marks it failed.

## Step value shapes

A command value is a **single step**, a **list of steps**, or a **described command** that wraps either in `operations` alongside a `description`:

```yaml
runtime:
  native:
    enabled: true

    # Single-step form
    build:
      cmd: "npm run build"

    # Multi-step form — run in order, abort on first non-zero exit
    prepare:
      - cmd: "pnpm install"
      - cmd: "pnpm run codegen"

    # Described form — same step/list shapes, nested under `operations`,
    # with a one-line `description` alongside
    update_libraries:
      description: "Bump dependencies and re-lock."
      operations:
        - cmd: "npx npm-check-updates -u"
        - cmd: "pnpm install"
```

A step object supports:

| Field | Required | Notes |
|-------|----------|-------|
| `cmd` | yes | Shell command. A multi-line string is treated as a script. |
| `cwd` | no | Working directory **relative to the manifest file**. Defaults to the manifest's directory. |
| `env` | no | Extra env (UPPER_SNAKE keys) layered for this step. |
| `shell` | no | Override the shell. Defaults to `/bin/sh -c`. |

### Environment available to steps

Each step runs with the service's fully composed env (the layered `env.common` / `env.native` / `.env` chain) **plus** `QAVOR_COMMAND=<name>` so a step or hook can branch on which command is running.

## Describing a command

Write the command's value as an object with `description` + `operations` instead of a bare step/list:

```yaml
runtime:
  native:
    enabled: true
    build:
      description: "Compile the service for production."
      operations:
        cmd: "npm run build"
    test:
      description: "Run the unit test suite."
      operations:
        - cmd: "rm -rf logs"
        - cmd: "npm test"
```

`operations` is **required** whenever you use this form and accepts the exact same shapes a bare command value would: a single step, a list of steps, or (inside a profile) a merge directive (`$append`/`$prepend`/`$replace`/`$unset`). `description` is optional and **purely documentation** — it has no effect on what runs. It is surfaced in two places:
- `qavor commands` (and its `--json` form) — see [Discovering commands](#discovering-commands).
- `qavor <command> --help`'s one-line summary, plus a `Declared by: <services>` line.

Because the whole `{ description, operations }` object lives at the command's own key under `runtime.native`, it merges like any other backend key when a service references a profile: a profile can set a shared description on a command it defines, and a service that overrides just `operations` (own `{ operations: [...] }`, no `description` key) still inherits the profile's description. Add a description whenever you author a non-obvious command — it is the main way a human (or a skill introspecting the workspace via `qavor commands --json`) discovers what a command does without opening the manifest. Skip it for self-explanatory names (`build`, `test`) if you'd rather keep the bare step/list form.

### Hooks around commands

`pre_command` and `post_command` hooks fire around **every** dynamic command run. Branch by command name via `$QAVOR_COMMAND`:

```yaml
hooks:
  pre_command:
    - 'if [ "$QAVOR_COMMAND" = "test" ]; then echo "starting tests"; fi'
  post_command:
    - 'echo "$QAVOR_COMMAND finished"'
```

## Authoring a new command — procedure

1. **Find the service manifest.** Locate the `qavor.yaml` whose `kind: service` block should own the command. In a multi-service repo there may be several; pick the right one (or each one, if the command applies to all).
2. **Confirm the backend.** The command goes under `runtime.native`. If the service has no `native` backend yet, add one with at least `enabled: true`.
3. **Pick a safe, non-shadowing name** (see constraints 2 and 3).
4. **Write the step(s).** Prefer the single-step form unless you genuinely need ordered phases. Use `cwd` for monorepo sub-package paths. Keep steps idempotent (constraint 5).
5. **Wrap it as `{ description, operations }`** (see [Describing a command](#describing-a-command)) unless the name is already self-explanatory (`build`, `test`) — the description is what shows up in `qavor commands` and `--help`.
6. **Don't rely on arg passthrough** (constraint 4). If the command is parameterized, read an env var and document the `--env` invocation.
7. **Validate:** run `qavor validate` (catches schema errors) and `qavor commands` (confirms the new name is discovered, described, and **not** shadowed).

### Reusing a command across many services

If the same command (e.g. `prepare`, `build`, `test`) repeats across services, factor it into a `kind: profile` manifest and reference it from each service's `profiles:` list instead of copy-pasting. Profiles are merged before the service's own `runtime`, so the service can still override individual steps. (This mirrors how the kubevious workspace defines a `node_library` profile with shared `prepare`/`build`/`test`/`update_libraries` commands.)

## Discovering commands

```bash
qavor commands            # one block per command: name, description, wrapped service list (shadowed names flagged)
qavor commands --json     # { "commands": [ { command, description, services[], allServices, registered } ] }
```

Human output is one block per command, not a table:

```
▸ build — Build the library.
    Services (14): helper-backend, helper-cache, helper-data-store,
    helper-easy-data-store, helper-external-services, helper-logic-processor,
    helper-mongodb, helper-mysql, helper-rabbitmq, helper-redis,
    helper-rule-engine, helper-websocket-client, helper-websocket-server,
    helpers
```

The `Services` line collapses to `Services (N): all services` when every service in the workspace declares the command (check `allServices` in JSON for the same signal); otherwise it wraps the full list at ~80 columns rather than spelling it out on one unreadable line. `description` is `null` when no declaring service writes the command in the `{ description, operations }` form (the block then has no `— …` suffix); when more than one service disagrees, the first one in alphabetical service-name order wins (services sharing a command via a profile normally agree, since they inherit the same text).

`registered: false` (or a `(shadowed)` tag) means the name collides with a built-in or is an unsafe token — it exists in manifests but isn't reachable as `qavor <name>`; rename it.

This is also the command a **skill** (or any tool introspecting a workspace) should call first to learn what it can run and what each command is for, before reaching for `qavor <command> --help` on a specific name.

## Running commands

```bash
qavor <command>                       # fan out across every service that declares it
qavor <command> --only api --only web # restrict to named services
qavor <command> --env KEY=VAL         # inject/override env for this run (repeatable)
qavor <command> --serial              # one service at a time
qavor <command> --parallel --jobs 4   # bounded concurrency (default: CPU count)
qavor <command> --json                # NDJSON results, one object per service
qavor <command> --serial --verbose    # stream the step's raw stdout/stderr
```

### Reading the results / debugging failures

- Default (TTY, non-`--json`): a live table on stdout, one row per service — `ran` / `skip` / `fail`.
- A service that doesn't declare the command shows `skip` (`no <command> command`) — that's expected, not an error.
- Raw command output is shown **only** under `--serial --verbose`. In parallel runs the output is discarded to avoid interleaving. So when a command fails, **re-run it with `--serial --verbose`** to see why.
- Exit codes: `0` all ran/skipped · `1` user error (unknown service via `--only`, or a name that isn't a known command) · `3` runtime error (at least one service's command failed).

## Worked example

A Node service that needs install, build, lint, and test:

```yaml
kind: service
name: api

runtime:
  native:
    enabled: true
    check_installed:
      cmd: "pnpm --version"
    install:
      cmd: 'echo "Install pnpm, then retry." && exit 1'

    # dynamic commands ↓
    prepare:
      description: "Install dependencies."
      operations:
        cmd: "pnpm install"
    build:
      description: "Compile the service for production."
      operations:
        cmd: "pnpm run build"
    lint:
      description: "Run the linter."
      operations:
        cmd: "pnpm run lint"
    test:
      description: "Run the unit test suite."
      operations:
        - cmd: "rm -rf logs"
        - cmd: "pnpm test"
    migrate:
      description: "Apply pending database migrations."
      operations:
        cmd: 'pnpm run db:migrate -- --env "${MIGRATE_ENV:-dev}"'

mode: native
```

Then:

```bash
qavor commands                 # shows build/lint/migrate/prepare/test → api, each with its description
qavor prepare                  # pnpm install across the workspace
qavor build --only api         # build just api
qavor migrate --env MIGRATE_ENV=staging
qavor test --serial --verbose  # watch the test output live
```

## Common pitfalls checklist

- [ ] Command placed under `runtime.native` (not `docker` / `docker-compose`).
- [ ] Name is a safe token and doesn't collide with a built-in (`qavor commands` shows it without `(shadowed)`).
- [ ] The command is wrapped as `{ description, operations }`, unless the name is self-explanatory.
- [ ] Not depending on positional arg passthrough; parameterize via `--env`.
- [ ] Steps are idempotent (they run every time, no caching).
- [ ] `cwd` is set for sub-package paths in monorepos.
- [ ] Ran `qavor validate` and `qavor commands` after editing.

## Scope / boundaries

- This skill only authors and runs **dynamic commands**. To scaffold whole manifests from scratch, use the `qavor-init` skill instead.
- Never hand-edit the generated TypeScript types in the qavor source tree; this skill only touches `qavor.yaml` manifests and runs the CLI.
- Never put secret values literally in a manifest. Use `${secret:NAME}` interpolation or pass them at runtime via `--env`.
