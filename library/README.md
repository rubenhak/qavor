# qavor service library

Ready-made, parametrizable templates for the stateful services a dev workspace
usually needs. Each template is a `kind: profile` (all bring-up logic and
parameters) plus a ready-to-use `kind: service` document in one `qavor.yaml`,
with any supporting files (a `docker-compose.yaml`) sitting next to it.

| Template | Runs | Publishes to dependents |
|---|---|---|
| [`postgresql/`](postgresql/) | PostgreSQL via docker compose | `POSTGRES_URL`, `POSTGRES_HOST/PORT/DB/USER/PASSWORD` |
| [`mysql/`](mysql/) | MySQL via docker compose | `MYSQL_URL`, `MYSQL_HOST/PORT/DATABASE/USER/PASSWORD` |
| [`redisearch/`](redisearch/) | RediSearch (redis-stack-server) via docker compose | `REDIS_URL`, `REDIS_HOST/PORT` |
| [`kind/`](kind/) | Local Kubernetes cluster via the kind CLI | `KIND_CLUSTER_NAME`, `KUBECONFIG_CONTEXT` |

Every template declares the same verbs, which become `qavor <verb>` commands in
your workspace:

| Verb | Meaning |
|---|---|
| `up` | Idempotent bring-up: create if absent, start if stopped, no-op if running; blocks until ready |
| `down` | Stop and remove the runtime unit. **Data volumes are kept** (exception: kind — see below) |
| `status` | Show current state |
| `logs` | Print recent logs |
| `purge` | `down` **plus delete the data volume** — destroys data |

`check_installed` is also declared and surfaced by `qavor doctor`.

> **kind caveat:** a kind cluster's state lives inside its node containers, so
> `down` **is** destructive for the kind template. The database templates keep
> data across `down`/`up`.

## Consuming a template

### Mode A — reference it remotely (recommended)

Write a small `kind: service` stub in any repo of your workspace and point its
`profiles:` at the template **directory**. qavor fetches the whole directory
(profile + compose file), caches it, and flattens the profile into your stub:

```yaml
# e.g. qavor/infra.yaml in your project repo
kind: service
name: mysql
profiles:
  - github:rubenhak/qavor//library/mysql@v0.4.0   # always pin a tag
env:
  common:
    MYSQL_PORT: 3307        # any template parameter, overridden here
```

Then:

```bash
qavor up --only mysql          # bring it up (waits for the healthcheck)
qavor status --serial --verbose
qavor logs --only mysql --serial --verbose
qavor down                     # stop; data volume kept
qavor purge --only mysql       # stop + wipe data
```

Because a directory reference has no `.yaml` suffix, qavor reads
`<dir>/qavor.yaml` and materializes the sibling files locally. Supported source
forms:

| Form | Example | Notes |
|---|---|---|
| GitHub shorthand | `github:rubenhak/qavor//library/mysql@v0.4.0` | dir listed via the GitHub API; optional `auth.tokenEnv` bearer |
| GitHub page URL | `https://github.com/rubenhak/qavor/tree/v0.4.0/library/mysql` | same as above |
| git (SSH/HTTPS) | `git@github.com:rubenhak/qavor.git//library/mysql@v0.4.0` | whole repo cloned to the cache; user's git auth |
| local path | `file:///abs/path/qavor/library/mysql` or `{ url: ../qavor/library/mysql }` | for monorepos / local development |
| plain https | *file references only* (`https://…/qavor.yaml`) | a plain web server cannot be enumerated, so no directory form |

An optional `#sha256=<hex>` fragment (or long-form `integrity:`) pins the
`qavor.yaml` content; `@tag`/`@commit` pins the tree. Fetches are cached under
`~/.cache/qavor/`; `--offline` uses the cache only, `--refresh` re-fetches.

### Mode B — vendor it as-is

Copy the template directory into any repo of your workspace:

```bash
mkdir -p qavor/mysql && cd qavor/mysql
curl -fsSLO https://raw.githubusercontent.com/rubenhak/qavor/v0.4.0/library/mysql/qavor.yaml
curl -fsSLO https://raw.githubusercontent.com/rubenhak/qavor/v0.4.0/library/mysql/docker-compose.yaml
```

