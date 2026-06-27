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

## Workspaces Manifest

The workspace-level manifest. This file is created dynamically as the part of the
initial clone and the only purpose is to be point to the 

The project repo provides top level de

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
    # command check installed when starting natively
    check_installed:
      cmd: "uv --version"
    # command install when starting natively
    install:
      cmd: |
        echo "UV is not installed. Install it first and try again."
    # `prepare` is a user-defined command, not a reserved key. Any key here other
    # than enabled/check_installed/install/run is a command, discovered and run on
    # demand as `qavor <key>` (here `qavor prepare`). qavor assumes no fixed set.
    prepare:
      cmd: "uv sync --all-extras"
    # another user-defined command — run on demand as `qavor update_libraries`.
    # any command may be written as a list of steps run in sequence — each entry
    # is a full step (own cmd/cwd/env/shell) and the first non-zero exit aborts
    # the rest. (`run` is the exception: it takes a single command.)
    update_libraries:
      - cmd: "uv lock --upgrade"
      - cmd: "uv sync --all-extras"
    # `run` is reserved: the long-lived process started by `qavor up`.
    run:
      cmd: "uv run uvicorn app.main:app --port ${PORT}"
  docker:
    enabled: true
    # command check installed when starting natively
    check_installed:
      cmd: "docker --version"
    # command install when starting natively
    install:
      cmd: |
        echo "Docker is not installed. Install it first and try again."
    # command prepare when starting natively
    prepare:
      cmd: "docker build -t ${IMAGE_NAME} Dockerfile"
    # command run when starting natively
    run:
      cmd: "docker run -it --rm ${IMAGE_NAME}"



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
Multiple profiles can bee referenced. The order is from top to bottom. Profiles should be able to reference
other profiles as well.


```yaml
# indicates a named run profile
kind: profile

# unique profile name; referenced from the CLI
name: python_application

# defines common rules for preparing and running python applications
runtime:
  native:
    enabled: true
    # command check installed when starting natively
    check_installed:
      cmd: "uv --version"
    # command install when starting natively
    install:
      cmd: |
        echo "UV is not installed. Install it first and try again."
    # `prepare` is a user-defined command, not a reserved key. Any key here other
    # than enabled/check_installed/install/run is a command, discovered and run on
    # demand as `qavor <key>` (here `qavor prepare`). qavor assumes no fixed set.
    prepare:
      cmd: "uv sync --all-extras"
    # another user-defined command — run on demand as `qavor update_libraries`.
    # any command may be written as a list of steps run in sequence — each entry
    # is a full step (own cmd/cwd/env/shell) and the first non-zero exit aborts
    # the rest. (`run` is the exception: it takes a single command.)
    update_libraries:
      - cmd: "uv lock --upgrade"
      - cmd: "uv sync --all-extras"
    # `run` is reserved: the long-lived process started by `qavor up`.
    run:
      cmd: "uv run uvicorn app.main:app --port ${PORT}"
  docker:
    enabled: true
    # command check installed when starting natively
    check_installed:
      cmd: "docker --version"
    # command install when starting natively
    install:
      cmd: |
        echo "Docker is not installed. Install it first and try again."
    # command prepare when starting natively
    prepare:
      cmd: "docker build -t ${IMAGE_NAME} Dockerfile"
    # command run when starting natively
    run:
      cmd: "docker run -it --rm ${IMAGE_NAME}"

# default run mode for services in this profile (overridable per service via --mode)
mode: native

# env layered on top of every selected service
env:
  # common applies to every selected unit, regardless of run mode
  common:
    LOG_LEVEL: info
```


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
