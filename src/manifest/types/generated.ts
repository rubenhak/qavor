/* eslint-disable */
// AUTO-GENERATED — do not edit by hand.
// Source: docs/schemas/*.json
// Regenerate with `pnpm gen:types`.
export type QavorManifest =
  | WorkspacesManifest
  | ProjectManifest
  | ServiceManifest
  | ProfileManifest;
/**
 * Manifest schema version. Defaults to 1 if omitted.
 */
export type SchemaVersion = 1;
/**
 * Lowercase identifier. Letters, digits, dot, dash, underscore. 1-63 chars. Used as service/profile/repo/group identifiers.
 */
export type Name = string;
export type ProjectRepoEntry = {
  [k: string]: unknown | undefined;
} & {
  name: Name;
  /**
   * Explicit git URL. Overrides URL derivation from `git.root_url` + `git.repo_prefix`.
   */
  url?: string;
  branch?: string;
  tag?: string;
  commit?: string;
  /**
   * Workspace-relative clone path. Defaults to `./<name>` (or `./<name>.git` to match the conventional layout).
   */
  path?: string;
  /**
   * Inline group memberships in addition to the top-level `groups` map.
   */
  groups?: Name[];
  shallow?: boolean;
  submodules?: boolean;
  /**
   * Skip rather than fail if cloning is not authorized.
   */
  optional?: boolean;
};
/**
 * A runtime step value: either a single step object, or a list of step objects run in sequence. Each list entry is a full step (its own `cmd`/`cwd`/`env`/`shell`); steps run in declaration order and the first non-zero exit aborts the rest. The single-object form (`prepare: { cmd: "…" }`) and the list form (`prepare: [{ cmd: "…" }, { cmd: "…" }]`) are interchangeable. `run` accepts only a single step.
 */
export type RuntimeStepOrList = RuntimeStep | [RuntimeStep, ...RuntimeStep[]];
/**
 * Scalar value usable on the right-hand side of an env entry. Strings support ${VAR} and ${secret:NAME} interpolation.
 */
export type EnvScalar = string | number | boolean;
/**
 * A single dependency edge. Exactly one of `service` or `group` must be set. Backing services (postgres, kafka, …) are referenced the same way as any other service.
 */
export type Requirement = {
  /**
   * Service reference. `<service>` for same-workspace, `<repo>:<service>` permitted.
   */
  service?: string;
  group?: Name;
  optional?: boolean;
  /**
   * Optional gating expression. Examples: `mode == 'docker'`, `profile == 'dev'`, `os == 'darwin'`.
   */
  condition?: string;
  /**
   * Whether to wait for process-up or for the readiness probe to pass before starting dependents.
   */
  waitFor?: 'start' | 'ready';
} & Requirement1;
export type Requirement1 = {
  [k: string]: unknown | undefined;
};
/**
 * One or more shell commands or paths to executable scripts, run in the manifest's directory.
 */
export type HookCommands = string | [string, ...string[]];

/**
 * Workspace pointer file. Lives at the root of the workspace directory as `qavor.yaml` and is created automatically by `qavor init`. Its only job is to point at the project repo whose `kind: project` manifest enumerates the rest of the workspace.
 */
export interface WorkspacesManifest {
  kind: 'workspaces';
  schemaVersion?: SchemaVersion;
  /**
   * Workspace-relative path to the directory containing the project repo's `qavor.yaml` (kind: project).
   */
  root_project_path: string;
}
/**
 * Project-level manifest. Lives at the root of the project repo as `qavor.yaml`. Defines workspace identity and is the single source of truth for the list of repos that make up the workspace. No other manifest kind contributes to the repo set.
 */
export interface ProjectManifest {
  kind: 'project';
  schemaVersion?: SchemaVersion;
  name: Name;
  description?: string;
  git?: {
    /**
     * Base git URL for repos in this project. Combined with `repo_prefix` and a repo `name` to derive the clone URL when no explicit `url` is given.
     */
    root_url?: string;
    /**
     * Optional prefix prepended to repo names when deriving clone URLs.
     */
    repo_prefix?: string;
    /**
     * Default branch used when a repo entry does not pin its own.
     */
    default_branch?: string;
    /**
     * Hint for clone URL form when `root_url` is a host instead of a full URL.
     */
    remote?: 'ssh' | 'https';
    shallow?: boolean;
    submodules?: boolean;
  };
  /**
   * Named groups of repo names. A repo may appear in multiple groups.
   */
  groups?: {
    /**
     * @minItems 1
     *
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[a-z0-9][a-z0-9._-]{0,62}$".
     */
    [k: string]: [Name, ...Name[]];
  };
  /**
   * The complete, authoritative list of repos that compose the workspace. This is the only place the repo set is declared. Each entry is either a bare name (URL derived from `git.root_url` + `git.repo_prefix` + name) or an object with explicit fields.
   *
   * @minItems 1
   */
  repositories: [Name | ProjectRepoEntry, ...(Name | ProjectRepoEntry)[]];
}
/**
 * Runnable application: how to build and execute an app. This single kind covers both first-party apps (built and run natively or in a container) and externally provided backing dependencies such as postgres/kafka/redis (typically run via `docker-compose` per ADR-005, exposing a `env.publish` contract to dependents). Lives at the root of a single-service repo as `qavor.yaml`, or under a sub-directory of a multi-service repo (e.g. `service-foo/qavor.yaml`). A service manifest never defines the workspace repo set — the list of repositories comes solely from the `kind: project` manifest's `repositories:` list.
 */
