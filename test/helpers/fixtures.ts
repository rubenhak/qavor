import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '..', '..');
export const fixturesDir = path.join(repoRoot, 'testdata', 'fixtures');

export async function makeTempDir(prefix = 'qavor-test-'): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return base;
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.cp(src, dst, { recursive: true });
}

/**
 * Initialize a directory as a git repo (one commit on `main`) with the
 * given fixture files copied in.
 */
export async function makeGitRepo(targetDir: string, fixture: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const src = path.join(fixturesDir, fixture);
  await copyDir(src, targetDir);
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: targetDir });
  await execa('git', ['config', 'user.email', 'qavor-test@example.com'], { cwd: targetDir });
  await execa('git', ['config', 'user.name', 'Qavor Test'], { cwd: targetDir });
  await execa('git', ['add', '-A'], { cwd: targetDir });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: targetDir });
}

/** Initialize an empty git repo (useful for clone targets). */
export async function makeEmptyGitRepo(targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: targetDir });
  await execa('git', ['config', 'user.email', 'qavor-test@example.com'], { cwd: targetDir });
  await execa('git', ['config', 'user.name', 'Qavor Test'], { cwd: targetDir });
}

/**
 * Build a fixture set of repos in a temp dir. Returns absolute paths to the
 * generated source-of-truth git repos (to be cloned via file://).
 */
export interface FixtureRepos {
  base: string;
  projectRepo: string;
  serviceRepos: Record<string, string>;
}

export async function buildFixtureRepos(
  opts: {
    /** Filter set of services to include (default all). */
    services?: string[];
  } = {},
): Promise<FixtureRepos> {
  const base = await makeTempDir('qavor-srcrepos-');
  const allServices = ['web', 'auth', 'notes'];
  const wanted = opts.services ?? allServices;
  const serviceRepos: Record<string, string> = {};
  for (const svc of wanted) {
    const target = path.join(base, `${svc}-src.git`);
    await makeGitRepo(target, svc);
    serviceRepos[svc] = target;
  }
  // Build a project manifest with explicit file:// urls per entry so
  // clones are hermetic (no network, no missing root_url).
  const projectRepo = path.join(base, 'project-repo.git');
  await makeGitRepo(projectRepo, 'project-repo');
  const repos = wanted
    .map((name) => `  - name: ${name}\n    url: ${fileUrl(serviceRepos[name]!)}`)
    .join('\n');
  const yaml = `kind: project\nname: acme-platform\ngit:\n  default_branch: main\nrepositories:\n${repos}\n`;
  await fs.writeFile(path.join(projectRepo, 'qavor.yaml'), yaml);
  await execa('git', ['add', '-A'], { cwd: projectRepo });
  await execa('git', ['commit', '-q', '-m', 'wire urls'], { cwd: projectRepo });
  return { base, projectRepo, serviceRepos };
}

export function fileUrl(absPath: string): string {
  return `file://${absPath}`;
}

/**
 * Run the qavor CLI in-process via tsx. Returns stdout/stderr/exit.
 */
export async function runCli(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> } = { cwd: process.cwd() },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const entry = path.join(repoRoot, 'src', 'index.ts');
  const tsxLoader = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const tsxLoaderUrl = `file://${tsxLoader}`;
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') baseEnv[k] = v;
  // Pin a git identity so commits are hermetic: cloned workspace repos have no
  // local user.name/user.email, and CI machines have no global git config, so
  // `git commit` would otherwise fail with exit 128. Locally this is masked by
  // the developer's global config.
  const gitIdentity: Record<string, string> = {
    GIT_AUTHOR_NAME: 'Qavor Test',
    GIT_AUTHOR_EMAIL: 'qavor-test@example.com',
    GIT_COMMITTER_NAME: 'Qavor Test',
    GIT_COMMITTER_EMAIL: 'qavor-test@example.com',
  };
  const env = { ...baseEnv, ...gitIdentity, ...(opts.env ?? {}) };
  const res = await execa(
    process.execPath,
    ['--no-warnings', '--import', tsxLoaderUrl, entry, ...args],
    {
      cwd: opts.cwd,
      env,
      reject: false,
    },
  );
  const stdout = typeof res.stdout === 'string' ? res.stdout : '';
  const stderr = typeof res.stderr === 'string' ? res.stderr : '';
  return { stdout, stderr, exitCode: res.exitCode ?? -1 };
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
