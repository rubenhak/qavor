---
name: verify
description: Build and drive the qavor CLI end-to-end against a real workspace to verify changes at the CLI surface.
---

# Verifying qavor changes

qavor is a CLI; its surface is the terminal. Verify by running the freshly
built binary against a real workspace — not by re-running tests.

## Build + run handle

```bash
./prepare.sh                 # pnpm install + build → dist/index.js (rebuild after every src change)
./run.sh <args>              # exec dist/index.js; safe from any cwd
# or directly: node /path/to/qavor.git/dist/index.js <args>
```

## Workspaces to drive against

- **Standalone scratch workspace (fastest, no repos to clone):** a dir with
  `qavor.yaml` = `kind: project` + `standalone: true`, and service manifests in
  subdirs (scanned to depth 5). Bootstrapped lazily on first command — no
  `qavor init` needed. Good for exercising one template in isolation.
- **Real multi-repo:** `/Users/rubenhak/repos/kubevious` (project repo at
  `workspace.git/`). Manifests in `workspace.git/<subdir>/qavor.yaml` are
  discovered. Leave no untracked files behind — it's a real git repo.

`cd`-ing into a workspace before `node …/dist/index.js` works; the shell cwd is
reset after each Bash call, so cd in the same command.

## Library / backing-service recipe (verified working)

Stub referencing a template by **directory** source, non-default instance+port:

```yaml
kind: service
name: postgresql
profiles:
  - file:///Users/rubenhak/repos/personal/qavor.git/library/postgresql
env:
  common: { POSTGRES_INSTANCE: verify, POSTGRES_PORT: 5433 }
```

Drive (fan-out output needs BOTH `--serial` and `--verbose`):

```bash
node …/dist/index.js commands                              # verbs registered?
node …/dist/index.js up --serial --verbose                 # healthcheck-gated
docker ps --filter name=qavor-pg-verify                    # running + healthy?
node …/dist/index.js up --serial --verbose                 # idempotent no-op
node …/dist/index.js status --serial --verbose
# seed a row, down, up → row survives (volume kept); purge → volume gone
node …/dist/index.js down --serial --verbose
node …/dist/index.js purge --serial --verbose
```

Fail-closed check: a declarative step with an undefined `${VAR}` exits 3 with
`Unresolved ${...}`.

## Cleanup

- `docker rm -f` any `qavor-*` containers the run created.
- `docker volume rm` any `qavor-*_data` volumes.
- `docker network rm qavor` if this run created the shared network and nothing
  else uses it.
- Remove scratch workspace dirs / any stub subdir added to a real repo.
- Remote caches live under `~/.cache/qavor/`; `file://` dir sources read in
  place (no cache). After editing a template consumed via git/github, add
  `--refresh`.