export interface ServiceManifest {
  kind: 'service';
  schemaVersion?: SchemaVersion;
  name: Name;
  description?: string;
  /**
   * Additional group memberships for this service.
   */
  groups?: Name[];
  /**
   * Profiles applied to this service in declaration order. Profile values are layered first; this manifest's own `runtime` and `env` are merged on top.
   */
  profiles?: Name[];
  runtime?: RuntimeBlock;
  /**
   * Default run mode for this service. Overridable per invocation via `--mode`. Must match a backend whose `enabled: true` is set on this service or one of its profiles. Backing services typically use `docker-compose`.
   */
  mode?: 'native' | 'docker' | 'docker-compose';
  /**
   * Dependencies that must be running before this service starts.
   */
  require?: Requirement[];
  env?: EnvBlock;
  hooks?: Hooks;
}
/**
 * Available runtime backends. A service manifest may declare any subset; the active backend is chosen by the resolved `mode`.
 */
export interface RuntimeBlock {
  native?: RuntimeBackend;
  docker?: RuntimeBackend;
  'docker-compose'?: RuntimeBackend;
}
/**
 * Runtime backend definition. A small set of keys is reserved for the start lifecycle: `enabled` (gate), `check_installed` + `install` (installation — install runs only when check_installed fails), and `run` (the long-lived process started by `qavor up`; `run` takes a single step). Every *other* key is a user-defined command — a named shell step (or list of steps) discovered and run on demand by `qavor <command>` (e.g. `prepare`, `update_libraries`, `lint`, `test`, `migrate`). qavor assumes no fixed command set: any command declared here is runnable, fanned out across the services that define it. Each command accepts a single step or a list of steps run in declaration order; the first non-zero exit aborts the rest.
 */
export interface RuntimeBackend {
  enabled?: boolean;
  check_installed?: RuntimeStepOrList;
  install?: RuntimeStepOrList;
  run?: RuntimeStepOrList;
}
/**
 * Single shell step in a runtime backend entry (`run`, `check_installed`, `install`, or any user-defined command such as `prepare`).
 */
export interface RuntimeStep {
  /**
   * Shell command. Multiline strings are treated as a script.
   */
  cmd: string;
  /**
   * Working directory relative to the manifest file.
   */
  cwd?: string;
  env?: EnvMap;
  /**
   * Override shell. Defaults to `/bin/sh -c` (POSIX) or `cmd /C` on Windows.
   */
  shell?: string;
}
/**
 * Map of env names to scalar values or long-form envSpec entries.
 */
export interface EnvMap {
  /**
   * This interface was referenced by `EnvMap`'s JSON-Schema definition
   * via the `patternProperty` "^[A-Z_][A-Z0-9_]*$".
   */
  [k: string]: EnvScalar | EnvSpec;
}
/**
 * Long-form env entry. Use when you need typing, validation, default vs override, secret marking, or documentation.
 */
export interface EnvSpec {
  value?: EnvScalar;
  default?: EnvScalar;
  required?: boolean;
  type?: 'string' | 'int' | 'number' | 'bool' | 'url' | 'duration';
  pattern?: string;
  secret?: boolean;
  description?: string;
}
/**
 * Layered env block. `common` always applies; `native` or `docker` is layered on top depending on the active run mode. `publish` (optional) is the explicit contract a backing service exposes to its dependents at start time — when present, dependents receive only the published keys instead of the service's full composed env. See the proposal section on Manifest Resolution Order for the full precedence chain.
 */
export interface EnvBlock {
  common?: EnvMap;
  native?: EnvMap;
  docker?: EnvMap;
  publish?: EnvMap;
}
/**
 * Lifecycle hooks. Each hook list runs in the manifest's directory at the corresponding lifecycle event. `pre_command`/`post_command` fire around every user-defined `qavor <command>` run; the running command name is exposed to the hook script via the `QAVOR_COMMAND` environment variable so a single hook pair can branch per command.
 */
export interface Hooks {
  pre_clone?: HookCommands;
  post_clone?: HookCommands;
  pre_command?: HookCommands;
  post_command?: HookCommands;
  pre_run?: HookCommands;
  post_run?: HookCommands;
  pre_stop?: HookCommands;
  post_stop?: HookCommands;
}
/**
 * Reusable runtime + env bundle. Referenced by service manifests via the `profiles:` list. Profiles can themselves reference other profiles; resolution flattens the chain in declaration order with later entries winning. A profile's runtime/env layer below the referencing manifest's own runtime/env.
 */
export interface ProfileManifest {
  kind: 'profile';
  schemaVersion?: SchemaVersion;
  name: Name;
  description?: string;
  /**
   * Other profiles this one extends. Resolved in declaration order before this profile's own values are applied.
   */
  profiles?: Name[];
  runtime?: RuntimeBlock;
  mode?: 'native' | 'docker' | 'docker-compose';
  env?: EnvBlock;
}
