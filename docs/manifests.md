# Manifest Examples

Below are examples describing various manifests for Qavor.

All manifests share three conventions:

- A top-level `kind:` field discriminates the document. Tooling validates against
  one schema per kind.
- A repo's manifests live in `qavor.yaml` (single or multi-document) at the
  repo root. For repos with many services, a `qavor/` directory of files is
  also accepted; both forms can mix kinds freely.
- Environment variables are layered: `common` always applies; `native` or
  `container` is added on top depending on run mode. Workspace `.env`, user
  `.env.local`, and `--env KEY=VAL` continue to override on top of that.

> **Runtime-support status.** Every manifest shape below validates against the
> schemas, but not all of it executes yet. **Runs today:** the `native` runtime
> via dynamic commands (`qavor <command>` — e.g. `qavor run`, `qavor prepare`),
> profiles (local + remote,
> chaining, merge directives), `require:`-dependency env composition, and the
> `env.publish` contract (composed into dependents by `qavor resolve-env`).
> **Not yet executed:** `mode: docker` / `mode: docker-compose` bring-up
> (backing services validate and their published contract composes, but qavor
> does not yet start their compose project), and `${secret:...}` interpolation,
> which is **reserved and fails closed**. Use plain env for now. See the
> [README implementation status](../README.md#implementation-status).

A typical workspace on disk looks like this:

```
<workspace>/                       # root workspace dir (not a git repo)
├── qavor.yaml                     # workspace manifest          (kind: workspaces)
├── project-repo.git/              # project repo: workspace identity + repo list
│   └── qavor.yaml                 # project manifest            (kind: project)
├── service-repo-1.git/            # single-service repo
│   └── qavor.yaml                 # service manifest            (kind: service)
├── service-repo-2.git/
│   └── qavor.yaml                 # service manifest            (kind: service)
├── multi-service-repo-3.git/      # repo hosting multiple services
│   ├── service-foo/
│   │   └── qavor.yaml             # service manifest            (kind: service)
│   └── service-bar/
│       └── qavor.yaml             # service manifest            (kind: service)
├── backing-dependencies.git/      # repo grouping backing services
│   ├── postgresql/
│   │   └── qavor.yaml             # backing service            (kind: service)
│   ├── kafka/
│   │   └── qavor.yaml             # backing service            (kind: service)
│   └── rabbitmq/
│       └── qavor.yaml             # backing service            (kind: service)
└── another-repo.git/              # plain repo; qavor.yaml is optional
```

## Single-repo (standalone) projects

A project does not need a separate workspace dir and a list of sibling repos. A
`kind: project` manifest with `standalone: true` (and no `repositories:`) declares
that **the repo holding it is the whole workspace**. There is no `kind: workspaces`
pointer; the `.qavor/` state dir lives inside the repo (auto-gitignored) and is
bootstrapped on first command — no `qavor init` needed.

Case 1 — a single repo with one top-level service (a 2-document root `qavor.yaml`):

```yaml
kind: project
name: my-app
standalone: true
---
kind: service
name: api
mode: native
runtime:
  native:
    enabled: true
    run: { operations: { cmd: pnpm start } }
```

Case 2 — a single repo with several services a few directories down. The root holds
only the standalone project; services are discovered by the normal sub-directory scan:

```
<repo>/                            # the git repo == the workspace
├── qavor.yaml                     # kind: project, standalone: true
├── services/
│   ├── gateway/qavor.yaml         # kind: service
│   └── worker/qavor.yaml          # kind: service
└── .qavor/                        # in-repo state (gitignored)
```

`qavor discover` in a single-repo scans the repo's own sub-directories and scaffolds a
`kind: service` manifest into any Dockerfile-bearing dir (it never writes `repositories:`).

## Workspaces Manifest

**Multi-repo only.** The workspace-level manifest exists solely in a multi-repo
workspace, where the workspace directory is a plain (non-git) parent dir holding the
cloned repos. Its only job is to reference the root project repo dir. It is created
dynamically by `qavor init` (never hand-written) and is the one piece of workspace
state that lives outside `.qavor/`.

A **single-repo (`standalone: true`) project has no workspaces manifest** — the repo is
its own workspace, so there is nothing to point at. See *Single-repo (standalone)
projects* above.

```yaml
# indicates that the manifest describes the root workspace
kind: workspaces

# The path to the project repo where the root project manifest is defined
root_project_path: ./project-repo.git
```

## Project Manifest

The single source of truth for the workspace's repo set. Defines how the repos are
cloned and lists every repository in the project. `qavor init` reads this manifest to
clone the rest of the repos. No other manifest kind contributes repos to the workspace —
`kind: service` manifests only describe how to build and run apps.

```yaml
# indicates that the manifest describes the root project / workspace
kind: project

# human-readable workspace name; used as the compose project namespace
name: acme-platform

# git configuration shared by all repos in the project
git:
  # base git clone url; combined with repo_prefix and the repo `name` below
  # to form the final clone URL unless an explicit `url` is given on the repo
  root_url: https://github.com/rubenhak

  # optional prefix to append to repository names below
  repo_prefix: acme-

  # optinal branch to clone when a repo does not pin its own, "main" will be the default
  default_branch: main

# list of repositories in the project
repositories:
  # minimal form; URL is derived as ${root_url}/${repo_prefix}${name}.git
  - web
  - app
  - db
```



## Service Manifest

A runnable application: it describes how to build and execute an app. The `kind: service`
manifest covers **both** first-party apps (built and run natively or in a container) and
externally provided backing dependencies such as postgres, kafka, or redis. A backing
service typically runs via `docker-compose` (qavor generates and owns the compose project,
per ADR-005) and exposes an explicit `env.publish` contract to its dependents; see
[Backing services](#backing-service-example) below. A service manifest never defines which
repos belong to the workspace — that list lives only in the `kind: project` manifest's
`repositories:`. A repo may contain zero, one, or many service manifests.

```yaml
# indicates that the manifest describes an executable application
kind: service

# unique service name within the workspace; cross-repo refs use this
name: auth

# optional additional group membership
groups: [backend]

# which runtimes are available for this service
runtime:
  native:
    enabled: true
    # Every command shares one uniform shape: an optional one-line `description`
    # plus `operations` (the step or steps that run). There is no structural
    # difference between the two reserved install-lifecycle commands
    # (check_installed, install) and user-defined ones — they all look like this.
    check_installed:
      description: "Check that uv is installed."
      operations:
        - cmd: "uv --version"
    install:
      description: "Install uv."
      operations:
        - cmd: |
            echo "UV is not installed. Install it first and try again."
    # `prepare` is a user-defined command, not a reserved key. Any key here other
    # than enabled/check_installed/install/run is a command, discovered and run
    # on demand as `qavor <key>` (here `qavor prepare`). qavor assumes no fixed
    # set. `description` is documentation only — surfaced by `qavor commands` and
    # by `qavor <command> --help`; a service referencing this profile inherits it
    # unless it overrides it.
    prepare:
      description: "Sync Python dependencies via uv."
      operations:
        - cmd: "uv sync --all-extras"
    # `operations` may be a list of steps run in sequence — each entry is a full
    # step (own cmd/cwd/env/shell) and the first non-zero exit aborts the rest.
    update_libraries:
      description: "Upgrade the uv lockfile and re-sync."
      operations:
        - cmd: "uv lock --upgrade"
        - cmd: "uv sync --all-extras"
    # `run` is just another user-defined command — start the app on demand with
    # `qavor run`. qavor does not special-case or supervise it; the name is only a
    # convention.
    run:
      description: "Start the app."
      operations:
        - cmd: "uv run uvicorn app.main:app --port ${PORT}"
  docker:
    enabled: true
    check_installed:
      description: "Check that docker is installed."
      operations:
        - cmd: "docker --version"
    install:
      description: "Install docker."
      operations:
        - cmd: |
            echo "Docker is not installed. Install it first and try again."
    prepare:
      description: "Build the image."
      operations:
        - cmd: "docker build -t ${IMAGE_NAME} Dockerfile"
    run:
      description: "Run the container."
      operations:
        - cmd: "docker run -it --rm ${IMAGE_NAME}"



# default run mode for services in this profile (overridable per service via --mode)
mode: native

# what this service needs in order to start
require:
  - service: postgres             # named backing service in this workspace
  - service: token-issuer         # cross-repo service reference (by service name)

env:
  # common env variables apply to all environments
  common:
    PORT: 8080
    LOG_LEVEL: info

  # native applies along with common env vars when running natively
  native:
    LOG_FORMAT: text

  # container applies along with common env vars when running in a container
  docker:
    IMAGE_NAME: auth-service
    LOG_LEVEL: warn
    LOG_FORMAT: json
```


<a id="backing-service-example"></a>
### Backing service (postgres, kafka, redis, …)

An externally provided backing dependency is just a `kind: service` with two
extra traits: it usually runs via `docker-compose` (qavor generates and owns the
compose project, per ADR-005), and it declares an `env.publish` block — the
explicit contract exposed to dependents. When a service declares `env.publish`,
its dependents receive **only** the published keys (interpolated at start time),
never its full env.

```yaml
# a backing service is just a service that publishes a contract
kind: service

# unique service name within the workspace
name: postgres

# optional additional group membership
groups: [database]

# which runtimes are available; backing services typically use docker-compose
mode: docker-compose
runtime:
  native:
    enabled: false
  docker:
    enabled: false
  docker-compose:
    enabled: true

# Hooks allow custom operation to be performed 
hooks:
  pre_run:
    - ./pre-run.sh
  post_run:
    - ./post-run.sh
  
# defines environment variables for the dep itself
env:
  # common env variables apply to all environments
  common:
    POSTGRES_DB:       auth
    POSTGRES_USER:     auth
    POSTGRES_PASSWORD: "${secret:PG_PW}"

  # native applies along with common env vars when running natively
  native:
    POSTGRES_HOST: localhost
    POSTGRES_PORT: 1234

  # container applies along with common env vars when running in a container
  docker:
    POSTGRES_HOST: mypostgresql
    POSTGRES_PORT: 5432


  # variables published to dependents (resolved into their env at start time)
  publish:
    POSTGRES_HOST: "${POSTGRES_HOST}"
    POSTGRES_PORT: "${POSTGRES_PORT}"
    POSTGRES_URL:  "postgres://auth:${secret:PG_PW}@${HOST}:${PORT}/auth"
    
```



## Manifest Resolution Order

When the same env key is set in multiple places, later layers win:

1. References from require dependencies:
    1.1 commmon envs from `qavor.yaml`
    1.2 native or container envs  (depending on mode)
    1.3 `.env` next to the `qavor.yaml`
    1.4 `.env.native` or `.env.container` (depending on mode), next to the `qavor.yaml`
2. The service itself:
    2.1 commmon envs from `qavor.yaml`
    2.2 native or container envs  (depending on mode)
    2.3 `.env` next to the `qavor.yaml`
    2.4 `.env.native` or `.env.container` (depending on mode), next to the `qavor.yaml`
3. Workspace `.env`
4. CLI `--env KEY=VAL`

The mode-specific dotenv file is `.env.native` in native mode and `.env.docker`
(with `.env.container` accepted as an alias) in docker mode.

`qavor env <service>` prints the fully-resolved value with provenance for each
key, so this chain is always inspectable.

`qavor resolve-env --only <service>` resolves the same chain
**including `require:` dependencies** (ordinary deps contribute their full env;
backing services that declare `env.publish` contribute only that contract) and
can emit a shell-sourceable form:

```bash
# inspect (human-readable, secrets redacted)
qavor resolve-env --only auth

# source the resolved env into the current shell (real values, incl. secrets)
eval "$(qavor resolve-env --only auth --format export)"
#   or: source <(qavor resolve-env --only auth --format export)

# machine-readable
qavor resolve-env --only auth --json
```




## Profile Manifest
Profiles allow configuration reusability and can be referenced from service manifests.
Multiple profiles can be referenced; they merge in declaration order, from top to
bottom, with later entries winning. A profile may itself reference other profiles
(see [Profile inheritance](#profile-inheritance-and-step-list-merge-directives) below).


```yaml
# indicates a named run profile
kind: profile

# unique profile name; referenced from the CLI
name: python_application

# defines common rules for preparing and running python applications
runtime:
  native:
    enabled: true
    # Every command shares one uniform shape: an optional one-line `description`
    # plus `operations` (the step or steps that run). There is no structural
    # difference between the two reserved install-lifecycle commands
    # (check_installed, install) and user-defined ones — they all look like this.
    check_installed:
      description: "Check that uv is installed."
      operations:
        - cmd: "uv --version"
    install:
      description: "Install uv."
      operations:
        - cmd: |
            echo "UV is not installed. Install it first and try again."
    # `prepare` is a user-defined command, not a reserved key. Any key here other
    # than enabled/check_installed/install/run is a command, discovered and run
    # on demand as `qavor <key>` (here `qavor prepare`). qavor assumes no fixed
    # set. `description` is documentation only — surfaced by `qavor commands` and
    # by `qavor <command> --help`; a service referencing this profile inherits it
    # unless it overrides it.
    prepare:
      description: "Sync Python dependencies via uv."
      operations:
        - cmd: "uv sync --all-extras"
    # `operations` may be a list of steps run in sequence — each entry is a full
    # step (own cmd/cwd/env/shell) and the first non-zero exit aborts the rest.
    update_libraries:
      description: "Upgrade the uv lockfile and re-sync."
      operations:
        - cmd: "uv lock --upgrade"
        - cmd: "uv sync --all-extras"
    # `run` is just another user-defined command — start the app on demand with
    # `qavor run`. qavor does not special-case or supervise it; the name is only a
    # convention.
    run:
      description: "Start the app."
      operations:
        - cmd: "uv run uvicorn app.main:app --port ${PORT}"
  docker:
    enabled: true
    check_installed:
      description: "Check that docker is installed."
      operations:
        - cmd: "docker --version"
    install:
      description: "Install docker."
      operations:
        - cmd: |
            echo "Docker is not installed. Install it first and try again."
    prepare:
      description: "Build the image."
      operations:
        - cmd: "docker build -t ${IMAGE_NAME} Dockerfile"
    run:
      description: "Run the container."
      operations:
        - cmd: "docker run -it --rm ${IMAGE_NAME}"

# default run mode for services in this profile (overridable per service via --mode)
mode: native

# env layered on top of every selected service
env:
  # common applies to every selected unit, regardless of run mode
  common:
    LOG_LEVEL: info
```

### Profile inheritance and step-list merge directives

A profile may itself carry a `profiles:` list, so profiles inherit from one or
more parent profiles. The chain is flattened at registry-build time: parents are
merged in declaration order (later winning), and the referencing profile/service
merges on top. `mode` and scalar values replace; `env` maps deep-merge key by
key; **a command's `operations` replace by default** — a `prepare.operations`
list on a child overrides the parent's `prepare` outright.

To *extend* an inherited step list instead of replacing it, a command's
`operations` may be a **merge directive** — an object with exactly one of
`$append` / `$prepend` / `$replace` / `$unset`. Directives are available on every
command, without exception.

```yaml
kind: profile
name: node_base
runtime:
  native:
    prepare:
      operations:
        - { cmd: "pnpm install" }
        - { cmd: "pnpm build" }
    test:
      operations:
        - { cmd: "pnpm test:unit" }
---
kind: service
name: web
profiles: [node_base]
runtime:
  native:
    # $prepend: run codegen before the inherited install/build steps
    prepare:
      operations:
        $prepend:
          - { cmd: "pnpm codegen" }
    # $append: add an integration pass after the inherited unit tests
    test:
      operations:
        $append:
          - { cmd: "pnpm test:int" }
    # $replace: explicit form of the default (override inherited steps)
    lint:
      operations:
        $replace:
          - { cmd: "biome check ." }
    # $unset: drop a command the parent defined
    migrate:
      operations: { $unset: true }
```

`web` resolves to `prepare: [codegen, install, build]`,
`test: [test:unit, test:int]`, `lint: [biome check .]`, and no `migrate`.
Directives compose down a chain: each layer sees the steps accumulated by the
layers below it. On a command with no inherited value, `$append`/`$prepend`/
`$replace` simply yield their own steps and `$unset` is a no-op.

### Remote profile references

A `profiles:` entry is normally a bare workspace-local name, but it may also point
at a **remote source** so teams can share profiles out-of-workspace. Remote
profiles are fetched, cached, optionally integrity-checked, validated as
`kind: profile`, and registered under their declared `name` — after which they
merge exactly like a local profile (declaration order, later wins, chaining
supported). Resolution happens once at registry-build time; nothing is fetched
unless a manifest actually declares a remote reference.

Two forms are accepted, and may be mixed freely with bare names:

```yaml
kind: service
name: auth
profiles:
  - python_application                                   # local, by name
  - https://cfg.acme.dev/profiles/base.yaml              # https URL (string form)
  - github:acme/config//profiles/base.yaml@v1.2.0        # GitHub shorthand
  - git@github.com:acme/config.git//profiles/base.yaml@main   # git over SSH
  - name: shared_base                                    # long-form object
    url: https://cfg.acme.dev/profiles/base.yaml
    integrity: sha256-<64 hex>                           # optional pin (fails closed)
    auth:
      tokenEnv: ACME_PROFILE_TOKEN                       # bearer token from env
```

**Supported sources**

| Form | Example | Auth |
|---|---|---|
| https URL | `https://host/base.yaml` | optional bearer via `auth.tokenEnv` |
| GitHub | `github:owner/repo//path[@ref]` or a `…/blob/<ref>/<path>` page URL | optional bearer |
| git (SSH/HTTPS) | `git@host:owner/repo.git//path[@ref]`, `ssh://…`, `https://….git//path[@ref]` | user's git credential helper / SSH agent |
| local file | `file:///abs/base.yaml`, or `{ url: ./rel/base.yaml }` (relative to the manifest) | — |

- **Integrity.** An optional `sha256-<hex>` pin (via the `integrity` field or a
  `#sha256=<hex>` fragment on the string form) is verified against the fetched
  bytes; a mismatch fails closed.
- **Auth.** Git sources reuse the user's existing git credential helper / SSH
  agent — there is no second credential store. Raw https/GitHub sources may set
  `auth.tokenEnv` (an env var name) to send `Authorization: Bearer <value>`.
- **Caching & offline.** Fetched content is cached under `~/.cache/qavor/`
  (`profiles/` for https/GitHub, `profiles-git/` for clones). `--offline`
  resolves from cache only; `--refresh` re-fetches.

```yaml
# indicates that the manifest describes an executable application
kind: service

# unique service name within the workspace; cross-repo refs use this
name: auth

# optional additional group membership
groups: [backend]

profiles:
  - python_application

# what this service needs in order to start
require:
  - service: postgres             # named backing service in this workspace
  - service: token-issuer         # cross-repo service reference (by service name)

env:
  # common env variables apply to all environments
  common:
    PORT: 8080

  # native applies along with common env vars when running natively
  native:
    LOG_FORMAT: text

  # container applies along with common env vars when running in a container
  docker:
    LOG_LEVEL: warn
    LOG_FORMAT: json
```
