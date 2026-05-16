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

The structure should be as following:

```
- root workspace dir (not a git repo)
  - qavor.yaml               # workspace manifest
  - project-repo.git
    - qavor.yaml             # root project manifest
  - service-repo-1.git
    - qavor.yaml             # service manifest
  - service-repo-2.git
    - qavor.yaml             # service manifest
  - multi-service-repo-3.git
    - service-foo
      - qavor.yaml             # service manifest
    - service-bar
      - qavor.yaml             # service manifest
  - stateful-dependencies.git
    - qavor.yaml             # repo manifest
    - postgresql
      - qavor.yaml           # dependency manifest
    - kafka
      - qavor.yaml           # dependency manifest
    - rabbitmq
      - qavor.yaml           # dependency manifest
  - another-repo.git         # does not necessarily need to contain a qavor.yaml file
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

Defines how he repos are going to be cloned and the list of all repositories in the project.
This repo is used to close the rest of the repos in the project.

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

A runnable application. Replaces the prior `kind: dependency` example — a
service is something the workspace runs, distinct from a stateful backing
dependency it depends on.

```yaml
# indicates that the manifest describes an executable application
kind: service

# unique service name within the workspace; cross-repo refs use this
name: auth

# optional additional group membership. If this manicest is on the top of the repo,
# it also defines he repo group membership
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
    # command prepare when starting natively
    prepare:
      cmd: "uv sync --all-extras"
    # command run when starting natively
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
  - stateful: postgres            # named stateful dep in this workspace
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


## Stateful Service Manifest

An externally provided backing dep (postgres, kafka, redis, …). Always
delegated to docker compose at v0; qavor generates and owns the compose
project (per ADR-005).

```yaml
# indicates that the manifest describes a stateful service
kind: stateful

# unique stateful name within the workspace
name: postgres

# optional additional group membership. If this manicest is on the top of the repo,
# it also defines he repo group membership
groups: [database]

# which runtimes are available; stateful deps run via docker-compose at v0
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



## Repo Manifest

Lives at the root of each repository. Carries metadata that does not belong on
a single service: how to prepare the repo, what custom tasks it exposes, and
which lifecycle hooks fire around qavor verbs.

```yaml
# indicates per-repo metadata
kind: repo

# repository identity; must match the `name` used in the project manifest
name: another-repo

# additional group memberships layered on top of project-level groups
groups: [backend]
```



## Manifest Resolution Order

When the same env key is set in multiple places, later layers win:

1. References from require dependencies:
    1.1 commmon envs from `qavor.yaml`
    1.2 native or container envs  (depending on mode)
    1.3 `.env` next to the `qavor.yaml`
    1.4 `.env.native` or `.env.container` (depending on mode), next to the `qavor.yaml`
2. Service or Stateful service:
    2.1 commmon envs from `qavor.yaml`
    2.2 native or container envs  (depending on mode)
    2.3 `.env` next to the `qavor.yaml`
    2.4 `.env.native` or `.env.container` (depending on mode), next to the `qavor.yaml`
3. Workspace `.env`
4. CLI `--env KEY=VAL`

`qavor env <service>` prints the fully-resolved value with provenance for each
key, so this chain is always inspectable.




## Profile Manifest
Profiles allow configuration reusability and can be referenced from services and stateful dependencies.
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
    # command prepare when starting natively
    prepare:
      cmd: "uv sync --all-extras"
    # command run when starting natively
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

# env layered on top of every selected service / stateful dep
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

# optional additional group membership. If this manicest is on the top of the repo,
# it also defines he repo group membership
groups: [backend]

profiles:
  - python_application

# what this service needs in order to start
require:
  - stateful: postgres            # named stateful dep in this workspace
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
