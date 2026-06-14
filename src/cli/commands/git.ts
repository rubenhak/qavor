import path from 'node:path';
import readline from 'node:readline/promises';
import type { Command } from 'commander';
import {
  gitClone,
  gitCommit,
  gitFetch,
  gitPullFastForward,
  gitPush,
  isGitRepo,
  readRepoStatus,
} from '../../git/git.js';
import type { ProjectManifest } from '../../manifest/types/index.js';
import { runFanOut } from '../../util/concurrency.js';
import { RuntimeFailure, UserError } from '../../util/exit-codes.js';
import type { Logger } from '../../util/logger.js';
import { emitJson, getLogger } from '../../util/logger.js';
import { readProjectManifest, resolveWorkspace } from '../../workspace/locate.js';
import { type ResolvedRepo, resolveRepos } from '../../workspace/repos.js';
import { inheritRootOptions, resolveExecutionPlan } from '../options.js';
import { reposPresent, selectRepos } from '../repos.js';
import { type ActionRow, createActionView } from './git-action-view.js';
import { createStatusView, type StatusRow } from './git-status-view.js';

/** Build an {@link ActionRow} from a thrown error, preserving its message tail. */
function failRow(repo: string, err: unknown): ActionRow {
  return {
    repo,
    outcome: 'fail',
    status: 'failed',
    detail: err instanceof Error ? err.message : String(err),
  };
}

/** Clone a single repo, mapping the outcome to an {@link ActionRow}. */
async function cloneOne(r: ResolvedRepo, logger: Logger): Promise<ActionRow> {
  if (r.isProjectRepo) {
    return { repo: r.name, outcome: 'ok', status: 'present', detail: 'project repo' };
  }
  if (await isGitRepo(r.dir)) {
    return { repo: r.name, outcome: 'ok', status: 'present' };
  }
  try {
    logger.info({ repo: r.name, url: r.url, dir: r.dir }, 'clone: starting');
    await gitClone({
      url: r.url,
      dest: r.dir,
      branch: r.branch,
      tag: r.tag,
      commit: r.commit,
      shallow: r.shallow,
      submodules: r.submodules,
    });
    return { repo: r.name, outcome: 'changed', status: 'cloned' };
  } catch (err) {
    if (r.optional) {
      return { repo: r.name, outcome: 'skip', status: 'skipped', detail: 'optional; clone failed' };
    }
    return failRow(r.name, err);
  }
}

async function loadProjectRepos(): Promise<{ workspaceRoot: string; repos: ResolvedRepo[] }> {
  const ws = await resolveWorkspace();
  const project = await readProjectManifest(ws.projectManifestFile);
  const repos = resolveRepos({
    workspaceRoot: ws.paths.root,
    project: project.data as unknown as ProjectManifest,
    projectRepoPath: ws.projectRepoPath,
  });
  return { workspaceRoot: ws.paths.root, repos };
}

function repoOption(c: Command): Command {
  return c.option('--repo <name...>', 'Operate on a subset of repos by name.');
}

/**
 * Read a single line from the user interactively. Prompts on stderr so stdout
 * stays reserved for command output / `--json`.
 */
