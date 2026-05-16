import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { readJsonFile } from '../../util/fs.js';
import { emit, emitJson } from '../../util/logger.js';
import { readProjectManifest, resolveWorkspace } from '../../workspace/locate.js';
import { inheritRootOptions } from '../options.js';

export function registerWorkspace(program: Command): void {
  const ws = program.command('workspace').description('Workspace operations.');
  ws.command('info')
    .description('Show information about the workspace at or above the cwd.')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const resolved = await resolveWorkspace();
      const project = await readProjectManifest(resolved.projectManifestFile);
      let meta: Record<string, unknown> = {};
      try {
        meta = await readJsonFile(resolved.paths.workspaceMetaFile);
      } catch {
        /* missing meta is fine */
      }
      const info = {
        workspace_root: resolved.paths.root,
        workspaces_file: resolved.paths.workspacesFile,
        project_repo_path: resolved.projectRepoPath,
        project_manifest_file: resolved.projectManifestFile,
        project_name: typeof project.data.name === 'string' ? project.data.name : null,
        state_dir: resolved.paths.stateRoot,
        meta,
      };
      if (root.json) {
        emitJson(info);
        return;
      }
      emit(`Workspace root:        ${info.workspace_root}`);
      emit(`Workspaces manifest:   ${path.relative(info.workspace_root, info.workspaces_file)}`);
      emit(`Project repo path:     ${path.relative(info.workspace_root, info.project_repo_path)}`);
      emit(
        `Project manifest:      ${path.relative(info.workspace_root, info.project_manifest_file)}`,
      );
      emit(`Project name:          ${info.project_name ?? '<unknown>'}`);
      emit(`State directory:       ${path.relative(info.workspace_root, info.state_dir)}`);
      if (Object.keys(meta).length > 0) {
        emit('Workspace meta:');
        for (const [k, v] of Object.entries(meta))
          emit(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      }
      // Touch fs so tests using stat the meta file exit cleanly.
      try {
        await fs.access(resolved.paths.workspaceMetaFile);
      } catch {
        /* ignore */
      }
    });
}