The file's second document is a ready `kind: service` (named `mysql`, grouped
under `database`), so `qavor up --only mysql` works immediately — no stub to
write. Override parameters by editing the service document's `env:` or via the
layers below. Updating means re-downloading.

## Parametrization and overrides

Every knob is an env var with a default declared in the template (see each
template's `env.common` — `qavor env <service>` prints the resolved values with
provenance). Overrides, later wins:

1. Template defaults (profile `env.common`)
2. **Your stub's `env:` block** ← put per-instance overrides here
3. `.env` next to your stub
4. Workspace-root `.env`
5. CLI `--env KEY=VAL`

**Derived-name caveat:** container/project names derive from `*_INSTANCE`
(e.g. `MYSQL_PROJECT: qavor-mysql-${MYSQL_INSTANCE}`), and the published
`*_URL` values interpolate the port/credentials. These derivations resolve from
the stub's own env scope — so override `*_INSTANCE`, ports, and credentials **in
the stub's `env:` block** (layer 2), not in the workspace `.env` or `--env`.

### Overriding steps

A stub can extend or replace the inherited commands with merge directives:

```yaml
kind: service
name: mysql
profiles: [ "github:rubenhak/qavor//library/mysql@v0.4.0" ]
runtime:
  native:
    up:
      operations:
        $append:                       # seed a schema after bring-up
          - cmd: mysql -h127.0.0.1 -P"$MYSQL_PORT" -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" < ./schema.sql
    purge:
      operations: { $unset: true }     # forbid data wipes in this workspace
```

### Multiple instances

Two stubs, same source, different instance + port (Mode A only — two vendored
copies would collide on the profile name):

```yaml
kind: service
name: mysql-app
profiles: [ "github:rubenhak/qavor//library/mysql@v0.4.0" ]
env: { common: { MYSQL_INSTANCE: app, MYSQL_PORT: 3306 } }
---
kind: service
name: mysql-test
profiles: [ "github:rubenhak/qavor//library/mysql@v0.4.0" ]
env: { common: { MYSQL_INSTANCE: test, MYSQL_PORT: 3307 } }
```

## Wiring application services

Declare the dependency and read the published contract:

```yaml
kind: service
name: api
require:
  - service: mysql
```

```bash
qavor up --only mysql                      # bring the database up first
eval "$(qavor resolve-env --only api --format export)"   # MYSQL_URL etc.
```

The published env (`MYSQL_URL`, …) flows to dependents through
`qavor resolve-env`; it is **not** injected automatically into `qavor <command>`
runs. Containers on the shared `DOCKER_NETWORK` (default `qavor`) also reach
each database by its container name (e.g. `qavor-mysql-main:3306`).

## Limitations

- **No dependency-ordered startup** — `require:` does not start things; run
  `qavor up` before your app's commands.
- **`install` is not executed** — `qavor doctor` runs `check_installed` and
  prints the install hint; installation is manual.
- **No `--group` fan-out yet** — scope with `--only <name...>`.
- **Parallel fan-out hides output** — use `--serial --verbose` to see docker's
  output (`status`/`ps` output is surfaced through the logger regardless).
- **One library version per workspace** — two different refs of the same
  template would collide on the profile name.
- POSIX `/bin/sh` steps; darwin + linux.

## Conventions for new templates

One directory per template, self-contained: a multi-document `qavor.yaml`
(profile `lib-<dir>` first, ready service second) plus sibling files. Uniform
verbs (`up/down/status/logs/purge` + `check_installed`/`install`), idempotent
`up` that blocks until ready, non-destructive `down`, data wipes only in
`purge`. Every parameter is a long-form envSpec with `description` plus either
`default` or, for a value derived at resolve time, `cmd` (and `secret: true`
where applicable), prefixed per template; images pinned to exact tags. POSIX
sh only in `cmd` steps and env `cmd` scripts. Guarded by `test/library.test.ts`.
Changing a template's interface (env names, publish keys, verbs) is a breaking
change for pinned consumers — bump deliberately.
