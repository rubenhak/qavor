export type {
  QavorManifest,
  WorkspacesManifest,
  ProjectManifest,
  ServiceManifest,
  ProfileManifest,
  ProfileRef,
  ProfileSource,
  ProfileSourceUri,
  ProfileAuth,
  ProjectRepoEntry,
  Requirement,
  Hooks,
  HookCommands,
  EnvBlock,
  EnvMap,
  EnvSpec,
  EnvScalar,
  RuntimeBlock,
  RuntimeBackend,
  RuntimeStep,
  RuntimeStepOrList,
  CmdStep,
  ComposeStep,
  DockerStep,
} from './generated.js';

/**
 * Discriminator helper. Useful in switch statements when narrowing a
 * QavorManifest by `kind:`.
 */
export type ManifestKind = 'workspaces' | 'project' | 'service' | 'profile';
