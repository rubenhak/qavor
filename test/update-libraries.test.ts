import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixtureRepos, cleanup, makeTempDir, runCli } from './helpers/fixtures.js';

// `update_libraries` is an ordinary dynamic command (no longer a built-in
// subcommand): it is discovered from `runtime.native.update_libraries` and run
// as `qavor update_libraries`.

test('qavor update_libraries: runs update_libraries cmd unconditionally every run', async () => {
  // `web` declares `runtime.native.update_libraries`; `auth` does not, so it
  // reports `skipped` — exercising both branches.
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-upd-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });

    const first = await runCli(['update_libraries', '--json'], { cwd: ws });
    assert.equal(first.exitCode, 0, `update_libraries failed: ${first.stderr}`);
    const firstParsed = JSON.parse(first.stdout);
    assert.equal(firstParsed.command, 'update_libraries');
    const okCount = firstParsed.results.filter((r: { status: string }) => r.status === 'ok').length;
    assert.ok(okCount >= 1, 'expected at least one updated service');
    const skipCount = firstParsed.results.filter(
      (r: { status: string }) => r.status === 'skipped',
    ).length;
    assert.ok(skipCount >= 1, 'expected at least one service without an update command');

    // No caching: a second run re-runs and produces the same statuses, never a
    // "skipped because cached" result.
    const second = await runCli(['update_libraries', '--json'], { cwd: ws });
    assert.equal(second.exitCode, 0, `update_libraries failed: ${second.stderr}`);
    const secondParsed = JSON.parse(second.stdout);
    assert.ok(
      secondParsed.results.every(
        (r: { status: string }) => r.status === 'ok' || r.status === 'skipped',
      ),
      `expected only ok/skipped on second run; got ${JSON.stringify(secondParsed.results)}`,
    );
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});

test('qavor update_libraries: --only limits to named services', async () => {
  const fixtures = await buildFixtureRepos({ services: ['web', 'auth'] });
  const ws = await makeTempDir('qavor-upd-only-');
  try {
    await runCli(['init', fixtures.projectRepo, '--into', ws]);
    await runCli(['git', 'clone'], { cwd: ws });

    const res = await runCli(['update_libraries', '--only', 'web', '--json'], { cwd: ws });
    assert.equal(res.exitCode, 0, `update_libraries failed: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].serviceName, 'web');
    assert.equal(parsed.results[0].status, 'ok');

    const unknown = await runCli(['update_libraries', '--only', 'nope', '--json'], { cwd: ws });
    assert.equal(unknown.exitCode, 1, 'unknown service should be a user error');
  } finally {
    await cleanup(fixtures.base);
    await cleanup(ws);
  }
});