async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function registerGitCommands(program: Command): void {
  const git = program.command('git').description('Per-repo git operations across the workspace.');

  repoOption(
    git.command('clone').description('Clone every repo enumerated in the project manifest.'),
  ).action(async (opts: { repo?: string[] }, cmd: Command) => {
    const root = inheritRootOptions(cmd);
    const logger = getLogger();
    const { workspaceRoot, repos } = await loadProjectRepos();
    const selected = selectRepos(repos, opts.repo);
    const plan = resolveExecutionPlan(root, 'parallel');

    const view = createActionView(
      selected.map((r) => r.name),
      { enabled: !root.json && !root.verbose, verb: 'cloning' },
    );
    const results = await runFanOut<ResolvedRepo, ActionRow>(
      selected,
      async (r, index) => {
        const row = await cloneOne(r, logger);
        view.resolve(index, row);
        return row;
      },
      plan,
    );

    if (root.json) {
      emitJson({ workspace: workspaceRoot, results });
      return;
    }
    view.finish();
    if (results.some((r) => r.outcome === 'fail')) {
      throw new RuntimeFailure('Some repos failed to clone.');
    }
  });

  repoOption(
    git.command('sync').description('Run `git fetch && git pull --ff-only` across selected repos.'),
  ).action(async (opts: { repo?: string[] }, cmd: Command) => {
    const root = inheritRootOptions(cmd);
    const { repos } = await loadProjectRepos();
    const selected = await reposPresent(selectRepos(repos, opts.repo));
    const plan = resolveExecutionPlan(root, 'parallel');
    const view = createActionView(
      selected.map((r) => r.name),
      { enabled: !root.json && !root.verbose, verb: 'syncing' },
    );
    const results = await runFanOut(
      selected,
      async (r, index): Promise<ActionRow> => {
        let row: ActionRow;
        try {
          await gitFetch(r.dir);
          await gitPullFastForward(r.dir);
          row = { repo: r.name, outcome: 'changed', status: 'synced' };
        } catch (err) {
          row = failRow(r.name, err);
        }
        view.resolve(index, row);
        return row;
      },
      plan,
    );
    if (root.json) {
      emitJson({ results });
      return;
    }
    view.finish();
    if (results.some((r) => r.outcome === 'fail')) {
      throw new RuntimeFailure('Some repos failed to sync.');
    }
  });

  repoOption(
    git.command('status').description('Aggregated repo status across selected repos.'),
  ).action(async (opts: { repo?: string[] }, cmd: Command) => {
    const root = inheritRootOptions(cmd);
    const { workspaceRoot, repos } = await loadProjectRepos();
    const selected = await reposPresent(selectRepos(repos, opts.repo));
    const plan = resolveExecutionPlan(root, 'parallel');

    // Live table on stdout: rows appear up-front with a spinner and fill in as
    // each repo's status resolves. Auto-disabled for --json, non-TTY, and
    // --verbose (where pino logs share the terminal); those fall back to a
    // single static render in `finish`.
    const view = createStatusView(
      selected.map((r) => r.name),
      { enabled: !root.json && !root.verbose },
    );
    const rows = await runFanOut(
      selected,
      async (r, index): Promise<StatusRow> => {
        const s = await readRepoStatus(r.dir);
        const row: StatusRow = {
          repo: r.name,
          branch: s.branch,
          ahead: s.ahead,
          behind: s.behind,
          dirty: s.dirtyCount,
          last_commit: s.lastCommit,
          last_commit_subject: s.lastCommitSubject,
        };
        view.resolve(index, row);
        return row;
      },
      plan,
    );
    if (root.json) {
      emitJson({ workspace: workspaceRoot, repos: rows });
      return;
    }
    view.finish();
  });

  repoOption(
    git
      .command('commit')
      .description('Stage changes and commit across selected repos.')
      .argument('[files...]', 'Specific files to stage (default: all changes).')
      .option('-m, --message <msg>', 'Commit message. Prompted for interactively if omitted.')
      .option('--allow-empty', 'Allow empty commits.')
      .option('--no-verify', 'Bypass pre-commit and commit-msg hooks.'),
  ).action(
    async (
      files: string[],
      opts: { repo?: string[]; message?: string; allowEmpty?: boolean; verify?: boolean },
      cmd: Command,
    ) => {
      const root = inheritRootOptions(cmd);
      let message = opts.message?.trim() ?? '';
      if (message.length === 0) {
        if (root.json || !process.stdin.isTTY) {
          throw new UserError(
            'Commit message required: pass -m <msg> (no interactive TTY available).',
          );
        }
        message = await promptLine('Commit message: ');
        if (message.length === 0) {
          throw new UserError('Commit message must not be empty.');
        }
      }
      const { repos } = await loadProjectRepos();
      const selected = await reposPresent(selectRepos(repos, opts.repo));
      // Commits mutate working trees and may fire pre-commit hooks that share
      // caches, so default to serial; users opt into `--parallel` explicitly.
      const plan = resolveExecutionPlan(root, 'serial');
      const view = createActionView(
        selected.map((r) => r.name),
        { enabled: !root.json && !root.verbose, verb: 'committing' },
      );
      const results = await runFanOut(
        selected,
        async (r, index): Promise<ActionRow> => {
          let row: ActionRow;
          try {
            const res = await gitCommit(r.dir, message, {
              allowEmpty: Boolean(opts.allowEmpty),
              files,
              noVerify: opts.verify === false,
            });
            row = res.committed
              ? { repo: r.name, outcome: 'changed', status: 'committed' }
              : { repo: r.name, outcome: 'skip', status: 'skipped', detail: 'nothing to commit' };
          } catch (err) {
            row = failRow(r.name, err);
          }
          view.resolve(index, row);
          return row;
        },
        plan,
      );
      if (root.json) {
        emitJson({ results });
        return;
      }
      view.finish();
      if (results.some((r) => r.outcome === 'fail')) {
        throw new RuntimeFailure('Some commits failed.');
      }
    },
  );

  repoOption(
    git.command('push').description('git push the current branch across selected repos.'),
  ).action(async (opts: { repo?: string[] }, cmd: Command) => {
    const root = inheritRootOptions(cmd);
    const { repos } = await loadProjectRepos();
    const selected = await reposPresent(selectRepos(repos, opts.repo));
    const plan = resolveExecutionPlan(root, 'parallel');
    const view = createActionView(
      selected.map((r) => r.name),
      { enabled: !root.json && !root.verbose, verb: 'pushing' },
    );
    const results = await runFanOut(
      selected,
      async (r, index): Promise<ActionRow> => {
        let row: ActionRow;
        try {
          await gitPush(r.dir);
          row = { repo: r.name, outcome: 'changed', status: 'pushed' };
        } catch (err) {
          row = failRow(r.name, err);
        }
        view.resolve(index, row);
        return row;
      },
      plan,
    );
    if (root.json) {
      emitJson({ results });
      return;
    }
    view.finish();
    if (results.some((r) => r.outcome === 'fail')) {
      throw new RuntimeFailure('Some pushes failed.');
    }
  });

  // ensure `path` import used
  void path;
}
