import path from 'node:path';
import readline from 'node:readline/promises';
import type { Command } from 'commander';
import pMap from 'p-map';
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
import { resolveJobs } from '../../util/concurrency.js';
import { RuntimeFailure, UserError } from '../../util/exit-codes.js';
import { emit, emitJson, getLogger } from '../../util/logger.js';
import { readProjectManifest, resolveWorkspace } from '../../workspace/locate.js';
import { type ResolvedRepo, resolveRepos } from '../../workspace/repos.js';
import { inheritRootOptions } from '../options.js';
import { reposPresent, selectRepos } from '../repos.js';

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
    const jobs = resolveJobs(root.jobs);

    const results: {
      repo: string;
      status: 'cloned' | 'present' | 'skipped' | 'failed';
      message?: string;
    }[] = [];
    await pMap(
      selected,
      async (r) => {
        if (r.isProjectRepo) {
          results.push({
            repo: r.name,
            status: 'present',
            message: 'project repo (already cloned)',
          });
          return;
        }
        if (await isGitRepo(r.dir)) {
          results.push({ repo: r.name, status: 'present' });
          return;
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
          results.push({ repo: r.name, status: 'cloned' });
        } catch (err) {
          if (r.optional) {
            results.push({ repo: r.name, status: 'skipped', message: 'optional; clone failed' });
          } else {
            throw new RuntimeFailure(
              `Clone failed for ${r.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      },
      { concurrency: jobs },
    );

    if (root.json) {
      emitJson({ workspace: workspaceRoot, results });
      return;
    }
    for (const r of results) {
      emit(`${r.status.padEnd(8)} ${r.repo}${r.message ? `  — ${r.message}` : ''}`);
    }
  });

  repoOption(
    git.command('sync').description('Run `git fetch && git pull --ff-only` across selected repos.'),
  ).action(async (opts: { repo?: string[] }, cmd: Command) => {
    const root = inheritRootOptions(cmd);
    const { repos } = await loadProjectRepos();
    const selected = await reposPresent(selectRepos(repos, opts.repo));
    const jobs = resolveJobs(root.jobs);
    const results: { repo: string; ok: boolean; error?: string }[] = [];
    await pMap(
      selected,
      async (r) => {
        try {
          await gitFetch(r.dir);
          await gitPullFastForward(r.dir);
          results.push({ repo: r.name, ok: true });
        } catch (err) {
          results.push({
            repo: r.name,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
      { concurrency: jobs },
    );
    if (root.json) {
      emitJson({ results });
      return;
    }
    for (const r of results)
      emit(`${r.ok ? 'ok  ' : 'fail'} ${r.repo}${r.error ? `  — ${r.error}` : ''}`);
    if (results.some((r) => !r.ok)) throw new RuntimeFailure('Some repos failed to sync.');
  });

  repoOption(
    git.command('status').description('Aggregated repo status across selected repos.'),
  ).action(async (opts: { repo?: string[] }, cmd: Command) => {
    const root = inheritRootOptions(cmd);
    const { workspaceRoot, repos } = await loadProjectRepos();
    const selected = await reposPresent(selectRepos(repos, opts.repo));
    const jobs = resolveJobs(root.jobs);
    type Row = {
      repo: string;
      branch: string | null;
      ahead: number;
      behind: number;
      dirty: number;
      last_commit: string | null;
      last_commit_subject: string | null;
    };
    const rows = await pMap(
      selected,
      async (r): Promise<Row> => {
        const s = await readRepoStatus(r.dir);
        return {
          repo: r.name,
          branch: s.branch,
          ahead: s.ahead,
          behind: s.behind,
          dirty: s.dirtyCount,
          last_commit: s.lastCommit,
          last_commit_subject: s.lastCommitSubject,
        };
      },
      { concurrency: jobs },
    );
    if (root.json) {
      emitJson({ workspace: workspaceRoot, repos: rows });
      return;
    }
    // simple table
    const headers = ['REPO', 'BRANCH', 'AHEAD', 'BEHIND', 'DIRTY', 'COMMIT', 'SUBJECT'];
    const data = rows.map((r) => [
      r.repo,
      r.branch ?? '-',
      String(r.ahead),
      String(r.behind),
      String(r.dirty),
      r.last_commit ?? '-',
      (r.last_commit_subject ?? '').split('\n')[0]?.slice(0, 60) ?? '',
    ]);
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...data.map((row) => (row[i] ?? '').length)),
    );
    const fmt = (row: string[]): string => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
    emit(fmt(headers));
    for (const row of data) emit(fmt(row));
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
      const jobs = resolveJobs(root.jobs);
      const results: { repo: string; committed: boolean; error?: string }[] = [];
      await pMap(
        selected,
        async (r) => {
          try {
            const res = await gitCommit(r.dir, message, {
              allowEmpty: Boolean(opts.allowEmpty),
              files,
              noVerify: opts.verify === false,
            });
            results.push({ repo: r.name, committed: res.committed });
          } catch (err) {
            results.push({
              repo: r.name,
              committed: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
        { concurrency: jobs },
      );
      if (root.json) {
        emitJson({ results });
        return;
      }
      for (const r of results) {
        const verb = r.committed ? 'committed' : r.error ? 'failed' : 'skipped';
        emit(`${verb.padEnd(10)} ${r.repo}${r.error ? `  — ${r.error}` : ''}`);
      }
      if (results.some((r) => r.error)) throw new RuntimeFailure('Some commits failed.');
    },
  );

  repoOption(
    git.command('push').description('git push the current branch across selected repos.'),
  ).action(async (opts: { repo?: string[] }, cmd: Command) => {
    const root = inheritRootOptions(cmd);
    const { repos } = await loadProjectRepos();
    const selected = await reposPresent(selectRepos(repos, opts.repo));
    const jobs = resolveJobs(root.jobs);
    const results: { repo: string; ok: boolean; error?: string }[] = [];
    await pMap(
      selected,
      async (r) => {
        try {
          await gitPush(r.dir);
          results.push({ repo: r.name, ok: true });
        } catch (err) {
          results.push({
            repo: r.name,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
      { concurrency: jobs },
    );
    if (root.json) {
      emitJson({ results });
      return;
    }
    for (const r of results)
      emit(`${r.ok ? 'ok  ' : 'fail'} ${r.repo}${r.error ? `  — ${r.error}` : ''}`);
    if (results.some((r) => !r.ok)) throw new RuntimeFailure('Some pushes failed.');
  });

  // ensure `path` import used
  void path;
}
