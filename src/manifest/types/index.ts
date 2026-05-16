export type {
  QavorManifest,
  WorkspacesManifest,
  ProjectManifest,
  RepoManifest,
  ServiceManifest,
  StatefulManifest,
  ProfileManifest,
  ProjectRepoEntry,
  Requirement,
  Hooks,
  HookCommands,
  EnvBlock,
  StatefulEnvBlock,
  EnvMap,
  EnvSpec,
  EnvScalar,
  RuntimeBlock,
  RuntimeBackend,
  RuntimeStep,
} from './generated.js';

/**
 * Discriminator helper. Useful in switch statements when narrowing a
 * QavorManifest by `kind:`.
 */
export type ManifestKind =
  | 'workspaces'
  | 'project'
  | 'repo'
  | 'service'
  | 'stateful'
  | 'profile';
