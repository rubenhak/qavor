import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { buildFixtureRepos, cleanup, makeTempDir, runCli } from './helpers/fixtures.js';

test('qavor clone: clones the repos listed in the project manifest', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-clone-');
  try {
    const init = await runCli(['init', fixtures.projectRepo, '--into', ws]);
    assert.equal(init.exitCode, 0, `init failed: ${init.stderr}`);
    const clone = await runCli(['git', 'clone'], { cwd: ws });
    assert.equal(clone.exitCode, 0, `clone failed: ${clone.stderr}`);
    const webStat = await fs.stat(path.join(ws, 'web.git'));
    const authStat = await fs.stat(path.join(ws, 'auth.git'));
    assert.ok(webStat.isDirectory());
    assert.ok(authStat.isDirectory());
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor status: reports per-repo branch + dirty count', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-status-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    // dirty the web repo
    await fs.writeFile(path.join(ws, 'web.git', 'extra.txt'), 'hello');
    const status = await runCli(['git', 'status', '--json'], { cwd: ws });
    assert.equal(status.exitCode, 0, `status failed: ${status.stderr}`);
    const parsed = JSON.parse(status.stdout);
    const web = parsed.repos.find((r: { repo: string }) => r.repo === 'web');
    assert.ok(web, 'expected web entry');
    assert.equal(web.dirty, 1);
    assert.equal(web.branch, 'main');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor status: human output renders a table + summary footer (ASCII fallback, no TTY)', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-status-human-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    await fs.writeFile(path.join(ws, 'web.git', 'extra.txt'), 'hello');
    // Pin color off so the assertion is deterministic regardless of the outer
    // environment: `colorEnabled()` honors FORCE_COLOR ahead of TTY status, so
    // a CI/dev shell with FORCE_COLOR set would otherwise colorize this piped
    // run. FORCE_COLOR='0' disables the force; NO_COLOR pins it off.
    const status = await runCli(['git', 'status'], {
      cwd: ws,
      env: { NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    assert.equal(status.exitCode, 0, `status failed: ${status.stderr}`);
    // Non-TTY + NO_COLOR: no ANSI escapes, ASCII glyphs only.
    assert.ok(!status.stdout.includes('\u001b['), 'piped output must not contain ANSI escapes');
    assert.match(status.stdout, /REPO\s+BRANCH\s+SYNC\s+CHANGES\s+COMMIT\s+SUBJECT/);
    assert.match(status.stdout, /\bweb\b.*\bmain\b/);
    // Dirty repo shows the ASCII dirty glyph + count and the summary tallies it.
    assert.match(status.stdout, /Summary:.*1 repo.*1 dirty/s);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor status: reports repos listed in the manifest but not cloned as missing', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-status-missing-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    // Clone only web; auth stays missing.
    await runCli(['git', 'clone', '--repo', 'web'], { cwd: ws });
    const status = await runCli(['git', 'status', '--json'], { cwd: ws });
    assert.equal(status.exitCode, 0, `status failed: ${status.stderr}`);
    const parsed = JSON.parse(status.stdout);
    const web = parsed.repos.find((r: { repo: string }) => r.repo === 'web');
    const auth = parsed.repos.find((r: { repo: string }) => r.repo === 'auth');
    assert.ok(web, 'expected web entry');
    assert.ok(auth, 'expected auth entry even though it is not cloned');
    assert.equal(web.missing, false);
    assert.equal(auth.missing, true);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor status: human output marks missing repos and tallies them in the summary', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-status-missing-human-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone', '--repo', 'web'], { cwd: ws });
    const status = await runCli(['git', 'status'], {
      cwd: ws,
      env: { NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    assert.equal(status.exitCode, 0, `status failed: ${status.stderr}`);
    assert.match(status.stdout, /\bauth\b.*not cloned/);
    assert.match(status.stdout, /Summary:.*1 missing/s);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor git sync: clones repos that are missing from the workspace', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-sync-clone-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    // Clone only web; sync should clone the missing auth repo.
    await runCli(['git', 'clone', '--repo', 'web'], { cwd: ws });
    let authExists = true;
    try {
      await fs.stat(path.join(ws, 'auth.git'));
    } catch {
      authExists = false;
    }
    assert.equal(authExists, false, 'auth.git should not exist before sync');

    const sync = await runCli(['git', 'sync'], { cwd: ws });
    assert.equal(sync.exitCode, 0, `sync failed: ${sync.stderr}`);
    const authStat = await fs.stat(path.join(ws, 'auth.git'));
    assert.ok(authStat.isDirectory(), 'sync should have cloned auth.git');

    const status = await runCli(['git', 'status', '--json'], { cwd: ws });
    const parsed = JSON.parse(status.stdout);
    const auth = parsed.repos.find((r: { repo: string }) => r.repo === 'auth');
    assert.equal(auth.missing, false, 'auth should be present after sync');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor git commit: stages and commits with -m across repos', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-commit-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    await fs.writeFile(path.join(ws, 'web.git', 'extra.txt'), 'hello');
    const commit = await runCli(['git', 'commit', '-m', 'add extra'], { cwd: ws });
    assert.equal(commit.exitCode, 0, `commit failed: ${commit.stderr}`);
    const status = await runCli(['git', 'status', '--json'], { cwd: ws });
    const parsed = JSON.parse(status.stdout);
    const web = parsed.repos.find((r: { repo: string }) => r.repo === 'web');
    assert.equal(web.dirty, 0, 'expected clean tree after commit');
    assert.equal(web.last_commit_subject?.trim(), 'add extra');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor git commit: only stages the named files', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-commit-files-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    await fs.writeFile(path.join(ws, 'web.git', 'staged.txt'), 'a');
    await fs.writeFile(path.join(ws, 'web.git', 'untouched.txt'), 'b');
    const commit = await runCli(['git', 'commit', '-m', 'partial', 'staged.txt'], { cwd: ws });
    assert.equal(commit.exitCode, 0, `commit failed: ${commit.stderr}`);
    const status = await runCli(['git', 'status', '--json'], { cwd: ws });
    const parsed = JSON.parse(status.stdout);
    const web = parsed.repos.find((r: { repo: string }) => r.repo === 'web');
    assert.equal(web.dirty, 1, 'untouched.txt should remain unstaged');
    assert.equal(web.last_commit_subject?.trim(), 'partial');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor git commit: --no-verify bypasses a failing pre-commit hook', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-commit-noverify-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    const hook = path.join(ws, 'web.git', '.git', 'hooks', 'pre-commit');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await fs.writeFile(path.join(ws, 'web.git', 'extra.txt'), 'hello');

    const blocked = await runCli(['git', 'commit', '-m', 'blocked'], { cwd: ws });
    assert.equal(blocked.exitCode, 3, 'pre-commit hook should block the commit');

    const ok = await runCli(['git', 'commit', '-m', 'bypassed', '--no-verify'], { cwd: ws });
    assert.equal(ok.exitCode, 0, `--no-verify commit failed: ${ok.stderr}`);
    const status = await runCli(['git', 'status', '--json'], { cwd: ws });
    const parsed = JSON.parse(status.stdout);
    const web = parsed.repos.find((r: { repo: string }) => r.repo === 'web');
    assert.equal(web.dirty, 0, 'expected clean tree after --no-verify commit');
    assert.equal(web.last_commit_subject?.trim(), 'bypassed');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor git commit: errors when message omitted with no TTY', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web'] });
  const ws = await makeTempDir('qavor-commit-notty-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });
    await fs.writeFile(path.join(ws, 'web.git', 'extra.txt'), 'hello');
    const commit = await runCli(['git', 'commit'], { cwd: ws });
    assert.equal(commit.exitCode, 1, 'expected user-error exit code');
    assert.match(commit.stderr, /Commit message required/);
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor clone: --repo selector clones only the requested repo', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-clone-sel-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    const r = await runCli(['git', 'clone', '--repo', 'web'], { cwd: ws });
    assert.equal(r.exitCode, 0, `selective clone failed: ${r.stderr}`);
    await fs.stat(path.join(ws, 'web.git'));
    let authExists = true;
    try {
      await fs.stat(path.join(ws, 'auth.git'));
    } catch {
      authExists = false;
    }
    assert.equal(authExists, false, 'auth.git should not have been cloned');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
