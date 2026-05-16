import path from 'node:path';

export interface WorkspacePaths {
  /** Absolute path to the workspace root (contains the kind: workspaces file). */
  root: string;
  /** Absolute path of the workspace pointer file. */
  workspacesFile: string;
  /** .qavor/ directory under the workspace root. */
  stateRoot: string;
  /** .qavor/state */
  stateDir: string;
  /** .qavor/logs */
  logsDir: string;
  /** .qavor/compose */
  composeDir: string;
  /** .qavor/cache */
  cacheDir: string;
  /** .qavor/workspace.json */
  workspaceMetaFile: string;
  /** .qavor/.gitignore */
  stateGitignore: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  const abs = path.resolve(root);
  const stateRoot = path.join(abs, '.qavor');
  return {
    root: abs,
    workspacesFile: path.join(abs, 'qavor.yaml'),
    stateRoot,
    stateDir: path.join(stateRoot, 'state'),
    logsDir: path.join(stateRoot, 'logs'),
    composeDir: path.join(stateRoot, 'compose'),
    cacheDir: path.join(stateRoot, 'cache'),
    workspaceMetaFile: path.join(stateRoot, 'workspace.json'),
    stateGitignore: path.join(stateRoot, '.gitignore'),
  };
}
